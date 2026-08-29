/**
 * 引用导出（任务 13.3，需求 12.5）。
 *
 * 需求要求 BibTeX 与 CSL-JSON。这里实现三种：另加 RIS，因为不少期刊的投稿系统
 * （Editorial Manager、ScholarOne）只接受 RIS 或 EndNote 格式，而用户在那一步
 * 没有别的办法——导不出 RIS 就意味着他要手工重录几十条文献。
 *
 * 三条贯穿的决策：
 *
 * 1. **三种格式共用同一套引用键**。BibTeX 的 `\cite{smith2023sleep}` 与 CSL-JSON 的
 *    `id` 必须一致，否则同一篇 Markdown 手稿在 pandoc（读 CSL-JSON）与 LaTeX
 *    （读 .bib）之间切换时全部引用失效，而 LaTeX 的报错（`Citation undefined`）
 *    不会说出原因。
 *
 * 2. **导出时报告数据缺陷，但不阻止导出**。缺年份、缺作者、已撤稿这些问题在导出
 *    这一步是用户最后一次能看见它们的机会——之后这份 .bib 会被 LaTeX 吃掉，
 *    而 LaTeX 对缺失字段的反应是静默输出一个畸形的引用。因此警告必须给足；
 *    但拒绝导出是错的：用户可能正需要一份不完整的清单去核对。
 *
 * 3. **非标准字段进 `custom` 而不是硬塞进顶层**。CSL-JSON 1.0.2 规定 `custom`
 *    是应用私有数据的位置。塞在顶层的自定义键会让严格的 CSL 处理器报错或整条跳过，
 *    而「参考文献列表里少了一条」很难被发现。
 */

import type { CslItem, CslName } from './csl.js';
import { cslYear, nameLabel } from './csl.js';
import type { RefRecord } from '../repo/refs.js';
import { bibtexKeyFor, sanitizeKey, toBibtexFile } from './bibtex.js';

export type ExportFormat = 'bibtex' | 'csl-json' | 'ris';

export const EXPORT_FORMAT_LABEL: Readonly<Record<ExportFormat, string>> = {
  bibtex: 'BibTeX（.bib，LaTeX / biblatex）',
  'csl-json': 'CSL-JSON（.json，pandoc / Zotero / Word 的 CSL 引擎）',
  ris: 'RIS（.ris，EndNote / 多数期刊投稿系统）',
};

export const EXPORT_FORMAT_EXT: Readonly<Record<ExportFormat, string>> = {
  bibtex: 'bib',
  'csl-json': 'json',
  ris: 'ris',
};

export const EXPORT_FORMAT_MIME: Readonly<Record<ExportFormat, string>> = {
  bibtex: 'application/x-bibtex',
  'csl-json': 'application/json',
  ris: 'application/x-research-info-systems',
};

/** 一条导出警告。指向具体条目，而不是「有些条目缺字段」。 */
export interface ExportWarning {
  refId: string | null;
  key: string;
  cite: string;
  issue: string;
}

export interface ExportResult {
  format: ExportFormat;
  filename: string;
  content: string;
  mime: string;
  entryCount: number;
  /** 数据缺陷。不阻止导出，但必须让用户看见。 */
  warnings: readonly ExportWarning[];
  /** 引用键（按导出顺序）。手稿里 `\cite{}` 用的就是这些。 */
  keys: readonly string[];
}

export interface ExportOptions {
  format: ExportFormat;
  /** 输出文件名（不含扩展名）。 */
  stem?: string;
  /** BibTeX 的 asciiOnly 与摘要开关。 */
  asciiOnly?: boolean;
  includeAbstract?: boolean;
  /** 排序方式。`key` 是默认——它让两次导出的 diff 可读。 */
  sort?: 'key' | 'author-year' | 'year-desc' | 'added';
}

/* ------------------------------------------------------------------ *
 * 引用键
 * ------------------------------------------------------------------ */

/**
 * 给一批条目分配唯一引用键。
 *
 * 冲突时加字母后缀（`smith2023sleep`、`smith2023sleepa`），这是 BibTeX 社区的传统
 * 做法。**不能**改成加数字：`smith2023sleep2` 与「2 是年份的一部分」在视觉上区分不开。
 *
 * 顺序敏感：同一批条目、同一顺序必须得到同一组键。因此调用方要先排序再分配键，
 * 而不是反过来——反过来的话两次导出可能把后缀分给不同的条目，于是手稿里原本
 * 指向 A 的 `\cite{smith2023sleepa}` 变成指向 B，而编译不报错。
 */
export function assignKeys(refs: readonly RefRecord[]): readonly { ref: RefRecord; key: string }[] {
  const used = new Map<string, number>();
  return refs.map((ref) => {
    const base = sanitizeKey(bibtexKeyFor(ref));
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const key = seen === 0 ? base : `${base}${String.fromCharCode(96 + seen)}`;
    return { ref, key };
  });
}

function sortRefs(refs: readonly RefRecord[], mode: ExportOptions['sort']): readonly RefRecord[] {
  const copy = [...refs];
  switch (mode) {
    case 'author-year':
      return copy.sort((a, b) => {
        const byAuthor = (a.firstAuthor ?? '~').localeCompare(b.firstAuthor ?? '~');
        if (byAuthor !== 0) return byAuthor;
        return (a.year ?? 0) - (b.year ?? 0);
      });
    case 'year-desc':
      return copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    case 'added':
      return copy.sort((a, b) => a.addedAt - b.addedAt);
    default:
      // 默认按引用键排。让两次导出的 diff 只反映真实变化
      return copy.sort((a, b) => bibtexKeyFor(a).localeCompare(bibtexKeyFor(b)));
  }
}

/* ------------------------------------------------------------------ *
 * 数据缺陷检查
 * ------------------------------------------------------------------ */

/**
 * 导出前的数据体检。
 *
 * 检查项按「会不会让引用输出出错」排，而不是按「字段是否齐全」。缺 ISSN 不影响
 * 任何常用样式，缺年份会让 APA 输出成 `Smith, J. (n.d.)`——审稿人会当成疏漏。
 */
export function checkExportQuality(
  entries: readonly { ref: RefRecord; key: string }[],
): readonly ExportWarning[] {
  const warnings: ExportWarning[] = [];

  for (const { ref, key } of entries) {
    const csl = ref.csl;
    const cite = shortCite(csl);
    const push = (issue: string): void => {
      warnings.push({ refId: ref.id, key, cite, issue });
    };

    /*
     * 撤稿排在最前。
     *
     * 这是唯一一条不是「格式会出错」而是「结论会出错」的警告：引用一篇被撤稿的
     * 文献是审稿必退的问题，而它在正常的书目字段里完全看不出来。
     */
    if (csl.extra?.retracted === true) {
      push('该文献已被撤稿。引用它需要在正文里明确说明理由（例如讨论该撤稿事件本身）。');
    }
    if (Array.isArray(csl.extra?.updateTo)) {
      const notices = (csl.extra.updateTo as unknown[]).filter(
        (u): u is string => typeof u === 'string' && u.startsWith('retraction'),
      );
      if (notices.length > 0) push(`Crossref 记录显示它撤回了其他文献：${notices.join('、')}`);
    }

    if ((csl.author?.length ?? 0) === 0 && (csl.editor?.length ?? 0) === 0) {
      push('没有作者也没有编者。多数样式会输出成匿名条目。');
    }
    if (cslYear(csl) === null) {
      push('没有发表年份。APA 等样式会输出 (n.d.)，审稿人通常视为疏漏。');
    }
    if (typeof csl.title !== 'string' || csl.title.trim() === '') {
      push('没有标题。');
    }

    if (csl.type === 'article-journal' && typeof csl['container-title'] !== 'string') {
      push('标记为期刊论文但没有期刊名。');
    }
    if (csl.type === 'chapter' && typeof csl['container-title'] !== 'string') {
      push('标记为书章但没有书名（BibTeX 的 booktitle 会缺失）。');
    }
    if (csl.type === 'paper-conference' && typeof csl['container-title'] !== 'string') {
      push('标记为会议论文但没有会议名。');
    }
    if (csl.type === 'document') {
      push('条目类型未能确定（落到兜底的 document）。引用格式可能不符合该文献的实际类型。');
    }
    if (csl.type === 'article' && typeof csl['container-title'] !== 'string') {
      push('这是一篇 preprint（未经同行评议）。引用时应当标注。');
    }

    if (ref.doi === null && csl.PMID === undefined && csl.URL === undefined) {
      push('既没有 DOI 也没有 PMID 或 URL，读者无法定位这条文献。');
    }
  }

  return warnings;
}

/** 短引用，用于警告里指出是哪一条。 */
function shortCite(csl: CslItem): string {
  const first = csl.author?.[0];
  const author =
    first === undefined ? '（无作者）' : (first.family ?? first.literal ?? '（无姓氏）');
  const year = cslYear(csl);
  const title = (csl.title ?? '（无标题）').slice(0, 60);
  return `${author} ${year === null ? 'n.d.' : String(year)} 《${title}》`;
}

/* ------------------------------------------------------------------ *
 * CSL-JSON
 * ------------------------------------------------------------------ */

/** CSL 规范里我们会输出的字段。不在这份清单里的一律移进 `custom`。 */
const CSL_STANDARD_FIELDS: readonly string[] = [
  'id',
  'type',
  'title',
  'container-title',
  'container-title-short',
  'collection-title',
  'author',
  'editor',
  'issued',
  'accessed',
  'volume',
  'issue',
  'page',
  'page-first',
  'number-of-pages',
  'publisher',
  'publisher-place',
  'edition',
  'DOI',
  'URL',
  'PMID',
  'PMCID',
  'ISSN',
  'ISBN',
  'abstract',
  'language',
  'note',
  'keyword',
];

/**
 * 把一条内部 CSL 转成可导出的 CSL-JSON 条目。
 *
 * 两件事：把 `extra` 搬进 `custom`（CSL-JSON 1.0.2 为应用私有数据规定的位置），
 * 以及把**人需要看到**的信号补进 `note`。
 *
 * 为什么两处都放：`custom` 里的内容不会出现在任何渲染出来的参考文献列表里——
 * 它是给程序读的。而「已撤稿」必须让读这份文件的人看到，因此它同时进 `note`，
 * 因为大多数样式会渲染 note，Zotero 也会把它显示在条目详情里。
 */
export function toCslJsonItem(
  csl: CslItem,
  key: string,
  options: { includeAbstract?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const field of CSL_STANDARD_FIELDS) {
    if (field === 'id' || field === 'abstract' || field === 'note') continue;
    const value = (csl as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field] = value;
  }

  out.id = key;
  out.type = csl.type;

  if (options.includeAbstract === true && typeof csl.abstract === 'string') {
    out.abstract = csl.abstract;
  }

  const notes: string[] = [];
  if (csl.extra?.retracted === true) notes.push('RETRACTED（该文献已被撤稿）');
  if (csl.type === 'article' && typeof csl['container-title'] !== 'string') notes.push('Preprint');
  if (typeof csl.extra?.arxivId === 'string') notes.push(`arXiv: ${csl.extra.arxivId}`);
  if (typeof csl.note === 'string' && csl.note.trim() !== '') notes.push(csl.note.trim());
  if (notes.length > 0) out.note = notes.join('; ');

  /*
   * 私有数据进 custom。
   *
   * 用 `l-science` 作为命名空间键而不是把字段平铺进 custom：custom 是共享的，
   * 平铺会与其他工具（Zotero 用 custom 存自己的东西）撞名。
   */
  const extra = csl.extra ?? {};
  if (Object.keys(extra).length > 0) {
    out.custom = { 'l-science': extra };
  }

  return out;
}

/**
 * 导出 CSL-JSON。
 *
 * 缩进两格而不是压紧：这份文件会进版本库（用户把参考文献与手稿一起提交），
 * 压紧之后每次新增一条文献的 diff 是整个文件。
 */
export function toCslJsonFile(
  entries: readonly { csl: CslItem; key: string }[],
  options: { includeAbstract?: boolean } = {},
): string {
  const items = entries.map((entry) =>
    toCslJsonItem(entry.csl, entry.key, {
      ...(options.includeAbstract === undefined
        ? {}
        : { includeAbstract: options.includeAbstract }),
    }),
  );
  return `${JSON.stringify(items, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * RIS
 * ------------------------------------------------------------------ */

/** CSL type → RIS 的 TY 标签。 */
const RIS_TYPE: Readonly<Record<string, string>> = {
  'article-journal': 'JOUR',
  'article-magazine': 'MGZN',
  'article-newspaper': 'NEWS',
  review: 'JOUR',
  article: 'JOUR',
  book: 'BOOK',
  chapter: 'CHAP',
  'entry-encyclopedia': 'ENCYC',
  'paper-conference': 'CONF',
  thesis: 'THES',
  report: 'RPRT',
  dataset: 'DATA',
  software: 'COMP',
  standard: 'STD',
  patent: 'PAT',
  webpage: 'ELEC',
  document: 'GEN',
};

function risName(name: CslName): string {
  if (typeof name.literal === 'string' && name.literal.trim() !== '') return name.literal.trim();
  const family = (name.family ?? '').trim();
  const given = (name.given ?? '').trim();
  if (family !== '' && given !== '') return `${family}, ${given}`;
  return family === '' ? given : family;
}

/**
 * 导出 RIS。
 *
 * 格式细节都是硬要求，写错任何一条大多数导入器会静默丢掉整条记录：
 * 标签必须是两字符 + 两空格 + `-` + 一空格；`TY` 必须是第一行；`ER` 必须是最后一行
 * 且后面跟一个空行；换行用 CRLF（EndNote 与多数投稿系统的解析器按 CRLF 切行，
 * 用 LF 时它们会把整条记录读成一行）。
 */
export function toRisFile(entries: readonly { csl: CslItem; key: string }[]): string {
  const blocks: string[] = [];

  for (const { csl, key } of entries) {
    const lines: string[] = [];
    const push = (tag: string, value: string | undefined | null): void => {
      if (value === undefined || value === null) return;
      // RIS 的值不能含换行：多行内容要么折成一行，要么拆成多个同名标签
      const cleaned = value.replace(/\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (cleaned === '') return;
      lines.push(`${tag.padEnd(2, ' ')}  - ${cleaned}`);
    };

    push('TY', RIS_TYPE[csl.type] ?? 'GEN');
    for (const author of csl.author ?? []) push('AU', risName(author));
    for (const editor of csl.editor ?? []) push('ED', risName(editor));
    push('TI', csl.title);

    // 期刊名：JO 是全称，T2 是「次级标题」。书章与会议论文的容器名走 T2
    if (typeof csl['container-title'] === 'string') {
      if (csl.type === 'chapter' || csl.type === 'paper-conference') {
        push('T2', csl['container-title']);
      } else {
        push('JO', csl['container-title']);
        push('JA', csl['container-title-short']);
      }
    }

    const year = cslYear(csl);
    if (year !== null) push('PY', String(year));
    // DA 给完整日期。RIS 的日期格式是 `YYYY/MM/DD/`
    const parts = csl.issued?.['date-parts']?.[0];
    if (Array.isArray(parts) && parts.length >= 2) {
      const [y, m, d] = parts as (number | undefined)[];
      push(
        'DA',
        `${String(y ?? '')}/${String(m ?? '').padStart(2, '0')}/${d === undefined ? '' : String(d).padStart(2, '0')}/`,
      );
    }

    push('VL', csl.volume);
    push('IS', csl.issue);
    if (typeof csl.page === 'string') {
      const range = /^(\S+?)\s*[-–—]\s*(\S+)$/u.exec(csl.page);
      if (range === null) {
        push('SP', csl.page);
      } else {
        push('SP', range[1]);
        push('EP', range[2]);
      }
    }

    push('PB', csl.publisher);
    push('CY', csl['publisher-place']);
    push('ET', csl.edition);
    push('DO', csl.DOI);
    push('UR', csl.URL);
    for (const issn of csl.ISSN ?? []) push('SN', issn);
    for (const isbn of csl.ISBN ?? []) push('SN', isbn);
    push('LA', csl.language);
    push('AB', csl.abstract);

    // ID 让导入器保留我们的引用键，从而与 .bib 导出保持一致
    push('ID', key);

    const notes: string[] = [];
    if (csl.extra?.retracted === true) notes.push('RETRACTED（该文献已被撤稿）');
    if (csl.type === 'article' && typeof csl['container-title'] !== 'string')
      notes.push('Preprint');
    if (typeof csl.PMID === 'string') notes.push(`PMID: ${csl.PMID}`);
    if (typeof csl.PMCID === 'string') notes.push(`PMCID: ${csl.PMCID}`);
    if (typeof csl.note === 'string') notes.push(csl.note);
    if (notes.length > 0) push('N1', notes.join('; '));

    lines.push('ER  - ');
    blocks.push(lines.join('\r\n'));
  }

  // 记录之间空一行；文件以 CRLF 结束
  return `${blocks.join('\r\n\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 导出一批文献。
 *
 * 不落盘、不碰仓储——纯函数。落成制品由 `RefLibrary.export` 负责，这样这一层
 * 可以直接单测，也可以被手稿编译（任务 13.6）复用而不产生多余的制品。
 */
export function exportRefs(refs: readonly RefRecord[], options: ExportOptions): ExportResult {
  const sorted = sortRefs(refs, options.sort);
  const keyed = assignKeys(sorted);
  const entries = keyed.map(({ ref, key }) => ({ csl: ref.csl, key }));

  const content =
    options.format === 'bibtex'
      ? toBibtexFile(entries, {
          ...(options.asciiOnly === undefined ? {} : { asciiOnly: options.asciiOnly }),
          ...(options.includeAbstract === undefined
            ? {}
            : { includeAbstract: options.includeAbstract }),
        })
      : options.format === 'csl-json'
        ? toCslJsonFile(entries, {
            ...(options.includeAbstract === undefined
              ? {}
              : { includeAbstract: options.includeAbstract }),
          })
        : toRisFile(entries);

  const stem =
    (options.stem ?? 'references').replace(/[^\w.-]+/gu, '-').slice(0, 80) || 'references';
  const filename =
    options.format === 'csl-json'
      ? `${stem}.csl.json`
      : `${stem}.${EXPORT_FORMAT_EXT[options.format]}`;

  return {
    format: options.format,
    filename,
    content,
    mime: EXPORT_FORMAT_MIME[options.format],
    entryCount: entries.length,
    warnings: checkExportQuality(keyed),
    keys: keyed.map((k) => k.key),
  };
}

/**
 * 把警告折成给模型与用户看的文本。
 *
 * 按条目分组而不是按问题类型：用户要修的是某一条文献，把「五条缺年份」列在一起
 * 之后他还要再去对应回是哪五条。
 */
export function renderExportWarnings(warnings: readonly ExportWarning[], limit = 20): string {
  if (warnings.length === 0) return '';

  const byKey = new Map<string, { cite: string; issues: string[] }>();
  for (const warning of warnings) {
    const existing = byKey.get(warning.key);
    if (existing === undefined)
      byKey.set(warning.key, { cite: warning.cite, issues: [warning.issue] });
    else existing.issues.push(warning.issue);
  }

  const lines = [`${String(byKey.size)} 条文献存在会影响引用输出的问题：`];
  let shown = 0;
  for (const [key, entry] of byKey) {
    if (shown >= limit) {
      lines.push(`… 还有 ${String(byKey.size - shown)} 条，用 ref.list 逐条查看。`);
      break;
    }
    lines.push(`- ${key}　${entry.cite}`);
    for (const issue of entry.issues) lines.push(`    · ${issue}`);
    shown += 1;
  }
  return lines.join('\n');
}

/** 作者列表的完整展开，供手稿编译（任务 13.6）复用。 */
export function fullAuthorList(csl: CslItem): readonly string[] {
  return (csl.author ?? []).map(nameLabel);
}
