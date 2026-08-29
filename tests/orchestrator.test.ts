/**
 * 会话编排测试（任务 8.5）。
 *
 * 重点在几处会让平台不可用或烧钱的行为：
 * - 回合上限必须存在，撞上时如实报告而不是伪装成正常结束
 * - 中断保留已产出的内容
 * - 无论怎么结束都回到 idle，否则会话永久卡死
 * - 内容安全拒答不换模型绕过
 *
 * 全部离线：假适配器 + 假工具。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelDescriptor, TurnEvent } from '@l-science/shared';
import type { ChatChunk, ProviderAdapter } from '@l-science/adapters';
import { AdapterRegistry } from '@l-science/adapters';
import {
  AppStore,
  ConversationBusyError,
  IllegalTransitionError,
  Orchestrator,
  ToolRegistry,
  canTransition,
  inferTaskType,
  toolOutputForModel,
  type Conversation,
  type OrchestratorDeps,
  type ProjectStore,
  type ToolDefinition,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let conversation: Conversation;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-orch-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '编排测试' });
  project = store.openProject(created.id);
  conversation = project.conversations.create({ title: '测试会话' });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 测试替身
 * ------------------------------------------------------------------ */

function testModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'fake-model',
    providerId: 'fake',
    displayName: 'Fake',
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    modalities: ['text'],
    strengths: {
      reasoning: 70,
      coding: 70,
      math: 70,
      longContextRecall: 70,
      writingZh: 70,
      writingEn: 70,
      toolUse: 70,
      structuredOutput: 70,
      citationFidelity: 70,
      instructionFollowing: 70,
    },
    pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
    performance: { medianLatencyMs: 100, tokensPerSec: 100 },
    policy: { trainingUse: 'none', retentionDays: 0, zdr: true, region: 'test' },
    local: true,
    features: {
      streaming: true,
      toolUse: true,
      promptCache: false,
      vision: false,
      thinking: false,
    },
    ...overrides,
  };
}

/**
 * 假适配器。`script` 是每一轮要产出的分片序列，按调用次序取用。
 * 用完后退回一个不带工具调用的普通回复，让循环自然收敛。
 */
function fakeAdapter(script: ReadonlyArray<readonly ChatChunk[]>, id = 'fake'): ProviderAdapter {
  let call = 0;
  return {
    id,
    displayName: id,
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1 }),
    chat: (_ctx, _req) => {
      const chunks =
        script[call] ??
        ([
          { kind: 'text', text: '完成。' },
          {
            kind: 'done',
            usage: { tokensIn: 1, tokensOut: 1, cost: 0, currency: 'USD' },
            stopReason: 'end_turn',
          },
        ] as const);
      call += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const done = (stopReason: ChatChunk extends { kind: 'done'; stopReason: infer S } ? S : never) =>
  ({
    kind: 'done',
    usage: { tokensIn: 10, tokensOut: 5, cost: 0.001, currency: 'USD' },
    stopReason,
  }) as const;

function echoTool(name = 'echo'): ToolDefinition<{ value: string }> {
  return {
    name,
    description: '回显',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    parseInput: (raw) => {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.value !== 'string') throw new Error('value 必须是字符串');
      return { value: obj.value };
    },
    execute: async (input) => ({ ok: true, output: { kind: 'text', text: `echo:${input.value}` } }),
  };
}

interface BuildOptions {
  script?: ReadonlyArray<readonly ChatChunk[]>;
  tools?: ReadonlyArray<ToolDefinition<never>>;
  models?: readonly ModelDescriptor[];
  maxTurns?: number;
  adapters?: ReadonlyArray<{ adapter: ProviderAdapter; providerId: string }>;
  explicitSkills?: OrchestratorDeps['explicitSkills'];
}

function build(options: BuildOptions = {}): Orchestrator {
  const registry = new ToolRegistry({ probe: () => true });
  for (const tool of options.tools ?? [echoTool() as unknown as ToolDefinition<never>]) {
    registry.register(tool);
  }

  const adapters = new AdapterRegistry();
  if (options.adapters === undefined) {
    adapters.register(fakeAdapter(options.script ?? []));
  } else {
    for (const entry of options.adapters) adapters.register(entry.adapter);
  }

  return new Orchestrator({
    conversations: project.conversations,
    messages: project.messages,
    toolCalls: project.toolCalls,
    tools: registry,
    adapters,
    routerView: () => ({
      models: options.models ?? [testModel()],
      runtime: new Map(),
    }),
    adapterContext: (providerId) => ({ baseUrl: `http://${providerId}`, apiKey: 'k' }),
    workspaceDir: () => root,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.explicitSkills === undefined ? {} : { explicitSkills: options.explicitSkills }),
  });
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

describe('状态机（任务 8.5.1）', () => {
  it('允许的迁移', () => {
    expect(canTransition('idle', 'executing')).toBe(true);
    expect(canTransition('executing', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'executing')).toBe(true);
    expect(canTransition('executing', 'idle')).toBe(true);
  });

  it('不允许的迁移', () => {
    // 状态机的价值全在「哪些迁移不允许」上
    expect(canTransition('idle', 'awaiting_approval')).toBe(false);
    expect(canTransition('idle', 'reviewing')).toBe(false);
    expect(canTransition('awaiting_approval', 'awaiting_user_input')).toBe(false);
  });

  it('同态到同态是幂等的', () => {
    // 报错只会让调用方到处写「先判断当前是不是已经是目标态」
    expect(canTransition('executing', 'executing')).toBe(true);
  });

  it('非法迁移的错误消息列出允许的目标', () => {
    const err = new IllegalTransitionError('idle', 'reviewing');
    expect(err.message).toContain('planning');
    expect(err.message).toContain('executing');
  });
});

describe('并发控制', () => {
  it('会话正忙时拒绝新回合', async () => {
    const orch = build({
      script: [[{ kind: 'text', text: 'a' }, done('end_turn')]],
    });

    const first = orch.startTurn(conversation.id, '第一条');
    // 尚未消费迭代器，回合已登记为活跃
    expect(() => orch.startTurn(conversation.id, '第二条')).toThrow(ConversationBusyError);
    await collect(first);
  });

  it('忙时的错误消息指出该怎么办', () => {
    const orch = build();
    const first = orch.startTurn(conversation.id, 'x');
    try {
      orch.startTurn(conversation.id, 'y');
    } catch (err) {
      expect((err as Error).message).toContain('先中断');
    }
    void collect(first);
  });

  it('回合结束后可以再开', async () => {
    const orch = build();
    await collect(orch.startTurn(conversation.id, '第一条'));
    expect(orch.isActive(conversation.id)).toBe(false);
    await expect(collect(orch.startTurn(conversation.id, '第二条'))).resolves.toBeDefined();
  });

  it('不存在的会话报错', () => {
    const orch = build();
    expect(() => orch.startTurn('conv_nope', 'x')).toThrow(/会话不存在/);
  });
});

/* ------------------------------------------------------------------ *
 * agent 循环
 * ------------------------------------------------------------------ */

describe('agent 循环（任务 8.5.2）', () => {
  it('无工具调用时一轮结束', async () => {
    const events = await collect(
      build({
        script: [[{ kind: 'text', text: '答案是 42。' }, done('end_turn')]],
      }).startTurn(conversation.id, '算一下'),
    );

    expect(events.filter((e) => e.kind === 'text.delta')).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe('turn.end');
    expect(events.some((e) => e.kind === 'tool.start')).toBe(false);
  });

  it('工具调用后把结果回灌并继续', async () => {
    const events = await collect(
      build({
        script: [
          [
            { kind: 'text', text: '我来查一下。' },
            { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"hi"}' },
            done('tool_use'),
          ],
          [{ kind: 'text', text: '查到了：hi' }, done('end_turn')],
        ],
      }).startTurn(conversation.id, '查一下'),
    );

    const start = events.find((e) => e.kind === 'tool.start');
    expect(start).toMatchObject({ tool: 'echo', callId: 'c1' });

    const output = events.find((e) => e.kind === 'tool.output');
    expect(output).toMatchObject({ output: { kind: 'text', text: 'echo:hi' } });

    // 第二轮的文本说明结果确实回灌了
    expect(
      events.filter((e) => e.kind === 'text.delta').map((e) => (e as { text: string }).text),
    ).toContain('查到了：hi');
  });

  it('多轮工具调用收敛', async () => {
    const toolChunk = (n: number) =>
      [
        {
          kind: 'tool_call' as const,
          id: `c${String(n)}`,
          name: 'echo',
          argumentsJson: `{"value":"${String(n)}"}`,
        },
        done('tool_use'),
      ] as const;

    const events = await collect(
      build({
        script: [
          toolChunk(1),
          toolChunk(2),
          toolChunk(3),
          [{ kind: 'text', text: '好了' }, done('end_turn')],
        ],
      }).startTurn(conversation.id, '做三步'),
    );

    expect(events.filter((e) => e.kind === 'tool.start')).toHaveLength(3);
    expect(events.at(-1)?.kind).toBe('turn.end');
  });

  it('撞回合上限时如实报告任务未完成', async () => {
    // 伪装成正常结束会让用户以为 agent 认为做完了，而实际上它还在中途
    const loop = [
      { kind: 'tool_call' as const, id: 'c', name: 'echo', argumentsJson: '{"value":"x"}' },
      done('tool_use'),
    ] as const;

    await collect(
      build({ script: [loop, loop, loop, loop, loop], maxTurns: 3 }).startTurn(
        conversation.id,
        '无限循环',
      ),
    );

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const summary = messages.find((m) => (m.content as { kind?: string }).kind === 'turn-summary');
    expect(summary).toBeDefined();
    const content = summary?.content as { stopReason: string; detail: string };
    expect(content.stopReason).toBe('max-turns');
    expect(content.detail).toContain('没有完成');
  });

  it('回合上限内正常结束不写摘要消息', async () => {
    // 助手消息本身就是结果，再加一条摘要是噪声
    await collect(build().startTurn(conversation.id, '简单问题'));
    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    expect(messages.some((m) => (m.content as { kind?: string }).kind === 'turn-summary')).toBe(
      false,
    );
  });

  it('工具参数不是合法 JSON 时回灌可执行的错误', async () => {
    const events = await collect(
      build({
        script: [
          [
            { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":' },
            done('tool_use'),
          ],
          [{ kind: 'text', text: '重试后好了' }, done('end_turn')],
        ],
      }).startTurn(conversation.id, 'x'),
    );

    const output = events.find((e) => e.kind === 'tool.output');
    expect(output).toMatchObject({ output: { ename: 'InvalidToolArguments' } });
    // 要让模型知道是它的参数格式问题而不是工具坏了
    expect((output as { output: { evalue: string } }).output.evalue).toContain('合法的 JSON');
  });

  it('入参校验失败与工具不可用给不同的回灌文本', async () => {
    const badArgs = await collect(
      build({
        script: [
          [
            { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":123}' },
            done('tool_use'),
          ],
        ],
      }).startTurn(conversation.id, 'x'),
    );
    const argOut = badArgs.find((e) => e.kind === 'tool.output');
    expect((argOut as { output: { evalue: string } }).output.evalue).toContain('JSON Schema');

    conversation = project.conversations.create({ title: '第二个会话' });
    const missing = await collect(
      build({
        script: [
          [
            { kind: 'tool_call', id: 'c2', name: 'nonexistent', argumentsJson: '{}' },
            done('tool_use'),
          ],
        ],
      }).startTurn(conversation.id, 'x'),
    );
    const missOut = missing.find((e) => e.kind === 'tool.output');
    expect((missOut as { output: { ename: string } }).output.ename).toBe('ToolUnavailable');
  });

  it('工具调用被记录到数据库', async () => {
    await collect(
      build({
        script: [
          [
            { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"hi"}' },
            done('tool_use'),
          ],
          [{ kind: 'text', text: '好' }, done('end_turn')],
        ],
      }).startTurn(conversation.id, 'x'),
    );

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const calls = project.toolCalls.listByMessage(
      messages.find((m) => m.role === 'user')?.id ?? '',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'echo', status: 'ok' });
  });
});

/* ------------------------------------------------------------------ *
 * 中断
 * ------------------------------------------------------------------ */

describe('中断（需求 3.10）', () => {
  it('中断后状态回到 idle', async () => {
    const orch = build({
      script: [
        [
          { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"x"}' },
          done('tool_use'),
        ],
      ],
    });

    const events = orch.startTurn(conversation.id, 'x');
    const collected: TurnEvent[] = [];
    for await (const event of events) {
      collected.push(event);
      if (event.kind === 'tool.output') await orch.interrupt(conversation.id);
    }

    // 不回 idle 的话会话永久卡在 executing，用户再也发不出消息
    expect(project.conversations.get(conversation.id)?.status).toBe('idle');
    expect(orch.isActive(conversation.id)).toBe(false);
  });

  it('中断保留已产出的内容', async () => {
    // 用户中断是因为不想等了，不是要撤销。丢掉已跑出的结果是在惩罚他行使中断权
    const orch = build({
      script: [
        [
          { kind: 'text', text: '已经算出了一部分结果' },
          { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"x"}' },
          done('tool_use'),
        ],
      ],
    });

    for await (const event of orch.startTurn(conversation.id, 'x')) {
      if (event.kind === 'tool.output') await orch.interrupt(conversation.id);
    }

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const assistant = messages.find((m) => m.role === 'assistant');
    expect((assistant?.content as { text: string }).text).toContain('已经算出了一部分结果');
  });

  it('中断被记录为 interrupted 而不是正常结束', async () => {
    const orch = build({
      script: [
        [
          { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"x"}' },
          done('tool_use'),
        ],
      ],
    });

    for await (const event of orch.startTurn(conversation.id, 'x')) {
      if (event.kind === 'tool.output') await orch.interrupt(conversation.id);
    }

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const summary = messages.find((m) => (m.content as { kind?: string }).kind === 'turn-summary');
    expect((summary?.content as { stopReason: string }).stopReason).toBe('interrupted');
  });

  it('中断不活跃的会话返回 false', async () => {
    expect(await build().interrupt(conversation.id)).toBe(false);
  });

  it('出错时同样回到 idle', async () => {
    const broken: ProviderAdapter = {
      id: 'fake',
      displayName: 'fake',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        throw Object.assign(new Error('供应商炸了'), { retryable: false });
      },
    };

    const orch = build({ adapters: [{ adapter: broken, providerId: 'fake' }] });
    await collect(orch.startTurn(conversation.id, 'x'));
    expect(project.conversations.get(conversation.id)?.status).toBe('idle');
  });
});

/* ------------------------------------------------------------------ *
 * 路由与降级
 * ------------------------------------------------------------------ */

describe('路由与降级', () => {
  it('推出路由决策事件', async () => {
    // 用户需要能看到为什么选了这个模型
    const events = await collect(build().startTurn(conversation.id, 'x'));
    const decision = events.find((e) => e.kind === 'routing.decision');
    expect(decision).toBeDefined();
    expect((decision as { decision: { chosenModelId: string } }).decision.chosenModelId).toBe(
      'fake-model',
    );
  });

  it('没有可用模型时报告缺什么', async () => {
    const orch = build({ models: [] });
    await collect(orch.startTurn(conversation.id, 'x'));

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const summary = messages.find((m) => (m.content as { kind?: string }).kind === 'turn-summary');
    const content = summary?.content as { stopReason: string; detail: string };
    expect(content.stopReason).toBe('no-model');
    expect(content.detail).toContain('注册表为空');
  });

  it('可重试的失败降级到下一个模型', async () => {
    const failing: ProviderAdapter = {
      id: 'flaky',
      displayName: 'flaky',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        throw Object.assign(new Error('限流'), { retryable: true });
      },
    };

    const orch = build({
      adapters: [
        { adapter: failing, providerId: 'flaky' },
        {
          adapter: fakeAdapter(
            [[{ kind: 'text', text: '备用模型答的' }, done('end_turn')]],
            'backup',
          ),
          providerId: 'backup',
        },
      ],
      models: [
        testModel({
          id: 'flaky-model',
          providerId: 'flaky',
          strengths: { ...testModel().strengths, reasoning: 90 },
        }),
        testModel({ id: 'backup-model', providerId: 'backup' }),
      ],
    });

    const events = await collect(orch.startTurn(conversation.id, 'x'));
    expect(
      events.filter((e) => e.kind === 'text.delta').map((e) => (e as { text: string }).text),
    ).toContain('备用模型答的');
  });

  it('内容安全拒答不换模型绕过（需求 7.8）', async () => {
    let backupCalled = false;
    const filtered: ProviderAdapter = {
      id: 'strict',
      displayName: 'strict',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        throw Object.assign(new Error('blocked'), { retryable: true, isContentFilter: true });
      },
    };
    const backup: ProviderAdapter = {
      id: 'backup',
      displayName: 'backup',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        backupCalled = true;
        return (async function* () {
          yield { kind: 'text', text: '绕过了' } as ChatChunk;
          yield done('end_turn') as ChatChunk;
        })();
      },
    };

    const orch = build({
      adapters: [
        { adapter: filtered, providerId: 'strict' },
        { adapter: backup, providerId: 'backup' },
      ],
      models: [
        testModel({
          id: 'strict-model',
          providerId: 'strict',
          strengths: { ...testModel().strengths, reasoning: 95 },
        }),
        testModel({ id: 'backup-model', providerId: 'backup' }),
      ],
    });

    await collect(orch.startTurn(conversation.id, 'x'));
    // 安全边界不是故障，换模型绕过等于把安全判断当故障处理
    expect(backupCalled).toBe(false);

    const messages = project.messages.page(conversation.id, { limit: 50 }).messages;
    const summary = messages.find((m) => (m.content as { kind?: string }).kind === 'turn-summary');
    expect((summary?.content as { stopReason: string }).stopReason).toBe('content-filter');
  });

  it('不可重试的失败不降级', async () => {
    let backupCalled = false;
    const bad: ProviderAdapter = {
      id: 'bad',
      displayName: 'bad',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        throw Object.assign(new Error('凭据无效'), { retryable: false });
      },
    };
    const backup: ProviderAdapter = {
      id: 'backup',
      displayName: 'backup',
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 1 }),
      chat: () => {
        backupCalled = true;
        return (async function* () {
          yield done('end_turn') as ChatChunk;
        })();
      },
    };

    const orch = build({
      adapters: [
        { adapter: bad, providerId: 'bad' },
        { adapter: backup, providerId: 'backup' },
      ],
      models: [
        testModel({
          id: 'bad-model',
          providerId: 'bad',
          strengths: { ...testModel().strengths, reasoning: 95 },
        }),
        testModel({ id: 'backup-model', providerId: 'backup' }),
      ],
    });

    await collect(orch.startTurn(conversation.id, 'x'));
    // 换模型也一样错，重试只是把一个错误放大成一串
    expect(backupCalled).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 显式技能注入（任务 12.16，需求 9.5）
 *
 * 这一组守的是「显式」这两个字。用户在输入框里点了一个技能，它就必须真的进上下文——
 * 靠模型自己去 search_skills 加载是不保证的，而那种失败在界面上看不出来。
 * ------------------------------------------------------------------ */

describe('显式技能注入（任务 12.16）', () => {
  interface SeenMessage {
    role: string;
    content: string;
  }

  /** 记录每次模型调用收到的历史，用于断言技能内容真的进去了。 */
  function captureAdapter(): { adapter: ProviderAdapter; seen: SeenMessage[][] } {
    const seen: SeenMessage[][] = [];
    const base = fakeAdapter([[{ kind: 'text', text: '好' }, done('end_turn')]]);
    return {
      seen,
      adapter: {
        ...base,
        chat: (ctx: unknown, req: { messages?: unknown; history?: unknown }) => {
          // 适配器收到的请求里消息字段名以实际实现为准，两种都取一下
          const list = (req.messages ?? req.history ?? []) as ReadonlyArray<{
            role: string;
            content: unknown;
          }>;
          seen.push(
            list.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
          );
          return (base as unknown as { chat: (c: unknown, r: unknown) => unknown }).chat(ctx, req);
        },
      } as unknown as ProviderAdapter,
    };
  }

  it('指定的技能内容进入本回合历史，且排在用户消息之前', async () => {
    const { adapter, seen } = captureAdapter();
    const orch = build({
      adapters: [{ adapter, providerId: 'fake' }],
      explicitSkills: ({ slugs }) => ({
        injections: slugs.map((slug) => ({
          slug,
          name: `技能 ${slug}`,
          content: `# 技能 ${slug}\n\n按这个方法做。`,
        })),
        missing: [],
      }),
    });

    await collect(orch.startTurn(conversation.id, '帮我分期', {}, ['sleep-staging']));

    const history = seen[0] ?? [];
    const injected = history.findIndex((m) => m.content.includes('技能 sleep-staging'));
    const user = history.findIndex((m) => m.content === '帮我分期');
    expect(injected).toBeGreaterThanOrEqual(0);
    // 先给方法再给任务：反过来模型已经开始规划，再读到一份可能冲突的方法学
    expect(injected).toBeLessThan(user);
  });

  it('注入内容明说以技能为准，冲突时要讲出来', async () => {
    const { adapter, seen } = captureAdapter();
    const orch = build({
      adapters: [{ adapter, providerId: 'fake' }],
      explicitSkills: () => ({
        injections: [{ slug: 's', name: 'S', content: '正文' }],
        missing: [],
      }),
    });
    await collect(orch.startTurn(conversation.id, 'x', {}, ['s']));

    const injected = (seen[0] ?? []).find((m) => m.content.includes('正文'));
    expect(injected?.role).toBe('system');
    expect(injected?.content).toContain('以它为准');
  });

  it('找不到的技能如实告知模型，不静默忽略', async () => {
    const { adapter, seen } = captureAdapter();
    const orch = build({
      adapters: [{ adapter, providerId: 'fake' }],
      explicitSkills: ({ slugs }) => ({ injections: [], missing: [...slugs] }),
    });

    await collect(orch.startTurn(conversation.id, 'x', {}, ['no-such-skill']));

    const notice = (seen[0] ?? []).find((m) => m.content.includes('no-such-skill'));
    /*
     * 静默过滤掉的后果：用户点了技能、界面上它就在那儿，而模型根本不知道，
     * 于是他会以为方法已经生效并据此判断结果对不对。
     */
    expect(notice).toBeDefined();
    expect(notice?.content).toContain('不要假装');
  });

  it('没传技能时不产生任何额外消息', async () => {
    const { adapter, seen } = captureAdapter();
    let called = false;
    const orch = build({
      adapters: [{ adapter, providerId: 'fake' }],
      explicitSkills: () => {
        called = true;
        return { injections: [], missing: [] };
      },
    });

    await collect(orch.startTurn(conversation.id, 'x'));

    // 不该为了「什么都没选」而去查一遍技能库
    expect(called).toBe(false);
    expect((seen[0] ?? []).filter((m) => m.role === 'system')).toHaveLength(0);
  });

  it('没有提供 explicitSkills 时传了 slug 也不崩', async () => {
    // 单元测试与旧调用方不一定接这个回调，缺它必须是安全降级
    const orch = build();
    await expect(
      collect(orch.startTurn(conversation.id, 'x', {}, ['whatever'])),
    ).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * 持久化与辅助
 * ------------------------------------------------------------------ */

describe('消息持久化（任务 8.5.3）', () => {
  it('用户消息先落库', async () => {
    // 中断或崩溃之后，用户至少能看到自己说过什么
    const orch = build();
    const events = orch.startTurn(conversation.id, '我的问题');
    const messages = project.messages.page(conversation.id, { limit: 10 }).messages;
    expect(messages.find((m) => m.role === 'user')).toMatchObject({
      content: { kind: 'text', text: '我的问题' },
    });
    await collect(events);
  });

  it('助手消息带上模型与用量', async () => {
    await collect(
      build({
        script: [[{ kind: 'text', text: '答' }, done('end_turn')]],
      }).startTurn(conversation.id, 'x'),
    );

    const assistant = project.messages
      .page(conversation.id, { limit: 10 })
      .messages.find((m) => m.role === 'assistant');
    expect(assistant?.modelId).toBe('fake-model');
    expect(assistant?.providerId).toBe('fake');
    expect(assistant?.usage).toMatchObject({ tokensIn: 10, tokensOut: 5 });
  });

  it('思考过程与正文分开存', async () => {
    await collect(
      build({
        script: [
          [
            { kind: 'thinking', text: '先想一下' },
            { kind: 'text', text: '答案' },
            done('end_turn'),
          ],
        ],
      }).startTurn(conversation.id, 'x'),
    );

    const assistant = project.messages
      .page(conversation.id, { limit: 10 })
      .messages.find((m) => m.role === 'assistant');
    const content = assistant?.content as { text: string; thinking?: string };
    expect(content.text).toBe('答案');
    expect(content.thinking).toBe('先想一下');
  });

  it('turn.end 汇总全部轮次的用量', async () => {
    const events = await collect(
      build({
        script: [
          [
            { kind: 'tool_call', id: 'c1', name: 'echo', argumentsJson: '{"value":"x"}' },
            done('tool_use'),
          ],
          [{ kind: 'text', text: '好' }, done('end_turn')],
        ],
      }).startTurn(conversation.id, 'x'),
    );

    const end = events.at(-1);
    expect(end?.kind).toBe('turn.end');
    // 两轮各 10/5，合计 20/10
    expect((end as { usage: { tokensIn: number } }).usage.tokensIn).toBe(20);
  });
});

describe('后台通知注入', () => {
  it('落库为系统消息并返回事件', () => {
    // 不直接开新回合：用户可能正在打字，突然插入一轮 agent 输出会打断他
    const orch = build();
    const event = orch.deliverNotification(conversation.id, {
      label: '长任务',
      output: { kind: 'text', text: '跑完了' },
      durationMs: 5000,
    });

    expect(event.kind).toBe('tool.output');
    const messages = project.messages.page(conversation.id, { limit: 10 }).messages;
    const notice = messages.find(
      (m) => (m.content as { kind?: string }).kind === 'background-notice',
    );
    expect(notice?.content).toMatchObject({ label: '长任务', text: '跑完了', durationMs: 5000 });
  });

  it('错误输出被转成可读文本', () => {
    const orch = build();
    orch.deliverNotification(conversation.id, {
      label: 't',
      output: { kind: 'error', ename: 'ValueError', evalue: '崩了', traceback: [] },
      durationMs: 1,
    });

    const notice = project.messages
      .page(conversation.id, { limit: 10 })
      .messages.find((m) => (m.content as { kind?: string }).kind === 'background-notice');
    expect((notice?.content as { text: string }).text).toContain('ValueError');
  });
});

describe('工具输出回灌', () => {
  it('文本原样', () => {
    expect(toolOutputForModel({ kind: 'text', text: 'hello' })).toBe('hello');
  });

  it('错误带上 traceback', () => {
    const text = toolOutputForModel({
      kind: 'error',
      ename: 'E',
      evalue: 'v',
      traceback: ['line1', 'line2'],
    });
    expect(text).toContain('E: v');
    expect(text).toContain('line1');
  });

  it('富输出取 text/plain', () => {
    expect(toolOutputForModel({ kind: 'rich', data: { 'text/plain': '<DataFrame>' } })).toBe(
      '<DataFrame>',
    );
  });

  it('图像不回灌 base64', () => {
    // 几百 KB 的 base64 会挤掉上下文，而模型读不出图里画了什么
    const text = toolOutputForModel({ kind: 'rich', data: { 'image/png': 'A'.repeat(5000) } });
    expect(text).toContain('image/png');
    expect(text).not.toContain('AAAA');
  });

  it('超长文本被截断并标注', () => {
    const text = toolOutputForModel({ kind: 'text', text: 'x'.repeat(100_000) });
    expect(text).toContain('省略');
    expect(text.length).toBeLessThan(100_000);
  });
});

describe('任务类型推断', () => {
  it('按关键词命中对应任务', () => {
    const ask = (text: string) => inferTaskType([{ role: 'user', content: text }]);
    expect(ask('帮我润色这段引言')).toBe('manuscript.polish');
    expect(ask('把这段翻译成英文')).toBe('manuscript.translate');
    expect(ask('这个差异显著吗，做个 ANOVA')).toBe('stats.reason');
    expect(ask('画一张箱线图')).toBe('figure.compose');
    expect(ask('帮我筛一批文献')).toBe('literature.screen');
  });

  it('认不出时退到通用档', () => {
    // 通用档的权重形状在通用场景下不会明显选错
    expect(inferTaskType([{ role: 'user', content: '随便聊聊' }])).toBe('analysis.codegen');
  });

  it('不猜权重极端的任务类型', () => {
    // citation.verify 压倒性看重引文可靠性，猜错的代价比退到通用档大
    const guessed = inferTaskType([{ role: 'user', content: '核对一下这些引用' }]);
    expect(guessed).not.toBe('citation.verify');
  });

  it('取最后一条用户消息', () => {
    expect(
      inferTaskType([
        { role: 'user', content: '画个图' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '帮我润色' },
      ]),
    ).toBe('manuscript.polish');
  });
});

describe('中文动宾分离（调试中发现的漏匹配）', () => {
  const ask = (text: string) => inferTaskType([{ role: 'user', content: text }]);

  it('动词与「图」被量词隔开也能识别', () => {
    // 「画一张箱线图」里「画」与「图」中间夹了三个字，写成 /画图/ 匹配不到，
    // 而这恰恰是最自然的说法
    expect(ask('画一张箱线图')).toBe('figure.compose');
    expect(ask('帮我绘一个散点图')).toBe('figure.compose');
    expect(ask('做两张对比的柱状图')).toBe('figure.compose');
  });

  it('直接说图种名也能识别', () => {
    expect(ask('来个热图')).toBe('figure.compose');
    expect(ask('用直方图看分布')).toBe('figure.compose');
  });

  it('隔太远不误判', () => {
    // 「画」和「图」相距很远时大概率不是同一个动宾结构
    expect(ask('他画画很好，我们讨论一下这个理论的图景与意义所在')).not.toBe('figure.compose');
  });

  it('覆盖不到的说法退回通用档而不是猜错', () => {
    // 关键词匹配的覆盖是有限的。写这组测试时我先漏了「做」和「柱状」，
    // 补上之后又发现「搞个图」也不在集合里——补关键词是无底洞。
    // 真正的解法是 route.classify 那次模型调用，见 inferTaskType 的函数头。
    //
    // 这条测试记录的是**兜底行为是安全的**：认不出时退到 analysis.codegen，
    // 它的权重形状（重代码与推理、成本中等敏感）在通用场景下不会明显选错。
    // 相比之下猜成 citation.verify 这类权重极端的任务代价大得多
    for (const text of ['搞个图看看', '把结果可视地呈现出来', '随便看看数据']) {
      expect(ask(text)).toBe('analysis.codegen');
    }
  });
});

describe('副作用同步执行（调试中发现的懒执行问题）', () => {
  it('未开始消费时活跃回合已登记', () => {
    // async generator 的函数体在首次 next() 前不执行。把登记放在里面会让
    // 忙检查形同虚设：同一会话上能跑起两个回合，状态机被两条路径同时改写
    const orch = build();
    const events = orch.startTurn(conversation.id, 'x');
    expect(orch.isActive(conversation.id)).toBe(true);
    void collect(events);
  });

  it('未开始消费时用户消息已落库', () => {
    const orch = build();
    const events = orch.startTurn(conversation.id, '还没消费就该存下来');
    const messages = project.messages.page(conversation.id, { limit: 10 }).messages;
    expect(messages.find((m) => m.role === 'user')).toMatchObject({
      content: { kind: 'text', text: '还没消费就该存下来' },
    });
    void collect(events);
  });

  it('拿到迭代器后第二次 startTurn 被拒', () => {
    const orch = build();
    const events = orch.startTurn(conversation.id, 'x');
    expect(() => orch.startTurn(conversation.id, 'y')).toThrow(ConversationBusyError);
    void collect(events);
  });
});
