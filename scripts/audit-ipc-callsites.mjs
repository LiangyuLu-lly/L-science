#!/usr/bin/env node
/**
 * 死 IPC 调用点审计。
 *
 * 为什么需要它：源码契约测试（`readFileSync` + `toContain`）只能证明某个
 * 方法名出现在 `api.ts` 里，不能证明**有人调用它**。于是「补齐 22 个包装」这类
 * 提交会让测试变绿，而研究者仍然点不到任何一个按钮——测试通过，功能是假的。
 *
 * 这个脚本用调用点说话：
 *   - schema 里注册了、但没有任何 UI 包装的（后端有、界面够不着）
 *   - 包装了、但除 `api.ts` 之外无人引用的（假可用——正是上面那种情况）
 *
 * 它不判断「该不该有」，只负责把两份清单摆出来。要新增死方法，或者要解释为什么
 * 某个方法只能由 agent 工具调用，都得在这里留下痕迹。
 *
 * 用法：node scripts/audit-ipc-callsites.mjs [--json]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = join(repoRoot, 'packages', 'ui', 'src');

/** schema 里声明的方法名。这是「后端存在」的权威来源。 */
function schemaMethods() {
  const text = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'ipc.ts'), 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/method:\s*z\.literal\('([^']+)'\)/g)) found.add(m[1]);
  return found;
}

/** api.ts 里包装的方法名，以及每个包装函数名。 */
function wrappedMethods() {
  const text = readFileSync(join(UI_SRC, 'lib', 'api.ts'), 'utf8');
  const methods = new Set();
  for (const m of text.matchAll(/method:\s*'([^']+)'/g)) methods.add(m[1]);

  // 包装函数名：`export const name = (...) => invoke<...>({ method: '...' })`
  const wrappers = new Map();
  const re = /export const (\w+)\s*=\s*[\s\S]{0,400}?method:\s*'([^']+)'/g;
  for (const m of text.matchAll(re)) wrappers.set(m[1], m[2]);
  return { methods, wrappers };
}

/** UI 源码里所有 .ts/.tsx（排除 api.ts 自身）。 */
function uiFiles(dir = UI_SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) uiFiles(full, out);
    else if (/\.tsx?$/.test(entry) && entry !== 'api.ts') out.push(full);
  }
  return out;
}

const schema = schemaMethods();
const { methods: wrapped, wrappers } = wrappedMethods();
const files = uiFiles();

/** 包装名 → 除 api.ts 外被引用的文件数。 */
const usedBy = new Map();
for (const name of wrappers.keys()) usedBy.set(name, []);

const names = [...wrappers.keys()];
const callRe = names.length === 0 ? null : new RegExp(`\\b(${names.join('|')})\\b`, 'g');
/** 组件里直接 invoke({ method: '…' }) 的方法也算有人调用，不能只认包装名。 */
const directMethods = new Set();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const seen = new Set();
  if (callRe !== null) for (const m of text.matchAll(callRe)) seen.add(m[1]);
  for (const name of seen) usedBy.get(name)?.push(file.slice(repoRoot.length + 1));
  for (const m of text.matchAll(/method:\s*'([^']+)'/g)) directMethods.add(m[1]);
}

const unwrapped = [...schema].filter((m) => !wrapped.has(m) && !directMethods.has(m)).sort();
const wrappedNeverUsed = [...wrappers.entries()]
  .filter(([name]) => (usedBy.get(name) ?? []).length === 0)
  .map(([name, method]) => ({ name, method }))
  .sort((a, b) => a.method.localeCompare(b.method));

const payload = {
  schemaCount: schema.size,
  wrappedCount: wrapped.size,
  directCallCount: directMethods.size,
  wrappedNeverUsed,
  unwrapped,
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  process.stdout.write(`schema 方法 ${String(schema.size)}　UI 包装 ${String(wrapped.size)}\n\n`);
  process.stdout.write(`包装了但无人调用（假可用风险）${String(wrappedNeverUsed.length)} 个：\n`);
  for (const { name, method } of wrappedNeverUsed) {
    process.stdout.write(`  ${method.padEnd(28)} ${name}\n`);
  }
  process.stdout.write(`\n后端有但 UI 完全没包装${String(unwrapped.length)} 个：\n`);
  for (const method of unwrapped) process.stdout.write(`  ${method}\n`);
}
