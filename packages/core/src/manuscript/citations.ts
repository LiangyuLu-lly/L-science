/**
 * 引文字符串解析（任务 13.5，需求 13.9）。
 *
 * 引文核实的第一步是把「一段引文」变成可检索的结构化字段。这一步做不好，后面的
 * 检索必然查不到，而查不到会被报成「可能是编造的引文」——那是最坏的误报：它让用户
 * 去核对一条其实存在的文献，几次之后他就不再相信这套检查了。
 *
 * 因此这里的取向与断言抽取相反：**宁可解析出较少的字段，也不要解析错**。把
 * 「Nature」当成作者姓氏会让检索指向完全无关的文献，而漏掉期刊名只是让检索宽一些。
 *
 * 支持的输入形态：
 *
 * 1. **完整的参考文献列表条目**（Vancouver / APA / 混合）：
 *    `Smith J, Jones A. Sleep spindles and memory. Nature. 2023;596(7873):583-9. doi:10.1038/x`
 * 2. **正文里的作者年份引用**：`(Smith et al., 2023)`
 * 3. **裸标识**：DOI、PMID、arXiv 编号
 * 4. **只有标题**：模型「记得」一个标题时最常见的形态
 *
 * 数字引用（`[12]`）与 `\cite{key}` 不在这里处理：它们本身不含任何书目信息，
 * 必须先经参考文献列表或 .bib 解析成上面四种之一。这一点由调用方负责，
 * 而不是在这里猜——猜错的方向是「把 [12] 当成一个标题去检索」。
 */

import { normalizeArxivId, normalizeDoi, normalizePmcid, normalizePmid } from '../refs/csl.js';

/** 解析出的引文结构。字段全部可空——解析不出来就不填，绝不猜。 */
export interface ParsedCitation {
  /** 原文，逐字保留。核实记录里存的是它。 */
  raw: string;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  /** 第一作者姓氏。 */
  firstAuthorSurname: string | null;
  /** 全部作者姓氏（按出现顺序）。 */
  authorSurnames: readonly string[];
  year: number | null;
  title: string | null;
  /** 期刊或会议名。 */
  container: string | null;
  volume: string | null;
  pages: string | null;
  /** 这条引文能不能拿去检索。false 时不该发请求。 */
  searchable: boolean;
  /** 解析出的形态，用于解释与排错。 */
  shape: CitationShape;
  /** 无法解析时的原因。 */
  reason: string | null;
}

export type CitationShape =
  | 'doi'
  | 'pmid'
  | 'pmcid'
  | 'arxiv'
  | 'reference-entry'
  | 'author-year'
  | 'title-only'
  | 'marker-only'
  | 'unparseable';

export const CITATION_SHAPE_LABEL: Readonly<Record<CitationShape, string>> = {
  doi: 'DOI',
  pmid: 'PMID',
  pmcid: 'PMCID',
  arxiv: 'arXiv 编号',
  'reference-entry': '参考文献条目',
  'author-year': '作者年份引用',
  'title-only': '仅标题',
  'marker-only': '仅引用标记（无书目信息）',
  unparseable: '无法解析',
};

function empty(raw: string, shape: CitationShape, reason: string | null): ParsedCitation {
  return {
    raw,
    doi: null,
    pmid: null,
    pmcid: null,
    arxivId: null,
    firstAuthorSurname: null,
    authorSurnames: [],
    year: null,
    title: null,
    container: null,
    volume: null,
    pages: null,
    searchable: false,
    shape,
    reason,
  };
}

/**
 * 从任意位置抠出 DOI。
 *
 * 参考文献条目里的 DOI 可能带 `doi:`、`https://doi.org/` 前缀，也可能在末尾跟着
 * 句号或访问日期。用 `normalizeDoi` 归一化——它已经处理了这些形态。
 */
function extractDoi(text: string): string | null {
  const match = /\b10\.\d{4,9}\/[^\s"'<>,;)]+/u.exec(text);
  return match === null ? null : normalizeDoi(match[0]);
}

function extractPmid(text: string): string | null {
  // 只认带 `PMID` 标签的：裸数字在参考文献里更可能是卷号、页码或年份
  const match = /\bPMID\s*[:：]?\s*(\d{5,9})\b/iu.exec(text);
  return match === null ? null : normalizePmid(match[1]);
}

function extractPmcid(text: string): string | null {
  const match = /\bPMC\s*(\d{4,9})\b/iu.exec(text);
  return match === null ? null : normalizePmcid(match[1]);
}

function extractArxiv(text: string): string | null {
  const match = /\barXiv\s*[:：]?\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/iu.exec(
    text,
  );
  return match === null ? null : normalizeArxivId(match[1]);
}

/** 四位年份。取第一个落在合理区间里的。 */
function extractYear(text: string): number | null {
  const currentYear = new Date().getUTCFullYear();
  for (const match of text.matchAll(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/gu)) {
    const year = Number(match[1]);
    // 上界留两年余量：出版商常把 in-press 文献标成下一年
    if (year >= 1500 && year <= currentYear + 2) return year;
  }
  return null;
}

/**
 * 判断一段文字像不像作者段。
 *
 * 参考文献条目的作者段有几种形式：`Smith J, Jones AB`（Vancouver）、
 * `Smith, J., & Jones, A. B.`（APA）、`Smith J. B.`。共同点是「姓氏首字母大写 +
 * 少量首字母缩写」，而且不含期刊名里常见的词。
 */
const NON_AUTHOR_WORDS =
  /\b(?:journal|review|proceedings|nature|science|cell|lancet|bmj|jama|plos|frontiers|advances|annals|archives|reports|letters|transactions|bulletin|acta|international|european|american|chinese|press|university|available|accessed|retrieved|http|www|doi|volume|issue|suppl)\b/iu;

/**
 * 从作者段抽姓氏。
 *
 * 两种断句：APA 用 `,` 分隔姓与名并用 `&`/`and` 连接最后一位；Vancouver 用 `,`
 * 分隔作者、空格分隔姓与缩写。两者混在一起时按「逗号切分，每段取首个大写词」
 * 处理——这条规则对两种格式都给出正确的姓氏，代价是复姓（`van der Berg`）
 * 只取到最后一节。
 *
 * 取姓氏而不是全名是刻意的：检索时上游对姓氏的匹配远比对「J.」或「John」可靠，
 * 而缩写与全名的差别会让精确匹配失败。
 */
function extractAuthorSurnames(segment: string): readonly string[] {
  const cleaned = segment
    .replace(/\bet\s+al\.?/giu, '')
    .replace(/\b(?:and|&)\b/giu, ',')
    .replace(/\s+/gu, ' ')
    .trim();

  const out: string[] = [];
  for (const piece of cleaned.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    // 纯缩写段（APA 的 `J. B.`）跳过：它是上一位作者的名
    if (/^(?:[A-Z]\.?\s*){1,4}$/u.test(trimmed)) continue;

    const words = trimmed.split(' ').filter((w) => w !== '');
    // 取第一个「首字母大写且不是单个缩写」的词作为姓氏
    const surname = words.find((w) => /^[A-Z][A-Za-z'’-]{1,}$/u.test(w.replace(/\.$/u, '')));
    if (surname === undefined) continue;
    const normalized = surname.replace(/\.$/u, '');
    if (NON_AUTHOR_WORDS.test(normalized)) continue;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 解析完整的参考文献条目。
 *
 * 策略是按句号切段，然后按位置认字段：第一段是作者，第二段是标题，第三段是期刊。
 * 这个假设对 Vancouver 与多数期刊格式成立，对 APA 也基本成立（APA 的年份在括号里，
 * 单独由 `extractYear` 取）。
 *
 * 切段用「句号 + 空格」而不是单纯句号：标题里的缩写（`et al.`、`vs.`）与 DOI 里的
 * 点号都不能断段。这里复用 `splitSentences` 的思路但更保守——只在「句号 + 空格 +
 * 大写字母或数字」处断，因为参考文献条目的每一段都以大写或数字开头。
 */
function parseReferenceEntry(raw: string): ParsedCitation | null {
  const text = raw.replace(/\s+/gu, ' ').trim();

  // 先摘掉 DOI 与 URL，它们里面的点号会干扰切段
  const withoutTail = text
    .replace(/\bdoi\s*[:：]?\s*10\.\d{4,9}\/\S+/giu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\bPMID\s*[:：]?\s*\d+/giu, ' ')
    .replace(/\bPMCID\s*[:：]?\s*PMC?\d+/giu, ' ')
    .trim();

  const segments = withoutTail
    .split(/(?<=[.。])\s+(?=[A-Z0-9\u4e00-\u9fff“"'(\[])/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');

  if (segments.length < 2) return null;

  const authorSegment = segments[0] as string;
  const surnames = extractAuthorSurnames(authorSegment);
  if (surnames.length === 0) return null;

  /*
   * 标题段。
   *
   * APA 把年份放在作者之后的括号里（`Smith, J. (2023). Title.`），此时第一段
   * 已经吞掉了年份，标题在第二段。Vancouver 的年份在期刊段里。两种情况下标题
   * 都是第二段——除了第二段看起来还是作者的情形（作者太多被切断了）。
   */
  let titleIndex = 1;
  while (
    titleIndex < segments.length - 1 &&
    (looksLikeAuthorSegment(segments[titleIndex] as string) ||
      // APA 把年份单独放在括号里（`Smith, J. (2023). Title.`），切段之后它自成一段。
      // 不跳过的话标题会被当成期刊、期刊被当成……而 `(2023)` 因为太短被判成没有标题
      !hasTitleSubstance(segments[titleIndex] as string))
  ) {
    titleIndex += 1;
  }

  const titleRaw = (segments[titleIndex] ?? '').replace(/[.。]\s*$/u, '').trim();
  const title = titleRaw.length >= 8 ? titleRaw : null;

  const containerRaw = (segments[titleIndex + 1] ?? '').trim();
  // 期刊段形如 `Nature. 2023;596(7873):583-9.` 或 `Nature, 596, 583-589.`
  const containerMatch = /^([^.;,0-9]{2,120}?)\s*[.;,]/u.exec(containerRaw);
  const container =
    containerMatch === null
      ? containerRaw === ''
        ? null
        : containerRaw.replace(/[.。]\s*$/u, '').slice(0, 120)
      : (containerMatch[1] ?? '').trim();

  const volume = /(?:^|[;,\s])(\d{1,4})\s*(?:\(\d+\))?\s*[:：]/u.exec(containerRaw)?.[1] ?? null;
  const pages = /(\d{1,6}\s*[-–—]\s*\d{1,6}|e\d{4,7})/u.exec(containerRaw)?.[1] ?? null;

  return {
    raw,
    doi: extractDoi(text),
    pmid: extractPmid(text),
    pmcid: extractPmcid(text),
    arxivId: extractArxiv(text),
    firstAuthorSurname: surnames[0] ?? null,
    authorSurnames: surnames,
    year: extractYear(text),
    title,
    container: container === null || container === '' ? null : container,
    volume,
    pages,
    searchable: true,
    shape: 'reference-entry',
    reason: null,
  };
}

/**
 * 一段文字有没有足够的内容当标题。
 *
 * 判据是「去掉标点与数字之后还剩至少 8 个字母，或者含中日韩字符」。`(2023).`、
 * `32(2), 100-110.`、`pp. 1-10.` 都过不了这一关，而它们在切段之后会与标题混在一起。
 */
function hasTitleSubstance(segment: string): boolean {
  if (/[\u4e00-\u9fff]{4,}/u.test(segment)) return true;
  const letters = segment.replace(/[^A-Za-z]/gu, '');
  return letters.length >= 8;
}

/** 一段文字是否更像作者段而不是标题。 */
function looksLikeAuthorSegment(segment: string): boolean {
  if (NON_AUTHOR_WORDS.test(segment)) return false;
  // 作者段里逗号密度高、单词短、含大量首字母缩写
  const initials = (segment.match(/\b[A-Z]{1,3}\b/gu) ?? []).length;
  const words = segment.split(/\s+/u).length;
  return words > 0 && initials / words > 0.35;
}

/**
 * 解析正文里的作者年份引用。
 *
 * `(Smith et al., 2023)` 只有姓氏与年份，检索时命中率明显低于完整条目。仍然要支持：
 * 用户让模型核实的往往正是正文里的这些引用。
 */
function parseAuthorYear(raw: string): ParsedCitation | null {
  const inner = /^\s*[([]?\s*(.+?)\s*[)\]]?\s*$/u.exec(raw)?.[1] ?? raw;
  const year = extractYear(inner);
  if (year === null) return null;

  const beforeYear = inner.slice(0, inner.indexOf(String(year)));
  const surnames = extractAuthorSurnames(beforeYear);
  if (surnames.length === 0) return null;

  // 姓氏 + 年份两个字段太弱，但足以发起一次书目检索
  return {
    ...empty(raw, 'author-year', null),
    firstAuthorSurname: surnames[0] ?? null,
    authorSurnames: surnames,
    year,
    searchable: true,
    shape: 'author-year',
    reason: null,
  };
}

/**
 * 解析一条引文。
 *
 * 顺序即优先级。标识排最前是因为它们能唯一定位，一旦命中就不必再猜标题与作者。
 */
export function parseCitation(raw: string): ParsedCitation {
  const trimmed = raw.replace(/\s+/gu, ' ').trim();
  if (trimmed === '') return empty(raw, 'unparseable', '空字符串');

  const doi = extractDoi(trimmed);
  if (doi !== null) {
    /*
     * 有 DOI 时仍然继续解析其余字段。
     *
     * 只按 DOI 查会漏掉一类关键错误：DOI 是真的但正文里写的作者、年份、标题
     * 与它指向的文献不符——那说明引文本身错了（复制错行是最常见的成因）。
     * 检出这种错误需要同时有「引文声称的」与「DOI 实际指向的」两份信息。
     */
    const entry = parseReferenceEntry(trimmed);
    if (entry !== null) return { ...entry, doi, shape: 'doi' };
    return {
      ...empty(raw, 'doi', null),
      doi,
      year: extractYear(trimmed),
      searchable: true,
    };
  }

  const pmid = extractPmid(trimmed);
  if (pmid !== null) {
    const entry = parseReferenceEntry(trimmed);
    if (entry !== null) return { ...entry, pmid, shape: 'pmid' };
    return { ...empty(raw, 'pmid', null), pmid, searchable: true };
  }

  const pmcid = extractPmcid(trimmed);
  if (pmcid !== null) {
    return { ...empty(raw, 'pmcid', null), pmcid, searchable: true };
  }

  const arxivId = extractArxiv(trimmed);
  if (arxivId !== null) {
    return { ...empty(raw, 'arxiv', null), arxivId, searchable: true };
  }

  /*
   * 只有引用标记而无书目信息。
   *
   * `[12]`、`\cite{smith2023}`、`@smith2023` 单独出现时不含任何可检索的内容。
   * 必须明确拒绝而不是当成标题去查——把 `[12]` 当标题检索会返回一堆无关文献，
   * 而其中最相似的那条会被当成命中，于是一条编造的引文被「核实」通过了。
   */
  /*
   * 判据是「把全部引用标记摘掉之后还剩多少字母」，而不是「整串是否恰好是一个标记」。
   *
   * 只匹配单个标记会漏掉 `[12], [3,5-7], [9]` 这种一行多个标记的形态——它有 18 个
   * 字符、三个「词」，于是会掉进下面的「当成标题」兜底，然后被拿去检索。那正是
   * 这一档要防的事。
   */
  const withoutMarkers = trimmed
    .replace(/\[[\d\s,;–-]+\]/gu, ' ')
    .replace(/\\cite[tp]?\*?(?:\[[^\]]*\])*\{[^}]*\}/gu, ' ')
    .replace(/(?<![\w@])@[A-Za-z][\w:.#$%&+?<>~/-]*/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

  const hadMarker = withoutMarkers.length < trimmed.replace(/[^\p{L}\p{N}]+/gu, '').length;
  if (hadMarker && withoutMarkers.replace(/\d+/gu, '').length < 6) {
    return empty(
      raw,
      'marker-only',
      '这只是一个引用标记，不含任何书目信息。先在参考文献列表或 .bib 里找到它对应的条目，' +
        '再核实那个条目。把标记本身当标题去检索会返回一堆无关文献，' +
        '而其中最相似的那条会被误判为命中。',
    );
  }

  /*
   * 完整条目优先于正文引用。
   *
   * 顺序反过来会出一个静默的降级：APA 条目
   * `Smith, J. (2023). Title. Journal, 32, 1-10.` 里含 `(2023)`，`parseAuthorYear`
   * 因此命中并返回一个只有姓氏与年份的结果——标题被丢掉了。而标题是检索区分度
   * 最高的字段，丢掉它会让这条引文检索不到，然后被报成「可能是编造的」。
   *
   * 反向不会误判：`(Smith et al., 2023)` 里没有「句号 + 空格 + 大写」的分段，
   * `parseReferenceEntry` 会直接返回 null。
   */
  const entry = parseReferenceEntry(trimmed);
  if (entry !== null) return entry;

  const authorYear = parseAuthorYear(trimmed);
  if (authorYear !== null) return authorYear;

  /*
   * 兜底：当成标题。
   *
   * 门槛设在 12 个字符与 3 个词（中文按字符数）：更短的串（`Nature 2023`）
   * 检索出来的东西没有判断价值，而返回一个「找不到」会让用户以为这篇文献不存在。
   */
  const words = trimmed.split(/\s+/u).length;
  const hasCjk = /[\u4e00-\u9fff]/u.test(trimmed);
  if (trimmed.length >= 12 && (words >= 3 || (hasCjk && trimmed.length >= 8))) {
    return {
      ...empty(raw, 'title-only', null),
      title: trimmed.slice(0, 400),
      year: extractYear(trimmed),
      searchable: true,
      shape: 'title-only',
      reason: null,
    };
  }

  return empty(
    raw,
    'unparseable',
    `「${trimmed}」里没有可检索的书目信息（没有 DOI/PMID，也没有足够长的标题）。` +
      '核实一条引文至少需要标题，或者一个标识。',
  );
}

/**
 * 从参考文献列表里逐条解析。
 *
 * 列表的行首常带序号（`1.`、`[1]`、`(1)`）。序号要摘掉——留着它会让
 * `extractYear` 在 `1. Smith J...` 里把 `1` 之后的东西错认，也会让作者段解析失败。
 *
 * 一条引文可能跨多行（软换行），因此按「以序号开头」而不是按行切分。没有序号的
 * 列表按空行分段。
 */
export function parseReferenceList(text: string): readonly ParsedCitation[] {
  const lines = text.split(/\r?\n/u);
  const numbered = /^\s*(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})[.)、])\s+/u;

  const blocks: string[] = [];
  let current: string[] = [];
  let sawNumber = false;

  for (const line of lines) {
    if (numbered.test(line)) {
      sawNumber = true;
      if (current.length > 0) blocks.push(current.join(' '));
      current = [line.replace(numbered, '')];
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(line.trim());
  }
  if (current.length > 0) blocks.push(current.join(' '));

  // 没有任何序号时按行切：那通常是一份手工列表，一行一条
  const candidates = sawNumber
    ? blocks
    : blocks.flatMap((b) => (b.includes('\n') ? b.split('\n') : [b]));

  return candidates
    .map((block) => block.replace(/\s+/gu, ' ').trim())
    .filter((block) => block.length >= 12)
    .slice(0, 500)
    .map((block) => parseCitation(block));
}

/** 渲染成一行，用于工具输出与核实记录。 */
export function describeCitation(parsed: ParsedCitation): string {
  const parts: string[] = [];
  if (parsed.firstAuthorSurname !== null) {
    parts.push(
      parsed.authorSurnames.length > 1
        ? `${parsed.firstAuthorSurname} 等`
        : parsed.firstAuthorSurname,
    );
  }
  if (parsed.year !== null) parts.push(`（${String(parsed.year)}）`);
  if (parsed.title !== null) parts.push(parsed.title.slice(0, 120));
  if (parsed.container !== null) parts.push(`. ${parsed.container}`);
  if (parsed.doi !== null) parts.push(`. doi:${parsed.doi}`);
  if (parsed.pmid !== null) parts.push(`. PMID:${parsed.pmid}`);

  const summary = parts.join('');
  return summary === '' ? parsed.raw.slice(0, 160) : summary;
}
