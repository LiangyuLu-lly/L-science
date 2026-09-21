#!/usr/bin/env node
/**
 * 增量构建 + 产物完整性自检。
 *
 * `tsc --build` 只相信 .tsbuildinfo。当 dist 被清过而 tsbuildinfo 还在（手工清理、
 * 打包中断、部分拷贝），它会报成功却少产出文件，应用启动时报
 * `Cannot find module .../dist/ollama.js`——错误指向产物文件，而不是构建状态，
 * 排查方向完全错了。这里在构建后核对运行时真正加载的入口，缺了就全量重建一次。
 *
 * 宁可在构建阶段多花几十秒，也不要让用户对着一个指向 dist 的 MODULE_NOT_FOUND 猜。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** 运行时真正被 import 的入口。少一个应用就起不来。 */
const REQUIRED_ENTRIES = [
  'packages/shared/dist/index.js',
  'packages/adapters/dist/index.js',
  'packages/adapters/dist/ollama.js',
  'packages/core/dist/index.js',
  'packages/core/dist/backend.js',
  'packages/kernel/dist/index.js',
  'packages/shell/dist/main.js',
];

function runTsc(args) {
  return spawnSync(process.execPath, [tscBin, ...args], { cwd: repoRoot, stdio: 'inherit' })
    .status ?? 1;
}

function missingEntries() {
  return REQUIRED_ENTRIES.filter((rel) => !existsSync(join(repoRoot, rel)));
}

let status = runTsc(['--build']);
if (status !== 0) process.exit(status);

let gaps = missingEntries();
if (gaps.length > 0) {
  process.stderr.write(
    `构建产物不完整（${String(gaps.length)} 个入口缺失），tsbuildinfo 与 dist 不同步，全量重建：\n`,
  );
  for (const rel of gaps) process.stderr.write(`  缺 ${rel}\n`);

  status = runTsc(['--build', '--clean']);
  if (status === 0) status = runTsc(['--build']);

  gaps = missingEntries();
  if (status !== 0 || gaps.length > 0) {
    process.stderr.write(
      `全量重建后仍不完整：${gaps.length > 0 ? gaps.join('、') : '（tsc 退出码非零）'}\n`,
    );
    process.exit(status === 0 ? 1 : status);
  }
  process.stderr.write('全量重建完成，产物已齐全。\n');
}
