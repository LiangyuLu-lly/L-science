/**
 * 仓储与存储门面测试（任务 3.1-3.3）。
 *
 * 重点在跨越数据库与文件系统的那几个操作：创建与删除项目无法放进单个事务，
 * 因此测的是「中途失败时留下的是哪种不一致」——必须是可被发现的孤儿目录，
 * 而不是注册表指向一个打不开的项目。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppStore, projectPaths, type ProjectStore } from '@l-science/core';

let root: string;
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-repo-'));
  store = AppStore.open(root);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * AppStore 与项目
 * ------------------------------------------------------------------ */

describe('AppStore', () => {
  it('打开时建出全部数据目录', () => {
    for (const p of [
      store.paths.config,
      store.paths.credentials,
      store.paths.projects,
      store.paths.runtimeKernels,
      store.paths.runtimeEnvs,
      store.paths.skillsBuiltin,
      store.paths.skillsUser,
      store.paths.logs,
    ]) {
      expect(existsSync(p), p).toBe(true);
    }
    expect(existsSync(store.paths.appDb)).toBe(true);
  });

  it('关闭后拒绝继续使用', () => {
    const s = AppStore.open(mkdtempSync(join(tmpdir(), 'lsci-closed-')));
    s.close();
    expect(() => s.createProject({ name: 'x' })).toThrow(/已关闭/);
  });
});

describe('项目生命周期', () => {
  it('创建项目会同时落地注册表行、目录与项目库', () => {
    const p = store.createProject({ name: '睡眠分期研究', description: 'PSG 数据分析' });

    expect(p.name).toBe('睡眠分期研究');
    expect(p.archivedAt).toBeNull();

    const paths = projectPaths(p.id, root);
    expect(existsSync(paths.db)).toBe(true);
    expect(existsSync(paths.blobs)).toBe(true);
    expect(existsSync(paths.workspace)).toBe(true);

    // 项目库自称的 id 必须与目录名一致
    expect(store.openProject(p.id).declaredProjectId()).toBe(p.id);
  });

  it('项目名两端空白被裁剪，纯空白被拒', () => {
    expect(store.createProject({ name: '  有名字  ' }).name).toBe('有名字');
    expect(() => store.createProject({ name: '   ' })).toThrow(/不能为空/);
  });

  it('默认只列未归档项目', () => {
    const a = store.createProject({ name: 'A' });
    const b = store.createProject({ name: 'B' });
    store.projects.archive(b.id);

    expect(store.projects.list().map((p) => p.id)).toEqual([a.id]);
    expect(store.projects.list({ includeArchived: true })).toHaveLength(2);
    expect(store.projects.count()).toBe(1);
    expect(store.projects.count({ includeArchived: true })).toBe(2);
  });

  it('归档可逆且幂等', () => {
    const p = store.createProject({ name: 'A' });

    const archived = store.projects.archive(p.id);
    expect(archived.archivedAt).not.toBeNull();

    // 再归档一次不该抛错
    const again = store.projects.archive(p.id);
    expect(again.archivedAt).toBe(archived.archivedAt);

    expect(store.projects.unarchive(p.id).archivedAt).toBeNull();
  });

  it('重命名更新名字与时间戳', async () => {
    const p = store.createProject({ name: '旧名' });
    await new Promise((r) => setTimeout(r, 5));
    const renamed = store.projects.rename(p.id, '新名');
    expect(renamed.name).toBe('新名');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(p.updatedAt);
  });

  it('操作不存在的项目抛出明确错误', () => {
    expect(() => store.projects.rename('nope', 'x')).toThrow(/不存在/);
    expect(() => store.projects.archive('nope')).toThrow(/不存在/);
    expect(store.projects.get('nope')).toBeNull();
  });

  it('列表按最近更新排序', async () => {
    const a = store.createProject({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.createProject({ name: 'B' });
    await new Promise((r) => setTimeout(r, 5));
    store.projects.touch(a.id);

    expect(store.projects.list().map((p) => p.name)).toEqual(['A', 'B']);
    expect(b.id).toBeTruthy();
  });

  it('删除项目同时清掉注册表行与目录', () => {
    const p = store.createProject({ name: '待删' });
    const paths = projectPaths(p.id, root);
    // 先打开，验证句柄被关掉后目录才能删（Windows 上文件锁会阻止删除）
    store.openProject(p.id);

    const res = store.deleteProject(p.id);
    expect(res.removedRow).toBe(true);
    expect(res.removedDir).toBe(true);
    expect(existsSync(paths.root)).toBe(false);
    expect(store.projects.get(p.id)).toBeNull();
  });

  it('创建时 id 冲突会回收刚建的库，不留半个项目', () => {
    const p = store.createProject({ name: '第一个', id: 'fixed-id' });
    expect(existsSync(projectPaths(p.id, root).db)).toBe(true);

    // 目录已存在，直接拒绝
    expect(() => store.createProject({ name: '第二个', id: 'fixed-id' })).toThrow(/已存在/);
    // 原项目不受影响
    expect(store.projects.get('fixed-id')?.name).toBe('第一个');
  });

  it('目录被外部删除时能被识别为悬挂项目', () => {
    const p = store.createProject({ name: '会被破坏' });
    store.openProject(p.id).close();
    rmSync(projectPaths(p.id, root).root, { recursive: true, force: true });

    expect(store.danglingProjects()).toEqual([p.id]);
    expect(() => store.openProject(p.id)).toThrow(/不存在/);
  });

  it('同一项目的库句柄被复用', () => {
    const p = store.createProject({ name: 'A' });
    expect(store.openProject(p.id)).toBe(store.openProject(p.id));
  });
});

/* ------------------------------------------------------------------ *
 * 会话与消息
 * ------------------------------------------------------------------ */

describe('会话与消息', () => {
  let project: ProjectStore;

  beforeEach(() => {
    const p = store.createProject({ name: '测试项目' });
    project = store.openProject(p.id);
  });

  it('新建会话状态为 idle', () => {
    const c = project.conversations.create({ title: '第一次对话' });
    expect(c.status).toBe('idle');
    expect(c.title).toBe('第一次对话');
    expect(project.conversations.list()).toHaveLength(1);
  });

  it('状态流转与改标题', () => {
    const c = project.conversations.create();
    project.conversations.setStatus(c.id, 'executing');
    expect(project.conversations.get(c.id)?.status).toBe('executing');

    project.conversations.setTitle(c.id, '改过的标题');
    expect(project.conversations.get(c.id)?.title).toBe('改过的标题');
  });

  it('对不存在的会话改状态抛错', () => {
    expect(() => project.conversations.setStatus('nope', 'idle')).toThrow(/不存在/);
  });

  it('消息 seq 从 1 开始严格递增', () => {
    const c = project.conversations.create();
    const seqs = ['a', 'b', 'c'].map(
      (t) =>
        project.messages.append({ conversationId: c.id, role: 'user', content: { text: t } }).seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
    expect(project.messages.latestSeq(c.id)).toBe(3);
    expect(project.messages.count(c.id)).toBe(3);
  });

  it('不同会话的 seq 各自独立', () => {
    const a = project.conversations.create();
    const b = project.conversations.create();
    project.messages.append({ conversationId: a.id, role: 'user', content: 1 });
    project.messages.append({ conversationId: a.id, role: 'user', content: 2 });
    const first = project.messages.append({ conversationId: b.id, role: 'user', content: 3 });
    expect(first.seq).toBe(1);
  });

  it('向不存在的会话追加消息被拒', () => {
    expect(() =>
      project.messages.append({ conversationId: 'nope', role: 'user', content: 'x' }),
    ).toThrow(/不存在/);
  });

  it('追加消息会推进会话的 updated_at', async () => {
    const c = project.conversations.create();
    const before = project.conversations.get(c.id)?.updatedAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    project.messages.append({ conversationId: c.id, role: 'user', content: 'x' });
    expect(project.conversations.get(c.id)?.updatedAt ?? 0).toBeGreaterThan(before);
  });

  it('保留模型标识与用量', () => {
    const c = project.conversations.create();
    const m = project.messages.append({
      conversationId: c.id,
      role: 'assistant',
      content: { text: '回答' },
      modelId: 'model-x',
      providerId: 'prov-y',
      usage: { tokensIn: 10, tokensOut: 20, cost: 0.001, currency: 'USD' },
    });
    expect(m.modelId).toBe('model-x');
    expect(m.usage?.tokensOut).toBe(20);
  });

  it('分页按 seq 升序返回，游标向更早翻', () => {
    const c = project.conversations.create();
    for (let i = 1; i <= 10; i += 1) {
      project.messages.append({ conversationId: c.id, role: 'user', content: i });
    }

    const last = project.messages.page(c.id, { limit: 4 });
    expect(last.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(last.hasMore).toBe(true);
    expect(last.oldestSeq).toBe(7);

    const prev = project.messages.page(c.id, { beforeSeq: last.oldestSeq ?? 0, limit: 4 });
    expect(prev.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(prev.hasMore).toBe(true);

    const first = project.messages.page(c.id, { beforeSeq: prev.oldestSeq ?? 0, limit: 4 });
    expect(first.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(first.hasMore).toBe(false);
  });

  it('空会话分页返回空结果而不报错', () => {
    const c = project.conversations.create();
    const page = project.messages.page(c.id);
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.oldestSeq).toBeNull();
  });

  it('分页 limit 被夹在合理区间', () => {
    const c = project.conversations.create();
    for (let i = 0; i < 5; i += 1) {
      project.messages.append({ conversationId: c.id, role: 'user', content: i });
    }
    expect(project.messages.page(c.id, { limit: 99999 }).messages).toHaveLength(5);
    expect(project.messages.page(c.id, { limit: 0 }).messages).toHaveLength(1);
  });

  it('删除会话级联清掉消息', () => {
    const c = project.conversations.create();
    project.messages.append({ conversationId: c.id, role: 'user', content: 'x' });
    expect(project.conversations.delete(c.id)).toBe(true);
    expect(project.messages.count(c.id)).toBe(0);
  });

  it('归档会话从默认列表消失', () => {
    const c = project.conversations.create();
    project.conversations.archive(c.id);
    expect(project.conversations.list()).toHaveLength(0);
    expect(project.conversations.list({ includeArchived: true })).toHaveLength(1);
  });

  it('内容为复杂结构时能原样往返', () => {
    const c = project.conversations.create();
    const content = { blocks: [{ type: 'text', text: '含 emoji 与换行\n第二行' }], n: 1.5 };
    const m = project.messages.append({ conversationId: c.id, role: 'assistant', content });
    expect(project.messages.get(m.id)?.content).toEqual(content);
  });
});

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

describe('工具调用', () => {
  let project: ProjectStore;
  let messageId: string;

  beforeEach(() => {
    const p = store.createProject({ name: '测试项目' });
    project = store.openProject(p.id);
    const c = project.conversations.create();
    messageId = project.messages.append({
      conversationId: c.id,
      role: 'assistant',
      content: 'x',
    }).id;
  });

  it('start 后处于 running，finish 后落终态', () => {
    const call = project.toolCalls.start({
      messageId,
      toolName: 'python',
      input: { code: '1+1' },
    });
    expect(call.status).toBe('running');
    expect(call.endedAt).toBeNull();

    const done = project.toolCalls.finish(call.id, { status: 'ok', output: { result: 2 } });
    expect(done.status).toBe('ok');
    expect(done.endedAt).not.toBeNull();
    expect(done.output).toEqual({ result: 2 });
  });

  it('记录非零退出码与错误终态', () => {
    const call = project.toolCalls.start({ messageId, toolName: 'bash', input: { cmd: 'false' } });
    const done = project.toolCalls.finish(call.id, { status: 'error', exitCode: 1 });
    expect(done.exitCode).toBe(1);
    expect(done.status).toBe('error');
  });

  it('拒绝重复收尾', () => {
    const call = project.toolCalls.start({ messageId, toolName: 'python', input: null });
    project.toolCalls.finish(call.id, { status: 'ok' });
    expect(() => project.toolCalls.finish(call.id, { status: 'ok' })).toThrow(/已是终态/);
  });

  it('收尾不存在的调用抛错', () => {
    expect(() => project.toolCalls.finish('nope', { status: 'ok' })).toThrow(/不存在/);
  });

  it('后台标记被保留', () => {
    const call = project.toolCalls.start({
      messageId,
      toolName: 'python',
      input: null,
      background: true,
    });
    expect(call.background).toBe(true);
  });

  it('按消息列出调用', () => {
    project.toolCalls.start({ messageId, toolName: 'python', input: null });
    project.toolCalls.start({ messageId, toolName: 'bash', input: null });
    expect(project.toolCalls.listByMessage(messageId).map((c) => c.toolName)).toEqual([
      'python',
      'bash',
    ]);
  });

  it('遗留的 running 记录可被批量标为 aborted', () => {
    const python = project.toolCalls.start({ messageId, toolName: 'python', input: null });
    const bash = project.toolCalls.start({ messageId, toolName: 'bash', input: null });
    const finished = project.toolCalls.start({ messageId, toolName: 'r', input: null });
    project.toolCalls.finish(finished.id, { status: 'ok' });

    expect(project.toolCalls.listRunning()).toHaveLength(2);
    expect(project.toolCalls.abortStale()).toBe(2);
    expect(project.toolCalls.listRunning()).toHaveLength(0);
    expect(project.toolCalls.get(python.id)?.status).toBe('aborted');
    expect(project.toolCalls.get(bash.id)?.status).toBe('aborted');
    expect(project.toolCalls.get(python.id)?.endedAt).not.toBeNull();
    // 已完成的不受影响
    expect(project.toolCalls.get(finished.id)?.status).toBe('ok');
  });
});

describe('abortStale 调用点', () => {
  it('backend openProject 在本进程首次打开项目时调用 abortStale', () => {
    // Given: abortStale 会无差别把所有 running 标成 aborted，不能每次取库都跑
    const src = readFileSync(join('packages', 'core', 'src', 'backend.ts'), 'utf8');
    const start = src.indexOf('function openProject');
    const end = src.indexOf('async function main');
    const openProject = src.slice(start, end);

    // When / Then: 调用点钉在 per-project 打开函数里，且有「本进程已清理过」的门闩
    expect(start).toBeGreaterThan(-1);
    expect(openProject).toContain('toolCalls.abortStale()');
    expect(openProject).toMatch(/!\w+\.has\(projectId\)/u);
  });
});
