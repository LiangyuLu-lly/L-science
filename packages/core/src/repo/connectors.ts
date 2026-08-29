/**
 * 连接器与工具授权仓储（任务 12.13、12.14，需求 14.1、14.2、17.5）。
 *
 * 三张表各管一件事：
 *
 * - `connector_groups` / `connectors`：目录本体。组是用户操作的单位——他关的是
 *   「结构与相互作用」这一组，不是逐个去关五十个连接器。
 * - `connector_domains`：每个连接器依赖哪些域名。它让「关掉一组」能连带把出口白名单
 *   收回去；没有这张表就会出现「连接器关了但网络还通」这种没人能解释的半开状态。
 * - `tool_grants`：**按工具**的授权。同一个连接器上「查基因」与「提交作业」的风险完全
 *   不同，用一条连接器级授权覆盖两者等于没有管控。
 */

import { randomUUID } from 'node:crypto';

import type { GrantScope } from '@l-science/shared';

import type { Db } from '../db.js';

export type ConnectorKind = 'mcp-stdio' | 'mcp-http';

export interface ConnectorGroup {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface ConnectorRecord {
  id: string;
  kind: ConnectorKind;
  name: string;
  groupId: string | null;
  /** 随平台分发的内置连接器。升级时整体替换，用户自建的绝不碰。 */
  builtin: boolean;
  /** 传输配置。stdio 存 command/args/env，http 存 url/headers。 */
  config: Record<string, unknown>;
  credentialRef: string | null;
  enabled: boolean;
  health: { ok: boolean; checkedAt: number; detail?: string } | null;
  lastError: string | null;
  /** 内置连接器的内容指纹，用于判断是否需要同步。 */
  sourceSha256: string | null;
  /** 该连接器需要访问的域名。用于出口白名单联动。 */
  domains: readonly string[];
}

export interface ToolGrant {
  id: string;
  connectorId: string;
  toolName: string;
  scope: GrantScope;
  scopeId: string | null;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  sort_order: number;
}

interface ConnectorRow {
  id: string;
  kind: string;
  name: string;
  group_id: string | null;
  builtin: number;
  config_json: string;
  credential_ref: string | null;
  enabled: number;
  health_json: string | null;
  last_error: string | null;
  source_sha256: string | null;
  transport: string | null;
}

interface GrantRow {
  id: string;
  connector_id: string;
  tool_name: string;
  scope: string;
  scope_id: string | null;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class ConnectorRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 组 ---------------- */

  upsertGroup(input: {
    id: string;
    name: string;
    description?: string | null;
    sortOrder?: number;
  }): ConnectorGroup {
    /*
     * 已存在时**不覆盖 enabled**。
     *
     * 内置目录每次启动都会同步一遍，而 enabled 是用户的选择。用 INSERT OR REPLACE
     * 会把它重置成默认值，表现为「每次重启后我关掉的那组又开了」。
     */
    this.#db
      .prepare(
        `INSERT INTO connector_groups (id, name, description, enabled, sort_order)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           sort_order = excluded.sort_order`,
      )
      .run(input.id, input.name, input.description ?? null, input.sortOrder ?? 0);

    const group = this.getGroup(input.id);
    if (group === null) throw new Error('连接器组写入后读取失败');
    return group;
  }

  getGroup(id: string): ConnectorGroup | null {
    const row = this.#db.prepare('SELECT * FROM connector_groups WHERE id = ?').get(id) as
      GroupRow | undefined;
    return row === undefined ? null : this.#toGroup(row);
  }

  listGroups(): readonly ConnectorGroup[] {
    return (
      this.#db
        .prepare('SELECT * FROM connector_groups ORDER BY sort_order, name')
        .all() as GroupRow[]
    ).map((r) => this.#toGroup(r));
  }

  setGroupEnabled(id: string, enabled: boolean): boolean {
    return (
      this.#db
        .prepare('UPDATE connector_groups SET enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  #toGroup(row: GroupRow): ConnectorGroup {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      sortOrder: row.sort_order,
    };
  }

  /* ---------------- 连接器 ---------------- */

  upsert(input: {
    id: string;
    kind: ConnectorKind;
    name: string;
    groupId?: string | null;
    builtin?: boolean;
    config: Record<string, unknown>;
    credentialRef?: string | null;
    domains?: readonly string[];
    sourceSha256?: string | null;
    /** 新建时的初始启用状态。已存在的记录不受影响。 */
    enabledByDefault?: boolean;
  }): ConnectorRecord {
    const run = this.#db.transaction((): void => {
      // 同样不覆盖 enabled：它是用户的选择
      this.#db
        .prepare(
          `INSERT INTO connectors
             (id, kind, name, group_id, builtin, config_json, credential_ref,
              enabled, health_json, last_error, source_sha256, transport)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             kind = excluded.kind,
             name = excluded.name,
             group_id = excluded.group_id,
             builtin = excluded.builtin,
             config_json = excluded.config_json,
             credential_ref = COALESCE(excluded.credential_ref, connectors.credential_ref),
             source_sha256 = excluded.source_sha256,
             transport = excluded.transport`,
        )
        .run(
          input.id,
          input.kind,
          input.name,
          input.groupId ?? null,
          input.builtin === true ? 1 : 0,
          JSON.stringify(input.config),
          input.credentialRef ?? null,
          input.enabledByDefault === false ? 0 : 1,
          input.sourceSha256 ?? null,
          input.kind === 'mcp-stdio' ? 'stdio' : 'http',
        );

      if (input.domains !== undefined) {
        // 整体替换：域名清单来自定义，不是用户维护的，diff 没有意义
        this.#db.prepare('DELETE FROM connector_domains WHERE connector_id = ?').run(input.id);
        const ins = this.#db.prepare(
          'INSERT INTO connector_domains (connector_id, domain) VALUES (?, ?) ON CONFLICT DO NOTHING',
        );
        for (const d of input.domains) ins.run(input.id, d.toLowerCase());
      }
    });
    run();

    const record = this.get(input.id);
    if (record === null) throw new Error('连接器写入后读取失败');
    return record;
  }

  get(id: string): ConnectorRecord | null {
    const row = this.#db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as
      ConnectorRow | undefined;
    return row === undefined ? null : this.#toConnector(row);
  }

  list(
    options: { groupId?: string; includeDisabled?: boolean; builtinOnly?: boolean } = {},
  ): readonly ConnectorRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.groupId !== undefined) {
      clauses.push('group_id = ?');
      params.push(options.groupId);
    }
    if (options.includeDisabled !== true) clauses.push('enabled = 1');
    if (options.builtinOnly === true) clauses.push('builtin = 1');

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.#db
        .prepare(`SELECT * FROM connectors${where} ORDER BY group_id, name`)
        .all(...params) as ConnectorRow[]
    ).map((r) => this.#toConnector(r));
  }

  /**
   * 实际可用的连接器：自己启用 **且** 所属组启用。
   *
   * 两级开关都要满足。只看连接器级会让「关掉整组」失效，而用户会以为已经关了。
   */
  listEffective(): readonly ConnectorRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT c.* FROM connectors c
             LEFT JOIN connector_groups g ON g.id = c.group_id
            WHERE c.enabled = 1 AND (c.group_id IS NULL OR g.enabled = 1)
            ORDER BY c.group_id, c.name`,
        )
        .all() as ConnectorRow[]
    ).map((r) => this.#toConnector(r));
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return (
      this.#db.prepare('UPDATE connectors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
        .changes > 0
    );
  }

  setCredentialRef(id: string, ref: string | null): boolean {
    return (
      this.#db.prepare('UPDATE connectors SET credential_ref = ? WHERE id = ?').run(ref, id)
        .changes > 0
    );
  }

  recordHealth(id: string, health: { ok: boolean; checkedAt: number; detail?: string }): void {
    this.#db
      .prepare('UPDATE connectors SET health_json = ?, last_error = ? WHERE id = ?')
      .run(JSON.stringify(health), health.ok ? null : (health.detail ?? '健康检查失败'), id);
  }

  /** 删除。内置连接器不允许删——它会在下次同步时回来，删掉只会让状态看起来不一致。 */
  delete(id: string): { deleted: boolean; reason?: string } {
    const record = this.get(id);
    if (record === null) return { deleted: false, reason: '连接器不存在' };
    if (record.builtin) {
      return {
        deleted: false,
        reason: '内置连接器不能删除，只能禁用。它会在下次启动同步时回来。',
      };
    }
    return {
      deleted: this.#db.prepare('DELETE FROM connectors WHERE id = ?').run(id).changes > 0,
    };
  }

  /** 同步内置目录时，把源里已下架的内置连接器删掉。用户自建的不动。 */
  pruneBuiltins(keepIds: readonly string[]): number {
    const keep = new Set(keepIds);
    let removed = 0;
    for (const record of this.list({ includeDisabled: true, builtinOnly: true })) {
      if (keep.has(record.id)) continue;
      this.#db.prepare('DELETE FROM connectors WHERE id = ?').run(record.id);
      removed += 1;
    }
    return removed;
  }

  /** 生效连接器所需的全部域名。出口白名单按它联动。 */
  effectiveDomains(): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT d.domain FROM connector_domains d
           JOIN connectors c ON c.id = d.connector_id
           LEFT JOIN connector_groups g ON g.id = c.group_id
          WHERE c.enabled = 1 AND (c.group_id IS NULL OR g.enabled = 1)
          ORDER BY d.domain`,
      )
      .all() as Array<{ domain: string }>;
    return rows.map((r) => r.domain);
  }

  #toConnector(row: ConnectorRow): ConnectorRecord {
    const domains = (
      this.#db
        .prepare('SELECT domain FROM connector_domains WHERE connector_id = ? ORDER BY domain')
        .all(row.id) as Array<{ domain: string }>
    ).map((d) => d.domain);

    return {
      id: row.id,
      kind: row.kind as ConnectorKind,
      name: row.name,
      groupId: row.group_id,
      builtin: row.builtin === 1,
      config: parseJson<Record<string, unknown>>(row.config_json, {}),
      credentialRef: row.credential_ref,
      enabled: row.enabled === 1,
      health: parseJson<ConnectorRecord['health']>(row.health_json, null),
      lastError: row.last_error,
      sourceSha256: row.source_sha256,
      domains,
    };
  }

  /* ---------------- 工具授权 ---------------- */

  /**
   * 是否已有覆盖该工具的有效授权。
   *
   * 作用域覆盖关系：`always` 覆盖一切；`project` 只在同项目内；`session` 只在同会话内。
   * `once` 从不落库，因此这里不会遇到它。
   */
  isToolAllowed(input: {
    connectorId: string;
    toolName: string;
    conversationId: string | null;
    projectId: string | null;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const rows = this.#db
      .prepare(
        `SELECT * FROM tool_grants
          WHERE connector_id = ? AND tool_name = ? AND revoked_at IS NULL`,
      )
      .all(input.connectorId, input.toolName) as GrantRow[];

    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= now) continue;
      switch (row.scope) {
        case 'always':
          return true;
        case 'project':
          if (input.projectId !== null && row.scope_id === input.projectId) return true;
          break;
        case 'session':
          if (input.conversationId !== null && row.scope_id === input.conversationId) return true;
          break;
        default:
          break;
      }
    }
    return false;
  }

  allowTool(input: {
    connectorId: string;
    toolName: string;
    scope: GrantScope;
    scopeId?: string | null;
    expiresAt?: number | null;
  }): ToolGrant {
    const id = `tg_${randomUUID()}`;
    const grantedAt = Date.now();
    this.#db
      .prepare(
        `INSERT INTO tool_grants
           (id, connector_id, tool_name, scope, scope_id, granted_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.connectorId,
        input.toolName,
        input.scope,
        input.scopeId ?? null,
        grantedAt,
        input.expiresAt ?? null,
      );

    return {
      id,
      connectorId: input.connectorId,
      toolName: input.toolName,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
  }

  listToolGrants(options: { includeRevoked?: boolean } = {}): readonly ToolGrant[] {
    const where = options.includeRevoked === true ? '' : ' WHERE revoked_at IS NULL';
    return (
      this.#db
        .prepare(`SELECT * FROM tool_grants${where} ORDER BY granted_at DESC, rowid DESC`)
        .all() as GrantRow[]
    ).map((row) => ({
      id: row.id,
      connectorId: row.connector_id,
      toolName: row.tool_name,
      scope: row.scope as GrantScope,
      scopeId: row.scope_id,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** 撤销。软删除而不是硬删：「曾经授权过什么」是审计内容。 */
  revokeToolGrant(id: string): boolean {
    return (
      this.#db
        .prepare('UPDATE tool_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(Date.now(), id).changes > 0
    );
  }

  /** 撤销某连接器的全部工具授权。禁用连接器时连带调用。 */
  revokeAllForConnector(connectorId: string): number {
    return this.#db
      .prepare(
        'UPDATE tool_grants SET revoked_at = ? WHERE connector_id = ? AND revoked_at IS NULL',
      )
      .run(Date.now(), connectorId).changes;
  }
}
