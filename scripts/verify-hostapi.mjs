/**
 * 控制面 REPL 端到端验证（任务 12.7，需求 10.8）。
 *
 * 单元测试用假内核验的是调度逻辑。这里验的是**真内核里 host 到底能不能用**：
 * shim 有没有写对地方、PYTHONPATH 与初始化代码有没有生效、回环 HTTP 在
 * ipykernel 进程里能不能通、以及最关键的那条边界——普通分析内核**拿不到**
 * 控制面权限。
 *
 * 那条边界是整个特权面的全部意义。它靠「两个独立的内核池实例」保证，而这种
 * 结构性约束恰恰是单元测试最容易假装通过的地方（假池想注入什么都行）。
 *
 * 用法：node scripts/verify-hostapi.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KernelPool, detectKernels } from '../packages/kernel/dist/index.js';
import {
  AppStore,
  ArtifactStore,
  ClaimLedger,
  ClaimsRepo,
  ControlRepl,
  FindingsRepo,
  HostRpcServer,
  InterruptEvent,
  ManuscriptCompiler,
  ManuscriptRepo,
  PlanRepo,
  RefLibrary,
  RefsRepo,
  RegistryRepo,
  SkillAuditRepo,
  UsageRepo,
  registerHostMethods,
} from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;

const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)}  ${detail}\n`);
};

const textOf = (result) =>
  result.output.kind === 'text' ? result.output.text : JSON.stringify(result.output);

const kernels = detectKernels();
if (kernels.python === null) {
  process.stdout.write('Python 内核不可用，无法验证控制面。\n');
  process.stdout.write('创建托管环境：conda create -n lsci python=3.13 -y 然后装 ipykernel\n');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'lsci-hostapi-'));
const store = AppStore.open(join(root, 'app'));

let controlPool = null;
let plainPool = null;
let server = null;

try {
  const created = store.createProject({ name: '控制面验证' });
  const project = store.openProject(created.id);
  const conversation = project.conversations.create({ title: '控制面会话' });

  const artifacts = new ArtifactStore(project.db, project.paths.blobs);

  /* --- M4 三层：文献库、断言台账、手稿编译器（任务 13.1-13.6）--- */

  const refLibrary = new RefLibrary({
    repo: new RefsRepo(project.db),
    artifacts,
    // 一律不批：本脚本不出网。库内操作不受影响
    authorizeHosts: async () => [],
    authorizeFulltextHost: async () => false,
  });

  const claimLedger = new ClaimLedger({
    repo: new ClaimsRepo(project.db),
    artifactExists: (versionId) => artifacts.getVersion(versionId) !== null,
    refExists: (refId) => refLibrary.repo.get(refId) !== null,
    refIdByDoi: (doi) => refLibrary.repo.getByDoi(doi)?.id ?? null,
    computeExists: () => false,
  });

  const manuscriptCompiler = new ManuscriptCompiler({
    repo: new ManuscriptRepo(project.db),
    artifacts,
    refs: () => refLibrary.repo.list({ limit: 1000 }),
  });

  /* ---------------- 1. RPC 服务与方法注册 ---------------- */

  process.stdout.write('\n--- 1. 控制面 RPC ---\n');

  server = new HostRpcServer({ onLog: (line) => process.stderr.write(`[host] ${line}\n`) });
  await server.start();
  check(server.port > 0, '控制面 RPC 已监听', `127.0.0.1:${server.port}`);

  const host = registerHostMethods(server, {
    projectId: created.id,
    db: project.db,
    artifacts,
    plans: new PlanRepo(project.db),
    findings: new FindingsRepo(project.db),
    // 技能与子 agent 这里不参与验证，给出最小可用替身即可：本脚本要验的是
    // 「host 通不通」，技能检索本身由 tests/skills.test.ts 覆盖
    skills: {
      records: () => [],
      search: async () => [],
      inject: () => null,
      readReference: () => ({ ok: false, reason: '本脚本未加载技能' }),
      requirementsOf: () => null,
    },
    skillAudit: new SkillAuditRepo(project.db),
    usage: new UsageRepo(project.db),
    registry: new RegistryRepo(store.db),
    subAgents: {
      spawn: () => {
        throw new Error('本脚本不派子 agent');
      },
      list: () => [],
      get: () => null,
    },
    /*
     * M4 三层接上（任务 13.1-13.6）。
     *
     * 域名门在这里一律拒批：本脚本不出网，而拒批之后 `list` / `stats` / `export`
     * 这些不需要上游的方法照样可用——这正是要验的，「接上了」不该等于「必须联网」。
     */
    refs: () => refLibrary,
    claims: () => claimLedger,
    manuscripts: () => manuscriptCompiler,
  });

  check(host.surfaces.length >= 10, '已注册表面', host.surfaces.map((s) => s.name).join('、'));
  check(host.pending.length > 0, '未实现的表面已列出', host.pending.map((p) => p.name).join('、'));
  check(
    host.pending.every((p) => p.name !== 'refs' && p.name !== 'claims'),
    'M4 三层不再在 pending 里',
    host.pending.map((p) => p.name).join('、'),
  );
  check(
    server.methods().includes('artifacts.list') && server.methods().includes('query.sql'),
    '方法名与 shim 一致',
    `${server.methods().length} 个`,
  );

  /* ---------------- 2. 控制面内核 ---------------- */

  process.stdout.write('\n--- 2. 控制面内核里的 host ---\n');

  const shimDir = join(root, 'control', 'shim');

  controlPool = new KernelPool({
    runtimeDir: join(root, 'control', 'runtime'),
    workspaceRoot: join(root, 'control', 'workspace'),
    available: kernels,
    onLog: (line) => process.stderr.write(`[control-kernel] ${line}\n`),
    interrupterFactory: () => InterruptEvent.create(),
    extraEnv: () => repl.env(),
    extraInitCode: () => ControlRepl.initCode(),
  });

  const repl = new ControlRepl({
    pool: controlPool,
    server,
    surfaces: host.surfaces,
    pending: host.pending,
    shimDir,
    onLog: (line) => process.stderr.write(`[repl] ${line}\n`),
  });

  const surfacesResult = await repl.run({
    code: 'import json\nprint(json.dumps(sorted(host.surfaces())))',
    conversationId: conversation.id,
    timeoutMs: 120_000,
  });
  check(
    surfacesResult.ok,
    'host 在控制面内核里可用',
    surfacesResult.ok ? '' : textOf(surfacesResult),
  );
  check(surfacesResult.mode === 'singleton', '默认走单例内核', `mode=${surfacesResult.mode}`);
  check(
    textOf(surfacesResult).includes('artifacts') && textOf(surfacesResult).includes('query'),
    'host.surfaces() 列出真实表面',
    textOf(surfacesResult).slice(0, 80),
  );

  /* ---------------- 3. 真实数据往返 ---------------- */

  process.stdout.write('\n--- 3. 真实数据往返 ---\n');

  const findings = new FindingsRepo(project.db);
  findings.add({
    conversationId: conversation.id,
    severity: 'fail',
    category: 'statistics',
    title: '十二次检验未做多重比较校正',
    evidence: [{ kind: 'message', id: 'msg_seed', note: '脚本预置' }],
  });

  const summaryResult = await repl.run({
    code: 'import json\nprint(json.dumps(host.findings.summary()))',
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    summaryResult.ok && textOf(summaryResult).includes('"blocking": 1'),
    'host.findings.summary() 读到真数据',
    textOf(summaryResult).trim(),
  );

  // 会话 id 必须来自本次执行，而不是内核启动那一刻
  const other = project.conversations.create({ title: '另一个会话' });
  const otherSummary = await repl.run({
    code: 'import json\nprint(json.dumps(host.findings.summary()))',
    conversationId: other.id,
    timeoutMs: 60_000,
  });
  check(
    otherSummary.ok && textOf(otherSummary).includes('"blocking": 0'),
    '会话上下文按次调用生效',
    textOf(otherSummary).trim(),
  );

  const sqlResult = await repl.run({
    code: [
      'rows = host.query.sql(sql="SELECT title, severity FROM findings ORDER BY created_at")',
      'print(len(rows["rows"]), rows["rows"][0]["severity"])',
    ].join('\n'),
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    sqlResult.ok && textOf(sqlResult).includes('1 fail'),
    'host.query.sql 只读查询可用',
    textOf(sqlResult).trim(),
  );

  const writeAttempt = await repl.run({
    code: [
      'try:',
      '    host.query.sql(sql="UPDATE findings SET status=\'resolved\'")',
      '    print("NOT-BLOCKED")',
      'except Exception as exc:',
      '    print("BLOCKED", type(exc).__name__)',
    ].join('\n'),
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    textOf(writeAttempt).includes('BLOCKED HostError'),
    '写入 SQL 被拒且在 Python 侧是异常',
    textOf(writeAttempt).trim(),
  );

  const pendingAttempt = await repl.run({
    code: [
      'try:',
      '    host.compute.list()',
      '    print("NOT-BLOCKED")',
      'except AttributeError as exc:',
      '    print("PENDING", str(exc)[:60])',
    ].join('\n'),
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    textOf(pendingAttempt).includes('PENDING'),
    '未接上的表面抛错而不是返回空',
    // 本脚本不接算力服务，因此 host.compute 走 pending 分支。抛错而不是给空壳是关键：
    // 空壳会让模型以为「查了但没有算力目标」，然后基于一个不存在的事实继续推理
    textOf(pendingAttempt).trim(),
  );

  /* ---------------- 3b. M4 三层在控制面里可用 ---------------- */

  process.stdout.write('\n--- 3b. 文献库 / 断言台账 / 手稿编译 ---\n');

  const refsProbe = await repl.run({
    code: 'import json\nprint(json.dumps({"n": len(host.refs.list()), "stats": host.refs.stats()["total"]}))',
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    refsProbe.ok && textOf(refsProbe).includes('"n": 0'),
    'host.refs 可用（空库返回空表而非报错）',
    textOf(refsProbe).trim().slice(0, 60),
  );

  const claimProbe = await repl.run({
    code: [
      'c = host.claims.register(',
      '    text="干预组的反应时比对照组快 42 ms（p = 0.003）。",',
      '    conversationId=' + JSON.stringify(conversation.id),
      ')',
      'print("KIND", c["claim"]["kinds"])',
      'print("UNSUPPORTED", len(host.claims.unsupported()["confirmed"]))',
    ].join('\n'),
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    claimProbe.ok && textOf(claimProbe).includes('numeric'),
    'host.claims 登记并按规则分类',
    textOf(claimProbe).trim().slice(0, 80),
  );

  /*
   * 关键的一条：**没有执行者身份时核验被拒**。
   *
   * 需求 13.3 要求每条核验都记下是谁判的。这里直接调 RPC（不经控制面内核），
   * 于是上下文里没有模型 id——必须被拒绝而不是记一条「不知道谁判的」结论。
   */
  const verifyWithoutModel = await fetch(server.env().L_SCIENCE_HOST_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lsci-host-token': server.token,
    },
    body: JSON.stringify({
      method: 'claims.verify',
      params: { claimId: 'cl_whatever', kind: 'ref', ref: 'rf_x', verdict: 'supports' },
      context: { conversationId: conversation.id },
    }),
  });
  const verifyBody = await verifyWithoutModel.json();
  check(
    verifyBody.ok === false && String(verifyBody.error?.message).includes('执行者身份'),
    '无执行者身份时拒绝记核验结论',
    String(verifyBody.error?.message ?? '').split('\n')[0],
  );

  const profilesProbe = await repl.run({
    code: [
      'p = host.manuscripts.profiles()',
      'print("PROFILES", len(p["profiles"]))',
      'print("DISCLAIMER", "近似值" in p["disclaimer"])',
    ].join('\n'),
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    profilesProbe.ok && textOf(profilesProbe).includes('DISCLAIMER True'),
    'host.manuscripts 档案带数值来源说明',
    textOf(profilesProbe).trim().slice(0, 60),
  );

  /* ---------------- 4. 状态保留与旁路 ---------------- */

  process.stdout.write('\n--- 4. 单例状态与旁路内核 ---\n');

  await repl.run({ code: 'marker = 41 + 1', conversationId: conversation.id, timeoutMs: 60_000 });
  const stateResult = await repl.run({
    code: 'print("marker =", marker)',
    conversationId: conversation.id,
    timeoutMs: 60_000,
  });
  check(
    stateResult.ok && textOf(stateResult).includes('marker = 42'),
    '单例内核保留状态',
    textOf(stateResult).trim(),
  );

  const bypassResult = await repl.run({
    code: 'print("has marker:", "marker" in dir())',
    conversationId: conversation.id,
    mode: 'bypass',
    timeoutMs: 120_000,
  });
  check(
    bypassResult.mode === 'bypass' && textOf(bypassResult).includes('has marker: False'),
    '旁路内核不共享状态',
    textOf(bypassResult).trim(),
  );
  check(bypassResult.bypassReason !== null, '旁路原因如实给出', bypassResult.bypassReason ?? '');

  // host 在旁路内核里同样可用：它也在控制面池里
  const bypassHost = await repl.run({
    code: 'print("surfaces:", len(host.surfaces()))',
    conversationId: conversation.id,
    mode: 'bypass',
    timeoutMs: 120_000,
  });
  check(
    bypassHost.ok && textOf(bypassHost).includes('surfaces:'),
    '旁路内核里 host 可用',
    textOf(bypassHost).trim(),
  );

  /* ---------------- 5. 特权边界 ---------------- */

  process.stdout.write('\n--- 5. 普通分析内核拿不到控制面 ---\n');

  // 与控制面**不同的池实例**，不注入 token、不注入初始化代码。
  // 这正是特权边界的实现方式：边界由池的构造决定，而不是由一处条件判断决定
  plainPool = new KernelPool({
    runtimeDir: join(root, 'plain', 'runtime'),
    workspaceRoot: join(root, 'plain', 'workspace'),
    available: kernels,
    onLog: (line) => process.stderr.write(`[plain-kernel] ${line}\n`),
  });

  const plainKernel = await plainPool.acquire(conversation.id, 'python');
  const collect = async (code) => {
    let text = '';
    for await (const out of plainKernel.execute(code, { timeoutMs: 60_000 })) {
      if (out.type === 'stream') text += out.text;
      if (out.type === 'error') text += `${out.ename}: ${out.evalue}`;
    }
    return text;
  };

  const envLeak = await collect(
    'import os\nprint("TOKEN" if os.environ.get("L_SCIENCE_HOST_TOKEN") else "NO-TOKEN")',
  );
  check(envLeak.includes('NO-TOKEN'), '普通内核没有控制面 token', envLeak.trim());

  const hostLeak = await collect('print("host" in dir())');
  check(hostLeak.includes('False'), '普通内核里没有 host 名字', hostLeak.trim());

  // 就算它自己把 shim 导进来，也调不通——token 不在环境里
  const shimLeak = await collect(
    [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(shimDir)})`,
      'import lsci_host',
      'try:',
      '    lsci_host.host.findings.summary()',
      '    print("LEAKED")',
      'except lsci_host.HostUnavailable as exc:',
      '    print("DENIED")',
    ].join('\n'),
  );
  check(shimLeak.includes('DENIED'), '手工导入 shim 也调不到控制面', shimLeak.trim());

  /* ---------------- 6. 收尾 ---------------- */

  process.stdout.write('\n--- 6. 收尾 ---\n');

  check((await repl.interrupt()) !== undefined, 'interrupt 可调用');
  await repl.close();
  const afterClose = await repl.run({
    code: 'print("restarted", "marker" in dir())',
    conversationId: conversation.id,
    timeoutMs: 120_000,
  });
  check(
    afterClose.ok && textOf(afterClose).includes('restarted False'),
    'close 后重新取用是干净内核',
    textOf(afterClose).trim(),
  );
} catch (err) {
  failed += 1;
  process.stdout.write(
    `\n未预期的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
} finally {
  if (controlPool !== null) await controlPool.close().catch(() => undefined);
  if (plainPool !== null) await plainPool.close().catch(() => undefined);
  if (server !== null) await server.stop().catch(() => undefined);
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
