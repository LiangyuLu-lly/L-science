/**
 * 记忆仓储（任务 12.9，需求 16.1-16.3）。
 *
 * 三层作用域分两个库存：
 *
 * - `global`（跨项目的偏好与工作习惯）与 `compute`（算力环境笔记）在**应用库**：
 *   它们与具体项目无关，放进项目库会让每个项目各存一份，改一处不影响其他项目。
 * - `project`（项目背景、术语约定、数据说明、既定决策）在**项目库**：删项目时它
 *   跟着一起走，不会留下一堆指向已不存在项目的孤儿记忆。
 *
 * 两张表的列不同（项目库那张没有 scope 列，作用域由「它在哪个库里」隐含），因此这里
 * 用一个类封装两种形状，而不是让调用方自己判断该查哪张表——那种判断散在各处，
 * 漏一处就会出现「写进了应用库但从项目库里查」这种查不出来也不报错的情况。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';

/** 记忆作用域（需求 16.1）。 */
export type MemoryScope = 'global' | 'project' | 'compute';

/**
 * 记忆类别。
 *
 * 分类不是分类癖：注入时按类别排序（约定与背景优先于偏好），UI 也按类别分组。
 * 合成一类的结果是注入预算被一堆「我喜欢深色主题」挤满，而真正影响分析正确性的
 * 「本项目的被试编号是 S01-S24」被截掉。
 */
export type MemoryKind =
  'preference' | 'background' | 'convention' | 'decision' | 'data' | 'environment';

export interface MemoryNote {
  id: string;
  scope: MemoryScope;
  /** project 作用域是项目 id，compute 作用域是算力目标 id，global 为 null。 */
  scopeId: string | null;
  kind: MemoryKind;
  content: string;
  /** 为什么记住它（需求 16.2）。写入时强制要求。 */
  reason: string;
  updatedAt: number;
}

interface AppRow {
  id: string;
  scope: string;
  scope_id: string | null;
  kind: string;
  content_md: string;
  reason: string | null;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  kind: string;
  content_md: string;
  reason: string | null;
  updated_at: number;
}

/**
 * 归一化内容用于查重。
 *
 * 去掉空白与常见标点后比较：同一条约定被反复写入时往往只差一个句号或一个空格，
 * 而那种重复会让记忆在几十个会话之后变成同一句话的几十份副本。
 */
export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。，、；：！？.,;:!?"'“”‘’（）()【】[\]]/g, '');
}

function toAppNote(row: AppRow): MemoryNote {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id,
    kind: row.kind as MemoryKind,
    content: row.content_md,
    reason: row.reason ?? '',
    updatedAt: row.updated_at,
  };
}

function toProjectNote(row: ProjectRow, projectId: string): MemoryNote {
  return {
    id: row.id,
    scope: 'project',
    scopeId: projectId,
    kind: row.kind as MemoryKind,
    content: row.content_md,
    reason: row.reason ?? '',
    updatedAt: row.updated_at,
  };
}

export interface MemoryRepoOptions {
  /** 应用库。global 与 compute 作用域存这里。 */
  appDb: Db;
  /** 项目库。project 作用域存这里。省略时 project 作用域不可用。 */
  projectDb?: Db;
  /** 项目 id。有 projectDb 时必须给出，用于填充 scopeId。 */
  projectId?: string;
}

export class MemoryRepo {
  readonly #appDb: Db;
  readonly #projectDb: Db | null;
  readonly #projectId: string | null;

  constructor(options: MemoryRepoOptions) {
    this.#appDb = options.appDb;
    this.#projectDb = options.projectDb ?? null;
    this.#projectId = options.projectId ?? null;

    if (this.#projectDb !== null && this.#projectId === null) {
      // 没有 projectId 就填不出 scopeId，而空的 scopeId 会让 compute/project
      // 两类记忆在 UI 上分不开
      throw new Error('提供 projectDb 时必须同时提供 projectId');
    }
  }

  get hasProjectScope(): boolean {
    return this.#projectDb !== null;
  }

  /* ---------------- 写入 ---------------- */

  /**
   * 写入或更新一条记忆。
   *
   * 内容归一化后完全相同的既有条目会被**更新**而不是新增一条：同一条约定被反复
   * 写入是最常见的记忆膨胀来源，而膨胀之后注入预算会被副本占满。
   */
  upsert(input: {
    scope: MemoryScope;
    scopeId?: string | null;
    kind: MemoryKind;
    content: string;
    reason: string;
    /** 指定要替换的条目。用于纠正已经过时的记忆。 */
    replaceId?: string;
  }): { note: MemoryNote; created: boolean; deduped: boolean } {
    const content = input.content.trim();
    const reason = input.reason.trim();

    if (content === '') throw new Error('记忆内容不能为空');
    // 需求 16.2：写入必须附带理由。没有理由的记忆在用户审查时无从判断该不该留
    if (reason === '') throw new Error('写入记忆必须说明理由');

    if (input.replaceId !== undefined) {
      const updated = this.#update(input.replaceId, { kind: input.kind, content, reason });
      if (updated === null) throw new Error(`要替换的记忆不存在：${input.replaceId}`);
      return { note: updated, created: false, deduped: false };
    }

    const scopeId = this.#resolveScopeId(input.scope, input.scopeId ?? null);

    const existing = this.list({
      scope: input.scope,
      ...(scopeId === null ? {} : { scopeId }),
    }).find((n) => normalizeMemoryContent(n.content) === normalizeMemoryContent(content));
    if (existing !== undefined) {
      const updated = this.#update(existing.id, { kind: input.kind, content, reason });
      return {
        note: updated ?? existing,
        created: false,
        deduped: true,
      };
    }

    const id = `mem_${randomUUID()}`;
    const now = Date.now();

    if (input.scope === 'project') {
      const db = this.#requireProjectDb();
      db.prepare(
        `INSERT INTO memory_notes (id, kind, content_md, reason, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, input.kind, content, reason, now);
    } else {
      this.#appDb
        .prepare(
          `INSERT INTO memory_notes (id, scope, scope_id, kind, content_md, reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.scope, scopeId, input.kind, content, reason, now);
    }

    const note = this.get(id);
    if (note === null) throw new Error('记忆写入后读取失败');
    return { note, created: true, deduped: false };
  }

  #update(
    id: string,
    patch: { kind: MemoryKind; content: string; reason: string },
  ): MemoryNote | null {
    const now = Date.now();

    const appChanges = this.#appDb
      .prepare(
        'UPDATE memory_notes SET kind = ?, content_md = ?, reason = ?, updated_at = ? WHERE id = ?',
      )
      .run(patch.kind, patch.content, patch.reason, now, id).changes;

    if (appChanges === 0 && this.#projectDb !== null) {
      this.#projectDb
        .prepare(
          'UPDATE memory_notes SET kind = ?, content_md = ?, reason = ?, updated_at = ? WHERE id = ?',
        )
        .run(patch.kind, patch.content, patch.reason, now, id);
    }

    return this.get(id);
  }

  /* ---------------- 读取 ---------------- */

  /**
   * 按 id 取一条。两个库都查。
   *
   * 不靠 id 前缀区分库：前缀可以被手工编辑、导入的数据也可能不带，而「查不到就
   * 当作不存在」在删除路径上意味着静默失败。
   */
  get(id: string): MemoryNote | null {
    const appRow = this.#appDb.prepare('SELECT * FROM memory_notes WHERE id = ?').get(id) as
      AppRow | undefined;
    if (appRow !== undefined) return toAppNote(appRow);

    if (this.#projectDb === null || this.#projectId === null) return null;
    const projectRow = this.#projectDb
      .prepare('SELECT * FROM memory_notes WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return projectRow === undefined ? null : toProjectNote(projectRow, this.#projectId);
  }

  /** 列出记忆。省略 scope 时返回全部可见的（含项目作用域，如果有项目库）。 */
  list(
    options: { scope?: MemoryScope; scopeId?: string; kind?: MemoryKind; limit?: number } = {},
  ): readonly MemoryNote[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
    const notes: MemoryNote[] = [];

    if (options.scope !== 'project') {
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (options.scope !== undefined) {
        clauses.push('scope = ?');
        params.push(options.scope);
      } else {
        // 不带 scope 时只取应用库里的两类，避免把别的 scope 值混进来
        clauses.push("scope IN ('global', 'compute')");
      }
      if (options.scopeId !== undefined) {
        clauses.push('scope_id = ?');
        params.push(options.scopeId);
      }
      if (options.kind !== undefined) {
        clauses.push('kind = ?');
        params.push(options.kind);
      }

      const rows = this.#appDb
        .prepare(
          `SELECT * FROM memory_notes WHERE ${clauses.join(' AND ')}
             ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, limit) as AppRow[];
      notes.push(...rows.map(toAppNote));
    }

    const wantProject = options.scope === undefined || options.scope === 'project';
    if (wantProject && this.#projectDb !== null && this.#projectId !== null) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options.kind !== undefined) {
        clauses.push('kind = ?');
        params.push(options.kind);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = this.#projectDb
        .prepare(`SELECT * FROM memory_notes ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
        .all(...params, limit) as ProjectRow[];
      notes.push(...rows.map((r) => toProjectNote(r, this.#projectId as string)));
    }

    // 合并两个库的结果后重新排序：各自已排好，但拼起来就乱了
    return notes.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  count(scope: MemoryScope, scopeId?: string): number {
    if (scope === 'project') {
      if (this.#projectDb === null) return 0;
      return (
        this.#projectDb.prepare('SELECT COUNT(*) AS n FROM memory_notes').get() as { n: number }
      ).n;
    }
    const row =
      scopeId === undefined
        ? (this.#appDb
            .prepare('SELECT COUNT(*) AS n FROM memory_notes WHERE scope = ?')
            .get(scope) as { n: number })
        : (this.#appDb
            .prepare('SELECT COUNT(*) AS n FROM memory_notes WHERE scope = ? AND scope_id = ?')
            .get(scope, scopeId) as { n: number });
    return row.n;
  }

  /** 删除一条（需求 16.3）。两个库都试。 */
  delete(id: string): boolean {
    if (this.#appDb.prepare('DELETE FROM memory_notes WHERE id = ?').run(id).changes > 0) {
      return true;
    }
    if (this.#projectDb === null) return false;
    return this.#projectDb.prepare('DELETE FROM memory_notes WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------- 内部 ---------------- */

  #requireProjectDb(): Db {
    if (this.#projectDb === null) {
      throw new Error('当前没有项目上下文，无法写入项目作用域的记忆');
    }
    return this.#projectDb;
  }

  #resolveScopeId(scope: MemoryScope, given: string | null): string | null {
    if (scope === 'global') return null;
    if (scope === 'project') return this.#projectId;
    // compute 作用域必须指名是哪个算力目标：不指名的话「这个集群的分区叫 gpu」
    // 会被套到所有集群上
    if (given === null || given.trim() === '') {
      throw new Error('compute 作用域必须指定算力目标 id');
    }
    return given.trim();
  }
}
