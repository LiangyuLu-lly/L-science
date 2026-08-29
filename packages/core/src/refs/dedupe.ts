/**
 * 文献去重与多源合并（任务 13.1，需求 12.2）。
 *
 * 需求要求「按 DOI 精确匹配与标题模糊匹配去重」。直接照字面实现会出一类很难发现的
 * 错误：两篇不同的文献被合并之后，被合并掉那条的证据绑定（需求 13.2 的 claim 证据）
 * 会指向另一篇文献，而正文里的引用看起来一切正常。因此这里的判定分三档而不是两档：
 *
 * - `same`：可以自动合并。只在标识相等，或标识缺失且标题几乎相同且作者年份都对得上时给出。
 * - `likely`：**报告但不合并**。典型情形是 preprint 与正式发表版——两个不同的 DOI、
 *   几乎相同的标题。它们是两个真实存在的注册对象，自动合并掉一个会让「当初引的是
 *   preprint」这个事实消失。用户或模型可以显式合并，但系统不替他做决定。
 * - `distinct`：不是同一篇。
 *
 * 标题相似度用两个指标而不是一个：
 *
 * - **归一化编辑距离**处理拼写与标点差异（`Sleep spindles: a review` 与
 *   `Sleep spindles - a review`）。
 * - **词包含率**处理副标题缺失（一家上游给 `Deep learning for sleep staging`，
 *   另一家给 `Deep learning for sleep staging: a multicenter validation study`）。
 *   编辑距离在这种情形下只有 0.6 左右，单靠它会漏掉真正的重复。
 *
 * 包含率单独用是危险的（任何短标题都「包含」在长标题里），因此它必须与作者、
 * 年份同时成立才起作用。
 */

import type { CslItem } from './csl.js';
import { cslYear, containerLabel, familyKey, firstAuthorKey, normalizeTitle } from './csl.js';
import { normalizeArxivId, normalizeDoi, normalizePmcid, normalizePmid } from './csl.js';

/** 去重比对用的指纹。从 CslItem 算出，不额外查库。 */
export interface RefFingerprint {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  /** 归一化标题。空串表示没有标题——此时只能靠标识判定。 */
  titleNorm: string;
  year: number | null;
  /** 第一作者姓氏键。 */
  firstAuthor: string;
  /** 全部作者姓氏键，用于自引检测与合并时选取更完整的作者列表。 */
  authorKeys: readonly string[];
  container: string | null;
}

export function fingerprint(item: CslItem): RefFingerprint {
  const container = containerLabel(item);
  return {
    doi: normalizeDoi(item.DOI),
    pmid: normalizePmid(item.PMID),
    pmcid: normalizePmcid(item.PMCID),
    arxivId: normalizeArxivId(
      typeof item.extra?.arxivId === 'string' ? item.extra.arxivId : undefined,
    ),
    titleNorm: normalizeTitle(item.title),
    year: cslYear(item),
    firstAuthor: firstAuthorKey(item),
    authorKeys: (item.author ?? []).map(familyKey).filter((k) => k !== ''),
    container: container === null ? null : normalizeTitle(container),
  };
}

/* ------------------------------------------------------------------ *
 * 标题相似度
 * ------------------------------------------------------------------ */

/**
 * 编辑距离（Levenshtein），滚动两行。
 *
 * 标题最长几百字符，O(n·m) 在这个量级上是几万次运算，不需要更聪明的算法。
 * 上限保护是为了防御异常输入：某些上游会把整段摘要塞进 title 字段，那时
 * 两个两千字符的串会变成四百万次运算，而它发生在每次新增文献的循环里。
 */
export function levenshtein(a: string, b: string, maxLen = 512): number {
  const s = a.length > maxLen ? a.slice(0, maxLen) : a;
  const t = b.length > maxLen ? b.slice(0, maxLen) : b;
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = new Array<number>(t.length + 1);
  let cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j += 1) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[t.length] ?? 0;
}

export interface TitleSimilarity {
  /** 1 - 归一化编辑距离。完全相同为 1。 */
  char: number;
  /** 短标题的词有多少比例出现在长标题里。副标题缺失时接近 1。 */
  containment: number;
  /** 词集合的 Jaccard 系数。 */
  jaccard: number;
}

const NO_SIMILARITY: TitleSimilarity = { char: 0, containment: 0, jaccard: 0 };

export function titleSimilarity(a: string, b: string): TitleSimilarity {
  if (a === '' || b === '') return NO_SIMILARITY;
  if (a === b) return { char: 1, containment: 1, jaccard: 1 };

  const longer = Math.max(a.length, b.length);
  const shorter = Math.min(a.length, b.length);

  /*
   * 长度差过大时跳过 DP。
   *
   * 编辑距离至少是长度差，因此 char 相似度上界是 shorter/longer。差一倍时上界
   * 只有 0.5，远低于任何判定阈值——算出来也用不上。这个提前退出让「一条短标题
   * 与几千条长标题比对」这个循环快一个数量级。
   */
  const charUpperBound = shorter / longer;
  const char = charUpperBound < 0.5 ? charUpperBound : 1 - levenshtein(a, b) / longer;

  const tokensA = new Set(a.split(' ').filter((w) => w !== ''));
  const tokensB = new Set(b.split(' ').filter((w) => w !== ''));
  let intersection = 0;
  const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  for (const token of small) if (large.has(token)) intersection += 1;

  const union = tokensA.size + tokensB.size - intersection;
  return {
    char: Math.max(0, char),
    containment: small.size === 0 ? 0 : intersection / small.size,
    jaccard: union === 0 ? 0 : intersection / union,
  };
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

export type MatchVerdict = 'same' | 'likely' | 'distinct';

export interface MatchResult {
  verdict: MatchVerdict;
  /** 判定依据。 */
  by: 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'title' | null;
  similarity: TitleSimilarity;
  /** 面向用户的一句话理由。`likely` 时用户要靠它决定合不合。 */
  reason: string;
}

/**
 * 年份是否相容。
 *
 * 允许差 1 年：电子首发与纸版卷期跨年是常态（online 2023-12，issue 2024-01），
 * 六家上游对「发表年份」的取值也因此不一致。差 2 年以上就不再是同一篇了。
 * 任一方缺年份时视为相容——缺失不是矛盾。
 */
function yearsCompatible(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= 1;
}

/** 阈值集中在这里，测试直接引用它们，改阈值时测试跟着一起改。 */
export const DEDUPE_THRESHOLDS = {
  /** 标识缺失时，仅靠标题就判同一篇所需的字符相似度。 */
  titleOnlySame: 0.95,
  /** 标题 + 作者 + 年份共同成立时所需的字符相似度。 */
  titleWithAuthorSame: 0.84,
  /** 副标题缺失路径：包含率门槛（同时要求作者与年份成立）。 */
  containmentSame: 0.95,
  /** 报告为可疑重复的下限。 */
  likely: 0.78,
  /** 两个不同 DOI 之间报告为可疑重复的下限（更严，因为它们本就是两个对象）。 */
  crossDoiLikely: 0.9,
} as const;

/**
 * 判定两条文献是否重复。
 *
 * 参数顺序无关（对称）。
 */
export function matchRefs(a: RefFingerprint, b: RefFingerprint): MatchResult {
  const similarity = titleSimilarity(a.titleNorm, b.titleNorm);

  /*
   * 标识相等即同一篇。
   *
   * 这一档在 DOI 之外还认 PMID / PMCID / arXiv id：一条文献可能只有 PMID
   * （PubMed 里有而 Crossref 里没有的老文献），此时 DOI 精确匹配完全无效，
   * 而 PMID 的唯一性与 DOI 一样强。
   */
  if (a.doi !== null && b.doi !== null && a.doi === b.doi) {
    return { verdict: 'same', by: 'doi', similarity, reason: `DOI 相同：${a.doi}` };
  }
  if (a.pmid !== null && b.pmid !== null && a.pmid === b.pmid) {
    return { verdict: 'same', by: 'pmid', similarity, reason: `PMID 相同：${a.pmid}` };
  }
  if (a.pmcid !== null && b.pmcid !== null && a.pmcid === b.pmcid) {
    return { verdict: 'same', by: 'pmcid', similarity, reason: `PMCID 相同：${a.pmcid}` };
  }
  if (a.arxivId !== null && b.arxivId !== null && a.arxivId === b.arxivId) {
    return { verdict: 'same', by: 'arxiv', similarity, reason: `arXiv 编号相同：${a.arxivId}` };
  }

  const bothHaveDoi = a.doi !== null && b.doi !== null;
  const authorAgrees = a.firstAuthor !== '' && a.firstAuthor === b.firstAuthor;
  const yearOk = yearsCompatible(a.year, b.year);

  /*
   * 两个不同的 DOI 永不自动合并。
   *
   * 最常见的情形是 preprint 与正式发表版：标题相同、作者相同、年份差一年，
   * 但它们是两个已注册的对象。自动合并掉一个之后，「当初引的是 preprint」
   * 这个事实无法恢复，而它在审稿意见里是会被问到的。
   */
  if (bothHaveDoi) {
    if (
      similarity.char >= DEDUPE_THRESHOLDS.crossDoiLikely ||
      (similarity.containment >= 0.95 && authorAgrees)
    ) {
      return {
        verdict: 'likely',
        by: 'title',
        similarity,
        reason:
          `标题高度相似（字符相似度 ${similarity.char.toFixed(2)}）但 DOI 不同` +
          `（${a.doi ?? '?'} / ${b.doi ?? '?'}）。常见原因是 preprint 与正式发表版，` +
          '两者都是真实存在的注册对象，因此不会自动合并。要合并请显式指定保留哪一条。',
      };
    }
    return {
      verdict: 'distinct',
      by: null,
      similarity,
      reason: `DOI 不同且标题相似度只有 ${similarity.char.toFixed(2)}`,
    };
  }

  // 有一方连标题都没有：只能靠标识，而标识已经比过了
  if (a.titleNorm === '' || b.titleNorm === '') {
    return {
      verdict: 'distinct',
      by: null,
      similarity,
      reason: '标识不同且至少一方没有标题，无从比对',
    };
  }

  if (similarity.char >= DEDUPE_THRESHOLDS.titleOnlySame && yearOk) {
    return {
      verdict: 'same',
      by: 'title',
      similarity,
      reason: `标题几乎完全相同（${similarity.char.toFixed(2)}）且年份相容，至少一方没有 DOI`,
    };
  }

  if (similarity.char >= DEDUPE_THRESHOLDS.titleWithAuthorSame && authorAgrees && yearOk) {
    return {
      verdict: 'same',
      by: 'title',
      similarity,
      reason: `标题相似度 ${similarity.char.toFixed(2)}，第一作者（${a.firstAuthor}）与年份都对得上`,
    };
  }

  /*
   * 副标题缺失路径。
   *
   * 包含率高说明短标题的词全在长标题里。单凭这一点不能判同一篇（任何短标题都
   * 「包含」在足够长的标题里），因此额外要求第一作者与年份成立，并且短标题
   * 至少有四个词——两三个词的标题（`Sleep`、`Methods`）包含率必然很高。
   */
  const shorterTokenCount = Math.min(a.titleNorm.split(' ').length, b.titleNorm.split(' ').length);
  if (
    similarity.containment >= DEDUPE_THRESHOLDS.containmentSame &&
    shorterTokenCount >= 4 &&
    authorAgrees &&
    yearOk
  ) {
    return {
      verdict: 'same',
      by: 'title',
      similarity,
      reason:
        `一方的标题是另一方的前缀或子集（包含率 ${similarity.containment.toFixed(2)}），` +
        `第一作者（${a.firstAuthor}）与年份都对得上。常见原因是某个上游丢了副标题。`,
    };
  }

  if (similarity.char >= DEDUPE_THRESHOLDS.likely || similarity.jaccard >= 0.8) {
    return {
      verdict: 'likely',
      by: 'title',
      similarity,
      reason:
        `标题相似（字符 ${similarity.char.toFixed(2)}、词集合 ${similarity.jaccard.toFixed(2)}）` +
        `但${authorAgrees ? '' : '第一作者不一致'}${yearOk ? '' : '年份相差超过一年'}，无法确定是同一篇`,
    };
  }

  return {
    verdict: 'distinct',
    by: null,
    similarity,
    reason: `标题相似度 ${similarity.char.toFixed(2)}，低于判定门槛`,
  };
}

/* ------------------------------------------------------------------ *
 * 多源合并
 * ------------------------------------------------------------------ */

/**
 * 字段完备度打分，用于决定合并时以谁为主。
 *
 * 权重按「缺了它引用格式会出错」排：没有作者与年份的条目在任何期刊样式下都是废的；
 * 没有摘要只是不方便。这个函数不比较两条是否重复，只在已确定重复之后选主记录。
 */
export function completeness(item: CslItem): number {
  let score = 0;
  if ((item.author?.length ?? 0) > 0) score += 10 + Math.min(item.author?.length ?? 0, 10);
  if (item.issued?.['date-parts'] !== undefined) score += 10;
  if (typeof item.title === 'string' && item.title !== '') score += 8;
  if (typeof item['container-title'] === 'string') score += 6;
  if (typeof item.volume === 'string') score += 3;
  if (typeof item.issue === 'string') score += 2;
  if (typeof item.page === 'string') score += 4;
  if (typeof item.DOI === 'string') score += 6;
  if (typeof item.publisher === 'string') score += 2;
  if ((item.ISSN?.length ?? 0) > 0) score += 2;
  if (typeof item.abstract === 'string') score += 3;
  if (typeof item.PMID === 'string') score += 2;
  if (typeof item.PMCID === 'string') score += 2;
  return score;
}

/**
 * 合并两条已判定为同一篇的记录。
 *
 * 规则：
 * - 主记录的字段优先，缺失的从副记录补。
 * - **作者列表取更长的那个**，而不是取主记录的。上游截断作者列表是常见缺陷
 *   （某些接口只给前 10 位），而作者列表在引用里必须完整；一旦以短的为准，
 *   缺的作者不会再有机会补回来。
 * - `extra` 逐键合并，主记录优先。被合并掉那条独有的信号（比如只有 OpenAlex
 *   给的 `retracted`）必须保留下来——它可能是这条记录最重要的信息。
 * - `type` 以主记录为准，除非主记录是兜底的 `document` 而副记录不是。
 */
export function mergeCsl(primary: CslItem, secondary: CslItem): CslItem {
  const primaryAuthors = primary.author ?? [];
  const secondaryAuthors = secondary.author ?? [];
  const author =
    secondaryAuthors.length > primaryAuthors.length ? secondaryAuthors : primaryAuthors;

  const extra: Record<string, unknown> = { ...(secondary.extra ?? {}), ...(primary.extra ?? {}) };

  const merged: Record<string, unknown> = { ...secondary };
  for (const [key, value] of Object.entries(primary)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }

  merged.id = primary.id;
  merged.type =
    primary.type === 'document' && secondary.type !== 'document' ? secondary.type : primary.type;
  if (author.length > 0) merged.author = author;
  if (Object.keys(extra).length > 0) merged.extra = extra;

  return merged as unknown as CslItem;
}

/**
 * 把多个上游的结果合成一条。
 *
 * 输入顺序即优先级（`resolver.ts` 按字段规范度排的）。以完备度最高的一条为主，
 * 而不是以第一条为主：Crossref 通常最规范，但对 preprint 与非英文期刊它经常
 * 只有标题和 DOI，而 OpenAlex 有完整作者列表。硬按顺序取主会丢掉后者。
 *
 * 同分时取靠前的（顺序即偏好），因此 `>` 而不是 `>=`。
 */
export function mergeAll(items: readonly CslItem[]): CslItem | null {
  const usable = items.filter((i) => i.title !== undefined || i.DOI !== undefined);
  if (usable.length === 0) return null;

  let best = usable[0] as CslItem;
  let bestScore = completeness(best);
  for (const item of usable.slice(1)) {
    const score = completeness(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  let result = best;
  for (const item of usable) {
    if (item === best) continue;
    result = mergeCsl(result, item);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 批量聚类
 * ------------------------------------------------------------------ */

export interface DedupeCluster {
  /** 合并后的代表条目。 */
  item: CslItem;
  /** 参与合并的原始下标。 */
  members: readonly number[];
  /** 判定为 `likely` 但未合并的下标与理由。 */
  suspects: readonly { index: number; reason: string }[];
}

/**
 * 对一批条目聚类去重。
 *
 * 用「逐条与已有簇比对」而不是先算全部两两相似度：后者是 O(n²) 次编辑距离，
 * 在一次导入几百条的场景下会明显卡顿，而簇的数量远小于条目数。
 *
 * `likely` 的对不合并但会记进 `suspects`，调用方（工具输出、UI）如实告知用户
 * 「这两条可能是同一篇，需要你判断」。静默丢弃这个信号等于把判断权拿走了。
 */
export function clusterRefs(items: readonly CslItem[]): readonly DedupeCluster[] {
  const clusters: {
    item: CslItem;
    fp: RefFingerprint;
    members: number[];
    suspects: { index: number; reason: string }[];
  }[] = [];

  for (const [index, item] of items.entries()) {
    const fp = fingerprint(item);
    let placed = false;

    for (const cluster of clusters) {
      const match = matchRefs(fp, cluster.fp);
      if (match.verdict === 'same') {
        cluster.item = mergeCsl(
          completeness(cluster.item) >= completeness(item) ? cluster.item : item,
          completeness(cluster.item) >= completeness(item) ? item : cluster.item,
        );
        cluster.fp = fingerprint(cluster.item);
        cluster.members.push(index);
        placed = true;
        break;
      }
      if (match.verdict === 'likely') {
        cluster.suspects.push({ index, reason: match.reason });
      }
    }

    if (!placed) clusters.push({ item, fp, members: [index], suspects: [] });
  }

  return clusters.map((c) => ({ item: c.item, members: c.members, suspects: c.suspects }));
}
