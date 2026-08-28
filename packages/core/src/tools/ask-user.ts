/**
 * `ask_user` 工具（任务 8.2，需求 17.4）。
 *
 * agent 向用户提问并等待回答。它存在的意义是让 agent 在**信息缺失时停下来问**，
 * 而不是替用户假设一个取值继续往下算——后者会产出一份看起来完整、但基于错误
 * 前提的分析，而用户没有任何线索知道哪一步被替他决定了。
 *
 * 三个刻意的设计：
 *
 * 1. **超时不等于拿到答案。** 用户没答时返回失败而不是空串。空串在语义上是
 *    「我没有补充」，那是有效信息；把「没人在」也表示成空串会让 agent 拿着一个
 *    不存在的答案继续。
 * 2. **有选项时仍允许自由作答。** 预设选项常常漏掉用户真正想说的那个，强制
 *    只能选会把他逼到「选一个最接近的」，而那个答案是错的。
 * 3. **一次只问一个问题。** 允许批量提问会让 UI 变成一张表单，而 agent 在拿到
 *    第一个答案之后往往就不需要问第二个了。
 */

import type { UserQuestion } from '@l-science/shared';

import type { QuestionService } from '../approval/questions.js';
import { errorOutput, textOutput } from './registry.js';
import type { ToolDefinition, ToolResult } from './types.js';

export interface AskUserInput {
  question: string;
  detail?: string;
  choices?: readonly string[];
  kind?: UserQuestion['kind'];
  timeoutMs?: number;
}

export interface AskUserToolOptions {
  questions: QuestionService;
}

/** 提问最长等多久。默认与审批一致（10 分钟）。 */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export function createAskUserTool(options: AskUserToolOptions): ToolDefinition<AskUserInput> {
  return {
    name: 'ask_user',
    description:
      '向用户提问并等待回答。信息缺失且**无法从数据或上下文推断**时用它——' +
      '比如不知道被试的分组变量叫什么、不确定该用哪个时间窗、需要确认投稿目标期刊。' +
      '不要用它确认你已经能自己判断的事：每次提问都会打断用户，' +
      '把能自己查的东西拿来问会让他觉得这个平台比手工做还费劲。' +
      '提供 choices 时用户仍可自由作答。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题本身。一句话，具体到可以直接回答。' },
        detail: {
          type: 'string',
          description:
            '补充上下文：为什么需要这个信息、不同取值会导致什么不同。' + '用户靠它判断该怎么答。',
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: '预设选项。可省略表示自由作答。用户始终可以不选而自己写。',
        },
        kind: {
          type: 'string',
          enum: ['general', 'compute-config'],
          description:
            'compute-config 用于算力配置类提问（目标、分区、账户），UI 会附上当前可用的选项。' +
            '其余用 general。',
        },
        timeoutMs: { type: 'number', description: '等待上限，毫秒。默认 10 分钟。' },
      },
      required: ['question'],
      additionalProperties: false,
    },

    parseInput(raw): AskUserInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.question !== 'string' || obj.question.trim() === '') {
        throw new Error('question 必须是非空字符串');
      }
      if (obj.detail !== undefined && typeof obj.detail !== 'string') {
        throw new Error('detail 必须是字符串');
      }
      if (obj.choices !== undefined) {
        if (!Array.isArray(obj.choices) || obj.choices.some((c) => typeof c !== 'string')) {
          throw new Error('choices 必须是字符串数组');
        }
      }
      if (
        obj.kind !== undefined &&
        (typeof obj.kind !== 'string' || !['general', 'compute-config'].includes(obj.kind))
      ) {
        throw new Error('kind 只能是 general 或 compute-config');
      }
      if (
        obj.timeoutMs !== undefined &&
        (typeof obj.timeoutMs !== 'number' || obj.timeoutMs <= 0 || obj.timeoutMs > MAX_TIMEOUT_MS)
      ) {
        throw new Error(`timeoutMs 必须是 0 到 ${String(MAX_TIMEOUT_MS)} 之间的正数`);
      }

      return {
        question: obj.question.trim(),
        ...(typeof obj.detail === 'string' && obj.detail.trim() !== ''
          ? { detail: obj.detail }
          : {}),
        ...(Array.isArray(obj.choices) ? { choices: obj.choices as readonly string[] } : {}),
        ...(typeof obj.kind === 'string' ? { kind: obj.kind as UserQuestion['kind'] } : {}),
        ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const result = await options.questions.ask({
        kind: input.kind ?? 'general',
        question: input.question,
        detail: input.detail ?? null,
        choices: input.choices ?? [],
        conversationId: ctx.conversationId,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });

      if (result.state === 'answered') {
        // 空答案要说明是「明确表示没有补充」，否则模型会以为提问失败了
        return {
          ok: true,
          output: textOutput(
            result.answer.trim() === ''
              ? '用户回答为空，表示没有补充信息。请基于已有信息继续，并说明你替他做了哪个假设。'
              : result.answer,
          ),
        };
      }

      if (result.state === 'timeout') {
        return {
          ok: false,
          output: errorOutput(
            'UserDidNotAnswer',
            `等了 ${String(Math.round(result.waitedMs / 1000))} 秒仍未收到回答。` +
              '不要假设一个答案继续——如果这一步确实必须有这个信息，' +
              '就在回复里说明卡在哪，把选择权交回用户。',
          ),
        };
      }

      return {
        ok: false,
        output: errorOutput('UserQuestionCancelled', `提问已取消：${result.reason}`),
      };
    },
  };
}
