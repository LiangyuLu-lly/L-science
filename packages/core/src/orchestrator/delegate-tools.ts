/**
 * 委派工具（任务 12.6，需求 10.5、10.6、10.7）。
 *
 * `delegate` 一次可以派出多个子 agent 并等它们全部结束——并行的价值在这里，
 * 逐个 await 等于顺序执行。等待期间用户可以中断，阻塞式的会被一并取消。
 *
 * 非阻塞委派立刻返回句柄，由 `agent_status` 查询、`guide_agent` 引导、
 * `stop_agent` 停止。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { SubAgentHandle, SubAgentRunner, SubAgentSpec } from './subagent.js';

export interface DelegateToolsOptions {
  runner: SubAgentRunner;
  /** 已启用的技能，用于校验 skillSlug。 */
  availableSkills: () => ReadonlySet<string>;
  /** 委派开始与结束时推事件给 UI。 */
  onEvent?: (event: {
    kind: 'agent.started' | 'agent.finished';
    agentId: string;
    conversationId: string;
    parentConversationId: string;
    detail?: string;
  }) => void;
}

export interface DelegateInput {
  tasks: readonly SubAgentSpec[];
  /** 全部为非阻塞时立即返回。混用时以每个任务自己的 blocking 为准。 */
}

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        '任务描述。**子 agent 看不到本会话的历史**，所以要写到它能独立执行的程度：' +
        '做什么、用什么数据、判据是什么。',
    },
    skillSlug: {
      type: 'string',
      description: '要遵循的技能 slug。会被注入子 agent 的提示。必须是实际存在的技能。',
    },
    inputVersionIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        '输入制品的版本 id。子 agent 用 {{artifact:id}} 引用它们——那会解析成项目级路径，' +
        '因此跨 agent 传数据不需要共享目录。**不要指望它能看到你工作目录里的文件。**',
    },
    produces: {
      type: 'array',
      items: { type: 'string' },
      description: '期望产出。子 agent 必须用 save_artifacts 保存，否则你拿不到它。',
    },
    blocking: {
      type: 'boolean',
      description:
        '是否阻塞等待。默认 true。设为 false 时立即返回句柄，任务在后台继续；' +
        '用户中断时非阻塞的子 agent 不会被取消。',
    },
    taskType: {
      type: 'string',
      description: '任务类型，用于给子 agent 选模型。省略时按「生成分析代码」处理。',
    },
    maxTurns: { type: 'number', description: '回合上限' },
  },
  required: ['task'],
  additionalProperties: false,
} as const;

function describeResult(handle: SubAgentHandle, result: Awaited<SubAgentHandle['result']>): string {
  const lines = [
    `子 agent ${handle.agentId}：${result.status}（${String(result.turns)} 回合，` +
      `${String(result.usage.tokensIn)} in / ${String(result.usage.tokensOut)} out）`,
  ];
  if (result.summary !== '') lines.push(`陈述：${result.summary}`);
  if (result.producedVersionIds.length > 0) {
    lines.push(`产出制品版本：${result.producedVersionIds.join('、')}`);
  } else if (result.status === 'done') {
    // 说「完成了」但没有产物，通常意味着它只是在描述而没有真的做
    lines.push('注意：它没有保存任何制品。若本任务本应有产出，说明它没有真正完成。');
  }
  if (result.detail !== null) lines.push(`说明：${result.detail}`);
  lines.push(`过程可在子会话 ${result.conversationId} 里翻看。`);
  return lines.join('\n');
}

export function createDelegateTool(options: DelegateToolsOptions): ToolDefinition<DelegateInput> {
  return {
    name: 'delegate',
    description:
      '把一件或多件独立的任务派给子 agent。一次传多个任务它们会并行跑——' +
      '逐个调用等于顺序执行，没有并行的价值。' +
      '**子 agent 看不到本会话的历史**，任务描述要自足；数据经制品交接，不要指望共享文件。' +
      '适合的场景：多个被试各跑一遍同样的分析、几个方向各查一遍文献。' +
      '不适合的场景：需要来回商量的、需要看用户反应的、一两步就能做完的。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: TASK_SCHEMA, description: '要派出的任务，至少一个' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },

    parseInput(raw): DelegateInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
        throw new Error('tasks 至少要有一个任务');
      }
      if (obj.tasks.length > 16) {
        throw new Error('一次最多派 16 个任务。更多的话请分批，否则排队时间比串行还长');
      }

      const tasks: SubAgentSpec[] = [];
      for (const [i, rawTask] of obj.tasks.entries()) {
        if (typeof rawTask !== 'object' || rawTask === null) {
          throw new Error(`tasks[${String(i)}] 必须是对象`);
        }
        const t = rawTask as Record<string, unknown>;
        if (typeof t.task !== 'string' || t.task.trim() === '') {
          throw new Error(`tasks[${String(i)}].task 必须是非空字符串`);
        }

        const strArray = (value: unknown, field: string): readonly string[] => {
          if (value === undefined || value === null) return [];
          if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
            throw new Error(`tasks[${String(i)}].${field} 必须是字符串数组`);
          }
          return value as string[];
        };

        tasks.push({
          task: t.task.trim(),
          ...(typeof t.skillSlug === 'string' ? { skillSlug: t.skillSlug } : {}),
          inputVersionIds: strArray(t.inputVersionIds, 'inputVersionIds'),
          produces: strArray(t.produces, 'produces'),
          // 默认阻塞：转后台必须是显式选择
          blocking: t.blocking !== false,
          ...(typeof t.taskType === 'string'
            ? { taskType: t.taskType as SubAgentSpec['taskType'] }
            : {}),
          ...(typeof t.maxTurns === 'number' && t.maxTurns > 0
            ? { maxTurns: Math.floor(t.maxTurns) }
            : {}),
        });
      }

      return { tasks };
    },

    async execute(input, ctx): Promise<ToolResult> {
      // 先校验技能绑定：派出去之后才发现技能不存在，那几个子 agent 已经在烧 token 了
      const skills = options.availableSkills();
      const bad = input.tasks
        .map((t) => t.skillSlug)
        .filter((s): s is string => typeof s === 'string' && !skills.has(s));
      if (bad.length > 0) {
        return {
          ok: false,
          output: errorOutput(
            'UnknownSkill',
            `以下 skillSlug 不存在或已被禁用：${[...new Set(bad)].join('、')}。` +
              '先用 search_skills 确认，再委派。',
          ),
        };
      }

      const handles = input.tasks.map((spec) => {
        const handle = options.runner.spawn({
          parentConversationId: ctx.conversationId,
          spec,
        });
        options.onEvent?.({
          kind: 'agent.started',
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          parentConversationId: ctx.conversationId,
          detail: spec.task.slice(0, 120),
        });
        return { handle, spec };
      });

      const blocking = handles.filter((h) => h.handle.blocking);
      const background = handles.filter((h) => !h.handle.blocking);

      // 非阻塞的挂一个收尾回调即可，不等它
      for (const { handle } of background) {
        void handle.result.then((r) => {
          options.onEvent?.({
            kind: 'agent.finished',
            agentId: handle.agentId,
            conversationId: handle.conversationId,
            parentConversationId: ctx.conversationId,
            detail: r.status,
          });
        });
      }

      const sections: string[] = [];

      if (background.length > 0) {
        sections.push(
          `已在后台派出 ${String(background.length)} 个子 agent（非阻塞）：` +
            background.map((h) => h.handle.agentId).join('、') +
            '。用 agent_status 查进度，guide_agent 发补充说明，stop_agent 停止。' +
            '用户中断本会话时它们不会被取消。',
        );
      }

      if (blocking.length > 0) {
        /*
         * 并行等待。用 allSettled 而不是 all：一个失败不该让其余的结果丢掉——
         * 那几个已经跑完的子 agent 的产物是真实存在的制品，把它们的 id 丢了
         * 就等于白跑。
         */
        const results = await Promise.allSettled(blocking.map((h) => h.handle.result));

        sections.push(`${String(blocking.length)} 个阻塞式子 agent 已结束：`);
        for (const [i, settled] of results.entries()) {
          const entry = blocking[i];
          if (entry === undefined) continue;

          if (settled.status === 'fulfilled') {
            options.onEvent?.({
              kind: 'agent.finished',
              agentId: entry.handle.agentId,
              conversationId: entry.handle.conversationId,
              parentConversationId: ctx.conversationId,
              detail: settled.value.status,
            });
            sections.push('', describeResult(entry.handle, settled.value));
          } else {
            sections.push(
              '',
              `子 agent ${entry.handle.agentId} 异常终止：${
                settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
              }`,
            );
          }
        }

        const failed = results.filter(
          (r) => r.status === 'rejected' || r.value.status !== 'done',
        ).length;
        if (failed > 0) {
          sections.push(
            '',
            `其中 ${String(failed)} 个没有正常完成。不要把它们的任务当成已完成——` +
              '它们的产物不存在，依赖这些产物的结论没有依据。',
          );
        }
      }

      return { ok: true, output: textOutput(sections.join('\n')) };
    },
  };
}

export interface AgentStatusInput {
  agentId?: string;
}

export function createAgentStatusTool(
  options: DelegateToolsOptions,
): ToolDefinition<AgentStatusInput> {
  return {
    name: 'agent_status',
    description: '查询在跑的子 agent。省略 agentId 时列出本会话派出的全部。',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      additionalProperties: false,
    },

    parseInput(raw): AgentStatusInput {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (obj.agentId !== undefined && typeof obj.agentId !== 'string') {
        throw new Error('agentId 必须是字符串');
      }
      return typeof obj.agentId === 'string' ? { agentId: obj.agentId } : {};
    },

    async execute(input, ctx): Promise<ToolResult> {
      if (input.agentId !== undefined) {
        const handle = options.runner.get(input.agentId);
        if (handle === null) {
          return {
            ok: true,
            output: textOutput(
              `子 agent ${input.agentId} 不在运行中（可能已结束）。` +
                '结束的子 agent 的结果在它当时的 delegate 返回值里。',
            ),
          };
        }
        return {
          ok: true,
          output: textOutput(
            `${handle.agentId}：${handle.status}${handle.blocking ? '（阻塞式）' : '（非阻塞）'}，` +
              `子会话 ${handle.conversationId}`,
          ),
        };
      }

      const handles = options.runner.list(ctx.conversationId);
      if (handles.length === 0) {
        return { ok: true, output: textOutput('本会话没有在跑的子 agent。') };
      }

      return {
        ok: true,
        output: textOutput(
          [
            `在跑的子 agent ${String(handles.length)} 个：`,
            ...handles.map(
              (h) =>
                `- ${h.agentId}　${h.status}　${h.blocking ? '阻塞式' : '非阻塞'}　子会话 ${h.conversationId}`,
            ),
          ].join('\n'),
        ),
      };
    },
  };
}

export interface GuideAgentInput {
  agentId: string;
  message: string;
}

export function createGuideAgentTool(
  options: DelegateToolsOptions,
): ToolDefinition<GuideAgentInput> {
  return {
    name: 'guide_agent',
    description:
      '给运行中的子 agent 发一条补充说明。它会在子 agent 的**下一个回合开始前**生效——' +
      '流式模型调用一旦开始就无法插话。用于纠偏或补充遗漏的信息，不要用它来闲聊。',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        message: { type: 'string', description: '补充说明。写具体，它没有上下文。' },
      },
      required: ['agentId', 'message'],
      additionalProperties: false,
    },

    parseInput(raw): GuideAgentInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (typeof obj.agentId !== 'string' || obj.agentId === '') {
        throw new Error('agentId 必须是非空字符串');
      }
      if (typeof obj.message !== 'string' || obj.message.trim() === '') {
        throw new Error('message 必须是非空字符串');
      }
      return { agentId: obj.agentId, message: obj.message.trim() };
    },

    async execute(input): Promise<ToolResult> {
      if (!options.runner.get(input.agentId)?.guide(input.message)) {
        return {
          ok: false,
          output: errorOutput(
            'AgentNotRunning',
            `子 agent ${input.agentId} 不在运行中，无法接收引导消息。`,
          ),
        };
      }
      return {
        ok: true,
        output: textOutput(`已发给 ${input.agentId}，它的下一个回合开始前会读到。`),
      };
    },
  };
}

export interface StopAgentInput {
  agentId: string;
  reason: string;
}

export function createStopAgentTool(options: DelegateToolsOptions): ToolDefinition<StopAgentInput> {
  return {
    name: 'stop_agent',
    description:
      '停止一个运行中的子 agent。它已保存的制品会保留——停止不回滚已发生的事。' +
      '走错方向、不再需要、或用户要求时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        reason: { type: 'string', description: '停止原因，会记进它的结果里' },
      },
      required: ['agentId', 'reason'],
      additionalProperties: false,
    },

    parseInput(raw): StopAgentInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (typeof obj.agentId !== 'string' || obj.agentId === '') {
        throw new Error('agentId 必须是非空字符串');
      }
      if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
        throw new Error('reason 必须是非空字符串——停止原因会记进结果，事后要能看懂');
      }
      return { agentId: obj.agentId, reason: obj.reason.trim() };
    },

    async execute(input): Promise<ToolResult> {
      if (!options.runner.get(input.agentId)?.stop(input.reason)) {
        return {
          ok: false,
          output: errorOutput('AgentNotRunning', `子 agent ${input.agentId} 不在运行中。`),
        };
      }
      return { ok: true, output: textOutput(`已停止 ${input.agentId}。已保存的制品保留。`) };
    },
  };
}
