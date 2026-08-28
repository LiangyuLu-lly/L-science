/**
 * 技能注册表（任务 12.1、12.3，需求 9.1、9.2、9.8）。
 *
 * 技能的**内容**在文件系统上，库里存的是「有哪些、在哪、用户启用了没有」。
 * 这样分工的理由：技能是可以手写的目录，用户直接改文件后不该需要额外操作
 * 才能生效；而「我关掉了这个技能」是用户的决定，不能因为一次重扫就丢掉。
 *
 * 因此扫描是**同步而不是重建**：文件系统消失的技能被禁用并标记，而不是删行。
 * 与模型注册表同一个取舍——删掉会连带丢掉用户的启用选择，而技能目录在开发
 * 过程中被临时移走是常事。
 */

import type { Db } from '../db.js';
import type { LoadedSkill, SkillManifest, SkillScope } from '../skills/manifest.js';

export interface SkillRecord {
  slug: string;
  name: string;
  version: string | null;
  scope: SkillScope;
  domain: string | null;
  /** 技能目录的绝对路径。 */
  path: string;
  manifest: SkillManifest;
  enabled: boolean;
}

interface SkillRow {
  slug: string;
  name: string;
  version: string | null;
  scope: string;
  domain: string | null;
  path: string;
  manifest_json: string;
  enabled: number;
}

function toRecord(row: SkillRow): SkillRecord | null {
  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(row.manifest_json) as SkillManifest;
  } catch {
    // 单条记录损坏不该让整个技能列表读不出来
    return null;
  }
  return {
    slug: row.slug,
    name: row.name,
    version: row.version,
    scope: row.scope === 'user' ? 'user' : 'builtin',
    domain: row.domain,
    path: row.path,
    manifest,
    enabled: row.enabled === 1,
  };
}

export interface SkillSyncResult {
  added: readonly string[];
  updated: readonly string[];
  /** 文件系统上已不存在、因此被禁用的技能。 */
  disappeared: readonly string[];
}

export class SkillRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  upsert(record: SkillRecord): void {
    this.#db
      .prepare(
        `INSERT INTO skills (slug, name, version, scope, domain, path, manifest_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           scope = excluded.scope,
           domain = excluded.domain,
           path = excluded.path,
           manifest_json = excluded.manifest_json`,
      )
      .run(
        record.slug,
        record.name,
        record.version,
        record.scope,
        record.domain,
        record.path,
        JSON.stringify(record.manifest),
        record.enabled ? 1 : 0,
      );
  }

  get(slug: string): SkillRecord | null {
    const row = this.#db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as
      SkillRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  list(options: { includeDisabled?: boolean; scope?: SkillScope } = {}): readonly SkillRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.includeDisabled !== true) clauses.push('enabled = 1');
    if (options.scope !== undefined) {
      clauses.push('scope = ?');
      params.push(options.scope);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM skills${where} ORDER BY domain, slug`)
      .all(...params) as SkillRow[];
    return rows.map(toRecord).filter((r): r is SkillRecord => r !== null);
  }

  setEnabled(slug: string, enabled: boolean): boolean {
    return (
      this.#db.prepare('UPDATE skills SET enabled = ? WHERE slug = ?').run(enabled ? 1 : 0, slug)
        .changes > 0
    );
  }

  /**
   * 把文件系统上扫到的技能同步进库。
   *
   * 新技能默认启用；已存在的保留用户的启用选择——不因为一次重扫就把用户
   * 关掉的技能重新打开。
   */
  sync(skills: readonly LoadedSkill[]): SkillSyncResult {
    const existing = new Map(this.list({ includeDisabled: true }).map((s) => [s.slug, s]));

    const added: string[] = [];
    const updated: string[] = [];

    const run = this.#db.transaction(() => {
      for (const skill of skills) {
        const prior = existing.get(skill.manifest.slug);
        this.upsert({
          slug: skill.manifest.slug,
          name: skill.manifest.name,
          version: skill.manifest.version,
          scope: skill.scope,
          domain: skill.manifest.domain,
          path: skill.path,
          manifest: skill.manifest,
          enabled: prior?.enabled ?? true,
        });
        if (prior === undefined) added.push(skill.manifest.slug);
        else updated.push(skill.manifest.slug);
      }

      const seen = new Set(skills.map((s) => s.manifest.slug));
      const disappeared: string[] = [];
      for (const [slug, record] of existing) {
        if (!seen.has(slug) && record.enabled) {
          this.setEnabled(slug, false);
          disappeared.push(slug);
        }
      }
      return disappeared;
    });

    return { added, updated, disappeared: run() as string[] };
  }
}

/* ------------------------------------------------------------------ *
 * 加载审计（任务 12.3，需求 9.8）
 * ------------------------------------------------------------------ */

/** 技能被加载的原因。区分它们是审计的全部价值所在。 */
export type SkillLoadReason =
  /** 语义检索命中。 */
  | 'search'
  /** 模型或用户点名加载。 */
  | 'explicit'
  /** 计划里的某一步绑定了它。 */
  | 'plan-step'
  /** 作为另一个技能的参考材料被二次加载。 */
  | 'reference';

export interface SkillLoadEvent {
  id: number;
  conversationId: string;
  slug: string;
  reason: SkillLoadReason;
  /** 检索命中时是哪句查询、命中分多少；计划绑定时是哪个步骤。 */
  detail: string | null;
  /** 注入上下文的字符数。用于判断技能是不是把上下文吃掉了。 */
  injectedChars: number;
  at: number;
}

/**
 * 技能加载审计（需求 9.8）。
 *
 * 存在项目库里而不是应用库：「这次会话为什么用了睡眠分期技能」是项目内的
 * 追溯问题，跟着项目一起归档、一起导出才有意义。
 */
export class SkillAuditRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(input: {
    conversationId: string;
    slug: string;
    reason: SkillLoadReason;
    detail?: string | null;
    injectedChars?: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO skill_loads (conversation_id, slug, reason, detail, injected_chars, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.slug,
        input.reason,
        input.detail ?? null,
        input.injectedChars ?? 0,
        Date.now(),
      );
  }

  byConversation(conversationId: string, limit = 200): readonly SkillLoadEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT id, conversation_id, slug, reason, detail, injected_chars, at
           FROM skill_loads WHERE conversation_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, limit) as Array<{
      id: number;
      conversation_id: string;
      slug: string;
      reason: string;
      detail: string | null;
      injected_chars: number;
      at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      slug: r.slug,
      reason: r.reason as SkillLoadReason,
      detail: r.detail,
      injectedChars: r.injected_chars,
      at: r.at,
    }));
  }

  /**
   * 按技能汇总本项目的使用情况。
   *
   * 用途是回答「哪些技能实际在被用」——三十几个内置技能里如果有一半从未命中，
   * 那说明它们的 triggers 写得不对，而不是用户不需要它们。
   */
  summary(): ReadonlyArray<{ slug: string; loads: number; lastAt: number }> {
    return this.#db
      .prepare(
        `SELECT slug, COUNT(*) AS loads, MAX(at) AS lastAt
           FROM skill_loads GROUP BY slug ORDER BY loads DESC`,
      )
      .all() as Array<{ slug: string; loads: number; lastAt: number }>;
  }
}
