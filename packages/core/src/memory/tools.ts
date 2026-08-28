/**
 * 记忆的 agent 侧工具（任务 12.9，需求 16.2、16.4）。
 *
 * 两个刻意的边界：
 *
 * 1. **没有 forget 工具。** 删除是用户的权力（需求 16.3）。模型能删记忆的话，一条它
 *    此刻觉得不方便的约定就会消失，而用户不会收到任何通知。需要纠正过时的记忆时用
 *    `remember` 的 `replaceId`——那留下了痕迹。
 * 2. **写入的拒绝理由要带改写建议。** 只说「不许写」会让模型放弃使用记忆，
 *    那等于把这个能力关掉。
 */

import type { MemoryKind, MemoryScope } from '../repo/memory.js';
import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { memoryGuidance } from './classify.js';
import type { MemoryService } from './service.js';

const SCOPES: readonly MemoryScope[] = ['global', 'project', 'compute'];
const KINDS: readonly MemoryKind[] = [
  'preference',
  'background',
  'convention',
  'decision',
  'data',
  'environment',
];

export interface MemoryToolOptions {
  /** 按项目取服务实例。记忆的项目作用域绑在项目库上。 */
  service: (projectId: string) => MemoryService;
}

/* ------------------------------------------------------------------ *
 * remember
 * ------------------------------------------------------------------ */

export interface RememberInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  reason: string;
  scopeId?: string;
  replaceId?: string;
}

export function createRememberTool(options: MemoryToolOptions): ToolDefinition<RememberInput> {
  return {
    name: 'remember',
    description:
      '把一条**跨会话仍然成立的知识**写进长期记忆，之后每个会话都会自动看到它。\n' +
      `${memoryGuidance()}\n` +
      '不要记这一轮发生了什么，也不要记具体的分析结果——那些会被拒。' +
      '发现已有记忆过时了，用 replaceId 覆盖它，不要新增一条相互矛盾的。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: SCOPES,
          description:
            'global：跨项目的偏好与习惯。project：本项目的背景、约定、决策、数据说明。' +
            'compute：某个算力目标的环境笔记（要同时给 scopeId）。',
        },
        kind: { type: 'string', enum: KINDS, description: '类别。决定注入时的优先级。' },
        content: {
          type: 'string',
          description: '一句完整、离开当前上下文也读得懂的陈述。不要用「这个」「刚才」这类指代。',
        },
        reason: {
          type: 'string',
          description:
            '为什么值得长期记住。用户日后审查记忆时靠它判断该不该留，' +
            '因此「重要」这类话没有用。',
        },
        scopeId: { type: 'string', description: 'compute 作用域下的算力目标 id。' },
        replaceId: {
          type: 'string',
          description: '要覆盖的既有记忆 id。用于纠正已经过时的条目。',
        },
      },
      required: ['scope', 'kind', 'content', 'reason'],
      additionalProperties: false,
    },

    parseInput(raw): RememberInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.scope !== 'string' || !SCOPES.includes(obj.scope as MemoryScope)) {
        throw new Error(`scope 只能是 ${SCOPES.join(' / ')}`);
      }
      if (typeof obj.kind !== 'string' || !KINDS.includes(obj.kind as MemoryKind)) {
        throw new Error(`kind 只能是 ${KINDS.join(' / ')}`);
      }
      if (typeof obj.content !== 'string' || obj.content.trim() === '') {
        throw new Error('content 必须是非空字符串');
      }
      if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
        throw new Error('reason 必须是非空字符串：没有理由的记忆用户无从判断该不该留');
      }

      return {
        scope: obj.scope as MemoryScope,
        kind: obj.kind as MemoryKind,
        content: obj.content,
        reason: obj.reason,
        ...(typeof obj.scopeId === 'string' && obj.scopeId.trim() !== ''
          ? { scopeId: obj.scopeId.trim() }
          : {}),
        ...(typeof obj.replaceId === 'string' && obj.replaceId.trim() !== ''
          ? { replaceId: obj.replaceId.trim() }
          : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const service = options.service(ctx.projectId);
      const result = service.remember({
        scope: input.scope,
        kind: input.kind,
        content: input.content,
        reason: input.reason,
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        ...(input.replaceId === undefined ? {} : { replaceId: input.replaceId }),
      });

      if (!result.ok) {
        return {
          ok: false,
          output: errorOutput('MemoryRejected', result.reason),
        };
      }

      const verb = result.deduped
        ? '已有同样的记忆，更新了理由与时间'
        : result.created
          ? '已记住'
          : '已覆盖';
      return {
        ok: true,
        output: textOutput(
          `${verb}（${input.scope}/${input.kind}，id ${result.note.id}）：${result.note.content}`,
        ),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * recall_memory
 * ------------------------------------------------------------------ */

export interface RecallInput {
  scope?: MemoryScope;
  kind?: MemoryKind;
  scopeId?: string;
  query?: string;
}

export function createRecallMemoryTool(options: MemoryToolOptions): ToolDefinition<RecallInput> {
  return {
    name: 'recall_memory',
    description:
      '列出已经记住的内容。全局与项目作用域的记忆已经自动注入在系统提示词里，' +
      '因此这个工具主要用于三件事：查算力环境笔记（不自动注入）、' +
      '拿到某条记忆的 id 以便覆盖它、以及记忆条数到上限时看一遍好做合并。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES },
        kind: { type: 'string', enum: KINDS },
        scopeId: { type: 'string', description: 'compute 作用域下的算力目标 id。' },
        query: { type: 'string', description: '按内容做子串筛选（不区分大小写）。' },
      },
      additionalProperties: false,
    },

    parseInput(raw): RecallInput {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (obj.scope !== undefined && !SCOPES.includes(obj.scope as MemoryScope)) {
        throw new Error(`scope 只能是 ${SCOPES.join(' / ')}`);
      }
      if (obj.kind !== undefined && !KINDS.includes(obj.kind as MemoryKind)) {
        throw new Error(`kind 只能是 ${KINDS.join(' / ')}`);
      }

      return {
        ...(typeof obj.scope === 'string' ? { scope: obj.scope as MemoryScope } : {}),
        ...(typeof obj.kind === 'string' ? { kind: obj.kind as MemoryKind } : {}),
        ...(typeof obj.scopeId === 'string' && obj.scopeId.trim() !== ''
          ? { scopeId: obj.scopeId.trim() }
          : {}),
        ...(typeof obj.query === 'string' && obj.query.trim() !== ''
          ? { query: obj.query.trim() }
          : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const service = options.service(ctx.projectId);
      let notes = service.list({
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      });

      if (input.query !== undefined) {
        const needle = input.query.toLowerCase();
        notes = notes.filter(
          (n) =>
            n.content.toLowerCase().includes(needle) || n.reason.toLowerCase().includes(needle),
        );
      }

      if (notes.length === 0) {
        return { ok: true, output: textOutput('没有匹配的记忆。') };
      }

      return {
        ok: true,
        output: textOutput(
          [
            `${String(notes.length)} 条记忆：`,
            '',
            ...notes.map((n) =>
              [
                `[${n.scope}/${n.kind}] ${n.content}`,
                `  id: ${n.id}`,
                `  理由：${n.reason}`,
                n.scopeId === null || n.scope === 'project' ? '' : `  作用于：${n.scopeId}`,
              ]
                .filter((s) => s !== '')
                .join('\n'),
            ),
          ].join('\n'),
        ),
      };
    },
  };
}
