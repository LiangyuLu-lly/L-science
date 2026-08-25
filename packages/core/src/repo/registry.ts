/**
 * 供应商与模型注册表仓储（应用库，任务 11.1b）。
 *
 * 注册表是适配器、路由与持久化之间的接合处。它回答三个问题：
 * 配了哪些供应商、每家有哪些模型、每个模型当前能不能用。
 *
 * 一条贯穿的设计：**模型描述整体以 JSON 存一列**（`descriptor_json`），
 * 而不是拆成几十个列。理由是能力向量会随需求演进增删维度，拆列意味着每次
 * 加一个能力维度都要写一次 schema 迁移；而这些字段除了 id 之外从不参与
 * SQL 查询条件——路由把它们全部读进内存再打分。存 JSON 因此没有牺牲任何
 * 查询能力，却省掉了整类迁移。
 */

import type { ModelDescriptor } from '@l-science/shared';

import type { Db } from '../db.js';
import type { ModelRuntimeState } from '../router/index.js';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface ProviderRecord {
  id: string;
  name: string;
  /** 适配器 id，对应 AdapterRegistry 里注册的名字。 */
  adapter: string;
  baseUrl: string | null;
  /** 凭据库里的引用名。**不是凭据本身**——密钥永不进数据库。 */
  credentialRef: string | null;
  policy: Record<string, unknown> | null;
  enabled: boolean;
}

/** 模型的健康状态。与描述分开存，因为它变化频繁而描述基本不变。 */
export interface ModelHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  checkedAt: number;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  /** 传给供应商 API 的模型名。与 id 可能不同（id 带前缀去重时）。 */
  modelName: string;
  descriptor: ModelDescriptor;
  enabled: boolean;
  health: ModelHealth | null;
}

interface ProviderRow {
  id: string;
  name: string;
  adapter: string;
  base_url: string | null;
  credential_ref: string | null;
  policy_json: string | null;
  enabled: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_name: string;
  descriptor_json: string;
  enabled: number;
  health_json: string | null;
}

/* ------------------------------------------------------------------ *
 * 行 <-> 对象
 * ------------------------------------------------------------------ */

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 单条记录的 JSON 损坏不该让整个注册表读不出来。返回 null 让调用方
    // 按「缺失」处理，比抛错让用户完全无法进入设置页要好
    return null;
  }
}

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    policy: parseJson<Record<string, unknown>>(row.policy_json),
    enabled: row.enabled === 1,
  };
}

function toModel(row: ModelRow): ModelRecord | null {
  const descriptor = parseJson<ModelDescriptor>(row.descriptor_json);
  // 描述损坏的模型直接跳过：没有能力向量就无法参与打分，
  // 硬塞一个默认值进去会让路由基于假数据决策
  if (descriptor === null) return null;

  return {
    id: row.id,
    providerId: row.provider_id,
    modelName: row.model_name,
    descriptor,
    enabled: row.enabled === 1,
    health: parseJson<ModelHealth>(row.health_json),
  };
}

/* ------------------------------------------------------------------ *
 * 仓储
 * ------------------------------------------------------------------ */

/** 健康检查结果超过这个时长即视为过期，路由不再采信。 */
export const HEALTH_TTL_MS = 5 * 60 * 1000;

export class RegistryRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 供应商 ---------------- */

  upsertProvider(record: ProviderRecord): void {
    this.#db
      .prepare(
        `INSERT INTO providers (id, name, adapter, base_url, credential_ref, policy_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           adapter = excluded.adapter,
           base_url = excluded.base_url,
           credential_ref = excluded.credential_ref,
           policy_json = excluded.policy_json,
           enabled = excluded.enabled`,
      )
      .run(
        record.id,
        record.name,
        record.adapter,
        record.baseUrl,
        record.credentialRef,
        record.policy === null ? null : JSON.stringify(record.policy),
        record.enabled ? 1 : 0,
      );
  }

  getProvider(id: string): ProviderRecord | null {
    const row = this.#db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined;
    return row === undefined ? null : toProvider(row);
  }

  listProviders(options: { includeDisabled?: boolean } = {}): readonly ProviderRecord[] {
    const sql =
      options.includeDisabled === true
        ? 'SELECT * FROM providers ORDER BY id'
        : 'SELECT * FROM providers WHERE enabled = 1 ORDER BY id';
    return (this.#db.prepare(sql).all() as ProviderRow[]).map(toProvider);
  }

  setProviderEnabled(id: string, enabled: boolean): void {
    this.#db.prepare('UPDATE providers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  /**
   * 删除供应商。
   *
   * 其模型由外键 ON DELETE CASCADE 一并删除。凭据**不删**——用户可能只是
   * 暂时移除这家供应商，把凭据一起删掉会让他重新录入。清理凭据是独立的
   * 显式动作。
   */
  deleteProvider(id: string): boolean {
    return this.#db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------- 模型 ---------------- */

  upsertModel(record: Omit<ModelRecord, 'health'> & { health?: ModelHealth | null }): void {
    this.#db
      .prepare(
        `INSERT INTO models (id, provider_id, model_name, descriptor_json, enabled, health_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider_id = excluded.provider_id,
           model_name = excluded.model_name,
           descriptor_json = excluded.descriptor_json,
           enabled = excluded.enabled`,
      )
      .run(
        record.id,
        record.providerId,
        record.modelName,
        JSON.stringify(record.descriptor),
        record.enabled ? 1 : 0,
        record.health === undefined || record.health === null
          ? null
          : JSON.stringify(record.health),
      );
  }

  getModel(id: string): ModelRecord | null {
    const row = this.#db.prepare('SELECT * FROM models WHERE id = ?').get(id) as
      ModelRow | undefined;
    return row === undefined ? null : toModel(row);
  }

  listModels(
    options: { providerId?: string; includeDisabled?: boolean } = {},
  ): readonly ModelRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.providerId !== undefined) {
      clauses.push('provider_id = ?');
      params.push(options.providerId);
    }
    if (options.includeDisabled !== true) {
      clauses.push('enabled = 1');
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM models${where} ORDER BY provider_id, model_name`)
      .all(...params) as ModelRow[];

    return rows.map(toModel).filter((m): m is ModelRecord => m !== null);
  }

  setModelEnabled(id: string, enabled: boolean): void {
    this.#db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  recordHealth(id: string, health: ModelHealth): void {
    this.#db
      .prepare('UPDATE models SET health_json = ? WHERE id = ?')
      .run(JSON.stringify(health), id);
  }
}

/* ------------------------------------------------------------------ *
 * 模型同步
 * ------------------------------------------------------------------ */

export interface SyncResult {
  added: readonly string[];
  updated: readonly string[];
  /** 线上已不存在、因此被禁用的模型。 */
  disappeared: readonly string[];
}

export class RegistrySync {
  readonly #repo: RegistryRepo;
  readonly #db: Db;

  constructor(db: Db, repo: RegistryRepo) {
    this.#db = db;
    this.#repo = repo;
  }

  /**
   * 把适配器发现的模型同步进注册表。
   *
   * 线上消失的模型被**禁用而不是删除**。删除会连带丢掉两样东西：用户对该模型
   * 的启用/禁用选择，以及历史用量与反馈统计所引用的模型行。供应商下线一个
   * 型号后又恢复（灰度、区域差异都会造成这种抖动）时，删除过的模型会以
   * 「全新模型」身份回来，此前积累的反馈全部作废。
   */
  sync(providerId: string, discovered: readonly ModelDescriptor[]): SyncResult {
    const existing = new Map(
      this.#repo.listModels({ providerId, includeDisabled: true }).map((m) => [m.id, m]),
    );

    const added: string[] = [];
    const updated: string[] = [];

    const run = this.#db.transaction(() => {
      for (const descriptor of discovered) {
        const prior = existing.get(descriptor.id);
        this.#repo.upsertModel({
          id: descriptor.id,
          providerId,
          modelName: descriptor.id,
          descriptor,
          // 新模型默认启用；已存在的保留用户的选择，不因为一次同步就把
          // 用户禁用过的模型重新打开
          enabled: prior?.enabled ?? true,
        });
        if (prior === undefined) added.push(descriptor.id);
        else updated.push(descriptor.id);
      }

      const discoveredIds = new Set(discovered.map((d) => d.id));
      const disappeared: string[] = [];
      for (const [id, record] of existing) {
        if (!discoveredIds.has(id) && record.enabled) {
          this.#repo.setModelEnabled(id, false);
          disappeared.push(id);
        }
      }
      return disappeared;
    });

    const disappeared = run() as string[];
    return { added, updated, disappeared };
  }
}

/* ------------------------------------------------------------------ *
 * 供路由使用的视图
 * ------------------------------------------------------------------ */

/**
 * 组装路由需要的两样东西：模型描述数组与运行时状态映射。
 *
 * 这一层的存在是为了让路由不必知道数据库的形状。它也是「凭据是否存在」这个
 * 判断的落点——路由需要它做硬过滤，但路由本身不该接触凭据库。
 */
export function buildRouterView(input: {
  repo: RegistryRepo;
  /** 判断某个凭据引用名是否已配置。通常传 `(ref) => vault.has(ref)`。 */
  hasCredential: (credentialRef: string | null) => boolean;
  /** 当前时刻，用于判断健康结果是否过期。 */
  now?: number;
}): {
  models: readonly ModelDescriptor[];
  runtime: ReadonlyMap<string, ModelRuntimeState>;
} {
  const { repo, hasCredential, now = Date.now() } = input;

  const providers = new Map(repo.listProviders({ includeDisabled: true }).map((p) => [p.id, p]));
  const records = repo.listModels({ includeDisabled: true });

  const models: ModelDescriptor[] = [];
  const runtime = new Map<string, ModelRuntimeState>();

  for (const record of records) {
    const provider = providers.get(record.providerId);
    models.push(record.descriptor);

    const state: ModelRuntimeState = {
      // 供应商被禁用等价于其下所有模型被禁用。不这样处理的话，
      // 用户在设置里关掉一家供应商后它的模型仍会被选中
      userDisabled: !record.enabled || provider?.enabled === false,
      hasCredential: hasCredential(provider?.credentialRef ?? null),
    };

    // 过期的健康结果不采信：五分钟前不健康不代表现在不健康，
    // 拿旧结果做硬过滤会让恢复了的供应商长期被排除
    if (record.health !== null && now - record.health.checkedAt <= HEALTH_TTL_MS) {
      state.healthy = record.health.ok;
    }

    runtime.set(record.descriptor.id, state);
  }

  return { models, runtime };
}
