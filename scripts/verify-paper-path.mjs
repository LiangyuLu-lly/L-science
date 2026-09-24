#!/usr/bin/env node
/**
 * 论文主路径的真机点击链验证（需求 S9 判据）。
 *
 * 为什么不能只跑 vitest：源码契约测试读文件、比对字符串。它们全绿的时候，
 * 界面可能根本没有按钮（本仓库真实发生过：13 个 ledger 类没有一条样式，
 * 而测试全绿）。这个脚本对着**真实运行的桌面外壳**点一遍：
 *
 *   文献 -> 贴 DOI 入库 -> 选中 -> 从本篇抽断言 -> 断言页确认
 *        -> 手稿编译 -> 设置看授权
 *
 * 每一步都要求界面出现可观察的产物（卡片、断言行、编译报告、授权标题），
 * 并写下截图。任何一步没有产物就是 FAIL。
 *
 * 前置：
 *   npm run dev:ui      （另一个终端，Vite 5223）
 *   npm run dev:shell   （Electron + CDP 9222）
 *
 * 用法：node scripts/verify-paper-path.mjs [--keep-shots]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(repoRoot, 'docs', 'screenshots', 'paper-path');
const CDP_BASE = `http://127.0.0.1:${process.env.L_SCIENCE_CDP_PORT ?? '9222'}`;

/** 一个真实可解析的 DOI（AlphaFold 论文）。解析要联网，Crossref 在启动时已预放行。 */
const DOI = '10.1038/s41586-021-03819-2';

const MANUSCRIPT = `---
title: 打包验证手稿
journal: Nature
---

# 引言

这是一段用于验证编译链路的正文。

# 方法

我们不引用任何一条编造的文献。
`;

let failed = false;
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok, label, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}\n`);
  if (!ok) failed = true;
};

async function findPage() {
  let list;
  try {
    list = await (await fetch(`${CDP_BASE}/json/list`)).json();
  } catch {
    process.stderr.write(
      `无法连接 ${CDP_BASE}。请先启动开发外壳：\n  npm run dev:ui\n  npm run dev:shell\n`,
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
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
});

await send('Runtime.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到表达式为真，返回它最后一次的值。 */
async function waitFor(expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last === true || (typeof last === 'number' && last > 0)) return last;
    await sleep(250);
  }
  throw new Error(`等待「${what}」超时`);
}

/** 按可见文字点一个按钮。 */
const clickByText = (text) =>
  evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const hit = els.find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
    if (hit === undefined) return false;
    hit.click();
    return true;
  })()`);

let shotSeq = 0;
async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(shotDir, { recursive: true });
  shotSeq += 1;
  const file = join(shotDir, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(res.data, 'base64'));
  return file;
}

/* ------------------------------------------------------------------ *
 * 0. 桥接与后端就绪
 * ------------------------------------------------------------------ */

await sleep(3000);
const bridge = await evaluate(`window.lscience === undefined ? '__MISSING__' : 'ok'`);
check(bridge !== '__MISSING__', '桌面桥接已注入', String(bridge));

try {
  await waitFor(
    `document.querySelector('.badge--ready') !== null`,
    20000,
    '控制平面就绪',
  );
  check(true, '控制平面就绪');
} catch (err) {
  check(false, '控制平面就绪', err.message);
}

/* ------------------------------------------------------------------ *
 * 1. 跳过首次引导后，文献必须仍然可用
 * ------------------------------------------------------------------ */

// 先回到文献：脚本可能在任意视图上被调用（上一次运行会停在设置页）
await clickByText('文献');
await sleep(600);

  const skipped = await clickByText('本次跳过');
  if (skipped) {
    await sleep(800);
    check(
      (await evaluate(`document.querySelector('.overlay') === null`)) === true,
      '跳过首次引导后遮罩关闭',
    );
  } else {
    check(true, '本次跳过（本次运行没有遮罩，视为已配置）');
  }

  // onSkip 固定落到设置页（App.tsx setView('settings')）。
  // 「跳过不挡文献」的判据是回到文献后输入框在，不是跳过之后还停在文献。
  // skippedThisSession 为真时再进文献不会把遮罩弹回来。
  await clickByText('文献');
  try {
    await waitFor(`document.querySelector('#ref-identifiers') !== null`, 8000, '文献页 DOI 输入框');
    check(true, '文献页在没有密钥时也可用（贴 DOI 输入框存在）');
  } catch (err) {
    check(false, '文献页在没有密钥时也可用（贴 DOI 输入框存在）', err.message);
  }
  await shot('refs-empty');

/* ------------------------------------------------------------------ *
 * 2. 贴 DOI 入库
 * ------------------------------------------------------------------ */

await evaluate(`(() => {
  const el = document.querySelector('#ref-identifiers');
  if (el === null) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(DOI)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const submitted = await evaluate(`(() => {
  const form = document.querySelector('#ref-identifiers')?.closest('form');
  if (form === null || form === undefined) return false;
  form.requestSubmit();
  return true;
})()`);
check(submitted === true, '已提交 DOI', DOI);

try {
  // 注意：空态的拖拽区也带 .ref-card 类，等它会立刻假通过。
  // 真正的条目才有「选中」按钮，等它才是等入库完成。
  await waitFor(`document.querySelectorAll('.ref-card__select').length`, 40000, '文献卡片出现');
  check(true, '文献入库成功（出现可选中条目）');
} catch (err) {
  const errText = await evaluate(
    `document.querySelector('.panel__error')?.textContent ?? '(没有错误提示)'`,
  );
  check(false, '文献入库成功', `${err.message}｜界面错误：${errText}`);
}
await shot('refs-after-resolve');

/* ------------------------------------------------------------------ *
 * 3. 选中 + 从本篇抽断言（本地抽取，不需要模型）
 * ------------------------------------------------------------------ */

const selectedOk = await evaluate(`(() => {
  const card = document.querySelector('.ref-card__select');
  if (card === null || card === undefined) return false;
  card.click();
  return true;
})()`);
check(selectedOk === true, '点中文献条目');
await sleep(600);
check(
  (await evaluate(`document.querySelector('.dock-paper') !== null`)) === true,
  '选中文献后底部显示当前文献',
);

const extractClicked = await clickByText('从本篇抽断言');
check(extractClicked === true, '找到并点击「从本篇抽断言」');
await sleep(2500);
await shot('after-extract');

/* ------------------------------------------------------------------ *
 * 4. 断言页：有行、有来源章
 * ------------------------------------------------------------------ */

await clickByText('断言');
await sleep(800);
let rowCount = 0;
try {
  rowCount = await waitFor(`document.querySelectorAll('.ledger__row').length`, 15000, '断言行出现');
  check(rowCount > 0, '断言页出现可操作的行', `${String(rowCount)} 行`);
} catch (err) {
  check(false, '断言页出现可操作的行', err.message);
}

const noteText = await evaluate(`document.querySelector('.ledger__pane')?.textContent ?? ''`);
const listText = await evaluate(`document.querySelector('.ledger')?.textContent ?? ''`);
check(
  `${listText}${noteText}`.includes('摘自'),
  '断言带来源章（摘自全文 / 摘自题录与摘要）',
  `${listText}${noteText}`.includes('摘自题录与摘要（无全文）') ? '本题录路径' : '全文路径',
);
await shot('claims-ledger');

/* ------------------------------------------------------------------ *
 * 5. 断言确认真能点
 * ------------------------------------------------------------------ */

const confirmed = await clickByText('确认');
check(confirmed === true, '断言行有「确认」可点');
await sleep(1200);
const alertAfterConfirm = await evaluate(
  `document.querySelector('.panel__error')?.textContent ?? ''`,
);
check(alertAfterConfirm === '', '确认没有报错', alertAfterConfirm);
await shot('claims-after-confirm');

/* ------------------------------------------------------------------ *
 * 6. 手稿编译（本地，不需要模型）
 * ------------------------------------------------------------------ */

await clickByText('手稿');
await sleep(600);
await evaluate(`(() => {
  const el = document.querySelector('#manuscript-source');
  if (el === null) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(MANUSCRIPT)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await shot('manuscript-editor');
const compiled = await clickByText('编译');
check(compiled === true, '找到并点击「编译」');

try {
  await waitFor(
    `(document.body.textContent ?? '').includes('警告') ? 1 : 0`,
    30000,
    '编译报告出现',
  );
  check(true, '编译产出报告（含错误/警告计数）');
} catch (err) {
  const errText = await evaluate(`document.querySelector('.panel__error')?.textContent ?? ''`);
  check(false, '编译产出报告', `${err.message}｜界面错误：${errText}`);
}
const resultAccess = await evaluate(
  `(document.body.textContent ?? '').includes('在制品里查看')`,
);
check(resultAccess === true, '编译结果指向「在制品里查看」（不是假的文件夹揭示）');
await shot('manuscript-compiled');

/* ------------------------------------------------------------------ *
 * 7. 设置里的授权区（兑现审批卡的承诺）
 * ------------------------------------------------------------------ */

await clickByText('设置');
await sleep(800);
const grantHeading = await evaluate(`(() => {
  const heads = [...document.querySelectorAll('h2, h3')];
  const hit = heads.find((h) => (h.textContent ?? '').includes('授权'));
  return hit === undefined ? '' : (hit.textContent ?? '').trim();
})()`);
check(grantHeading !== '', '设置页有授权区', grantHeading);
await shot('settings-grants');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

check(consoleErrors.length === 0, '控制台没有 error', consoleErrors.slice(0, 2).join(' ｜ '));

const passCount = results.filter((r) => r.ok).length;
process.stdout.write(
  `\n截图：${shotDir}（${String(shotSeq)} 张）\n` +
    `通过 ${String(passCount)}，失败 ${String(results.length - passCount)}\n`,
);
process.exit(failed ? 1 : 0);
