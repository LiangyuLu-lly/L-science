/**
 * BibTeX 导出（任务 13.1、13.3，需求 12.5）。
 *
 * 三个决策决定了这个文件的形状：
 *
 * 1. **正文保留 UTF-8，只转义 LaTeX 特殊字符**。把 `é` 转成 `\'{e}` 在 biblatex +
 *    biber 下反而更容易出问题，而后者是现在的默认工具链。`asciiOnly` 选项留给
 *    仍在用传统 bibtex 的期刊模板。
 *
 * 2. **只保护首字母缩写词，不整体包双花括号**。`title = {{Sleep spindles...}}` 能
 *    保住大小写，代价是所有要求句首大写（sentence case）的样式全部失效——而那是
 *    大多数生物医学期刊的要求。折中办法是只给 `EEG`、`mRNA`、`COVID-19` 这类
 *    含内部大写或全大写的词加花括号，其余交给样式处理。
 *
 * 3. **引用键必须稳定**。键会出现在用户的 .tex 正文里（`\cite{smith2023sleep}`），
 *    重新导出时变了会让整篇文档的引用全部失效。因此键由 `library.ts` 的
 *    `bibtexKeyFor` 从姓氏/年份/首词算出并缓存进 `refs.bibtex`，不含随机成分。
 */

import type { CslItem, CslName } from './csl.js';
import { cslYear } from './csl.js';

/** CSL type → BibTeX entry type。 */
const ENTRY_TYPE: Readonly<Record<string, string>> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  review: 'article',
  article: 'misc',
  book: 'book',
  chapter: 'incollection',
  'entry-encyclopedia': 'incollection',
  'paper-conference': 'inproceedings',
  thesis: 'phdthesis',
  report: 'techreport',
  dataset: 'misc',
  software: 'misc',
  standard: 'misc',
  patent: 'misc',
  webpage: 'misc',
  document: 'misc',
};

/**
 * LaTeX 特殊字符。
 *
 * `\` 必须第一个处理，否则后续替换插入的反斜杠会被自己再转义一遍。用一次
 * 正则替换而不是链式 replace，就是为了避免这个顺序陷阱。
 */
const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '%': '\\%',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#_%~^]/gu, (ch) => LATEX_ESCAPES[ch] ?? ch);
}

/**
 * 常见带重音字符的 LaTeX 写法。
 *
 * 只列真实出现在作者名与期刊名里的。全表覆盖 Unicode 是不可能也不必要的——
 * `asciiOnly` 模式下无法转换的字符会被替换成基础拉丁字母（通过 NFKD 去掉
 * 组合符），而不是丢掉：丢掉会让作者名少一个字母，那比拼写不完美严重得多。
 */
const ACCENT_MAP: Readonly<Record<string, string>> = {
  á: "\\'{a}",
  à: '\\`{a}',
  â: '\\^{a}',
  ä: '\\"{a}',
  ã: '\\~{a}',
  å: '\\aa{}',
  é: "\\'{e}",
  è: '\\`{e}',
  ê: '\\^{e}',
  ë: '\\"{e}',
  í: "\\'{i}",
  ì: '\\`{i}',
  î: '\\^{i}',
  ï: '\\"{i}',
  ó: "\\'{o}",
  ò: '\\`{o}',
  ô: '\\^{o}',
  ö: '\\"{o}',
  õ: '\\~{o}',
  ø: '\\o{}',
  ú: "\\'{u}",
  ù: '\\`{u}',
  û: '\\^{u}',
  ü: '\\"{u}',
  ý: "\\'{y}",
  ÿ: '\\"{y}',
  ñ: '\\~{n}',
  ç: '\\c{c}',
  ß: '\\ss{}',
  æ: '\\ae{}',
  œ: '\\oe{}',
  ł: '\\l{}',
  š: '\\v{s}',
  ž: '\\v{z}',
  č: '\\v{c}',
  ř: '\\v{r}',
  ě: '\\v{e}',
  ů: '\\r{u}',
  ą: '\\k{a}',
  ę: '\\k{e}',
  ő: '\\H{o}',
  ű: '\\H{u}',
};

function toAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = ACCENT_MAP[lower];
    if (mapped !== undefined) {
      // 大写形式：把 map 里的小写字母换成大写（`\'{a}` → `\'{A}`）
      out +=
        ch === lower
          ? mapped
          : mapped.replace(/\{([a-z])\}/u, (_m, c: string) => `{${c.toUpperCase()}}`);
      continue;
    }
    if (ch.charCodeAt(0) < 128) {
      out += ch;
      continue;
    }
    // 兜底：去掉组合用重音符号，保留基础字母。CJK 字符没有分解形式，
    // 会原样留下——那是对的，传统 bibtex 处理 CJK 要靠 CJK 包而不是转义
    const decomposed = ch.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
    out += decomposed === '' ? ch : decomposed;
  }
  return out;
}

/**
 * 给需要保住大小写的词加花括号。
 *
 * 判据：全大写且长度 ≥2（`EEG`、`MRI`、`DNA`），或含内部大写（`mRNA`、`pH`、
 * `iPSC`），或含数字与字母混排（`COVID-19`、`5-HT`）。首词不特殊处理——句首
 * 大写本来就该由样式决定。
 *
 * 不保护单个大写字母：那会把每个句首都包起来，等于整体包双花括号。
 */
export function protectAcronyms(title: string): string {
  return title
    .split(/(\s+)/u)
    .map((token) => {
      if (/^\s*$/u.test(token)) return token;
      const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (core.length < 2) return token;
      // 已经被花括号包住的不再包
      if (token.includes('{')) return token;

      const allCaps = /^[\p{Lu}\p{N}]+$/u.test(core) && /\p{Lu}/u.test(core);
      const innerCaps = /^\p{L}/u.test(core) && /[\p{Lu}]/u.test(core.slice(1));
      const mixedDigit = /\p{L}/u.test(core) && /\p{N}/u.test(core) && /\p{Lu}/u.test(core);

      if (!allCaps && !innerCaps && !mixedDigit) return token;
      return token.replace(core, `{${core}}`);
    })
    .join('');
}

/**
 * BibTeX 的作者字段：`Family, Given and Family, Given`。
 *
 * 转义在这里逐段做，而不是由调用方对整个结果串做一次。机构作者要整体包花括号
 * （否则 bibtex 把最后一个词当姓，`World Health Organization` 会被渲染成
 * 「Organization, W. H.」），而事后转义会把那对花括号自己也转义掉，输出成
 * `\{World Health Organization\}`——花括号变成了正文里的字面字符，保护失效。
 */
function bibtexNames(names: readonly CslName[], esc: (text: string) => string): string {
  return names
    .map((n) => {
      if (typeof n.literal === 'string' && n.literal.trim() !== '') {
        return `{${esc(n.literal.trim())}}`;
      }
      const family = esc((n.family ?? '').trim());
      const given = esc((n.given ?? '').trim());
      const particle = esc((n['non-dropping-particle'] ?? '').trim());
      const full = particle === '' ? family : `${particle} ${family}`;
      if (full !== '' && given !== '') {
        return n.suffix === undefined ? `${full}, ${given}` : `${full}, ${esc(n.suffix)}, ${given}`;
      }
      return full === '' ? given : full;
    })
    .filter((s) => s !== '')
    .join(' and ');
}

/** CSL 页码转 BibTeX 的 `--`。 */
function bibtexPages(page: string): string {
  // 只把「数字-数字」形式的连字符转成 en dash 区间。`e12345` 或 `S1-S9` 里的
  // 连字符也一并处理（它们同样是区间），但 `10-15,20-22` 这种多段列表原样保留
  return page.replace(/(\d)\s*[-–—]\s*(\d)/gu, '$1--$2');
}

const MONTH_NAMES: readonly string[] = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

export interface BibtexOptions {
  /** 引用键。省略时用 `csl.id`（不保证是合法的 BibTeX 键）。 */
  key?: string;
  /** 转义所有非 ASCII 字符。传统 bibtex 工具链需要。 */
  asciiOnly?: boolean;
  /** 是否输出摘要。默认不输出：摘要会让 .bib 体积膨胀十倍且样式一般不用。 */
  includeAbstract?: boolean;
  /** 是否输出 keywords。 */
  includeKeywords?: boolean;
}

/**
 * 把一条 CSL 转成一个 BibTeX 条目。
 *
 * 缺字段就不输出该行，不写空值：`journal = {}` 会让某些样式打印出一个空的
 * 期刊名占位（比如「. , 2023」这种），比缺字段更难看且更难查。
 */
export function toBibtex(item: CslItem, options: BibtexOptions = {}): string {
  const entryType = ENTRY_TYPE[item.type] ?? 'misc';
  const key = sanitizeKey(options.key ?? item.id);

  const esc = (text: string): string => {
    const escaped = escapeLatex(text);
    return options.asciiOnly === true ? toAscii(escaped) : escaped;
  };

  const fields: [string, string][] = [];
  const push = (name: string, value: string | undefined): void => {
    if (value === undefined || value.trim() === '') return;
    fields.push([name, value]);
  };

  if ((item.author?.length ?? 0) > 0) push('author', bibtexNames(item.author ?? [], esc));
  if ((item.editor?.length ?? 0) > 0) push('editor', bibtexNames(item.editor ?? [], esc));

  if (typeof item.title === 'string') push('title', protectAcronyms(esc(item.title)));

  const container = item['container-title'];
  if (typeof container === 'string') {
    // 期刊 vs 会议/文集：BibTeX 用不同字段名，用错的话样式取不到值
    if (entryType === 'inproceedings' || entryType === 'incollection') {
      push('booktitle', esc(container));
    } else if (entryType === 'article') {
      push('journal', esc(container));
    } else {
      push('journal', esc(container));
    }
  }

  const year = cslYear(item);
  if (year !== null) push('year', String(year));

  const parts = item.issued?.['date-parts']?.[0];
  if (Array.isArray(parts) && parts.length >= 2) {
    const month = parts[1];
    if (typeof month === 'number' && month >= 1 && month <= 12) {
      // 月份用三字母缩写宏（不加花括号）：bibtex 的标准做法，样式会按语言本地化
      fields.push(['__raw_month', MONTH_NAMES[month - 1] as string]);
    }
  }

  push('volume', item.volume === undefined ? undefined : esc(item.volume));
  push('number', item.issue === undefined ? undefined : esc(item.issue));
  push('pages', item.page === undefined ? undefined : bibtexPages(esc(item.page)));
  push('publisher', item.publisher === undefined ? undefined : esc(item.publisher));
  push('address', item['publisher-place'] === undefined ? undefined : esc(item['publisher-place']));
  push('edition', item.edition === undefined ? undefined : esc(item.edition));

  // thesis 的机构在 CSL 里放 publisher，BibTeX 的 phdthesis 要 school
  if (entryType === 'phdthesis' && typeof item.publisher === 'string') {
    push('school', esc(item.publisher));
  }
  if (entryType === 'techreport' && typeof item.publisher === 'string') {
    push('institution', esc(item.publisher));
  }

  if (typeof item.DOI === 'string') push('doi', item.DOI);
  if (typeof item.URL === 'string') push('url', item.URL);
  if ((item.ISSN?.length ?? 0) > 0) push('issn', (item.ISSN ?? []).join(', '));
  if ((item.ISBN?.length ?? 0) > 0) push('isbn', (item.ISBN ?? []).join(', '));
  if (typeof item.language === 'string') push('language', esc(item.language));

  if (options.includeAbstract === true && typeof item.abstract === 'string') {
    push('abstract', esc(item.abstract));
  }
  if (options.includeKeywords === true && typeof item.keyword === 'string') {
    push('keywords', esc(item.keyword));
  }

  /*
   * 标识与警示信息进 note。
   *
   * PMID 与 PMCID 没有标准 BibTeX 字段（biblatex 有 `eprint`，但传统 bibtex 会
   * 忽略未知字段而不报错）。撤稿标记必须出现在输出里——它是这条记录最重要的信息，
   * 而 .bib 文件常常是用户唯一会去看的产物。
   */
  const notes: string[] = [];
  if (item.extra?.retracted === true) notes.push('RETRACTED（该文献已被撤稿）');
  if (typeof item.PMID === 'string') notes.push(`PMID: ${item.PMID}`);
  if (typeof item.PMCID === 'string') notes.push(`PMCID: ${item.PMCID}`);
  if (typeof item.extra?.arxivId === 'string') notes.push(`arXiv: ${item.extra.arxivId}`);
  if (item.type === 'article' && typeof item['container-title'] !== 'string') {
    notes.push('Preprint');
  }
  if (typeof item.note === 'string') notes.push(item.note);
  if (notes.length > 0) push('note', esc(notes.join('; ')));

  const width = Math.max(...fields.map(([name]) => (name === '__raw_month' ? 5 : name.length)), 1);
  const lines = fields.map(([name, value]) =>
    name === '__raw_month'
      ? `  ${'month'.padEnd(width)} = ${value},`
      : `  ${name.padEnd(width)} = {${value}},`,
  );

  return `@${entryType}{${key},\n${lines.join('\n')}\n}`;
}

/**
 * 清洗引用键。
 *
 * BibTeX 的键不允许含 `,`、`{`、`}`、空白与 `%`；实践中还要避开 `/`、`.`、`:`
 * （它们会让部分样式与 latexmk 出问题）。直接用 DOI 当键正是踩这一条。
 */
export function sanitizeKey(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9:_-]+/gu, '')
    .replace(/^[^A-Za-z0-9]+/u, '');
  return cleaned === '' ? 'ref' : cleaned.slice(0, 64);
}

/**
 * 导出多条为一个 .bib 文件。
 *
 * 键冲突时加后缀 `a`/`b`/…（BibTeX 的传统做法）。不去重掉冲突的条目：两条不同的
 * 文献恰好同一作者同年同首词是完全正常的，丢掉一条会让正文里的引用编译失败，
 * 而 latex 的报错信息（`Citation undefined`）不会指出原因。
 */
export function toBibtexFile(
  entries: readonly { csl: CslItem; key: string }[],
  options: BibtexOptions = {},
): string {
  const used = new Map<string, number>();
  const blocks: string[] = [];

  for (const entry of entries) {
    const base = sanitizeKey(entry.key);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const key = seen === 0 ? base : `${base}${String.fromCharCode(96 + seen)}`;
    blocks.push(toBibtex(entry.csl, { ...options, key }));
  }

  const header = [
    '% 由 L-science 导出',
    `% ${String(entries.length)} 条文献，生成时间 ${new Date().toISOString()}`,
    '% 正文保留 UTF-8。传统 bibtex 工具链请用 asciiOnly 模式重新导出，',
    '% 或改用 biblatex + biber（推荐）。',
  ].join('\n');

  return `${header}\n\n${blocks.join('\n\n')}\n`;
}
