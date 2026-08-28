/**
 * 路由决策与反馈记录（任务 11.10、11.9 的持久化侧）。
 *
 * 决策落库有两个用途，缺一不可：
 *
 * 1. **事后可解释**（需求 7.6）。用户在两周后问「这张图当时为什么用的是便宜
 *    模型」，答案必须能查出来。只在事件流里推一次是不够的——事件流不落盘。
 * 2. **反馈闭环的锚点**（需求 7.11）。奖励信号要挂在某次决策上才有意义。
 *    「用户重试了」这个信号本身不说明什么，「用户重试了那次选中 X 的决策」
 *    才是可用的训练信号。
 */

import { randomUUID } from 'node:crypto';

import type { RoutingDecision } from '@l-science/shared';

import type { Db } from '../db.js';
import { experienceKey, type ExperienceAdjustment } from '../router/index.js';

/**
 * 奖励信号的来源（需求 7.11）。
 *
 * 分开记录来源而不是只存一个数值：不同来源的可信度差异很大。用户显式点「重试」
 * 是强信号，而「编辑量大」可能只是他本来就想改写风格。混成一个数值之后，
 * 这个差异再也无法恢复。
 */
export type FeedbackSignal =
  'accepted' | 'retried' | 'edited' | 'reviewer-finding' | 'tool-failure' | 'user-override';

export type FeedbackSource = 'user' | 'reviewer' | 'system';

export interface FeedbackRecord {
  routingDecisionId: string;
  signal: FeedbackSignal;
  /** 归一化到 -1 到 +1。正值表示这次选择是好的。 */
  value: number;
  source: FeedbackSource;
}

/**
 * 各信号的权重。
 *
 * `reviewer-finding` 权重最高：它是独立审查发现的实质问题，比用户的即时反应
 * 可靠得多——用户可能因为答案「读起来顺」而接受一个统计用法错误的结论。
 *
 * `edited` 权重最低且为负得有限：用户编辑输出是正常的写作过程，不一定意味着
 * 模型选错了。把它当强负信号会让路由偏向那些「输出短、不给用户可改的东西」
 * 的模型。
 */
const SIGNAL_WEIGHT: Readonly<Record<FeedbackSignal, number>> = {
  accepted: 1,
  retried: -0.8,
  edited: -0.2,
  'reviewer-finding': -1,
  'tool-failure': -0.6,
  'user-override': -0.7,
};

interface DecisionRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  task_type: string;
  chosen_model_id: string | null;
  candidates_json: string;
  score_json: string | null;
  excluded_json: string | null;
  reason: string | null;
  fallback_of: string | null;
  created_at: number;
}

export class RoutingRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 记录一次决策。id 沿用决策自带的，便于事件流与库里的记录对得上。 */
  record(
    decision: RoutingDecision,
    context: { conversationId?: string | null; messageId?: string | null } = {},
  ): void {
    this.#db
      .prepare(
        `INSERT INTO routing_decisions
           (id, conversation_id, message_id, task_type, chosen_model_id,
            candidates_json, score_json, excluded_json, reason, fallback_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        decision.id,
        context.conversationId ?? null,
        context.messageId ?? null,
        decision.taskType,
        decision.chosenModelId,
        // 候选集只存 id 列表：完整的 ModelDescriptor 会让每条决策记录膨胀到
        // 几 KB，而事后追溯需要的是「当时有哪些候选」而不是它们当时的全部属性
        JSON.stringify(decision.scores.map((s) => s.modelId)),
        JSON.stringify(decision.scores),
        JSON.stringify(decision.excluded),
        decision.reason,
        decision.fallbackOf ?? null,
        decision.createdAt,
      );
  }

  get(id: string): RoutingDecision | null {
    const row = this.#db.prepare('SELECT * FROM routing_decisions WHERE id = ?').get(id) as
      DecisionRow | undefined;
    if (row === undefined) return null;

    const parse = <T>(raw: string | null, fallback: T): T => {
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    return {
      id: row.id,
      taskType: row.task_type as RoutingDecision['taskType'],
      chosenModelId: row.chosen_model_id,
      scores: parse<RoutingDecision['scores']>(row.score_json, []),
      excluded: parse<RoutingDecision['excluded']>(row.excluded_json, []),
      reason: row.reason ?? '',
      ...(row.fallback_of === null ? {} : { fallbackOf: row.fallback_of }),
      createdAt: row.created_at,
    };
  }

  /** 某个会话的决策历史，最新在前。 */
  byConversation(conversationId: string, limit = 50): readonly RoutingDecision[] {
    const rows = this.#db
      .prepare(
        'SELECT id FROM routing_decisions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(conversationId, Math.max(1, Math.min(limit, 500))) as Array<{ id: string }>;

    return rows.map((r) => this.get(r.id)).filter((d): d is RoutingDecision => d !== null);
  }

  /** 记录一条反馈信号。 */
  addFeedback(record: FeedbackRecord): void {
    this.#db
      .prepare(
        `INSERT INTO routing_feedback (id, routing_decision_id, signal, value, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `rf_${randomUUID()}`,
        record.routingDecisionId,
        record.signal,
        record.value,
        record.source,
        Date.now(),
      );
  }

  /** 按信号类型的默认权重记录反馈，调用方不必自己算数值。 */
  addSignal(routingDecisionId: string, signal: FeedbackSignal, source: FeedbackSource): void {
    this.addFeedback({
      routingDecisionId,
      signal,
      value: SIGNAL_WEIGHT[signal],
      source,
    });
  }

  /**
   * 汇总成路由打分要用的经验修正表（需求 7.11）。
   *
   * 键是 `${taskType}:${modelId}`，与 `experienceKey` 保持一致。按任务类型分组
   * 而不是只按模型：一个模型在写作上好不代表在统计推理上也好，混在一起会让
   * 修正值互相抵消，最后趋近于零而失去作用。
   */
  experience(): ReadonlyMap<string, ExperienceAdjustment> {
    const rows = this.#db
      .prepare(
        `SELECT d.task_type AS task_type, d.chosen_model_id AS model_id,
                AVG(f.value) AS avg_value, COUNT(*) AS n
           FROM routing_feedback f
           JOIN routing_decisions d ON d.id = f.routing_decision_id
          WHERE d.chosen_model_id IS NOT NULL
          GROUP BY d.task_type, d.chosen_model_id`,
      )
      .all() as Array<{ task_type: string; model_id: string; avg_value: number; n: number }>;

    const result = new Map<string, ExperienceAdjustment>();
    for (const row of rows) {
      result.set(experienceKey(row.task_type, row.model_id), {
        // 夹到 -1..1：单条信号的权重已在这个范围内，但均值受浮点误差影响
        // 可能微微越界，而打分公式假设它在范围内
        value: Math.max(-1, Math.min(1, row.avg_value)),
        sampleCount: row.n,
      });
    }
    return result;
  }

  /** 某个决策收到的反馈，用于决策面板展示。 */
  feedbackOf(routingDecisionId: string): ReadonlyArray<{
    signal: FeedbackSignal;
    value: number;
    source: FeedbackSource;
    createdAt: number;
  }> {
    return (
      this.#db
        .prepare(
          'SELECT signal, value, source, created_at FROM routing_feedback WHERE routing_decision_id = ? ORDER BY created_at',
        )
        .all(routingDecisionId) as Array<{
        signal: string;
        value: number;
        source: string;
        created_at: number;
      }>
    ).map((r) => ({
      signal: r.signal as FeedbackSignal,
      value: r.value,
      source: r.source as FeedbackSource,
      createdAt: r.created_at,
    }));
  }
}

export { SIGNAL_WEIGHT };
