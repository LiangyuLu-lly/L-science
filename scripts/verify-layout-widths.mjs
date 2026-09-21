#!/usr/bin/env node
/**
 * 多宽度版式检查。
 *
 * 为什么单独做：真机点击链证明了「功能走得通」，截图是 1280 一档。而论文工作台
 * 会被拉成各种窗口宽（小笔记本 1024、分屏 900、最大化 1600+）。窄窗口最容易出事
 * 的地方是断言账本的两栏（左列表 + 右证据）和文献的三栏——挤在一起时按钮会被压掉。
 *
 * 这里不强断「好看」，只报告每档宽度下的硬事实：是否出现横向滚动条、账本两栏是否
 * 还在、按钮是否还被渲染。横向滚动条是真正的缺陷信号：它意味着内容被推到屏幕外。
 *
 * 前置与 verify-paper-path 相同：npm run dev:ui / npm run dev:shell
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(repoRoot, 'docs', 'screenshots', 'layout');
const CDP_BASE = `http://127.0.0.1:${process.env.L_SCIENCE_CDP_PORT ?? '9222'}`;

/** 桌面应用的常见档位。375 不做：本项目不发移动端。 */
const WIDTHS = [
  { w: 1024, h: 720, label: '1024-small-laptop' },
  { w: 1280, h: 800, label: '1280-default' },
  { w: 1600, h: 900, label: '1600-split-or-large' },
];

const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (page === undefined) {
  process.stderr.write(`CDP 里没有 page target。先启动 npm run dev:ui 与 npm run dev:shell。\n`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
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
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByText = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(${JSON.stringify(text)}));
    if (el === undefined) return false;
    el.click();
    return true;
  })()`);

let failed = false;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}\n`);
  if (!ok) failed = true;
};

/** 当前页面的硬事实：横向溢出、账本两栏、按钮数。 */
const probe = () =>
  evaluate(`(() => {
    const root = document.documentElement;
    const overflowX = root.scrollWidth - root.clientWidth;
    const ledger = document.querySelector('.ledger');
    const cols = ledger === null ? '' : getComputedStyle(ledger).gridTemplateColumns;
    return {
      overflowX,
      ledgerColumns: cols,
      ledgerRows: document.querySelectorAll('.ledger__row').length,
      visibleButtons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).length,
      composerVisible: document.querySelector('#composer-input') !== null,
    };
  })()`);

mkdirSync(shotDir, { recursive: true });

for (const { w, h, label } of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);

  // 文献
  await clickByText('文献');
  await sleep(500);
  const refs = await probe();
  check(refs.overflowX <= 1, `${label} 文献：没有横向溢出`, `溢出 ${String(refs.overflowX)}px，可见按钮 ${String(refs.visibleButtons)}`);
  check(refs.composerVisible, `${label} 文献：输入框常驻`);
  const a = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${label}-refs.png`), Buffer.from(a.data, 'base64'));

  // 断言（账本两栏最容易在窄窗口塌）
  await clickByText('断言');
  await sleep(600);
  const claims = await probe();
  check(claims.overflowX <= 1, `${label} 断言：没有横向溢出`, `溢出 ${String(claims.overflowX)}px`);
  check(
    claims.ledgerRows === 0 || claims.ledgerColumns !== '',
    `${label} 断言：账本容器有版式`,
    claims.ledgerRows === 0 ? '（本次没有断言行，跳过栏检查）' : claims.ledgerColumns,
  );
  if (claims.ledgerRows > 0) {
    const twoCol = claims.ledgerColumns.split(' ').length >= 2;
    check(
      w < 900 ? true : twoCol,
      `${label} 断言：宽窗口下账本保留「列表 + 证据」两栏`,
      claims.ledgerColumns,
    );
  }
  const b = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${label}-claims.png`), Buffer.from(b.data, 'base64'));

  // 手稿
  await clickByText('手稿');
  await sleep(500);
  const ms = await probe();
  check(ms.overflowX <= 1, `${label} 手稿：没有横向溢出`, `溢出 ${String(ms.overflowX)}px`);
  const c = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${label}-manuscript.png`), Buffer.from(c.data, 'base64'));
}

await send('Emulation.clearDeviceMetricsOverride');
process.stdout.write(`\n截图：${shotDir}\n退出码：${failed ? 1 : 0}\n`);
process.exit(failed ? 1 : 0);
