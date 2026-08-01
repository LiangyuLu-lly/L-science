#!/usr/bin/env node
/**
 * 以开发模式启动桌面外壳。
 *
 * 用 Node 启动器而不是在 npm script 里写 `VAR=x electron ...`：那套语法在
 * Windows 的 cmd 下不成立，而引入 cross-env 只为设两个变量不值得。
 *
 * 默认连 Vite 开发服务器并开启回环调试端口，供 `npm run verify:ui` 检查渲染层。
 * 调试端口只在这个开发入口开启，生产启动路径不开。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const devServer = process.env.L_SCIENCE_DEV_SERVER ?? 'http://127.0.0.1:5223';
const cdpPort = process.env.L_SCIENCE_CDP_PORT ?? '9222';

let electronBin;
try {
  // electron 包导出其可执行文件的绝对路径
  electronBin = require('electron');
} catch {
  process.stderr.write('未找到 electron。先执行 npm install。\n');
  process.exit(1);
}

if (typeof electronBin !== 'string') {
  process.stderr.write('electron 包未提供可执行文件路径，可能是二进制未下载。\n');
  process.stderr.write('修复：node node_modules/electron/install.js\n');
  process.exit(1);
}

const args = [join(repoRoot, 'packages', 'shell'), `--remote-debugging-port=${cdpPort}`];

process.stderr.write(`开发外壳启动：dev server=${devServer}  CDP=${cdpPort}\n`);

const child = spawn(electronBin, args, {
  stdio: 'inherit',
  env: { ...process.env, L_SCIENCE_DEV_SERVER: devServer },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
