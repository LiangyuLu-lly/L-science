/**
 * 宿主路径授权测试（任务 5.5，需求 5.5、17.1、17.5）。
 *
 * 重点在三处：
 * - 路径规范化必须两侧一致，否则会出现「授权了却检查不过」
 * - 明显危险的请求不发审批。反复弹这种卡片会训练用户习惯性点同意
 * - 审批卡片必须说清后果，不只是路径
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '@l-science/shared';
import {
  ApprovalRepo,
  ApprovalService,
  AppStore,
  GrantRepo,
  assessHostPath,
  normalizeHostPath,
  requestHostAccess,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let grants: GrantRepo;
let approvals: ApprovalService;
let published: ApprovalRequest[];
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-ha-'));
  dataDir = join(root, 'external-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'raw.edf'), 'x');

  store = AppStore.open(join(root, 'app'));
  const created = store.createProject({ name: '授权测试' });
  project = store.openProject(created.id);
  grants = new GrantRepo(store.db);
  published = [];
  approvals = new ApprovalService({
    repo: new ApprovalRepo(project.db),
    publish: (r) => published.push(r),
  });
});

afterEach(() => {
  approvals.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const ask = (overrides: Partial<Parameters<typeof requestHostAccess>[0]> = {}) =>
  requestHostAccess({
    grants,
    approvals,
    hostPath: dataDir,
    mode: 'ro',
    purpose: '读取原始 EEG 记录',
    projectId: project.projectId,
    conversationId: 'conv-1',
    ...overrides,
  });

describe('路径规范化', () => {
  it('去掉尾部分隔符', () => {
    // 不统一的话会出现「授权了 E:\data\ 但检查 E:\data 时说没授权」
    expect(normalizeHostPath('E:\\data\\')).toBe(normalizeHostPath('E:\\data'));
  });

  it('大小写归一（Windows 路径不区分大小写）', () => {
    expect(normalizeHostPath('E:\\Data')).toBe(normalizeHostPath('e:\\data'));
  });

  it('折叠 .. 与 .', () => {
    // 不折叠的话 E:\data\..\..\Windows 会被当成 E:\data 的子路径通过检查
    expect(normalizeHostPath('E:\\data\\..\\other')).toBe(normalizeHostPath('E:\\other'));
    expect(normalizeHostPath('E:\\data\\.\\sub')).toBe(normalizeHostPath('E:\\data\\sub'));
  });

  it('折叠重复分隔符', () => {
    expect(normalizeHostPath('E:\\\\data\\\\sub')).toBe(normalizeHostPath('E:\\data\\sub'));
  });
});

describe('危险路径评估', () => {
  it('拒绝盘根', () => {
    const result = assessHostPath('E:\\');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('取消沙箱边界');
  });

  it('拒绝系统目录及其子目录', () => {
    expect(assessHostPath('C:\\Windows').blocked).toBe(true);
    expect(assessHostPath('C:\\Windows\\System32').blocked).toBe(true);
    expect(assessHostPath('C:\\Program Files').blocked).toBe(true);
  });

  it('拒绝相对路径', () => {
    const result = assessHostPath('data\\raw');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('绝对路径');
  });

  it('普通数据目录通过', () => {
    expect(assessHostPath('E:\\research\\eeg').blocked).toBe(false);
  });

  it('名字里含 Windows 但不是系统目录的路径通过', () => {
    // 前缀匹配必须带分隔符，否则 C:\WindowsData 会被误判
    expect(assessHostPath('C:\\WindowsData\\x').blocked).toBe(false);
  });
});

describe('授权流程', () => {
  it('首次请求发起审批，批准后放行并建立授权', async () => {
    const pending = ask({ mode: 'ro' });
    expect(published).toHaveLength(1);

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    const result = await pending;

    expect(result).toMatchObject({ granted: true, source: 'approved' });
    expect(grants.listHostGrants()).toHaveLength(1);
  });

  it('已有有效授权时不再发审批', async () => {
    const first = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await first;

    const second = await ask();
    expect(second).toMatchObject({ granted: true, source: 'existing-grant' });
    expect(published).toHaveLength(1);
  });

  it('once 作用域放行但不建立持久授权', async () => {
    const pending = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'once' });
    const result = await pending;

    expect(result).toMatchObject({ granted: true, source: 'approved' });
    // once 的语义就是「这一次放行」
    expect((result as { grant: unknown }).grant).toBeNull();
    expect(grants.listHostGrants()).toHaveLength(0);
  });

  it('拒绝后不放行且标记为不可重试', async () => {
    const pending = ask();
    approvals.decide({
      approvalId: published[0]?.id ?? '',
      decision: 'deny',
      note: '那个盘是别人的',
    });
    const result = await pending;

    expect(result).toMatchObject({ granted: false, retryable: false });
    expect((result as { reason: string }).reason).toContain('那个盘是别人的');
  });

  it('再次请求同一路径时命中拒绝记忆，不再打扰用户', async () => {
    const first = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    const second = await ask();
    expect(second).toMatchObject({ granted: false, retryable: false });
    expect((second as { reason: string }).reason).toContain('不再重复询问');
    expect(published).toHaveLength(1);
  });

  it('危险路径直接拒绝，不发审批', async () => {
    // 让用户对一个明显错误的请求点「同意」毫无意义，而且反复弹这种卡片
    // 会训练他习惯性点同意
    const result = await ask({ hostPath: 'C:\\Windows\\System32' });
    expect(result).toMatchObject({ granted: false, retryable: false });
    expect(published).toHaveLength(0);
  });

  it('只读授权后请求写入会重新发起审批', async () => {
    const first = ask({ mode: 'ro' });
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await first;

    const second = ask({ mode: 'rw' });
    expect(published).toHaveLength(2);
    // 卡片要说明当前状态，用户才知道自己在升级权限而不是首次授权
    expect(published[1]?.detail).toContain('只读');

    approvals.decide({ approvalId: published[1]?.id ?? '', decision: 'approve', scope: 'project' });
    expect(await second).toMatchObject({ granted: true });
  });

  it('读写授权覆盖只读请求', async () => {
    const first = ask({ mode: 'rw' });
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await first;

    expect(await ask({ mode: 'ro' })).toMatchObject({ source: 'existing-grant' });
  });

  it('超时标记为可重试', async () => {
    const pending = requestHostAccess({
      grants,
      approvals,
      hostPath: dataDir,
      mode: 'ro',
      purpose: 'x',
      projectId: project.projectId,
      conversationId: 'conv-1',
    });
    approvals.cancel(published[0]?.id ?? '', '会话中止');
    const result = await pending;
    // 取消与超时都说明用户没表态，稍后重试合理
    expect(result).toMatchObject({ granted: false, retryable: true });
  });
});

describe('审批卡片说清后果（需求 17.2）', () => {
  it('读写请求说明可以修改与删除', async () => {
    const pending = ask({ mode: 'rw' });
    const card = published[0];

    // 用户看到「允许访问 E:\data 吗」无法判断风险
    expect(card?.impact).toContain('修改');
    expect(card?.impact).toContain('删除');
    expect(card?.impact).toContain('沙箱');

    approvals.decide({ approvalId: card?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('只读请求说明数据会进入上下文并可能发往云端', async () => {
    const pending = ask({ mode: 'ro' });
    // 这是只读授权真正的风险所在，不说清等于隐瞒
    expect(published[0]?.impact).toContain('云端模型');

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('说明撤销不会撤回已发生的读写', async () => {
    const pending = ask();
    // 授权可撤销，但授权期间发生的读写不可撤销。笼统标成可逆是不诚实的
    expect(published[0]?.reversible).toBe(true);
    expect(published[0]?.undoHint).toContain('不会撤回');

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('原文带上调用方给的用途', async () => {
    const pending = ask({ purpose: '读取被试 S03 的睡眠分期标注' });
    expect(published[0]?.detail).toContain('S03');
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('路径不存在时如实说明', async () => {
    const pending = ask({ hostPath: join(root, 'no-such-dir') });
    // 用户以为自己在授权一个已有目录，而实际上不是
    expect(published[0]?.detail).toContain('不存在');
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });

  it('提供四种作用域供选择', async () => {
    const pending = ask();
    // 没有 once 的话用户面对「要么拒绝、要么永久授权」，多数人会选永久，
    // 审批就退化成形式主义
    expect(published[0]?.scopeOptions).toEqual(['once', 'session', 'project', 'always']);
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
  });
});

describe('作用域落地', () => {
  it('project 作用域的授权记在当前项目上', async () => {
    const pending = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await pending;

    const grant = grants.listHostGrants()[0];
    expect(grant).toMatchObject({ scope: 'project', scopeId: project.projectId });
  });

  it('session 作用域的授权记在会话上', async () => {
    const pending = ask({ conversationId: 'conv-xyz' });
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'session' });
    await pending;

    expect(grants.listHostGrants()[0]).toMatchObject({ scope: 'session', scopeId: 'conv-xyz' });
  });

  it('无会话 id 时 session 作用域降级为项目作用域', async () => {
    // scopeId 为 null 的 session 授权永远命中不了，等于用户白点了一次同意
    const pending = ask({ conversationId: null });
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'session' });
    await pending;

    expect(grants.listHostGrants()[0]?.scopeId).toBe(project.projectId);
  });

  it('project 作用域的授权在另一个项目不生效', async () => {
    const pending = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await pending;

    const other = store.createProject({ name: '另一个项目' });
    const result = ask({ projectId: other.id });
    // 换项目后要重新审批
    expect(published).toHaveLength(2);
    approvals.decide({ approvalId: published[1]?.id ?? '', decision: 'approve', scope: 'project' });
    expect(await result).toMatchObject({ granted: true });
  });

  it('撤销后再次请求会重新审批', async () => {
    const first = ask();
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve', scope: 'project' });
    await first;

    grants.revokeHostPath(grants.listHostGrants()[0]?.id ?? '');

    const second = ask();
    expect(published).toHaveLength(2);
    expect(published[1]?.detail).toContain('已被撤销');
    approvals.decide({ approvalId: published[1]?.id ?? '', decision: 'approve', scope: 'project' });
    expect(await second).toMatchObject({ granted: true });
  });
});

describe('盘根规范化的边界', () => {
  it('盘根保留尾部分隔符', () => {
    // 剥成 E: 之后 isAbsolute 返回 false，盘根检查永远跑不到，
    // 请求会被「必须是绝对路径」这条误导性规则拦下。
    // E: 在 Windows 上还有「E 盘的当前目录」这个完全不同的含义
    expect(normalizeHostPath('E:\\')).toBe('e:\\');
    expect(normalizeHostPath('E:\\\\')).toBe('e:\\');
  });

  it('盘根被识别为盘根而不是相对路径', () => {
    const result = assessHostPath('E:\\');
    expect(result.reason).toContain('盘根');
    expect(result.reason).not.toContain('相对路径');
  });

  it('非盘根路径仍然剥掉尾部分隔符', () => {
    expect(normalizeHostPath('E:\\data\\')).toBe('e:\\data');
  });
});
