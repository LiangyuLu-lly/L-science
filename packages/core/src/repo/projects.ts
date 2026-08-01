/**
 * 项目注册表仓储（应用库）。
 *
 * 只管元数据。项目内容在各自的 `projects/<id>/project.db` 里，删除项目时
 * 需要同时清理注册表行与那个目录——两者不在同一事务里，因此顺序很重要：
 * 先删注册表行（在事务内），再删目录。反过来的话，目录删掉但注册表还在，
 * 列表里会出现一个打不开的项目。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  rootPath: string | null;
  settings: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  root_path: string | null;
  settings_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function toProject(row: ProjectRow): Project {
  let settings: Record<string, unknown> | null = null;
  if (row.settings_json !== null) {
    try {
      settings = JSON.parse(row.settings_json) as Record<string, unknown>;
    } catch {
      // 宁可丢掉损坏的设置也不要让整个项目列表打不开。
      settings = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  rootPath?: string;
  settings?: Record<string, unknown>;
  /** 仅测试与导入场景使用；正常情况下由仓储生成。 */
  id?: string;
}

export class ProjectRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (name === '') throw new Error('项目名不能为空');

    const now = Date.now();
    const id = input.id ?? randomUUID();

    this.#db
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.description ?? null,
        input.rootPath ?? null,
        input.settings === undefined ? null : JSON.stringify(input.settings),
        now,
        now,
      );

    const created = this.get(id);
    if (created === null) throw new Error('项目创建后立即读取失败');
    return created;
  }

  get(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    return row === undefined ? null : toProject(row);
  }

  /** 默认只列未归档项目，按最近更新排序。 */
  list(opts: { includeArchived?: boolean } = {}): Project[] {
    const sql =
      opts.includeArchived === true
        ? 'SELECT * FROM projects ORDER BY archived_at IS NOT NULL, updated_at DESC'
        : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC';
    return (this.#db.prepare(sql).all() as ProjectRow[]).map(toProject);
  }

  rename(id: string, name: string): Project {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('项目名不能为空');

    const info = this.#db
      .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, Date.now(), id);
    if (info.changes === 0) throw new Error(`项目不存在：${id}`);

    const updated = this.get(id);
    if (updated === null) throw new Error(`项目不存在：${id}`);
    return updated;
  }

  /** 归档是可逆的软状态，不删任何数据。 */
  archive(id: string): Project {
    const now = Date.now();
    const info = this.#db
      .prepare(
        'UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
      )
      .run(now, now, id);
    if (info.changes === 0) {
      const existing = this.get(id);
      if (existing === null) throw new Error(`项目不存在：${id}`);
      return existing; // 已归档，幂等返回
    }
    const updated = this.get(id);
    if (updated === null) throw new Error(`项目不存在：${id}`);
    return updated;
  }

  unarchive(id: string): Project {
    const now = Date.now();
    this.#db
      .prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
    const updated = this.get(id);
    if (updated === null) throw new Error(`项目不存在：${id}`);
    return updated;
  }

  /** 触碰更新时间，用于把最近活动的项目排到列表前面。 */
  touch(id: string): void {
    this.#db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * 从注册表删除项目行。**不**删除项目目录——那由上层在本方法成功后进行，
   * 保证「注册表里还在但目录已没」这种更糟的状态不会出现。
   */
  deleteRow(id: string): boolean {
    const run = this.#db.transaction((): number => {
      const info = this.#db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return info.changes;
    });
    return run() > 0;
  }

  count(opts: { includeArchived?: boolean } = {}): number {
    const sql =
      opts.includeArchived === true
        ? 'SELECT COUNT(*) AS n FROM projects'
        : 'SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL';
    return (this.#db.prepare(sql).get() as { n: number }).n;
  }
}
