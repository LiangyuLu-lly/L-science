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

ensureElectron();
