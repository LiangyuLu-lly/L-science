/**
 * 授权仓储测试（需求 17.5）。
 *
 * 重点在两处会造成真实安全后果的地方：
 * - 作用域必须真的限制生效范围，而不只是一个记录字段
 * - 域名匹配不能用后缀包含。白名单里有 example.com 时，notexample.com 与
 *   example.com.evil.net 都必须被拒绝
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppStore, GrantRepo } from '@l-science/core';

let root: string;
let store: AppStore;
let grants: GrantRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-grant-'));
  store = AppStore.open(root);
  grants = new GrantRepo(store.db);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('宿主路径授权', () => {
  it('授权后可通过检查', () => {
    grants.grantHostPath({ hostPath: 'D:\\data', mode: 'ro', scope: 'always' });
    const result = grants.checkHostPath({ hostPath: 'D:\\data', requiredMode: 'ro' });
    expect(result.ok).toBe(true);
  });

  it('未授权的路径返回 not-found', () => {
    const result = grants.checkHostPath({ hostPath: 'D:\\other', requiredMode: 'ro' });
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('只读授权不满足写入需求', () => {
    grants.grantHostPath({ hostPath: 'D:\\data', mode: 'ro', scope: 'always' });
    const result = grants.checkHostPath({ hostPath: 'D:\\data', requiredMode: 'rw' });
    expect(result).toMatchObject({ ok: false, reason: 'mode-insufficient' });
  });

  it('读写授权满足只读需求', () => {
    grants.grantHostPath({ hostPath: 'D:\\data', mode: 'rw', scope: 'always' });
    expect(grants.checkHostPath({ hostPath: 'D:\\data', requiredMode: 'ro' }).ok).toBe(true);
  });

  it('撤销后立即失效', () => {
    const grant = grants.grantHostPath({ hostPath: 'D:\\data', mode: 'rw', scope: 'always' });
    expect(grants.revokeHostPath(grant.id)).toBe(true);
    expect(grants.checkHostPath({ hostPath: 'D:\\data', requiredMode: 'ro' })).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });

  it('重复撤销返回 false', () => {
    const grant = grants.grantHostPath({ hostPath: 'D:\\d', mode: 'ro', scope: 'always' });
    expect(grants.revokeHostPath(grant.id)).toBe(true);
    expect(grants.revokeHostPath(grant.id)).toBe(false);
  });

  it('撤销是软删除，审计痕迹保留', () => {
    // 审计需要能回答「这个路径曾经被授权过吗」，硬删除会让它永远查不出来
    const grant = grants.grantHostPath({ hostPath: 'D:\\d', mode: 'ro', scope: 'always' });
    grants.revokeHostPath(grant.id);
    const all = grants.listHostGrants({ includeInactive: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedAt).toBeGreaterThan(0);
  });

  it('过期与撤销是两种不同状态', () => {
    // 二者都导致无效，但用户看不出是自己撤的还是自然到期时无法采取正确行动
    const now = Date.now();
    grants.grantHostPath({
      hostPath: 'D:\\expired',
      mode: 'ro',
      scope: 'always',
      expiresAt: now - 1000,
    });
    expect(
      grants.checkHostPath({ hostPath: 'D:\\expired', requiredMode: 'ro', now }),
    ).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('未到期的授权有效', () => {
    const now = Date.now();
    grants.grantHostPath({
      hostPath: 'D:\\live',
      mode: 'ro',
      scope: 'always',
      expiresAt: now + 60_000,
    });
    expect(grants.checkHostPath({ hostPath: 'D:\\live', requiredMode: 'ro', now }).ok).toBe(true);
  });

  it('默认列表只含当前有效的授权', () => {
    const a = grants.grantHostPath({ hostPath: 'D:\\a', mode: 'ro', scope: 'always' });
    grants.grantHostPath({
      hostPath: 'D:\\b',
      mode: 'ro',
      scope: 'always',
      expiresAt: Date.now() - 1,
    });
    grants.revokeHostPath(
      grants.grantHostPath({ hostPath: 'D:\\c', mode: 'ro', scope: 'always' }).id,
    );

    // 让「取有效授权」成为最省事的调用方式，人就不会因为图省事而用上已撤销的
    expect(grants.listHostGrants().map((g) => g.id)).toEqual([a.id]);
    expect(grants.listHostGrants({ includeInactive: true })).toHaveLength(3);
  });
});

describe('作用域真的限制生效范围', () => {
  it('project 作用域只在该项目内生效', () => {
    grants.grantHostPath({
      hostPath: 'D:\\p',
      mode: 'ro',
      scope: 'project',
      scopeId: 'proj-1',
    });

    expect(
      grants.checkHostPath({ hostPath: 'D:\\p', requiredMode: 'ro', projectId: 'proj-1' }).ok,
    ).toBe(true);
    expect(
      grants.checkHostPath({ hostPath: 'D:\\p', requiredMode: 'ro', projectId: 'proj-2' }),
    ).toMatchObject({ ok: false, reason: 'scope-mismatch' });
  });

  it('session 作用域只在该会话内生效', () => {
    grants.grantHostPath({
      hostPath: 'D:\\s',
      mode: 'ro',
      scope: 'session',
      scopeId: 'conv-1',
    });

    expect(
      grants.checkHostPath({ hostPath: 'D:\\s', requiredMode: 'ro', conversationId: 'conv-1' }).ok,
    ).toBe(true);
    expect(
      grants.checkHostPath({ hostPath: 'D:\\s', requiredMode: 'ro', conversationId: 'conv-2' }),
    ).toMatchObject({ ok: false, reason: 'scope-mismatch' });
  });

  it('always 作用域在任何上下文生效', () => {
    grants.grantHostPath({ hostPath: 'D:\\a', mode: 'ro', scope: 'always' });
    expect(
      grants.checkHostPath({
        hostPath: 'D:\\a',
        requiredMode: 'ro',
        projectId: 'any',
        conversationId: 'any',
      }).ok,
    ).toBe(true);
  });

  it('once 作用域即便入库也不生效', () => {
    // 一次性授权不该入库。入库了说明写入方用错了作用域，
    // 此时按不生效处理——宁可多问一次也不要放行语义不明的授权
    grants.grantHostPath({ hostPath: 'D:\\o', mode: 'ro', scope: 'once' });
    expect(grants.checkHostPath({ hostPath: 'D:\\o', requiredMode: 'ro' })).toMatchObject({
      ok: false,
      reason: 'scope-mismatch',
    });
  });

  it('同一路径的多条授权中任一条满足即通过', () => {
    grants.grantHostPath({ hostPath: 'D:\\m', mode: 'ro', scope: 'project', scopeId: 'p1' });
    grants.grantHostPath({ hostPath: 'D:\\m', mode: 'rw', scope: 'always' });
    expect(grants.checkHostPath({ hostPath: 'D:\\m', requiredMode: 'rw' }).ok).toBe(true);
  });

  it('全部不满足时报告最有帮助的那个原因', () => {
    // 报告碰巧第一个原因会误导用户。这里 mode-insufficient 比 scope-mismatch
    // 更可执行：它说明路径确实授权过，只是权限不够
    grants.grantHostPath({ hostPath: 'D:\\r', mode: 'ro', scope: 'project', scopeId: 'other' });
    grants.grantHostPath({ hostPath: 'D:\\r', mode: 'ro', scope: 'always' });
    const result = grants.checkHostPath({ hostPath: 'D:\\r', requiredMode: 'rw' });
    expect(result).toMatchObject({ ok: false, reason: 'mode-insufficient' });
  });
});

describe('域名白名单', () => {
  it('精确匹配', () => {
    grants.allowDomain({ domain: 'example.com', mode: 'ro', scope: 'always' });
    expect(grants.isDomainAllowed({ domain: 'example.com' }).allowed).toBe(true);
  });

  it('不做后缀包含匹配', () => {
    // 白名单里有 example.com 时，这两个都必须被拒绝
    grants.allowDomain({ domain: 'example.com', mode: 'ro', scope: 'always' });
    expect(grants.isDomainAllowed({ domain: 'notexample.com' }).allowed).toBe(false);
    expect(grants.isDomainAllowed({ domain: 'example.com.evil.net' }).allowed).toBe(false);
  });

  it('精确条目不覆盖子域', () => {
    grants.allowDomain({ domain: 'example.com', mode: 'ro', scope: 'always' });
    expect(grants.isDomainAllowed({ domain: 'api.example.com' }).allowed).toBe(false);
  });

  it('前导点表示覆盖自身与全部子域', () => {
    grants.allowDomain({ domain: '.example.com', mode: 'ro', scope: 'always' });
    expect(grants.isDomainAllowed({ domain: 'example.com' }).allowed).toBe(true);
    expect(grants.isDomainAllowed({ domain: 'api.example.com' }).allowed).toBe(true);
    expect(grants.isDomainAllowed({ domain: 'a.b.example.com' }).allowed).toBe(true);
    // 通配也不能被后缀欺骗
    expect(grants.isDomainAllowed({ domain: 'notexample.com' }).allowed).toBe(false);
  });

  it('域名大小写归一', () => {
    // DNS 不区分大小写。不归一化会让 Example.com 与 example.com 变成两条，
    // 用户以为加过了但实际没命中
    grants.allowDomain({ domain: 'Example.COM', mode: 'ro', scope: 'always' });
    expect(grants.isDomainAllowed({ domain: 'example.com' }).allowed).toBe(true);
    expect(grants.isDomainAllowed({ domain: 'EXAMPLE.com' }).allowed).toBe(true);
  });

  it('作用域同样限制白名单生效范围', () => {
    grants.allowDomain({ domain: 'p.com', mode: 'ro', scope: 'project', scopeId: 'p1' });
    expect(grants.isDomainAllowed({ domain: 'p.com', projectId: 'p1' }).allowed).toBe(true);
    expect(grants.isDomainAllowed({ domain: 'p.com', projectId: 'p2' }).allowed).toBe(false);
  });

  it('移除后不再命中', () => {
    const grant = grants.allowDomain({ domain: 'x.com', mode: 'ro', scope: 'always' });
    expect(grants.removeDomain(grant.id)).toBe(true);
    expect(grants.isDomainAllowed({ domain: 'x.com' }).allowed).toBe(false);
  });

  it('记录添加理由，供事后审查', () => {
    grants.allowDomain({
      domain: 'pubmed.ncbi.nlm.nih.gov',
      mode: 'ro',
      scope: 'always',
      reason: '文献检索',
    });
    expect(grants.listDomains()[0]?.reason).toBe('文献检索');
  });
});

describe('清理', () => {
  it('清理很久以前撤销或过期的记录', () => {
    const long = 100 * 24 * 60 * 60 * 1000;
    grants.grantHostPath({
      hostPath: 'D:\\old',
      mode: 'ro',
      scope: 'always',
      expiresAt: Date.now() - long,
    });
    const live = grants.grantHostPath({ hostPath: 'D:\\live', mode: 'ro', scope: 'always' });

    expect(grants.pruneExpired()).toBe(1);
    expect(grants.listHostGrants({ includeInactive: true }).map((g) => g.id)).toEqual([live.id]);
  });

  it('不清理近期撤销的记录', () => {
    const grant = grants.grantHostPath({ hostPath: 'D:\\recent', mode: 'ro', scope: 'always' });
    grants.revokeHostPath(grant.id);
    expect(grants.pruneExpired()).toBe(0);
  });
});
