#!/usr/bin/env node
/**
 * 把 sidecar 预构建到 release/sidecar-stage，供 extraResources 复制到 sidecar/app。
 *
 * 原生模块（better-sqlite3 / koffi / zeromq）必须在舞台目录里 `npm install --omit=dev`
 * 装出来。绝不能把仓库根的 node_modules 当 extraResources 源，也不能打进 linux-x64
 * 或 conda。
 *
 * 用法：node scripts/pack-sidecar.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backendRel, sidecarStage } from './lib/pack-layout.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACE_PACKAGES = Object.freeze(['shared', 'adapters', 'kernel', 'core']);

const SKIP_SEGMENTS = new Set(['node_modules', 'linux-x64', 'conda']);

export function sidecarStageManifest() {
  return {
    name: 'l-science-sidecar',
    private: true,
    type: 'module',
    dependencies: {
      'better-sqlite3': '13.0.2',
      koffi: '3.1.4',
      zeromq: '6.5.0',
      zod: '4.4.3',
      '@l-science/shared': 'file:packages/shared/dist',
      '@l-science/adapters': 'file:packages/adapters/dist',
      '@l-science/kernel': 'file:packages/kernel/dist',
      '@l-science/core': 'file:packages/core/dist',
    },
  };
}

export function distPackageManifest(pkgName) {
  return {
    name: `@l-science/${pkgName}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './index.js',
    exports: {
      '.': { default: './index.js' },
    },
  };
}

function shouldSkip(src) {
  return src.split(/[\\/]/u).some((part) => SKIP_SEGMENTS.has(part));
}

function npmCliJs() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(cli)) {
    throw new Error(`找不到 ${cli}，无法在舞台目录里 npm install`);
  }
  return cli;
}

function installStage(stageDir) {
  execFileSync(process.execPath, [npmCliJs(), 'install', '--omit=dev'], {
    cwd: stageDir,
    windowsHide: true,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  const sqlite = join(stageDir, 'node_modules', 'better-sqlite3');
  if (!existsSync(sqlite)) {
    throw new Error('sidecar stage 缺少 node_modules/better-sqlite3');
  }
}

export async function packSidecar({ root = repoRoot, install = true } = {}) {
  const stageDir = join(root, sidecarStage);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  for (const name of WORKSPACE_PACKAGES) {
    const srcDist = join(root, 'packages', name, 'dist');
    if (!existsSync(srcDist)) {
      throw new Error(`缺少 ${srcDist}，请先 npm run build`);
    }
    const destDist = join(stageDir, 'packages', name, 'dist');
    await mkdir(dirname(destDist), { recursive: true });
    await cp(srcDist, destDist, { recursive: true, filter: (src) => !shouldSkip(src) });
    await writeFile(
      join(destDist, 'package.json'),
      `${JSON.stringify(distPackageManifest(name), null, 2)}\n`,
    );
  }

  const backend = join(stageDir, backendRel);
  if (!existsSync(backend)) {
    throw new Error(`sidecar stage 缺少 ${backendRel}`);
  }

  await writeFile(
    join(stageDir, 'package.json'),
    `${JSON.stringify(sidecarStageManifest(), null, 2)}\n`,
  );
  process.stdout.write(`[pack-sidecar] 已写入 ${sidecarStage}\n`);

  if (!install) return stageDir;

  process.stdout.write(`[pack-sidecar] npm install --omit=dev（${sidecarStage}）\n`);
  installStage(stageDir);
  process.stdout.write('[pack-sidecar] node_modules/better-sqlite3 已就位\n');
  return stageDir;
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

if (invokedAsCli()) {
  packSidecar().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
