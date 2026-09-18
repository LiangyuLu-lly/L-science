/**
 * Claim Ledger 服务（任务 13.4，需求 13.1-13.4）。
 *
 * 把抽取、登记、证据绑定、核验记录串成一件事。三个决策决定了这一层的形状：
 *
 * 1. **绑定证据时校验被指向的东西真的存在**。这是整套机制里最重要的一道检查：
 *    模型会给出一个它以为存在的制品版本 id。放行之后，那条断言在计数上「有证据」，
 *    FAIL 检查放过它，而用户点开是空的——他此时已经相信了那句话。这道检查要
 *    宿主提供存在性判定，因此 `ClaimLedger` 需要注入回调而不能只吃仓储。
 *
 * 2. **断言状态由证据的核验结论推导，不由调用方直接写**。让模型自己说「这条断言
 *    已支持」等于取消了核验。状态只能通过「记录某条证据的核验结论」间接改变，
 *    而那必须带模型标识（需求 13.4）。用户可以手工 `dismiss` 或 `retract`——
 *    那是关于「这条断言要不要核验」的决定，不是关于「它对不对」的判断。
 *
 * 3. **自动抽取的断言不直接进 FAIL**。规则抽取必然误抽（方法学里的「采样率
 *    250 Hz」会被认成数值结论）。把它们与用户明确登记的断言同等对待会让 FAIL 级
 *    发现里塞满误抽，而一旦用户开始忽略 FAIL，整套机制就失效了。因此
 *    `origin: 'extracted'` 的无证据断言默认只报 WARN；确认过（`confirm`）之后
 *    转成 `user` 来源，才进 FAIL。
 */

import type {
  ClaimEvidence,
  ClaimEvidenceKind,
  ClaimOrigin,
  ClaimRecord,
  ClaimStatus,
  ClaimVerdict,
  ClaimsRepo,
} from '../repo/claims.js';
import { EVIDENCE_KIND_LABEL, OPEN_CLAIM_STATUSES } from '../repo/claims.js';
import type { ClaimKind, ExtractOptions, ExtractResult } from './extract.js';
import { CLAIM_KIND_LABEL, classifyClaim, extractClaims } from './extract.js';

export interface ClaimLedgerDeps {
  repo: ClaimsRepo;
  /**
   * 制品版本是否存在。
   *
   * 不提供时跳过校验并在结果里说明——测试与不接制品库的部署走这条路。但生产必须
   * 提供：这是挡住「证据指向一个编出来的版本 id」的唯一手段。
   */
  artifactExists?: (versionId: string) => boolean;
  /** 文献条目是否存在。 */
  refExists?: (refId: string) => boolean;
  /** 按 DOI 找库里的文献条目。用于把 doi 类证据升级成 ref 类。 */
  refIdByDoi?: (doi: string) => string | null;
  /** 工具调用是否存在（compute 类证据）。 */
  computeExists?: (id: string) => boolean;
  onLog?: (line: string) => void;
}

export interface BindResult {
  ok: boolean;
  evidence: ClaimEvidence | null;
  /** 断言的新状态（绑定本身不改状态，除非顺带记了核验结论）。 */
  claim: ClaimRecord | null;
  reason: string | null;
  /** 建议：比如「这个 DOI 已在库里，用 ref 类指向 rf_… 更好」。 */
  advice: string | null;
}

export interface RegisterResult {
  ok: boolean;
  claim: ClaimRecord | null;
  /** 命中已有断言时为真（同一条文本不重复登记）。 */
  existing: boolean;
  reason: string | null;
}

/** 已确认但未绑证据时给人看的事实句。严重度仍是 fail，界面用「阻断」标出来。 */
export const UNSUPPORTED_CONFIRMED_FACT = '这条断言还没有证据';

/** 下一步。不去补，审查照样开 FAIL。 */
export const UNSUPPORTED_CONFIRMED_CTA = '去补证据';

export interface ExtractRegisterResult {
  extraction: ExtractResult;
  created: readonly ClaimRecord[];
  /** 已存在因此跳过的条数。 */
  skippedExisting: number;
  summary: string;
}

export class ClaimLedger {
  readonly repo: ClaimsRepo;
  readonly #deps: ClaimLedgerDeps;
  readonly #log: (line: string) => void;

  constructor(deps: ClaimLedgerDeps) {
    this.repo = deps.repo;
    this.#deps = deps;
    this.#log = deps.onLog ?? ((): void => undefined);
  }

  /* ---------------- 登记 ---------------- */

  /**
   * 登记一条断言。
   *
   * 类型由 `classifyClaim` 判定而不是由调用方给。让模型选类型的结果是它全选
   * `numeric`——那是第一个选项，而选错类型会让核验提示词问错问题
   * （对因果陈述问「这个数字对不对」）。
   */
  register(input: {
    text: string;
    manuscriptId?: string | null;
    conversationId?: string | null;
    locator?: string | null;
    section?: string | null;
    origin?: ClaimOrigin;
    note?: string | null;
    /** 覆盖自动判定的类型。仅在自动判定为 other 时才建议使用。 */
    kind?: ClaimKind;
  }): RegisterResult {
    const text = input.text.replace(/\s+/gu, ' ').trim();
    if (text === '') {
      return { ok: false, claim: null, existing: false, reason: '断言文本不能为空' };
    }

    const existing = this.repo.findByText(text, {
      ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    });
    if (existing !== null) {
      return {
        ok: true,
        claim: existing,
        existing: true,
        reason: `这条断言已登记（${existing.id}，状态 ${existing.status}）。要补证据请直接绑定到它。`,
      };
    }

    const classified = classifyClaim(text);
    const kinds = classified.kinds.length > 0 ? classified.kinds : ['other' as ClaimKind];
    const kind = input.kind ?? (kinds[0] as ClaimKind);

    try {
      const claim = this.repo.add({
        text,
        kind,
        kinds,
        numbers: classified.numbers,
        ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.locator === undefined ? {} : { locator: input.locator }),
        ...(input.section === undefined ? {} : { section: input.section }),
        origin: input.origin ?? 'model',
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return { ok: true, claim, existing: false, reason: null };
    } catch (err) {
      return {
        ok: false,
        claim: null,
        existing: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 从手稿里抽取并批量登记（需求 13.1）。
   *
   * 已存在的同一条文本跳过而不是重复登记：手稿改一个错别字之后重新抽取，
   * 不该让已经核验过的断言变成一条新的未核验断言。
   */
  extractAndRegister(input: {
    markdown: string;
    manuscriptId?: string | null;
    conversationId?: string | null;
    options?: ExtractOptions;
  }): ExtractRegisterResult {
    const extraction = extractClaims(input.markdown, input.options ?? {});
    const created: ClaimRecord[] = [];
    let skippedExisting = 0;

    for (const candidate of extraction.claims) {
      const result = this.register({
        text: candidate.text,
        ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        locator: candidate.locator,
        section: candidate.section,
        origin: 'extracted',
        note: candidate.reasons.join('；'),
        kind: candidate.kind,
      });

      if (!result.ok || result.claim === null) continue;
      if (result.existing) {
        skippedExisting += 1;
        continue;
      }
      created.push(result.claim);
    }

    const byKind = new Map<ClaimKind, number>();
    for (const claim of created) byKind.set(claim.kind, (byKind.get(claim.kind) ?? 0) + 1);
    const kindText = [...byKind.entries()]
      .map(([kind, count]) => `${CLAIM_KIND_LABEL[kind]} ${String(count)}`)
      .join('，');

    const summary = [
      `扫过 ${String(extraction.sentencesScanned)} 句，新登记 ${String(created.length)} 条断言` +
        (kindText === '' ? '' : `（${kindText}）`) +
        (skippedExisting > 0 ? `，${String(skippedExisting)} 条已存在` : '') +
        (extraction.truncated ? '。已达上限，后面的段落没有扫。' : '。'),
      '',
      '这些是**规则抽取**的候选，未经确认。规则必然会误抽——方法学里的' +
        '「采样率 250 Hz」会被认成数值结论。逐条看过之后：真正需要证据的用 confirm 确认' +
        '（确认后无证据会开 FAIL 级发现），不需要核验的用 dismiss 关掉。',
    ].join('\n');

    this.#log(`抽取断言：新增 ${String(created.length)}，已存在 ${String(skippedExisting)}`);
    return { extraction, created, skippedExisting, summary };
  }

  /**
   * 确认一条自动抽取的断言。
   *
   * 把 `origin` 从 `extracted` 改成 `user`，于是它无证据时会开 FAIL 而不只是 WARN。
   * 这一步刻意需要人（或模型）显式做：自动抽取的结果不该有 FAIL 的分量。
   */
  confirm(
    claimId: string,
    note?: string,
  ): { ok: boolean; claim: ClaimRecord | null; reason: string | null } {
    const claim = this.repo.get(claimId);
    if (claim === null) return { ok: false, claim: null, reason: `断言不存在：${claimId}` };
    if (claim.origin !== 'extracted') {
      return {
        ok: true,
        claim,
        reason: `这条断言的来源是 ${claim.origin}，本来就已经是确认状态。`,
      };
    }

    this.repo.promoteOrigin(claimId, note ?? null);
    return { ok: true, claim: this.repo.get(claimId), reason: null };
  }

  /* ---------------- 证据 ---------------- */

  /**
   * 绑定证据（需求 13.2）。
   *
   * 先校验被指向的东西存在。这是挡住「证据指向一个编出来的 id」的唯一手段，
   * 而那类错误的表现是最坏的：断言看起来有证据、检查放过它、用户点开是空的。
   */
  bind(input: {
    claimId: string;
    kind: ClaimEvidenceKind;
    ref: string;
    locator?: string | null;
    quote?: string | null;
    note?: string | null;
  }): BindResult {
    const claim = this.repo.get(input.claimId);
    if (claim === null) {
      return {
        ok: false,
        evidence: null,
        claim: null,
        reason: `断言不存在：${input.claimId}`,
        advice: null,
      };
    }

    const ref = input.ref.trim();
    const existence = this.#checkExistence(input.kind, ref);
    if (!existence.ok) {
      return {
        ok: false,
        evidence: null,
        claim,
        reason: existence.reason,
        advice: existence.advice,
      };
    }

    try {
      const evidence = this.repo.bindEvidence({
        claimId: input.claimId,
        kind: input.kind,
        ref,
        ...(input.locator === undefined ? {} : { locator: input.locator }),
        ...(input.quote === undefined ? {} : { quote: input.quote }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return {
        ok: true,
        evidence,
        claim: this.repo.get(input.claimId),
        reason: null,
        advice: existence.advice,
      };
    } catch (err) {
      return {
        ok: false,
        evidence: null,
        claim,
        reason: err instanceof Error ? err.message : String(err),
        advice: null,
      };
    }
  }

  /** 校验证据指向的东西是否存在。 */
  #checkExistence(
    kind: ClaimEvidenceKind,
    ref: string,
  ): { ok: true; advice: string | null } | { ok: false; reason: string; advice: string | null } {
    switch (kind) {
      case 'artifact-version': {
        const exists = this.#deps.artifactExists;
        if (exists === undefined) {
          return { ok: true, advice: '未校验制品版本是否存在（本实例没有接制品库）。' };
        }
        if (!exists(ref)) {
          return {
            ok: false,
            reason:
              `制品版本不存在：${ref}。\n` +
              '不要凭记忆写版本 id——用 save_artifacts 的返回值。' +
              '指向一个不存在的版本会让这条断言在计数上「有证据」而实际无从核对。',
            advice: null,
          };
        }
        return { ok: true, advice: null };
      }

      case 'ref': {
        const exists = this.#deps.refExists;
        if (exists === undefined) {
          return { ok: true, advice: '未校验文献条目是否存在（本实例没有接文献库）。' };
        }
        if (!exists(ref)) {
          return {
            ok: false,
            reason:
              `文献条目不存在：${ref}。先用 manage_references 的 resolve 把它入库，` +
              '再用返回的 rf_ 开头的 id 绑定。',
            advice: null,
          };
        }
        return { ok: true, advice: null };
      }

      case 'quote': {
        // quote 的 ref 指向文献或制品，两种都要认
        if (ref.startsWith('rf_')) {
          const exists = this.#deps.refExists;
          if (exists !== undefined && !exists(ref)) {
            return { ok: false, reason: `文献条目不存在：${ref}`, advice: null };
          }
        } else {
          const exists = this.#deps.artifactExists;
          if (exists !== undefined && !exists(ref)) {
            return { ok: false, reason: `制品版本不存在：${ref}`, advice: null };
          }
        }
        return { ok: true, advice: null };
      }

      case 'doi': {
        /*
         * 裸 DOI 是弱证据：它只证明有这么一篇文献，证明不了它支持这个断言。
         * 库里已有对应条目时建议升级——那条记录带元数据、可能带全文，能真的去核对。
         */
        const byDoi = this.#deps.refIdByDoi;
        const refId = byDoi === undefined ? null : byDoi(ref);
        if (refId !== null) {
          return {
            ok: true,
            advice:
              `这个 DOI 已在文献库里（${refId}）。改用 kind='ref' 指向它更好：` +
              '文献条目带元数据与全文，核验时能真的读到内容；裸 DOI 只能证明这篇文献存在。',
          };
        }
        return {
          ok: true,
          advice:
            '裸 DOI 是弱证据——它证明这篇文献存在，证明不了它支持这条断言。' +
            '建议先用 manage_references 入库并抓全文，再用 quote 类给出支持该断言的原文片段。',
        };
      }

      case 'compute': {
        const exists = this.#deps.computeExists;
        if (exists === undefined) return { ok: true, advice: null };
        if (!exists(ref)) {
          return {
            ok: false,
            reason:
              `找不到这个计算单元：${ref}。compute 类的引用应当是一次真实执行的工具调用 id，` +
              '或者是带生成代码的制品版本 id。',
            advice: null,
          };
        }
        return { ok: true, advice: null };
      }

      default:
        return { ok: true, advice: null };
    }
  }

  unbind(
    claimId: string,
    kind: ClaimEvidenceKind,
    ref: string,
  ): { ok: boolean; reason: string | null } {
    const removed = this.repo.unbindEvidence(claimId, kind, ref);
    if (!removed) return { ok: false, reason: '这条证据不存在' };
    this.#deriveStatus(claimId);
    return { ok: true, reason: null };
  }

  /* ---------------- 核验 ---------------- */

  /**
   * 记录核验结论并推导断言状态（需求 13.4）。
   *
   * `modelId` 是必填的：只有结论没有执行者时，半年后回看无法判断这个结论的可信度。
   * 用户手工判定时传一个明确的标识（`user:manual`），而不是留空——留空与
   * 「一个未知的模型说的」在库里长得一样。
   */
  verify(input: {
    claimId: string;
    kind: ClaimEvidenceKind;
    ref: string;
    verdict: ClaimVerdict;
    modelId: string;
    note?: string | null;
  }): { ok: boolean; claim: ClaimRecord | null; reason: string | null } {
    const claim = this.repo.get(input.claimId);
    if (claim === null) {
      return { ok: false, claim: null, reason: `断言不存在：${input.claimId}` };
    }

    /*
     * 引文支撑陈述的 supports 结论必须有真的经过检索的核实记录（需求 13.9）。
     *
     * 这是「禁止凭记忆作答」这条要求在数据层的实现。提示词里写「不要凭记忆回答」
     * 只是让模型在幻觉之外多加一句「我已核实」；而这里的判据是可查的事实：
     * `citation_checks` 里有没有一条挂在这个断言上、且真的发出过查询的记录。
     *
     * 只挡 `supports`。`contradicts` 与 `insufficient` 不挡：模型判断「这条引文
     * 不支持该断言」不需要先证明那篇文献存在，而挡住它会让一个正确的否定结论
     * 无法被记录。
     */
    if (input.verdict === 'supports' && claim.kinds.includes('citation')) {
      const backed = this.repo.hasRetrievalBackedCheck(input.claimId);
      if (!backed) {
        return {
          ok: false,
          claim,
          reason:
            '这是一条引文支撑陈述，而它还没有经过检索取证的核实记录。\n' +
            '需求 13.9 规定引文核实必须经由检索工具取证，不能凭记忆作答——' +
            '因此这里不接受一个没有检索记录支撑的「支持」结论。\n' +
            `先用 verify_citations 核实这条引文（claimId=${input.claimId}），` +
            '它会真的去 Crossref / OpenAlex / Semantic Scholar / Europe PMC 查一遍并留下记录。',
        };
      }
    }

    let recorded: boolean;
    try {
      recorded = this.repo.recordVerdict({
        claimId: input.claimId,
        kind: input.kind,
        ref: input.ref,
        verdict: input.verdict,
        modelId: input.modelId,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
    } catch (err) {
      return { ok: false, claim, reason: err instanceof Error ? err.message : String(err) };
    }

    if (!recorded) {
      return {
        ok: false,
        claim,
        reason:
          `这条断言上没有 ${EVIDENCE_KIND_LABEL[input.kind]} = ${input.ref} 的证据。` +
          '先绑定证据再记录核验结论。',
      };
    }

    this.#deriveStatus(input.claimId);
    return { ok: true, claim: this.repo.get(input.claimId), reason: null };
  }

  /**
   * 由证据的核验结论推导断言状态。
   *
   * 规则的顺序就是严重度：**一条矛盾压倒任意多条支持**。三条证据支持、一条矛盾时
   * 结论是 `refuted` 而不是「多数支持」——那一条矛盾意味着要么某处算错了，要么
   * 断言表述过强，两种都必须处理。取多数会把这个信号抹掉。
   *
   * 用户手工设的 `retracted` / `dismissed` 不被推导覆盖：那是关于「这条断言要不要
   * 核验」的决定，不是关于它对不对的判断。
   */
  #deriveStatus(claimId: string): ClaimStatus | null {
    const claim = this.repo.get(claimId);
    if (claim === null) return null;
    if (claim.status === 'retracted' || claim.status === 'dismissed') return claim.status;

    const verdicts = claim.evidence
      .map((e) => e.verdict)
      .filter((v): v is ClaimVerdict => v !== null);

    let next: ClaimStatus;
    if (verdicts.includes('contradicts')) next = 'refuted';
    else if (verdicts.includes('supports')) next = 'supported';
    else if (verdicts.includes('insufficient')) next = 'insufficient';
    else next = 'open';

    if (next !== claim.status) this.repo.setStatus(claimId, next);
    return next;
  }

  /** 手工关闭一条断言。 */
  close(
    claimId: string,
    status: 'retracted' | 'dismissed',
    note: string,
  ): { ok: boolean; claim: ClaimRecord | null; reason: string | null } {
    if (note.trim() === '') {
      return {
        ok: false,
        claim: null,
        reason:
          '关闭断言必须说明理由。没有理由的关闭在事后无法与「漏掉了」区分，' +
          '而这份记录的用途正是事后追溯。',
      };
    }
    const claim = this.repo.get(claimId);
    if (claim === null) return { ok: false, claim: null, reason: `断言不存在：${claimId}` };
    this.repo.setStatus(claimId, status, note.trim());
    return { ok: true, claim: this.repo.get(claimId), reason: null };
  }

  /** 重新打开。核验结论保留——它们是历史，不该因为重新打开而消失。 */
  reopen(
    claimId: string,
    note: string,
  ): { ok: boolean; claim: ClaimRecord | null; reason: string | null } {
    const claim = this.repo.get(claimId);
    if (claim === null) return { ok: false, claim: null, reason: `断言不存在：${claimId}` };
    this.repo.setStatus(claimId, 'open', note.trim() === '' ? null : note.trim());
    // 立刻按现有证据重算一次：重新打开之后状态应当反映已有的核验结论
    this.#deriveStatus(claimId);
    return { ok: true, claim: this.repo.get(claimId), reason: null };
  }

  /* ---------------- 汇总与渲染 ---------------- */

  summary(
    scope: { manuscriptId?: string | null; conversationId?: string } = {},
  ): ReturnType<ClaimsRepo['summary']> {
    return this.repo.summary(scope);
  }

  /**
   * 未关闭且无证据的断言（需求 13.3 的判定对象）。
   *
   * 按 `origin` 分成两组返回：确认过的进 FAIL，自动抽取的进 WARN。这个区分是
   * 让 FAIL 保持可信的唯一办法。
   */
  unsupported(scope: { manuscriptId?: string | null; conversationId?: string } = {}): {
    confirmed: readonly ClaimRecord[];
    extracted: readonly ClaimRecord[];
  } {
    const all = this.repo.list({
      ...scope,
      status: 'unresolved',
      unsupportedOnly: true,
      limit: 500,
    });
    return {
      confirmed: all.filter((c) => c.origin !== 'extracted'),
      extracted: all.filter((c) => c.origin === 'extracted'),
    };
  }

  /** 证据矛盾的断言。它们比无证据更严重：手稿里有一句已知错误的陈述。 */
  refuted(
    scope: { manuscriptId?: string | null; conversationId?: string } = {},
  ): readonly ClaimRecord[] {
    return this.repo.list({ ...scope, status: 'refuted', limit: 500 });
  }

  /** 渲染成给模型与用户看的文本。 */
  render(
    claims: readonly ClaimRecord[],
    options: { limit?: number; showEvidence?: boolean } = {},
  ): string {
    const limit = options.limit ?? 30;
    const lines: string[] = [];

    for (const claim of claims.slice(0, limit)) {
      const tags = [
        CLAIM_KIND_LABEL[claim.kind],
        claim.origin === 'extracted' ? '自动抽取' : claim.origin === 'user' ? '已确认' : '模型登记',
      ];
      lines.push(
        `- ${claim.id}　[${tags.join('/')}]　${claim.locator ?? '（无定位）'}　状态 ${claim.status}`,
      );
      lines.push(`    ${claim.text.slice(0, 240)}`);
      if (claim.numbers.length > 0) {
        lines.push(`    数值：${claim.numbers.join('、')}`);
      }
      if (options.showEvidence !== false) {
        if (claim.evidence.length === 0) {
          lines.push('    证据：无');
        } else {
          for (const evidence of claim.evidence) {
            const verdict =
              evidence.verdict === null
                ? '未核验'
                : `${evidence.verdict}（${evidence.verifiedByModelId ?? '未记录模型'}）`;
            lines.push(
              `    证据：${EVIDENCE_KIND_LABEL[evidence.kind]} ${evidence.ref}` +
                `${evidence.locator === null ? '' : ` @${evidence.locator}`}　${verdict}`,
            );
          }
        }
      }
    }

    if (claims.length > limit) {
      lines.push(`… 还有 ${String(claims.length - limit)} 条。`);
    }
    return lines.join('\n');
  }

  /** 一句话状态，用于「能不能宣称完成」的自检。 */
  gateSummary(scope: { manuscriptId?: string | null; conversationId?: string } = {}): string {
    const s = this.summary(scope);
    if (s.total === 0) return 'Claim Ledger 里还没有登记任何断言。';

    const parts = [
      `共 ${String(s.total)} 条断言`,
      `未关闭 ${String(s.unresolved)}`,
      `无证据 ${String(s.unsupported)}`,
      `证据矛盾 ${String(s.refuted)}`,
      `已支持 ${String(s.supported)}`,
    ];
    const confirmedUnsupported = this.unsupported(scope).confirmed.length;
    const tail =
      s.blocking === 0
        ? '没有阻断项。'
        : `**${String(s.blocking)} 条阻断项**（无证据或证据矛盾），在它们处理完之前不应宣称手稿完成。` +
          (confirmedUnsupported > 0
            ? `${UNSUPPORTED_CONFIRMED_FACT}。${UNSUPPORTED_CONFIRMED_CTA}。`
            : '');
    return `${parts.join('，')}。${tail}`;
  }
}

/** 未关闭状态的集合，供确定性检查复用。 */
export { OPEN_CLAIM_STATUSES };
