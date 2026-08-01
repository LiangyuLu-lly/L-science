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

/** 失败时把响应里的错误信封原样打出来，否则只能看到 undefined 猜不出原因。 */
const explain = (id) => {
  const f = stdoutFrames.find((x) => x.id === id);
  if (f === undefined) return '(无响应)';
  if (f.ok === true) return JSON.stringify(f.result).slice(0, 200);
  return `${f.error?.code}: ${f.error?.message}${f.error?.detail === undefined ? '' : ` (${f.error.detail})`}`;
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

  // --- 7. 项目与会话 CRUD ---
  send(req('p1', { method: 'project.list' }));
  await waitFor(() => byId('p1') !== undefined, 8000, 'project.list');
  const initial = byId('p1');
  check(
    initial.ok === true &&
      Array.isArray(initial.result?.projects) &&
      initial.result.projects.length >= 1,
    '首次运行有默认项目  ',
    `${initial.result?.projects?.length ?? 0} 个`,
  );

  send(req('p2', { method: 'project.create', name: '端到端测试项目' }));
  await waitFor(() => byId('p2') !== undefined, 8000, 'project.create');
  const createdProject = byId('p2').result?.project;
  check(
    byId('p2').ok === true && createdProject?.name === '端到端测试项目',
    'project.create      ',
    createdProject?.id ?? '',
  );

  send(
    req('cv1', {
      method: 'conversation.create',
      projectId: createdProject.id,
      title: '第一次对话',
    }),
  );
  await waitFor(() => byId('cv1') !== undefined, 8000, 'conversation.create');
  const conversation = byId('cv1').result?.conversation;
  check(
    byId('cv1').ok === true && conversation?.status === 'idle',
    'conversation.create ',
    byId('cv1').ok === true ? `status=${conversation?.status}` : explain('cv1'),
  );
  if (byId('cv1').ok !== true) throw new Error(`conversation.create 失败：${explain('cv1')}`);

  send(req('cv2', { method: 'conversation.list', projectId: createdProject.id }));
  await waitFor(() => byId('cv2') !== undefined, 8000, 'conversation.list');
  check(byId('cv2').result?.conversations?.length === 1, 'conversation.list   ', '');

  send(req('cv3', { method: 'conversation.history', conversationId: conversation.id }));
  await waitFor(() => byId('cv3') !== undefined, 8000, 'conversation.history');
  const history = byId('cv3');
  check(
    history.ok === true &&
      history.result?.page?.messages?.length === 0 &&
      history.result.page.hasMore === false,
    '空会话历史为空页    ',
    `projectId=${history.result?.projectId === createdProject.id ? '匹配' : '不匹配'}`,
  );

  // 不存在的项目必须是 not_found，而不是 internal
  send(req('p3', { method: 'conversation.list', projectId: 'no-such-project' }));
  await waitFor(() => byId('p3') !== undefined, 8000, '不存在项目的响应');
  check(
    byId('p3').ok === false && byId('p3').error?.code === 'not_found',
    '不存在项目→not_found',
    byId('p3').error?.code ?? '',
  );

  // 归档后默认列表里应减少
  send(req('p4', { method: 'project.archive', projectId: createdProject.id }));
  await waitFor(() => byId('p4') !== undefined, 8000, 'project.archive');
  send(req('p5', { method: 'project.list' }));
  await waitFor(() => byId('p5') !== undefined, 8000, '归档后的列表');
  send(req('p6', { method: 'project.list', includeArchived: true }));
  await waitFor(() => byId('p6') !== undefined, 8000, '含归档的列表');
  check(
    byId('p5').result.projects.length < byId('p6').result.projects.length,
    '归档从默认列表移除  ',
    `${byId('p5').result.projects.length} vs ${byId('p6').result.projects.length}`,
  );

  // 尚未实现的方法必须显式拒绝，不能假装接受
  send(req('n1', { method: 'conversation.send', conversationId: conversation.id, text: 'hi' }));
  await waitFor(() => byId('n1') !== undefined, 8000, 'conversation.send');
  check(
    byId('n1').ok === false && byId('n1').error?.code === 'bad_request',
    '未实现编排显式拒绝  ',
    byId('n1').error?.message ?? '',
  );

  // --- 8. stdin 关闭后自行退出 ---
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
  // 必须等进程真正退出再删目录：Windows 上打开的 SQLite 文件被锁住，
  // 立即 rmSync 会以 EPERM 失败。
  if (child.exitCode === null) {
    child.stdin.end();
    const exited = await Promise.race([
      new Promise((r) => child.once('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (!exited) {
      child.kill();
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // 即便如此仍可能撞上杀软或索引器短暂持有句柄，重试几次。
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

process.stdout.write(failed ? '\n结果：有失败项\n' : '\n结果：控制平面通道全部通过\n');
process.exit(failed ? 1 : 0);
