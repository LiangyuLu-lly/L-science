#!/usr/bin/env node
/**
 * 打包时拉取官方 Node 24 Windows x64 运行时，只落盘 node.exe。
 *
 * 安装包里的 sidecar 需要一份与 engines.node 对齐的解释器，但不能把开发机
 * 的 node_modules 或系统 Node 打进去。官方 win-x64 zip 是独立发行物，解压
 * 即得 node.exe，不走安装器。版本钉死，运行时不解析 latest。
 *
 * 用法：node scripts/download-node.mjs [--force]
 * vendor/node-win-x64/node.exe 已存在时跳过；--force 覆盖。
 */

import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { vendorNode } from './lib/pack-layout.mjs';

/** 钉死的 24.x。查自 https://nodejs.org/dist/index.json（2026-09-19 最新 24 为 24.21.0 LTS Krypton）。 */
export const NODE_VERSION = '24.21.0';

const DIST_ORIGIN = 'https://nodejs.org';
const SHA256_LINE = /^([0-9a-fA-F]{64}) [ *](\S+)$/u;
const ZIP_TIMEOUT_MS = 10 * 60 * 1000;
const SHASUMS_TIMEOUT_MS = 30_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function winX64ZipName(version) {
  return `node-v${version}-win-x64.zip`;
}

export function innerNodeExe(version) {
  return `node-v${version}-win-x64/node.exe`;
}

export function nodeDistUrls(version = NODE_VERSION) {
  const zipName = winX64ZipName(version);
  const base = `${DIST_ORIGIN}/dist/v${version}`;
  return {
    zip: `${base}/${zipName}`,
    shasums: `${base}/SHASUMS256.txt`,
    zipName,
  };
}

/**
 * 从官方 SHASUMS256.txt 取出某个文件名的 hex sha256。
 * 行格式：`<64 hex>` + 两个空格或 ` *` + 文件名。
 */
export function parseSha256(shasumsText, filename) {
  for (const raw of shasumsText.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    const match = SHA256_LINE.exec(line);
    if (match === null) continue;
    const hash = match[1];
    const name = match[2];
    if (hash === undefined || name === undefined) continue;
    if (name === filename) return hash.toLowerCase();
  }
  throw new Error(`SHASUMS256.txt 没有 ${filename} 这一项`);
}

function sameSha256(actual, expected) {
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

async function downloadToFile(url, dest, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${String(res.status)}`);
  }
  if (res.body === null) {
    throw new Error(`GET ${url} 无响应体`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function windowsTar() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function extractNodeExe(zipFileName, staging, version) {
  const tar = windowsTar();
  if (!existsSync(tar)) {
    throw new Error(`找不到 ${tar}，无法解压官方 Node zip`);
  }
  const member = innerNodeExe(version);
  // cwd=staging 且只传 zip 文件名，避免 GNU/bsdtar 把 `C:` 当成远程主机。
  execFileSync(tar, ['-xf', zipFileName, member], {
    cwd: staging,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return join(staging, ...member.split('/'));
}

export async function downloadNode({ force = false, root = repoRoot } = {}) {
  const destDir = join(root, vendorNode);
  const destExe = join(destDir, 'node.exe');
  if (existsSync(destExe) && !force) {
    process.stdout.write(`[download-node] 已存在 ${vendorNode}/node.exe，跳过\n`);
    return destExe;
  }

  const urls = nodeDistUrls(NODE_VERSION);
  const staging = await mkdtemp(join(tmpdir(), 'lsci-node-'));
  try {
    process.stdout.write(`[download-node] 下载 ${urls.shasums}\n`);
    const shasumsRes = await fetch(urls.shasums, {
      signal: AbortSignal.timeout(SHASUMS_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!shasumsRes.ok) {
      throw new Error(`GET ${urls.shasums} → ${String(shasumsRes.status)}`);
    }
    const expected = parseSha256(await shasumsRes.text(), urls.zipName);

    const zipPath = join(staging, urls.zipName);
    process.stdout.write(`[download-node] 下载 ${urls.zip}\n`);
    await downloadToFile(urls.zip, zipPath, ZIP_TIMEOUT_MS);

    const actual = await fileSha256(zipPath);
    if (!sameSha256(actual, expected)) {
      throw new Error(`sha256 不匹配：期望 ${expected}，实际 ${actual}`);
    }
    process.stdout.write('[download-node] sha256 校验通过\n');

    const extracted = extractNodeExe(urls.zipName, staging, NODE_VERSION);
    await mkdir(destDir, { recursive: true });
    await copyFile(extracted, destExe);
    process.stdout.write(`[download-node] 解出 node.exe → ${vendorNode}/node.exe\n`);
    return destExe;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

async function main() {
  await downloadNode({ force: process.argv.includes('--force') });
}

if (invokedAsCli()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
