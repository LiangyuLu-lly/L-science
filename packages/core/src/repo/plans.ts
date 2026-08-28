/**
 * 计划仓储（任务 12.5，需求 10.1、10.4）。
 *
 * 分工：`plans.spec_json` 存**不变的计划本体**（目标、阶段、步骤、依赖关系），
 * `plan_steps` 存**可变的执行状态**。这样分是因为两者的读写节奏完全不同——
 * 计划批准后本体就冻结了，而状态在执行期间每几秒变一次。
 *
 * 状态单独成表还有一个必要理由：UI 要能只查状态而不反序列化整个计划，
 * 一个五十步的计划每次状态刷新都解一遍 JSON 是浪费。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';
import type { PlanSpec, PlanStatus, PlanStepStatus } from '../plan/spec.js';

export interface PlanRecord {
  id: string;
  conversationId: string;
  status: PlanStatus;
  spec: PlanSpec;
  createdAt: number;
}

export interface PlanStepRecord {
  /** 数据库主键，形如 `<planId>:<ref>`。 */
  id: string;
  planId: string;
  /** 计划内的引用名，与 spec 里的 ref 一致。 */
  ref: string;
  phase: number;
  seq: number;
  title: string | null;
  description: string | null;
  skillSlug: string | null;
  status: PlanStepStatus;
  /** 委派信息与运行时的子 agent 句柄。 */
  delegation: Record<string, unknown> | null;
  /** 产出的制品版本 id 或文件路径，逗号分隔。 */
  resultRef: string | null;
}

interface PlanRow {
  id: string;
  conversation_id: string;
  status: string;
  spec_json: string;
  created_at: number;
}

interface StepRow {
  id: string;
  plan_id: string;
  phase: number;
  seq: number;
  title: string | null;
  description: string | null;
  skill_slug: string | null;
  status: string;
  delegation_json: string | null;
  result_ref: string | null;
}

/** 步骤主键。planId 已唯一，拼上 ref 即全局唯一，且能反解出 ref。 */
export function planStepId(planId: string, ref: string): string {
  return `${planId}:${ref}`;
}

function refOf(stepId: string, planId: string): string {
  return stepId.startsWith(`${planId}:`) ? stepId.slice(planId.length + 1) : stepId;
}

function toStep(row: StepRow): PlanStepRecord {
  let delegation: Record<string, unknown> | null = null;
  if (row.delegation_json !== null) {
    try {
      delegation = JSON.parse(row.delegation_json) as Record<string, unknown>;
    } catch {
      // 单条委派信息损坏不该让整个计划读不出来
      delegation = null;
    }
  }

  return {
    id: row.id,
    planId: row.plan_id,
    ref: refOf(row.id, row.plan_id),
    phase: row.phase,
    seq: row.seq,
    title: row.title,
    description: row.description,
    skillSlug: row.skill_slug,
    status: row.status as PlanStepStatus,
    delegation,
    resultRef: row.result_ref,
  };
}

export class PlanRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 创建计划。状态为 `draft`——**未经用户批准不执行**（需求 10.4）。
   *
   * 步骤行与计划行在同一事务里写：只写了计划没写步骤的半成品会让 UI 显示一个
   * 空计划，而用户无从判断是「还没生成完」还是「生成失败了」。
   */
  create(input: { conversationId: string; spec: PlanSpec }): PlanRecord {
    const id = `pl_${randomUUID()}`;
    const now = Date.now();

    const run = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO plans (id, conversation_id, status, spec_json, created_at)
           VALUES (?, ?, 'draft', ?, ?)`,
        )
        .run(id, input.conversationId, JSON.stringify(input.spec), now);

      const insert = this.#db.prepare(
        `INSERT INTO plan_steps
           (id, plan_id, phase, seq, title, description, skill_slug, status, delegation_json, result_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      );

      // seq 按阶段内的出现顺序，从 1 开始。它只用于展示排序；执行顺序由依赖决定
      const seqByPhase = new Map<number, number>();
      for (const step of input.spec.steps) {
        const seq = (seqByPhase.get(step.phase) ?? 0) + 1;
        seqByPhase.set(step.phase, seq);

        insert.run(
          planStepId(id, step.ref),
          id,
          step.phase,
          seq,
          step.title,
          step.description,
          step.skillSlug,
          step.delegation === null ? null : JSON.stringify(step.delegation),
        );
      }
    });

    run();

    const created = this.get(id);
    if (created === null) throw new Error('计划创建后读取失败，数据可能已损坏');
    return created;
  }

  get(id: string): PlanRecord | null {
    const row = this.#db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    if (row === undefined) return null;

    let spec: PlanSpec;
    try {
      spec = JSON.parse(row.spec_json) as PlanSpec;
    } catch {
      return null;
    }

    return {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status as PlanStatus,
      spec,
      createdAt: row.created_at,
    };
  }

  /**
   * 某个会话的计划，最新在前。
   *
   * 次级排序用 `rowid` 而不是 `id`：`created_at` 是毫秒时间戳，而「拒绝一版计划后
   * 立刻重新生成」恰好会落在同一毫秒里。此时按 UUID 排序的结果是任意的，界面上
   * 「最新在前」会显示成旧的那一版。rowid 就是插入顺序，正是这里要的语义。
   */
  byConversation(conversationId: string, limit = 20): readonly PlanRecord[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM plans WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(conversationId, limit) as PlanRow[];

    return rows.map((row) => this.get(row.id)).filter((p): p is PlanRecord => p !== null);
  }

  /**
   * 当前活跃的计划（草稿、已批准或执行中）。
   *
   * 一个会话同时有两个活跃计划是无意义的状态：执行器不知道该推进哪个。
   * 由调用方在创建新计划时先把旧的关掉。
   */
  activeOf(conversationId: string): PlanRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM plans WHERE conversation_id = ?
           AND status IN ('draft', 'approved', 'executing')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId) as PlanRow | undefined;
    return row === undefined ? null : this.get(row.id);
  }

  steps(planId: string): readonly PlanStepRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY phase, seq')
      .all(planId) as StepRow[];
    return rows.map(toStep);
  }

  step(planId: string, ref: string): PlanStepRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM plan_steps WHERE id = ?')
      .get(planStepId(planId, ref)) as StepRow | undefined;
    return row === undefined ? null : toStep(row);
  }

  setStatus(planId: string, status: PlanStatus): boolean {
    return (
      this.#db.prepare('UPDATE plans SET status = ? WHERE id = ?').run(status, planId).changes > 0
    );
  }

  /**
   * 替换计划本体（需求 10.4 的「执行前修改」）。
   *
   * 只允许在 `draft` 状态下改。执行中改计划会让已完成的步骤与新的步骤集合对不上
   * ——一个已经跑完的步骤在新计划里可能不存在，那它的产物算什么？这个问题没有
   * 好答案，所以直接禁止：要改就先拒绝当前计划，重新生成一份。
   */
  replaceSpec(planId: string, spec: PlanSpec): { ok: true } | { ok: false; reason: string } {
    const plan = this.get(planId);
    if (plan === null) return { ok: false, reason: `计划不存在：${planId}` };
    if (plan.status !== 'draft') {
      return {
        ok: false,
        reason:
          `计划已是 ${plan.status} 状态，不能改动本体。` +
          '执行中改计划会让已完成的步骤与新步骤集合对不上。请拒绝当前计划后重新生成。',
      };
    }

    const run = this.#db.transaction(() => {
      this.#db
        .prepare('UPDATE plans SET spec_json = ? WHERE id = ?')
        .run(JSON.stringify(spec), planId);
      this.#db.prepare('DELETE FROM plan_steps WHERE plan_id = ?').run(planId);

      const insert = this.#db.prepare(
        `INSERT INTO plan_steps
           (id, plan_id, phase, seq, title, description, skill_slug, status, delegation_json, result_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      );
      const seqByPhase = new Map<number, number>();
      for (const step of spec.steps) {
        const seq = (seqByPhase.get(step.phase) ?? 0) + 1;
        seqByPhase.set(step.phase, seq);
        insert.run(
          planStepId(planId, step.ref),
          planId,
          step.phase,
          seq,
          step.title,
          step.description,
          step.skillSlug,
          step.delegation === null ? null : JSON.stringify(step.delegation),
        );
      }
    });

    run();
    return { ok: true };
  }

  setStepStatus(input: {
    planId: string;
    ref: string;
    status: PlanStepStatus;
    resultRef?: string | null;
    delegation?: Record<string, unknown> | null;
  }): boolean {
    const sets = ['status = ?'];
    const params: unknown[] = [input.status];

    if (input.resultRef !== undefined) {
      sets.push('result_ref = ?');
      params.push(input.resultRef);
    }
    if (input.delegation !== undefined) {
      sets.push('delegation_json = ?');
      params.push(input.delegation === null ? null : JSON.stringify(input.delegation));
    }
    params.push(planStepId(input.planId, input.ref));

    return (
      this.#db.prepare(`UPDATE plan_steps SET ${sets.join(', ')} WHERE id = ?`).run(...params)
        .changes > 0
    );
  }

  /** 进度摘要，供 UI 与「宣称完成前自检」使用。 */
  progress(planId: string): {
    total: number;
    byStatus: Readonly<Record<PlanStepStatus, number>>;
    currentPhase: number | null;
  } {
    const steps = this.steps(planId);
    const byStatus: Record<PlanStepStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    for (const step of steps) byStatus[step.status] += 1;

    // 当前阶段 = 最小的「还有未完成步骤」的阶段
    const unfinished = steps.filter((s) => s.status === 'pending' || s.status === 'running');
    const currentPhase =
      unfinished.length === 0 ? null : Math.min(...unfinished.map((s) => s.phase));

    return { total: steps.length, byStatus, currentPhase };
  }
}
