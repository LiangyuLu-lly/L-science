/**
 * `search_skills` 与 `load_skill_reference` 工具（任务 12.2、12.3，需求 9.3-9.5、9.8）。
 *
 * 检索与注入分成两个动作而不是一个：`search_skills` 返回候选清单，模型看过之后
 * 再决定加载哪个。一步到底（检索即注入命中的第一个）的问题是模型无法否决——
 * 用户问的是「怎么导出 EDF」，检索最高分却是 `sleep-staging`，一步到底会把
 * 一份不相关的长文档塞进上下文，而模型只能带着它继续。
 *
 * 因此 `search_skills` 有一个 `load` 参数：模型确定要哪个时可以一次做完，
 * 不确定时先看清单。默认不加载。
 */

import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { errorOutput, textOutput } from '../tools/registry.js';
import type { SkillManager } from './manager.js';
import type { SkillLoadReason } from '../repo/skills.js';

export interface SearchSkillsInput {
  query: string;
  limit?: number;
  /** 直接加载这些 slug 的技能内容。留空则只返回清单。 */
  load?: readonly string[];
}

export interface SkillToolOptions {
  manager: SkillManager;
  /** 记录一次加载。用于需求 9.8 的审计。 */
  audit?: (input: {
    conversationId: string;
    slug: string;
    reason: SkillLoadReason;
    detail: string | null;
    injectedChars: number;
  }) => void;
}

/** 检索结果的一行摘要。要让模型能据此判断该不该加载。 */
function describeHit(hit: Awaited<ReturnType<SkillManager['search']>>[number]): string {
  const parts = [
    `- ${hit.slug}（${hit.manifest.name}）相关度 ${hit.score.toFixed(2)}`,
    `  ${hit.manifest.description}`,
  ];
  if (hit.manifest.triggers.length > 0) {
    parts.push(`  适用：${hit.manifest.triggers.join('；')}`);
  }
  if (hit.scope === 'user') parts.push('  来源：用户自建（覆盖同名内置技能）');
  if (!hit.requirementsSatisfied && hit.missingSummary !== null) {
    // 依赖缺失不隐藏也不过滤：模型需要知道「这个方法存在但环境没装好」
    parts.push(`  ⚠ 依赖未满足：\n${hit.missingSummary.replace(/^/gm, '    ')}`);
  }
  if (hit.references.length > 0) {
    parts.push(`  参考材料：${hit.references.join('、')}`);
  }
  return parts.join('\n');
}

export function createSearchSkillsTool(
  options: SkillToolOptions,
): ToolDefinition<SearchSkillsInput> {
  return {
    name: 'search_skills',
    description:
      '按自然语言检索可用的领域技能，返回候选清单。技能是经过审阅的方法学文档，' +
      '涵盖信号处理、统计规范、文献检索、期刊格式等。**动手做一件有既定方法的事之前先检索**——' +
      '自己临时发明流程通常会漏掉领域里的标准做法（比如多重比较校正、分期规则）。' +
      '确定要用哪个之后用 load 参数把它的指令文档加载进来。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '想做什么，用自然语言描述。中英文都可以。',
        },
        limit: { type: 'number', description: '返回条数，默认 5' },
        load: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要直接加载的技能 slug。已经确定用哪个时填它，可以省掉一次往返；不确定时留空先看清单。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },

    parseInput(raw): SearchSkillsInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.query !== 'string' || obj.query.trim() === '') {
        throw new Error('query 必须是非空字符串');
      }
      if (obj.limit !== undefined && (typeof obj.limit !== 'number' || obj.limit < 1)) {
        throw new Error('limit 必须是不小于 1 的数字');
      }
      if (obj.load !== undefined) {
        if (!Array.isArray(obj.load) || obj.load.some((s) => typeof s !== 'string')) {
          throw new Error('load 必须是字符串数组');
        }
      }

      return {
        query: obj.query.trim(),
        ...(typeof obj.limit === 'number' ? { limit: Math.min(20, Math.floor(obj.limit)) } : {}),
        ...(Array.isArray(obj.load) ? { load: obj.load as string[] } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const hits = await options.manager.search(input.query, input.limit ?? 5);
      const sections: string[] = [];

      if (hits.length === 0) {
        sections.push(
          `没有技能匹配「${input.query}」。可用技能共 ${String(options.manager.list().length)} 个。` +
            '换个说法再试，或者直接按通用方法做——但要在回答里说明这一步没有对应的既定方法。',
        );
      } else {
        sections.push(`匹配到 ${String(hits.length)} 个技能：`);
        sections.push(hits.map(describeHit).join('\n'));
      }

      // 加载请求：允许加载不在本次命中里的 slug（模型可能记得某个技能的名字）
      const toLoad = [...new Set(input.load ?? [])];
      const notFound: string[] = [];

      for (const slug of toLoad) {
        const injection = options.manager.inject(slug);
        if (injection === null) {
          notFound.push(slug);
          continue;
        }

        const hit = hits.find((h) => h.slug === slug);
        options.audit?.({
          conversationId: ctx.conversationId,
          slug,
          // 命中列表里有它就算检索加载，否则是模型点名的
          reason: hit === undefined ? 'explicit' : 'search',
          detail:
            hit === undefined
              ? `模型点名加载，查询「${input.query}」`
              : `检索命中，查询「${input.query}」，相关度 ${hit.score.toFixed(3)}`,
          injectedChars: injection.content.length,
        });

        sections.push(`\n---\n\n${injection.content}`);
      }

      if (notFound.length > 0) {
        sections.push(
          `\n以下 slug 不存在或已被禁用，未加载：${notFound.join('、')}。` +
            '请从上面的候选清单里选。',
        );
      }

      return { ok: true, output: textOutput(sections.join('\n')) };
    },
  };
}

export interface LoadSkillReferenceInput {
  slug: string;
  name: string;
}

export function createLoadSkillReferenceTool(
  options: SkillToolOptions,
): ToolDefinition<LoadSkillReferenceInput> {
  return {
    name: 'load_skill_reference',
    description:
      '加载某个技能的参考材料。技能的主文档里会列出它有哪些参考材料——' +
      '那些是按需加载的详细内容（参数表、判读标准、模板），不会随主文档一起进来。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '技能 slug' },
        name: { type: 'string', description: '参考材料文件名' },
      },
      required: ['slug', 'name'],
      additionalProperties: false,
    },

    parseInput(raw): LoadSkillReferenceInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (typeof obj.slug !== 'string' || obj.slug.trim() === '') {
        throw new Error('slug 必须是非空字符串');
      }
      if (typeof obj.name !== 'string' || obj.name.trim() === '') {
        throw new Error('name 必须是非空字符串');
      }
      return { slug: obj.slug.trim(), name: obj.name.trim() };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const result = options.manager.readReference(input.slug, input.name);
      if (!result.ok) {
        return {
          ok: false,
          output: errorOutput('SkillReferenceNotFound', result.reason),
        };
      }

      options.audit?.({
        conversationId: ctx.conversationId,
        slug: input.slug,
        reason: 'reference',
        detail: `参考材料 ${input.name}`,
        injectedChars: result.content.length,
      });

      return {
        ok: true,
        output: textOutput(`# ${input.slug} / ${input.name}\n\n${result.content}`),
      };
    },
  };
}
