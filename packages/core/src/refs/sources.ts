/**
 * 文献元数据上游（任务 13.1，需求 12.1）。
 *
 * 需求要求至少覆盖 Crossref、OpenAlex、Semantic Scholar 与 PubMed。这里实现六家：
 * 另加 DataCite（数据集与软件的 DOI 注册在它那里，Crossref 对这类 DOI 一律 404）
 * 与 Europe PMC（生物医学覆盖最全，并且它是唯一在元数据里直接告诉你「全文能不能
 * 拿到、以什么形式」的来源——13.2 的抓取链要用）。
 *
 * 每家一个纯函数，形状统一为 `SourceResult`：**永不抛异常**，失败变成
 * `ok: false` 加一句原因。多源解析要串六家，任何一家抛异常都会让整次解析中断，
 * 而那时用户看到的是「解析失败」，看不到其实另外五家里有四家成功了。
 *
 * 六家的字段完备度差别很大，这决定了默认的尝试顺序（见 `resolver.ts`）：
 * Crossref 的书目字段最规范（页码、ISSN、卷期齐全）；OpenAlex 独有 `is_retracted`
 * 与开放获取位置；Semantic Scholar 独有 tldr 与影响力被引数；Europe PMC 独有
 * 全文可得性；PubMed 独有 MeSH 与出版类型。
 */

import type { CslItem, CslName, CslType } from './csl.js';
import {
  cleanAbstract,
  compact,
  dateParts,
  ensureCsl,
  intOrUndefined,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  str,
} from './csl.js';
import type { HttpOptions, HttpResult, RefSourceId } from './http.js';
import { arr, httpJson, pick } from './http.js';

/** 一次上游解析的结果。 */
export interface SourceResult {
  source: RefSourceId;
  ok: boolean;
  item: CslItem | null;
  /** 失败原因。ok 时为 null。 */
  reason: string | null;
  /** 实际请求地址，供审计。 */
  url: string;
  status: number | null;
}

/** 检索命中的候选。用于标题反查 DOI 与引文核实（需求 13.9）。 */
export interface SourceCandidate {
  source: RefSourceId;
  item: CslItem;
  /** 上游给出的相关性分数，各家量纲不同，仅用于同源内排序。 */
  score: number | null;
}

export interface SourceSearchResult {
  source: RefSourceId;
  ok: boolean;
  candidates: readonly SourceCandidate[];
  reason: string | null;
  url: string;
  /** 上游声明的命中总数。用于「这个标题在库里根本不存在」这个判断。 */
  total: number | null;
}

function fail(source: RefSourceId, url: string, res: HttpResult): SourceResult {
  return {
    source,
    ok: false,
    item: null,
    reason: res.reason ?? '未知失败',
    url,
    status: res.status,
  };
}

function failSearch(source: RefSourceId, url: string, res: HttpResult): SourceSearchResult {
  return {
    source,
    ok: false,
    candidates: [],
    reason: res.reason ?? '未知失败',
    url,
    total: null,
  };
}

function empty(source: RefSourceId, url: string, reason: string): SourceResult {
  return { source, ok: false, item: null, reason, url, status: 200 };
}

/** mailto 作为查询参数附上（Crossref 与 OpenAlex 都据此走礼节池）。 */
function withMailto(url: URL, options: HttpOptions): URL {
  const mailto = options.mailto ?? null;
  if (mailto !== null && mailto.trim() !== '') url.searchParams.set('mailto', mailto.trim());
  return url;
}

/* ------------------------------------------------------------------ *
 * Crossref
 * ------------------------------------------------------------------ */

/**
 * Crossref 的 `type` → CSL type。
 *
 * 映射表写全而不是「认识的映射、其余归 document」：`posted-content`（preprint）
 * 与 `proceedings-article`（会议论文）在引用格式上与期刊论文差别很大，落到
 * document 之后导出的引用会缺少会议名或不标注 preprint 身份——审稿人会当成
 * 已发表文献来看。
 */
const CROSSREF_TYPE: Readonly<Record<string, CslType>> = {
  'journal-article': 'article-journal',
  'journal-issue': 'document',
  'journal-volume': 'document',
  journal: 'document',
  'proceedings-article': 'paper-conference',
  proceedings: 'book',
  'proceedings-series': 'book',
  'book-chapter': 'chapter',
  'book-part': 'chapter',
  'book-section': 'chapter',
  'book-series': 'book',
  'book-set': 'book',
  'book-track': 'chapter',
  book: 'book',
  monograph: 'book',
  'reference-book': 'book',
  'reference-entry': 'entry-encyclopedia',
  'edited-book': 'book',
  dissertation: 'thesis',
  dataset: 'dataset',
  database: 'dataset',
  component: 'document',
  report: 'report',
  'report-component': 'report',
  'report-series': 'report',
  standard: 'standard',
  'peer-review': 'review',
  'posted-content': 'article',
  grant: 'document',
  other: 'document',
};

function crossrefNames(raw: unknown): readonly CslName[] {
  const out: CslName[] = [];
  for (const entry of arr(raw)) {
    const family = str(pick(entry, 'family'));
    const given = str(pick(entry, 'given'));
    const literal = str(pick(entry, 'name'));
    const suffix = str(pick(entry, 'suffix'));
    if (family === undefined && given === undefined && literal === undefined) continue;
    out.push({
      ...(family === undefined ? {} : { family }),
      ...(given === undefined ? {} : { given }),
      ...(literal === undefined ? {} : { literal }),
      ...(suffix === undefined ? {} : { suffix }),
    });
  }
  return out;
}

/** Crossref 的 date-parts 已经是 CSL 形状，只需要挑一个可用的日期字段。 */
function crossrefDate(msg: unknown): ReturnType<typeof dateParts> {
  // 顺序：issued（正式发表）→ published-print → published-online → created。
  // issued 是 Crossref 对「发表日期」的规范答案；created 是记录创建时间，
  // 与发表日期可能差几个月，只在其余全缺时用
  for (const key of ['issued', 'published', 'published-print', 'published-online', 'created']) {
    const parts = pick(msg, key, 'date-parts', 0);
    if (Array.isArray(parts) && parts.length > 0) {
      const [y, m, d] = parts as (number | undefined)[];
      const year = intOrUndefined(y);
      if (year === undefined) continue;
      return dateParts(year, intOrUndefined(m), intOrUndefined(d));
    }
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const s = str(entry);
      if (s !== undefined) return s;
    }
    return undefined;
  }
  return str(value);
}

function stringList(value: unknown): readonly string[] | undefined {
  const out: string[] = [];
  for (const entry of arr(value)) {
    const s = str(entry);
    if (s !== undefined) out.push(s);
  }
  return out.length === 0 ? undefined : out;
}

/** 把 Crossref 的 `message` 翻成 CSL。 */
export function crossrefToCsl(msg: unknown): CslItem | null {
  const doi = normalizeDoi(str(pick(msg, 'DOI')));
  const title = firstString(pick(msg, 'title'));
  if (doi === null && title === undefined) return null;

  const rawType = str(pick(msg, 'type')) ?? 'other';
  const subtype = str(pick(msg, 'subtype'));
  // preprint 的 subtype 才是 'preprint'；posted-content 也可能是 report 或 dissertation
  const type: CslType =
    rawType === 'posted-content' && subtype !== undefined && subtype !== 'preprint'
      ? (CROSSREF_TYPE[subtype] ?? 'article')
      : (CROSSREF_TYPE[rawType] ?? 'document');

  const authors = crossrefNames(pick(msg, 'author'));
  const editors = crossrefNames(pick(msg, 'editor'));
  const container = firstString(pick(msg, 'container-title'));
  const shortContainer = firstString(pick(msg, 'short-container-title'));
  const issued = crossrefDate(msg);
  const page = str(pick(msg, 'page'));
  const issn = stringList(pick(msg, 'ISSN'));
  const isbn = stringList(pick(msg, 'ISBN'));
  const abstract = cleanAbstract(pick(msg, 'abstract'));

  const extra: Record<string, unknown> = {};
  const citedBy = intOrUndefined(pick(msg, 'is-referenced-by-count'));
  if (citedBy !== undefined) extra.citedByCount = citedBy;
  const refCount = intOrUndefined(pick(msg, 'reference-count'));
  if (refCount !== undefined) extra.referenceCount = refCount;
  const subjects = stringList(pick(msg, 'subject'));
  if (subjects !== undefined) extra.subjects = subjects;
  if (rawType === 'posted-content') extra.preprint = true;
  const license = firstString(arr(pick(msg, 'license')).map((l) => pick(l, 'URL')));
  if (license !== undefined) extra.license = license;
  /*
   * 撤稿与更正线索（需求 13.7 之外的额外价值）。
   *
   * Crossref 用 `update-to` 表达「本文更正/撤回了某文」，`update-policy` 只是
   * 期刊的政策链接。引用一篇已被撤稿的文献是论文层面的硬伤，因此哪怕它不在
   * 需求清单里也要保留下来——它是元数据里现成的。
   */
  const updates = arr(pick(msg, 'update-to'))
    .map((u) => {
      const label = str(pick(u, 'type'));
      const target = normalizeDoi(str(pick(u, 'DOI')));
      return label === undefined || target === null ? null : `${label}:${target}`;
    })
    .filter((x): x is string => x !== null);
  if (updates.length > 0) extra.updateTo = updates;

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title,
      'container-title': container,
      'container-title-short': shortContainer,
      author: authors.length === 0 ? undefined : authors,
      editor: editors.length === 0 ? undefined : editors,
      issued,
      volume: str(pick(msg, 'volume')),
      issue: str(pick(msg, 'issue')),
      page,
      publisher: str(pick(msg, 'publisher')),
      DOI: doi ?? undefined,
      URL: str(pick(msg, 'URL')),
      ISSN: issn,
      ISBN: isbn,
      abstract,
      language: str(pick(msg, 'language')),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? `crossref:${title ?? 'unknown'}`,
  );
}

export async function crossrefByDoi(doi: string, options: HttpOptions = {}): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'crossref',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }
  // DOI 后缀里合法地包含 `/`，因此只能编码路径段而不是整个 DOI。
  // encodeURIComponent 会把斜杠也编码掉，Crossref 对此是宽容的（两种都认），
  // 但保留原样更接近其它客户端的行为，出问题时便于与文档对照
  const url = withMailto(
    new URL(
      `https://api.crossref.org/works/${normalized.split('/').map(encodeURIComponent).join('/')}`,
    ),
    options,
  ).toString();

  const res = await httpJson(url, options);
  if (!res.ok) return fail('crossref', url, res);

  const item = crossrefToCsl(pick(res.json, 'message'));
  if (item === null) return empty('crossref', url, 'Crossref 返回的记录里既没有 DOI 也没有标题');
  return { source: 'crossref', ok: true, item, reason: null, url, status: res.status };
}

/**
 * 按书目信息检索 Crossref。
 *
 * 用 `query.bibliographic` 而不是 `query.title`：前者会把作者、年份、期刊一起
 * 参与匹配，对「模型给了一条不完整引文，要找出它到底是哪篇」这个场景（需求 13.9）
 * 命中率高得多。
 */
export async function crossrefSearch(
  query: { bibliographic?: string; title?: string; author?: string; year?: number; rows?: number },
  options: HttpOptions = {},
): Promise<SourceSearchResult> {
  const url = new URL('https://api.crossref.org/works');
  if (query.bibliographic !== undefined) {
    url.searchParams.set('query.bibliographic', query.bibliographic);
  }
  if (query.title !== undefined) url.searchParams.set('query.title', query.title);
  if (query.author !== undefined) url.searchParams.set('query.author', query.author);
  if (query.year !== undefined) {
    url.searchParams.set(
      'filter',
      `from-pub-date:${String(query.year)}-01-01,until-pub-date:${String(query.year)}-12-31`,
    );
  }
  url.searchParams.set('rows', String(Math.max(1, Math.min(query.rows ?? 5, 20))));
  withMailto(url, options);

  const href = url.toString();
  const res = await httpJson(href, options);
  if (!res.ok) return failSearch('crossref', href, res);

  const candidates: SourceCandidate[] = [];
  for (const raw of arr(pick(res.json, 'message', 'items'))) {
    const item = crossrefToCsl(raw);
    if (item === null) continue;
    const score = pick(raw, 'score');
    candidates.push({
      source: 'crossref',
      item,
      score: typeof score === 'number' ? score : null,
    });
  }

  return {
    source: 'crossref',
    ok: true,
    candidates,
    reason: null,
    url: href,
    total: intOrUndefined(pick(res.json, 'message', 'total-results')) ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * OpenAlex
 * ------------------------------------------------------------------ */

const OPENALEX_TYPE: Readonly<Record<string, CslType>> = {
  article: 'article-journal',
  'book-chapter': 'chapter',
  dataset: 'dataset',
  preprint: 'article',
  dissertation: 'thesis',
  book: 'book',
  review: 'review',
  'reference-entry': 'entry-encyclopedia',
  report: 'report',
  standard: 'standard',
  editorial: 'article-journal',
  letter: 'article-journal',
  erratum: 'article-journal',
  'peer-review': 'review',
  libguides: 'webpage',
  'supplementary-materials': 'document',
  other: 'document',
  paratext: 'document',
  retraction: 'article-journal',
  grant: 'document',
};

/**
 * 从 OpenAlex 的倒排索引重建摘要。
 *
 * OpenAlex 出于版权考虑不给连续文本，只给 `{词: [出现位置]}`。按位置放回去就能
 * 还原原文。位置有重复或缺口时按已知位置输出，缺口留空——重建出的摘要即使有洞
 * 也比没有摘要有用，而假装完整会让人以为读到的是全文摘要。
 */
export function rebuildInvertedAbstract(index: unknown): string | undefined {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) return undefined;
  const slots: string[] = [];
  let max = -1;
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    for (const pos of arr(positions)) {
      if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0 || pos > 100_000) continue;
      slots[pos] = word;
      if (pos > max) max = pos;
    }
  }
  if (max < 0) return undefined;
  const words: string[] = [];
  for (let i = 0; i <= max; i += 1) {
    const w = slots[i];
    if (w !== undefined) words.push(w);
  }
  return cleanAbstract(words.join(' '));
}

/** OpenAlex 只给作者显示名，需要拆成姓与名。 */
function splitDisplayName(display: string): CslName {
  const cleaned = display.trim().replace(/\s+/gu, ' ');
  if (cleaned === '') return {};
  // 机构名的判据：含关键词或不含空格的单词块。拆错的后果是引用里出现
  // 「University, of California」，因此宁可整体当 literal
  if (
    /\b(university|institute|hospital|center|centre|laboratory|college|department|consortium|group|committee|society|ministry|academy)\b/iu.test(
      cleaned,
    )
  ) {
    return { literal: cleaned };
  }
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { family: cleaned };
  const family = parts[parts.length - 1] ?? '';
  const given = parts.slice(0, -1).join(' ');
  return { family, given };
}

export function openAlexToCsl(work: unknown): CslItem | null {
  const doi = normalizeDoi(str(pick(work, 'doi')) ?? str(pick(work, 'ids', 'doi')));
  const title = str(pick(work, 'title')) ?? str(pick(work, 'display_name'));
  if (doi === null && title === undefined) return null;

  const rawType = str(pick(work, 'type')) ?? 'other';
  let type: CslType = OPENALEX_TYPE[rawType] ?? 'document';
  // OpenAlex 把 preprint 也标成 article，靠 primary_location 的仓储类型区分
  const locationType = str(pick(work, 'primary_location', 'source', 'type'));
  if (rawType === 'article' && locationType === 'repository') type = 'article';

  const authors: CslName[] = [];
  for (const authorship of arr(pick(work, 'authorships'))) {
    const display = str(pick(authorship, 'author', 'display_name'));
    if (display === undefined) continue;
    authors.push(splitDisplayName(display));
  }

  const container =
    str(pick(work, 'primary_location', 'source', 'display_name')) ??
    str(pick(work, 'host_venue', 'display_name'));
  const pubDate = str(pick(work, 'publication_date'));
  const year = intOrUndefined(pick(work, 'publication_year'));
  let issued = dateParts(year);
  if (pubDate !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(pubDate);
    if (m !== null) {
      issued = dateParts(Number(m[1]), Number(m[2]), Number(m[3]));
    }
  }

  const firstPage = str(pick(work, 'biblio', 'first_page'));
  const lastPage = str(pick(work, 'biblio', 'last_page'));
  const page =
    firstPage === undefined
      ? undefined
      : lastPage === undefined || lastPage === firstPage
        ? firstPage
        : `${firstPage}-${lastPage}`;

  const abstract =
    cleanAbstract(pick(work, 'abstract')) ??
    rebuildInvertedAbstract(pick(work, 'abstract_inverted_index'));

  const pmid = normalizePmid(str(pick(work, 'ids', 'pmid'))?.replace(/^.*\//u, ''));
  const pmcid = normalizePmcid(str(pick(work, 'ids', 'pmcid'))?.replace(/^.*\//u, ''));

  const extra: Record<string, unknown> = {};
  const openAlexId = str(pick(work, 'id'));
  if (openAlexId !== undefined)
    extra.openAlexId = openAlexId.replace(/^https?:\/\/openalex\.org\//u, '');
  const citedBy = intOrUndefined(pick(work, 'cited_by_count'));
  if (citedBy !== undefined) extra.citedByCount = citedBy;
  /*
   * 撤稿标记。
   *
   * OpenAlex 是六家里唯一在标准字段里给这个的。落进 extra 并在导出与引用核实
   * 时显式检查——引用一篇撤稿文献是审稿必退的问题，而它在正常的书目字段里
   * 完全看不出来。
   */
  if (pick(work, 'is_retracted') === true) extra.retracted = true;
  if (pick(work, 'is_paratext') === true) extra.paratext = true;
  const oaStatus = str(pick(work, 'open_access', 'oa_status'));
  if (oaStatus !== undefined) extra.oaStatus = oaStatus;
  if (pick(work, 'open_access', 'is_oa') === true) extra.isOpenAccess = true;
  const oaUrl =
    str(pick(work, 'best_oa_location', 'pdf_url')) ?? str(pick(work, 'open_access', 'oa_url'));
  if (oaUrl !== undefined) extra.oaUrl = oaUrl;
  const pdfUrl = str(pick(work, 'primary_location', 'pdf_url'));
  if (pdfUrl !== undefined) extra.pdfUrl = pdfUrl;
  const license = str(pick(work, 'best_oa_location', 'license'));
  if (license !== undefined) extra.license = license;
  const issnL = str(pick(work, 'primary_location', 'source', 'issn_l'));
  const issn =
    stringList(pick(work, 'primary_location', 'source', 'issn')) ??
    (issnL === undefined ? undefined : [issnL]);
  const topics = arr(pick(work, 'topics'))
    .map((t) => str(pick(t, 'display_name')))
    .filter((x): x is string => x !== undefined)
    .slice(0, 6);
  if (topics.length > 0) extra.topics = topics;

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title,
      'container-title': container,
      author: authors.length === 0 ? undefined : authors,
      issued,
      volume: str(pick(work, 'biblio', 'volume')),
      issue: str(pick(work, 'biblio', 'issue')),
      page,
      publisher: str(pick(work, 'primary_location', 'source', 'host_organization_name')),
      DOI: doi ?? undefined,
      URL: str(pick(work, 'primary_location', 'landing_page_url')),
      PMID: pmid ?? undefined,
      PMCID: pmcid ?? undefined,
      ISSN: issn,
      abstract,
      language: str(pick(work, 'language')),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? `openalex:${title ?? 'unknown'}`,
  );
}

export async function openAlexByDoi(doi: string, options: HttpOptions = {}): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'openalex',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }
  const url = withMailto(
    new URL(`https://api.openalex.org/works/doi:${normalized}`),
    options,
  ).toString();

  const res = await httpJson(url, options);
  if (!res.ok) return fail('openalex', url, res);

  const item = openAlexToCsl(res.json);
  if (item === null) return empty('openalex', url, 'OpenAlex 返回的记录缺少标题与 DOI');
  return { source: 'openalex', ok: true, item, reason: null, url, status: res.status };
}

export async function openAlexSearch(
  query: { title?: string; free?: string; year?: number; rows?: number },
  options: HttpOptions = {},
): Promise<SourceSearchResult> {
  const url = new URL('https://api.openalex.org/works');
  const filters: string[] = [];
  if (query.title !== undefined) filters.push(`title.search:${query.title}`);
  if (query.year !== undefined) filters.push(`publication_year:${String(query.year)}`);
  if (filters.length > 0) url.searchParams.set('filter', filters.join(','));
  if (query.free !== undefined) url.searchParams.set('search', query.free);
  url.searchParams.set('per-page', String(Math.max(1, Math.min(query.rows ?? 5, 25))));
  withMailto(url, options);

  const href = url.toString();
  const res = await httpJson(href, options);
  if (!res.ok) return failSearch('openalex', href, res);

  const candidates: SourceCandidate[] = [];
  for (const raw of arr(pick(res.json, 'results'))) {
    const item = openAlexToCsl(raw);
    if (item === null) continue;
    const score = pick(raw, 'relevance_score');
    candidates.push({ source: 'openalex', item, score: typeof score === 'number' ? score : null });
  }

  return {
    source: 'openalex',
    ok: true,
    candidates,
    reason: null,
    url: href,
    total: intOrUndefined(pick(res.json, 'meta', 'count')) ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Semantic Scholar
 * ------------------------------------------------------------------ */

const S2_FIELDS = [
  'title',
  'abstract',
  'venue',
  'publicationVenue',
  'year',
  'publicationDate',
  'authors.name',
  'authors.authorId',
  'externalIds',
  'openAccessPdf',
  'publicationTypes',
  'journal',
  'citationCount',
  'referenceCount',
  'influentialCitationCount',
  'fieldsOfStudy',
  'tldr',
  'isOpenAccess',
].join(',');

const S2_TYPE: Readonly<Record<string, CslType>> = {
  JournalArticle: 'article-journal',
  Conference: 'paper-conference',
  Review: 'review',
  Book: 'book',
  BookSection: 'chapter',
  Dataset: 'dataset',
  Editorial: 'article-journal',
  LettersAndComments: 'article-journal',
  News: 'article-newspaper',
  Study: 'article-journal',
  CaseReport: 'article-journal',
  ClinicalTrial: 'article-journal',
  Thesis: 'thesis',
};

export function semanticScholarToCsl(paper: unknown): CslItem | null {
  const doi = normalizeDoi(str(pick(paper, 'externalIds', 'DOI')));
  const title = str(pick(paper, 'title'));
  if (doi === null && title === undefined) return null;

  // publicationTypes 是数组且可能多值。取第一个能映射的；Review 优先于
  // JournalArticle（一篇综述同时被标成两者，而引用格式上综述是更准确的描述）
  const types = arr(pick(paper, 'publicationTypes'))
    .map((t) => str(t))
    .filter((x): x is string => x !== undefined);
  const type: CslType =
    (types.includes('Review') ? S2_TYPE.Review : undefined) ??
    types.map((t) => S2_TYPE[t]).find((t): t is CslType => t !== undefined) ??
    'article-journal';

  const authors: CslName[] = [];
  for (const a of arr(pick(paper, 'authors'))) {
    const name = str(pick(a, 'name'));
    if (name === undefined) continue;
    authors.push(splitDisplayName(name));
  }

  const pubDate = str(pick(paper, 'publicationDate'));
  const year = intOrUndefined(pick(paper, 'year'));
  let issued = dateParts(year);
  if (pubDate !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(pubDate);
    if (m !== null) issued = dateParts(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  const container =
    str(pick(paper, 'journal', 'name')) ??
    str(pick(paper, 'publicationVenue', 'name')) ??
    str(pick(paper, 'venue'));

  const pmid = normalizePmid(str(pick(paper, 'externalIds', 'PubMed')));
  const pmcid = normalizePmcid(str(pick(paper, 'externalIds', 'PubMedCentral')));
  const arxiv = normalizeArxivId(str(pick(paper, 'externalIds', 'ArXiv')));

  const extra: Record<string, unknown> = {};
  const corpusId = pick(paper, 'externalIds', 'CorpusId');
  if (corpusId !== undefined) extra.s2CorpusId = String(corpusId);
  const citedBy = intOrUndefined(pick(paper, 'citationCount'));
  if (citedBy !== undefined) extra.citedByCount = citedBy;
  const influential = intOrUndefined(pick(paper, 'influentialCitationCount'));
  if (influential !== undefined) extra.influentialCitationCount = influential;
  const refCount = intOrUndefined(pick(paper, 'referenceCount'));
  if (refCount !== undefined) extra.referenceCount = refCount;
  const tldr = str(pick(paper, 'tldr', 'text'));
  // tldr 是模型生成的一句话总结。标注来源，否则它会被当成作者写的摘要
  if (tldr !== undefined) extra.tldr = tldr;
  const oaPdf = str(pick(paper, 'openAccessPdf', 'url'));
  if (oaPdf !== undefined) extra.oaUrl = oaPdf;
  if (pick(paper, 'isOpenAccess') === true) extra.isOpenAccess = true;
  const fields = stringList(pick(paper, 'fieldsOfStudy'));
  if (fields !== undefined) extra.fieldsOfStudy = fields;
  if (arxiv !== null) extra.arxivId = arxiv;
  if (types.length > 0) extra.s2PublicationTypes = types;

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title,
      'container-title': container,
      author: authors.length === 0 ? undefined : authors,
      issued,
      volume: str(pick(paper, 'journal', 'volume')),
      page: str(pick(paper, 'journal', 'pages')),
      DOI: doi ?? undefined,
      PMID: pmid ?? undefined,
      PMCID: pmcid ?? undefined,
      abstract: cleanAbstract(pick(paper, 'abstract')),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? `s2:${title ?? 'unknown'}`,
  );
}

export async function semanticScholarByDoi(
  doi: string,
  options: HttpOptions = {},
): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'semanticscholar',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(normalized)}?fields=${S2_FIELDS}`;
  const res = await httpJson(url, options);
  if (!res.ok) return fail('semanticscholar', url, res);

  const item = semanticScholarToCsl(res.json);
  if (item === null)
    return empty('semanticscholar', url, 'Semantic Scholar 返回的记录缺少标题与 DOI');
  return { source: 'semanticscholar', ok: true, item, reason: null, url, status: res.status };
}

export async function semanticScholarSearch(
  query: { text: string; year?: number; rows?: number },
  options: HttpOptions = {},
): Promise<SourceSearchResult> {
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', query.text);
  url.searchParams.set('fields', S2_FIELDS);
  url.searchParams.set('limit', String(Math.max(1, Math.min(query.rows ?? 5, 20))));
  if (query.year !== undefined) url.searchParams.set('year', String(query.year));

  const href = url.toString();
  const res = await httpJson(href, options);
  if (!res.ok) return failSearch('semanticscholar', href, res);

  const candidates: SourceCandidate[] = [];
  for (const raw of arr(pick(res.json, 'data'))) {
    const item = semanticScholarToCsl(raw);
    if (item !== null) candidates.push({ source: 'semanticscholar', item, score: null });
  }

  return {
    source: 'semanticscholar',
    ok: true,
    candidates,
    reason: null,
    url: href,
    total: intOrUndefined(pick(res.json, 'total')) ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * PubMed（NCBI E-utilities）
 * ------------------------------------------------------------------ */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** NCBI 的公共参数。带上 tool 与 email 是它礼节说明的要求。 */
function eutilsParams(url: URL, options: HttpOptions & { ncbiApiKey?: string | null }): URL {
  url.searchParams.set('tool', 'L-science');
  const mailto = options.mailto ?? null;
  if (mailto !== null && mailto.trim() !== '') url.searchParams.set('email', mailto.trim());
  const key = options.ncbiApiKey ?? null;
  if (key !== null && key.trim() !== '') url.searchParams.set('api_key', key.trim());
  return url;
}

/**
 * esummary 的作者名是 `Smith JB` 这种形式（姓 + 首字母缩写）。
 *
 * 拆法：最后一段全大写且长度 ≤4 时视为缩写，其余为姓。这条规则会在少数复姓与
 * 全大写姓氏上出错（`WHO`），因此机构作者（authtype 为 CollectiveName）在
 * 调用处直接走 literal，不进这个函数。
 */
function pubmedName(raw: string): CslName {
  const cleaned = raw.trim().replace(/\s+/gu, ' ');
  if (cleaned === '') return {};
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { family: cleaned };
  const last = parts[parts.length - 1] ?? '';
  if (/^[A-Z]{1,4}$/u.test(last)) {
    return {
      family: parts.slice(0, -1).join(' '),
      // 缩写补上点号：`JB` → `J. B.`，否则引用输出里会是「Smith, JB」
      given: last
        .split('')
        .map((c) => `${c}.`)
        .join(' '),
    };
  }
  return { family: last, given: parts.slice(0, -1).join(' ') };
}

/** PubMed 的月份缩写。pubdate 形如 `2023 May 12` 或 `2023 May` 或 `2023`。 */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function parsePubmedDate(raw: string | undefined): ReturnType<typeof dateParts> {
  if (raw === undefined) return undefined;
  const m = /^(\d{4})(?:\s+([A-Za-z]{3})[a-z]*)?(?:\s+(\d{1,2}))?/u.exec(raw.trim());
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = m[2] === undefined ? undefined : MONTHS[m[2].toLowerCase()];
  const day = m[3] === undefined ? undefined : Number(m[3]);
  return dateParts(year, month, day);
}

const PUBMED_TYPE: Readonly<Record<string, CslType>> = {
  'journal article': 'article-journal',
  review: 'review',
  'systematic review': 'review',
  'meta-analysis': 'review',
  'randomized controlled trial': 'article-journal',
  'clinical trial': 'article-journal',
  editorial: 'article-journal',
  letter: 'article-journal',
  comment: 'article-journal',
  preprint: 'article',
  'case reports': 'article-journal',
  'book chapter': 'chapter',
};

export function pubmedSummaryToCsl(entry: unknown): CslItem | null {
  const title = str(pick(entry, 'title'));
  const pmid = normalizePmid(str(pick(entry, 'uid')));
  if (title === undefined && pmid === null) return null;

  let doi: string | null = null;
  let pmcid: string | null = null;
  for (const idEntry of arr(pick(entry, 'articleids'))) {
    const kind = str(pick(idEntry, 'idtype'))?.toLowerCase();
    const value = str(pick(idEntry, 'value'));
    if (value === undefined) continue;
    if (kind === 'doi') doi = normalizeDoi(value);
    else if (kind === 'pmc') pmcid = normalizePmcid(value);
  }
  // elocationid 里也可能有 DOI（`doi: 10.1234/x`），articleids 缺失时兜底
  if (doi === null) doi = normalizeDoi(str(pick(entry, 'elocationid')));

  const authors: CslName[] = [];
  for (const a of arr(pick(entry, 'authors'))) {
    const name = str(pick(a, 'name'));
    if (name === undefined) continue;
    const authType = str(pick(a, 'authtype'))?.toLowerCase();
    authors.push(authType === 'collectivename' ? { literal: name } : pubmedName(name));
  }

  const pubTypes = arr(pick(entry, 'pubtype'))
    .map((t) => str(t))
    .filter((x): x is string => x !== undefined);
  /*
   * PubMed 的 pubtype 是多值且几乎总以 `Journal Article` 开头。
   *
   * 一篇综述会同时被标成 `Journal Article` 与 `Review`，按数组顺序取第一个能映射的
   * 会永远得到 article-journal。综述在引用格式与证据等级上都是更准确的描述，因此
   * 与 Semantic Scholar 那边保持一致：review 优先。
   */
  const lowered = pubTypes.map((t) => t.toLowerCase());
  const type: CslType = lowered.some((t) => t.includes('review') || t.includes('meta-analysis'))
    ? 'review'
    : (lowered.map((t) => PUBMED_TYPE[t]).find((t): t is CslType => t !== undefined) ??
      'article-journal');

  // epubdate 优先于 pubdate：电子首发日期更接近「什么时候可以读到」，
  // 而 pubdate 在很多期刊上是纸版的卷期日期（可能晚一年）
  const issued =
    parsePubmedDate(str(pick(entry, 'epubdate'))) ?? parsePubmedDate(str(pick(entry, 'pubdate')));

  const extra: Record<string, unknown> = {};
  if (pubTypes.length > 0) extra.pubmedTypes = pubTypes;
  const issn = str(pick(entry, 'issn'));
  const essn = str(pick(entry, 'essn'));
  const issnList = [issn, essn].filter((x): x is string => x !== undefined);

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title: title === undefined ? undefined : title.replace(/\.$/u, ''),
      'container-title': str(pick(entry, 'fulljournalname')),
      'container-title-short': str(pick(entry, 'source')),
      author: authors.length === 0 ? undefined : authors,
      issued,
      volume: str(pick(entry, 'volume')),
      issue: str(pick(entry, 'issue')),
      page: str(pick(entry, 'pages')),
      DOI: doi ?? undefined,
      PMID: pmid ?? undefined,
      PMCID: pmcid ?? undefined,
      ISSN: issnList.length === 0 ? undefined : issnList,
      language: str(pick(entry, 'lang', 0)),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? (pmid === null ? `pubmed:${title ?? 'unknown'}` : `pmid:${pmid}`),
  );
}

export interface PubmedOptions extends HttpOptions {
  ncbiApiKey?: string | null;
}

/** 按 PMID 取摘要记录。 */
export async function pubmedByPmid(
  pmid: string,
  options: PubmedOptions = {},
): Promise<SourceResult> {
  const normalized = normalizePmid(pmid);
  if (normalized === null) {
    return {
      source: 'pubmed',
      ok: false,
      item: null,
      reason: `不是合法 PMID：${pmid}`,
      url: '',
      status: null,
    };
  }
  const url = eutilsParams(new URL(`${EUTILS}/esummary.fcgi`), options).toString();
  const withId = `${url}&db=pubmed&retmode=json&id=${normalized}`;

  const res = await httpJson(withId, options);
  if (!res.ok) return fail('pubmed', withId, res);

  const entry = pick(res.json, 'result', normalized);
  // NCBI 对不存在的 id 返回 200 加一个 error 字段，而不是 404
  const errorText = str(pick(entry, 'error'));
  if (errorText !== undefined) return empty('pubmed', withId, `PubMed：${errorText}`);

  const item = pubmedSummaryToCsl(entry);
  if (item === null) return empty('pubmed', withId, `PubMed 没有 PMID ${normalized} 的记录`);
  return { source: 'pubmed', ok: true, item, reason: null, url: withId, status: res.status };
}

/** 按 DOI 解析：先 esearch 找 PMID 再 esummary。 */
export async function pubmedByDoi(doi: string, options: PubmedOptions = {}): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'pubmed',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }

  const searchUrl = eutilsParams(new URL(`${EUTILS}/esearch.fcgi`), options);
  searchUrl.searchParams.set('db', 'pubmed');
  searchUrl.searchParams.set('retmode', 'json');
  searchUrl.searchParams.set('term', `${normalized}[DOI]`);
  const href = searchUrl.toString();

  const res = await httpJson(href, options);
  if (!res.ok) return fail('pubmed', href, res);

  const ids = arr(pick(res.json, 'esearchresult', 'idlist'))
    .map((x) => normalizePmid(str(x)))
    .filter((x): x is string => x !== null);

  if (ids.length === 0) {
    return empty('pubmed', href, `PubMed 里没有 DOI ${normalized} 的记录（非生物医学文献很常见）`);
  }
  return pubmedByPmid(ids[0] as string, options);
}

/* ------------------------------------------------------------------ *
 * Europe PMC
 * ------------------------------------------------------------------ */

const EPMC_TYPE: Readonly<Record<string, CslType>> = {
  'journal article': 'article-journal',
  review: 'review',
  preprint: 'article',
  'book chapter': 'chapter',
  book: 'book',
};

export function europePmcToCsl(result: unknown): CslItem | null {
  const doi = normalizeDoi(str(pick(result, 'doi')));
  const title = str(pick(result, 'title'));
  if (doi === null && title === undefined) return null;

  const pmid = normalizePmid(str(pick(result, 'pmid')));
  const pmcid = normalizePmcid(str(pick(result, 'pmcid')));

  const authors: CslName[] = [];
  for (const a of arr(pick(result, 'authorList', 'author'))) {
    const literal = str(pick(a, 'collectiveName'));
    if (literal !== undefined) {
      authors.push({ literal });
      continue;
    }
    const family = str(pick(a, 'lastName'));
    const initials = str(pick(a, 'initials'));
    const given =
      str(pick(a, 'firstName')) ??
      (initials === undefined
        ? undefined
        : initials
            .split('')
            .map((c) => `${c}.`)
            .join(' '));
    if (family === undefined && given === undefined) {
      const fullName = str(pick(a, 'fullName'));
      if (fullName !== undefined) authors.push(pubmedName(fullName));
      continue;
    }
    authors.push({
      ...(family === undefined ? {} : { family }),
      ...(given === undefined ? {} : { given }),
    });
  }

  const year = intOrUndefined(pick(result, 'pubYear'));
  const firstPub = str(pick(result, 'firstPublicationDate'));
  let issued = dateParts(year);
  if (firstPub !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(firstPub);
    if (m !== null) issued = dateParts(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  const rawType = str(pick(result, 'pubType'))?.toLowerCase() ?? '';
  const type: CslType =
    Object.entries(EPMC_TYPE).find(([key]) => rawType.includes(key))?.[1] ?? 'article-journal';

  const extra: Record<string, unknown> = {};
  const epmcId = str(pick(result, 'id'));
  const epmcSource = str(pick(result, 'source'));
  if (epmcId !== undefined && epmcSource !== undefined) {
    extra.europePmcId = `${epmcSource}:${epmcId}`;
  }
  if (str(pick(result, 'isOpenAccess')) === 'Y') extra.isOpenAccess = true;
  if (str(pick(result, 'inEPMC')) === 'Y') extra.inEuropePmc = true;
  if (str(pick(result, 'inPMC')) === 'Y') extra.inPubmedCentral = true;
  if (str(pick(result, 'hasPDF')) === 'Y') extra.hasPdf = true;
  if (str(pick(result, 'hasSuppl')) === 'Y') extra.hasSupplement = true;
  /*
   * 全文可得形式。
   *
   * `fullTextIdList` 与 `textMinedTerms` 之外，Europe PMC 还给 `hasTextMinedTerms`
   * 等一串 Y/N 标记。这里只留 13.2 的抓取链要用的：能不能拿到 XML、能不能拿到 PDF。
   */
  const availability = arr(pick(result, 'fullTextIdList', 'fullTextId'))
    .map((x) => str(x))
    .filter((v): v is string => v !== undefined);
  if (availability.length > 0) extra.fullTextIds = availability;
  const citedBy = intOrUndefined(pick(result, 'citedByCount'));
  if (citedBy !== undefined) extra.citedByCount = citedBy;

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title: title === undefined ? undefined : title.replace(/\.$/u, ''),
      'container-title': str(pick(result, 'journalInfo', 'journal', 'title')),
      'container-title-short': str(pick(result, 'journalTitle')),
      author: authors.length === 0 ? undefined : authors,
      issued,
      volume: str(pick(result, 'journalInfo', 'volume')),
      issue: str(pick(result, 'journalInfo', 'issue')),
      page: str(pick(result, 'pageInfo')),
      DOI: doi ?? undefined,
      PMID: pmid ?? undefined,
      PMCID: pmcid ?? undefined,
      abstract: cleanAbstract(pick(result, 'abstractText')),
      language: str(pick(result, 'language')),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? (pmid === null ? `epmc:${title ?? 'unknown'}` : `pmid:${pmid}`),
  );
}

const EPMC_SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/**
 * Europe PMC 检索。
 *
 * `resultType=core` 才会带摘要、作者全名与全文可得性标记；默认的 lite 只有
 * 标题与几个 id，不够用。
 */
export async function europePmcQuery(
  query: string,
  options: HttpOptions & { rows?: number } = {},
): Promise<SourceSearchResult> {
  const url = new URL(EPMC_SEARCH);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('resultType', 'core');
  url.searchParams.set('pageSize', String(Math.max(1, Math.min(options.rows ?? 5, 25))));

  const href = url.toString();
  const res = await httpJson(href, options);
  if (!res.ok) return failSearch('europepmc', href, res);

  const candidates: SourceCandidate[] = [];
  for (const raw of arr(pick(res.json, 'resultList', 'result'))) {
    const item = europePmcToCsl(raw);
    if (item !== null) candidates.push({ source: 'europepmc', item, score: null });
  }

  return {
    source: 'europepmc',
    ok: true,
    candidates,
    reason: null,
    url: href,
    total: intOrUndefined(pick(res.json, 'hitCount')) ?? null,
  };
}

export async function europePmcByDoi(
  doi: string,
  options: HttpOptions = {},
): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'europepmc',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }
  const search = await europePmcQuery(`DOI:"${normalized}"`, { ...options, rows: 3 });
  if (!search.ok) {
    return {
      source: 'europepmc',
      ok: false,
      item: null,
      reason: search.reason,
      url: search.url,
      status: null,
    };
  }
  // 精确到 DOI 的查询仍可能返回多条（同一文献的 preprint 与正式版）。
  // 取 DOI 真的相等的那条，而不是第一条
  const exact =
    search.candidates.find((c) => c.item.DOI === normalized) ?? search.candidates[0] ?? null;
  if (exact === null) {
    return empty('europepmc', search.url, `Europe PMC 里没有 DOI ${normalized} 的记录`);
  }
  return {
    source: 'europepmc',
    ok: true,
    item: exact.item,
    reason: null,
    url: search.url,
    status: 200,
  };
}

/* ------------------------------------------------------------------ *
 * DataCite
 * ------------------------------------------------------------------ */

const DATACITE_TYPE: Readonly<Record<string, CslType>> = {
  Dataset: 'dataset',
  Software: 'software',
  Text: 'document',
  JournalArticle: 'article-journal',
  Preprint: 'article',
  ConferencePaper: 'paper-conference',
  Book: 'book',
  BookChapter: 'chapter',
  Dissertation: 'thesis',
  Report: 'report',
  Standard: 'standard',
  Collection: 'dataset',
  Image: 'document',
  Other: 'document',
};

export function dataCiteToCsl(data: unknown): CslItem | null {
  const attrs = pick(data, 'attributes') ?? data;
  const doi = normalizeDoi(str(pick(attrs, 'doi')));
  const title = firstString(arr(pick(attrs, 'titles')).map((t) => pick(t, 'title')));
  if (doi === null && title === undefined) return null;

  const resourceType =
    str(pick(attrs, 'types', 'resourceTypeGeneral')) ?? str(pick(attrs, 'types', 'schemaOrg'));
  const citeprocType = str(pick(attrs, 'types', 'citeproc'));
  const type: CslType =
    (citeprocType !== undefined && citeprocType in DATACITE_TYPE
      ? DATACITE_TYPE[citeprocType]
      : undefined) ??
    (resourceType === undefined ? undefined : DATACITE_TYPE[resourceType]) ??
    'dataset';

  const authors: CslName[] = [];
  for (const c of arr(pick(attrs, 'creators'))) {
    const family = str(pick(c, 'familyName'));
    const given = str(pick(c, 'givenName'));
    if (family !== undefined || given !== undefined) {
      authors.push({
        ...(family === undefined ? {} : { family }),
        ...(given === undefined ? {} : { given }),
      });
      continue;
    }
    const name = str(pick(c, 'name'));
    if (name === undefined) continue;
    const nameType = str(pick(c, 'nameType'));
    authors.push(
      nameType === 'Organizational'
        ? { literal: name }
        : name.includes(',')
          ? {
              family: name.split(',')[0]?.trim() ?? name,
              given: name.split(',').slice(1).join(',').trim(),
            }
          : splitDisplayName(name),
    );
  }

  const year = intOrUndefined(pick(attrs, 'publicationYear'));
  const extra: Record<string, unknown> = {};
  const version = str(pick(attrs, 'version'));
  if (version !== undefined) extra.version = version;
  const repo = str(pick(attrs, 'publisher')) ?? str(pick(attrs, 'publisher', 'name'));
  const rights = firstString(arr(pick(attrs, 'rightsList')).map((r) => pick(r, 'rights')));
  if (rights !== undefined) extra.license = rights;
  if (resourceType !== undefined) extra.dataCiteType = resourceType;

  return ensureCsl(
    compact<Partial<CslItem>>({
      type,
      title,
      author: authors.length === 0 ? undefined : authors,
      issued: dateParts(year),
      publisher: repo,
      DOI: doi ?? undefined,
      URL: str(pick(attrs, 'url')),
      abstract: cleanAbstract(
        firstString(arr(pick(attrs, 'descriptions')).map((d) => pick(d, 'description'))),
      ),
      extra: Object.keys(extra).length === 0 ? undefined : extra,
    }),
    doi ?? `datacite:${title ?? 'unknown'}`,
  );
}

export async function dataCiteByDoi(doi: string, options: HttpOptions = {}): Promise<SourceResult> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      source: 'datacite',
      ok: false,
      item: null,
      reason: `不是合法 DOI：${doi}`,
      url: '',
      status: null,
    };
  }
  const url = `https://api.datacite.org/dois/${encodeURIComponent(normalized)}`;
  const res = await httpJson(url, options);
  if (!res.ok) return fail('datacite', url, res);

  const item = dataCiteToCsl(pick(res.json, 'data'));
  if (item === null) return empty('datacite', url, 'DataCite 返回的记录缺少标题与 DOI');
  return { source: 'datacite', ok: true, item, reason: null, url, status: res.status };
}
