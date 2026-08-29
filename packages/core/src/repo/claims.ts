/**
 * Claim Ledger 仓储（任务 13.4，需求 13.1-13.4）。
 *
 * 两条硬约束写在这一层，因为它们是这套机制的全部价值所在：
 *
 * 1. **证据必须能指到具体的东西**（需求 13.2）。`evidence_ref` 不允许为空，
 *    kind 与 ref 的形状要匹配（artifact-version 的 ref 必须像版本 id）。
 *    一条「有证据」但指向空串的绑定比没有证据更糟：它让 FAIL 级检查放过这条断言，
 *    而检查通过会被理解为「核对过了」。
 *
 * 2. **核验结论必须带模型标识**（需求 13.4）。`verdict` 与 `verified_by_model_id`
 *    要么都有要么都没有。只有结论没有执行者时，半年后回看无法判断这个结论的可信度
 *    ——是一个强模型仔细读了全文，还是一个小模型看了标题就说「支持」。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';
import type { ClaimKind } from '../manuscript/extract.js';

/**
 * 断言状态。
 *
 * 「未关闭」是需求 13.3 的判定依据，含 `open`、`insufficient`、`refuted` 三种：
 *
 * - `refuted` 算未关闭是刻意的。证据与断言矛盾意味着**手稿必须改**，把它当成
 *   「处理完了」会让一条已知错误的陈述留在正文里，而 Claim Ledger 的记录看起来
 *   一切正常。
 * - `insufficient` 同理：有证据但不足以支持，事情没完。
 * - `retracted` 是关闭的：作者把这句话从手稿里删了，它不再需要证据。
 * - `dismissed` 是关闭的：判定为无需核验（例如它其实是背景陈述而不是本文结论）。
 */
export type ClaimStatus =
  'open' | 'supported' | 'insufficient' | 'refuted' | 'retracted' | 'dismissed';

export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = ['open', 'insufficient', 'refuted'];

export const CLAIM_STATUS_LABEL: Readonly<Record<ClaimStatus, string>> = {
  open: '待核验',
  supported: '证据支持',
  insufficient: '证据不足',
  refuted: '证据矛盾',
  retracted: '已撤回',
  dismissed: '无需核验',
};

/**
 * 断言的来源。
 *
 * `extracted` 与另两种在 FAIL 判定上被区别对待（见 `manuscript/ledger.ts`）：
 * 自动抽取未经人确认，其中必然混着方法学描述这类不需要证据的句子。把它们
 * 与用户明确写下的断言同等对待会让 FAIL 级发现里塞满误抽，而一旦开始忽略 FAIL，
 * 整套机制就失效了。
 */
export type ClaimOrigin = 'extracted' | 'model' | 'user';

export const CLAIM_ORIGIN_LABEL: Readonly<Record<ClaimOrigin, string>> = {
  extracted: '自动抽取',
  model: '模型登记',
  user: '用户登记',
};

/**
 * 证据类型（需求 13.2）。
 *
 * 需求点名要求 artifact 版本、DOI 与可复现计算单元三类。这里多两类：
 *
 * - `ref` 比裸 `doi` 强：它指向文献库里的一条记录，因此带着元数据、可能带着全文，
 *   核验时能真的去读。裸 DOI 只能证明「有这么一篇文献」，证明不了它支持这个断言。
 * - `quote` 指向全文里的一段原文，是引文支撑陈述唯一真正能核验的形态。
 */
export type ClaimEvidenceKind =
  'artifact-version' | 'ref' | 'doi' | 'compute' | 'quote' | 'message';

export const EVIDENCE_KIND_LABEL: Readonly<Record<ClaimEvidenceKind, string>> = {
  'artifact-version': '制品版本',
  ref: '文献条目',
  doi: 'DOI',
  compute: '计算单元',
  quote: '原文引述',
  message: '会话消息',
};

/** 核验结论（需求 13.4）。 */
export type ClaimVerdict = 'supports' | 'contradicts' | 'insufficient' | 'unrelated';

export const VERDICT_LABEL: Readonly<Record<ClaimVerdict, string>> = {
  supports: '支持',
  contradicts: '矛盾',
  insufficient: '不足',
  unrelated: '无关',
};

export interface ClaimEvidence {
  claimId: string;
  kind: ClaimEvidenceKind;
  /** 指向的东西：版本 id、文献 id、DOI、工具调用 id。 */
  ref: string;
  /** 在证据内部的位置：页码、表格单元、行号区间。 */
  locator: string | null;
  /** 支持该断言的原文片段。`quote` 类必填。 */
  quote: string | null;
  note: string | null;
  verdict: ClaimVerdict | null;
  /** 执行核验的模型（需求 13.4）。verdict 非空时必须有。 */
  verifiedByModelId: string | null;
  verifiedAt: number | null;
  createdAt: number;
}

export interface ClaimRecord {
  id: string;
  manuscriptId: string | null;
  conversationId: string | null;
  locator: string | null;
  section: string | null;
  text: string;
  kind: ClaimKind;
  kinds: readonly ClaimKind[];
  /** 句子里的数值表达式。核验时明确摆给模型。 */
  numbers: readonly string[];
  status: ClaimStatus;
  origin: ClaimOrigin;
  note: string | null;
  createdAt: number;
  updatedAt: number | null;
  evidence: readonly ClaimEvidence[];
}

interface ClaimRow {
  id: string;
  manuscript_id: string | null;
  conversation_id: string | null;
  locator: string | null;
  section: string | null;
  text: string;
  kind: string;
  kinds_json: string | null;
  numbers_json: string | null;
  status: string;
  origin: string;
  note: string | null;
  created_at: number;
  updated_at: number | null;
}

interface EvidenceRow {
  claim_id: string;
  evidence_kind: string;
  evidence_ref: string;
  locator: string | null;
  quote: string | null;
  note: string | null;
  verdict: string | null;
  verified_by_model_id: string | null;
  verified_at: number | null;
  created_at: number | null;
}

function parseList(text: string | null, fallback: readonly string[] = []): readonly string[] {
  if (text === null) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // 单条记录的辅助字段损坏不该让整个断言读不出来
    return fallback;
  }
}

function toEvidence(row: EvidenceRow): ClaimEvidence {
  return {
    claimId: row.claim_id,
    kind: row.evidence_kind as ClaimEvidenceKind,
    ref: row.evidence_ref,
    locator: row.locator,
    quote: row.quote,
    note: row.note,
    verdict: row.verdict as ClaimVerdict | null,
    verifiedByModelId: row.verified_by_model_id,
    verifiedAt: row.verified_at,
    // M001 建表时没有这一列，M007 补的，旧行为 null。退回 0 而不是当前时间：
    // 当前时间会让一条老记录看起来是刚建的
    createdAt: row.created_at ?? 0,
  };
}

/** 各类证据 ref 的形状要求。写错 kind 是最常见的错误，而它会让核验去查错的地方。 */
const REF_SHAPE: Readonly<Record<ClaimEvidenceKind, { re: RegExp; hint: string }>> = {
  'artifact-version': {
    re: /^av_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    hint: '制品版本 id 形如 av_xxxxxxxx-xxxx-...，来自 save_artifacts 的返回值',
  },
  ref: {
    re: /^rf_[0-9a-f-]{8,}$/iu,
    hint: '文献条目 id 形如 rf_...，来自 manage_references',
  },
  doi: {
    re: /^10\.\d{4,9}\/\S+$/u,
    hint: 'DOI 形如 10.1038/xxx。更好的做法是先用 manage_references 入库再用 ref 类',
  },
  compute: {
    re: /^[\w:./-]{4,200}$/u,
    hint: '计算单元用工具调用 id 或制品版本 id',
  },
  quote: {
    re: /^rf_[0-9a-f-]{8,}$|^av_[0-9a-f-]{8,}$/iu,
    hint: 'quote 类的 ref 指向被引述的文献条目或制品版本，原文放在 quote 字段',
  },
  message: {
    re: /^[\w-]{8,200}$/u,
    hint: '消息 id',
  },
};

export class ClaimsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toClaim(row: ClaimRow): ClaimRecord {
    const kinds = parseList(row.kinds_json, [row.kind]) as readonly ClaimKind[];
    return {
      id: row.id,
      manuscriptId: row.manuscript_id,
      conversationId: row.conversation_id,
      locator: row.locator,
      section: row.section,
      text: row.text,
      kind: row.kind as ClaimKind,
      kinds: kinds.length === 0 ? [row.kind as ClaimKind] : kinds,
      numbers: parseList(row.numbers_json),
      status: row.status as ClaimStatus,
      origin: row.origin as ClaimOrigin,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence: this.evidence(row.id),
    };
  }

  /* ---------------- 写入 ---------------- */

  add(input: {
    text: string;
    kind: ClaimKind;
    kinds?: readonly ClaimKind[];
    numbers?: readonly string[];
    manuscriptId?: string | null;
    conversationId?: string | null;
    locator?: string | null;
    section?: string | null;
    origin?: ClaimOrigin;
    note?: string | null;
    status?: ClaimStatus;
  }): ClaimRecord {
    const text = input.text.trim();
    if (text === '') throw new Error('断言文本不能为空');
    if (text.length > 4000) {
      throw new Error(
        `断言文本 ${String(text.length)} 字符，超过 4000 上限。` +
          '一条断言应当是一句可核查的陈述；如果它有几千字，那是一段论述，请拆开。',
      );
    }

    const id = `cl_${randomUUID()}`;
    const now = Date.now();

    this.#db
      .prepare(
        `INSERT INTO claims
           (id, manuscript_id, conversation_id, locator, section, text, kind, kinds_json,
            numbers_json, status, origin, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.manuscriptId ?? null,
        input.conversationId ?? null,
        input.locator ?? null,
        input.section ?? null,
        text,
        input.kind,
        JSON.stringify(input.kinds ?? [input.kind]),
        JSON.stringify(input.numbers ?? []),
        input.status ?? 'open',
        input.origin ?? 'model',
        input.note ?? null,
        now,
        now,
      );

    const created = this.get(id);
    if (created === null) throw new Error('断言创建后读取失败');
    return created;
  }

  /**
   * 绑定一条证据（需求 13.2）。
   *
   * kind 与 ref 的形状必须匹配。放行形状不符的绑定会造成一个静默失败：
   * 核验时按 kind 去对应的库里查，查不到，于是这条证据永远是「未核验」，
   * 而断言在计数上已经「有证据」了——FAIL 检查因此放过它。
   */
  bindEvidence(input: {
    claimId: string;
    kind: ClaimEvidenceKind;
    ref: string;
    locator?: string | null;
    quote?: string | null;
    note?: string | null;
  }): ClaimEvidence {
    if (this.get(input.claimId) === null) {
      throw new Error(`断言不存在：${input.claimId}`);
    }

    const ref = input.ref.trim();
    if (ref === '') {
      throw new Error(
        '证据必须指向具体的东西。空的引用会让这条断言在计数上「有证据」而实际无从核对，' +
          '那比没有证据更糟——它让检查放过它。',
      );
    }

    const shape = REF_SHAPE[input.kind];
    if (shape !== undefined && !shape.re.test(ref)) {
      throw new Error(`证据类型 ${input.kind} 的引用格式不对：${ref}。${shape.hint}`);
    }

    const quote = input.quote?.trim() ?? null;
    if (input.kind === 'quote' && (quote === null || quote === '')) {
      throw new Error('quote 类证据必须给出原文片段，否则无法核对它是否真的支持该断言');
    }

    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO claim_evidence
           (claim_id, evidence_kind, evidence_ref, locator, quote, note, verdict,
            verified_by_model_id, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
         ON CONFLICT (claim_id, evidence_kind, evidence_ref) DO UPDATE SET
           locator = COALESCE(excluded.locator, claim_evidence.locator),
           quote   = COALESCE(excluded.quote, claim_evidence.quote),
           note    = COALESCE(excluded.note, claim_evidence.note)`,
      )
      .run(input.claimId, input.kind, ref, input.locator ?? null, quote, input.note ?? null, now);

    this.#touch(input.claimId);

    const row = this.#db
      .prepare(
        'SELECT * FROM claim_evidence WHERE claim_id = ? AND evidence_kind = ? AND evidence_ref = ?',
      )
      .get(input.claimId, input.kind, ref) as EvidenceRow | undefined;
    if (row === undefined) throw new Error('证据写入后读取失败');
    return toEvidence(row);
  }

  /**
   * 记录核验结论（需求 13.4）。
   *
   * `modelId` 必填。只有结论没有执行者时，半年后回看无法判断这个结论的可信度——
   * 是一个强模型读了全文，还是一个小模型看了标题。这个区别在追溯时是决定性的。
   */
  recordVerdict(input: {
    claimId: string;
    kind: ClaimEvidenceKind;
    ref: string;
    verdict: ClaimVerdict;
    modelId: string;
    note?: string | null;
  }): boolean {
    if (input.modelId.trim() === '') {
      throw new Error('核验结论必须记录执行核验的模型标识（需求 13.4）');
    }

    const changed =
      this.#db
        .prepare(
          `UPDATE claim_evidence
             SET verdict = ?, verified_by_model_id = ?, verified_at = ?,
                 note = COALESCE(?, note)
           WHERE claim_id = ? AND evidence_kind = ? AND evidence_ref = ?`,
        )
        .run(
          input.verdict,
          input.modelId.trim(),
          Date.now(),
          input.note ?? null,
          input.claimId,
          input.kind,
          input.ref.trim(),
        ).changes > 0;

    if (changed) this.#touch(input.claimId);
    return changed;
  }

  unbindEvidence(claimId: string, kind: ClaimEvidenceKind, ref: string): boolean {
    const changed =
      this.#db
        .prepare(
          'DELETE FROM claim_evidence WHERE claim_id = ? AND evidence_kind = ? AND evidence_ref = ?',
        )
        .run(claimId, kind, ref.trim()).changes > 0;
    if (changed) this.#touch(claimId);
    return changed;
  }

  /**
   * 把自动抽取的断言提升为已确认。
   *
   * 只有这一个方向（extracted → user），没有反向的通用 origin setter。理由是
   * `origin` 决定这条断言无证据时开 FAIL 还是 WARN——一个能任意改它的方法等于
   * 让调用方自己决定要不要被 FAIL 挡住。`WHERE origin = 'extracted'` 让重复调用
   * 无副作用，也让「用户登记的断言被降级成自动抽取」不可能发生。
   */
  promoteOrigin(id: string, note?: string | null): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE claims SET origin = 'user', note = COALESCE(?, note), updated_at = ?
           WHERE id = ? AND origin = 'extracted'`,
        )
        .run(note ?? null, Date.now(), id).changes > 0
    );
  }

  setStatus(id: string, status: ClaimStatus, note?: string | null): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE claims SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
        )
        .run(status, note ?? null, Date.now(), id).changes > 0
    );
  }

  /** 改断言文本。手稿改了之后要跟着改，否则 ledger 里记的是旧句子。 */
  updateText(
    id: string,
    text: string,
    extra: { locator?: string | null; section?: string | null } = {},
  ): boolean {
    const trimmed = text.trim();
    if (trimmed === '') throw new Error('断言文本不能为空');
    return (
      this.#db
        .prepare(
          `UPDATE claims SET text = ?, locator = COALESCE(?, locator),
             section = COALESCE(?, section), updated_at = ? WHERE id = ?`,
        )
        .run(trimmed, extra.locator ?? null, extra.section ?? null, Date.now(), id).changes > 0
    );
  }

  attachToManuscript(id: string, manuscriptId: string | null): boolean {
    return (
      this.#db
        .prepare('UPDATE claims SET manuscript_id = ?, updated_at = ? WHERE id = ?')
        .run(manuscriptId, Date.now(), id).changes > 0
    );
  }

  delete(id: string): boolean {
    // claim_evidence 有 ON DELETE CASCADE，证据跟着走
    return this.#db.prepare('DELETE FROM claims WHERE id = ?').run(id).changes > 0;
  }

  #touch(id: string): void {
    this.#db.prepare('UPDATE claims SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /* ---------------- 查询 ---------------- */

  get(id: string): ClaimRecord | null {
    const row = this.#db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as
      ClaimRow | undefined;
    return row === undefined ? null : this.#toClaim(row);
  }

  evidence(claimId: string): readonly ClaimEvidence[] {
    return (
      this.#db
        .prepare(
          'SELECT * FROM claim_evidence WHERE claim_id = ? ORDER BY evidence_kind, evidence_ref',
        )
        .all(claimId) as EvidenceRow[]
    ).map(toEvidence);
  }

  /**
   * 按同一条文本查已有断言。
   *
   * 重复抽取同一份手稿时用它去重。比对的是折叠空白后的原文而不是相似度：
   * 断言是逐字的陈述，「差不多的句子」是另一条断言。
   */
  findByText(
    text: string,
    scope: { manuscriptId?: string | null; conversationId?: string | null } = {},
  ): ClaimRecord | null {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    const clauses = ['text = ?'];
    const params: unknown[] = [normalized];

    if (scope.manuscriptId !== undefined) {
      if (scope.manuscriptId === null) clauses.push('manuscript_id IS NULL');
      else {
        clauses.push('manuscript_id = ?');
        params.push(scope.manuscriptId);
      }
    }
    if (scope.conversationId !== undefined && scope.conversationId !== null) {
      clauses.push('conversation_id = ?');
      params.push(scope.conversationId);
    }

    const row = this.#db
      .prepare(`SELECT * FROM claims WHERE ${clauses.join(' AND ')} LIMIT 1`)
      .get(...params) as ClaimRow | undefined;
    return row === undefined ? null : this.#toClaim(row);
  }

  list(
    options: {
      manuscriptId?: string | null;
      conversationId?: string;
      /** 省略时返回未关闭的（open + insufficient + refuted）。 */
      status?: ClaimStatus | 'unresolved' | 'all';
      kind?: ClaimKind;
      origin?: ClaimOrigin;
      /** 只要没有任何证据的。 */
      unsupportedOnly?: boolean;
      limit?: number;
    } = {},
  ): readonly ClaimRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.manuscriptId !== undefined) {
      if (options.manuscriptId === null) clauses.push('manuscript_id IS NULL');
      else {
        clauses.push('manuscript_id = ?');
        params.push(options.manuscriptId);
      }
    }
    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.origin !== undefined) {
      clauses.push('origin = ?');
      params.push(options.origin);
    }

    const status = options.status ?? 'unresolved';
    if (status === 'unresolved') {
      clauses.push(`status IN (${OPEN_CLAIM_STATUSES.map(() => '?').join(', ')})`);
      params.push(...OPEN_CLAIM_STATUSES);
    } else if (status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }

    if (options.unsupportedOnly === true) {
      clauses.push(
        'NOT EXISTS (SELECT 1 FROM claim_evidence WHERE claim_evidence.claim_id = claims.id)',
      );
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(options.limit ?? 200, 1000)));

    return (
      this.#db
        .prepare(
          `SELECT * FROM claims${where}
           ORDER BY CASE status
                      WHEN 'refuted' THEN 0
                      WHEN 'open' THEN 1
                      WHEN 'insufficient' THEN 2
                      ELSE 3
                    END,
                    created_at, rowid
           LIMIT ?`,
        )
        .all(...params) as ClaimRow[]
    ).map((r) => this.#toClaim(r));
  }

  /**
   * 汇总。
   *
   * `blocking` 是「未关闭且无证据」加「证据矛盾」的数量——它非零时不该宣称手稿完成。
   * 与 findings 的 summary 同构，让两处的「还剩多少事」读起来一致。
   */
  summary(scope: { manuscriptId?: string | null; conversationId?: string } = {}): {
    total: number;
    unresolved: number;
    unsupported: number;
    refuted: number;
    insufficient: number;
    supported: number;
    blocking: number;
    byKind: Readonly<Record<string, number>>;
    byOrigin: Readonly<Record<string, number>>;
  } {
    const all = this.list({ ...scope, status: 'all', limit: 1000 });

    const byKind: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    let unresolved = 0;
    let unsupported = 0;
    let refuted = 0;
    let insufficient = 0;
    let supported = 0;

    for (const claim of all) {
      byKind[claim.kind] = (byKind[claim.kind] ?? 0) + 1;
      byOrigin[claim.origin] = (byOrigin[claim.origin] ?? 0) + 1;

      const open = (OPEN_CLAIM_STATUSES as readonly string[]).includes(claim.status);
      if (open) unresolved += 1;
      if (open && claim.evidence.length === 0) unsupported += 1;
      if (claim.status === 'refuted') refuted += 1;
      if (claim.status === 'insufficient') insufficient += 1;
      if (claim.status === 'supported') supported += 1;
    }

    return {
      total: all.length,
      unresolved,
      unsupported,
      refuted,
      insufficient,
      supported,
      blocking: unsupported + refuted,
      byKind,
      byOrigin,
    };
  }

  /** 引用了某个制品版本 / 文献条目的全部断言。删制品前要用它警告用户。 */
  claimsCiting(kind: ClaimEvidenceKind, ref: string): readonly ClaimRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT claims.* FROM claims
             JOIN claim_evidence ON claim_evidence.claim_id = claims.id
           WHERE claim_evidence.evidence_kind = ? AND claim_evidence.evidence_ref = ?
           ORDER BY claims.created_at`,
        )
        .all(kind, ref.trim()) as ClaimRow[]
    ).map((r) => this.#toClaim(r));
  }
}
