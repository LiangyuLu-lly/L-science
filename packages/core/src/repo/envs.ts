/**
 * 环境与包仓储（应用库，任务 14.4，需求 15.1-15.7）。
 *
 * 环境在**应用库**：一个 conda 环境或一个 venv 是这台机器上的资源，不属于某个项目。
 * 放进项目库会让「新建项目后要把环境重新登记一遍」，而登记一个 venv 需要用户去找路径。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';
import type {
  EnvKind,
  EnvLanguage,
  EnvMode,
  EnvProbe,
  EnvStatus,
  PackageRecord,
  PackageSource,
} from '../envs/types.js';

export interface EnvRecord {
  id: string;
  name: string;
  kind: EnvKind;
  mode: EnvMode;
  language: EnvLanguage;
  /** 环境根目录。 */
  path: string;
  /** 解释器绝对路径。需求 15.2 的内核直启靠它。 */
  interpreter: string | null;
  pythonVersion: string | null;
  rVersion: string | null;
  status: EnvStatus;
  /** 新内核默认用哪个环境。同一语言只有一个。 */
  isDefault: boolean;
  notes: string | null;
  lastProbe: EnvProbe | null;
  lastProbeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface EnvRow {
  id: string;
  name: string;
  kind: string;
  mode: string;
  path: string | null;
  python_version: string | null;
  r_version: string | null;
  packages_json: string | null;
  status: string | null;
  language: string | null;
  interpreter: string | null;
  is_default: number;
  notes: string | null;
  last_probe_json: string | null;
  last_probe_at: number | null;
  created_at: number | null;
  updated_at: number | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toRecord(row: EnvRow): EnvRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as EnvKind,
    mode: row.mode as EnvMode,
    /*
     * M001 建表时没有 language 列，M005 补的。旧行按 r_version 反推。
     *
     * 反推只在这里做一次，并且**只对旧行**：新写入必须显式给 language。一个 conda
     * 环境可以两个都装，那时反推的答案取决于 if 的顺序。
     */
    language: (row.language ?? (row.r_version !== null ? 'r' : 'python')) as EnvLanguage,
    path: row.path ?? '',
    interpreter: row.interpreter,
    pythonVersion: row.python_version,
    rVersion: row.r_version,
    status: (row.status ?? 'ready') as EnvStatus,
    isDefault: row.is_default === 1,
    notes: row.notes,
    lastProbe: parseJson<EnvProbe>(row.last_probe_json),
    lastProbeAt: row.last_probe_at,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? row.created_at ?? 0,
  };
}

export class EnvsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(input: {
    name: string;
    kind: EnvKind;
    mode: EnvMode;
    language: EnvLanguage;
    path: string;
    interpreter?: string | null;
    pythonVersion?: string | null;
    rVersion?: string | null;
    status?: EnvStatus;
    notes?: string | null;
  }): EnvRecord {
    const name = input.name.trim();
    if (name === '') throw new Error('环境必须有名字');
    if (this.getByName(name) !== null) {
      throw new Error(`已有同名环境：${name}。名字要能一眼分清是哪一个。`);
    }
    /*
     * 同一个路径不许登记两次。
     *
     * 登记两次的表现是列表里有两条看起来不同的环境，而它们其实是同一个目录——
     * 在其中一条上装包，另一条的包清单也变了，而用户看不出为什么。
     */
    const existingPath = this.getByPath(input.path);
    if (existingPath !== null) {
      throw new Error(
        `这个目录已经登记为「${existingPath.name}」：${input.path}。` +
          '同一个目录登记两次会让两条记录互相影响，而界面上看不出它们是同一个。',
      );
    }

    const id = `env_${randomUUID()}`;
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO environments
           (id, name, kind, mode, path, python_version, r_version, packages_json, status,
            language, interpreter, is_default, notes, last_probe_json, last_probe_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        name,
        input.kind,
        input.mode,
        input.path,
        input.pythonVersion ?? null,
        input.rVersion ?? null,
        input.status ?? 'creating',
        input.language,
        input.interpreter ?? null,
        input.notes ?? null,
        now,
        now,
      );
    return this.get(id) as EnvRecord;
  }

  get(id: string): EnvRecord | null {
    const row = this.#db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as
      EnvRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  getByName(name: string): EnvRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM environments WHERE name = ? COLLATE NOCASE')
      .get(name.trim()) as EnvRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  getByPath(path: string): EnvRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM environments WHERE path = ? COLLATE NOCASE')
      .get(path) as EnvRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** 按名字或 id 找。名字优先——用户与模型都用名字。 */
  resolve(ref: string): EnvRecord | null {
    return this.getByName(ref) ?? this.get(ref.trim());
  }

  list(
    options: { language?: EnvLanguage; mode?: EnvMode; status?: EnvStatus } = {},
  ): readonly EnvRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.language !== undefined) {
      clauses.push('language = ?');
      params.push(options.language);
    }
    if (options.mode !== undefined) {
      clauses.push('mode = ?');
      params.push(options.mode);
    }
    if (options.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.#db
      .prepare(
        `SELECT * FROM environments ${where}
         ORDER BY is_default DESC, mode, name COLLATE NOCASE`,
      )
      .all(...params) as EnvRow[];
    return rows.map(toRecord);
  }

  /** 某个语言的默认环境。新内核用它（需求 15.2）。 */
  defaultFor(language: EnvLanguage): EnvRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM environments WHERE language = ? AND is_default = 1')
      .get(language) as EnvRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * 设为默认。
   *
   * 先清掉同语言的旧默认再设新的，两步在一个事务里：中间失败会留下「零个默认」
   * 或（因为部分唯一索引）直接违反约束，而两者都会让新内核起不来。
   */
  setDefault(id: string): boolean {
    const env = this.get(id);
    if (env === null) return false;

    const tx = this.#db.transaction((envId: string, language: string) => {
      this.#db
        .prepare(
          'UPDATE environments SET is_default = 0, updated_at = ? WHERE language = ? AND is_default = 1',
        )
        .run(Date.now(), language);
      this.#db
        .prepare('UPDATE environments SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), envId);
    });
    tx(id, env.language);
    return true;
  }

  /** 清掉某个语言的默认，回到用探测到的托管环境。 */
  clearDefault(language: EnvLanguage): boolean {
    return (
      this.#db
        .prepare(
          'UPDATE environments SET is_default = 0, updated_at = ? WHERE language = ? AND is_default = 1',
        )
        .run(Date.now(), language).changes > 0
    );
  }

  update(
    id: string,
    patch: {
      name?: string;
      interpreter?: string | null;
      pythonVersion?: string | null;
      rVersion?: string | null;
      status?: EnvStatus;
      notes?: string | null;
    },
  ): EnvRecord | null {
    if (this.get(id) === null) return null;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw new Error('环境必须有名字');
      const clash = this.getByName(name);
      if (clash !== null && clash.id !== id) throw new Error(`已有同名环境：${name}`);
    }

    const sets = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) push('name', patch.name.trim());
    if (patch.interpreter !== undefined) push('interpreter', patch.interpreter);
    if (patch.pythonVersion !== undefined) push('python_version', patch.pythonVersion);
    if (patch.rVersion !== undefined) push('r_version', patch.rVersion);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.notes !== undefined) push('notes', patch.notes);

    params.push(id);
    this.#db.prepare(`UPDATE environments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  recordProbe(id: string, probe: EnvProbe): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE environments
              SET last_probe_json = ?, last_probe_at = ?, status = ?,
                  python_version = CASE WHEN language = 'python' THEN ? ELSE python_version END,
                  r_version = CASE WHEN language = 'r' THEN ? ELSE r_version END,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          JSON.stringify(probe),
          probe.at,
          probe.status,
          probe.version,
          probe.version,
          Date.now(),
          id,
        ).changes > 0
    );
  }

  /**
   * 删记录。
   *
   * **只删记录，不删目录**——目录由服务层按 `mode` 决定：托管环境可以删目录，
   * 用户登记的只能取消登记。把两件事合在这里会让「取消登记」意外删掉用户的 venv。
   */
  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM environments WHERE id = ?').run(id).changes > 0;
  }

  exists(id: string): boolean {
    return (
      (this.#db.prepare('SELECT 1 FROM environments WHERE id = ?').get(id) as unknown) !== undefined
    );
  }

  /* ---------------- 包 ---------------- */

  /**
   * 用探测结果整体替换一个环境的包清单。
   *
   * 整体替换而不是增量更新：用户可以在环境里自己跑 pip / conda，增量更新会让我们的
   * 记录慢慢偏离真实状态，而混装检查依赖它的准确性。整体替换的代价是丢掉
   * `installed_by`（谁装的），因此那一列由调用方在替换后重新标注。
   */
  replacePackages(envId: string, packages: readonly PackageRecord[]): number {
    const tx = this.#db.transaction((id: string, list: readonly PackageRecord[]) => {
      this.#db.prepare('DELETE FROM env_packages WHERE env_id = ?').run(id);
      const insert = this.#db.prepare(
        `INSERT INTO env_packages (env_id, name, version, source, channel, installed_by, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const pkg of list) {
        insert.run(
          id,
          pkg.name,
          pkg.version,
          pkg.source,
          pkg.channel,
          pkg.installedBy,
          pkg.installedAt,
        );
      }
    });
    tx(envId, packages);
    return packages.length;
  }

  /** 记一次平台发起的安装。用于回答「这个包是平台装的还是用户装的」。 */
  markInstalledBy(envId: string, names: readonly string[], installedBy: string): number {
    const stmt = this.#db.prepare(
      'UPDATE env_packages SET installed_by = ? WHERE env_id = ? AND name = ? COLLATE NOCASE',
    );
    let changed = 0;
    for (const name of names) changed += stmt.run(installedBy, envId, name).changes;
    return changed;
  }

  packages(
    envId: string,
    options: { source?: PackageSource; query?: string; limit?: number } = {},
  ): readonly PackageRecord[] {
    const clauses = ['env_id = ?'];
    const params: unknown[] = [envId];
    if (options.source !== undefined) {
      clauses.push('source = ?');
      params.push(options.source);
    }
    if (options.query !== undefined && options.query.trim() !== '') {
      clauses.push('name LIKE ?');
      params.push(`%${options.query.trim().toLowerCase()}%`);
    }
    params.push(options.limit ?? 2000);

    const rows = this.#db
      .prepare(
        `SELECT * FROM env_packages WHERE ${clauses.join(' AND ')}
         ORDER BY name COLLATE NOCASE LIMIT ?`,
      )
      .all(...params) as {
      name: string;
      version: string | null;
      source: string;
      channel: string | null;
      installed_by: string | null;
      installed_at: number;
    }[];

    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      source: r.source as PackageSource,
      channel: r.channel,
      installedBy: r.installed_by,
      installedAt: r.installed_at,
    }));
  }

  /** 按来源计数。「这个环境里有几个包是 pip 装的」在排查导入错误时是第一个要问的。 */
  packageStats(envId: string): { total: number; bySource: Readonly<Record<string, number>> } {
    const rows = this.#db
      .prepare('SELECT source, COUNT(*) AS n FROM env_packages WHERE env_id = ? GROUP BY source')
      .all(envId) as { source: string; n: number }[];
    const bySource: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      bySource[row.source] = row.n;
      total += row.n;
    }
    return { total, bySource };
  }
}
