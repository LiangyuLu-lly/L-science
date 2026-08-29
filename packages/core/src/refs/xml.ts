/**
 * 最小 XML 解析器（任务 13.2，需求 12.3、12.4）。
 *
 * 为什么从零写而不是加依赖：与 `skills/archive.ts` 同一个理由的另一面。这里要解析的
 * 是 PMC 的 JATS 全文与 NCBI 几个接口的响应，形状固定且已知；而 XML 解析器是常见的
 * 拒绝服务面（十亿笑、外部实体注入、深度递归爆栈），第三方库对这些的防护取决于它
 * 当年的实现选择，而我们没有办法在不读它源码的情况下知道它挡不挡。
 *
 * 因此这里的取舍是明确的：
 *
 * - **不处理 DTD、不解析实体声明、不加载外部实体**。碰到 `<!DOCTYPE` 直接整段跳过。
 *   这一条同时挡掉「十亿笑」与 XXE：既然从不展开自定义实体，就没有可放大的东西。
 * - **只认五个预定义实体加数字字符引用**。JATS 里出现的其它实体（`&alpha;`）保持
 *   字面形式而不是丢掉——丢掉会让公式里少一个符号，而保留 `&alpha;` 至少还能看出
 *   原文写了什么。
 * - **深度与节点数有上限**，超限抛错。递归下降在深层嵌套上会爆栈，而爆栈是进程级
 *   故障，不是一次解析失败。
 * - **不做命名空间解析**。`xlink:href` 原样作为属性名。JATS 的命名空间前缀是固定的，
 *   解析它只会多一层间接。
 *
 * 不实现的东西：处理指令（跳过）、CDATA 之外的转义规则、属性默认值、schema 校验。
 */

export interface XmlElement {
  kind: 'element';
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly XmlNode[];
}

export interface XmlText {
  kind: 'text';
  text: string;
}

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export const XML_LIMITS = {
  /** 输入字符数上限。 */
  maxChars: 24 * 1024 * 1024,
  /** 元素嵌套深度上限。 */
  maxDepth: 200,
  /** 元素总数上限。 */
  maxElements: 400_000,
} as const;

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * 解码实体引用。
 *
 * 未知实体**原样保留**。这不是偷懒：JATS 正文里的 `&alpha;`、`&mu;` 之类来自 DTD，
 * 而我们刻意不解析 DTD。把它替换成空会让「α 波」变成「 波」，而保留字面形式让
 * 读者仍然知道那里有个希腊字母。
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 代理区与超出 Unicode 范围的码点会让 fromCodePoint 抛异常
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return PREDEFINED[body] ?? whole;
  });
}

interface Cursor {
  readonly src: string;
  pos: number;
  elements: number;
}

/** 跳过 `<!-- -->`、`<![CDATA[ ]]>` 之外的 `<! ... >` 声明，含带内部子集的 DOCTYPE。 */
function skipDeclaration(cur: Cursor): string | null {
  // 到这里 cur.pos 指向 `<!`
  const src = cur.src;
  if (src.startsWith('<!--', cur.pos)) {
    const end = src.indexOf('-->', cur.pos + 4);
    cur.pos = end === -1 ? src.length : end + 3;
    return null;
  }
  if (src.startsWith('<![CDATA[', cur.pos)) {
    const end = src.indexOf(']]>', cur.pos + 9);
    const text = src.slice(cur.pos + 9, end === -1 ? src.length : end);
    cur.pos = end === -1 ? src.length : end + 3;
    // CDATA 内容不做实体解码：那是它存在的意义
    return text;
  }

  /*
   * DOCTYPE 与其它声明。
   *
   * 内部子集（`[ ... ]`）里可以有 `>`，因此不能简单找第一个 `>`。这里手工扫过
   * 方括号块。整段内容一律丢弃——实体声明不解析，外部实体不加载。
   */
  let depth = 0;
  let i = cur.pos + 2;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    else if (ch === '>' && depth <= 0) {
      cur.pos = i + 1;
      return null;
    }
    i += 1;
  }
  cur.pos = src.length;
  return null;
}

/** 解析开标签里的属性。 */
function parseAttrs(src: string, from: number, to: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gu;
  re.lastIndex = 0;
  const chunk = src.slice(from, to);
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const name = m[1];
    if (name === undefined || name === '') continue;
    const raw = m[2];
    if (raw === undefined) {
      // 无值属性（HTML 风格）。XML 里不合法但真实数据里出现过，按空串收下
      attrs[name] = '';
      continue;
    }
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    attrs[name] = decodeXmlEntities(unquoted);
  }
  return attrs;
}

/**
 * 解析 XML，返回根元素。
 *
 * 用显式栈而不是递归：递归在深层嵌套上会爆栈，而爆栈会带走整个进程。有了显式栈，
 * 超过深度上限只是一次抛错。
 *
 * 容错取向是「尽力返回可用的树」而不是严格校验：真实世界的 JATS 里有未闭合的
 * `<br>`、有多余的闭标签。严格报错会让一篇本可以读的论文变成读不了。但根元素缺失
 * 这类结构性问题仍然抛错——那意味着拿到的根本不是 XML。
 */
export function parseXml(source: string): XmlElement {
  if (source.length > XML_LIMITS.maxChars) {
    throw new XmlError(
      `XML 有 ${String(Math.round(source.length / 1024 / 1024))}MB，超过 ` +
        `${String(XML_LIMITS.maxChars / 1024 / 1024)}MB 上限`,
    );
  }

  const cur: Cursor = { src: source, pos: 0, elements: 0 };
  const root: XmlElement = { kind: 'element', name: '#document', attrs: {}, children: [] };
  const stack: { node: XmlElement; children: XmlNode[] }[] = [{ node: root, children: [] }];

  const pushText = (text: string): void => {
    if (text === '') return;
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    top.children.push({ kind: 'text', text });
  };

  while (cur.pos < source.length) {
    const lt = source.indexOf('<', cur.pos);
    if (lt === -1) {
      pushText(decodeXmlEntities(source.slice(cur.pos)));
      break;
    }
    if (lt > cur.pos) pushText(decodeXmlEntities(source.slice(cur.pos, lt)));
    cur.pos = lt;

    const next = source[cur.pos + 1];

    if (next === '!') {
      const cdata = skipDeclaration(cur);
      if (cdata !== null) pushText(cdata);
      continue;
    }

    if (next === '?') {
      const end = source.indexOf('?>', cur.pos + 2);
      cur.pos = end === -1 ? source.length : end + 2;
      continue;
    }

    if (next === '/') {
      const end = source.indexOf('>', cur.pos);
      const name = source.slice(cur.pos + 2, end === -1 ? source.length : end).trim();
      cur.pos = end === -1 ? source.length : end + 1;

      /*
       * 找到栈里最近的同名元素并弹到它。
       *
       * 不要求严格配对：`<b><i></b>` 这种交错在真实数据里出现过，严格报错会让整份
       * 文档读不出来。找不到同名元素时忽略这个闭标签——它是多余的。
       */
      let target = -1;
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i]?.node.name === name) {
          target = i;
          break;
        }
      }
      if (target === -1) continue;
      while (stack.length > target) {
        const frame = stack.pop();
        if (frame === undefined) break;
        (frame.node as { children: readonly XmlNode[] }).children = frame.children;
      }
      continue;
    }

    // 开标签
    const end = findTagEnd(source, cur.pos);
    if (end === -1) {
      // 没有闭合的 `>`：把剩下的当文本，避免丢内容
      pushText(decodeXmlEntities(source.slice(cur.pos)));
      break;
    }

    const selfClosing = source[end - 1] === '/';
    const inner = source.slice(cur.pos + 1, selfClosing ? end - 1 : end);
    const nameMatch = /^[^\s/>]+/u.exec(inner);
    const name = nameMatch?.[0] ?? '';
    cur.pos = end + 1;
    if (name === '') continue;

    cur.elements += 1;
    if (cur.elements > XML_LIMITS.maxElements) {
      throw new XmlError(`XML 元素数超过上限 ${String(XML_LIMITS.maxElements)}`);
    }

    const element: XmlElement = {
      kind: 'element',
      name,
      attrs: parseAttrs(inner, name.length, inner.length),
      children: [],
    };

    const top = stack[stack.length - 1];
    if (top === undefined) break;
    top.children.push(element);

    if (selfClosing) continue;
    if (stack.length >= XML_LIMITS.maxDepth) {
      throw new XmlError(`XML 嵌套深度超过上限 ${String(XML_LIMITS.maxDepth)}`);
    }
    stack.push({ node: element, children: [] });
  }

  // 收尾：未闭合的元素也要把 children 落上去
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    (frame.node as { children: readonly XmlNode[] }).children = frame.children;
  }

  const firstElement = root.children.find((c): c is XmlElement => c.kind === 'element');
  if (firstElement === undefined) {
    throw new XmlError('没有找到根元素，这份内容可能不是 XML');
  }
  return firstElement;
}

/**
 * 属性名不能含 `>`，但属性**值**可以。
 *
 * 因此不能直接找第一个 `>`：`<graphic xlink:href="a>b"/>` 会被截断。这里跳过引号块。
 */
function findTagEnd(src: string, from: number): number {
  let i = from + 1;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
    i += 1;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 查询助手
 * ------------------------------------------------------------------ */

export function isElement(node: XmlNode): node is XmlElement {
  return node.kind === 'element';
}

/** 直接子元素，可按名筛。 */
export function childElements(node: XmlElement, name?: string): readonly XmlElement[] {
  return node.children.filter(
    (c): c is XmlElement => isElement(c) && (name === undefined || c.name === name),
  );
}

/** 第一个匹配的直接子元素。 */
export function child(node: XmlElement, name: string): XmlElement | null {
  return childElements(node, name)[0] ?? null;
}

/**
 * 按路径取子元素，例如 `front/article-meta/title-group`。
 *
 * 只走直接子元素，不做后代搜索：JATS 里同名元素在不同层级含义不同
 * （`title` 出现在 `title-group`、`sec`、`fig` 里），后代搜索会拿错。
 */
export function at(node: XmlElement, path: string): XmlElement | null {
  let cursor: XmlElement | null = node;
  for (const segment of path.split('/')) {
    if (cursor === null) return null;
    cursor = child(cursor, segment);
  }
  return cursor;
}

/** 深度优先找出全部同名后代。 */
export function findAll(node: XmlElement, name: string, limit = 100_000): readonly XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [node];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop();
    if (current === undefined) continue;
    // 逆序压栈保证输出是文档顺序
    const kids = current.children.filter(isElement);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as XmlElement);
    if (current !== node && current.name === name) out.push(current);
  }
  return out;
}

/** 第一个同名后代。 */
export function find(node: XmlElement, name: string): XmlElement | null {
  return findAll(node, name, 1)[0] ?? null;
}

/** 元素内的全部文本，标签被剥掉，空白折叠。 */
export function textOf(node: XmlNode | null): string {
  if (node === null) return '';
  if (node.kind === 'text') return node.text;
  let out = '';
  for (const kid of node.children) out += textOf(kid);
  return out;
}

/** 折叠空白之后的文本。 */
export function trimmedText(node: XmlNode | null): string {
  return textOf(node).replace(/\s+/gu, ' ').trim();
}

/** 属性值。命名空间前缀原样匹配；找不到时也试不带前缀的形式。 */
export function attr(node: XmlElement | null, name: string): string | null {
  if (node === null) return null;
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  // `xlink:href` 与 `href` 在不同版本的 JATS 里都出现过
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  for (const [key, value] of Object.entries(node.attrs)) {
    const keyBare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (keyBare === bare) return value;
  }
  return null;
}
