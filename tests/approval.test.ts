/**
 * 审批与用户交互测试（任务 8.1、8.2，需求 17）。
 *
 * 重点在四处：
 * - 并发审批互不串号（任务 8.1 明确要求）
 * - 拒绝语义正确传播，且拒绝后不再打扰用户（需求 17.3）
 * - 超时与显式拒绝的区别不被抹平（重试语义相反）
 * - 关闭时等待者被逐一 resolve，否则进程关不掉
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest, UserQuestion } from '@l-science/shared';
import {
  ApprovalRepo,
  ApprovalService,
  AppStore,
  QuestionService,
  approvalFingerprint,
  stableStringify,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let repo: ApprovalRepo;
let published: ApprovalRequest[];
let service: ApprovalService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-ap-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '审批测试' });
  project = store.openProject(created.id);
  repo = new ApprovalRepo(project.db);
  published = [];
  service = new ApprovalService({ repo, publish: (r) => published.push(r) });
});

afterEach(() => {
  service.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const draft = (overrides: Partial<Parameters<ApprovalService['request']>[0]> = {}) => ({
  kind: 'artifact-delete' as const,
  title: '删除制品 fig1.png',
  detail: '该制品有 3 个版本，均将被删除。',
  impact: '引用它的 2 处手稿段落会失去图片。',
  reversible: false,
  payload: { artifactId: 'a1' },
  ...overrides,
});

describe('指纹', () => {
  it('相同载荷得到相同指纹', () => {
    expect(approvalFingerprint('artifact-delete', { a: 1 })).toBe(
      approvalFingerprint('artifact-delete', { a: 1 }),
    );
  });

  it('键顺序不影响指纹', () => {
    // JSON.stringify 保留插入顺序，用它做指纹会让「同一个请求」因构造顺序
    // 不同算成两个，拒绝记忆随之无声失效
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(approvalFingerprint('host-access', { path: 'x', mode: 'ro' })).toBe(
      approvalFingerprint('host-access', { mode: 'ro', path: 'x' }),
    );
  });

  it('不同种类的相同载荷指纹不同', () => {
    expect(approvalFingerprint('artifact-delete', { a: 1 })).not.toBe(
      approvalFingerprint('host-access', { a: 1 }),
    );
  });

  it('嵌套结构与数组也稳定', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }));
  });

  it('undefined 字段不参与指纹', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('审批请求与决议', () => {
  it('推送给用户后挂起，批准后返回 approved', async () => {
    const pending = service.request(draft());
    // 先登记等待者再推送，因此推送时等待者一定已就位
    expect(published).toHaveLength(1);

    const id = published[0]?.id ?? '';
    expect(service.decide({ approvalId: id, decision: 'approve' })).toBe(true);

    const result = await pending;
    expect(result.state).toBe('approved');
  });

  it('请求携带影响范围与可逆性', async () => {
    const pending = service.request(draft());
    const request = published[0];
    // 需求 17.2：必须说明将要发生什么、影响范围、是否可逆
    expect(request?.title).toContain('fig1.png');
    expect(request?.impact).toContain('手稿');
    expect(request?.reversible).toBe(false);
    expect(request?.undoHint).toBeNull();

    service.decide({ approvalId: request?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('可逆操作带上撤销提示', async () => {
    const pending = service.request(
      draft({ reversible: true, undoHint: '可在回收站中恢复 30 天内的版本。' }),
    );
    expect(published[0]?.reversible).toBe(true);
    expect(published[0]?.undoHint).toContain('回收站');
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('拒绝返回 denied 并带上备注', async () => {
    const pending = service.request(draft());
    service.decide({
      approvalId: published[0]?.id ?? '',
      decision: 'deny',
      note: '这张图还要用',
    });

    const result = await pending;
    expect(result).toMatchObject({ state: 'denied', fromPriorDenial: false, note: '这张图还要用' });
  });

  it('决议不存在的 id 返回 false 而不是静默成功', () => {
    // 静默成功会让「点了没反应」这类问题无从排查
    expect(service.decide({ approvalId: 'ap_nonexistent', decision: 'approve' })).toBe(false);
  });

  it('同一审批不能决议两次', async () => {
    const pending = service.request(draft());
    const id = published[0]?.id ?? '';
    expect(service.decide({ approvalId: id, decision: 'approve' })).toBe(true);
    expect(service.decide({ approvalId: id, decision: 'deny' })).toBe(false);
    expect((await pending).state).toBe('approved');
  });

  it('拒绝以正常结果返回而不是抛异常', async () => {
    // 用异常表达拒绝会让调用方倾向于 try/catch 后继续执行，
    // 那正是审批要防止的事
    const pending = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await expect(pending).resolves.toMatchObject({ state: 'denied' });
  });
});

describe('并发审批互不串号（任务 8.1）', () => {
  it('三个并发审批各自拿到自己的结果', async () => {
    const a = service.request(draft({ payload: { artifactId: 'a' } }));
    const b = service.request(draft({ payload: { artifactId: 'b' } }));
    const c = service.request(draft({ payload: { artifactId: 'c' } }));

    expect(published).toHaveLength(3);
    const [ra, rb, rc] = published;

    // 刻意按 b、c、a 的顺序决议，且决议内容各不相同
    service.decide({ approvalId: rb?.id ?? '', decision: 'deny', note: 'B 被拒' });
    service.decide({ approvalId: rc?.id ?? '', decision: 'approve', note: 'C 通过' });
    service.decide({ approvalId: ra?.id ?? '', decision: 'approve', note: 'A 通过' });

    expect(await a).toMatchObject({ state: 'approved', note: 'A 通过' });
    expect(await b).toMatchObject({ state: 'denied', note: 'B 被拒' });
    expect(await c).toMatchObject({ state: 'approved', note: 'C 通过' });
  });

  it('每个审批有独立的 id', () => {
    void service.request(draft({ payload: { n: 1 } }));
    void service.request(draft({ payload: { n: 2 } }));
    expect(published[0]?.id).not.toBe(published[1]?.id);
  });

  it('pending 列出全部待决议项', () => {
    void service.request(draft({ payload: { n: 1 } }));
    void service.request(draft({ payload: { n: 2 } }));
    expect(service.pending()).toHaveLength(2);

    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    expect(service.pending()).toHaveLength(1);
  });
});

describe('拒绝后不重试同一请求（需求 17.3）', () => {
  it('第二次发起同一请求直接返回拒绝，不再打扰用户', async () => {
    const first = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny', note: '不行' });
    await first;

    const publishedBefore = published.length;
    const second = await service.request(draft());

    // 没有记忆的话，循环里的 agent 能拿同一件事问用户几十次，
    // 用户最终会为了脱身而点同意——这比不问更糟
    expect(second).toMatchObject({ state: 'denied', fromPriorDenial: true, note: '不行' });
    expect(published).toHaveLength(publishedBefore);
  });

  it('载荷不同的请求仍会正常询问', async () => {
    const first = service.request(draft({ payload: { artifactId: 'a1' } }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    const second = service.request(draft({ payload: { artifactId: 'a2' } }));
    expect(published).toHaveLength(2);
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    expect((await second).state).toBe('approved');
  });

  it('批准过的请求不会被记成拒绝', async () => {
    const first = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await first;

    const second = service.request(draft());
    // 批准不建立记忆：同一操作再次发生时仍应确认
    expect(published).toHaveLength(2);
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    expect((await second).state).toBe('approved');
  });

  it('拒绝记忆按会话隔离', async () => {
    const first = service.request(draft({ conversationId: 'conv-a' }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    // 在一个会话里拒绝，不该让另一个会话永久做不了
    const second = service.request(draft({ conversationId: 'conv-b' }));
    expect(published).toHaveLength(2);
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    expect((await second).state).toBe('approved');
  });

  it('撤销拒绝记忆后可以重新询问', async () => {
    const first = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    service.forgetDenial('artifact-delete', { artifactId: 'a1' }, null);

    const second = service.request(draft());
    // 用户改变主意时应该能重新被询问
    expect(published).toHaveLength(2);
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    expect((await second).state).toBe('approved');
  });

  it('拒绝记忆不跨进程重启，重启后用户仍会被询问', async () => {
    const first = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny', note: '当时不批' });
    await first;

    // 永久拒绝会造成相反的困扰：用户隔天回来明确表示现在可以了，
    // 系统却仍然直接拒绝，且不给他被询问的机会
    const askedAgain: ApprovalRequest[] = [];
    const revived = new ApprovalService({ repo, publish: (r) => askedAgain.push(r) });
    const pending = revived.request(draft());
    expect(askedAgain).toHaveLength(1);

    revived.decide({ approvalId: askedAgain[0]?.id ?? '', decision: 'approve' });
    expect((await pending).state).toBe('approved');
    revived.close();
  });

  it('历史拒绝可查询，供 UI 提示上下文而不替用户决定', async () => {
    const first = service.request(draft());
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny', note: '当时不批' });
    await first;

    // 提供信息与代替判断是两件事
    const prior = service.priorDenialOf('artifact-delete', { artifactId: 'a1' }, null);
    expect(prior).toMatchObject({ note: '当时不批' });
    expect(prior?.decidedAt).toBeGreaterThan(0);
  });
});

describe('超时与显式拒绝的区别', () => {
  it('超时返回 timeout 而不是 denied', async () => {
    vi.useFakeTimers();
    try {
      const pending = service.request(draft({ timeoutMs: 1000 }));
      vi.advanceTimersByTime(1001);
      const result = await pending;
      // 两者都阻止操作，但重试语义相反：显式拒绝表达了用户意志不允许再问，
      // 超时只说明用户当时不在
      expect(result.state).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时不建立拒绝记忆，稍后可重新发起', async () => {
    vi.useFakeTimers();
    try {
      const pending = service.request(draft({ timeoutMs: 1000 }));
      vi.advanceTimersByTime(1001);
      await pending;

      const second = service.request(draft({ timeoutMs: 1000 }));
      expect(published).toHaveLength(2);
      service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
      expect((await second).state).toBe('approved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('在超时前决议则超时不再触发', async () => {
    vi.useFakeTimers();
    try {
      const pending = service.request(draft({ timeoutMs: 1000 }));
      service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
      vi.advanceTimersByTime(5000);
      expect((await pending).state).toBe('approved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeoutMs 为 0 表示不超时', () => {
    void service.request(draft({ timeoutMs: 0 }));
    expect(service.pending()[0]?.deadline).toBeNull();
  });
});

describe('授权作用域（需求 17.5）', () => {
  it('批准时返回用户选择的作用域', async () => {
    const pending = service.request(
      draft({ kind: 'host-access', scopeOptions: ['once', 'session', 'project', 'always'] }),
    );
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    expect(await pending).toMatchObject({ state: 'approved', scope: 'project' });
  });

  it('未提供作用域选项时视为一次性', async () => {
    const pending = service.request(draft());
    expect(published[0]?.scopeOptions).toEqual([]);
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'always' });
    // 请求没提供选项，用户提交的 always 不该被采纳
    expect(await pending).toMatchObject({ scope: 'once' });
  });

  it('提交了不在选项里的作用域时降级到最保守的可选项', async () => {
    const pending = service.request(draft({ scopeOptions: ['session', 'project'] }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'always' });
    // 取最保守的而不是列表第一个——顺序不该影响安全默认值
    expect(await pending).toMatchObject({ scope: 'session' });
  });

  it('没选作用域时取最保守的可选项', async () => {
    const pending = service.request(draft({ scopeOptions: ['project', 'once', 'always'] }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    expect(await pending).toMatchObject({ scope: 'once' });
  });
});

describe('授权有效期（需求 17.5）', () => {
  it('有持久作用域时自动提供有效期档位', () => {
    void service.request(draft({ scopeOptions: ['once', 'project'] }));
    expect(published[0]?.expiryOptions.length).toBeGreaterThan(0);
    // 档位里必须有「不过期」这一项——用户明确要长期授权时得有这个选择
    expect(published[0]?.expiryOptions).toContain(null);
  });

  it('一次性确认不提供有效期选择', () => {
    // 那次放行在操作结束的一刻就结束了，「7 天」对它没有意义
    void service.request(draft());
    expect(published[0]?.expiryOptions).toEqual([]);
  });

  it('用户选的有效期被换算成到期时刻', async () => {
    const pending = service.request(
      draft({ scopeOptions: ['project'], expiryOptions: [3_600_000, null] }),
    );
    service.decide({
      approvalId: published[0]?.id ?? '',
      decision: 'approve',
      scope: 'project',
      expiresInMs: 3_600_000,
    });
    const result = await pending;
    expect(result.state).toBe('approved');
    if (result.state !== 'approved') return;
    expect(result.expiresAt).not.toBeNull();
    expect((result.expiresAt ?? 0) - Date.now()).toBeGreaterThan(3_500_000);
  });

  it('选「不过期」时 expiresAt 为 null', async () => {
    const pending = service.request(
      draft({ scopeOptions: ['project'], expiryOptions: [3_600_000, null] }),
    );
    service.decide({
      approvalId: published[0]?.id ?? '',
      decision: 'approve',
      scope: 'project',
      expiresInMs: null,
    });
    expect(await pending).toMatchObject({ expiresAt: null });
  });

  it('不在档位里的有效期不被采纳，落到该作用域的默认值', async () => {
    const pending = service.request(
      draft({ scopeOptions: ['project'], expiryOptions: [3_600_000, null] }),
    );
    service.decide({
      approvalId: published[0]?.id ?? '',
      decision: 'approve',
      scope: 'project',
      // 1 分钟不在提供的档位里：通常是 UI 与后端版本不一致
      expiresInMs: 60_000,
    });
    // project 作用域的默认是「跟随项目生命周期」，因此 null
    expect(await pending).toMatchObject({ expiresAt: null });
  });

  it('always 默认给一个到期日而不是永久', async () => {
    /*
     * 「所有项目内都不再询问」是最宽的一档，而用户按下它时想的通常是
     * 「这段时间我都在弄这个」，不是「余生都同意」。给一个到期日意味着这条授权会被
     * 重新审视一次，而重新审视是这类宽授权唯一的安全阀。
     */
    const pending = service.request(draft({ scopeOptions: ['always'] }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'always' });
    const result = await pending;
    if (result.state !== 'approved') throw new Error('应当获批');
    expect(result.expiresAt).not.toBeNull();
  });

  it('once 恒无到期时刻', async () => {
    const pending = service.request(draft({ scopeOptions: ['once', 'project'] }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'once' });
    // 它不产生持久授权，写上一个到期时刻会让调用方误以为要落库
    expect(await pending).toMatchObject({ scope: 'once', expiresAt: null });
  });
});

describe('审批历史与拒绝记忆的撤销（需求 17.1、17.5）', () => {
  it('history 带上当时给用户看的内容', async () => {
    const pending = service.request(
      draft({ title: '删除 3 个制品？', impact: '磁盘上的文件会被移除' }),
    );
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;

    const rows = service.history();
    expect(rows).toHaveLength(1);
    // 只记 kind 与 state 的话，事后无法判断那次同意是基于一份完整说明还是一句含糊提示
    expect(rows[0]?.request.title).toBe('删除 3 个制品？');
    expect(rows[0]?.request.impact).toBe('磁盘上的文件会被移除');
    expect(rows[0]?.state).toBe('approved');
  });

  it('history 区分「历史上被拒过」与「现在还在拦截」', async () => {
    const pending = service.request(draft({ payload: { path: 'D:/x' } }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'deny', note: '不行' });
    await pending;

    const denied = service.history({ state: 'denied' });
    expect(denied).toHaveLength(1);
    // 用户看到一条三天前的拒绝记录时，他想知道的是「现在还挡着吗」
    expect(denied[0]?.stillDenied).toBe(true);
  });

  it('按 id 撤销拒绝记忆之后同一请求会重新询问', async () => {
    const first = service.request(draft({ payload: { path: 'D:/x' } }));
    const id = published[0]?.id ?? '';
    service.decide({ approvalId: id, decision: 'deny' });
    await first;

    // 撤销之前：同一请求被自动拒绝，不再打扰用户
    const auto = await service.request(draft({ payload: { path: 'D:/x' } }));
    expect(auto).toMatchObject({ state: 'denied', fromPriorDenial: true });

    expect(service.forgetDenialById(id)).toBe(true);
    expect(service.history({ state: 'denied' })[0]?.stillDenied).toBe(false);

    // 撤销之后：重新发起会真的挂起等用户决定
    const reopened = service.request(draft({ payload: { path: 'D:/x' } }));
    expect(service.pending()).toHaveLength(1);
    service.decide({ approvalId: service.pending()[0]?.request.id ?? '', decision: 'approve' });
    expect(await reopened).toMatchObject({ state: 'approved' });
  });

  it('撤销一条不是被拒绝的记录返回假', async () => {
    const pending = service.request(draft());
    const id = published[0]?.id ?? '';
    service.decide({ approvalId: id, decision: 'approve' });
    await pending;
    expect(service.forgetDenialById(id)).toBe(false);
    expect(service.forgetDenialById('ap_不存在')).toBe(false);
  });
});

describe('取消与关闭', () => {
  it('取消返回 cancelled', async () => {
    const pending = service.request(draft());
    expect(service.cancel(published[0]?.id ?? '', '会话被中止')).toBe(true);
    expect(await pending).toMatchObject({ state: 'cancelled', reason: '会话被中止' });
  });

  it('关闭时全部等待者被 resolve 而不是丢弃', async () => {
    // 丢弃会让 await 它们的调用方永久挂起，进程也就永远关不掉
    const a = service.request(draft({ payload: { n: 1 } }));
    const b = service.request(draft({ payload: { n: 2 } }));
    service.close('测试关闭');

    expect(await a).toMatchObject({ state: 'cancelled' });
    expect(await b).toMatchObject({ state: 'cancelled' });
  });

  it('关闭后新请求立即返回 cancelled', async () => {
    service.close();
    expect(await service.request(draft())).toMatchObject({ state: 'cancelled' });
  });

  it('取消不建立拒绝记忆', async () => {
    const pending = service.request(draft());
    service.cancel(published[0]?.id ?? '', '中止');
    await pending;

    const second = service.request(draft());
    expect(published).toHaveLength(2);
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    expect((await second).state).toBe('approved');
  });
});

describe('审计记录', () => {
  it('审批写入数据库并记录终态', async () => {
    const pending = service.request(draft({ conversationId: 'conv-1' }));
    const id = published[0]?.id ?? '';
    expect(repo.get(id)?.state).toBe('pending');

    service.decide({ approvalId: id, decision: 'deny', note: '不批' });
    await pending;

    const row = repo.get(id);
    expect(row).toMatchObject({ state: 'denied', note: '不批', conversationId: 'conv-1' });
    expect(row?.decidedAt).toBeGreaterThan(0);
  });

  it('存的是当时展示给用户的完整请求', async () => {
    // 审计需要的是「当时给用户看的是什么」，而不是当时的载荷加今天的文案模板
    const pending = service.request(draft());
    const id = published[0]?.id ?? '';
    service.decide({ approvalId: id, decision: 'approve' });
    await pending;

    const row = repo.get(id);
    expect(row?.request.impact).toContain('手稿');
    expect(row?.request.reversible).toBe(false);
  });

  it('遗留的 pending 记录在服务启动时被标为 abandoned', () => {
    // 进程重启后等待这些审批的调用方已不存在。留着 pending 会让 UI 显示
    // 一堆点了没反应的卡片——比没有卡片更糟
    void service.request(draft());
    const id = published[0]?.id ?? '';
    expect(repo.get(id)?.state).toBe('pending');

    const revived = new ApprovalService({ repo, publish: () => undefined });
    expect(repo.get(id)?.state).toBe('abandoned');
    revived.close();
  });

  it('按会话列出审批历史', async () => {
    const a = service.request(draft({ conversationId: 'c1', payload: { n: 1 } }));
    const b = service.request(draft({ conversationId: 'c2', payload: { n: 2 } }));
    service.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    service.decide({ approvalId: published[1]?.id ?? '', decision: 'approve' });
    await Promise.all([a, b]);

    expect(repo.list({ conversationId: 'c1' })).toHaveLength(1);
    expect(repo.list({ state: 'approved' })).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * ask_user（任务 8.2，需求 17.4）
 * ------------------------------------------------------------------ */

describe('向用户提问', () => {
  let asked: UserQuestion[];
  let questions: QuestionService;

  beforeEach(() => {
    asked = [];
    questions = new QuestionService({ publish: (q) => asked.push(q) });
  });

  afterEach(() => {
    questions.close();
  });

  it('提问后挂起，作答后返回答案', async () => {
    const pending = questions.ask({ kind: 'general', question: '用哪个显著性水平？' });
    expect(asked).toHaveLength(1);

    expect(questions.answer(asked[0]?.id ?? '', '0.05')).toBe(true);
    expect(await pending).toEqual({ state: 'answered', answer: '0.05' });
  });

  it('区分一般提问与算力配置提问（需求 17.4）', async () => {
    const a = questions.ask({ kind: 'general', question: '一般问题' });
    const b = questions.ask({ kind: 'compute-config', question: '用哪个分区？' });

    // 算力配置类提问需要展示可用算力目标、分区、账户等上下文，
    // UI 渲染方式与一般提问完全不同
    expect(asked[0]?.kind).toBe('general');
    expect(asked[1]?.kind).toBe('compute-config');

    questions.answer(asked[0]?.id ?? '', 'x');
    questions.answer(asked[1]?.id ?? '', 'gpu');
    await Promise.all([a, b]);
  });

  it('空串是有效答案', async () => {
    // 「没有补充」是有效信息，与「用户没答」必须区分
    const pending = questions.ask({ kind: 'general', question: '还有补充吗？' });
    questions.answer(asked[0]?.id ?? '', '');
    expect(await pending).toEqual({ state: 'answered', answer: '' });
  });

  it('预设选项被传递给 UI', async () => {
    const pending = questions.ask({
      kind: 'general',
      question: '选一个',
      choices: ['甲', '乙'],
    });
    expect(asked[0]?.choices).toEqual(['甲', '乙']);
    questions.answer(asked[0]?.id ?? '', '丙');
    // 允许答一个不在选项里的值——预设选项常漏掉用户真正想说的那个
    expect(await pending).toMatchObject({ answer: '丙' });
  });

  it('并发提问互不串号', async () => {
    const a = questions.ask({ kind: 'general', question: 'Q1' });
    const b = questions.ask({ kind: 'general', question: 'Q2' });

    questions.answer(asked[1]?.id ?? '', 'A2');
    questions.answer(asked[0]?.id ?? '', 'A1');

    expect(await a).toMatchObject({ answer: 'A1' });
    expect(await b).toMatchObject({ answer: 'A2' });
  });

  it('作答不存在的 id 返回 false', () => {
    expect(questions.answer('q_nope', 'x')).toBe(false);
  });

  it('超时返回 timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = questions.ask({ kind: 'general', question: 'Q', timeoutMs: 500 });
      vi.advanceTimersByTime(501);
      expect((await pending).state).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('按会话批量取消', async () => {
    const a = questions.ask({ kind: 'general', question: 'Q1', conversationId: 'c1' });
    const b = questions.ask({ kind: 'general', question: 'Q2', conversationId: 'c1' });
    const c = questions.ask({ kind: 'general', question: 'Q3', conversationId: 'c2' });

    expect(questions.cancelConversation('c1', '会话中止')).toBe(2);
    expect(await a).toMatchObject({ state: 'cancelled' });
    expect(await b).toMatchObject({ state: 'cancelled' });

    questions.answer(asked[2]?.id ?? '', 'A3');
    expect(await c).toMatchObject({ answer: 'A3' });
  });

  it('关闭时全部等待者被 resolve', async () => {
    const a = questions.ask({ kind: 'general', question: 'Q1' });
    questions.close('关闭');
    expect(await a).toMatchObject({ state: 'cancelled', reason: '关闭' });
  });

  it('关闭后新提问立即返回 cancelled', async () => {
    questions.close();
    expect(await questions.ask({ kind: 'general', question: 'Q' })).toMatchObject({
      state: 'cancelled',
    });
  });
});
