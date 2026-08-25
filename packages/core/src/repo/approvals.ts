/**
 * 审批记录仓储（项目库，任务 8.1）。
 *
 * 落盘的目的不是让审批能跨重启恢复——等待中的调用方在进程重启后已经不存在，
 * 恢复一个没人在等的审批毫无意义。目的是**留下审计痕迹**：事后需要能回答
 * 「谁在什么时候批准了删除哪个制品」。
 *
 * 因此启动时会把遗留的 pending 记录标为 abandoned，而不是重新挂起。
 */

import type { ApprovalKind, ApprovalRequest } from '@l-science/shared';

import type { Db } from '../db.js';
import { approvalFingerprint } from '../approval/types.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'timeout' | 'abandoned';

export interface ApprovalRow {
  id: string;
  conversationId: string | null;
  kind: ApprovalKind;
  request: ApprovalRequest;
  state: ApprovalState;
  note: string | null;
  requestedAt: number;
  decidedAt: number | null;
}

interface RawRow {
  id: string;
  conversation_id: string | null;
  kind: string;
  payload_json: string;
  state: string;
  note: string | null;
  requested_at: number;
  decided_at: number | null;
}

function toRow(raw: RawRow): ApprovalRow | null {
  let request: ApprovalRequest;
  try {
    request = JSON.parse(raw.payload_json) as ApprovalRequest;
  } catch {
    // 审计记录损坏时跳过该行而不是让整个审批历史读不出来
    return null;
  }
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    kind: raw.kind as ApprovalKind,
    request,
    state: raw.state as ApprovalState,
    note: raw.note,
    requestedAt: raw.requested_at,
    decidedAt: raw.decided_at,
  };
}

export class ApprovalRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 记录一次新发起的审批。 */
  insert(input: {
    request: ApprovalRequest;
    conversationId: string | null;
    requestedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO approvals (id, conversation_id, kind, payload_json, state, requested_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.request.id,
        input.conversationId,
        input.request.kind,
        // 整个请求存成 JSON：审计需要的是「当时给用户看的是什么」，
        // 而不是当时的 payload 加上今天的文案模板
        JSON.stringify(input.request),
        input.requestedAt,
      );
  }

  settle(id: string, state: Exclude<ApprovalState, 'pending'>, note: string | null): void {
    this.#db
      .prepare('UPDATE approvals SET state = ?, note = ?, decided_at = ? WHERE id = ?')
      .run(state, note, Date.now(), id);
  }

  get(id: string): ApprovalRow | null {
    const raw = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  list(
    options: { conversationId?: string; state?: ApprovalState; limit?: number } = {},
  ): readonly ApprovalRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.state !== undefined) {
      clauses.push('state = ?');
      params.push(options.state);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit === undefined ? '' : ` LIMIT ${String(Math.max(1, options.limit))}`;

    const rows = this.#db
      .prepare(`SELECT * FROM approvals${where} ORDER BY requested_at DESC${limit}`)
      .all(...params) as RawRow[];

    return rows.map(toRow).filter((r): r is ApprovalRow => r !== null);
  }

  /**
   * 把遗留的 pending 记录标为 abandoned。
   *
   * 进程重启后，等待这些审批的调用方已经不存在了。留着 pending 会让 UI 显示
   * 一堆点了也没反应的待办卡片——比没有卡片更糟，因为它让用户以为系统坏了。
   */
  abandonStale(): number {
    return this.#db
      .prepare("UPDATE approvals SET state = 'abandoned', decided_at = ? WHERE state = 'pending'")
      .run(Date.now()).changes;
  }

  /**
   * 查询某个指纹此前是否被拒绝过（需求 17.3）。
   *
   * 按会话隔离：用户在一个会话里拒绝了某件事，不该让另一个会话也永久做不了。
   * 传 null 表示查全局（无会话关联的审批）。
   */
  priorDenial(
    kind: ApprovalKind,
    payload: unknown,
    conversationId: string | null,
  ): ApprovalRow | null {
    const fingerprint = approvalFingerprint(kind, payload);
    const rows = this.list({
      state: 'denied',
      ...(conversationId !== null ? { conversationId } : {}),
    });
    return rows.find((r) => approvalFingerprint(r.kind, r.request.payload) === fingerprint) ?? null;
  }
}
