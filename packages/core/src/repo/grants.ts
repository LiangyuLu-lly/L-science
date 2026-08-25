/**
 * 授权仓储（应用库，需求 17.5）。
 *
 * 宿主路径授权与域名白名单都放在应用库而不是项目库：授权一次不该因为切项目
 * 而失效。但 `scope`/`scope_id` 允许把一条授权限定到单个项目或单个会话，
 * 因此「跨项目存储」不等于「跨项目生效」。
 *
 * 三条贯穿的判断：
 *
 * 1. **撤销用软删除**（`revoked_at`），不 DELETE。审计需要能回答「这个路径
 *    曾经被授权过吗」，硬删除会让这个问题永远查不出来。
 * 2. **过期与撤销分开判断**。二者都导致授权无效，但过期是预期生命周期结束，
 *    撤销是用户主动收回——UI 上要区分展示，否则用户看不出是自己撤的还是
 *    自然到期。
 * 3. **查询默认只返回当前有效的**。让「取有效授权」成为最省事的调用方式，
 *    是为了让人不会因为图省事而不小心用上已撤销的授权。
 */

import { randomUUID } from 'node:crypto';

import type { GrantScope } from '@l-science/shared';

import type { Db } from '../db.js';

/**
 * 授予的权限级别。
 *
 * 与 `PathGuard` 的 `AccessMode`（`'read' | 'write'`）是两个概念：后者是
 * 「本次尝试的操作是什么」，这里是「授予了什么级别」。一条 `rw` 授权同时
 * 允许 `read` 与 `write` 操作。用同一个名字会掩盖这个区别，进而写出
 * 「授权是 read 所以不能 write」这种看似正确、实则把两层混在一起的判断。
 */
export type GrantMode = 'ro' | 'rw';

export interface HostGrant {
  id: string;
  /** 宿主机上的真实路径。 */
  hostPath: string;
  /** 在沙箱内的挂载点。native 后端下与 hostPath 相同。 */
  guestPath: string | null;
  mode: GrantMode;
  scope: GrantScope;
  /** 作用域对应的 id：project 时是项目 id，session 时是会话 id。 */
  scopeId: string | null;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface DomainGrant {
  id: string;
  domain: string;
  mode: GrantMode;
  scope: GrantScope;
  scopeId: string | null;
  reason: string | null;
  addedAt: number;
}

interface HostGrantRow {
  id: string;
  host_path: string;
  guest_path: string | null;
  mode: string;
  scope: string;
  scope_id: string | null;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

interface DomainGrantRow {
  id: string;
  scope: string;
  scope_id: string | null;
  domain: string;
  mode: string;
  reason: string | null;
  added_at: number;
}

function toHostGrant(row: HostGrantRow): HostGrant {
  return {
    id: row.id,
    hostPath: row.host_path,
    guestPath: row.guest_path,
    mode: row.mode as GrantMode,
    scope: row.scope as GrantScope,
    scopeId: row.scope_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function toDomainGrant(row: DomainGrantRow): DomainGrant {
  return {
    id: row.id,
    domain: row.domain,
    mode: row.mode as GrantMode,
    scope: row.scope as GrantScope,
    scopeId: row.scope_id,
    reason: row.reason,
    addedAt: row.added_at,
  };
}

/** 授权为何无效。用于向用户解释，而不是只说「没权限」。 */
export type GrantInvalidReason =
  'not-found' | 'revoked' | 'expired' | 'scope-mismatch' | 'mode-insufficient';

/** 作用域是否覆盖当前上下文。 */
function scopeCovers(
  grant: { scope: GrantScope; scopeId: string | null },
  context: { projectId?: string | null; conversationId?: string | null },
): boolean {
  switch (grant.scope) {
    case 'always':
      return true;
    case 'project':
      return grant.scopeId !== null && grant.scopeId === context.projectId;
    case 'session':
      return grant.scopeId !== null && grant.scopeId === context.conversationId;
    case 'once':
      // 一次性授权不入库。入库了说明是历史遗留或写入方用错了作用域，
      // 此时按不生效处理——宁可多问一次也不要放行一个语义不明的授权
      return false;
  }
}

export class GrantRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 宿主路径 ---------------- */

  grantHostPath(input: {
    hostPath: string;
    guestPath?: string | null;
    mode: GrantMode;
    scope: GrantScope;
    scopeId?: string | null;
    expiresAt?: number | null;
  }): HostGrant {
    const id = `hg_${randomUUID()}`;
    const grantedAt = Date.now();

    this.#db
      .prepare(
        `INSERT INTO host_grants (id, host_path, guest_path, mode, scope, scope_id, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.hostPath,
        input.guestPath ?? null,
        input.mode,
        input.scope,
        input.scopeId ?? null,
        grantedAt,
        input.expiresAt ?? null,
      );

    return {
      id,
      hostPath: input.hostPath,
      guestPath: input.guestPath ?? null,
      mode: input.mode,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
  }

  /**
   * 查询某个路径当前是否已被授权（需求 17.5）。
   *
   * 返回具体的无效原因而不是简单的 true/false：用户看到「该授权已于昨天过期」
   * 与看到「没有权限」，能采取的行动完全不同。
   */
  checkHostPath(input: {
    hostPath: string;
    requiredMode: GrantMode;
    projectId?: string | null;
    conversationId?: string | null;
    now?: number;
  }):
    { ok: true; grant: HostGrant } | { ok: false; reason: GrantInvalidReason; grant?: HostGrant } {
    const now = input.now ?? Date.now();
    const rows = this.#db
      .prepare('SELECT * FROM host_grants WHERE host_path = ? ORDER BY granted_at DESC')
      .all(input.hostPath) as HostGrantRow[];

    if (rows.length === 0) return { ok: false, reason: 'not-found' };

    const grants = rows.map(toHostGrant);
    // 逐个检查并记住最接近成功的失败原因，这样报告的是「最有帮助的那个原因」
    // 而不是碰巧第一个
    let best: { reason: GrantInvalidReason; grant: HostGrant } | null = null;
    const rank: Record<GrantInvalidReason, number> = {
      'mode-insufficient': 4,
      expired: 3,
      revoked: 2,
      'scope-mismatch': 1,
      'not-found': 0,
    };

    for (const grant of grants) {
      let reason: GrantInvalidReason | null = null;

      if (!scopeCovers(grant, input)) reason = 'scope-mismatch';
      else if (grant.revokedAt !== null) reason = 'revoked';
      else if (grant.expiresAt !== null && grant.expiresAt <= now) reason = 'expired';
      else if (input.requiredMode === 'rw' && grant.mode === 'ro') reason = 'mode-insufficient';

      if (reason === null) return { ok: true, grant };
      if (best === null || rank[reason] > rank[best.reason]) best = { reason, grant };
    }

    return best === null
      ? { ok: false, reason: 'not-found' }
      : { ok: false, reason: best.reason, grant: best.grant };
  }

  /** 撤销一条授权（需求 17.5）。软删除，保留审计痕迹。 */
  revokeHostPath(id: string): boolean {
    return (
      this.#db
        .prepare('UPDATE host_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(Date.now(), id).changes > 0
    );
  }

  listHostGrants(options: { includeInactive?: boolean; now?: number } = {}): readonly HostGrant[] {
    const rows = this.#db
      .prepare('SELECT * FROM host_grants ORDER BY granted_at DESC')
      .all() as HostGrantRow[];
    const grants = rows.map(toHostGrant);
    if (options.includeInactive === true) return grants;

    const now = options.now ?? Date.now();
    return grants.filter(
      (g) => g.revokedAt === null && (g.expiresAt === null || g.expiresAt > now),
    );
  }

  /* ---------------- 域名白名单 ---------------- */

  allowDomain(input: {
    domain: string;
    mode: GrantMode;
    scope: GrantScope;
    scopeId?: string | null;
    reason?: string | null;
  }): DomainGrant {
    const id = `dg_${randomUUID()}`;
    const addedAt = Date.now();

    this.#db
      .prepare(
        `INSERT INTO domain_allowlist (id, scope, scope_id, domain, mode, reason, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.scopeId ?? null,
        // 域名统一小写：DNS 不区分大小写，不归一化会让 Example.com 与
        // example.com 变成两条白名单，用户以为加过了但实际没命中
        input.domain.toLowerCase(),
        input.mode,
        input.reason ?? null,
        addedAt,
      );

    return {
      id,
      domain: input.domain.toLowerCase(),
      mode: input.mode,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      reason: input.reason ?? null,
      addedAt,
    };
  }

  /**
   * 判断域名是否在白名单内。
   *
   * 支持前导点的子域通配（`.example.com` 覆盖 `a.example.com`），但**不做**
   * 后缀包含匹配。后缀匹配的危险很具体：白名单里有 `example.com` 时，
   * `notexample.com` 与 `example.com.evil.net` 都会被误判为命中。
   */
  isDomainAllowed(input: {
    domain: string;
    projectId?: string | null;
    conversationId?: string | null;
  }): { allowed: true; grant: DomainGrant } | { allowed: false } {
    const target = input.domain.toLowerCase();
    const rows = this.#db
      .prepare('SELECT * FROM domain_allowlist ORDER BY added_at DESC')
      .all() as DomainGrantRow[];

    for (const grant of rows.map(toDomainGrant)) {
      if (!scopeCovers(grant, input)) continue;

      const pattern = grant.domain;
      const hit = pattern.startsWith('.')
        ? // .example.com 覆盖自身与全部子域
          target === pattern.slice(1) || target.endsWith(pattern)
        : target === pattern;

      if (hit) return { allowed: true, grant };
    }

    return { allowed: false };
  }

  /** 移除白名单条目。域名白名单直接删除——它没有「曾经允许过」的审计价值，
   * 出站访问本身已经记在 egress_log 里。 */
  removeDomain(id: string): boolean {
    return this.#db.prepare('DELETE FROM domain_allowlist WHERE id = ?').run(id).changes > 0;
  }

  listDomains(): readonly DomainGrant[] {
    const rows = this.#db
      .prepare('SELECT * FROM domain_allowlist ORDER BY added_at DESC')
      .all() as DomainGrantRow[];
    return rows.map(toDomainGrant);
  }

  /** 清理已过期的宿主授权记录。定期调用以免表无限增长。 */
  pruneExpired(olderThanMs = 90 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    return this.#db
      .prepare(
        `DELETE FROM host_grants
         WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
            OR (expires_at IS NOT NULL AND expires_at < ?)`,
      )
      .run(cutoff, cutoff).changes;
  }
}
