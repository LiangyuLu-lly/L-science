/**
 * `control_repl` 工具（任务 12.7，需求 10.8）。
 *
 * 与 `python` 工具的分工必须在描述里说清楚，否则模型会拿它跑分析代码——那会让
 * 控制面单例内核被一段两小时的分析占住，而真正需要编排的调用全被推去旁路内核。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ControlRepl } from './repl.js';
import type { ShimPending, ShimSurface } from './shim.js';

export interface ControlReplToolOptions {
  repl: ControlRepl;
  surfaces: readonly ShimSurface[];
  pending: readonly ShimPending[];
}

export interface ControlReplInput {
  code: string;
  mode?: 'auto' | 'singleton' | 'bypass';
  timeoutMs?: number;
}

/** 把可用表面渲染进工具描述，模型不必先探索一遍才知道有什么。 */
function describeSurfaces(
  surfaces: readonly ShimSurface[],
  pending: readonly ShimPending[],
): string {
  const lines = surfaces.map(
    (s) => `  host.${s.name}.{${Object.keys(s.methods).sort().join(', ')}} —— ${s.doc}`,
  );
  if (pending.length > 0) {
    lines.push(`  当前不可用（访问会报错）：${pending.map((p) => `host.${p.name}`).join('、')}`);
  }
  return lines.join('\n');
}

export function createControlReplTool(
  options: ControlReplToolOptions,
): ToolDefinition<ControlReplInput> {
  return {
    name: 'control_repl',
    description:
      '在控制面 Python REPL 里执行代码。这里有一个 `host` 对象，可以程序化地驱动平台自身：' +
      '批量查制品与血缘、按条件派出子 agent、汇总 findings、对项目库做只读 SQL。\n' +
      '可用表面：\n' +
      `${describeSurfaces(options.surfaces, options.pending)}\n` +
      '**这里不跑分析代码。** 读数据、算统计、出图用 `python` 工具——' +
      '控制面是全项目唯一的单例内核，被一段长分析占住之后所有编排调用都会被挤走。' +
      '适合它的是「三十个被试各派一个子 agent 并汇总结果」这类用手写工具调用会很啰嗦的编排。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Python 代码。`host` 已在全局命名空间里。返回值用 print 输出，' + '与普通 cell 一样。',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'singleton', 'bypass'],
          description:
            'auto（默认）：单例空闲时用它，忙时自动改用一次性内核并告知。' +
            'singleton：必须用单例，忙时立刻失败（不排队，排队会死锁）。' +
            'bypass：总是用一次性内核，状态不保留。',
        },
        timeoutMs: { type: 'number', description: '墙钟超时，毫秒' },
      },
      required: ['code'],
      additionalProperties: false,
    },

    parseInput(raw): ControlReplInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.code !== 'string' || obj.code.trim() === '') {
        throw new Error('code 必须是非空字符串');
      }
      if (
        obj.mode !== undefined &&
        (typeof obj.mode !== 'string' || !['auto', 'singleton', 'bypass'].includes(obj.mode))
      ) {
        throw new Error('mode 只能是 auto、singleton 或 bypass');
      }
      if (
        obj.timeoutMs !== undefined &&
        (typeof obj.timeoutMs !== 'number' || obj.timeoutMs <= 0)
      ) {
        throw new Error('timeoutMs 必须是正数');
      }

      return {
        code: obj.code,
        ...(typeof obj.mode === 'string' ? { mode: obj.mode as ControlReplInput['mode'] } : {}),
        ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      let result;
      try {
        result = await options.repl.run({
          code: input.code,
          // host 调用要按**发起这次执行的会话**归属，而不是内核启动时的那个会话：
          // 控制面单例内核跨会话复用
          conversationId: ctx.conversationId,
          // 执行者身份由这里注入，控制面代码不自报（`host.claims.verify` 要用它）
          ...(ctx.modelId === undefined ? {} : { modelId: ctx.modelId }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
      } catch (err) {
        return {
          ok: false,
          output: errorOutput(
            'ControlPlaneFailed',
            `控制面执行失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      }

      // 走了旁路要如实说：调用方可能指望上一次执行留下的变量还在
      if (result.bypassReason !== null && result.output.kind === 'text') {
        return {
          ...result,
          output: textOutput(`[${result.bypassReason}]\n${result.output.text}`),
        };
      }
      return result;
    },
  };
}

export interface ControlReplStatusInput {
  action?: 'status' | 'restart' | 'interrupt';
}

export function createControlReplAdminTool(
  options: ControlReplToolOptions,
): ToolDefinition<ControlReplStatusInput> {
  return {
    name: 'control_repl_admin',
    description:
      '查看或重置控制面 REPL。restart 会清掉控制面的全部状态（派出去的子 agent 句柄、' +
      '中间结果都会丢），只在控制面卡住或状态确实乱了时用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'restart', 'interrupt'] },
      },
      additionalProperties: false,
    },

    parseInput(raw): ControlReplStatusInput {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (
        obj.action !== undefined &&
        (typeof obj.action !== 'string' || !['status', 'restart', 'interrupt'].includes(obj.action))
      ) {
        throw new Error('action 只能是 status、restart 或 interrupt');
      }
      return typeof obj.action === 'string'
        ? { action: obj.action as ControlReplStatusInput['action'] }
        : {};
    },

    async execute(input): Promise<ToolResult> {
      const action = input.action ?? 'status';

      if (action === 'status') {
        return {
          ok: true,
          output: textOutput(
            [
              `控制面单例内核：${options.repl.busy ? '正在执行' : '空闲'}（键 ${options.repl.singletonKey}）`,
              `可用表面：${options.surfaces.map((s) => s.name).join('、')}`,
              options.pending.length === 0
                ? ''
                : `当前不可用：${options.pending.map((p) => `${p.name}（${p.reason}）`).join('；')}`,
            ]
              .filter((s) => s !== '')
              .join('\n'),
          ),
        };
      }

      if (action === 'interrupt') {
        const interrupted = await options.repl.interrupt();
        return {
          ok: true,
          output: textOutput(
            interrupted ? '已向控制面内核发送中断。' : '控制面内核当前没有在执行。',
          ),
        };
      }

      try {
        const restarted = await options.repl.restart();
        return {
          ok: true,
          output: textOutput(
            restarted ? '控制面内核已重启，全部状态已清空。' : '控制面内核尚未启动，无需重启。',
          ),
        };
      } catch (err) {
        return {
          ok: false,
          output: errorOutput('ControlPlaneBusy', err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}
