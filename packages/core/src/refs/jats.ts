/**
 * JATS 全文 → Markdown（任务 13.2，需求 12.3、12.4）。
 *
 * 为什么要转：抓到的全文如果只存原始 XML，模型要读它就得先起一个 Python 内核解析
 * 一遍。而 PMC 的开放获取全文是这条流水线上唯一能拿到**结构化正文**的来源——JATS
 * 里章节、图题、表格、参考文献都是带标签的。把这份结构折成 Markdown 之后，
 * `read_file` 直接就能用，写综述时引用某一段的成本从「起内核 + 写解析代码」降到零。
 *
 * 原始 XML 仍然一起存下来（见 `fulltext.ts`），因为转换是有损的：数学公式、
 * 复杂表格的跨行跨列、作者贡献声明的结构都折平了。需要精确内容时回去读 XML。
 *
 * 一条刻意的取舍：**图片在 Markdown 里写成指向制品的相对路径**，而不是原始的
 * `xlink:href="figure1"`。后者对读者毫无意义（那是 PMC 包内的文件名），而写成
 * 制品文件名之后，用户在制品视图里能对上，模型也能用 `read_file` 看图。
 */

import type { XmlElement, XmlNode } from './xml.js';
import { at, attr, childElements, find, findAll, isElement, textOf, trimmedText } from './xml.js';

/** 一张随文图。 */
export interface JatsFigure {
  /** JATS 里的 id（`F1`）。正文引用用它。 */
  id: string | null;
  /** 图号标签（`Figure 1`）。 */
  label: string | null;
  caption: string;
  /** 包内的图片文件名（`xlink:href`）。不含扩展名时需要在包里模糊匹配。 */
  href: string | null;
}

/** 一张表。JATS 的表格是嵌套的 XHTML 片段，这里折成 Markdown。 */
export interface JatsTable {
  id: string | null;
  label: string | null;
  caption: string;
  markdown: string;
}

export interface JatsReference {
  /** JATS id（`B12`），正文的 `<xref rid="B12">` 指向它。 */
  id: string | null;
  /** 参考文献原文（尽力拼出的一行）。 */
  text: string;
  doi: string | null;
  pmid: string | null;
}

export interface JatsArticle {
  title: string | null;
  /** 作者显示名，按文中顺序。 */
  authors: readonly string[];
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  abstract: string | null;
  /** 正文的 Markdown。不含标题与摘要（它们单列）。 */
  bodyMarkdown: string;
  figures: readonly JatsFigure[];
  tables: readonly JatsTable[];
  references: readonly JatsReference[];
  /** 许可声明原文。抓下来的全文能不能再分发取决于它。 */
  license: string | null;
  /** 补充材料的包内文件名。 */
  supplementary: readonly { label: string | null; href: string }[];
}

/* ------------------------------------------------------------------ *
 * 行内渲染
 * ------------------------------------------------------------------ */

/** 行内标签 → Markdown 包裹符。 */
const INLINE_WRAP: Readonly<Record<string, string>> = {
  italic: '*',
  bold: '**',
  monospace: '`',
  underline: '',
  sc: '',
};

/**
 * 渲染行内内容。
 *
 * `xref` 保留成 `[Figure 1]` / `[12]` 这样的可读引用而不是丢掉：正文里
 * 「as shown in Fig. 2」的指向是理解论文的一部分，丢了之后读者不知道在说哪张图。
 *
 * 公式（`inline-formula`）用 `$...$` 包住其中的文本。JATS 里的公式可能是 MathML 或
 * TeX，前者折平之后是一串符号名，后者可用。两种都比丢掉好，但要标注出来是公式，
 * 否则一串 `x 2 y` 会被当成正文。
 */
function renderInline(node: XmlNode): string {
  if (node.kind === 'text') return node.text;

  const name = node.name;
  const inner = node.children.map(renderInline).join('');

  if (name === 'xref') {
    const label = inner.trim();
    return label === '' ? '' : `[${label}]`;
  }
  if (name === 'inline-formula' || name === 'disp-formula') {
    const tex = find(node, 'tex-math');
    const body = tex === null ? inner.replace(/\s+/gu, ' ').trim() : textOf(tex).trim();
    return body === '' ? '' : `$${body}$`;
  }
  if (name === 'sup') return inner === '' ? '' : `^${inner}^`;
  if (name === 'sub') return inner === '' ? '' : `~${inner}~`;
  if (name === 'ext-link' || name === 'uri') {
    const href = attr(node, 'xlink:href');
    if (href === null || href === '') return inner;
    return inner.trim() === '' ? href : `[${inner.trim()}](${href})`;
  }
  if (name === 'break') return '\n';
  // 图与表在正文里出现时不在这里展开：它们由 renderBlock 单独成块
  if (name === 'fig' || name === 'table-wrap' || name === 'supplementary-material') return '';

  const wrap = INLINE_WRAP[name];
  if (wrap !== undefined) {
    const trimmed = inner.trim();
    if (wrap === '' || trimmed === '') return inner;
    return `${wrap}${trimmed}${wrap}`;
  }
  return inner;
}

/** 折叠空白但保留换行。 */
function tidy(text: string): string {
  return text
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 表格
 * ------------------------------------------------------------------ */

/**
 * JATS 表格 → Markdown 表格。
 *
 * 跨行跨列（`rowspan`/`colspan`）在 Markdown 里表达不了。这里的处理是把跨列的单元格
 * 内容放在第一格、其余补空，并在表格下方加一行说明。丢掉说明的后果是读者以为表格是
 * 完整的——而论文表格里的合并表头承载着分组信息，误读会直接导致引错数字。
 */
function renderTable(wrap: XmlElement): string {
  const table = find(wrap, 'table');
  if (table === null) {
    // 有些期刊直接给图片版表格，没有结构化 table
    const graphic = find(wrap, 'graphic');
    if (graphic !== null) {
      return `（此表在原文中是图片：${attr(graphic, 'xlink:href') ?? '未知文件'}）`;
    }
    return '';
  }

  const rows: { cells: string[]; header: boolean }[] = [];
  let hasSpan = false;

  const collectRows = (parent: XmlElement, header: boolean): void => {
    for (const tr of childElements(parent, 'tr')) {
      const cells: string[] = [];
      for (const cell of childElements(tr)) {
        if (cell.name !== 'td' && cell.name !== 'th') continue;
        const colspan = Number.parseInt(attr(cell, 'colspan') ?? '1', 10);
        const rowspan = Number.parseInt(attr(cell, 'rowspan') ?? '1', 10);
        if (colspan > 1 || rowspan > 1) hasSpan = true;
        // 单元格里的换行会破坏 Markdown 表格，折成空格
        cells.push(
          cell.children
            .map(renderInline)
            .join('')
            .replace(/\s+/gu, ' ')
            .replace(/\|/gu, '\\|')
            .trim(),
        );
        for (let i = 1; i < colspan && i < 20; i += 1) cells.push('');
      }
      if (cells.length > 0) rows.push({ cells, header });
    }
  };

  for (const thead of childElements(table, 'thead')) collectRows(thead, true);
  for (const tbody of childElements(table, 'tbody')) collectRows(tbody, false);
  // 没有 thead/tbody 时 tr 直接挂在 table 上
  collectRows(table, false);

  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (cells: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const lines: string[] = [];
  const headerRows = rows.filter((r) => r.header);
  const bodyRows = rows.filter((r) => !r.header);

  if (headerRows.length > 0) {
    // 多行表头合成一行（用 / 连接），Markdown 只支持一行
    const merged = Array.from({ length: width }, (_, i) =>
      headerRows
        .map((r) => r.cells[i] ?? '')
        .filter((v) => v !== '')
        .join(' / '),
    );
    lines.push(pad(merged));
  } else {
    lines.push(pad(bodyRows[0]?.cells ?? []));
  }
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of headerRows.length > 0 ? bodyRows : bodyRows.slice(1)) {
    lines.push(pad(row.cells));
  }

  if (hasSpan) {
    lines.push('');
    lines.push(
      '> 原表含合并单元格，Markdown 无法表达。合并格的内容放在首格、其余留空。' +
        '需要精确的表头分组时请读原始 XML。',
    );
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 块级渲染
 * ------------------------------------------------------------------ */

interface RenderContext {
  figures: JatsFigure[];
  tables: JatsTable[];
  supplementary: { label: string | null; href: string }[];
  /** 包内文件名 → 制品文件名。图片落盘后回填，用于把 Markdown 里的路径改对。 */
  imageNames: ReadonlyMap<string, string>;
}

function figureOf(node: XmlElement): JatsFigure {
  const graphic = find(node, 'graphic');
  const caption = at(node, 'caption');
  return {
    id: attr(node, 'id'),
    label: trimmedText(at(node, 'label')) || null,
    caption: caption === null ? '' : tidy(caption.children.map(renderInline).join('')),
    href: graphic === null ? null : attr(graphic, 'xlink:href'),
  };
}

/** 渲染一个块级元素。返回若干 Markdown 段。 */
function renderBlock(node: XmlElement, depth: number, ctx: RenderContext): string[] {
  switch (node.name) {
    case 'sec': {
      const out: string[] = [];
      const title = child(node, 'title');
      if (title !== null) {
        const level = Math.min(depth + 2, 6);
        const text = tidy(title.children.map(renderInline).join(''));
        if (text !== '') out.push(`${'#'.repeat(level)} ${text}`);
      }
      for (const kid of childElements(node)) {
        if (kid.name === 'title') continue;
        out.push(...renderBlock(kid, depth + 1, ctx));
      }
      return out;
    }

    case 'p': {
      const text = tidy(node.children.map(renderInline).join(''));
      const nested: string[] = [];
      // 图、表、补充材料常常嵌在段落里。它们要单独成块，因此递归处理
      for (const kid of findAll(node, 'fig')) nested.push(...renderBlock(kid, depth, ctx));
      for (const kid of findAll(node, 'table-wrap')) nested.push(...renderBlock(kid, depth, ctx));
      for (const kid of findAll(node, 'supplementary-material')) {
        nested.push(...renderBlock(kid, depth, ctx));
      }
      return text === '' ? nested : [text, ...nested];
    }

    case 'fig': {
      const figure = figureOf(node);
      ctx.figures.push(figure);
      const label = figure.label ?? `图 ${String(ctx.figures.length)}`;
      const file = figure.href === null ? null : (ctx.imageNames.get(figure.href) ?? null);
      const lines = [`**${label}**${figure.caption === '' ? '' : `　${figure.caption}`}`];
      if (file !== null) lines.push(`![${label}](${file})`);
      else if (figure.href !== null) {
        // 图片没抓到时如实说明，而不是留一个断链
        lines.push(`（图片文件 ${figure.href} 未随全文一起取到）`);
      }
      return [lines.join('\n')];
    }

    case 'table-wrap': {
      const markdown = renderTable(node);
      const caption = at(node, 'caption');
      const entry: JatsTable = {
        id: attr(node, 'id'),
        label: trimmedText(child(node, 'label')) || null,
        caption: caption === null ? '' : tidy(caption.children.map(renderInline).join('')),
        markdown,
      };
      ctx.tables.push(entry);
      const label = entry.label ?? `表 ${String(ctx.tables.length)}`;
      return [
        [`**${label}**${entry.caption === '' ? '' : `　${entry.caption}`}`, '', markdown]
          .filter((s) => s !== '')
          .join('\n'),
      ];
    }

    case 'supplementary-material': {
      const href = attr(node, 'xlink:href');
      const label = trimmedText(child(node, 'label')) || null;
      if (href !== null && href !== '') ctx.supplementary.push({ label, href });
      const caption = at(node, 'caption');
      const text = caption === null ? '' : tidy(caption.children.map(renderInline).join(''));
      return [
        `**${label ?? '补充材料'}**${text === '' ? '' : `　${text}`}${href === null ? '' : `（${href}）`}`,
      ];
    }

    case 'list': {
      const ordered = attr(node, 'list-type') === 'order';
      const items = childElements(node, 'list-item').map((item, index) => {
        const body = childElements(item)
          .flatMap((kid) => renderBlock(kid, depth, ctx))
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim();
        return `${ordered ? `${String(index + 1)}.` : '-'} ${body}`;
      });
      return items.length === 0 ? [] : [items.join('\n')];
    }

    case 'disp-quote': {
      const body = childElements(node)
        .flatMap((kid) => renderBlock(kid, depth, ctx))
        .join('\n');
      return body === ''
        ? []
        : [
            body
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n'),
          ];
    }

    case 'disp-formula': {
      const tex = find(node, 'tex-math');
      const body = tex === null ? trimmedText(node) : textOf(tex).trim();
      return body === '' ? [] : [`$$\n${body}\n$$`];
    }

    case 'code':
    case 'preformat':
      return [`\`\`\`\n${textOf(node).trim()}\n\`\`\``];

    case 'boxed-text':
    case 'statement':
      return childElements(node).flatMap((kid) => renderBlock(kid, depth, ctx));

    // 这些在正文里出现但不该进 Markdown 正文
    case 'label':
    case 'graphic':
    case 'media':
      return [];

    default: {
      const kids = childElements(node);
      if (kids.length > 0) return kids.flatMap((kid) => renderBlock(kid, depth, ctx));
      const text = tidy(textOf(node));
      return text === '' ? [] : [text];
    }
  }
}

/** `child` 的本地别名，避免与 xml.js 的导入名冲突时读起来别扭。 */
function child(node: XmlElement, name: string): XmlElement | null {
  return childElements(node, name)[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * 元数据
 * ------------------------------------------------------------------ */

function articleIds(meta: XmlElement | null): {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
} {
  const out = {
    doi: null as string | null,
    pmid: null as string | null,
    pmcid: null as string | null,
  };
  if (meta === null) return out;
  for (const id of childElements(meta, 'article-id')) {
    const kind = attr(id, 'pub-id-type');
    const value = trimmedText(id);
    if (value === '') continue;
    if (kind === 'doi') out.doi = value;
    else if (kind === 'pmid') out.pmid = value;
    else if (kind === 'pmc' || kind === 'pmcid')
      out.pmcid = value.startsWith('PMC') ? value : `PMC${value}`;
  }
  return out;
}

function authorsOf(meta: XmlElement | null): readonly string[] {
  if (meta === null) return [];
  const out: string[] = [];
  for (const group of findAll(meta, 'contrib')) {
    if (attr(group, 'contrib-type') !== null && attr(group, 'contrib-type') !== 'author') continue;
    const name = child(group, 'name') ?? child(group, 'string-name');
    if (name !== null) {
      const surname = trimmedText(child(name, 'surname'));
      const given = trimmedText(child(name, 'given-names'));
      const label = [surname, given].filter((s) => s !== '').join(', ');
      if (label !== '') out.push(label);
      continue;
    }
    const collab = child(group, 'collab');
    if (collab !== null) {
      const label = trimmedText(collab);
      if (label !== '') out.push(label);
    }
  }
  return out;
}

function yearOf(meta: XmlElement | null): number | null {
  if (meta === null) return null;
  for (const pubDate of findAll(meta, 'pub-date')) {
    const year = Number.parseInt(trimmedText(child(pubDate, 'year')), 10);
    if (Number.isInteger(year) && year > 1000 && year < 3000) return year;
  }
  return null;
}

function referencesOf(root: XmlElement): readonly JatsReference[] {
  const out: JatsReference[] = [];
  for (const ref of findAll(root, 'ref')) {
    const citation =
      find(ref, 'element-citation') ?? find(ref, 'mixed-citation') ?? find(ref, 'citation') ?? ref;

    let doi: string | null = null;
    let pmid: string | null = null;
    for (const id of findAll(citation, 'pub-id')) {
      const kind = attr(id, 'pub-id-type');
      const value = trimmedText(id);
      if (kind === 'doi') doi = value;
      else if (kind === 'pmid') pmid = value;
    }

    out.push({
      id: attr(ref, 'id'),
      text: trimmedText(citation),
      doi,
      pmid,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export interface ParseJatsOptions {
  /** 包内图片文件名 → 落盘后的制品文件名。用于把 Markdown 里的图片路径改对。 */
  imageNames?: ReadonlyMap<string, string>;
}

/**
 * 解析一份 JATS 全文。
 *
 * 输入是已解析的 XML 根元素（`article`）。传节点而不是字符串，是为了让调用方能
 * 复用同一次解析——`fulltext.ts` 要先扫一遍图片清单、落盘、再带着文件名映射
 * 渲染 Markdown，解析两次纯属浪费。
 */
export function parseJats(root: XmlElement, options: ParseJatsOptions = {}): JatsArticle {
  const front = child(root, 'front');
  const meta = front === null ? null : child(front, 'article-meta');
  const journalMeta = front === null ? null : child(front, 'journal-meta');

  const ids = articleIds(meta);
  const titleGroup = meta === null ? null : child(meta, 'title-group');
  const title =
    titleGroup === null
      ? null
      : tidy((child(titleGroup, 'article-title')?.children ?? []).map(renderInline).join('')) ||
        null;

  const abstractNode = meta === null ? null : child(meta, 'abstract');
  const ctx: RenderContext = {
    figures: [],
    tables: [],
    supplementary: [],
    imageNames: options.imageNames ?? new Map(),
  };

  const abstract =
    abstractNode === null
      ? null
      : tidy(
          childElements(abstractNode)
            .flatMap((kid) => renderBlock(kid, 0, ctx))
            .join('\n\n'),
        ) || null;

  // 摘要里的图表不该算进正文清单（摘要几乎不含图，但结构化摘要里有小节标题）
  ctx.figures.length = 0;
  ctx.tables.length = 0;

  const body = child(root, 'body');
  const bodyBlocks =
    body === null ? [] : childElements(body).flatMap((kid) => renderBlock(kid, 0, ctx));

  /*
   * 附录与 back matter 里的图表也要算进来。
   *
   * 方法学细节经常整段放在附录里，而那正是复现一篇论文最需要读的部分。只渲染
   * `<body>` 会让附录凭空消失，而读者看不出少了东西。
   */
  const back = child(root, 'back');
  const appendixBlocks: string[] = [];
  if (back !== null) {
    for (const appendix of childElements(back, 'app-group')) {
      appendixBlocks.push(...childElements(appendix).flatMap((kid) => renderBlock(kid, 0, ctx)));
    }
    for (const appendix of childElements(back, 'app')) {
      appendixBlocks.push(...renderBlock(appendix, 0, ctx));
    }
    for (const section of childElements(back, 'sec')) {
      appendixBlocks.push(...renderBlock(section, 0, ctx));
    }
  }

  const licenseNode = meta === null ? null : find(meta, 'license');
  const license = licenseNode === null ? null : tidy(trimmedText(licenseNode)) || null;
  const licenseUrl = licenseNode === null ? null : attr(licenseNode, 'xlink:href');

  const allBlocks = [...bodyBlocks];
  if (appendixBlocks.length > 0) {
    allBlocks.push('## 附录', ...appendixBlocks);
  }

  return {
    title,
    authors: authorsOf(meta),
    journal: journalMeta === null ? null : trimmedText(find(journalMeta, 'journal-title')) || null,
    year: yearOf(meta),
    doi: ids.doi,
    pmid: ids.pmid,
    pmcid: ids.pmcid,
    abstract,
    bodyMarkdown: allBlocks.filter((b) => b.trim() !== '').join('\n\n'),
    figures: [...ctx.figures],
    tables: [...ctx.tables],
    references: referencesOf(root),
    license: license === null ? licenseUrl : license,
    supplementary: [...ctx.supplementary],
  };
}

/**
 * 把解析结果渲染成一份完整的 Markdown 文档。
 *
 * 头部带上来源与许可：抓下来的全文能不能引用、能不能再分发取决于许可，而这份
 * Markdown 会被当成论文素材反复读——把许可写在文件里，用户在任何时候打开它都
 * 能看到，不必回去查文献条目。
 */
export function jatsToMarkdown(
  article: JatsArticle,
  provenance: { source: string; url?: string },
): string {
  const lines: string[] = [];

  lines.push(`# ${article.title ?? '（无标题）'}`);
  lines.push('');
  if (article.authors.length > 0) lines.push(`**作者**：${article.authors.join('；')}`);
  const meta: string[] = [];
  if (article.journal !== null) meta.push(article.journal);
  if (article.year !== null) meta.push(String(article.year));
  if (article.doi !== null) meta.push(`doi:${article.doi}`);
  if (article.pmcid !== null) meta.push(article.pmcid);
  if (meta.length > 0) lines.push(`**出处**：${meta.join('　')}`);
  lines.push(
    `**全文来源**：${provenance.source}${provenance.url === undefined ? '' : `（${provenance.url}）`}`,
  );
  if (article.license !== null) lines.push(`**许可**：${article.license}`);
  lines.push('');
  lines.push(
    '> 本文由 JATS XML 自动转换。数学公式与复杂表格的结构有损，' +
      '需要精确内容时读同一制品组里的原始 XML。',
  );

  if (article.abstract !== null) {
    lines.push('');
    lines.push('## 摘要');
    lines.push('');
    lines.push(article.abstract);
  }

  if (article.bodyMarkdown !== '') {
    lines.push('');
    lines.push(article.bodyMarkdown);
  }

  if (article.references.length > 0) {
    lines.push('');
    lines.push('## 参考文献');
    lines.push('');
    for (const [index, ref] of article.references.entries()) {
      const tail: string[] = [];
      if (ref.doi !== null) tail.push(`doi:${ref.doi}`);
      if (ref.pmid !== null) tail.push(`PMID:${ref.pmid}`);
      lines.push(
        `${String(index + 1)}. ${ref.text}${tail.length === 0 ? '' : `　[${tail.join('　')}]`}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

/** 供正文引用的图表清单摘要，用于工具输出。 */
export function describeAssets(article: JatsArticle): string {
  const parts: string[] = [];
  if (article.figures.length > 0) parts.push(`${String(article.figures.length)} 张图`);
  if (article.tables.length > 0) parts.push(`${String(article.tables.length)} 张表`);
  if (article.supplementary.length > 0) {
    parts.push(`${String(article.supplementary.length)} 份补充材料`);
  }
  if (article.references.length > 0) parts.push(`${String(article.references.length)} 条参考文献`);
  return parts.length === 0 ? '未识别出图表与参考文献' : parts.join('，');
}

/** 判断一个节点是不是元素。re-export 便于 fulltext 使用同一套判定。 */
export { isElement };
