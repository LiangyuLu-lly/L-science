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
check(Number(focusables.value) > 0, '存在可聚焦元素      ', `${String(focusables.value)} 个`);

/* --- 7. 无障碍名称（需求 20.5.2）---------------------------------------
 *
 * 静态检查只能看到源码里写了什么，看不到浏览器最终算出的无障碍名称——那是 label 关联、
 * aria-*、内容文本、placeholder 一起参与的结果。这一段问的是浏览器自己：拿无障碍树，
 * 看有没有哪个可聚焦控件的名字是空的。名字为空时屏幕阅读器只会念出角色（「按钮」），
 * 而一屏上有六十多个按钮。
 */
await send('DOM.enable');
await send('Accessibility.enable');
const { nodes: axNodes } = await send('Accessibility.getFullAXTree');

const FOCUSABLE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'searchbox',
  'menuitem',
  'tab',
]);

/** 当前视图里没有无障碍名称的控件。 */
const namelessControls = async () => {
  const { nodes } = await send('Accessibility.getFullAXTree');
  const nameless = [];
  let counted = 0;
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = node.role?.value;
    if (!FOCUSABLE_ROLES.has(role)) continue;
    counted += 1;
    const name = (node.name?.value ?? '').trim();
    const disabled = (node.properties ?? []).some(
      (p) => p.name === 'disabled' && p.value?.value === true,
    );
    if (name === '' && !disabled) nameless.push(role);
  }
  return { nameless, counted };
};

const firstView = await namelessControls();
check(
  firstView.nameless.length === 0,
  '控件都有无障碍名称  ',
  firstView.nameless.length === 0
    ? `会话视图 ${String(firstView.counted)} 个控件`
    : `无名控件：${firstView.nameless.join('、')}`,
);
void axNodes;

/* --- 8. Tab 顺序可达性（需求 20.5.2）----------------------------------- */
const tabTo = async () => {
  // rawKeyDown + char + keyUp 是 CDP 里模拟真实按键的完整序列；只发 keyDown
  // 不会触发浏览器的默认焦点移动
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    key: 'Tab',
    code: 'Tab',
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    key: 'Tab',
    code: 'Tab',
  });
  const r = await evaluate(
    `(() => { const el = document.activeElement; if (el === null) return 'null';
       return [el.tagName, el.className || '', (el.textContent || '').trim().slice(0, 20)].join('|'); })()`,
  );
  return String(r.value);
};

// 把焦点收回文档本身，让 Tab 从头开始。document.body.focus() 在 body 没有 tabindex
// 时是空操作，因此要 blur 当前那个元素
await evaluate(
  `(() => { const el = document.activeElement; if (el instanceof HTMLElement) el.blur(); return document.activeElement === document.body; })()`,
);
const tabOrder = [];
for (let i = 0; i < 60; i += 1) {
  const where = await tabTo();
  tabOrder.push(where);
  // 焦点回到起点说明走完一圈
  if (i > 2 && where === tabOrder[0]) break;
}

/*
 * 跳转入口必须排在主导航之前。
 *
 * 断言的是**相对次序**而不是「第一站」：这个页面可能已经有一个控件持有焦点（启动过程中
 * 的一次点击就够了），那时 Tab 从中途开始并绕回来。相对次序在绕回时保持不变，而
 * 「第一站」会随起点变化——一个会因为起点不同而红绿摇摆的检查等于没有检查。
 */
const skipAt = tabOrder.findIndex((t) => t.includes('skip-to-main'));
const firstNavAt = tabOrder.findIndex((t) => t.includes('nav__item'));
check(
  skipAt !== -1 && firstNavAt !== -1 && skipAt < firstNavAt,
  '跳转入口在导航之前  ',
  `跳转第 ${String(skipAt + 1)} 站，导航第 ${String(firstNavAt + 1)} 站`,
);
// 主导航的每一项都必须能被 Tab 走到
const navReached = tabOrder.filter((t) => t.includes('nav__item')).length;
check(navReached >= 8, '主导航全部可 Tab 到 ', `走到 ${String(navReached)} 项`);
// 焦点不能困在一处：连续两站相同说明卡住了
const stuck = tabOrder.findIndex((t, i) => i > 0 && t === tabOrder[i - 1]);
check(stuck === -1, '无焦点陷阱          ', stuck === -1 ? '' : `卡在 ${tabOrder[stuck]}`);

/* --- 9. 实测对比度（需求 20.5.3）--------------------------------------
 *
 * 静态检查只能判定同一条规则里同时声明的前景/背景。真实页面上背景多半来自某个祖先，
 * 而那要解析层叠才知道——这里直接问 getComputedStyle，拿的是浏览器算完的结果。
 */
const CONTRAST_PROBE = `(() => {
  const lum = (rgb) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const parse = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s);
    if (m === null) return null;
    const parts = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: [parts[0], parts[1], parts[2]], a: parts.length > 3 ? parts[3] : 1 };
  };
  // 有效背景：往上找第一个不透明的背景色
  const bgOf = (el) => {
    let node = el;
    while (node !== null) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c !== null && c.a > 0.99) return c.rgb;
      node = node.parentElement;
    }
    return [17, 19, 24];
  };
  const bad = [];
  let checked = 0;
  for (const el of document.querySelectorAll('*')) {
    // 只看直接含可见文本的元素
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!own) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (parseFloat(style.opacity) < 0.9) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const fg = parse(style.color);
    if (fg === null || fg.a < 0.99) continue;
    const bg = bgOf(el);
    const la = lum(fg.rgb);
    const lb = lum(bg);
    const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    checked += 1;
    if (ratio < need) {
      bad.push(
        (el.className || el.tagName) + ' ' + ratio.toFixed(2) + '<' + need +
          ' (' + style.color + ' on rgb(' + bg.join(',') + '), ' + size + 'px)',
      );
    }
  }
  return JSON.stringify({ checked, bad: bad.slice(0, 12), total: bad.length });
})()`;

const contrastResult = JSON.parse(String((await evaluate(CONTRAST_PROBE)).value));
check(
  contrastResult.total === 0,
  '实测文字对比度达标  ',
  contrastResult.total === 0
    ? `会话视图 ${String(contrastResult.checked)} 个含文本元素`
    : `${String(contrastResult.total)} 处不达标：${contrastResult.bad.join(' | ')}`,
);

/* --- 10. 逐个视图扫一遍（需求 20.5.2、20.5.3）--------------------------
 *
 * 上面两条只看了会话视图。八个视图各自有几十个控件，而只查默认视图恰好会漏掉最容易
 * 出问题的那些——那三个没有标签的技能导入输入框就在「技能」视图里，任何只看首屏的
 * 检查都发现不了它们。
 *
 * 切视图靠点主导航按钮：这与用户的操作路径一致，顺便验证了导航本身能用。
 */
const viewLabels = JSON.parse(
  String(
    (
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.nav__item')].map((b) => b.textContent.trim()))`,
      )
    ).value,
  ),
);

const perView = [];
for (let i = 0; i < viewLabels.length; i += 1) {
  await evaluate(`[...document.querySelectorAll('.nav__item')][${String(i)}].click()`);
  // 视图切换后要等它自己的首次拉取落地，否则查到的是空壳
  await new Promise((r) => setTimeout(r, 1200));

  const names = await namelessControls();
  const contrastOfView = JSON.parse(String((await evaluate(CONTRAST_PROBE)).value));
  perView.push({
    label: viewLabels[i],
    controls: names.counted,
    nameless: names.nameless,
    texts: contrastOfView.checked,
    bad: contrastOfView.bad,
    badTotal: contrastOfView.total,
  });
}

const namelessViews = perView.filter((v) => v.nameless.length > 0);
check(
  namelessViews.length === 0,
  '各视图控件均有名称  ',
  namelessViews.length === 0
    ? perView.map((v) => `${v.label}:${String(v.controls)}`).join(' ')
    : namelessViews.map((v) => `${v.label}(${v.nameless.join('、')})`).join(' | '),
);

const badViews = perView.filter((v) => v.badTotal > 0);
check(
  badViews.length === 0,
  '各视图对比度达标    ',
  badViews.length === 0
    ? `共检查 ${String(perView.reduce((s, v) => s + v.texts, 0))} 个含文本元素`
    : badViews.map((v) => `${v.label}: ${v.bad.join(' , ')}`).join(' | '),
);

// 切回会话，让截图与可见文本反映默认视图
await evaluate(`[...document.querySelectorAll('.nav__item')][0].click()`);
await new Promise((r) => setTimeout(r, 600));

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
