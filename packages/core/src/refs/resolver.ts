/**
 * 多源元数据解析（任务 13.1，需求 12.1）。
 *
 * 六家上游**并行**发起而不是依次尝试。它们是不同主机，限速器按主机排队，因此
 * 并行不会加剧任何一家的压力；而依次尝试的最坏情况是六个 20 秒超时叠加成两分钟，
 * 那时用户已经认为功能坏了。
 *
 * 拿到多个成功结果之后合并而不是取第一个（`mergeAll`）。六家的字段完备度是互补的：
 * Crossref 有页码与 ISSN，OpenAlex 有完整作者列表与撤稿标记，Semantic Scholar 有
 * 摘要与影响力被引数，Europe PMC 有全文可得性，PubMed 有出版类型。取第一个成功的
 * 会让最终记录的质量取决于哪家先响应——那是随机的。
 */

import type { CslItem } from './csl.js';
import { normalizeArxivId, normalizeDoi, normalizePmcid, normalizePmid } from './csl.js';
import { mergeAll } from './dedupe.js';
import type { HttpOptions, RefSourceId } from './http.js';
import { HostRateLimiter, httpJson } from './http.js';
import type {
  PubmedOptions,
  SourceCandidate,
  SourceResult,
  SourceSearchResult,
} from './sources.js';
import {
  crossrefByDoi,
  crossrefSearch,
  dataCiteByDoi,
  europePmcByDoi,
  europePmcQuery,
  openAlexByDoi,
  openAlexSearch,
  pubmedByDoi,
  pubmedByPmid,
  semanticScholarByDoi,
  semanticScholarSearch,
  semanticScholarToCsl,
} from './sources.js';

/**
 * DOI 解析的默认顺序。
 *
 * 顺序只在同分时决定优先级（`mergeAll` 以完备度打分为主），因此这里排的是
 * 「字段最规范的在前」：Crossref 是 DOI 的注册机构之一，它的书目字段是权威的；
 * DataCite 排最后是因为绝大多数期刊 DOI 不在它那里，它主要救数据集与软件。
 */
/** 需要补全字段或对照多家时显式传入。日常入库默认只走 Crossref。 */
export const ALL_DOI_SOURCES: readonly RefSourceId[] = [
  'crossref',
  'openalex',
  'europepmc',
  'semanticscholar',
  'pubmed',
  'datacite',
];

export const DEFAULT_DOI_SOURCES: readonly RefSourceId[] = ['crossref'];

export interface ResolveOptions extends PubmedOptions {
  /** 尝试哪些上游。省略用 `DEFAULT_DOI_SOURCES`。 */
  sources?: readonly RefSourceId[];
  /**
   * 只取第一个成功结果。
   *
   * 默认 false。开启后按 `sources` 顺序**依次**尝试并在第一个成功时停止——用于
   * 批量导入几百条时省流量，代价是元数据完备度下降。
   */
  firstOnly?: boolean;
  limiter?: HostRateLimiter;
}

export interface ResolveReport {
  ok: boolean;
  item: CslItem | null;
  /** 每家上游的结果，成功与失败都在。需求 12.6 的「不得静默跳过」也适用于元数据解析。 */
  attempts: readonly SourceResult[];
  /** 参与合并的上游。 */
  merged: readonly RefSourceId[];
  /** 全部失败时的汇总原因。 */
  reason: string | null;
}

/** 六家上游各自的 DOI 解析函数。 */
const DOI_RESOLVERS: Readonly<
  Record<RefSourceId, ((doi: string, options: ResolveOptions) => Promise<SourceResult>) | undefined>
> = {
  crossref: (doi, options) => crossrefByDoi(doi, options),
  openalex: (doi, options) => openAlexByDoi(doi, options),
  semanticscholar: (doi, options) => semanticScholarByDoi(doi, options),
  pubmed: (doi, options) => pubmedByDoi(doi, options),
  europepmc: (doi, options) => europePmcByDoi(doi, options),
  datacite: (doi, options) => dataCiteByDoi(doi, options),
  arxiv: undefined,
  unpaywall: undefined,
  openaire: undefined,
};

function summarize(attempts: readonly SourceResult[]): string {
  if (attempts.length === 0) return '没有可用的上游';
  return attempts.map((a) => `${a.source}：${a.ok ? '成功' : (a.reason ?? '失败')}`).join('\n');
}

/** 共享一个限速器，否则每次调用各自排队，等于没有限速。 */
const SHARED_LIMITER = new HostRateLimiter();

function withLimiter(options: ResolveOptions): ResolveOptions {
  return { ...options, limiter: options.limiter ?? SHARED_LIMITER };
}

/**
 * 按 DOI 解析。
 *
 * 永不抛异常：任一上游抛出都会被它自己的函数收成 `ok: false`，这里再收成
 * `ResolveReport`。调用方拿到 `ok: false` 时 `attempts` 里有每一家的原因，
 * 可以据此告诉用户「Crossref 说没有这条记录，PubMed 超时了」而不是「解析失败」。
 */
export async function resolveByDoi(
  doi: string,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const normalized = normalizeDoi(doi);
  if (normalized === null) {
    return {
      ok: false,
      item: null,
      attempts: [],
      merged: [],
      reason:
        `「${doi}」不是合法的 DOI。DOI 的形式是 10.<四到九位数字>/<后缀>，` +
        '例如 10.1038/s41586-021-03819-2。如果这是一个标题，请改用标题检索。',
    };
  }

  const opts = withLimiter(options);
  const order = options.sources ?? DEFAULT_DOI_SOURCES;
  const attempts: SourceResult[] = [];

  if (options.firstOnly === true) {
    for (const source of order) {
      const resolver = DOI_RESOLVERS[source];
      if (resolver === undefined) continue;
      const result = await resolver(normalized, opts);
      attempts.push(result);
      if (result.ok && result.item !== null) {
        return { ok: true, item: result.item, attempts, merged: [source], reason: null };
      }
    }
  } else {
    const settled = await Promise.all(
      order.map(async (source): Promise<SourceResult> => {
        const resolver = DOI_RESOLVERS[source];
        if (resolver === undefined) {
          return {
            source,
            ok: false,
            item: null,
            reason: '该上游不支持按 DOI 解析',
            url: '',
            status: null,
          };
        }
        try {
          return await resolver(normalized, opts);
        } catch (err) {
          // 上游函数按约定不抛，但真抛了也不能让整次解析失败：另外五家可能都成功了
          return {
            source,
            ok: false,
            item: null,
            reason: `上游解析函数异常：${err instanceof Error ? err.message : String(err)}`,
            url: '',
            status: null,
          };
        }
      }),
    );
    attempts.push(...settled);
  }

  const items = attempts.filter((a) => a.ok && a.item !== null).map((a) => a.item as CslItem);

  if (items.length === 0) {
    return {
      ok: false,
      item: null,
      attempts,
      merged: [],
      reason: `DOI ${normalized} 在全部 ${String(attempts.length)} 家上游都没能解析：\n${summarize(attempts)}`,
    };
  }

  /*
   * 排序后再合并，让 `mergeAll` 的「同分取靠前」与声明的优先级一致。
   *
   * attempts 是并行完成的，数组顺序等于 `order`（Promise.all 保序），因此这里
   * 只需要按 order 过滤即可，不用重排。
   */
  const merged = mergeAll(items);
  if (merged === null) {
    return {
      ok: false,
      item: null,
      attempts,
      merged: [],
      reason: '上游返回了记录但都缺少标题与 DOI，无法使用',
    };
  }

  // 合并结果的 DOI 必须是请求的那个。某些上游（Europe PMC 的模糊命中）可能
  // 返回相关但不同的文献，让它覆盖掉请求的 DOI 会让库里出现一条张冠李戴的记录
  const withDoi: CslItem = { ...merged, DOI: normalized, id: normalized };

  return {
    ok: true,
    item: withDoi,
    attempts,
    merged: attempts.filter((a) => a.ok).map((a) => a.source),
    reason: null,
  };
}

/** 按 PMID 解析。PubMed 拿到 DOI 之后再走一遍多源，补齐其余字段。 */
export async function resolveByPmid(
  pmid: string,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const normalized = normalizePmid(pmid);
  if (normalized === null) {
    return {
      ok: false,
      item: null,
      attempts: [],
      merged: [],
      reason: `「${pmid}」不是合法的 PMID（应为纯数字）`,
    };
  }

  const opts = withLimiter(options);
  const first = await pubmedByPmid(normalized, opts);
  if (!first.ok || first.item === null) {
    return {
      ok: false,
      item: null,
      attempts: [first],
      merged: [],
      reason: first.reason ?? `PMID ${normalized} 解析失败`,
    };
  }

  const doi = normalizeDoi(first.item.DOI);
  if (doi === null) {
    // 老文献常常没有 DOI。PubMed 这一份就是全部能拿到的，如实返回
    return { ok: true, item: first.item, attempts: [first], merged: ['pubmed'], reason: null };
  }

  const full = await resolveByDoi(doi, options);
  if (!full.ok || full.item === null) {
    return {
      ok: true,
      item: first.item,
      attempts: [first, ...full.attempts],
      merged: ['pubmed'],
      reason: null,
    };
  }

  const merged = mergeAll([full.item, first.item]);
  return {
    ok: true,
    item: merged ?? full.item,
    attempts: [first, ...full.attempts],
    merged: ['pubmed', ...full.merged.filter((s) => s !== 'pubmed')],
    reason: null,
  };
}

/** 按 PMCID 解析：Europe PMC 直接认它。 */
export async function resolveByPmcid(
  pmcid: string,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const normalized = normalizePmcid(pmcid);
  if (normalized === null) {
    return {
      ok: false,
      item: null,
      attempts: [],
      merged: [],
      reason: `「${pmcid}」不是合法的 PMCID（形如 PMC1234567）`,
    };
  }

  const search = await europePmcQuery(`PMCID:"${normalized}"`, {
    ...withLimiter(options),
    rows: 3,
  });
  const attempt: SourceResult = {
    source: 'europepmc',
    ok: search.ok && search.candidates.length > 0,
    item: search.candidates[0]?.item ?? null,
    reason: search.ok
      ? search.candidates.length > 0
        ? null
        : `Europe PMC 里没有 ${normalized}`
      : search.reason,
    url: search.url,
    status: null,
  };

  if (!attempt.ok || attempt.item === null) {
    return { ok: false, item: null, attempts: [attempt], merged: [], reason: attempt.reason };
  }

  const doi = normalizeDoi(attempt.item.DOI);
  if (doi === null) {
    return {
      ok: true,
      item: attempt.item,
      attempts: [attempt],
      merged: ['europepmc'],
      reason: null,
    };
  }

  const full = await resolveByDoi(doi, options);
  if (!full.ok || full.item === null) {
    return {
      ok: true,
      item: attempt.item,
      attempts: [attempt, ...full.attempts],
      merged: ['europepmc'],
      reason: null,
    };
  }
  const merged = mergeAll([full.item, attempt.item]);
  return {
    ok: true,
    item: merged ?? full.item,
    attempts: [attempt, ...full.attempts],
    merged: ['europepmc', ...full.merged.filter((s) => s !== 'europepmc')],
    reason: null,
  };
}

/* ------------------------------------------------------------------ *
 * 标识嗅探
 * ------------------------------------------------------------------ */

export type IdentifierKind = 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'title';

export interface SniffedIdentifier {
  kind: IdentifierKind;
  value: string;
}

/**
 * 判断用户/模型给的一串东西是什么。
 *
 * 顺序很重要。DOI 放在最前是因为 URL 里最常见的就是 DOI；PMID 放在纯数字之后
 * 是因为「2024」这种四位数字既可能是 PMID 也可能是年份，而把年份当 PMID 去查
 * 会返回一篇毫不相干的文献——那是最坏的失败形式，因为它看起来成功了。
 * 因此纯数字必须至少五位才当 PMID（PubMed 的 PMID 早已超过一千万）。
 */
export function sniffIdentifier(raw: string): SniffedIdentifier {
  const trimmed = raw.trim();

  const doi = normalizeDoi(trimmed);
  if (doi !== null) return { kind: 'doi', value: doi };

  // URL 里内嵌的 DOI：`https://www.nature.com/articles/...` 不含 DOI，但
  // `https://link.springer.com/article/10.1007/s00415-020-09974-2` 含
  const embedded = /10\.\d{4,9}\/[^\s"'<>]+/u.exec(trimmed);
  if (embedded !== null) {
    const candidate = normalizeDoi(embedded[0]);
    if (candidate !== null) return { kind: 'doi', value: candidate };
  }

  const pmcid = normalizePmcid(/pmc\d{4,9}/iu.exec(trimmed)?.[0] ?? trimmed);
  if (pmcid !== null && /pmc/iu.test(trimmed)) return { kind: 'pmcid', value: pmcid };

  const arxiv = normalizeArxivId(trimmed);
  if (arxiv !== null) return { kind: 'arxiv', value: arxiv };

  const pmidMatch = /^(?:pmid:?\s*)?(\d{5,9})$/iu.exec(trimmed);
  if (pmidMatch !== null) return { kind: 'pmid', value: pmidMatch[1] as string };

  const pubmedUrl = /pubmed(?:\.ncbi\.nlm\.nih\.gov)?\/(\d{5,9})/iu.exec(trimmed);
  if (pubmedUrl !== null) return { kind: 'pmid', value: pubmedUrl[1] as string };

  return { kind: 'title', value: trimmed };
}

/** 按嗅探结果解析。`title` 类不在这里处理（它要走检索并返回多个候选）。 */
export async function resolveIdentifier(
  raw: string,
  options: ResolveOptions = {},
): Promise<ResolveReport & { kind: IdentifierKind }> {
  const sniffed = sniffIdentifier(raw);
  switch (sniffed.kind) {
    case 'doi':
      return { ...(await resolveByDoi(sniffed.value, options)), kind: 'doi' };
    case 'pmid':
      return { ...(await resolveByPmid(sniffed.value, options)), kind: 'pmid' };
    case 'pmcid':
      return { ...(await resolveByPmcid(sniffed.value, options)), kind: 'pmcid' };
    case 'arxiv':
      return { ...(await resolveByArxiv(sniffed.value, options)), kind: 'arxiv' };
    default:
      return {
        ok: false,
        item: null,
        attempts: [],
        merged: [],
        reason:
          `「${raw}」看起来不是标识而是标题。请用标题检索（searchRefs），` +
          '它会返回多个候选让你确认是哪一篇，而不是猜一个。',
        kind: 'title',
      };
  }
}

/**
 * 按 arXiv 编号解析。
 *
 * arXiv 自己的接口返回 Atom XML，而 Semantic Scholar 直接认 arXiv 编号并返回
 * JSON。因此这里走 S2 而不是 arXiv：少一个 XML 解析器，且拿到的记录里带
 * 正式发表版的 DOI（如果有），可以顺势补齐。
 */
export async function resolveByArxiv(
  arxivId: string,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const normalized = normalizeArxivId(arxivId);
  if (normalized === null) {
    return {
      ok: false,
      item: null,
      attempts: [],
      merged: [],
      reason: `「${arxivId}」不是合法的 arXiv 编号`,
    };
  }

  const opts = withLimiter(options);
  const viaS2 = await semanticScholarByArxiv(normalized, opts);
  if (!viaS2.ok || viaS2.item === null) {
    return { ok: false, item: null, attempts: [viaS2], merged: [], reason: viaS2.reason };
  }

  const doi = normalizeDoi(viaS2.item.DOI);
  if (doi === null) {
    const item: CslItem = {
      ...viaS2.item,
      URL: viaS2.item.URL ?? `https://arxiv.org/abs/${normalized}`,
      extra: { ...(viaS2.item.extra ?? {}), arxivId: normalized },
    };
    return { ok: true, item, attempts: [viaS2], merged: ['semanticscholar'], reason: null };
  }

  const full = await resolveByDoi(doi, options);
  const base =
    full.ok && full.item !== null ? (mergeAll([full.item, viaS2.item]) ?? full.item) : viaS2.item;
  return {
    ok: true,
    item: { ...base, extra: { ...(base.extra ?? {}), arxivId: normalized } },
    attempts: [viaS2, ...full.attempts],
    merged: ['semanticscholar', ...full.merged.filter((s) => s !== 'semanticscholar')],
    reason: null,
  };
}

/**
 * Semantic Scholar 的 arXiv 入口。
 *
 * 走 S2 而不是 arXiv 官方接口，因为后者返回 Atom XML。字段清单单列一份而不是
 * 复用 `S2_FIELDS`：arXiv 记录上 `publicationVenue` 与 `isOpenAccess` 恒为空，
 * 请求它们只会让 URL 更长。
 */
async function semanticScholarByArxiv(
  arxivId: string,
  options: HttpOptions,
): Promise<SourceResult> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(arxivId)}?fields=${S2_ARXIV_FIELDS}`;
  const res = await httpJson(url, options);
  if (!res.ok) {
    return {
      source: 'semanticscholar',
      ok: false,
      item: null,
      reason: res.reason ?? '失败',
      url,
      status: res.status,
    };
  }
  const item = semanticScholarToCsl(res.json);
  if (item === null) {
    return {
      source: 'semanticscholar',
      ok: false,
      item: null,
      reason: `Semantic Scholar 里没有 arXiv:${arxivId}`,
      url,
      status: res.status,
    };
  }
  return { source: 'semanticscholar', ok: true, item, reason: null, url, status: res.status };
}

const S2_ARXIV_FIELDS = [
  'title',
  'abstract',
  'venue',
  'year',
  'publicationDate',
  'authors.name',
  'externalIds',
  'openAccessPdf',
  'publicationTypes',
  'journal',
  'citationCount',
  'tldr',
].join(',');

/* ------------------------------------------------------------------ *
 * 标题检索
 * ------------------------------------------------------------------ */

export interface SearchReport {
  ok: boolean;
  /** 跨源合并去重后的候选，按证据强度排序。 */
  candidates: readonly SourceCandidate[];
  attempts: readonly SourceSearchResult[];
  reason: string | null;
}

/** 检索用的上游。DataCite 不参与：数据集检索与文献检索是两件事。 */
export const DEFAULT_SEARCH_SOURCES: readonly RefSourceId[] = [
  'crossref',
  'openalex',
  'europepmc',
  'semanticscholar',
];

/**
 * 按书目信息检索。
 *
 * 这是引文核实（需求 13.9）的取证入口：模型给出一条它「记得」的引文，这里去
 * 四家上游找它到底存不存在。因此**不做任何猜测性归并**——候选原样返回，由
 * 调用方按相似度判定，并且在一条都找不到时明确说「找不到」。
 */
export async function searchRefs(
  query: { text: string; author?: string; year?: number; rows?: number },
  options: ResolveOptions = {},
): Promise<SearchReport> {
  const opts = withLimiter(options);
  const order = options.sources ?? DEFAULT_SEARCH_SOURCES;
  const rows = Math.max(1, Math.min(query.rows ?? 5, 20));

  const runners: Readonly<Record<string, (() => Promise<SourceSearchResult>) | undefined>> = {
    crossref: () =>
      crossrefSearch(
        {
          bibliographic: query.text,
          ...(query.author === undefined ? {} : { author: query.author }),
          ...(query.year === undefined ? {} : { year: query.year }),
          rows,
        },
        opts,
      ),
    openalex: () =>
      openAlexSearch(
        {
          title: query.text,
          ...(query.year === undefined ? {} : { year: query.year }),
          rows,
        },
        opts,
      ),
    semanticscholar: () =>
      semanticScholarSearch(
        { text: query.text, ...(query.year === undefined ? {} : { year: query.year }), rows },
        opts,
      ),
    europepmc: () =>
      europePmcQuery(
        query.year === undefined
          ? `TITLE:"${query.text}"`
          : `TITLE:"${query.text}" AND PUB_YEAR:${String(query.year)}`,
        { ...opts, rows },
      ),
  };

  const attempts = await Promise.all(
    order.map(async (source): Promise<SourceSearchResult> => {
      const runner = runners[source];
      if (runner === undefined) {
        return {
          source,
          ok: false,
          candidates: [],
          reason: '该上游不支持检索',
          url: '',
          total: null,
        };
      }
      try {
        return await runner();
      } catch (err) {
        return {
          source,
          ok: false,
          candidates: [],
          reason: `检索函数异常：${err instanceof Error ? err.message : String(err)}`,
          url: '',
          total: null,
        };
      }
    }),
  );

  const candidates = attempts.flatMap((a) => a.candidates);
  const anyOk = attempts.some((a) => a.ok);

  return {
    ok: anyOk,
    candidates,
    attempts,
    reason: anyOk
      ? null
      : `全部 ${String(attempts.length)} 家上游检索失败：\n${attempts
          .map((a) => `${a.source}：${a.reason ?? '失败'}`)
          .join('\n')}`,
  };
}
