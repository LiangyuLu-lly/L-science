/**
 * 本地化与可访问性（任务 15.3，需求 20.5.1-20.5.3）。
 *
 * 这三条需求的共同点是**回退的时候没有信号**。少一个 `aria-label`、把一个 `<label>`
 * 写成 `<span>`、给按钮配一个 1.3:1 的边框，界面看起来都完全正常——用鼠标和正常视力的人
 * 永远不会发现。也正因为如此，它们靠人工核对是守不住的：核对过一次的结论在下一个组件
 * 加进来之后就失效了。
 *
 * 因此这里把能判定的部分变成断言。判不了的（屏幕阅读器实际读出什么、Tab 顺序是否符合
 * 阅读顺序）留给 `scripts/verify-ui.mjs` 在真实 DOM 上查，那一层能拿到无障碍树。
 *
 * 需要说清的一点：这些断言不等于「符合 WCAG」。真正的合规判定需要用辅助技术实测并由
 * 专业人员评审，任何静态检查都只能覆盖其中机械可判的那部分。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI = join('packages', 'ui', 'src');
const CSS = readFileSync(join(UI, 'styles.css'), 'utf8');
const HTML = readFileSync(join('packages', 'ui', 'index.html'), 'utf8');

function tsxFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(UI, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx$/u.test(entry)) continue;
    out.push(join(UI, entry));
  }
  return out;
}

const FILES = tsxFiles();

/* ------------------------------------------------------------------ *
 * JSX 标签提取
 * ------------------------------------------------------------------ */

/**
 * 取出某个标签的全部出现，连同它完整的属性文本。
 *
 * 不能用 `/<input[^>]*>/`：JSX 属性里全是箭头函数，`onChange={(e) => …}` 里的那个 `>`
 * 会让正则提前收尾，于是写在箭头函数之后的 `aria-label` 被漏掉。漏掉的方向是**误报**
 * ——检查会指着一个其实合规的控件，而修不掉的告警最后会被整条关掉。
 *
 * 所以按字符扫，跟踪花括号深度与字符串状态，深度为 0 时的 `>` 才是标签结束。
 */
function jsxTags(text: string, name: string): Array<{ attrs: string; line: number; end: number }> {
  const out: Array<{ attrs: string; line: number; end: number }> = [];
  const opener = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  for (const m of text.matchAll(opener)) {
    let i = m.index + name.length + 1;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    out.push({
      attrs: text.slice(m.index + name.length + 1, i),
      line: text.slice(0, m.index).split('\n').length,
      end: i,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 对比度计算（WCAG 2.1 相对亮度）
 * ------------------------------------------------------------------ */

function parseHex(hex: string): [number, number, number] | null {
  let s = hex.replace('#', '');
  if (s.length === 3) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  // 8 位是带 alpha 的写法，按不透明处理——alpha 参与之后要知道下层是什么，
  // 而那要解析层叠，超出静态检查能做的范围
  if (s.length === 8) s = s.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/u.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (ca === null || cb === null) return Number.NaN;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const TOKENS = new Map<string, string>();
for (const m of CSS.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gu)) {
  TOKENS.set(m[1] ?? '', m[2] ?? '');
}

function token(name: string): string {
  const value = TOKENS.get(name);
  if (value === undefined) throw new Error(`styles.css 里没有设计令牌 ${name}`);
  return value;
}

/** 解析一个颜色声明的取值，支持 `var(--x)` 与字面量。无法静态确定时返回 null。 */
function resolveColor(value: string): string | null {
  const varName = /var\((--[\w-]+)/u.exec(value);
  if (varName !== null) return TOKENS.get(varName[1] ?? '') ?? null;
  const hex = /#[0-9a-fA-F]{3,8}\b/u.exec(value);
  return hex === null ? null : hex[0];
}

interface CssRule {
  selector: string;
  body: string;
}

function cssRules(): CssRule[] {
  const out: CssRule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = (m[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .join(' ');
    out.push({ selector, body: m[2] ?? '' });
  }
  return out;
}

const RULES = cssRules();

/* ------------------------------------------------------------------ *
 * 20.5.1 本地化与中英混排
 * ------------------------------------------------------------------ */

describe('本地化（20.5.1）', () => {
  it('文档语言声明为简体中文', () => {
    // 少了它，屏幕阅读器会按系统语言念中文，而念错语言的结果是完全不可听
    expect(HTML).toMatch(/<html[^>]*lang="zh-CN"/u);
    expect(HTML).toMatch(/charset="UTF-8"/iu);
  });

  it('字体栈显式包含 CJK 字体，且排在拉丁字体之后', () => {
    const stack = /font-family:([\s\S]*?);/u.exec(CSS)?.[1] ?? '';
    /*
     * 'Segoe UI' 没有汉字字形。不显式给 CJK 字体时，汉字由浏览器的默认后备渲染，而那个
     * 后备在不同机器上不一样——中文界面里最常见的表现是汉字与拉丁字母的字重和基线对不上。
     */
    const cjk = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC'];
    for (const family of cjk) expect(stack).toContain(family);

    // 顺序：拉丁在前。反过来英文也会用 CJK 字体里的拉丁字形，那套字形偏宽
    const latinAt = stack.indexOf('Segoe UI');
    const cjkAt = stack.indexOf('Microsoft YaHei');
    expect(latinAt).toBeGreaterThanOrEqual(0);
    expect(cjkAt).toBeGreaterThan(latinAt);
  });

  it('长标识符能断行', () => {
    /*
     * DOI、文件路径、模型 id 都是没有空格的长串。不断行的话它们撑宽容器，在窄侧栏里
     * 表现为横向滚动或被裁掉——而被裁掉的那一截往往正是区分两个 DOI 的部分。
     */
    const needsWrap = ['code', '.kv dd', '.msg__body'];
    for (const selector of needsWrap) {
      const rule = RULES.find((r) => r.selector === selector);
      expect(rule, `styles.css 里找不到 ${selector}`).toBeDefined();
      expect(rule?.body, `${selector} 需要 overflow-wrap`).toMatch(/overflow-wrap:\s*anywhere/u);
    }
  });

  it('给屏幕阅读器的标签是中文', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/aria-label=["']([^"']+)["']/gu)) {
        // 这些标签只有辅助技术会读到，因此它们是最容易被留在英文里的一处
        if (!/[\u4e00-\u9fff]/u.test(m[1] ?? '')) {
          offenders.push(`${file}:${text.slice(0, m.index).split('\n').length}  ${m[1] ?? ''}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 20.5.2 键盘与语义
 * ------------------------------------------------------------------ */

describe('键盘可达与语义（20.5.2）', () => {
  it('每个表单控件都有可编程访问的名称', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      // htmlFor 的取值，字面量与 {表达式} 两种写法都收
      const labelFor = new Set<string>();
      for (const m of text.matchAll(/htmlFor=\{([^}]+)\}/gu)) labelFor.add((m[1] ?? '').trim());
      for (const m of text.matchAll(/htmlFor=["']([^"']+)["']/gu)) labelFor.add(m[1] ?? '');

      for (const tag of ['input', 'select', 'textarea']) {
        for (const { attrs, line, end } of jsxTags(text, tag)) {
          if (/type="hidden"/u.test(attrs)) continue;

          const idExpr =
            /\bid=\{([^}]+)\}/u.exec(attrs)?.[1]?.trim() ??
            /\bid=["']([^"']+)["']/u.exec(attrs)?.[1] ??
            null;

          const explicit =
            /aria-label[=\s]/u.test(attrs) ||
            /aria-labelledby[=\s]/u.test(attrs) ||
            (idExpr !== null && labelFor.has(idExpr));

          // 隐式关联：被 <label> 包着。往前找最近的 <label，中间不能有 </label>
          const before = text.slice(0, end);
          const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');

          if (!explicit && !wrapped) {
            offenders.push(`${file.split(sep).join('/')}:${String(line)}  <${tag}>`);
          }
        }
      }
    }

    expect(
      offenders,
      '给它加 <label htmlFor> 或 aria-label。旁边放一个 <span> 在视觉上是标签，' +
        '在程序上不是——屏幕阅读器把焦点移过来只会读「编辑框」，而一屏上并列几个输入框时' +
        '那等于分不清哪个是哪个。',
    ).toEqual([]);
  });

  it('点击处理器只挂在可交互元素上', () => {
    const offenders: string[] = [];
    const nonInteractive = [
      'div',
      'span',
      'li',
      'p',
      'td',
      'tr',
      'section',
      'header',
      'article',
      'ul',
      'ol',
      'pre',
      'img',
    ];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const tag of nonInteractive) {
        for (const { attrs, line } of jsxTags(text, tag)) {
          if (!/onClick[=\s]/u.test(attrs)) continue;
          /*
           * 挂在 div 上的 onClick 对鼠标有效、对键盘无效，而且屏幕阅读器不会把它当成
           * 可操作的东西。要么换成 button，要么补齐 role + tabIndex + 键盘处理三件套
           * ——三件缺一件都不算可用。
           */
          const patched =
            /role[=\s]/u.test(attrs) &&
            /tabIndex[=\s]/u.test(attrs) &&
            /onKey(?:Down|Up|Press)[=\s]/u.test(attrs);
          if (!patched) {
            offenders.push(`${file.split(sep).join('/')}:${String(line)}  <${tag} onClick>`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('只有符号内容的按钮带 aria-label', () => {
    // 「×」「▸」这类按钮在视觉上意思很清楚，读出来是「叉」或什么都不读
    const symbolOnly =
      /^[\s{}'"`()?:.\u2000-\u3000\u2190-\u21ff\u25a0-\u25ff\u2600-\u27bf\u00d7\u2716\u2713\u2717\u2026+\-*/<>=|]*$/u;
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/gu)) {
        if (/aria-label[=\s]/u.test(m[1] ?? '')) continue;
        const visible = (m[2] ?? '')
          .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
          .replace(/<[^>]*>/gu, '')
          .trim();
        if (symbolOnly.test(visible)) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(
            `${file.split(sep).join('/')}:${String(line)}  ${JSON.stringify(visible)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('role 取值都是 ARIA 里真实存在的', () => {
    /*
     * 拼错的 role 不会报错，它只是不生效——`role="alertbox"` 与没写 role 完全等价，
     * 而写了它的人以为自己已经把这条消息标成了紧急。
     */
    const VALID = new Set([
      'alert',
      'alertdialog',
      'button',
      'checkbox',
      'dialog',
      'group',
      'list',
      'listitem',
      'log',
      'menu',
      'menuitem',
      'note',
      'presentation',
      'none',
      'progressbar',
      'radio',
      'radiogroup',
      'region',
      'row',
      'rowgroup',
      'cell',
      'columnheader',
      'rowheader',
      'search',
      'separator',
      'status',
      'switch',
      'tab',
      'table',
      'tablist',
      'tabpanel',
      'textbox',
      'toolbar',
      'tooltip',
      'tree',
      'treeitem',
      'grid',
      'gridcell',
      'img',
      'link',
      'marquee',
      'timer',
    ]);
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\brole=["']([^"']+)["']/gu)) {
        if (!VALID.has(m[1] ?? '')) {
          offenders.push(`${file.split(sep).join('/')}  role="${m[1] ?? ''}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('有全局焦点环兜底', () => {
    /*
     * 各组件此前各写一条 `:focus-visible`，覆盖不到的控件靠浏览器默认样式。那能用，
     * 但它有一个安静的失效方式：任何一处 `outline: none` 都会让那个控件的焦点位置
     * 彻底看不见，而这种回退在视觉上完全无感。
     */
    const global = RULES.find((r) => r.selector === ':focus-visible');
    expect(global, 'styles.css 需要一条兜底的 :focus-visible').toBeDefined();
    expect(global?.body).toMatch(/outline:\s*\d+px\s+solid/u);
  });

  it('outline 只在允许清单里被关掉', () => {
    /*
     * `outline: none` 是可访问性最常见的单点破坏：为了改按钮外观顺手关掉焦点环，
     * 之后键盘用户完全不知道焦点在哪。允许清单里的两项都不是控件。
     */
    const ALLOWED = new Set([
      // 主内容是跳转目标而不是控件，画出来会像一个巨大的输入框
      '.app__main:focus',
    ]);
    const offenders: string[] = [];
    for (const { selector, body } of RULES) {
      if (!/outline:\s*(?:none|0)\b/u.test(body)) continue;
      if (ALLOWED.has(selector)) continue;
      offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });

  it('主导航是按钮而不是纯文本列表项', () => {
    const app = readFileSync(join(UI, 'App.tsx'), 'utf8');
    // 骨架期这里是不可聚焦的 <li>，verify:ui 报告可聚焦元素 0 个
    expect(app).toMatch(/<nav[^>]*aria-label="主导航"/u);
    expect(app).toMatch(/className=\{`nav__item/u);
    expect(app).toMatch(/aria-current=\{view === v\.id \? 'page' : undefined\}/u);
  });

  it('有跳到主内容的入口，且主内容可成为焦点目标', () => {
    const app = readFileSync(join(UI, 'App.tsx'), 'utf8');
    /*
     * 会话列表会长到几十项，而它在 Tab 顺序上排在主内容之前。没有这个入口时用键盘的人
     * 每次回到正文都要按几十次 Tab——那不是不方便，是让键盘操作在实际使用中不成立。
     */
    expect(app).toContain('skip-to-main');
    expect(app).toMatch(/<main[^>]*tabIndex=\{-1\}/u);
    // 平时不可见但必须可聚焦：display:none 会让它连焦点都拿不到
    const rule = RULES.find((r) => r.selector === '.skip-to-main');
    expect(rule).toBeDefined();
    expect(rule?.body).not.toMatch(/display:\s*none/u);
    expect(RULES.some((r) => r.selector === '.skip-to-main:focus-visible')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 20.5.3 对比度
 * ------------------------------------------------------------------ */

describe('对比度（20.5.3）', () => {
  it('正文与次要文字对两种背景都达到 4.5:1', () => {
    for (const fg of ['--fg', '--fg-dim']) {
      for (const bg of ['--bg', '--bg-raised']) {
        const ratio = contrast(token(fg), token(bg));
        expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('强调色达到 4.5:1（它同时用于正文链接与状态文字）', () => {
    for (const bg of ['--bg', '--bg-raised']) {
      const ratio = contrast(token('--accent'), token(bg));
      expect(ratio, `--accent on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('控件边框达到 3:1，且与装饰性分隔线是两个令牌', () => {
    /*
     * WCAG 1.4.11 要求「识别界面控件所必需的视觉信息」达到 3:1，而按钮与输入框的边界
     * 正是这类信息——它们没有其它可辨识的视觉线索。装饰性分隔线不在这条要求里。
     *
     * 两者必须是两个令牌：合成一个的话，要么分隔线跟着变亮（界面全是格子），要么控件
     * 边框跟着变暗（低视力用户看不出哪里能输入）。
     */
    for (const bg of ['--bg', '--bg-raised']) {
      const ratio = contrast(token('--border-control'), token(bg));
      expect(ratio, `--border-control on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
    expect(token('--border')).not.toBe(token('--border-control'));
  });

  it('控件确实用的是控件边框令牌', () => {
    // 靠在控件上重定义变量实现，这样已有和将来的 var(--border) 自动落到正确的一侧
    const rule = RULES.find(
      (r) => /\bbutton\b/u.test(r.selector) && /--border:\s*var\(--border-control\)/u.test(r.body),
    );
    expect(rule, '需要一条把 --border 重定义为 --border-control 的规则').toBeDefined();
    for (const tag of ['input', 'select', 'textarea']) {
      expect(rule?.selector).toContain(tag);
    }
  });

  it('同一条规则里声明的前景/背景配对全部达标', () => {
    /*
     * 这类配对是状态色的主要形态（`.badge--error { color: …; background: … }`），也是
     * 最容易出问题的地方：调色时只改一侧。同规则内两侧都在眼前，因此可以静态判定。
     *
     * 判不了的是靠层叠继承背景的那些，留给 verify-ui 在真实 DOM 上按 getComputedStyle 查。
     */
    const offenders: string[] = [];
    for (const { selector, body } of RULES) {
      const fgDecl = /(?:^|;|\s)color:\s*([^;]+)/u.exec(body);
      const bgDecl = /(?:^|;|\s)background(?:-color)?:\s*([^;]+)/u.exec(body);
      if (fgDecl === null || bgDecl === null) continue;
      const fg = resolveColor(fgDecl[1] ?? '');
      const bg = resolveColor(bgDecl[1] ?? '');
      if (fg === null || bg === null) continue;

      const ratio = contrast(fg, bg);
      if (Number.isNaN(ratio)) continue;

      // 大字放宽到 3:1（WCAG：>=24px，或 >=18.66px 且加粗）
      const size = Number(/font-size:\s*(\d+)px/u.exec(body)?.[1] ?? '14');
      const bold = /font-weight:\s*(?:600|700|bold)/u.test(body);
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;

      if (ratio < need) {
        offenders.push(`${selector}  ${fg} on ${bg} = ${ratio.toFixed(2)}（需要 ${String(need)}）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('只声明了文字色的规则对两种背景都达标', () => {
    /*
     * 这一类是漏得最多的：颜色写在一条规则里，背景来自某个祖先。同规则配对的检查看不到
     * 它，而它恰好是「调色时只改一侧」最容易落到的地方——`verify:ui` 的逐视图实测抓到过
     * 一处 2.13:1 的滑块标签，就是这个形状。
     *
     * 静态判定不知道实际背景是哪个，因此要求对 `--bg` 与 `--bg-raised` **都**达标。这比
     * 真实要求严，但严的方向是安全的：平台只有这两种表面色，一段文字落在哪一种上取决于
     * 它被放进哪个容器，而那是随时可能变的。
     */
    const surfaces = [token('--bg'), token('--bg-raised')];
    const offenders: string[] = [];

    for (const { selector, body } of RULES) {
      // 同规则里带背景的已在上一条查过
      if (/background(?:-color)?:/u.test(body)) continue;
      const decl = /(?:^|;|\s)color:\s*([^;]+)/u.exec(body);
      if (decl === null) continue;
      const fg = resolveColor(decl[1] ?? '');
      if (fg === null) continue;

      const size = Number(/font-size:\s*(\d+)px/u.exec(body)?.[1] ?? '14');
      const bold = /font-weight:\s*(?:600|700|bold)/u.test(body);
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;

      for (const bg of surfaces) {
        const ratio = contrast(fg, bg);
        if (Number.isNaN(ratio) || ratio >= need) continue;
        offenders.push(`${selector}  ${fg} on ${bg} = ${ratio.toFixed(2)}（需要 ${String(need)}）`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('状态不只靠颜色表达', () => {
    /*
     * 需求 2.5/2.6 的隔离徽章早就守着这条，这里把它推广到其它状态显示：色盲用户、
     * 高对比度模式、以及打印出来的截图都读不出颜色。
     */
    const app = readFileSync(join(UI, 'App.tsx'), 'utf8');
    // 连接状态徽章带文字标签
    expect(app).toContain('STATE_LABEL[backend.state]');
    const badge = readFileSync(join(UI, 'components', 'IsolationBadge.tsx'), 'utf8');
    expect(badge).toContain('STRENGTH_LABEL[info.strength]');
  });

  it('支持 Windows 高对比度模式', () => {
    /*
     * forced-colors 下系统接管全部颜色，自定义的 background/border 被丢弃。平台的按钮
     * 与输入框只靠边框区分，不显式改用系统颜色关键字的话，它们在高对比度主题下会变成
     * 一片没有边界的文本。
     */
    expect(CSS).toMatch(/@media \(forced-colors: active\)/u);
    const block = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/u.exec(CSS)?.[1] ?? '';
    expect(block).toContain('ButtonBorder');
    expect(block).toContain('Highlight');
  });

  it('尊重 prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
  });
});
