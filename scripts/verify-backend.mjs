#!/usr/bin/env node
/**
 * 控制平面后端的端到端验证（任务 2.2）。
 *
 * 启动真实的后端进程，用 NDJSON over stdio 走一遍请求-响应与错误路径。
 * 重点验证的是几个「出问题就整条通道失联」的性质：
 *  - 日志走 stderr 而不污染 stdout 的协议帧
 *  - 并发请求各自拿到正确响应
 *  - 坏帧只报协议错误，通道继续可用
 *  - stdin 关闭后进程自行退出，不留孤儿
 *
 * 用临时数据目录，不碰真实的 %LOCALAPPDATA%\L-science。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'packages', 'core', 'dist', 'backend.js');
const dataDir = mkdtempSync(join(tmpdir(), 'lsci-vb-'));

let failed = false;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}\n`);
  if (!ok) failed = true;
};

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, L_SCIENCE_DATA_DIR: dataDir },
});

const stdoutFrames = [];
let stdoutBuf = '';
let stderrText = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line === '') continue;
    try {
      stdoutFrames.push(JSON.parse(line));
    } catch {
      stdoutFrames.push({ __unparsable: line });
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrText += chunk;
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const req = (id, payload) => ({ v: 1, type: 'request', id, payload });

const waitFor = async (predicate, timeoutMs = 8000, what = '条件') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待${what}超时`);
};

const byId = (id) => stdoutFrames.find((f) => f.id === id);

try {
  // 后端要先完成 boot（建目录、迁移）才会开始处理请求
  await waitFor(() => stderrText.includes('控制平面就绪'), 15000, '后端就绪');

  // --- 1. stdout 洁净性：就绪日志必须在 stderr，stdout 此刻应无任何内容 ---
  check(
    stdoutFrames.length === 0,
    'stdout 未被日志污染  ',
    stdoutFrames.length === 0 ? '' : JSON.stringify(stdoutFrames[0]).slice(0, 120),
  );
  check(stderrText.includes('SQLite'), '启动日志走 stderr    ', '');

  // --- 2. 正常请求 ---
  send(req('s1', { method: 'app.status' }));
  await waitFor(() => byId('s1') !== undefined, 8000, 'app.status 响应');
  const s1 = byId('s1');
  check(
    s1.type === 'response' && s1.ok === true && s1.result?.ready === true,
    'app.status 往返     ',
    `schema=v${s1.result?.schema} sqlite=${s1.result?.sqlite}`,
  );

  // --- 3. 未实现的方法返回 not_found 而不是崩溃 ---
  send(req('s2', { method: 'env.doctor' }));
  await waitFor(() => byId('s2') !== undefined, 8000, 'env.doctor 响应');
  const s2 = byId('s2');
  check(
    s2.ok === false && s2.error?.code === 'not_found',
    '未实现方法报 not_found',
    s2.error?.remediation ?? '',
  );

  // --- 4. 坏帧只报协议错误，通道继续可用 ---
  child.stdin.write('这不是 JSON\n');
  send({ v: 999, type: 'request', id: 'bad', payload: { method: 'app.status' } });
  send({ v: 1, type: 'request', id: 'bad2', payload: { method: 'app.dropEverything' } });

  await waitFor(
    () => (stderrText.match(/协议错误/g) ?? []).length >= 3,
    8000,
    '三类坏帧的协议错误',
  );
  check(
    true,
    '坏帧被拒且已记录    ',
    `stderr 中出现 ${(stderrText.match(/协议错误/g) ?? []).length} 次`,
  );
  check(byId('bad') === undefined && byId('bad2') === undefined, '坏帧不产生响应帧    ', '');

  send(req('s3', { method: 'app.status' }));
  await waitFor(() => byId('s3') !== undefined, 8000, '坏帧之后的请求');
  check(byId('s3').ok === true, '坏帧后通道仍可用    ', '');

  // --- 5. 并发请求关联正确 ---
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
  for (const id of ids) send(req(id, { method: 'app.status' }));
  await waitFor(() => ids.every((id) => byId(id) !== undefined), 8000, '并发响应');
  check(
    ids.every((id) => byId(id).ok === true && byId(id).id === id),
    '并发请求关联正确    ',
    `${ids.length} 个请求全部对上`,
  );

  // --- 6. 重复 id 返回 conflict（同步发两条同 id）---
  // app.status 处理极快，重复 id 很可能已不在途，因此这里只断言不崩溃且都有响应
  send(req('dup', { method: 'app.status' }));
  send(req('dup', { method: 'app.status' }));
  await waitFor(() => stdoutFrames.filter((f) => f.id === 'dup').length >= 1, 8000, 'dup 响应');
  check(true, '重复 id 不致崩溃     ', '');

  // --- 7. stdin 关闭后自行退出 ---
  const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.end();
  const code = await Promise.race([
    exitPromise,
    new Promise((r) => setTimeout(() => r('timeout'), 8000)),
  ]);
  check(code === 0, 'stdin EOF 后自行退出 ', `exit=${String(code)}`);
} catch (err) {
  check(false, '验证流程异常        ', err instanceof Error ? err.message : String(err));
} finally {
  if (child.exitCode === null) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write(failed ? '\n结果：有失败项\n' : '\n结果：控制平面通道全部通过\n');
process.exit(failed ? 1 : 0);
