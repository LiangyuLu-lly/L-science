/**
 * 子 agent 委派测试（任务 12.6，需求 10.5、10.6、10.7）。
 *
 * 用假适配器跑真实的子 agent 循环。重点在四件事：
 * 1. 并行执行且各有独立的内核键与工作目录（共用会话内核时并行必然失败）
 * 2. 引导消息在回合之间生效
 * 3. 停止能真的停下来
 * 4. **中断只取消阻塞式的**，非阻塞的不受影响
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterContext, ChatChunk, ChatRequest, ProviderAdapter } from '@l-science/adapters';
import { AdapterRegistry } from '@l-science/adapters';
import type { ModelDescriptor } from '@l-science/shared';

import {
  AppStore,
  SubAgentRunner,
  ToolRegistry,
  extractVersionIds,
  textOutput,
  type ProjectStore,
  type SkillManager,
  type ToolContext,
  type ToolDefinition,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

const model: ModelDescriptor = {
  id: 'fake-model',
  providerId: 'fake',
  displayName: 'Fake',
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  modalities: ['text'],
  strengths: {
    reasoning: 70,
    coding: 70,
    math: 60,
    longContextRecall: 60,
    writingZh: 60,
    writingEn: 60,
    toolUse: 80,
    structuredOutput: 70,
    citationFidelity: 60,
    instructionFollowing: 80,
  },
  pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
  performance: { medianLatencyMs: 100, tokensPerSec: 100 },
  policy: { trainingUse: 'none', retentionDays: 0, zdr: true, region: 'local' },
  local: true,
  features: { streaming: true, toolUse: true, promptCache: false, vision: false, thinking: false },
};

/** 按脚本产出分片的假适配器。脚本按「第几次调用」索引。 */
function scriptedAdapter(
  script: (turn: number, req: ChatRequest) => readonly ChatChunk[],
  opts: { delayMs?: number } = {},
): { adapter: ProviderAdapter; calls: () => number } {
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: 'fake',
    displayName: 'Fake',
    listModels: () => Promise.resolve([model]),
    health: () => Promise.resolve({ ok: true, latencyMs: 1 }),
    chat: (_ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatChunk> => {
      const current = turn;
      turn += 1;
      return (async function* () {
        if (opts.delayMs !== undefined) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
          // 延迟期间被中断时要真的抛出去，否则停止指令等于无效
          if (req.signal?.aborted === true) throw new Error('aborted');
        }
        for (const chunk of script(current, req)) yield chunk;
      })();
    },
  };
  return { adapter, calls: () => turn };
}

const done = (text: string): readonly ChatChunk[] => [
  { kind: 'text', text },
  {
    kind: 'done',
    usage: { tokensIn: 10, tokensOut: 5, cost: 0, currency: 'USD' },
    stopReason: 'end_turn',
  },
];

const callTool = (
  name: string,
  argumentsJson: string,
  id = `c${String(Math.random()).slice(2, 8)}`,
): readonly ChatChunk[] => [
  { kind: 'tool_call', id, name, argumentsJson },
  {
    kind: 'done',
    usage: { tokensIn: 10, tokensOut: 5, cost: 0, currency: 'USD' },
    stopReason: 'tool_use',
  },
];

let root: string;
let store: AppStore;
let project: ProjectStore;
let parentId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-sub-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '子 agent 测试' });
  project = store.openProject(created.id);
  parentId = project.conversations.create({ title: '主会话' }).id;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 记录每次调用的 ToolContext，用来验证内核键与工作目录的隔离。 */
function makeRunner(input: {
  adapter: ProviderAdapter;
  extraTools?: ReadonlyArray<ToolDefinition<never>>;
  maxConcurrent?: number;
  skills?: SkillManager;
}): { runner: SubAgentRunner; contexts: ToolContext[] } {
  const adapters = new AdapterRegistry();
  adapters.register(input.adapter);

  const contexts: ToolContext[] = [];
  const tools = new ToolRegistry({ probe: () => true });

  const echo: ToolDefinition<{ note: string }> = {
    name: 'echo',
    description: '回显',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
    parseInput: (raw) => ({ note: String((raw as { note?: unknown }).note ?? '') }),
    execute: (i, ctx) => {
      contexts.push({ ...ctx });
      return Promise.resolve({ ok: true, output: textOutput(`echo:${i.note}`) });
    },
  };
  tools.register(echo);

  const fakeSave: ToolDefinition<unknown> = {
    name: 'save_artifacts',
    description: '假的保存',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    parseInput: (raw) => raw,
    execute: (_i, ctx) => {
      contexts.push({ ...ctx });
      return Promise.resolve({
        ok: true,
        output: textOutput('已保存 fig.png，版本 av_11111111-2222-3333-4444-555555555555'),
      });
    },
  };
  tools.register(fakeSave);

  for (const tool of input.extraTools ?? []) tools.register(tool as ToolDefinition<unknown>);

  const runner = new SubAgentRunner({
    conversations: project.conversations,
    messages: project.messages,
    toolCalls: project.toolCalls,
    tools,
    adapters,
    routerView: () => ({ models: [model], runtime: new Map() }),
    adapterContext: () => ({ baseUrl: 'http://127.0.0.1' }),
    workspaceDir: (agentId) => join(root, 'ws', agentId),
    projectId: project.projectId,
    ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
  });

  return { runner, contexts };
}

/* ------------------------------------------------------------------ *
 * 基本执行
 * ------------------------------------------------------------------ */

describe('子 agent 基本执行', () => {
  it('没有工具调用即为收尾，返回陈述', async () => {
    const { adapter } = scriptedAdapter(() => done('我做完了，结论是 A。'));
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: '算个数' } });
    const result = await handle.result;

    expect(result.status).toBe('done');
    expect(result.summary).toBe('我做完了，结论是 A。');
    expect(result.turns).toBe(1);
  });

  it('子 agent 有独立的会话行，父会话列表看不到它', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'));
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    await handle.result;

    // 五个并行子任务混进侧栏之后用户找不到主线对话
    expect(project.conversations.list().map((c) => c.id)).toEqual([parentId]);
    const children = project.conversations.children(parentId);
    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe(handle.conversationId);
    expect(children[0]?.parentConversationId).toBe(parentId);
  });

  it('过程落库，可以像普通会话一样翻看', async () => {
    const { adapter } = scriptedAdapter(() => done('结论'));
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: '任务描述' } });
    await handle.result;

    const page = project.messages.page(handle.conversationId, { limit: 20 });
    const texts = page.messages.map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes('任务描述'))).toBe(true);
    expect(texts.some((t) => t.includes('结论'))).toBe(true);
  });

  it('每个子 agent 有独立的内核键与工作目录', async () => {
    const { adapter } = scriptedAdapter((turn) =>
      turn === 0 ? callTool('echo', '{"note":"hi"}') : done('done'),
    );
    const { runner, contexts } = makeRunner({ adapter });

    const a = runner.spawn({ parentConversationId: parentId, spec: { task: 'a' } });
    const b = runner.spawn({ parentConversationId: parentId, spec: { task: 'b' } });
    await Promise.all([a.result, b.result]);

    const keys = contexts.map((c) => c.kernelKey);
    // 共用会话的内核键时，并行的第二个 agent 必然撞上「该内核已有执行在途」
    expect(new Set(keys).size).toBe(contexts.length);
    expect(keys.every((k) => k?.startsWith('sub_') === true)).toBe(true);
    expect(new Set(contexts.map((c) => c.workspaceDir)).size).toBe(contexts.length);
  });

  it('工具调用挂在真实消息上，不违反外键', async () => {
    const { adapter } = scriptedAdapter((turn) =>
      turn === 0 ? callTool('echo', '{"note":"x"}') : done('ok'),
    );
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    const result = await handle.result;
    expect(result.status).toBe('done');

    const page = project.messages.page(handle.conversationId, { limit: 20 });
    const assistant = page.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(project.toolCalls.listByMessage(assistant?.id ?? '')).toHaveLength(1);
  });

  it('达到回合上限时报失败而不是假装完成', async () => {
    const { adapter } = scriptedAdapter(() => callTool('echo', '{"note":"loop"}'));
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({
      parentConversationId: parentId,
      spec: { task: '死循环', maxTurns: 3 },
    });
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('回合上限');
    expect(result.turns).toBe(3);
  });
});

describe('子 agent 技能注入', () => {
  it('依赖未满足时不得写成应遵循的方法学', async () => {
    let system = '';
    const { adapter } = scriptedAdapter((_turn, req) => {
      system = req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      return done('做不到');
    });
    const skills = {
      inject: () => ({
        slug: 'needs',
        name: 'Needs',
        content: '# 技能：Needs（needs）本机不能跑\n不要按本技能的操作步骤执行',
        blocked: true,
        missing: ['nonexistent-pkg'],
        requirements: { satisfied: false, missing: [], probeFailures: [] },
        references: [],
      }),
    } as unknown as SkillManager;
    const { runner } = makeRunner({ adapter, skills });

    await runner.spawn({
      parentConversationId: parentId,
      spec: { task: '跑折叠', skillSlug: 'needs' },
    }).result;

    expect(system).not.toContain('本任务应遵循下面的方法学文档');
    expect(system).toContain('本机不能跑');
    expect(system).toContain('nonexistent-pkg');
  });
});

/* ------------------------------------------------------------------ *
 * 产物交接（需求 10.6）
 * ------------------------------------------------------------------ */

describe('产物交接（需求 10.6）', () => {
  it('从 save_artifacts 的输出里收集版本 id', async () => {
    const { adapter } = scriptedAdapter((turn) =>
      turn === 0 ? callTool('save_artifacts', '{"paths":["fig.png"]}') : done('存好了'),
    );
    const { runner } = makeRunner({ adapter });

    const result = await runner.spawn({ parentConversationId: parentId, spec: { task: '出图' } })
      .result;

    // 协调方拿到的是版本 id，不是内存里的对象
    expect(result.producedVersionIds).toEqual(['av_11111111-2222-3333-4444-555555555555']);
  });

  it('输入制品以 {{artifact:id}} 形式写进任务消息', async () => {
    let seenPrompt = '';
    const { adapter } = scriptedAdapter((_turn, req) => {
      seenPrompt = req.messages.map((m) => m.content).join('\n');
      return done('ok');
    });
    const { runner } = makeRunner({ adapter });

    await runner.spawn({
      parentConversationId: parentId,
      spec: { task: '分析', inputVersionIds: ['av_abc'], produces: ['result.csv'] },
    }).result;

    // 标记会解析成项目级 blob 路径，因此跨 agent 传数据不需要共享目录
    expect(seenPrompt).toContain('{{artifact:av_abc}}');
    expect(seenPrompt).toContain('result.csv');
  });

  it('系统提示明确说它看不到父会话历史', async () => {
    let system = '';
    const { adapter } = scriptedAdapter((_turn, req) => {
      system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      return done('ok');
    });
    const { runner } = makeRunner({ adapter });
    await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } }).result;

    expect(system).toContain('看不到父会话的历史');
    expect(system).toContain('save_artifacts');
  });

  it('extractVersionIds 只抓形如 av_<uuid> 的 id', () => {
    expect(extractVersionIds('存了 av_11111111-2222-3333-4444-555555555555 和 af_xxx')).toEqual([
      'av_11111111-2222-3333-4444-555555555555',
    ]);
    expect(extractVersionIds('没有 id')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 引导与停止（需求 10.5）
 * ------------------------------------------------------------------ */

describe('引导与停止（需求 10.5）', () => {
  it('引导消息在下一个回合开始前注入', async () => {
    const prompts: string[] = [];
    // 加延迟让第一个回合还在跑的时候有机会发引导——不加延迟两个回合会在
    // 测试拿到句柄之前就跑完，测的就不是「运行中发引导」了
    const { adapter } = scriptedAdapter(
      (turn, req) => {
        prompts.push(req.messages.map((m) => m.content).join('\n---\n'));
        return turn === 0 ? callTool('echo', '{"note":"first"}') : done('收到了');
      },
      { delayMs: 120 },
    );
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    // 第一个回合已经在跑，引导会在第二个回合前生效
    await new Promise((r) => setTimeout(r, 30));
    expect(handle.guide('注意要用中位数')).toBe(true);

    await handle.result;

    expect(prompts[0]).not.toContain('注意要用中位数');
    // 流式调用一旦开始就无法插话，因此它出现在第二个回合
    expect(prompts[1]).toContain('注意要用中位数');
  });

  it('引导消息也落库', async () => {
    const { adapter } = scriptedAdapter(
      (turn) => (turn === 0 ? callTool('echo', '{"note":"x"}') : done('ok')),
      { delayMs: 120 },
    );
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    await new Promise((r) => setTimeout(r, 30));
    handle.guide('补充说明');
    await handle.result;

    const page = project.messages.page(handle.conversationId, { limit: 20 });
    expect(page.messages.some((m) => JSON.stringify(m.content).includes('补充说明'))).toBe(true);
  });

  it('停止运行中的子 agent', async () => {
    const { adapter } = scriptedAdapter(
      (turn) => (turn === 0 ? callTool('echo', '{"note":"x"}') : done('ok')),
      { delayMs: 200 },
    );
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(handle.stop('走错方向了')).toBe(true);

    const result = await handle.result;
    expect(result.status).toBe('stopped');
    expect(result.detail).toBe('走错方向了');
  });

  it('对已结束的子 agent 引导或停止返回 false 而不抛错', async () => {
    /*
     * 这条曾经是个真问题：清理发生在 promise 链的 finally 里，而调用方
     * `await result` 之后的续段可能先于它执行。那个窗口里 guide() 返回 true，
     * 消息进了一个再也不会被读的信箱——调用方以为发出去了。
     * 现在靠一个在 resolve 之前置上的 finished 标记来判断。
     */
    const { adapter } = scriptedAdapter(() => done('ok'));
    const { runner } = makeRunner({ adapter });

    const handle = runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } });
    await handle.result;

    // 紧接着就查，不给 finally 执行的机会
    expect(handle.guide('晚了')).toBe(false);
    expect(handle.stop('晚了')).toBe(false);
    expect(runner.get(handle.agentId)).toBeNull();
    expect(runner.list(parentId)).toHaveLength(0);
  });

  it('list 只列出本父会话在跑的子 agent', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 150 });
    const { runner } = makeRunner({ adapter });

    const other = project.conversations.create({ title: '另一个主会话' }).id;
    const a = runner.spawn({ parentConversationId: parentId, spec: { task: 'a' } });
    const b = runner.spawn({ parentConversationId: other, spec: { task: 'b' } });

    await new Promise((r) => setTimeout(r, 30));
    expect(runner.list(parentId).map((h) => h.agentId)).toEqual([a.agentId]);
    expect(runner.list().length).toBe(2);

    await Promise.all([a.result, b.result]);
  });
});

/* ------------------------------------------------------------------ *
 * 中断语义（需求 10.7）
 * ------------------------------------------------------------------ */

describe('中断语义（需求 10.7）', () => {
  it('cancelBlocking 只取消阻塞式的，非阻塞的继续跑', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 250 });
    const { runner } = makeRunner({ adapter });

    const blocking = runner.spawn({
      parentConversationId: parentId,
      spec: { task: '阻塞', blocking: true },
    });
    const background = runner.spawn({
      parentConversationId: parentId,
      spec: { task: '后台', blocking: false },
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(runner.cancelBlocking(parentId, '用户中断')).toBe(1);

    const [b1, b2] = await Promise.all([blocking.result, background.result]);
    expect(b1.status).toBe('stopped');
    // 非阻塞的是用户显式转后台的，一次中断不该把两小时的作业杀掉
    expect(b2.status).toBe('done');
  });

  it('cancelBlocking 不影响别的父会话', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 200 });
    const { runner } = makeRunner({ adapter });

    const other = project.conversations.create({ title: '另一个' }).id;
    const mine = runner.spawn({ parentConversationId: parentId, spec: { task: 'a' } });
    const theirs = runner.spawn({ parentConversationId: other, spec: { task: 'b' } });

    await new Promise((r) => setTimeout(r, 30));
    runner.cancelBlocking(parentId, '中断');

    expect((await mine.result).status).toBe('stopped');
    expect((await theirs.result).status).toBe('done');
  });

  it('stopAll 连非阻塞的一起停', async () => {
    // 进程要退了，留着非阻塞的只会变成孤儿
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 250 });
    const { runner } = makeRunner({ adapter });

    const a = runner.spawn({ parentConversationId: parentId, spec: { task: 'a' } });
    const b = runner.spawn({
      parentConversationId: parentId,
      spec: { task: 'b', blocking: false },
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(runner.stopAll('后端关闭')).toBe(2);

    expect((await a.result).status).toBe('stopped');
    expect((await b.result).status).toBe('stopped');
  });
});

/* ------------------------------------------------------------------ *
 * 并发
 * ------------------------------------------------------------------ */

describe('并发', () => {
  it('并行执行而不是排队', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 120 });
    const { runner } = makeRunner({ adapter });

    const started = Date.now();
    await Promise.all(
      [1, 2, 3].map(
        (i) =>
          runner.spawn({ parentConversationId: parentId, spec: { task: `t${String(i)}` } }).result,
      ),
    );
    // 串行是 360ms 起，并行应显著更快
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('超过并发上限时排队而不是拒绝', async () => {
    // 拒绝会让计划里的并行步骤直接失败
    const { adapter } = scriptedAdapter(() => done('ok'), { delayMs: 80 });
    const { runner } = makeRunner({ adapter, maxConcurrent: 2 });

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(
        (i) =>
          runner.spawn({ parentConversationId: parentId, spec: { task: `t${String(i)}` } }).result,
      ),
    );
    expect(results.every((r) => r.status === 'done')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 失败处理
 * ------------------------------------------------------------------ */

describe('失败处理', () => {
  it('模型调用抛错时报 failed 并带原因', async () => {
    const adapters = new AdapterRegistry();
    adapters.register({
      id: 'fake',
      displayName: 'Fake',
      listModels: () => Promise.resolve([model]),
      health: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      chat: () =>
        (async function* (): AsyncIterable<ChatChunk> {
          await Promise.resolve();
          throw new Error('供应商 500');
        })(),
    });

    const runner = new SubAgentRunner({
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools: new ToolRegistry({ probe: () => true }),
      adapters,
      routerView: () => ({ models: [model], runtime: new Map() }),
      adapterContext: () => ({ baseUrl: 'http://127.0.0.1' }),
      workspaceDir: (id) => join(root, 'ws', id),
    });

    const result = await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } })
      .result;
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('供应商 500');
  });

  it('没有可用模型时报 failed 并给出可执行报告', async () => {
    const adapters = new AdapterRegistry();
    adapters.register({
      id: 'fake',
      displayName: 'Fake',
      listModels: () => Promise.resolve([]),
      health: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      chat: () => (async function* (): AsyncIterable<ChatChunk> {})(),
    });

    const runner = new SubAgentRunner({
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools: new ToolRegistry({ probe: () => true }),
      adapters,
      routerView: () => ({ models: [], runtime: new Map() }),
      adapterContext: () => ({ baseUrl: 'http://127.0.0.1' }),
      workspaceDir: (id) => join(root, 'ws', id),
    });

    const result = await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } })
      .result;
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/模型/);
  });

  it('工具执行失败被如实回灌，子 agent 仍能继续', async () => {
    const failing: ToolDefinition<unknown> = {
      name: 'boom',
      description: '总是失败',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      parseInput: (raw) => raw,
      execute: () => Promise.reject(new Error('炸了')),
    };

    const seen: string[] = [];
    const { adapter } = scriptedAdapter((turn, req) => {
      seen.push(req.messages.map((m) => m.content).join('|'));
      return turn === 0 ? callTool('boom', '{}') : done('我知道它失败了');
    });
    const { runner } = makeRunner({
      adapter,
      extraTools: [failing as unknown as ToolDefinition<never>],
    });

    const result = await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } })
      .result;
    expect(result.status).toBe('done');
    expect(seen[1]).toContain('炸了');
  });

  it('声称完成但没有任何产物时不假装成功', async () => {
    // 这一条由 delegate 工具的描述文本承担；这里验 runner 如实报告空产物
    const { adapter } = scriptedAdapter(() => done('搞定了'));
    const { runner } = makeRunner({ adapter });
    const result = await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } })
      .result;
    expect(result.status).toBe('done');
    expect(result.producedVersionIds).toEqual([]);
  });
});

describe('用量记录', () => {
  it('子 agent 的调用也进用量统计', async () => {
    const { adapter } = scriptedAdapter(() => done('ok'));
    const adapters = new AdapterRegistry();
    adapters.register(adapter);

    const { UsageRepo } = await import('@l-science/core');
    const usage = new UsageRepo(project.db);

    const runner = new SubAgentRunner({
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools: new ToolRegistry({ probe: () => true }),
      adapters,
      usage,
      routerView: () => ({ models: [model], runtime: new Map() }),
      adapterContext: () => ({ baseUrl: 'http://127.0.0.1' }),
      workspaceDir: (id) => join(root, 'ws', id),
    });

    await runner.spawn({ parentConversationId: parentId, spec: { task: 'x' } }).result;

    // 不记的话「这个项目花了多少钱」会漏掉子 agent 那部分，而并行委派恰恰是花钱最多的场景
    expect(usage.byProject({}).calls).toBe(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
