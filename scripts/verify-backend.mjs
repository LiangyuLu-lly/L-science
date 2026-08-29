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

/**
 * 取某个请求的响应帧。
 *
 * 必须按 type 过滤：请求关联的事件帧（helpers.emit）带同一个 id，不过滤会拿到
 * 第一个事件而不是响应。症状是 `ok` 与 `error` 都是 undefined，看起来像后端
 * 返回了一个畸形响应，而实际上响应还没到。
 */
const byId = (id) => stdoutFrames.find((f) => f.id === id && f.type === 'response');

/** 取某个请求关联的事件帧。 */
const eventsOf = (id) => stdoutFrames.filter((f) => f.id === id && f.type === 'event');

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
  /*
   * 认得出 id 的坏帧必须回一条错误响应。
   *
   * 这条断言原先写的是「坏帧不产生响应帧」，那是修复之前的行为：只记日志然后丢掉，
   * 调用方的 promise 永远不 settle，界面永久转圈而用户看不到任何错误。现在
   * transport 在 `type==='request'` 且 id 合法时回 `errResponse`，因此这里要断言
   * 的是「有响应且是 bad_request」。
   *
   * 不是 JSON 的那一行没有 id 可回，因此仍然只有日志。
   */
  await waitFor(
    () => byId('bad') !== undefined && byId('bad2') !== undefined,
    8000,
    '坏帧的错误响应',
  );
  check(
    byId('bad').ok === false &&
      byId('bad').error?.code === 'bad_request' &&
      byId('bad2').ok === false &&
      byId('bad2').error?.code === 'bad_request',
    '坏帧回错误响应不挂死',
    `${byId('bad').error?.code} / ${byId('bad2').error?.code}`,
  );
  check(
    stdoutFrames.every((f) => f.id !== 'unparsable'),
    '无 id 的坏帧只记日志',
    '',
  );

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

  /*
   * 会话编排已接通（任务 8.5.4）。这里不打真实模型——那是 verify-turn.mjs 的
   * 职责。本脚本只验证 IPC 层的接线：没有配置任何供应商时，编排应当以
   * 「没有可用模型」这个可解释的结果收尾，而不是崩溃或挂死。
   */
  send(req('n1', { method: 'conversation.send', conversationId: conversation.id, text: 'hi' }));
  await waitFor(() => byId('n1') !== undefined, 20000, 'conversation.send');
  check(
    byId('n1').ok === true && byId('n1').result?.delivered === true,
    '编排接通不崩溃      ',
    explain('n1'),
  );

  // 事件按请求 id 关联而不是广播：渲染层要能区分这些增量属于哪一次发送
  const turnEvents = eventsOf('n1');
  check(turnEvents.length > 0, '事件关联到本次请求  ', `${turnEvents.length} 个`);

  // 无供应商时应产出路由决策事件并说明缺什么，而不是静默失败
  const routingEvent = turnEvents.find((f) => f.payload?.kind === 'routing.decision');
  check(
    routingEvent !== undefined && routingEvent.payload.decision.chosenModelId === null,
    '无供应商时如实报告  ',
    (routingEvent?.payload.decision.reason ?? '').slice(0, 50),
  );

  // 回合必须以 turn.end 收尾，否则渲染层不知道该收起「正在思考」的指示
  check(
    turnEvents.some((f) => f.payload?.kind === 'turn.end'),
    '回合以 turn.end 收尾 ',
    turnEvents.map((f) => f.payload?.kind).join(', '),
  );

  // 中断一个已停下的会话不该报错——用户点停止时并不知道它是否刚好结束了
  send(req('n2', { method: 'conversation.interrupt', conversationId: conversation.id }));
  await waitFor(() => byId('n2') !== undefined, 8000, 'conversation.interrupt');
  check(
    byId('n2').ok === true,
    '中断已停会话不报错  ',
    `interrupted=${byId('n2').result?.interrupted}`,
  );

  // 回合结束后会话必须回到 idle，否则用户再也发不出消息
  send(req('n3', { method: 'conversation.list', projectId: createdProject.id }));
  await waitFor(() => byId('n3') !== undefined, 8000, 'conversation.list');
  const listed = (byId('n3').result?.conversations ?? []).find((c) => c.id === conversation.id);
  check(listed?.status === 'idle', '回合后状态回到 idle ', listed?.status ?? '?');

  // --- 8. 审批与授权（任务 8.1、8.2、5.5）---
  // IPC → 服务 → 数据库这条链必须端到端跑通，单测覆盖不到进程边界

  send(req('g1', { method: 'grant.list' }));
  await waitFor(() => byId('g1') !== undefined, 8000, 'grant.list');
  check(
    byId('g1').ok === true &&
      Array.isArray(byId('g1').result?.hostPaths) &&
      byId('g1').result.hostPaths.length === 0,
    'grant.list 初始为空  ',
    explain('g1'),
  );

  // 不存在的审批 id 必须报错，不能静默成功——静默成功让「点了没反应」无从排查
  send(req('a1', { method: 'approval.decide', approvalId: 'ap_nope', decision: 'approve' }));
  await waitFor(() => byId('a1') !== undefined, 8000, 'approval.decide');
  check(
    byId('a1').ok === false && byId('a1').error?.code === 'not_found',
    '决议不存在的审批报错',
    byId('a1').error?.message ?? '',
  );

  send(req('q1', { method: 'question.answer', questionId: 'q_nope', answer: 'x' }));
  await waitFor(() => byId('q1') !== undefined, 8000, 'question.answer');
  check(
    byId('q1').ok === false && byId('q1').error?.code === 'not_found',
    '作答不存在的提问报错',
    byId('q1').error?.message ?? '',
  );

  // 危险路径不发审批，直接拒绝
  send(
    req('h1', {
      method: 'host.requestAccess',
      hostPath: 'C:\\Windows\\System32',
      mode: 'rw',
      purpose: '不该被允许',
      projectId: createdProject.id,
    }),
  );
  await waitFor(() => byId('h1') !== undefined, 8000, 'host.requestAccess 危险路径');
  check(
    byId('h1').ok === true && byId('h1').result?.granted === false,
    '系统目录直接被拒    ',
    byId('h1').result?.reason?.slice(0, 60) ?? explain('h1'),
  );

  // 正常路径：应广播 approval.request 事件，然后由 approval.decide 决议
  const targetPath = join(dataDir, 'external');
  send(
    req('h2', {
      method: 'host.requestAccess',
      hostPath: targetPath,
      mode: 'ro',
      purpose: '读取外部数据集',
      projectId: createdProject.id,
      conversationId: conversation.id,
    }),
  );

  await waitFor(
    () => stdoutFrames.some((f) => f.type === 'event' && f.payload?.kind === 'approval.request'),
    8000,
    '审批请求事件',
  );
  const approvalEvent = stdoutFrames.find(
    (f) => f.type === 'event' && f.payload?.kind === 'approval.request',
  );
  const card = approvalEvent.payload.approval;
  check(true, '审批请求广播到前端  ', `id=${card.id}`);
  check(
    typeof card.impact === 'string' &&
      card.impact.length > 0 &&
      typeof card.reversible === 'boolean' &&
      Array.isArray(card.scopeOptions),
    '卡片含影响范围与可逆',
    `可逆=${card.reversible} 作用域=${card.scopeOptions.join('/')}`,
  );

  // 决议后原请求才会返回——这验证了阻塞等待真的生效
  check(byId('h2') === undefined, '决议前请求保持挂起  ', '');

  send(
    req('a2', {
      method: 'approval.decide',
      approvalId: card.id,
      decision: 'approve',
      scope: 'project',
    }),
  );
  await waitFor(() => byId('h2') !== undefined, 8000, 'host.requestAccess 决议后返回');
  check(
    byId('h2').ok === true && byId('h2').result?.granted === true,
    '批准后放行          ',
    `来源=${byId('h2').result?.source}`,
  );

  // 授权应已落库，且第二次请求不再发审批
  send(req('g2', { method: 'grant.list' }));
  await waitFor(() => byId('g2') !== undefined, 8000, 'grant.list 第二次');
  const hostGrants = byId('g2').result?.hostPaths ?? [];
  check(hostGrants.length === 1, '授权已落库          ', `${hostGrants.length} 条`);

  const eventsBefore = stdoutFrames.filter(
    (f) => f.type === 'event' && f.payload?.kind === 'approval.request',
  ).length;
  send(
    req('h3', {
      method: 'host.requestAccess',
      hostPath: targetPath,
      mode: 'ro',
      purpose: '再次读取',
      projectId: createdProject.id,
      conversationId: conversation.id,
    }),
  );
  await waitFor(() => byId('h3') !== undefined, 8000, 'host.requestAccess 复用授权');
  const eventsAfter = stdoutFrames.filter(
    (f) => f.type === 'event' && f.payload?.kind === 'approval.request',
  ).length;
  check(
    byId('h3').result?.source === 'existing-grant' && eventsAfter === eventsBefore,
    '已授权则不再询问    ',
    `来源=${byId('h3').result?.source}`,
  );

  // 撤销后应重新需要审批
  send(req('g3', { method: 'grant.revoke', grantId: hostGrants[0].id }));
  await waitFor(() => byId('g3') !== undefined, 8000, 'grant.revoke');
  check(byId('g3').ok === true && byId('g3').result?.revoked === true, '撤销授权成功        ', '');

  /*
   * --- 9. 工具面真的被注册了（任务 12.7b）---
   *
   * 组 5/6 的能力此前只在冒烟脚本里被组装过，真正的后端从未注册 python / r /
   * bash。这条检查存在的意义就是防止那种情况再次出现：单元测试测的是工具本身，
   * 而「后端有没有把它接上」只有走真实进程才能看出来。
   */
  send(req('t1', { method: 'tool.list', projectId: createdProject.id }));
  await waitFor(() => byId('t1') !== undefined, 30000, 'tool.list');
  const toolNames = (byId('t1').result?.available ?? []).map((t) => t.name).sort();
  const expected = [
    'ask_user',
    'check_findings',
    'control_repl',
    'create_skill',
    'delegate',
    'edit_file',
    'generate_plan',
    'python',
    'read_file',
    'remember',
    'save_artifacts',
    'search_skills',
  ];
  const missing = expected.filter((n) => !toolNames.includes(n));
  check(
    missing.length === 0,
    '核心工具全部已注册  ',
    missing.length === 0 ? `${toolNames.length} 个` : `缺 ${missing.join(', ')}`,
  );

  // --- 10. 记忆（任务 12.9，需求 16）---

  send(req('m1', { method: 'memory.list', projectId: createdProject.id }));
  await waitFor(() => byId('m1') !== undefined, 8000, 'memory.list');
  check(
    byId('m1').ok === true && byId('m1').result?.notes?.length === 0,
    'memory.list 初始为空 ',
    explain('m1'),
  );

  send(
    req('m2', {
      method: 'memory.upsert',
      projectId: createdProject.id,
      scope: 'project',
      kind: 'convention',
      content: '被试编号统一用 S01 到 S24，与原始文件名保持一致。',
      reason: '改写会与采集记录对不上。',
    }),
  );
  await waitFor(() => byId('m2') !== undefined, 8000, 'memory.upsert');
  const memoryNote = byId('m2').result?.note;
  check(
    byId('m2').ok === true && memoryNote?.scope === 'project',
    'memory.upsert       ',
    explain('m2'),
  );

  // 需求 16.4：用户手工写入一次性细节也要被拒——膨胀与是谁写的无关
  send(
    req('m3', {
      method: 'memory.upsert',
      projectId: createdProject.id,
      scope: 'project',
      kind: 'decision',
      content: '额叶的配对 t 检验 p = 0.03，因此干预有效。',
      reason: '这是主要结果。',
    }),
  );
  await waitFor(() => byId('m3') !== undefined, 8000, 'memory.upsert 一次性细节');
  check(
    byId('m3').ok === false && byId('m3').error?.code === 'bad_request',
    '一次性细节被拒      ',
    (byId('m3').error?.detail ?? '').slice(0, 50),
  );

  send(
    req('m4', { method: 'memory.delete', projectId: createdProject.id, memoryId: memoryNote.id }),
  );
  await waitFor(() => byId('m4') !== undefined, 8000, 'memory.delete');
  check(byId('m4').ok === true && byId('m4').result?.deleted === true, 'memory.delete       ', '');

  send(
    req('m5', { method: 'memory.delete', projectId: createdProject.id, memoryId: memoryNote.id }),
  );
  await waitFor(() => byId('m5') !== undefined, 8000, 'memory.delete 重复');
  check(
    byId('m5').ok === false && byId('m5').error?.code === 'not_found',
    '删不存在的记忆报错  ',
    '',
  );

  // --- 11. findings 面（任务 12.8）---

  send(
    req('f1', {
      method: 'finding.list',
      projectId: createdProject.id,
      conversationId: conversation.id,
    }),
  );
  await waitFor(() => byId('f1') !== undefined, 8000, 'finding.list');
  check(
    byId('f1').ok === true && byId('f1').result?.summary?.blocking === 0,
    'finding.list 可用    ',
    explain('f1'),
  );

  send(
    req('f2', {
      method: 'reviewer.runs',
      projectId: createdProject.id,
      conversationId: conversation.id,
    }),
  );
  await waitFor(() => byId('f2') !== undefined, 8000, 'reviewer.runs');
  check(
    byId('f2').ok === true && Array.isArray(byId('f2').result?.runs),
    'reviewer.runs 可用   ',
    '',
  );

  /*
   * --- 12. 技能创建与导入（任务 12.15，需求 9.6）---
   *
   * 走真实进程验的是整条链：ipc schema → dispatcher → 处理器 → 文件系统 →
   * `skills.reload()`。最后一步是关键——写进磁盘但没重扫的话，技能存在却搜不到，
   * 而那种状态单元测试看不见（它们直接调 writeUserSkill）。
   */

  const skillManifest = JSON.stringify(
    {
      slug: 'verify-authoring',
      name: '端到端校验技能',
      version: '1.0.0',
      domain: '测试',
      description: '由 verify-backend 写入，用于验证技能创建链路是否接通',
      triggers: ['验证技能创建', '端到端写入技能', '检查 skill.write'],
      tools: [],
    },
    null,
    2,
  );

  send(
    req('sk1', {
      method: 'skill.validate',
      manifest: skillManifest,
      instructions: '# 端到端校验\n\n这是正文。\n',
    }),
  );
  await waitFor(() => byId('sk1') !== undefined, 8000, 'skill.validate');
  check(
    byId('sk1').ok === true &&
      byId('sk1').result?.ok === true &&
      byId('sk1').result?.slug === 'verify-authoring',
    'skill.validate 通过  ',
    explain('sk1'),
  );

  // 一次性细节要在保存前就被指出来，而不是等技能在别的机器上失效
  send(
    req('sk2', {
      method: 'skill.validate',
      manifest: skillManifest,
      instructions: '# x\n\n读取 D:/data/s01.edf，按刚才的参数跑\n',
    }),
  );
  await waitFor(() => byId('sk2') !== undefined, 8000, 'skill.validate 内容审查');
  const auditWarnings = (byId('sk2').result?.warnings ?? []).join('；');
  check(
    auditWarnings.includes('绝对路径') && auditWarnings.includes('会话指代'),
    '一次性细节被指出    ',
    auditWarnings.slice(0, 80),
  );

  send(
    req('sk3', {
      method: 'skill.write',
      manifest: skillManifest,
      instructions: '# 端到端校验\n\n这是正文，用于确认写入链路接通。\n',
      references: { 'notes.md': '参考材料内容' },
    }),
  );
  await waitFor(() => byId('sk3') !== undefined, 15000, 'skill.write');
  check(
    byId('sk3').ok === true && byId('sk3').result?.ok === true,
    'skill.write 写入成功 ',
    explain('sk3'),
  );

  // 写完必须能被检索到——这一步验的是处理器有没有做 reload
  send(req('sk4', { method: 'skill.search', query: '验证技能创建', limit: 5 }));
  await waitFor(() => byId('sk4') !== undefined, 20000, 'skill.search 命中新技能');
  check(
    (byId('sk4').result?.hits ?? []).some((h) => h.slug === 'verify-authoring'),
    '新技能立刻可检索    ',
    (byId('sk4').result?.hits ?? []).map((h) => h.slug).join(', '),
  );

  send(req('sk5', { method: 'skill.source', slug: 'verify-authoring' }));
  await waitFor(() => byId('sk5') !== undefined, 8000, 'skill.source');
  check(
    byId('sk5').result?.scope === 'user' &&
      byId('sk5').result?.editable === true &&
      byId('sk5').result?.origin?.kind === 'authored' &&
      (byId('sk5').result?.references ?? []).includes('notes.md'),
    'skill.source 带来源  ',
    explain('sk5'),
  );

  // 同名再写一次必须被拒：静默覆盖会让用户改过的版本无声消失
  send(
    req('sk6', {
      method: 'skill.write',
      manifest: skillManifest,
      instructions: '# 覆盖尝试\n\n不该生效。\n',
    }),
  );
  await waitFor(() => byId('sk6') !== undefined, 8000, 'skill.write 同名');
  check(
    byId('sk6').result?.ok === false,
    '同名写入默认被拒    ',
    (byId('sk6').result?.errors ?? []).join('；').slice(0, 60),
  );

  // 导入一个 zip（用 core 自己的能力造，格式兼容由 verify:skills 单独验）
  const zipBase64 = await (async () => {
    const { deflateRawSync } = await import('node:zlib');
    const files = [
      {
        path: 'imported-skill/skill.json',
        content: JSON.stringify({
          slug: 'imported-skill',
          name: '导入的技能',
          version: '1.0.0',
          domain: '测试',
          description: '由 verify-backend 通过 zip 导入，用于验证导入链路',
          triggers: ['验证 zip 导入', '导入技能包', '检查 importArchive'],
          tools: [],
        }),
      },
      { path: 'imported-skill/SKILL.md', content: '# 导入的技能\n\n正文。\n' },
    ];
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const f of files) {
      const nameBuf = Buffer.from(f.path, 'utf8');
      const raw = Buffer.from(f.content, 'utf8');
      const data = deflateRawSync(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      locals.push(local, nameBuf, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const localBlock = Buffer.concat(locals);
    const centralBlock = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBlock.length, 12);
    eocd.writeUInt32LE(localBlock.length, 16);
    return Buffer.concat([localBlock, centralBlock, eocd]).toString('base64');
  })();

  send(
    req('sk7', {
      method: 'skill.importArchive',
      fileName: 'probe.zip',
      contentBase64: zipBase64,
    }),
  );
  await waitFor(() => byId('sk7') !== undefined, 15000, 'skill.importArchive');
  check(
    byId('sk7').result?.ok === true && byId('sk7').result?.skills?.[0]?.slug === 'imported-skill',
    'zip 导入成功        ',
    explain('sk7'),
  );

  // GitHub 标识写错时要在下载之前就被挡住，而不是等一个 404
  send(req('sk8', { method: 'skill.importGithub', spec: 'not-a-repo' }));
  await waitFor(() => byId('sk8') !== undefined, 15000, 'skill.importGithub 非法标识');
  check(
    byId('sk8').result?.ok === false &&
      (byId('sk8').result?.errors ?? []).join('').includes('owner/repo'),
    '非法仓库标识被挡住  ',
    (byId('sk8').result?.errors ?? []).join('；').slice(0, 60),
  );

  send(req('sk9', { method: 'skill.delete', slug: 'imported-skill' }));
  await waitFor(() => byId('sk9') !== undefined, 15000, 'skill.delete');
  check(
    byId('sk9').ok === true && byId('sk9').result?.deleted === true,
    'skill.delete 成功    ',
    explain('sk9'),
  );

  // 内置技能不可删，只能禁用——删了下次启动会被同步回来
  send(req('sk10', { method: 'skill.delete', slug: 'literature-search' }));
  await waitFor(() => byId('sk10') !== undefined, 8000, 'skill.delete 内置');
  check(
    byId('sk10').ok === false && String(byId('sk10').error?.message ?? '').includes('内置'),
    '内置技能拒绝删除    ',
    String(byId('sk10').error?.message ?? '').slice(0, 50),
  );

  // --- 13. 文献库（任务 13.1）---
  //
  // 这一段刻意**不打真实上游**：CI 与离线机器上必须可重复。因此只验证不需要
  // 网络的路径——空库列表、去重扫描、不存在的 id 报 not_found、非法标识在发请求
  // 之前就被挡住。真正的上游解析由 tests/refs.test.ts 用注入的 fetch 桩覆盖。

  send(req('rf1', { method: 'ref.list', projectId: createdProject.id }));
  await waitFor(() => byId('rf1') !== undefined, 20000, 'ref.list');
  check(
    byId('rf1').ok === true &&
      Array.isArray(byId('rf1').result?.refs) &&
      byId('rf1').result?.stats?.total === 0,
    'ref.list 空库        ',
    explain('rf1'),
  );

  send(req('rf2', { method: 'ref.get', projectId: createdProject.id, refId: 'rf_missing' }));
  await waitFor(() => byId('rf2') !== undefined, 8000, 'ref.get 不存在');
  check(
    byId('rf2').ok === false && byId('rf2').error?.code === 'not_found',
    '不存在的文献 not_found',
    String(byId('rf2').error?.code ?? '?'),
  );

  send(req('rf3', { method: 'ref.duplicates', projectId: createdProject.id }));
  await waitFor(() => byId('rf3') !== undefined, 8000, 'ref.duplicates');
  check(
    byId('rf3').ok === true &&
      Array.isArray(byId('rf3').result?.pairs) &&
      byId('rf3').result?.truncated === false,
    'ref.duplicates 空库  ',
    explain('rf3'),
  );

  // 标题不是标识：必须在任何网络请求之前就被拒绝，否则会把一个没核对过的
  // 猜测写进文献库
  send(
    req('rf4', {
      method: 'ref.resolve',
      projectId: createdProject.id,
      identifiers: ['Sleep spindles review'],
    }),
  );
  await waitFor(() => byId('rf4') !== undefined, 20000, 'ref.resolve 标题');
  check(
    byId('rf4').ok === true &&
      byId('rf4').result?.failed === 1 &&
      String(byId('rf4').result?.outcomes?.[0]?.reason ?? '').includes('不是标识'),
    '标题不能直接入库    ',
    String(byId('rf4').result?.outcomes?.[0]?.reason ?? '').slice(0, 40),
  );

  send(
    req('rf5', {
      method: 'ref.merge',
      projectId: createdProject.id,
      keepId: 'rf_a',
      dropId: 'rf_a',
    }),
  );
  await waitFor(() => byId('rf5') !== undefined, 8000, 'ref.merge 自合并');
  check(
    byId('rf5').ok === false && byId('rf5').error?.code === 'conflict',
    '自我合并被拒绝      ',
    String(byId('rf5').error?.code ?? '?'),
  );

  // 全文抓取：同样不打真实上游。验证的是「不存在的文献报 not_found」与
  // 「空内容的手工绑定被拒」这两条不需要网络的路径。
  send(req('rf6', { method: 'ref.assets', projectId: createdProject.id, refId: 'rf_missing' }));
  await waitFor(() => byId('rf6') !== undefined, 8000, 'ref.assets 不存在');
  check(
    byId('rf6').ok === false && byId('rf6').error?.code === 'not_found',
    'ref.assets not_found  ',
    String(byId('rf6').error?.code ?? '?'),
  );

  send(
    req('rf7', {
      method: 'ref.attachFulltext',
      projectId: createdProject.id,
      refId: 'rf_missing',
      fileName: 'x.pdf',
      contentBase64: Buffer.from('%PDF-1.7 fake').toString('base64'),
    }),
  );
  await waitFor(() => byId('rf7') !== undefined, 8000, 'ref.attachFulltext 不存在');
  check(
    byId('rf7').ok === false && String(byId('rf7').error?.message ?? '').includes('文献不存在'),
    '绑定到不存在的文献被拒',
    String(byId('rf7').error?.message ?? '').slice(0, 40),
  );

  // base64 解出空内容通常意味着传输被截断。静默接受会存下一个 0 字节的「全文」
  send(
    req('rf8', {
      method: 'ref.attachFulltext',
      projectId: createdProject.id,
      refId: 'rf_missing',
      fileName: 'x.pdf',
      contentBase64: '=',
    }),
  );
  await waitFor(() => byId('rf8') !== undefined, 8000, 'ref.attachFulltext 空内容');
  check(
    byId('rf8').ok === false && String(byId('rf8').error?.message ?? '').includes('空内容'),
    '空内容被拒            ',
    String(byId('rf8').error?.message ?? '').slice(0, 40),
  );

  // 全文抓取对不存在的文献要报 not_found 而不是内部错误
  send(
    req('rf9', {
      method: 'ref.fetchFulltext',
      projectId: createdProject.id,
      refId: 'rf_missing',
    }),
  );
  await waitFor(() => byId('rf9') !== undefined, 20000, 'ref.fetchFulltext 不存在');
  check(
    byId('rf9').ok === true &&
      byId('rf9').result?.ok === false &&
      String(byId('rf9').result?.summary ?? '').includes('文献不存在'),
    'fetchFulltext 不存在  ',
    String(byId('rf9').result?.summary ?? '').slice(0, 40),
  );

  // 导出：空库要报 conflict 而不是产出一个空文件。空 .bib 被 LaTeX 吃掉之后
  // 报的是「Citation undefined」，与「忘了导出」的症状一样
  send(req('rf10', { method: 'ref.export', projectId: createdProject.id, format: 'bibtex' }));
  await waitFor(() => byId('rf10') !== undefined, 8000, 'ref.export 空库');
  check(
    byId('rf10').ok === false && byId('rf10').error?.code === 'conflict',
    '空库导出被拒        ',
    String(byId('rf10').error?.message ?? '').slice(0, 40),
  );

  // 非法格式必须在 schema 层就被挡住
  send(req('rf11', { method: 'ref.export', projectId: createdProject.id, format: 'endnote' }));
  await waitFor(() => byId('rf11') !== undefined, 8000, 'ref.export 非法格式');
  check(
    byId('rf11').ok === false && byId('rf11').error?.code === 'bad_request',
    '非法导出格式被挡住  ',
    String(byId('rf11').error?.code ?? '?'),
  );

  // --- 14. Claim Ledger（任务 13.4）---
  //
  // 这一段完全不需要网络，因此覆盖得比文献库那段深：抽取、确认、绑定校验、
  // 核验结论与状态推导都走一遍真实进程。

  send(
    req('cm1', {
      method: 'claim.extract',
      projectId: createdProject.id,
      conversationId: conversation.id,
      markdown:
        '## Results\n\n' +
        'Spindle density was higher in patients than controls (p = 0.003).\n' +
        'Sampling was performed at 250 Hz throughout.\n',
    }),
  );
  await waitFor(() => byId('cm1') !== undefined, 20000, 'claim.extract');
  const extracted = byId('cm1').result?.created ?? [];
  check(
    byId('cm1').ok === true && extracted.length >= 2,
    'claim.extract 抽出断言 ',
    `${String(extracted.length)} 条`,
  );
  check(
    extracted.every((c) => c.origin === 'extracted'),
    '抽取的来源标成 extracted',
    extracted.map((c) => c.origin).join(','),
  );

  const claimId = extracted[0]?.id ?? 'cl_missing';

  // 绑定一个编出来的制品版本 id 必须被拒 —— 这是整套机制里最重要的一道检查
  send(
    req('cm2', {
      method: 'claim.bind',
      projectId: createdProject.id,
      claimId,
      evidenceKind: 'artifact-version',
      evidenceRef: 'av_00000000-0000-0000-0000-000000000000',
    }),
  );
  await waitFor(() => byId('cm2') !== undefined, 8000, 'claim.bind 编造 id');
  check(
    byId('cm2').ok === false && String(byId('cm2').error?.message ?? '').includes('不存在'),
    '编造的证据 id 被拒   ',
    String(byId('cm2').error?.message ?? '').slice(0, 40),
  );

  // 确认之后来源变成 user，于是无证据会升级成 FAIL
  send(req('cm3', { method: 'claim.confirm', projectId: createdProject.id, claimId }));
  await waitFor(() => byId('cm3') !== undefined, 8000, 'claim.confirm');
  check(
    byId('cm3').ok === true && byId('cm3').result?.claim?.origin === 'user',
    'confirm 提升为 user  ',
    String(byId('cm3').result?.claim?.origin ?? '?'),
  );

  send(
    req('cm4', {
      method: 'claim.list',
      projectId: createdProject.id,
      conversationId: conversation.id,
      unsupportedOnly: true,
    }),
  );
  await waitFor(() => byId('cm4') !== undefined, 8000, 'claim.list');
  check(
    byId('cm4').ok === true &&
      byId('cm4').result?.summary?.blocking >= 1 &&
      String(byId('cm4').result?.gate ?? '').includes('不应宣称手稿完成'),
    '无证据断言算阻断项  ',
    String(byId('cm4').result?.gate ?? '').slice(0, 50),
  );

  // 关闭必须给理由：没有理由的关闭在事后与「漏掉了」区分不开
  send(
    req('cm5', {
      method: 'claim.close',
      projectId: createdProject.id,
      claimId,
      status: 'dismissed',
      note: '',
    }),
  );
  await waitFor(() => byId('cm5') !== undefined, 8000, 'claim.close 空理由');
  check(
    byId('cm5').ok === false && byId('cm5').error?.code === 'bad_request',
    '关闭必须给理由      ',
    String(byId('cm5').error?.code ?? '?'),
  );

  send(
    req('cm6', {
      method: 'claim.close',
      projectId: createdProject.id,
      claimId,
      status: 'dismissed',
      note: '这是方法学参数，不是本文结论',
    }),
  );
  await waitFor(() => byId('cm6') !== undefined, 8000, 'claim.close');
  check(
    byId('cm6').ok === true && byId('cm6').result?.claim?.status === 'dismissed',
    'claim.close 生效     ',
    String(byId('cm6').result?.claim?.status ?? '?'),
  );

  send(req('cm7', { method: 'claim.get', projectId: createdProject.id, claimId: 'cl_missing' }));
  await waitFor(() => byId('cm7') !== undefined, 8000, 'claim.get 不存在');
  check(
    byId('cm7').ok === false && byId('cm7').error?.code === 'not_found',
    'claim.get not_found  ',
    String(byId('cm7').error?.code ?? '?'),
  );

  // manage_claims 必须在工具清单里
  send(req('cm8', { method: 'tool.list', projectId: createdProject.id }));
  await waitFor(() => byId('cm8') !== undefined, 30000, 'tool.list 断言工具');
  check(
    (byId('cm8').result?.available ?? []).some((t) => t.name === 'manage_claims') &&
      (byId('cm8').result?.available ?? []).some((t) => t.name === 'manage_references'),
    'M4 工具已注册        ',
    'manage_claims / manage_references',
  );

  // --- 15. 引文核实（任务 13.5，需求 13.9）---
  //
  // citation.parse 完全不需要网络，因此覆盖得深；citation.verify 只验证「不可核实的
  // 输入会被如实报告」这条不需要上游的路径。

  send(
    req('ct1', {
      method: 'citation.parse',
      projectId: createdProject.id,
      referenceList:
        '1. Jumper J, Evans R. Highly accurate protein structure prediction with AlphaFold. ' +
        'Nature. 2021;596:583-9. doi:10.1038/s41586-021-03819-2\n' +
        '2. [12]\n',
    }),
  );
  await waitFor(() => byId('ct1') !== undefined, 8000, 'citation.parse');
  const parsedCites = byId('ct1').result?.citations ?? [];
  check(
    byId('ct1').ok === true &&
      parsedCites.length >= 1 &&
      parsedCites[0]?.doi === '10.1038/s41586-021-03819-2' &&
      parsedCites[0]?.firstAuthorSurname === 'Jumper' &&
      parsedCites[0]?.year === 2021,
    'citation.parse 解析条目',
    `${String(parsedCites.length)} 条，首条 ${String(parsedCites[0]?.doi ?? '?')}`,
  );

  // 纯引用标记必须被判为不可检索：拿 [12] 去检索会返回一堆无关文献，
  // 其中最相似的会被误判成命中，于是一条编造的引文被「核实」通过
  send(
    req('ct2', {
      method: 'citation.parse',
      projectId: createdProject.id,
      referenceList: '1. [12], [3,5-7], [9], [14]\n',
    }),
  );
  await waitFor(() => byId('ct2') !== undefined, 8000, 'citation.parse 标记');
  const markerCites = byId('ct2').result?.citations ?? [];
  check(
    byId('ct2').ok === true &&
      markerCites.length === 1 &&
      markerCites[0]?.shape === 'marker-only' &&
      markerCites[0]?.searchable === false,
    '纯引用标记不可检索  ',
    String(markerCites[0]?.shape ?? '?'),
  );

  send(
    req('ct3', {
      method: 'citation.verify',
      projectId: createdProject.id,
      citations: ['[12]'],
    }),
  );
  await waitFor(() => byId('ct3') !== undefined, 30000, 'citation.verify 标记');
  check(
    byId('ct3').ok === true &&
      byId('ct3').result?.counts?.unverifiable === 1 &&
      (byId('ct3').result?.results ?? [])[0]?.queries?.length === 0,
    '不可核实且一次都没查',
    String((byId('ct3').result?.results ?? [])[0]?.verdict ?? '?'),
  );

  // 核实记录必须落库（需求 13.9 的可核查性）
  send(req('ct4', { method: 'citation.checks', projectId: createdProject.id }));
  await waitFor(() => byId('ct4') !== undefined, 8000, 'citation.checks');
  check(
    byId('ct4').ok === true &&
      (byId('ct4').result?.checks ?? []).length >= 1 &&
      (byId('ct4').result?.checks ?? [])[0]?.retrievalBacked === false,
    '核实记录已落库      ',
    `${String((byId('ct4').result?.checks ?? []).length)} 条`,
  );

  send(req('ct5', { method: 'citation.verify', projectId: createdProject.id }));
  await waitFor(() => byId('ct5') !== undefined, 8000, 'citation.verify 空入参');
  check(
    byId('ct5').ok === false && byId('ct5').error?.code === 'bad_request',
    '空入参被挡住        ',
    String(byId('ct5').error?.code ?? '?'),
  );

  send(req('ct6', { method: 'tool.list', projectId: createdProject.id }));
  await waitFor(() => byId('ct6') !== undefined, 30000, 'tool.list 核实工具');
  check(
    (byId('ct6').result?.available ?? []).some((t) => t.name === 'verify_citations'),
    'verify_citations 已注册',
    '',
  );

  // --- 16. 手稿编译（任务 13.6，需求 13.5-13.8）---
  //
  // 完全不需要网络，因此覆盖得深：解析、编译、双盲移除清单、自引泄露、局限说明。

  const MANUSCRIPT = [
    '---',
    'title: Sleep spindles predict overnight memory consolidation',
    'journal: NeurIPS',
    'authors:',
    '  - name: Jane Smith',
    '    affiliations: [1]',
    '    corresponding: true',
    '  - name: Bob Jones',
    '    affiliations: [1]',
    'affiliations:',
    '  - Department of Neuroscience, University X',
    'funding: [NIH R01-MH123456]',
    'acknowledgements: We thank the University X sleep laboratory staff.',
    '---',
    '',
    '## Introduction',
    '',
    'Spindles matter [1]. Our previous work showed that spindle density',
    'predicts recall [1].',
    '',
    '## Results',
    '',
    'Density was higher in good sleepers (p = 0.003). See Figure 1.',
    '',
    '**Figure 1.** Analysis pipeline.',
    '',
  ].join('\n');

  send(req('mc1', { method: 'manuscript.profiles' }));
  await waitFor(() => byId('mc1') !== undefined, 8000, 'manuscript.profiles');
  check(
    byId('mc1').ok === true &&
      (byId('mc1').result?.profiles ?? []).length >= 8 &&
      String(byId('mc1').result?.disclaimer ?? '').includes('核对官方要求'),
    '档案清单带免责说明  ',
    `${String((byId('mc1').result?.profiles ?? []).length)} 个档案`,
  );

  send(
    req('mc2', {
      method: 'manuscript.parse',
      projectId: createdProject.id,
      markdown: MANUSCRIPT,
    }),
  );
  await waitFor(() => byId('mc2') !== undefined, 20000, 'manuscript.parse');
  check(
    byId('mc2').ok === true &&
      (byId('mc2').result?.meta?.identifying?.authors ?? []).length === 2 &&
      (byId('mc2').result?.figures ?? []).length === 1 &&
      byId('mc2').result?.meta?.identifying?.affiliations?.length === 1,
    '嵌套元数据解析正确  ',
    `${String((byId('mc2').result?.meta?.identifying?.authors ?? []).length)} 作者`,
  );

  send(
    req('mc3', {
      method: 'manuscript.compile',
      projectId: createdProject.id,
      conversationId: conversation.id,
      markdown: MANUSCRIPT,
      both: true,
    }),
  );
  await waitFor(() => byId('mc3') !== undefined, 30000, 'manuscript.compile');
  const outputs = byId('mc3').result?.outputs ?? [];
  check(
    byId('mc3').ok === true && outputs.length === 2,
    'both 出两个版本      ',
    outputs.map((o) => (o.blinded ? '双盲' : '正式')).join('/'),
  );

  const blindedOutput = outputs.find((o) => o.blinded === true);
  check(
    blindedOutput !== undefined &&
      !String(blindedOutput.content ?? '').includes('Jane Smith') &&
      !String(blindedOutput.content ?? '').includes('NIH R01-MH123456') &&
      !String(blindedOutput.content ?? '').includes('sleep laboratory'),
    '双盲版移除身份字段  ',
    `移除 ${String((blindedOutput?.removedFields ?? []).length)} 项`,
  );

  check(
    (blindedOutput?.removedFields ?? []).join(' ').includes('Jane Smith'),
    '移除清单逐项列出    ',
    (blindedOutput?.removedFields ?? []).slice(0, 2).join('；').slice(0, 40),
  );

  // 需求 13.8：必须明示双盲基于结构化元数据，对隐式线索不作保证
  check(
    String(blindedOutput?.content ?? '').includes('对正文里的隐式身份线索不作任何保证') &&
      String(blindedOutput?.report ?? '').includes('正文一个字都没改'),
    '明示双盲处理的局限  ',
    '',
  );

  const formalOutput = outputs.find((o) => o.blinded === false);
  check(
    formalOutput !== undefined && String(formalOutput.content ?? '').includes('Jane Smith'),
    '正式版保留身份信息  ',
    '',
  );

  send(req('mc4', { method: 'manuscript.list', projectId: createdProject.id }));
  await waitFor(() => byId('mc4') !== undefined, 8000, 'manuscript.list');
  const manuscripts = byId('mc4').result?.manuscripts ?? [];
  check(
    byId('mc4').ok === true && manuscripts.length === 1 && manuscripts[0]?.status === 'compiled',
    'manuscript.list 可用 ',
    `${String(manuscripts.length)} 份，状态 ${String(manuscripts[0]?.status ?? '?')}`,
  );

  send(
    req('mc5', {
      method: 'manuscript.history',
      projectId: createdProject.id,
      manuscriptId: manuscripts[0]?.id ?? 'ms_missing',
    }),
  );
  await waitFor(() => byId('mc5') !== undefined, 8000, 'manuscript.history');
  check(
    byId('mc5').ok === true && (byId('mc5').result?.runs ?? []).length === 2,
    '编译历史记两次      ',
    `${String((byId('mc5').result?.runs ?? []).length)} 次`,
  );

  send(
    req('mc6', {
      method: 'manuscript.compile',
      projectId: createdProject.id,
      markdown: '---\nmeta: {a: 1}\n---\nbody\n',
    }),
  );
  await waitFor(() => byId('mc6') !== undefined, 20000, 'manuscript.compile 坏语法');
  check(
    byId('mc6').ok === false && byId('mc6').error?.code === 'bad_request',
    '不支持的语法被挡住  ',
    String(byId('mc6').error?.message ?? '').slice(0, 40),
  );

  send(req('mc7', { method: 'tool.list', projectId: createdProject.id }));
  await waitFor(() => byId('mc7') !== undefined, 30000, 'tool.list 编译工具');
  check(
    (byId('mc7').result?.available ?? []).some((t) => t.name === 'compile_manuscript'),
    'compile_manuscript 已注册',
    '',
  );

  // --- 17. 算力目标与作业（任务 14.2，需求 14.3、14.4、14.6、14.7）---
  process.stdout.write('\n--- 17. 算力目标与作业 ---\n');

  send(req('cp1', { method: 'compute.targets' }));
  await waitFor(() => byId('cp1') !== undefined, 8000, 'compute.targets');
  check(
    byId('cp1').ok === true &&
      Array.isArray(byId('cp1').result?.targets) &&
      byId('cp1').result?.targets.length === 0 &&
      typeof byId('cp1').result?.revision?.latest === 'number',
    'compute.targets 空库可用',
    `revision.count=${String(byId('cp1').result?.revision?.count ?? '?')}`,
  );
  check(
    (byId('cp1').result?.grantScopes?.write ?? []).includes('always') === false &&
      (byId('cp1').result?.grantScopes?.read ?? []).includes('always') === true,
    '授权档位上限已收敛  ',
    `write=${(byId('cp1').result?.grantScopes?.write ?? []).join(',')}`,
  );

  send(req('cp2', { method: 'compute.localCapabilities' }));
  await waitFor(() => byId('cp2') !== undefined, 30000, 'compute.localCapabilities');
  check(
    byId('cp2').ok === true &&
      typeof byId('cp2').result?.ssh?.available === 'boolean' &&
      byId('cp2').result?.suggestedLocalConfig?.family === 'local',
    '本机能力探测可用  ',
    `ssh=${String(byId('cp2').result?.ssh?.available)} gpu=${String(
      (byId('cp2').result?.gpus ?? []).length,
    )}`,
  );

  // 登记一个本地目标：它不建立对外通道，因此不走审批，可以在无人应答的脚本里完成
  send(
    req('cp3', {
      method: 'compute.register',
      projectId: createdProject.id,
      name: '本机',
      config: { family: 'local', maxConcurrent: 1, visibleDevices: null, shell: 'bash' },
      notesMd: '本机只有一块卡，别同时跑两个训练作业。',
    }),
  );
  await waitFor(() => byId('cp3') !== undefined, 60000, 'compute.register 本地');
  const localTarget = byId('cp3').result?.target;
  check(
    byId('cp3').ok === true && localTarget?.family === 'local' && localTarget?.enabled === true,
    'compute.register 本地  ',
    `${String(localTarget?.id ?? '?')} probe=${String(byId('cp3').result?.probe?.usable)}`,
  );

  // 配置不合法时要给出可执行的说明，而不是一句「校验失败」
  send(
    req('cp4', {
      method: 'compute.register',
      projectId: createdProject.id,
      name: 'hpc-bad',
      config: {
        family: 'ssh',
        host: 'hpc.example.edu',
        user: null,
        port: null,
        scheduler: 'slurm',
        remoteWorkdir: 'work',
        activate: null,
        partition: null,
        account: null,
        sshOptions: {},
        hostKeyFingerprint: null,
      },
    }),
  );
  await waitFor(() => byId('cp4') !== undefined, 20000, 'compute.register 相对路径');
  check(
    byId('cp4').ok === false &&
      byId('cp4').error?.code === 'bad_request' &&
      String(byId('cp4').error?.message ?? '').includes('不同集群上不一样'),
    '相对工作目录被拒    ',
    String(byId('cp4').error?.message ?? '').split('\n')[0],
  );

  // 危险的 ssh 选项在登记时就要被挡住
  send(
    req('cp5', {
      method: 'compute.register',
      projectId: createdProject.id,
      name: 'hpc-unsafe',
      config: {
        family: 'ssh',
        host: 'hpc.example.edu',
        user: null,
        port: null,
        scheduler: 'none',
        remoteWorkdir: '/scratch/x',
        activate: null,
        partition: null,
        account: null,
        sshOptions: { StrictHostKeyChecking: 'no' },
        hostKeyFingerprint: null,
      },
    }),
  );
  await waitFor(() => byId('cp5') !== undefined, 20000, 'compute.register 危险选项');
  check(
    byId('cp5').ok === false &&
      String(byId('cp5').error?.message ?? '').includes('StrictHostKeyChecking'),
    '危险 ssh 选项被拒   ',
    '',
  );

  send(req('cp6', { method: 'compute.target', targetId: localTarget?.id ?? 'ct_missing' }));
  await waitFor(() => byId('cp6') !== undefined, 8000, 'compute.target');
  check(
    byId('cp6').ok === true &&
      byId('cp6').result?.target?.needsHostKeyConfirmation === false &&
      Array.isArray(byId('cp6').result?.grants),
    'compute.target 详情  ',
    '',
  );

  // 停用要给原因：一个灰掉的目标而没有原因，用户唯一能做的是重新打开试试
  send(
    req('cp7', { method: 'compute.setEnabled', targetId: localTarget?.id ?? 'x', enabled: false }),
  );
  await waitFor(() => byId('cp7') !== undefined, 8000, 'compute.setEnabled 缺原因');
  check(
    byId('cp7').ok === false && byId('cp7').error?.code === 'bad_request',
    '停用必须给原因      ',
    String(byId('cp7').error?.message ?? ''),
  );

  send(
    req('cp8', {
      method: 'compute.setEnabled',
      targetId: localTarget?.id ?? 'x',
      enabled: false,
      reason: '先不用它',
    }),
  );
  await waitFor(() => byId('cp8') !== undefined, 8000, 'compute.setEnabled');
  check(byId('cp8').ok === true, 'compute.setEnabled 停用', '');

  send(req('cp9', { method: 'compute.targets' }));
  await waitFor(() => byId('cp9') !== undefined, 8000, 'compute.targets 停用后');
  check((byId('cp9').result?.targets ?? []).length === 0, '停用后默认不出现在列表', '');

  send(
    req('cp10', {
      method: 'compute.setEnabled',
      targetId: localTarget?.id ?? 'x',
      enabled: true,
    }),
  );
  await waitFor(() => byId('cp10') !== undefined, 8000, 'compute.setEnabled 启用');

  send(req('cp11', { method: 'compute.jobs', projectId: createdProject.id }));
  await waitFor(() => byId('cp11') !== undefined, 10000, 'compute.jobs');
  check(
    byId('cp11').ok === true && byId('cp11').result?.summary?.total === 0,
    'compute.jobs 可用    ',
    '',
  );

  send(req('cp12', { method: 'compute.grants' }));
  await waitFor(() => byId('cp12') !== undefined, 8000, 'compute.grants');
  check(
    byId('cp12').ok === true && String(byId('cp12').result?.note ?? '').includes('破坏性命令'),
    '授权列表说明破坏性例外',
    '',
  );

  send(
    req('cp13', {
      method: 'compute.remove',
      projectId: createdProject.id,
      targetId: localTarget?.id ?? 'x',
    }),
  );
  await waitFor(() => byId('cp13') !== undefined, 10000, 'compute.remove');
  check(
    byId('cp13').ok === true && byId('cp13').result?.deleted === true,
    'compute.remove 可用   ',
    '',
  );

  send(req('cp14', { method: 'tool.list', projectId: createdProject.id }));
  await waitFor(() => byId('cp14') !== undefined, 30000, 'tool.list 算力工具');
  const computeTools = (byId('cp14').result?.available ?? []).map((t) => t.name);
  check(
    ['manage_compute', 'run_remote_command', 'submit_compute_job'].every((n) =>
      computeTools.includes(n),
    ),
    '三个算力工具已注册  ',
    '',
  );

  // --- 18. stdin 关闭后自行退出 ---
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
