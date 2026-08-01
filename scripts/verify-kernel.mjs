#!/usr/bin/env node
/**
 * AD-2 端到端验证：从 Node 用 ZMQ 跟真实 Jupyter 内核完成协议握手并执行代码。
 *
 * 覆盖 Python（ipykernel）与 R（IRkernel）两个内核，逐项验证需求 3 的验收标准：
 * HMAC 握手、stdout 捕获、富输出、跨 cell 状态持久、inline 图像、结构化异常。
 *
 * 这是一次性验证脚本；M1 会把协议逻辑正式实现进 @l-science/kernel。
 *
 * 两条已验证的坑，M1 必须照办：
 *  1. iopub 消息必须按 parent_header.msg_id 关联到发起的请求。内核在启动阶段会
 *     自行推送 banner stream 与多条 status，按到达顺序取值一定错。
 *  2. 裸 ipykernel 不把 figure 渲染成 PNG，起内核时要注入 inline 后端。
 *
 * 用法：
 *   node scripts/verify-kernel.mjs            两个内核都验
 *   node scripts/verify-kernel.mjs --only=r   只验 R
 */

import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

import { Dealer, Subscriber } from 'zeromq';

import { condaInfo, managedPython, managedR } from './lib/env.mjs';

/** 每次验证都会建一个临时目录放连接文件，退出前统一清掉，不在 TEMP 里堆积。 */
const tempDirs = [];

/**
 * 删除目录，失败则重试。
 *
 * 内核进程的 cwd 就是这个临时目录，而 Windows 不允许删除任何进程的当前目录。
 * kill() 只是发信号，进程真正消失还需要一点时间，因此必须重试而不是一次性删。
 */
async function removeWithRetry(dir, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

const here = dirname(fileURLToPath(import.meta.url));
const DELIM = '<IDS|MSG>';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg?.slice('--only='.length) ?? null;

/* ---------------------------------------------------------------- *
 * 协议原语
 * ---------------------------------------------------------------- */

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

async function makeConnectionInfo(kernelName) {
  const ports = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  return {
    transport: 'tcp',
    ip: '127.0.0.1',
    shell_port: ports[0],
    iopub_port: ports[1],
    stdin_port: ports[2],
    control_port: ports[3],
    hb_port: ports[4],
    key: randomUUID(),
    signature_scheme: 'hmac-sha256',
    kernel_name: kernelName,
  };
}

function parse(parts) {
  const strs = parts.map((p) => p.toString());
  const i = strs.indexOf(DELIM);
  return {
    header: JSON.parse(strs[i + 2]),
    parentHeader: JSON.parse(strs[i + 3]),
    content: JSON.parse(strs[i + 5]),
  };
}

/* ---------------------------------------------------------------- *
 * 各语言的探针代码
 * ---------------------------------------------------------------- */

const PROBES = {
  python: {
    label: 'Python / ipykernel',
    // 依次：初始化 + stdout + 富输出 / 状态持久 / 图像 / 异常
    setup: [
      '%matplotlib inline',
      'import numpy as np, pandas as pd',
      'x = np.arange(10)',
      'df = pd.DataFrame({"a":[1,2,3]})',
      'print("sum:", int(x.sum()))',
      'df',
    ].join('\n'),
    persist: 'print("persisted:", int(x.sum()) + len(df))',
    plot: [
      'import matplotlib.pyplot as plt',
      'from IPython.display import display',
      'fig, ax = plt.subplots()',
      'ax.plot(x, x**2)',
      'display(fig)',
      'plt.close(fig)',
    ].join('\n'),
    fail: '1/0',
    expectedError: /^ZeroDivisionError/,
  },
  r: {
    label: 'R / IRkernel',
    setup: ['x <- 0:9', 'df <- data.frame(a = 1:3)', 'cat("sum:", sum(x), "\\n")', 'df'].join('\n'),
    persist: 'cat("persisted:", sum(x) + nrow(df), "\\n")',
    // IRkernel 默认就把绘图作为 display_data 推送，不需要额外启用后端
    plot: 'plot(x, x^2)',
    fail: 'stop("boom")',
    expectedError: /boom/,
  },
};

/* ---------------------------------------------------------------- *
 * 单个内核的验证流程
 * ---------------------------------------------------------------- */

async function verify(spec) {
  const probe = PROBES[spec.language];
  const info = await makeConnectionInfo(spec.kernelName);
  const dir = mkdtempSync(join(tmpdir(), `lsci-vk-${spec.language}-`));
  tempDirs.push(dir);
  const connFile = join(dir, 'connection.json');
  writeFileSync(connFile, JSON.stringify(info));

  const session = randomBytes(16).toString('hex');
  const sign = (h, p, m, c) =>
    createHmac('sha256', info.key).update(h).update(p).update(m).update(c).digest('hex');

  function frame(msgType, content) {
    const msgId = randomUUID();
    const header = JSON.stringify({
      msg_id: msgId,
      session,
      username: 'l-science',
      date: new Date().toISOString(),
      msg_type: msgType,
      version: '5.3',
    });
    const parent = '{}';
    const meta = '{}';
    const body = JSON.stringify(content);
    return { msgId, parts: [DELIM, sign(header, parent, meta, body), header, parent, meta, body] };
  }

  const execContent = (code) => ({
    code,
    silent: false,
    store_history: true,
    user_expressions: {},
    allow_stdin: false,
    stop_on_error: true,
  });

  process.stdout.write(`\n=== ${probe.label} ===\n`);

  const kernel = spawn(spec.command, [...spec.args, connFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dir,
    env: { ...process.env, ...(spec.env ?? {}) },
  });

  let spawnError = null;
  kernel.on('error', (e) => {
    spawnError = e.message;
  });

  const shell = new Dealer();
  shell.routingId = randomBytes(8).toString('hex');
  shell.connect(`tcp://127.0.0.1:${info.shell_port}`);

  const iopub = new Subscriber();
  iopub.connect(`tcp://127.0.0.1:${info.iopub_port}`);
  iopub.subscribe('');

  // R 内核启动比 Python 慢得多（要加载 base 包），给足时间
  await new Promise((r) => setTimeout(r, spec.startupMs ?? 2500));

  if (spawnError !== null) {
    process.stdout.write(`FAIL  无法启动内核：${spawnError}\n`);
    shell.close();
    iopub.close();
    return false;
  }

  let failed = false;
  const check = (ok, label, detail) => {
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}\n`);
    if (!ok) failed = true;
  };

  /** 收集属于指定请求的 iopub 输出，直到该请求的 status=idle。 */
  async function collect(msgId, timeoutMs) {
    const out = { stream: [], result: null, display: null, error: null };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = parse(await iopub.receive());
      if (msg.parentHeader.msg_id !== msgId) continue; // 关键：过滤启动噪声与其他请求
      const t = msg.header.msg_type;
      if (t === 'stream') out.stream.push(msg.content.text);
      else if (t === 'execute_result') out.result = Object.keys(msg.content.data);
      else if (t === 'display_data') out.display = Object.keys(msg.content.data);
      else if (t === 'error') out.error = `${msg.content.ename}: ${msg.content.evalue}`;
      else if (t === 'status' && msg.content.execution_state === 'idle') break;
    }
    return out;
  }

  const timeout = spec.execTimeoutMs ?? 30_000;

  // 1. 握手
  await shell.send(frame('kernel_info_request', {}).parts);
  const reply = parse(await shell.receive());
  const li = reply.content.language_info ?? {};
  check(
    reply.header.msg_type === 'kernel_info_reply',
    'HMAC 握手          ',
    `实现=${reply.content.implementation} 语言=${li.name} ${li.version} 协议=${reply.content.protocol_version}`,
  );

  // 2. stdout + 富输出
  const r1 = frame('execute_request', execContent(probe.setup));
  await shell.send(r1.parts);
  const o1 = await collect(r1.msgId, timeout);
  if (o1.error !== null) check(false, '初始化无异常        ', o1.error);
  check(
    o1.stream.join('').trim() === 'sum: 45',
    'stdout 捕获        ',
    `"${o1.stream.join('').trim()}"`,
  );
  // 富输出可能落在 execute_result 或 display_data，取决于内核
  const rich = o1.result ?? o1.display ?? [];
  check(
    rich.includes('text/html') && rich.includes('text/plain'),
    '富输出多 MIME      ',
    rich.join(', '),
  );

  // 3. 跨 cell 状态持久
  const r2 = frame('execute_request', execContent(probe.persist));
  await shell.send(r2.parts);
  const o2 = await collect(r2.msgId, timeout);
  check(
    o2.stream.join('').trim() === 'persisted: 48',
    '跨 cell 状态持久   ',
    `"${o2.stream.join('').trim()}"`,
  );

  // 4. inline 图像
  const r3 = frame('execute_request', execContent(probe.plot));
  await shell.send(r3.parts);
  const o3 = await collect(r3.msgId, timeout);
  const imgMimes = [...(o3.display ?? []), ...(o3.result ?? [])];
  check(imgMimes.includes('image/png'), 'inline 图像        ', imgMimes.join(', ') || '(无)');

  // 5. 结构化异常
  const r4 = frame('execute_request', execContent(probe.fail));
  await shell.send(r4.parts);
  const o4 = await collect(r4.msgId, timeout);
  check(
    o4.error !== null && probe.expectedError.test(o4.error),
    '结构化异常         ',
    o4.error ?? '(无)',
  );

  shell.close();
  iopub.close();

  // 等内核真正退出，否则它的 cwd（临时目录）无法被删除。
  const exited = new Promise((r) => kernel.once('exit', () => r(true)));
  kernel.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 5000))]);

  return !failed;
}

/* ---------------------------------------------------------------- *
 * 组装待验证的内核
 * ---------------------------------------------------------------- */

const { envs } = condaInfo();
const specs = [];

const py = managedPython(envs);
if (py !== null) {
  specs.push({
    language: 'python',
    kernelName: 'python3',
    command: py.executable,
    args: ['-m', 'ipykernel_launcher', '-f'],
    startupMs: 2500,
  });
} else {
  process.stdout.write('跳过 Python：找不到托管环境 lsci\n');
}

const r = managedR(envs);
if (r !== null) {
  specs.push({
    language: 'r',
    kernelName: 'ir',
    command: r.rscript,
    args: [resolve(here, 'lib', 'irkernel-launch.R')],
    env: r.spawnEnv,
    // R 内核冷启动明显慢于 Python
    startupMs: 8000,
    execTimeoutMs: 45_000,
  });
} else {
  process.stdout.write('跳过 R：找不到托管环境 lsci-r 或 Rscript 不可用\n');
}

if (specs.length === 0) {
  process.stdout.write('没有可验证的内核。\n');
  process.exit(1);
}

let allOk = true;
for (const spec of specs) {
  if (only !== null && spec.language !== only) continue;
  const ok = await verify(spec);
  if (!ok) allOk = false;
}

const leftover = [];
for (const dir of tempDirs) {
  if (!(await removeWithRetry(dir))) leftover.push(dir);
}
if (leftover.length > 0) {
  process.stdout.write(`\n注意：${String(leftover.length)} 个临时目录未能删除（可手动清理）：\n`);
  for (const dir of leftover) process.stdout.write(`  ${dir}\n`);
}

process.stdout.write(allOk ? '\n结果：AD-2 全部通过\n' : '\n结果：有失败项\n');
process.exit(allOk ? 0 : 1);
