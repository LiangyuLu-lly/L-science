/**
 * 引文核实（任务 13.5，需求 13.9）。
 *
 * 需求原文是一条**禁止**：「当引文核实任务执行时，系统应禁止模型凭记忆作答，
 * 必须经由检索工具取证」。
 *
 * 提示词层面守不住这条。模型说「我查过了，这篇文献确实存在」与它真的查过，在输出里
 * 长得一模一样；而写「不要凭记忆回答」只是让它在幻觉之外多加一句「我已核实」。
 *
 * 因此这里的架构是：**检索由后端做，模型拿不到写结论的权限**。
 *
 * - 模型能做的只有一件事：把要核实的引文交进来。
 * - 检索、比对、判定全部在这个文件里完成，结论直接落库（`citation_checks`）。
 * - 模型**没有**一个「告诉系统这条引文核实通过了」的入口。工具的返回值是这次检索的
 *   实际结果，它可以据此继续推理，但改不了记录。
 *
 * 判定分五档，区分它们比给一个是非答案有用得多：
 *
 * - `verified`：检索命中，且引文声称的字段与检索到的记录一致。
 * - `metadata-mismatch`：**标识命中但字段不符**。这是最有价值的一档——DOI 是真的，
 *   但正文里写的年份/作者/标题指向另一篇文献。成因几乎总是「复制错行」，而它在
 *   任何只检查「这个 DOI 存不存在」的流程里都查不出来。
 * - `not-found`：全部上游都没有。这才是「可能是编造的引文」。
 * - `ambiguous`：多个候选都像，无法确定是哪一篇。
 * - `unverifiable`：没能真的查（域名未批准、没有可检索字段、网络失败）。
 *   刻意与 `not-found` 分开：前者是「我们没查到」，后者是「查了，不存在」。
 *   混成一档会把网络故障说成学术不端。
 */

import type { RefRecord } from '../repo/refs.js';
import type { ClaimsRepo, CitationCheckRecord, CitationVerdict } from '../repo/claims.js';
import { citeLine, cslYear, familyKey, normalizeDoi, normalizeTitle } from '../refs/csl.js';
import { titleSimilarity } from '../refs/dedupe.js';
import type { RefLibrary } from '../refs/library.js';
import type { ParsedCitation } from './citations.js';
import { CITATION_SHAPE_LABEL, describeCitation, parseCitation } from './citations.js';

export const CITATION_VERDICT_LABEL: Readonly<Record<CitationVerdict, string>> = {
  verified: '已核实',
  'metadata-mismatch': '标识命中但字段不符',
  'not-found': '检索不到（可能是编造的引文）',
  ambiguous: '多个候选，无法确定',
  unverifiable: '未能核实（没查到或查不了）',
};

/** 一次核实的结果。 */
export interface CitationVerifyResult {
  raw: string;
  parsed: ParsedCitation;
  verdict: CitationVerdict;
  /** 命中的文献条目（已入库时）。 */
  matchedRefId: string | null;
  matchedDoi: string | null;
  /** 命中记录的一行引用。未命中时为 null。 */
  matchedCite: string | null;
  similarity: number | null;
  /** 字段不符的具体项。`metadata-mismatch` 时非空。 */
  mismatches: readonly string[];
  /** 实际发出的检索查询。空数组意味着没有真的查过（`unverifiable`）。 */
  queries: readonly string[];
  /** 逐源结果。 */
  attempts: readonly { source: string; ok: boolean; hits: number; reason: string | null }[];
  /** 面向用户与模型的结论说明。 */
  detail: string;
  /** 落库的核实记录 id。 */
  checkId: string | null;
}

export interface CitationVerifierDeps {
  library: RefLibrary;
  claims: ClaimsRepo;
  onLog?: (line: string) => void;
}

/**
 * 字段一致性的判定门槛。
 *
 * 标题用相似度而不是相等：出版商与索引库对副标题、连字符、希腊字母的处理各不相同，
 * 要求相等会让几乎所有引文都被判成「不符」，而那等于这一档失效。
 */
const MATCH_THRESHOLDS = {
  /** 标题相似度低于此值时算不符。 */
  titleMismatch: 0.75,
  /** 无标识时，仅靠标题判定命中所需的相似度。 */
  titleOnlyHit: 0.9,
  /** 候选之间差距小于此值时算模糊。 */
  ambiguityGap: 0.05,
} as const;

export class CitationVerifier {
  readonly #library: RefLibrary;
  readonly #claims: ClaimsRepo;
  readonly #log: (line: string) => void;

  constructor(deps: CitationVerifierDeps) {
    this.#library = deps.library;
    this.#claims = deps.claims;
    this.#log = deps.onLog ?? ((): void => undefined);
  }

  /**
   * 核实一条引文。
   *
   * `claimId` 给出时把记录挂到该断言上；`modelId` 记的是**发起者**而不是「谁做的
   * 判断」——判断由这段代码做，模型只是提出了要核实什么。
   */
  async verify(input: {
    raw: string;
    claimId?: string | null;
    modelId?: string | null;
  }): Promise<CitationVerifyResult> {
    const parsed = parseCitation(input.raw);

    if (!parsed.searchable) {
      return this.#record({
        parsed,
        verdict: 'unverifiable',
        queries: [],
        attempts: [],
        matched: null,
        similarity: null,
        mismatches: [],
        detail:
          parsed.reason ??
          `这条引文的形态是「${CITATION_SHAPE_LABEL[parsed.shape]}」，没有可检索的字段。`,
        claimId: input.claimId ?? null,
        modelId: input.modelId ?? null,
      });
    }

    /* ---------------- 标识路径 ---------------- */

    /*
     * 有标识时先按标识解析。它能唯一定位，因此拿回来的记录是权威的。
     *
     * 关键点：拿到之后**还要比对引文声称的字段**。只判断「这个 DOI 存不存在」会漏掉
     * 复制错行——DOI 是真的，但正文里写的是另一篇文献的作者与年份。
     */
    const identifier =
      parsed.doi !== null
        ? parsed.doi
        : parsed.pmid !== null
          ? parsed.pmid
          : parsed.pmcid !== null
            ? parsed.pmcid
            : parsed.arxivId;

    if (identifier !== null) {
      const outcome = await this.#library.addByIdentifier(identifier, { refresh: false });
      const queries = [identifier];
      const attempts = outcome.attempts.map((a) => ({
        source: a.source,
        ok: a.ok,
        hits: a.ok ? 1 : 0,
        reason: a.reason,
      }));

      if (!outcome.ok || outcome.ref === null) {
        /*
         * 标识查不到。
         *
         * 区分「上游都说没有」与「一次也没真的查到」：前者是 `not-found`
         * （这个 DOI 不存在，很可能是编造的），后者是 `unverifiable`。
         * 判据是有没有任何一家上游真的给出了回答。
         */
        const reached = attempts.some((a) => a.ok || a.reason?.includes('没有') === true);
        return this.#record({
          parsed,
          verdict: reached ? 'not-found' : 'unverifiable',
          queries,
          attempts,
          matched: null,
          similarity: null,
          mismatches: [],
          detail: reached
            ? `按标识 ${identifier} 在全部上游都查不到这条记录。\n` +
              '一个格式合法但不存在的 DOI 是编造引文最常见的形态。' +
              '请核对原文，或改用标题检索确认这篇文献到底是哪一篇。\n' +
              (outcome.reason ?? '')
            : `没能真的完成检索（不是「查不到」而是「查不了」）：${outcome.reason ?? '未知原因'}`,
          claimId: input.claimId ?? null,
          modelId: input.modelId ?? null,
        });
      }

      const mismatches = compareFields(parsed, outcome.ref);
      const sim =
        parsed.title === null
          ? null
          : titleSimilarity(normalizeTitle(parsed.title), outcome.ref.titleNorm ?? '').char;

      return this.#record({
        parsed,
        verdict: mismatches.length > 0 ? 'metadata-mismatch' : 'verified',
        queries,
        attempts,
        matched: outcome.ref,
        similarity: sim,
        mismatches,
        detail:
          mismatches.length > 0
            ? `标识 ${identifier} 确实存在，但它指向的文献与引文里写的不一致：\n` +
              mismatches.map((m) => `· ${m}`).join('\n') +
              '\n\n上游记录：' +
              citeLine(outcome.ref.csl) +
              '\n\n最常见的成因是复制参考文献时错了一行。请核对原文。'
            : `已核实。上游记录：${citeLine(outcome.ref.csl)}`,
        claimId: input.claimId ?? null,
        modelId: input.modelId ?? null,
      });
    }

    /* ---------------- 书目检索路径 ---------------- */

    const query = buildQuery(parsed);
    const search = await this.#library.search({
      text: query,
      ...(parsed.firstAuthorSurname === null ? {} : { author: parsed.firstAuthorSurname }),
      ...(parsed.year === null ? {} : { year: parsed.year }),
      rows: 8,
    });

    const attempts = search.attempts.map((a) => ({
      source: a.source,
      ok: a.ok,
      hits: a.candidates.length,
      reason: a.reason,
    }));

    if (!search.ok) {
      return this.#record({
        parsed,
        verdict: 'unverifiable',
        queries: [query],
        attempts,
        matched: null,
        similarity: null,
        mismatches: [],
        detail:
          `没能真的完成检索（不是「查不到」而是「查不了」）：${search.reason ?? '全部上游失败'}\n` +
          '这不能作为「这篇文献不存在」的依据。',
        claimId: input.claimId ?? null,
        modelId: input.modelId ?? null,
      });
    }

    /*
     * 按标题相似度给候选打分。
     *
     * 只有标题时不能只看最高分：两个都在 0.9 以上的候选意味着无法确定是哪一篇，
     * 而随便选一个会把引文「核实」到另一篇文献上——那比报「找不到」严重得多，
     * 因为它是一个看起来成功的错误结果。
     */
    const wanted = parsed.title === null ? '' : normalizeTitle(parsed.title);
    const scored = search.candidates
      .map((candidate) => {
        const candidateTitle = normalizeTitle(candidate.item.title);
        const titleScore =
          wanted === '' || candidateTitle === ''
            ? 0
            : Math.max(
                titleSimilarity(wanted, candidateTitle).char,
                // 副标题缺失时字符相似度会很低，包含率能救回来
                titleSimilarity(wanted, candidateTitle).containment * 0.95,
              );

        const authorOk =
          parsed.firstAuthorSurname !== null &&
          (candidate.item.author ?? []).some(
            (a) => familyKey(a) === normalizeTitle(parsed.firstAuthorSurname as string),
          );
        const candidateYear = cslYear(candidate.item);
        const yearOk =
          parsed.year === null ||
          candidateYear === null ||
          Math.abs(candidateYear - parsed.year) <= 1;

        return { candidate, titleScore, authorOk, yearOk };
      })
      .sort((a, b) => b.titleScore - a.titleScore);

    const best = scored[0];
    const runnerUp = scored[1];

    if (best === undefined || best.titleScore < MATCH_THRESHOLDS.titleMismatch) {
      return this.#record({
        parsed,
        verdict: 'not-found',
        queries: [query],
        attempts,
        matched: null,
        similarity: best?.titleScore ?? null,
        mismatches: [],
        detail:
          `在 ${String(attempts.filter((a) => a.ok).length)} 家上游检索「${query}」，` +
          (search.candidates.length === 0
            ? '没有任何候选。\n'
            : `${String(search.candidates.length)} 个候选里最相似的只有 ${(best?.titleScore ?? 0).toFixed(2)}：\n` +
              scored
                .slice(0, 3)
                .map((s) => `· ${s.titleScore.toFixed(2)}　${s.candidate.cite}`)
                .join('\n') +
              '\n') +
          '\n这条引文很可能不存在。**不要**据此构造一条文献记录；' +
          '如果你确信它存在，请给出它的 DOI 再核实一次。',
        claimId: input.claimId ?? null,
        modelId: input.modelId ?? null,
      });
    }

    if (
      runnerUp !== undefined &&
      best.titleScore - runnerUp.titleScore < MATCH_THRESHOLDS.ambiguityGap &&
      runnerUp.titleScore >= MATCH_THRESHOLDS.titleMismatch
    ) {
      return this.#record({
        parsed,
        verdict: 'ambiguous',
        queries: [query],
        attempts,
        matched: null,
        similarity: best.titleScore,
        mismatches: [],
        detail:
          '有多个候选同样像，无法确定是哪一篇：\n' +
          scored
            .slice(0, 4)
            .map(
              (s) =>
                `· ${s.titleScore.toFixed(2)}　${s.candidate.cite}` +
                `${s.candidate.item.DOI === undefined ? '' : `　doi:${s.candidate.item.DOI}`}`,
            )
            .join('\n') +
          '\n\n随便选一个会把这条引文「核实」到另一篇文献上——那是一个看起来成功的错误结果。' +
          '请用 DOI 明确指定是哪一篇。',
        claimId: input.claimId ?? null,
        modelId: input.modelId ?? null,
      });
    }

    /*
     * 命中。把它入库，这样它能作为 claim 证据被绑定。
     *
     * 不入库的话核实结论无处可依附：Claim Ledger 的 `ref` 类证据要求一个真实的
     * 文献条目 id，而临时的检索候选没有 id。
     */
    const added = this.#library.addResolved({
      csl: best.candidate.item,
      source: best.candidate.source,
    });

    const mismatches: string[] = [];
    if (!best.authorOk && parsed.firstAuthorSurname !== null) {
      mismatches.push(
        `引文写的第一作者是 ${parsed.firstAuthorSurname}，检索到的记录里没有这个姓氏` +
          `（${(best.candidate.item.author ?? [])
            .slice(0, 3)
            .map((a) => a.family ?? a.literal ?? '?')
            .join('、')}）`,
      );
    }
    if (!best.yearOk && parsed.year !== null) {
      mismatches.push(
        `引文写的年份是 ${String(parsed.year)}，检索到的记录是 ${String(cslYear(best.candidate.item) ?? 0)}`,
      );
    }

    return this.#record({
      parsed,
      verdict: mismatches.length > 0 ? 'metadata-mismatch' : 'verified',
      queries: [query],
      attempts,
      matched: added.ref,
      similarity: best.titleScore,
      mismatches,
      detail:
        (mismatches.length > 0
          ? `按标题检索到了一篇高度相似的文献（相似度 ${best.titleScore.toFixed(2)}），` +
            '但引文声称的字段与它不一致：\n' +
            mismatches.map((m) => `· ${m}`).join('\n') +
            '\n\n'
          : `已核实（标题相似度 ${best.titleScore.toFixed(2)}）。\n`) +
        `上游记录：${best.candidate.cite}` +
        (best.candidate.item.DOI === undefined ? '' : `\nDOI：${best.candidate.item.DOI}`) +
        (added.ref === null ? '' : `\n已入库为 ${added.ref.id}，可作为 ref 类证据绑定到断言上。`) +
        (best.candidate.item.extra?.retracted === true
          ? '\n\n⚠ 这篇文献已被撤稿。引用它需要在正文里明确说明理由。'
          : ''),
      claimId: input.claimId ?? null,
      modelId: input.modelId ?? null,
    });
  }

  /** 批量核实。串行——并行会让四家上游同时收到 N 倍请求而被限流。 */
  async verifyMany(
    citations: readonly string[],
    options: { claimId?: string | null; modelId?: string | null; signal?: AbortSignal } = {},
  ): Promise<{
    results: readonly CitationVerifyResult[];
    counts: Readonly<Record<CitationVerdict, number>>;
  }> {
    const results: CitationVerifyResult[] = [];
    const counts: Record<CitationVerdict, number> = {
      verified: 0,
      'metadata-mismatch': 0,
      'not-found': 0,
      ambiguous: 0,
      unverifiable: 0,
    };

    for (const raw of citations) {
      if (options.signal?.aborted === true) break;
      const result = await this.verify({
        raw,
        ...(options.claimId === undefined ? {} : { claimId: options.claimId }),
        ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      });
      results.push(result);
      counts[result.verdict] += 1;
    }

    this.#log(
      `引文核实 ${String(results.length)} 条：已核实 ${String(counts.verified)}、` +
        `字段不符 ${String(counts['metadata-mismatch'])}、` +
        `查不到 ${String(counts['not-found'])}、` +
        `模糊 ${String(counts.ambiguous)}、未能核实 ${String(counts.unverifiable)}`,
    );

    return { results, counts };
  }

  /** 落库并返回结果。所有出口都经这里，因此不存在「有结论但没记录」的状态。 */
  #record(input: {
    parsed: ParsedCitation;
    verdict: CitationVerdict;
    queries: readonly string[];
    attempts: readonly { source: string; ok: boolean; hits: number; reason: string | null }[];
    matched: RefRecord | null;
    similarity: number | null;
    mismatches: readonly string[];
    detail: string;
    claimId: string | null;
    modelId: string | null;
  }): CitationVerifyResult {
    let checkId: string | null = null;
    try {
      const record = this.#claims.addCitationCheck({
        raw: input.parsed.raw,
        parsed: input.parsed,
        queries: input.queries,
        attempts: input.attempts,
        verdict: input.verdict,
        detail: input.detail,
        ...(input.claimId === null ? {} : { claimId: input.claimId }),
        ...(input.matched === null ? {} : { matchedRefId: input.matched.id }),
        ...(input.matched?.doi == null ? {} : { matchedDoi: input.matched.doi }),
        ...(input.similarity === null ? {} : { similarity: input.similarity }),
        ...(input.modelId === null ? {} : { modelId: input.modelId }),
      });
      checkId = record.id;
    } catch (err) {
      // 落库失败不该让核实结果丢掉，但要留痕：没有记录的结论在下游检查里
      // 会被当成未核实，那是正确的降级
      this.#log(`核实记录写入失败：${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      raw: input.parsed.raw,
      parsed: input.parsed,
      verdict: input.verdict,
      matchedRefId: input.matched?.id ?? null,
      matchedDoi: input.matched?.doi ?? null,
      matchedCite: input.matched === null ? null : citeLine(input.matched.csl),
      similarity: input.similarity,
      mismatches: input.mismatches,
      queries: input.queries,
      attempts: input.attempts,
      detail: input.detail,
      checkId,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 字段比对
 * ------------------------------------------------------------------ */

/**
 * 比对引文声称的字段与上游记录。
 *
 * 只比**引文里真的写了**的字段：引文没给年份时不能因为「上游有年份」就算不符。
 * 这一点如果做错，每条只有 DOI 的引文都会被报成字段不符。
 */
export function compareFields(parsed: ParsedCitation, ref: RefRecord): readonly string[] {
  const mismatches: string[] = [];

  if (parsed.title !== null && (ref.titleNorm ?? '') !== '') {
    const sim = titleSimilarity(normalizeTitle(parsed.title), ref.titleNorm as string);
    if (sim.char < MATCH_THRESHOLDS.titleMismatch && sim.containment < 0.9) {
      mismatches.push(
        `标题不符（相似度 ${sim.char.toFixed(2)}）：引文写「${parsed.title.slice(0, 80)}」，` +
          `记录是「${(ref.csl.title ?? '').slice(0, 80)}」`,
      );
    }
  }

  if (parsed.year !== null && ref.year !== null && Math.abs(parsed.year - ref.year) > 1) {
    // 允许差一年：电子首发与纸版卷期跨年是常态
    mismatches.push(`年份不符：引文写 ${String(parsed.year)}，记录是 ${String(ref.year)}`);
  }

  if (parsed.firstAuthorSurname !== null) {
    const wanted = normalizeTitle(parsed.firstAuthorSurname);
    const authors = (ref.csl.author ?? []).map(familyKey);
    if (authors.length > 0 && !authors.includes(wanted)) {
      mismatches.push(
        `第一作者不符：引文写 ${parsed.firstAuthorSurname}，` +
          `记录的作者是 ${authors.slice(0, 4).join('、')}`,
      );
    }
  }

  if (parsed.container !== null && ref.container !== null) {
    if (!journalNamesMatch(parsed.container, ref.container)) {
      mismatches.push(`期刊名不符：引文写「${parsed.container}」，记录是「${ref.container}」`);
    }
  }

  return mismatches;
}

/** 期刊名里不参与比对的虚词。ISO 4 缩写会把它们整个去掉。 */
const JOURNAL_STOPWORDS = new Set([
  'of',
  'the',
  'and',
  'in',
  'for',
  'on',
  'a',
  'an',
  'de',
  'der',
  'und',
  'la',
  'le',
  'des',
]);

/**
 * 期刊名比对。
 *
 * **不能用字符串相似度**。期刊缩写是 ISO 4 规定的截断式缩写：`Journal of Sleep
 * Research` → `J Sleep Res`。两者的字符相似度只有 0.44，词集合交集只有一个词——
 * 任何基于相似度的门槛要么把这一对判成不符（于是几乎每条引文都报期刊名不符，
 * 这一档因此失效），要么松到把 `Nature` 与 `Neuron` 也判成相同。
 *
 * 正确的判据是缩写的构造规则本身：短名的每个实词都能对上长名的某个实词。
 *
 * 「对上」有两种形式，只认前缀是不够的：
 *
 * - **截断**：`res` → `research`，`sci` → `sciences`。前缀关系。
 * - **缩合**：`Natl` → `National`，`Physiol` → `Physiology`。前者去掉了中间的
 *   元音，不是前缀。这一类在真实刊名里很常见（`Proc Natl Acad Sci U S A`），
 *   只认前缀会把它判成不符。
 *
 * 因此判据是「首字母相同 **且** 短词是长词的子序列」。加首字母这一条是必要的：
 * 单靠子序列时一个单字母缩写（`S`）能匹配任何含该字母的词，于是 `S` 会对上
 * `Academy`。
 *
 * 门槛设在「全部实词都要命中」而不是多数：漏掉一个词通常意味着是另一份刊物
 * （`J Clin Invest` 与 `J Clin Immunol` 的差别就在最后一个词，而它们的前两个词
 * 完全相同）。
 */
export function journalNamesMatch(a: string, b: string): boolean {
  const tokens = (text: string): readonly string[] =>
    normalizeTitle(text)
      .split(' ')
      .filter((w) => w !== '' && !JOURNAL_STOPWORDS.has(w));

  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return true;

  const [short, long] = left.length <= right.length ? [left, right] : [right, left];

  // 长名的词按位置消费，避免一个长词被多个短词重复命中
  const remaining = [...long];
  for (const token of short) {
    const index = remaining.findIndex((candidate) => abbreviates(token, candidate));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/** `short` 是不是 `long` 的刊名缩写形式。见 `journalNamesMatch` 的说明。 */
function abbreviates(short: string, long: string): boolean {
  if (short === long) return true;
  if (long.startsWith(short)) return true;
  if (short.length > long.length) return false;
  if (short[0] !== long[0]) return false;

  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i += 1;
    if (i === short.length) return true;
  }
  return false;
}

/**
 * 拼检索查询。
 *
 * 标题优先，因为它的检索区分度最高。只有作者与年份时把两者拼起来——命中率低，
 * 但那是这条引文能提供的全部信息，而返回「查不了」会让用户以为功能坏了。
 */
export function buildQuery(parsed: ParsedCitation): string {
  if (parsed.title !== null && parsed.title.length >= 8) {
    return parsed.title.slice(0, 300);
  }
  const parts: string[] = [];
  if (parsed.firstAuthorSurname !== null) parts.push(parsed.firstAuthorSurname);
  if (parsed.container !== null) parts.push(parsed.container);
  if (parsed.year !== null) parts.push(String(parsed.year));
  return parts.join(' ').slice(0, 300);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 把一批核实结果渲染成给模型与用户看的文本。 */
export function renderVerifyResults(
  results: readonly CitationVerifyResult[],
  counts: Readonly<Record<CitationVerdict, number>>,
): string {
  const lines = [
    `核实 ${String(results.length)} 条引文：` +
      [
        `已核实 ${String(counts.verified)}`,
        `字段不符 ${String(counts['metadata-mismatch'])}`,
        `查不到 ${String(counts['not-found'])}`,
        `模糊 ${String(counts.ambiguous)}`,
        `未能核实 ${String(counts.unverifiable)}`,
      ].join('，'),
  ];

  /*
   * 排序：问题最严重的在前。
   *
   * 查不到（可能编造）排最前，其次字段不符。已核实的排最后并折成一行——
   * 用户要看的是「哪些有问题」，把二十条「已核实」列在前面会把问题挤出视野。
   */
  const order: readonly CitationVerdict[] = [
    'not-found',
    'metadata-mismatch',
    'ambiguous',
    'unverifiable',
    'verified',
  ];
  const sorted = [...results].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));

  for (const result of sorted) {
    if (result.verdict === 'verified') continue;
    lines.push('');
    lines.push(`【${CITATION_VERDICT_LABEL[result.verdict]}】${describeCitation(result.parsed)}`);
    lines.push(`  原文：${result.raw.slice(0, 200)}`);
    lines.push(
      ...result.detail
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => `  ${l}`),
    );
    if (result.queries.length > 0) {
      lines.push(
        `  实际检索：${result.queries.join(' / ')}　` +
          `命中 ${String(result.attempts.reduce((n, a) => n + a.hits, 0))} 个候选` +
          `（${result.attempts.filter((a) => a.ok).length} 家上游有响应）`,
      );
    }
  }

  const verified = sorted.filter((r) => r.verdict === 'verified');
  if (verified.length > 0) {
    lines.push('');
    lines.push(`已核实的 ${String(verified.length)} 条：`);
    for (const result of verified.slice(0, 30)) {
      /*
       * 已核实的那一行也带上「实际检索了什么」。
       *
       * 需求 13.9 的可核查性在这里最要紧：一条「已核实」如果看不出系统真的查了
       * 什么，它与「模型说它核实过了」在读者眼里没有区别。
       */
      lines.push(
        `  ✓ ${describeCitation(result.parsed)}` +
          (result.matchedRefId === null ? '' : `　→ ${result.matchedRefId}`) +
          (result.queries.length === 0 ? '' : `　实际检索：${result.queries.join(' / ')}`),
      );
    }
  }

  if (counts['not-found'] > 0) {
    lines.push('');
    lines.push(
      `**${String(counts['not-found'])} 条引文在全部上游都检索不到。** ` +
        '这是编造引文最典型的形态。不要为它们构造文献记录——' +
        '要么给出正确的 DOI 重新核实，要么把这些引用从正文里去掉。',
    );
  }

  return lines.join('\n');
}

/** 一次核实记录的可读摘要，用于审计视图。 */
export function describeCheck(check: CitationCheckRecord): string {
  const parts = [`[${CITATION_VERDICT_LABEL[check.verdict]}]`, check.raw.slice(0, 120)];
  if (check.matchedRefId !== null) parts.push(`→ ${check.matchedRefId}`);
  if (check.similarity !== null) parts.push(`相似度 ${check.similarity.toFixed(2)}`);
  parts.push(`查询 ${check.queries.length} 次`);
  return parts.join('　');
}

/** DOI 归一化的 re-export，供工具层校验用户输入。 */
export { normalizeDoi };
