/**
 * `create_skill` 工具（任务 12.15，需求 9.6）。
 *
 * 让模型在对话里把刚刚商定的做法写成一个技能。这是五条创建路径里唯一由模型发起的。
 *
 * ## 为什么必须过审批
 *
 * 其他工具的副作用是一次性的：跑一段代码、写一个文件，做错了看得见。技能不是——
 * 它**会被注入到以后每一次相关对话里**。一份方法学写错的技能，影响此后所有命中它的
 * 分析，而那种影响不以报错的形式出现，只表现为「结论慢慢开始不对」。
 *
 * 因此这个工具与 MCP 的非只读工具同一个处理：有审批通道就发卡片阻塞等待，
 * **没有审批通道就拒绝**。让它在没人能批准的时候静默写入，等于把「以后每次都按这个做」
 * 的决定权交给了模型。
 *
 * ## 为什么不让模型直接改已有技能
 *
 * 默认拒绝覆盖。模型「改进」一个内置技能的实际效果是造一个同名用户技能把它遮蔽掉，
 * 而遮蔽之后原来那份就再也不会被加载——用户从检索结果里看不出发生了这件事。
 * 要覆盖必须模型显式传 `overwrite` 并在审批卡片上写明它会遮蔽谁。
 */

import type { ApprovalService } from '../approval/service.js';
import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

import {
  auditSkillContent,
  validateSkillFiles,
  writeUserSkill,
  type SkillFileMap,
} from './authoring.js';
import type { SkillManager } from './manager.js';

export interface CreateSkillInput {
  slug: string;
  name: string;
  description: string;
  triggers: readonly string[];
  instructions: string;
  domain?: string;
  tools?: readonly string[];
  requires?: {
    python?: readonly string[];
    r?: readonly string[];
    commands?: readonly string[];
    connectors?: readonly string[];
    capabilities?: readonly string[];
  };
  references?: Readonly<Record<string, string>>;
  overwrite?: boolean;
}

export interface CreateSkillToolOptions {
  manager: SkillManager;
  userDir: string;
  /** 审批服务。省略时这个工具一律拒绝——见文件头。 */
  approvals?: ApprovalService;
  /** 写入成功后调用，用于广播给 UI。 */
  onCreated?: (input: { slug: string; replaced: boolean }) => void;
}

/** 校验 references 的键名。它们会变成 `references/<name>` 下的文件。 */
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function createCreateSkillTool(
  options: CreateSkillToolOptions,
): ToolDefinition<CreateSkillInput> {
  return {
    name: 'create_skill',
    description:
      '把一套已经确认可行的做法写成技能，供以后的对话复用。' +
      '**只在两种情况下用它**：用户明确要求「把这个存成技能」，' +
      '或者这次会话里摸索出了一套通用做法且用户认可了。' +
      '不要把一次性的分析过程写成技能——技能是给别的项目、别的数据也能用的方法学，' +
      '写进具体路径、具体数值或者「刚才那个文件」会让它在别处失效。' +
      '写入需要用户批准。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: '标识符。小写字母、数字与连字符，不超过 64 字符。它同时是目录名。',
        },
        name: { type: 'string', description: '人可读的名字' },
        description: {
          type: 'string',
          description:
            '一句话说清它解决什么问题。这是语义检索的主要输入，写得含糊会导致永远搜不到它。',
        },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description:
            '什么时候该用它，至少三条，写成用户会说的话（「帮我把这段 EEG 分期」）而不是技能的定义。',
        },
        instructions: {
          type: 'string',
          description:
            'SKILL.md 正文，Markdown。写清适用范围、步骤与顺序、关键参数的取舍、' +
            '**容易出错的地方**、以及怎么验证每一步做对了。',
        },
        domain: { type: 'string', description: '领域分类，用于设置页归组' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '这个技能需要哪些平台工具。只填真实存在的工具名。',
        },
        requires: {
          type: 'object',
          description: '环境依赖。python 用 import 名，commands 用可执行文件名。',
          properties: {
            python: { type: 'array', items: { type: 'string' } },
            r: { type: 'array', items: { type: 'string' } },
            commands: { type: 'array', items: { type: 'string' } },
            connectors: { type: 'array', items: { type: 'string' } },
            capabilities: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        references: {
          type: 'object',
          description:
            '按需加载的参考材料，键是文件名、值是内容。放参数表、判读标准、模板这类' +
            '不必每次都进上下文的长内容。',
          additionalProperties: { type: 'string' },
        },
        overwrite: {
          type: 'boolean',
          description:
            '覆盖同名技能。谨慎使用：覆盖内置技能会让原来那份再也不被加载，而用户从检索结果里看不出来。',
        },
      },
      required: ['slug', 'name', 'description', 'triggers', 'instructions'],
      additionalProperties: false,
    },

    parseInput(raw): CreateSkillInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      const str = (key: string, required: boolean): string | undefined => {
        const value = obj[key];
        if (value === undefined || value === null) {
          if (required) throw new Error(`${key} 必填`);
          return undefined;
        }
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`${key} 必须是非空字符串`);
        }
        return value.trim();
      };

      const strArray = (key: string): readonly string[] | undefined => {
        const value = obj[key];
        if (value === undefined || value === null) return undefined;
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new Error(`${key} 必须是字符串数组`);
        }
        return (value as string[]).map((s) => s.trim()).filter((s) => s !== '');
      };

      const triggers = strArray('triggers') ?? [];
      if (triggers.length === 0) throw new Error('triggers 至少要有一条');

      const instructions = obj.instructions;
      if (typeof instructions !== 'string' || instructions.trim() === '') {
        throw new Error('instructions 必须是非空字符串');
      }

      let references: Record<string, string> | undefined;
      if (obj.references !== undefined && obj.references !== null) {
        if (typeof obj.references !== 'object' || Array.isArray(obj.references)) {
          throw new Error('references 必须是「文件名 → 内容」的对象');
        }
        references = {};
        for (const [key, value] of Object.entries(obj.references as Record<string, unknown>)) {
          if (!REF_NAME_RE.test(key)) {
            throw new Error(
              `参考材料文件名 ${JSON.stringify(key)} 不合法：不能含路径分隔符或以点开头`,
            );
          }
          if (typeof value !== 'string') throw new Error(`参考材料 ${key} 的内容必须是字符串`);
          references[key] = value;
        }
      }

      let requires: CreateSkillInput['requires'];
      if (obj.requires !== undefined && obj.requires !== null) {
        if (typeof obj.requires !== 'object' || Array.isArray(obj.requires)) {
          throw new Error('requires 必须是对象');
        }
        const src = obj.requires as Record<string, unknown>;
        const pick = (key: string): readonly string[] | undefined => {
          const value = src[key];
          if (value === undefined || value === null) return undefined;
          if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
            throw new Error(`requires.${key} 必须是字符串数组`);
          }
          return value as string[];
        };
        requires = {
          ...(pick('python') === undefined ? {} : { python: pick('python') as string[] }),
          ...(pick('r') === undefined ? {} : { r: pick('r') as string[] }),
          ...(pick('commands') === undefined ? {} : { commands: pick('commands') as string[] }),
          ...(pick('connectors') === undefined
            ? {}
            : { connectors: pick('connectors') as string[] }),
          ...(pick('capabilities') === undefined
            ? {}
            : { capabilities: pick('capabilities') as string[] }),
        };
      }

      return {
        slug: str('slug', true) as string,
        name: str('name', true) as string,
        description: str('description', true) as string,
        triggers,
        instructions,
        ...(str('domain', false) === undefined ? {} : { domain: str('domain', false) as string }),
        ...(strArray('tools') === undefined ? {} : { tools: strArray('tools') as string[] }),
        ...(requires === undefined ? {} : { requires }),
        ...(references === undefined ? {} : { references }),
        ...(obj.overwrite === true ? { overwrite: true } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const manifest: Record<string, unknown> = {
        slug: input.slug,
        name: input.name,
        version: '1.0.0',
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        description: input.description,
        triggers: input.triggers,
        tools: input.tools ?? [],
        ...(input.requires === undefined ? {} : { requires: input.requires }),
      };

      const files: Record<string, string> = {
        'skill.json': `${JSON.stringify(manifest, null, 2)}\n`,
        'SKILL.md': `${input.instructions.trim()}\n`,
      };
      for (const [name, content] of Object.entries(input.references ?? {})) {
        files[`references/${name}`] = content;
      }

      /*
       * 先校验再申请审批。
       *
       * 反过来的话，用户批准了一个根本写不进去的技能——他花了一次注意力，换来一条
       * 校验错误。而校验是纯计算，不需要他等。
       */
      const validated = validateSkillFiles(files as SkillFileMap);
      if (!validated.ok) {
        return {
          ok: false,
          output: errorOutput(
            'SkillInvalid',
            `技能校验未通过，未写入：\n${validated.errors.map((e) => `- ${e}`).join('\n')}`,
          ),
        };
      }

      const existing = options.manager.records().find((r) => r.slug === input.slug);
      if (existing !== undefined && input.overwrite !== true) {
        return {
          ok: false,
          output: errorOutput(
            'SkillExists',
            `已存在技能 ${input.slug}（${existing.scope === 'builtin' ? '内置' : '用户自建'}：${existing.name}）。` +
              '换一个 slug，或者在确认要替换它之后传 overwrite。' +
              (existing.scope === 'builtin' ? '注意覆盖内置技能会让原来那份再也不被加载。' : ''),
          ),
        };
      }

      const contentWarnings = auditSkillContent(input.instructions);

      const approvals = options.approvals;
      if (approvals === undefined) {
        return {
          ok: false,
          output: errorOutput(
            'ApprovalUnavailable',
            '写入技能需要用户批准，而当前没有可用的审批通道，因此已拒绝。' +
              '把技能内容直接写在回答里交给用户，让他自己保存。',
          ),
        };
      }

      const decision = await approvals.request({
        kind: 'skill-write',
        title:
          existing === undefined
            ? `创建技能「${input.name}」？`
            : `用新版本覆盖技能「${input.name}」？`,
        detail: [
          `slug：${input.slug}`,
          `说明：${input.description}`,
          `触发场景：${input.triggers.join('；')}`,
          input.tools === undefined || input.tools.length === 0
            ? ''
            : `需要工具：${input.tools.join('、')}`,
          input.references === undefined || Object.keys(input.references).length === 0
            ? ''
            : `参考材料：${Object.keys(input.references).join('、')}`,
          '',
          `正文 ${String(input.instructions.length)} 字符，开头：`,
          input.instructions.slice(0, 600),
          contentWarnings.length === 0
            ? ''
            : `\n**内容检查提示**：\n${contentWarnings.map((w) => `- ${w}`).join('\n')}`,
        ]
          .filter((s) => s !== '')
          .join('\n'),
        impact:
          '技能会被写进你的技能目录，此后每一次相关对话都可能自动检索到并注入它。' +
          (existing?.scope === 'builtin'
            ? `\n**这会遮蔽内置技能 ${input.slug}**：原来那份此后不再被加载。`
            : existing === undefined
              ? ''
              : '\n它会替换你现有的同名技能。'),
        reversible: true,
        undoHint: '在设置的技能页里可以禁用或删除它。',
        // 技能写入不适合长期授权：每一份技能的内容都要单独看过
        scopeOptions: ['once'],
        payload: { slug: input.slug, action: existing === undefined ? 'create' : 'replace' },
        ...(ctx.conversationId === '' ? {} : { conversationId: ctx.conversationId }),
      });

      if (decision.state !== 'approved') {
        const why =
          decision.state === 'denied'
            ? decision.fromPriorDenial
              ? '此前已拒绝过同一个技能，没有再次打扰用户。'
              : '用户拒绝了这次写入。'
            : decision.state === 'timeout'
              ? '审批超时，按不写入处理。'
              : `审批被取消：${decision.reason}`;
        return {
          ok: false,
          output: errorOutput(
            'SkillWriteDenied',
            `${why}不要重试同一次写入。可以把技能内容直接写在回答里，或者问用户想改哪里。`,
          ),
        };
      }

      const builtinSlugs = new Set(
        options.manager
          .records()
          .filter((r) => r.scope === 'builtin')
          .map((r) => r.slug),
      );

      const result = writeUserSkill({
        userDir: options.userDir,
        files: files as SkillFileMap,
        origin: {
          kind: 'model',
          source: ctx.conversationId === '' ? null : `conversation:${ctx.conversationId}`,
          detail: '对话中由模型生成',
        },
        ...(input.overwrite === true ? { overwrite: true } : {}),
        builtinSlugs,
      });

      if (!result.ok) {
        return {
          ok: false,
          output: errorOutput('SkillWriteFailed', result.errors.join('\n')),
        };
      }

      // 让它立刻可被检索。不重扫的话这次会话里紧接着搜它会搜不到
      options.manager.reload();
      options.onCreated?.({ slug: result.slug ?? input.slug, replaced: result.replaced });

      const lines = [
        `技能 ${result.slug ?? input.slug} 已${result.replaced ? '更新' : '创建'}：${result.path ?? ''}`,
        result.shadowsBuiltin ? '注意：它遮蔽了同名的内置技能，原版此后不再加载。' : '',
        result.warnings.length === 0
          ? ''
          : `提示：\n${result.warnings.map((w) => `- ${w}`).join('\n')}`,
        '语义索引已更新，本次会话里可以直接用 search_skills 找到它。' +
          '向量层要到下次重扫技能时才跟上，在那之前靠词法检索。',
      ].filter((s) => s !== '');

      return { ok: true, output: textOutput(lines.join('\n')) };
    },
  };
}
