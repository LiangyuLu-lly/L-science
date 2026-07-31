/**
 * AD-2 端到端验证：从 Node 用 ZMQ 跟真实 ipykernel 完成 Jupyter 协议握手并执行代码。
 * 一次性验证脚本，M1 会把这套逻辑正式实现进 @l-science/kernel。
 *
 * 关键教训（已验证）：iopub 上的消息必须按 parent_header.msg_id 关联到发起的请求。
 * ipykernel 7 在启动阶段会自行推送 banner stream 与若干 status，按到达顺序取值一定错。
 */
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Dealer, Subscriber } from 'zeromq';

import { condaInfo, managedPython } from './lib/env.mjs';

const DELIM = '<IDS|MSG>';

const found = managedPython(condaInfo().envs);
if (found === null) {
  console.error('找不到托管环境 lsci。先创建它，或用 L_SCIENCE_PYTHON 指定解释器路径。');
  process.exit(1);
}
const PY = found.executable;

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const ports = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
const info = {
  transport: 'tcp',
  ip: '127.0.0.1',
  shell_port: ports[0],
  iopub_port: ports[1],
  stdin_port: ports[2],
  control_port: ports[3],
  hb_port: ports[4],
  key: randomUUID(),
  signature_scheme: 'hmac-sha256',
  kernel_name: 'python3',
};

const dir = mkdtempSync(join(tmpdir(), 'jk-'));
const connFile = join(dir, 'connection.json');
writeFileSync(connFile, JSON.stringify(info));

const session = randomBytes(16).toString('hex');
const sign = (h, p, m, c) =>
  createHmac('sha256', info.key).update(h).update(p).update(m).update(c).digest('hex');

/** 返回 { parts, msgId }，调用方需要 msgId 才能关联 iopub 输出。 */
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

function parse(parts) {
  const strs = parts.map((p) => p.toString());
  const i = strs.indexOf(DELIM);
  return {
    header: JSON.parse(strs[i + 2]),
    parentHeader: JSON.parse(strs[i + 3]),
    content: JSON.parse(strs[i + 5]),
  };
}

const execContent = (code) => ({
  code,
  silent: false,
  store_history: true,
  user_expressions: {},
  allow_stdin: false,
  stop_on_error: true,
});

console.log('启动 ipykernel ...');
const kernel = spawn(PY, ['-m', 'ipykernel_launcher', '-f', connFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: dir,
});

const shell = new Dealer();
shell.routingId = randomBytes(8).toString('hex');
shell.connect(`tcp://127.0.0.1:${info.shell_port}`);

const iopub = new Subscriber();
iopub.connect(`tcp://127.0.0.1:${info.iopub_port}`);
iopub.subscribe('');

await new Promise((r) => setTimeout(r, 2500));

let failed = false;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}`);
  if (!ok) failed = true;
};

/** 收集属于指定请求的 iopub 输出，直到该请求的 status=idle。 */
async function collect(msgId, timeoutMs = 25_000) {
  const out = { stream: [], result: null, error: null };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = parse(await iopub.receive());
    if (msg.parentHeader.msg_id !== msgId) continue; // 关键：过滤掉启动噪声与其他请求
    const t = msg.header.msg_type;
    if (t === 'stream') out.stream.push(msg.content.text);
    else if (t === 'execute_result') out.result = Object.keys(msg.content.data);
    else if (t === 'display_data') out.display = Object.keys(msg.content.data);
    else if (t === 'error') out.error = `${msg.content.ename}: ${msg.content.evalue}`;
    else if (t === 'status' && msg.content.execution_state === 'idle') break;
  }
  return out;
}

// --- 1. kernel_info_request -------------------------------------------------
const ki = frame('kernel_info_request', {});
await shell.send(ki.parts);
const reply = parse(await shell.receive());
check(
  reply.header.msg_type === 'kernel_info_reply',
  'kernel_info_reply    ',
  `实现=${reply.content.implementation} 语言=${reply.content.language_info?.name} ${reply.content.language_info?.version} 协议=${reply.content.protocol_version}`,
);

// --- 2. 执行代码：stdout 捕获 + 富输出 -------------------------------------
const r1 = frame(
  'execute_request',
  execContent(
    [
      'import numpy as np, pandas as pd',
      'x = np.arange(10)',
      'df = pd.DataFrame({"a":[1,2,3]})',
      'print("sum:", int(x.sum()))',
      'df',
    ].join('\n'),
  ),
);
await shell.send(r1.parts);
const o1 = await collect(r1.msgId);
if (o1.error !== null) check(false, '执行无异常          ', o1.error);
check(
  o1.stream.join('').trim() === 'sum: 45',
  'stdout 捕获          ',
  `"${o1.stream.join('').trim()}"`,
);
check(
  (o1.result ?? []).includes('text/html') && (o1.result ?? []).includes('text/plain'),
  '富输出 MIME          ',
  (o1.result ?? []).join(', '),
);

// --- 3. 跨 cell 状态持久 ---------------------------------------------------
const r2 = frame('execute_request', execContent('print("persisted:", int(x.sum()) + len(df))'));
await shell.send(r2.parts);
const o2 = await collect(r2.msgId);
check(
  o2.stream.join('').trim() === 'persisted: 48',
  '跨 cell 状态持久     ',
  `"${o2.stream.join('').trim()}"`,
);

// --- 4. matplotlib inline 图像 ---------------------------------------------
const r3 = frame(
  'execute_request',
  execContent(
    [
      // 裸 ipykernel 不会把 figure 渲染成 PNG，必须先启用 inline 后端。
      // M1 起内核时要把这一步做进初始化序列。
      '%matplotlib inline',
      'import matplotlib.pyplot as plt',
      'from IPython.display import display',
      'fig, ax = plt.subplots()',
      'ax.plot(x, x**2)',
      'display(fig)',
      'plt.close(fig)',
    ].join('\n'),
  ),
);
await shell.send(r3.parts);
const o3 = await collect(r3.msgId);
check(
  (o3.display ?? []).includes('image/png'),
  '图像作为 display_data',
  (o3.display ?? []).join(', '),
);

// --- 5. 异常作为结构化 error 而非 stderr 文本 -----------------------------
const r4 = frame('execute_request', execContent('1/0'));
await shell.send(r4.parts);
const o4 = await collect(r4.msgId);
check(
  o4.error !== null && o4.error.startsWith('ZeroDivisionError'),
  '结构化异常           ',
  o4.error ?? '(无)',
);

shell.close();
iopub.close();
kernel.kill();

console.log(failed ? '\n结果：有失败项' : '\n结果：AD-2 全部通过');
process.exit(failed ? 1 : 0);
