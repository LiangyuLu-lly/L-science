/**
 * 会话、消息与工具调用仓储（项目库）。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

export type ConversationStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'awaiting_approval'
  | 'awaiting_user_input'
  | 'background_pending';

export interface Conversation {
  id: string;
  title: string | null;
  agentId: string | null;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    status: row.status as ConversationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export class ConversationRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: { title?: string; agentId?: string; id?: string } = {}): Conversation {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.#db
      .prepare(
        `INSERT INTO conversations (id, title, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, input.title ?? null, input.agentId ?? null, now, now);

    const created = this.get(id);
    if (created === null) throw new Error('会话创建后立即读取失败');
    return created;
  }

  get(id: string): Conversation | null {
    const row = this.#db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      ConversationRow | undefined;
    return row === undefined ? null : toConversation(row);
  }

  list(opts: { includeArchived?: boolean; limit?: number } = {}): Conversation[] {
    const limit = opts.limit ?? 200;
    const sql =
      opts.includeArchived === true
        ? 'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?';
    return (this.#db.prepare(sql).all(limit) as ConversationRow[]).map(toConversation);
  }

  setStatus(id: string, status: ConversationStatus): void {
    const info = this.#db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
    if (info.changes === 0) throw new Error(`会话不存在：${id}`);
  }

  setTitle(id: string, title: string): void {
    const info = this.#db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
    if (info.changes === 0) throw new Error(`会话不存在：${id}`);
  }

  archive(id: string): void {
    const now = Date.now();
    this.#db
      .prepare('UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
  }

  /** 消息与工具调用由外键级联删除。 */
  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }
}

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  currency: string;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: unknown;
  modelId: string | null;
  providerId: string | null;
  usage: Usage | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content_json: string;
  model_id: string | null;
  provider_id: string | null;
  usage_json: string | null;
  created_at: number;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: parseJson<unknown>(row.content_json),
    modelId: row.model_id,
    providerId: row.provider_id,
    usage: parseJson<Usage>(row.usage_json),
    createdAt: row.created_at,
  };
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: unknown;
  modelId?: string;
  providerId?: string;
  usage?: Usage;
  id?: string;
}

/** 一页消息。`hasMore` 表示更早的方向还有内容。 */
export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  /** 本页最小 seq，作为下一次向前翻页的游标。空页为 null。 */
  oldestSeq: number | null;
}

export class MessageRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 追加一条消息。
   *
   * `seq` 由 `MAX(seq)+1` 在同一事务内算出，配合表上的
   * `UNIQUE (conversation_id, seq)` 约束。better-sqlite3 是同步的，
   * 单进程内不会出现两个事务交错；跨进程写同一库时唯一约束会让后者失败，
   * 而不是静默产生重复 seq。
   */
  append(input: AppendMessageInput): Message {
    const now = Date.now();
    const id = input.id ?? randomUUID();

    const run = this.#db.transaction((): number => {
      const exists = this.#db
        .prepare('SELECT 1 FROM conversations WHERE id = ?')
        .get(input.conversationId);
      if (exists === undefined) throw new Error(`会话不存在：${input.conversationId}`);

      const { next } = this.#db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?')
        .get(input.conversationId) as { next: number };

      this.#db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, seq, role, content_json, model_id, provider_id, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          next,
          input.role,
          JSON.stringify(input.content ?? null),
          input.modelId ?? null,
          input.providerId ?? null,
          input.usage === undefined ? null : JSON.stringify(input.usage),
          now,
        );

      // 会话的 updated_at 跟着动，列表排序才有意义。
      this.#db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(now, input.conversationId);

      return next;
    });

    const seq = run();
    const created = this.get(id);
    if (created === null) throw new Error(`消息写入后读取失败：seq=${String(seq)}`);
    return created;
  }

  get(id: string): Message | null {
    const row = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      MessageRow | undefined;
    return row === undefined ? null : toMessage(row);
  }

  /**
   * 按游标向前（更早）翻页。
   *
   * 返回结果按 seq 升序，便于直接渲染；但查询是按 seq 降序取 limit 条后反转，
   * 这样长会话不必扫全表。`beforeSeq` 省略表示从最新一条开始。
   */
  page(conversationId: string, opts: { beforeSeq?: number; limit?: number } = {}): MessagePage {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

    const rows =
      opts.beforeSeq === undefined
        ? (this.#db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
            .all(conversationId, limit + 1) as MessageRow[])
        : (this.#db
            .prepare(
              'SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(conversationId, opts.beforeSeq, limit + 1) as MessageRow[]);

    // 多取一条用于判断是否还有更早的内容，不必再发一次 COUNT。
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse().map(toMessage);

    return {
      messages: page,
      hasMore,
      oldestSeq: page.length === 0 ? null : (page[0]?.seq ?? null),
    };
  }

  count(conversationId: string): number {
    return (
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { n: number }
    ).n;
  }

  /** 最新一条消息的 seq；空会话返回 0。 */
  latestSeq(conversationId: string): number {
    return (
      this.#db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { n: number }
    ).n;
  }
}

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

export type ToolCallStatus = 'running' | 'ok' | 'error' | 'aborted';

export interface ToolCall {
  id: string;
  messageId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  status: ToolCallStatus;
  sandboxId: string | null;
  exitCode: number | null;
  background: boolean;
  startedAt: number | null;
  endedAt: number | null;
}

interface ToolCallRow {
  id: string;
  message_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string;
  sandbox_id: string | null;
  exit_code: number | null;
  background: number;
  started_at: number | null;
  ended_at: number | null;
}

function toToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    messageId: row.message_id,
    toolName: row.tool_name,
    input: parseJson<unknown>(row.input_json),
    output: parseJson<unknown>(row.output_json),
    status: row.status as ToolCallStatus,
    sandboxId: row.sandbox_id,
    exitCode: row.exit_code,
    background: row.background === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export class ToolCallRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  start(input: {
    messageId: string;
    toolName: string;
    input: unknown;
    sandboxId?: string;
    background?: boolean;
    id?: string;
  }): ToolCall {
    const id = input.id ?? randomUUID();
    this.#db
      .prepare(
        `INSERT INTO tool_calls
           (id, message_id, tool_name, input_json, status, sandbox_id, background, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        input.messageId,
        input.toolName,
        JSON.stringify(input.input ?? null),
        input.sandboxId ?? null,
        input.background === true ? 1 : 0,
        Date.now(),
      );

    const created = this.get(id);
    if (created === null) throw new Error('工具调用写入后读取失败');
    return created;
  }

  /** 收尾。刻意要求显式给出终态，不提供「默认成功」。 */
  finish(
    id: string,
    result: { status: Exclude<ToolCallStatus, 'running'>; output?: unknown; exitCode?: number },
  ): ToolCall {
    const info = this.#db
      .prepare(
        `UPDATE tool_calls
            SET status = ?, output_json = ?, exit_code = ?, ended_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(
        result.status,
        result.output === undefined ? null : JSON.stringify(result.output),
        result.exitCode ?? null,
        Date.now(),
        id,
      );

    if (info.changes === 0) {
      const existing = this.get(id);
      if (existing === null) throw new Error(`工具调用不存在：${id}`);
      throw new Error(`工具调用已是终态，不能重复收尾：${id} (${existing.status})`);
    }

    const updated = this.get(id);
    if (updated === null) throw new Error(`工具调用不存在：${id}`);
    return updated;
  }

  get(id: string): ToolCall | null {
    const row = this.#db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as
      ToolCallRow | undefined;
    return row === undefined ? null : toToolCall(row);
  }

  listByMessage(messageId: string): ToolCall[] {
    return (
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE message_id = ? ORDER BY started_at')
        .all(messageId) as ToolCallRow[]
    ).map(toToolCall);
  }

  /**
   * 列出仍处于 running 的调用。
   *
   * 用途是启动时的孤儿清理：进程被强杀时不会有人来收尾，这些记录会永远停在
   * running。启动时把它们标成 aborted，避免 UI 上出现永久转圈的工具卡片。
   */
  listRunning(): ToolCall[] {
    return (
      this.#db
        .prepare("SELECT * FROM tool_calls WHERE status = 'running' ORDER BY started_at")
        .all() as ToolCallRow[]
    ).map(toToolCall);
  }

  /** 把遗留的 running 记录标为 aborted，返回处理条数。 */
  abortStale(): number {
    return this.#db
      .prepare(`UPDATE tool_calls SET status = 'aborted', ended_at = ? WHERE status = 'running'`)
      .run(Date.now()).changes;
  }
}
