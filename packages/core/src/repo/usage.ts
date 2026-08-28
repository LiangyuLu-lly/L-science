/**
 * 用量与成本记录（任务 11.10，需求 18）。
 *
 * 每次模型调用一条记录：供应商、模型、token、成本、延迟、状态、失败类别。
 * 表名叫 `egress_log` 是因为它同时承担「哪些数据出了本机」这个审计职责——
 * 每条记录都对应一次真实的出站请求。
 *
 * 需求 18.5 是这里最需要守住的一条：**不留凭据，不留完整请求正文**。可观测性
 * 数据的特点是留存久、易导出、常被贴进 issue，因此它是凭据泄漏最容易发生的地方。
 * 错误消息尤其危险——供应商的报错经常把请求内容回显出来。
 */

import type { Db } from '../db.js';

/** 调用的终态。失败类别要能支撑降级链分析（需求 18.3）。 */
export type CallStatus =
  | 'ok'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'aborted'
  | 'auth-failed'
  | 'content-filtered'
  | 'bad-request'
  | 'network-error'
  | 'unknown-error';

export interface UsageRecord {
  conversationId: string | null;
  providerId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  status: CallStatus;
  /** 失败原因。会先经脱敏，见 `redactError`。 */
  error?: string | null;
}

export interface UsageRow extends UsageRecord {
  id: number;
  ts: number;
}

/**
 * 已知的凭据形态。
 *
 * 覆盖主流供应商的 key 前缀与通用的 Bearer 头。不追求穷尽——穷尽是不可能的，
 * 而这份清单的价值在于挡住绝大多数实际会发生的情况。真正的防线是**根本不把
 * 请求正文写进日志**，脱敏只是第二道。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek / 多数兼容供应商
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bAIza[A-Za-z0-9_-]{30,}/g, // Google
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // 任何 Authorization 头
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWT
];

/** 错误消息的长度上限。超长的错误几乎总是回显了请求正文。 */
const MAX_ERROR_CHARS = 2000;

/**
 * 脱敏错误消息（需求 18.5）。
 *
 * 两件事：替换掉看起来像凭据的片段，以及截断。截断不只是省空间——供应商在
 * 400 响应里回显整个请求是常见行为，而那份正文可能包含用户的原始数据。
 * 一条两万字的错误消息里，有用的信息几乎总在开头。
 */
export function redactError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let redacted = raw;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[已脱敏的凭据]');
  }

  if (redacted.length > MAX_ERROR_CHARS) {
    redacted =
      `${redacted.slice(0, MAX_ERROR_CHARS)}\n[错误消息过长已截断，原长度 ${String(raw.length)} 字符。` +
      '供应商在错误响应里回显请求正文是常见行为，完整内容不予留存。]';
  }

  return redacted;
}

/**
 * 把供应商错误映射成失败类别。
 *
 * 分类的目的是让降级链分析可行（需求 18.3）：「限流」与「凭据错误」都表现为
 * 调用失败，但前者说明该换个供应商分摊、后者说明配置有问题，运维动作完全不同。
 */
export function classifyFailure(input: {
  status?: number;
  isContentFilter?: boolean;
  aborted?: boolean;
  message?: string;
}): CallStatus {
  if (input.aborted === true) return 'aborted';
  if (input.isContentFilter === true) return 'content-filtered';

  const status = input.status;
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth-failed';
    if (status === 408) return 'timeout';
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'server-error';
    if (status >= 400) return 'bad-request';
  }

  const message = input.message ?? '';
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(message)) return 'network-error';

  return 'unknown-error';
}

/** 按维度汇总的结果。 */
export interface UsageSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** 成功的调用数。与 calls 的差就是失败数。 */
  succeeded: number;
  /** 延迟中位数。用均值会被少数超慢调用带偏，看不出典型体验。 */
  medianLatencyMs: number;
}

export interface ModelUsageSummary extends UsageSummary {
  providerId: string;
  modelId: string;
}

/** 失败分布，用于降级链分析（需求 18.3）。 */
export interface FailureBreakdown {
  status: CallStatus;
  count: number;
  /** 最近一次的（已脱敏的）错误消息，用于快速定位。 */
  lastError: string | null;
  lastAt: number;
}

export interface TimeRange {
  from?: number;
  to?: number;
}

function rangeClause(range: TimeRange, params: unknown[]): string {
  const clauses: string[] = [];
  if (range.from !== undefined) {
    clauses.push('ts >= ?');
    params.push(range.from);
  }
  if (range.to !== undefined) {
    clauses.push('ts <= ?');
    params.push(range.to);
  }
  return clauses.length === 0 ? '' : clauses.join(' AND ');
}

export class UsageRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 记录一次调用。
   *
   * 错误消息在写入前脱敏，而不是在读取时——读取时脱敏意味着敏感内容已经落盘，
   * 而落盘的东西会被备份、会被导出、会被贴进 issue。
   */
  record(input: UsageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO egress_log
           (ts, conversation_id, provider_id, model_id, tokens_in, tokens_out,
            cost, latency_ms, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        input.conversationId,
        input.providerId,
        input.modelId,
        input.tokensIn,
        input.tokensOut,
        input.cost,
        input.latencyMs,
        input.status,
        redactError(input.error),
      );
  }

  /** 按会话汇总（需求 18.2）。 */
  byConversation(conversationId: string, range: TimeRange = {}): UsageSummary {
    const params: unknown[] = [conversationId];
    const extra = rangeClause(range, params);
    return this.#summarize(`conversation_id = ?${extra === '' ? '' : ` AND ${extra}`}`, params);
  }

  /**
   * 整个项目的汇总（需求 18.2）。
   *
   * 「项目」在这里等于「这个项目库」——用量表在项目库里，因此不带项目过滤条件
   * 本身就是项目级汇总。这也是应用库/项目库分离带来的一个便利：不需要在每行上
   * 存 project_id。
   */
  byProject(range: TimeRange = {}): UsageSummary {
    const params: unknown[] = [];
    return this.#summarize(rangeClause(range, params), params);
  }

  #summarize(where: string, params: readonly unknown[]): UsageSummary {
    const clause = where === '' ? '' : ` WHERE ${where}`;

    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS succeeded
           FROM egress_log${clause}`,
      )
      .get(...params) as {
      calls: number;
      tokens_in: number;
      tokens_out: number;
      cost: number;
      succeeded: number;
    };

    return {
      calls: row.calls,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cost: row.cost,
      succeeded: row.succeeded,
      medianLatencyMs: this.#median(clause, params),
    };
  }

  /**
   * 延迟中位数。
   *
   * 用中位数而不是均值：一次 30 秒的超时调用会把一百次 500ms 调用的均值拉到
   * 800ms，而那个数字既不代表典型体验也不代表最坏情况。SQLite 没有内置的
   * 中位数函数，用 OFFSET 取中间那一行。
   */
  #median(clause: string, params: readonly unknown[]): number {
    const count = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM egress_log${clause}${clause === '' ? ' WHERE' : ' AND'} latency_ms IS NOT NULL`,
        )
        .get(...params) as { n: number }
    ).n;

    if (count === 0) return 0;

    const row = this.#db
      .prepare(
        `SELECT latency_ms FROM egress_log${clause}${clause === '' ? ' WHERE' : ' AND'} latency_ms IS NOT NULL
         ORDER BY latency_ms LIMIT 1 OFFSET ?`,
      )
      .get(...params, Math.floor(count / 2)) as { latency_ms: number } | undefined;

    return row?.latency_ms ?? 0;
  }

  /** 按模型分组的用量。用于「钱花在哪个模型上」。 */
  byModel(range: TimeRange = {}): readonly ModelUsageSummary[] {
    const params: unknown[] = [];
    const where = rangeClause(range, params);
    const clause = where === '' ? '' : ` WHERE ${where}`;

    const rows = this.#db
      .prepare(
        `SELECT provider_id, model_id,
                COUNT(*) AS calls,
                COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS succeeded,
                COALESCE(AVG(latency_ms), 0) AS avg_latency
           FROM egress_log${clause}
          GROUP BY provider_id, model_id
          ORDER BY cost DESC`,
      )
      .all(...params) as Array<{
      provider_id: string;
      model_id: string;
      calls: number;
      tokens_in: number;
      tokens_out: number;
      cost: number;
      succeeded: number;
      avg_latency: number;
    }>;

    return rows.map((r) => ({
      providerId: r.provider_id,
      modelId: r.model_id,
      calls: r.calls,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cost: r.cost,
      succeeded: r.succeeded,
      // 分组查询里取中位数要按组开窗，代价不值得——这里用均值并在字段名上
      // 保持一致，调用方需要精确中位数时用 byConversation/byProject
      medianLatencyMs: Math.round(r.avg_latency),
    }));
  }

  /** 失败分布（需求 18.3）。 */
  failures(range: TimeRange = {}): readonly FailureBreakdown[] {
    const params: unknown[] = [];
    const where = rangeClause(range, params);
    const clause = where === '' ? " WHERE status != 'ok'" : ` WHERE ${where} AND status != 'ok'`;

    const rows = this.#db
      .prepare(
        `SELECT status, COUNT(*) AS count, MAX(ts) AS last_at
           FROM egress_log${clause}
          GROUP BY status
          ORDER BY count DESC`,
      )
      .all(...params) as Array<{ status: string; count: number; last_at: number }>;

    return rows.map((r) => {
      const last = this.#db
        .prepare(
          'SELECT error FROM egress_log WHERE status = ? AND ts = ? ORDER BY id DESC LIMIT 1',
        )
        .get(r.status, r.last_at) as { error: string | null } | undefined;

      return {
        status: r.status as CallStatus,
        count: r.count,
        lastError: last?.error ?? null,
        lastAt: r.last_at,
      };
    });
  }

  /** 最近的调用记录，用于诊断面板。 */
  recent(limit = 50): readonly UsageRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM egress_log ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as Array<{
      id: number;
      ts: number;
      conversation_id: string | null;
      provider_id: string;
      model_id: string;
      tokens_in: number;
      tokens_out: number;
      cost: number;
      latency_ms: number;
      status: string;
      error: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      conversationId: r.conversation_id,
      providerId: r.provider_id,
      modelId: r.model_id,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cost: r.cost,
      latencyMs: r.latency_ms,
      status: r.status as CallStatus,
      error: r.error,
    }));
  }

  /** 按天汇总，用于趋势图。 */
  daily(range: TimeRange = {}): ReadonlyArray<{ date: string; calls: number; cost: number }> {
    const params: unknown[] = [];
    const where = rangeClause(range, params);
    const clause = where === '' ? '' : ` WHERE ${where}`;

    // SQLite 的 unixepoch 是秒，我们存的是毫秒
    return this.#db
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS date,
                COUNT(*) AS calls,
                COALESCE(SUM(cost), 0) AS cost
           FROM egress_log${clause}
          GROUP BY date
          ORDER BY date`,
      )
      .all(...params) as Array<{ date: string; calls: number; cost: number }>;
  }
}
