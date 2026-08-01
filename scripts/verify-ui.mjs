#!/usr/bin/env node
/**
 * 渲染层实际状态检查（通过 Chrome DevTools Protocol）。
 *
 * 为什么需要它：单元测试覆盖不到「Electron 把两个进程、preload、contextBridge
 * 和渲染层拼起来之后到底是什么样」。实测中它抓到过一个单测完全无法发现的问题——
 * sandbox 下的 preload 必须是 CommonJS，编成 ESM 会让 Electron 静默放弃加载
 * preload：窗口正常打开、没有未捕获异常，但 window.lscience 不存在，IPC 全废。
 *
 * 用法：
 *   1. 起开发服务器：      npm run dev:ui
 *   2. 带调试端口起外壳：  npm run dev:shell
 *   3. 检查：              npm run verify:ui
 *
 * 调试端口只监听回环地址，且仅在手动传入 --remote-debugging-port 时开启，
 * 不是常态配置。
 */

import { writeFileSync } from 'node:fs';

const CDP_PORT = process.env.L_SCIENCE_CDP_PORT ?? '9222';
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

let failed = false;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}\n`);
  if (!ok) failed = true;
};

async function findPage() {
  let list;
  try {
    list = await (await fetch(`${CDP_BASE}/json/list`)).json();
  } catch {
    process.stderr.write(
      `无法连接 ${CDP_BASE}。请先以调试模式启动外壳：\n` +
        '  npm run dev:ui        （另一个终端）\n' +
        '  npm run dev:shell\n',
    );
    process.exit(2);
  }
  const page = list.find((t) => t.type === 'page');
  if (page === undefined) {
    process.stderr.write('CDP 里没有 page target，渲染层可能尚未创建窗口。\n');
    process.exit(2);
  }
  return page;
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);

let seq = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(
      (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '),
    );
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.text ?? '未知异常');
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
});

await send('Runtime.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) return { error: res.exceptionDetails.text };
  return { value: res.result.value };
};

// 等 useBackend 完成首次探测
await new Promise((r) => setTimeout(r, 2500));

/* --- 1. preload 是否生效 ------------------------------------------------- */
const bridge = await evaluate(
  `window.lscience ? Object.keys(window.lscience).join(',') : '__MISSING__'`,
);
const bridgeOk = bridge.value !== '__MISSING__' && bridge.value !== undefined;
check(
  bridgeOk,
  'preload 已加载      ',
  bridgeOk ? `暴露 ${bridge.value}` : 'window.lscience 不存在 —— 检查 preload 是否被编成了 ESM',
);

/* --- 2. 未泄漏 Node/Electron 内部对象 ----------------------------------- */
const leaks = await evaluate(
  `['ipcRenderer','require','process','electron','module','global'].filter(k => k in window).join(',')`,
);
check(leaks.value === '', '未泄漏内部对象      ', leaks.value === '' ? '' : `泄漏：${leaks.value}`);

/* --- 3. 后端连接状态 ---------------------------------------------------- */
const badge = await evaluate(
  `(() => { const b = document.querySelector('.badge'); return b ? b.className + '|' + b.textContent : '__NONE__'; })()`,
);
const connected = String(badge.value).includes('badge--ready');
check(connected, '后端已连接          ', String(badge.value).split('|')[1] ?? String(badge.value));

/* --- 4. 真实往返调用 ---------------------------------------------------- */
const status = await evaluate(
  `window.lscience ? window.lscience.invoke({method:'app.status'}).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message) : 'ERR:no bridge'`,
);
const statusOk = typeof status.value === 'string' && status.value.startsWith('{');
check(
  statusOk,
  'app.status 往返     ',
  statusOk ? JSON.parse(status.value).dataDir : String(status.value),
);

/* --- 5. 渲染层无错误 ---------------------------------------------------- */
check(
  pageErrors.length === 0 && consoleErrors.length === 0,
  '渲染层无错误        ',
  [...pageErrors, ...consoleErrors].join(' | '),
);

/* --- 6. 可访问性：交互元素可聚焦（需求 20.5.2）------------------------- */
const focusables = await evaluate(
  `[...document.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].length`,
);
const interactive = await evaluate(`document.querySelectorAll('.app__nav li').length`);
// 当前导航项还是占位文本，尚未成为可交互控件；这条只报告不判失败。
process.stdout.write(
  `INFO  可聚焦元素          ${String(focusables.value)} 个（导航占位项 ${String(interactive.value)} 个，成为真实导航后须可键盘操作）\n`,
);

/* --- 输出可见文本与截图便于人工核对 ------------------------------------ */
const text = await evaluate('document.body.innerText');
process.stdout.write(`\n---------- 渲染出的可见文本 ----------\n${String(text.value)}\n`);

const shotPath = process.env.SHOT_PATH ?? 'ui-shot.png';
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  process.stdout.write(`\n截图：${shotPath}\n`);
} catch {
  process.stdout.write('\n截图失败（不影响检查结果）\n');
}

ws.close();
process.stdout.write(failed ? '\n结果：有失败项\n' : '\n结果：渲染层检查全部通过\n');
process.exit(failed ? 1 : 0);
