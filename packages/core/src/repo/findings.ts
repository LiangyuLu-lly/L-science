/**
 * Reviewer 运行与 findings 仓储（任务 12.7、12.8，需求 11.4-11.8）。
 *
 * 两条设计约束直接来自需求：
 *
 * 1. **每条 finding 必须关联到具体证据**（需求 11.8）。无指向的泛泛发现（「统计方法
 *    需要复核」）对用户毫无帮助，他无从判断说的是哪一处，也无从修。因此 `evidence`
 *    是必填且非空的。
 * 2. **「已自报待复核」是独立状态**（需求 11.7）。agent 说它修好了不等于修好了；
 *    直接关闭会让一次错误的自我判断永久掩盖问题。它只能把 finding 推进到
 *    `claimed-fixed`，由下一轮审查确认或重新提出。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';

/** WARN 不打断主 agent，FAIL 打断（需求 11.5）。 */
export type FindingSeverity = 'warn' | 'fail';

/** 检查类别（需求 11.4）。 */
export type FindingCategory =
  'evidence' | 'statistics' | 'reproducibility' | 'consistency' | 'integrity';

export type FindingStatus = 'open' | 'claimed-fixed' | 'resolved' | 'dismissed';

/** 证据指向。三种之一必须给出具体 id。 */
export interface FindingEvidence {
  kind: 'artifact-version' | 'message' | 'claim' | 'plan-step';
  id: string;
  /** 为什么这条证据支持该发现。 */
  note?: string;
}

export interface Finding {
  id: string;
  conversationId: string;
  reviewerRunId: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string | null;
  evidence: readonly FindingEvidence[];
  status: FindingStatus;
  addressedNote: string | null;
  addressedAt: number | null;
  createdAt: number;
}

export type ReviewerTrigger = 'turn-end' | 'artifact-saved' | 'pre-compile' | 'user-request';

export type ReviewerRunStatus = 'running' | 'done' | 'failed' | 'degraded';

export interface ReviewerRun {
  id: string;
  conversationId: string;
  trigger: ReviewerTrigger;
  /** 执行审查的模型。强制异厂商（需求 11.2），这一列是可核查的凭据。 */
  modelId: string;
  status: ReviewerRunStatus;
  summary: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

interface FindingRow {
  id: string;
  conversation_id: string;
  reviewer_run_id: string | null;
  severity: string;
  category: string;
  title: string;
  detail: string | null;
  evidence_json: string | null;
  status: string;
  addressed_note: string | null;
  addressed_at: number | null;
  created_at: number;
}

interface RunRow {
  id: string;
  conversation_id: string;
  trigger: string;
  model_id: string;
  status: string;
  summary: string | null;
  started_at: number | null;
  ended_at: number | null;
}

function toFinding(row: FindingRow): Finding {
  let evidence: FindingEvidence[] = [];
  if (row.evidence_json !== null) {
    try {
      const parsed = JSON.parse(row.evidence_json) as unknown;
      if (Array.isArray(parsed)) evidence = parsed as FindingEvidence[];
    } catch {
      // 单条证据损坏不该让整个 findings 列表读不出来
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    reviewerRunId: row.reviewer_run_id,
    severity: row.severity as FindingSeverity,
    category: row.category as FindingCategory,
    title: row.title,
    detail: row.detail,
    evidence,
    status: row.status as FindingStatus,
    addressedNote: row.addressed_note,
    addressedAt: row.addressed_at,
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): ReviewerRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    trigger: row.trigger as ReviewerTrigger,
    modelId: row.model_id,
    status: row.status as ReviewerRunStatus,
    summary: row.summary,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export class FindingsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- Reviewer 运行 ---------------- */

  startRun(input: {
    conversationId: string;
    trigger: ReviewerTrigger;
    modelId: string;
  }): ReviewerRun {
    const id = `rr_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO reviewer_runs
           (id, conversation_id, trigger, model_id, status, summary, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(id, input.conversationId, input.trigger, input.modelId, Date.now());

    const run = this.getRun(id);
    if (run === null) throw new Error('审查记录创建后读取失败');
    return run;
  }

  finishRun(
    id: string,
    result: { status: Exclude<ReviewerRunStatus, 'running'>; summary?: string | null },
  ): boolean {
    return (
      this.#db
        .prepare('UPDATE reviewer_runs SET status = ?, summary = ?, ended_at = ? WHERE id = ?')
        .run(result.status, result.summary ?? null, Date.now(), id).changes > 0
    );
  }

  getRun(id: string): ReviewerRun | null {
    const row = this.#db.prepare('SELECT * FROM reviewer_runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  /** 某会话的审查历史，最新在前。次级排序用 rowid：同毫秒触发时按插入序。 */
  runs(conversationId: string, limit = 20): readonly ReviewerRun[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM reviewer_runs WHERE conversation_id = ?
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(conversationId, limit) as RunRow[]
    ).map(toRun);
  }

  /** 上一次未完成的审查。进程重启后用它把僵死记录标掉。 */
  abandonStaleRuns(): number {
    return this.#db
      .prepare(
        `UPDATE reviewer_runs SET status = 'failed', summary = '后端重启，本次审查未完成',
           ended_at = ? WHERE status = 'running'`,
      )
      .run(Date.now()).changes;
  }

  /* ---------------- findings ---------------- */

  /**
   * 记录一条发现。
   *
   * `evidence` 为空直接抛错（需求 11.8）。这条硬约束的价值是它挡住了
   * 「统计方法需要复核」这类无指向的发现——用户看到它既不知道说的是哪一处，
   * 也不知道改什么，于是只能忽略；而一旦开始忽略 findings，整个审查机制就失效了。
   */
  add(input: {
    conversationId: string;
    reviewerRunId?: string | null;
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    detail?: string | null;
    evidence: readonly FindingEvidence[];
  }): Finding {
    if (input.evidence.length === 0) {
      throw new Error(
        '发现必须关联具体证据（制品版本、消息、断言或计划步骤）。' +
          '无指向的发现用户无从判断说的是哪一处，也无从修。',
      );
    }
    for (const item of input.evidence) {
      if (typeof item.id !== 'string' || item.id.trim() === '') {
        throw new Error(`证据 ${item.kind} 缺少 id`);
      }
    }

    const id = `fd_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO findings
           (id, conversation_id, reviewer_run_id, severity, category, title, detail,
            evidence_json, status, addressed_note, addressed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.reviewerRunId ?? null,
        input.severity,
        input.category,
        input.title,
        input.detail ?? null,
        JSON.stringify(input.evidence),
        Date.now(),
      );

    const created = this.get(id);
    if (created === null) throw new Error('发现创建后读取失败');
    return created;
  }

  get(id: string): Finding | null {
    const row = this.#db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as
      FindingRow | undefined;
    return row === undefined ? null : toFinding(row);
  }

  list(
    options: {
      conversationId?: string;
      severity?: FindingSeverity;
      category?: FindingCategory;
      /** 省略时返回未关闭的（open + claimed-fixed）。 */
      status?: FindingStatus | 'unresolved';
      limit?: number;
    } = {},
  ): readonly Finding[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.severity !== undefined) {
      clauses.push('severity = ?');
      params.push(options.severity);
    }
    if (options.category !== undefined) {
      clauses.push('category = ?');
      params.push(options.category);
    }

    // 默认只看未关闭的：已解决的发现在「还有什么要改」这个问题上是噪声
    const status = options.status ?? 'unresolved';
    if (status === 'unresolved') {
      clauses.push("status IN ('open', 'claimed-fixed')");
    } else {
      clauses.push('status = ?');
      params.push(status);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(options.limit ?? 100, 500)));

    return (
      this.#db
        .prepare(
          `SELECT * FROM findings${where}
           ORDER BY CASE severity WHEN 'fail' THEN 0 ELSE 1 END, created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(...params) as FindingRow[]
    ).map(toFinding);
  }

  /**
   * agent 自报已修（需求 11.7）。
   *
   * 只推进到 `claimed-fixed`，**不关闭**。直接关闭会让一次错误的自我判断永久掩盖
   * 问题——而「我以为我改好了」在这类审查里恰恰是最常见的情形。由下一轮审查确认
   * 或重新提出。
   */
  claimFixed(id: string, note: string): boolean {
    if (note.trim() === '') {
      throw new Error('自报已修必须说明改了什么，否则下一轮审查无从核对');
    }
    return (
      this.#db
        .prepare(
          `UPDATE findings SET status = 'claimed-fixed', addressed_note = ?, addressed_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(note.trim(), Date.now(), id).changes > 0
    );
  }

  /** Reviewer 复核通过，关闭发现。只有审查方能做这件事。 */
  resolve(id: string, note?: string): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE findings SET status = 'resolved', addressed_note = COALESCE(?, addressed_note),
             addressed_at = ? WHERE id = ? AND status IN ('open', 'claimed-fixed')`,
        )
        .run(note ?? null, Date.now(), id).changes > 0
    );
  }

  /** 复核未通过：把自报已修的发现打回 open，让它继续挡着。 */
  reopen(id: string, note: string): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE findings SET status = 'open', addressed_note = ?, addressed_at = NULL
           WHERE id = ? AND status = 'claimed-fixed'`,
        )
        .run(note, id).changes > 0
    );
  }

  /** 用户判定为误报。与 resolved 分开：误报不代表问题被修了。 */
  dismiss(id: string, note: string): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE findings SET status = 'dismissed', addressed_note = ?, addressed_at = ?
           WHERE id = ? AND status IN ('open', 'claimed-fixed')`,
        )
        .run(note, Date.now(), id).changes > 0
    );
  }

  /**
   * 未关闭发现的摘要，供 agent 在宣称完成前自检（需求 11.6）。
   *
   * `blocking` 是 FAIL 级的数量——它非零时不该宣称完成。
   */
  summary(conversationId?: string): {
    blocking: number;
    warnings: number;
    claimedFixed: number;
    byCategory: Readonly<Record<string, number>>;
  } {
    const rows = this.list({
      ...(conversationId === undefined ? {} : { conversationId }),
      status: 'unresolved',
      limit: 500,
    });

    const byCategory: Record<string, number> = {};
    let blocking = 0;
    let warnings = 0;
    let claimedFixed = 0;

    for (const finding of rows) {
      byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
      if (finding.status === 'claimed-fixed') claimedFixed += 1;
      if (finding.severity === 'fail') blocking += 1;
      else warnings += 1;
    }

    return { blocking, warnings, claimedFixed, byCategory };
  }
}
