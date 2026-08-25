#!/usr/bin/env node
/**
 * 安装后补救：确保 Electron 的运行时二进制真的落盘了。
 *
 * 实测发现在本机 `npm install` 之后 electron 的 postinstall 没有生效——包目录里
 * 只有 JS 壳，没有 dist/electron.exe，也没有 path.txt。手动执行它自带的 install.js
 * 可以正常下载。原因未查明（可能是工作区场景下 npm 的脚本调度问题），但这类
 * 「装完看着成功、跑起来才发现缺东西」的故障值得在安装期就兜住。
 *
 * 这个脚本是幂等的：二进制已存在时直接跳过。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function ensureElectron() {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve('electron/package.json', { paths: [repoRoot] }));
  } catch {
    // 没装 electron（比如只做后端开发），不是错误。
    return;
  }

  const binary = join(pkgDir, 'dist', 'electron.exe');
  const pathTxt = join(pkgDir, 'path.txt');
  if (existsSync(binary) && existsSync(pathTxt)) return;

  process.stdout.write('[postinstall] Electron 二进制缺失，执行其 install.js 补下载 ...\n');
  try {
    execFileSync(process.execPath, ['install.js'], {
      cwd: pkgDir,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
  } catch (err) {
    process.stderr.write(
      `[postinstall] Electron 二进制下载失败：${err instanceof Error ? err.message : String(err)}\n` +
        '  这不阻塞后端开发。需要跑桌面外壳时，可手动重试：\n' +
        `    cd "${pkgDir}" && node install.js\n` +
        '  网络受限时可设镜像后重试：\n' +
        '    $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"\n',
    );
    return;
  }

  if (existsSync(binary)) {
    process.stdout.write('[postinstall] Electron 二进制就绪\n');
  }
}

/**
 * koffi 的原生二进制同样可能没落盘。
 *
 * 它的 install 脚本是 `node ./cnoke.cjs ... --prebuild`（下载预编译产物）。本机
 * 实测 `npm install` 之后该脚本未生效，与 Electron 是同一种症状。koffi 缺失的
 * 后果比 Electron 严重：Job Object 与内核中断事件都靠它，缺了会静默退化成
 * 「轮询限额 + 中断变重启」。
 */
function ensureKoffi() {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve('koffi/package.json', { paths: [repoRoot] }));
  } catch {
    return;
  }

  // 能 require 起来就说明二进制齐了
  try {
    require.resolve('koffi', { paths: [repoRoot] });
    const probe = require(require.resolve('koffi', { paths: [repoRoot] }));
    if (typeof probe.load === 'function') return;
  } catch {
    // 落到下面重建
  }

  process.stdout.write('[postinstall] koffi 原生二进制缺失，执行其 prebuild 下载 ...\n');
  try {
    execFileSync(
      process.execPath,
      ['./cnoke.cjs', '-P', '.', '-D', 'src/koffi', '--prebuild', '--release'],
      {
        cwd: pkgDir,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
      },
    );
    process.stdout.write('[postinstall] koffi 就绪\n');
  } catch (err) {
    process.stderr.write(
      `[postinstall] koffi 准备失败：${err instanceof Error ? err.message : String(err)}\n` +
        '  后果：资源限额退化为轮询检查，内核中断退化为重启（丢失内存状态）。\n' +
        `  手动重试：cd "${pkgDir}" && node ./cnoke.cjs -P . -D src/koffi --prebuild --release\n`,
    );
  }
}

ensureElectron();
ensureKoffi();
