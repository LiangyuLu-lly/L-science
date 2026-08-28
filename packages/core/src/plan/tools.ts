/**
 * `generate_plan` 与 `plan_status` 工具（任务 12.5，需求 10.1-10.4）。
 *
 * 两个刻意的设计：
 *
 * 1. **生成即校验，校验不过就退回给模型改**，不落库成一个做不到的计划。工具的
 *    返回值里带着具体的修正建议，模型可以直接改完再调一次。落一个坏计划进库，
 *    再让用户去发现「这一步绑的技能不存在」，是把机器能做的检查推给了人。
 * 2. **生成不等于开始执行。** 计划状态是 `draft`，要用户批准（需求 10.4）。
 *    模型不能自己批准自己的计划——那样「可审阅」就只是个说法。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { PlanRepo } from '../repo/plans.js';
import { parsePlanSpec, PlanSpecError, planBatches, type PlanSpec } from './spec.js';
import { describeIssues, planExecutable, validatePlan, type PlanIssue } from './validate.js';

export interface PlanToolOptions {
  repo: (conversationId: string) => PlanRepo;
  /** 当前已启用的技能 slug。 */
  availableSkills: () => ReadonlySet<string>;
  /** 已登记但被禁用的技能。 */
  disabledSkills: () => ReadonlySet<string>;
  /** 当前已注册的工具名。 */
  availableTools: () => ReadonlySet<string>;
  /** 依赖未满足的技能 → 缺失说明。 */
  skillsWithMissingRequirements: () => ReadonlyMap<string, string>;
  /** 计划创建后推事件给 UI。 */
  onPlanCreated?: (planId: string, conversationId: string) => void;
}

/** 把计划渲染成给模型与用户看的文本。 */
export function renderPlan(spec: PlanSpec): string {
  const lines: string[] = [`目标：${spec.goal}`];
  const batches = planBatches(spec);

  for (const phase of spec.phases) {
    lines.push('');
    lines.push(`## 阶段 ${String(phase.phase)}：${phase.title}`);

    const steps = spec.steps
      .filter((s) => s.phase === phase.phase)
      .sort((a, b) => a.ref.localeCompare(b.ref));

    for (const step of steps) {
      const tags: string[] = [];
      if (step.skillSlug !== null) tags.push(`技能 ${step.skillSlug}`);
      if (step.tools.length > 0) tags.push(`工具 ${step.tools.join('/')}`);
      if (step.retrieval) tags.push('取证步骤');
      if (step.delegation !== null) {
        tags.push(step.delegation.parallel ? '可并行委派' : '委派');
        if (!step.delegation.blocking) tags.push('非阻塞');
      }

      lines.push(
        `- **${step.ref}** ${step.title}${tags.length > 0 ? `　[${tags.join('，')}]` : ''}`,
      );
      lines.push(`  ${step.description}`);
      if (step.dependsOn.length > 0) lines.push(`  依赖：${step.dependsOn.join('、')}`);
      if (step.produces.length > 0) lines.push(`  产出：${step.produces.join('、')}`);
    }
  }

  if (batches !== null && batches.length > 0) {
    lines.push('');
    lines.push(
      `执行批次（同一批次内无依赖，可并行）：${batches
        .map((b, i) => `${String(i + 1)}) ${b.map((s) => s.ref).join(' ')}`)
        .join('　')}`,
    );
  }

  return lines.join('\n');
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: '用户的研究目标。用你确认过的表述，不要照抄含糊的原话。' },
    phases: {
      type: 'array',
      description: '阶段清单。可省略，省略时按步骤里出现的阶段号自动补出来。',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'number', description: '阶段号，从 1 开始' },
          title: { type: 'string', description: '阶段标题' },
        },
        required: ['phase', 'title'],
        additionalProperties: false,
      },
    },
    steps: {
      type: 'array',
      description: '步骤清单。至少一步。',
      items: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: '计划内唯一的短引用名（如 s1、load-data），供 dependsOn 使用',
          },
          phase: { type: 'number', description: '所属阶段号，从 1 开始' },
          title: { type: 'string', description: '一行标题' },
          description: {
            type: 'string',
            description:
              '这一步具体做什么。写到别人能照着执行的程度。**不要在这里写来自记忆的领域阈值或参数**——' +
              '有权威来源的数值应当先用一个 retrieval 步骤查出来。',
          },
          skillSlug: {
            type: 'string',
            description:
              '绑定的技能 slug。**必须是 search_skills 确认存在的**，不要凭印象写。' +
              '这一步不需要既定方法时留空。',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '这一步会用到的工具名。必须是当前实际可用的工具。',
          },
          produces: {
            type: 'array',
            items: { type: 'string' },
            description:
              '这一步产出什么，写具体的文件名或制品说明。步骤之间只经文件或制品交接，' +
              '写不出产物通常说明这一步实际什么都没交出去。',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖的前置步骤 ref',
          },
          retrieval: {
            type: 'boolean',
            description:
              '这一步是否为「查出某个事实或数值」。标了它，依赖它的步骤里出现数值就不再被判为硬编码。',
          },
          delegation: {
            type: 'object',
            description: '委派给子 agent 执行。省略则由主 agent 顺序执行。',
            properties: {
              parallel: { type: 'boolean', description: '是否可与同阶段其他步骤并行' },
              blocking: {
                type: 'boolean',
                description:
                  '是否阻塞式。默认 true。阻塞式的子 agent 会在用户中断时被一并取消；' +
                  '非阻塞式不受影响，因此转后台必须是显式选择。',
              },
              maxConcurrent: { type: 'number', description: '并发上限' },
            },
            additionalProperties: false,
          },
        },
        required: ['ref', 'phase', 'title', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['goal', 'steps'],
  additionalProperties: false,
} as const;

export function createGeneratePlanTool(options: PlanToolOptions): ToolDefinition<unknown> {
  return {
    name: 'generate_plan',
    description:
      '为一个较大的研究目标生成结构化执行计划，供用户审阅后执行。' +
      '**先用 search_skills 确认能力覆盖再生成计划**——每一步绑定的技能与工具都会被校验，' +
      '绑到不存在的能力上会被退回。' +
      '生成的计划处于草稿状态，需要用户批准才会执行；你不能自己批准。' +
      '目标很小、一两步就能做完时不要用它，直接做。',
    inputSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,

    parseInput(raw): unknown {
      // 结构校验在 execute 里做，这样错误信息能与语义校验一起返回给模型
      return raw;
    },

    async execute(input, ctx): Promise<ToolResult> {
      let spec: PlanSpec;
      try {
        spec = parsePlanSpec(input);
      } catch (err) {
        return {
          ok: false,
          output: errorOutput(
            'PlanSpecInvalid',
            err instanceof PlanSpecError
              ? `计划结构不合法：${err.message}`
              : `计划解析失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      }

      const issues: readonly PlanIssue[] = validatePlan({
        spec,
        availableSkills: options.availableSkills(),
        disabledSkills: options.disabledSkills(),
        availableTools: options.availableTools(),
        skillsWithMissingRequirements: options.skillsWithMissingRequirements(),
      });

      if (!planExecutable(issues)) {
        // 不落库。一个绑到不存在能力上的计划落库之后，用户批准的是一个做不到的承诺
        return {
          ok: false,
          output: errorOutput(
            'PlanNotExecutable',
            `${describeIssues(issues)}\n\n改完之后重新调用 generate_plan。`,
          ),
        };
      }

      const repo = options.repo(ctx.conversationId);

      /*
       * 已有活跃计划时先关掉它。
       *
       * 一个会话同时有两个活跃计划是无意义的状态——执行器不知道该推进哪个，
       * UI 也不知道该显示哪个。旧计划标为 rejected 而不是删除：它是一段真实发生过
       * 的推理过程，删掉之后「为什么换了方案」就答不出来了。
       */
      const active = repo.activeOf(ctx.conversationId);
      if (active !== null) repo.setStatus(active.id, 'rejected');

      const plan = repo.create({ conversationId: ctx.conversationId, spec });
      options.onPlanCreated?.(plan.id, ctx.conversationId);

      const parts = [
        `已生成计划（id ${plan.id}，状态：草稿，等待用户批准）。`,
        active === null ? '' : `此前的计划 ${active.id} 已作废。`,
        '',
        renderPlan(spec),
      ].filter((s) => s !== '');

      if (issues.length > 0) {
        parts.push('', describeIssues(issues));
      }
      parts.push(
        '',
        '计划已展示给用户。等他批准后再开始执行；他可能会要求修改，那时用 generate_plan 重新生成一版。',
      );

      return { ok: true, output: textOutput(parts.join('\n')) };
    },
  };
}

export interface PlanStatusInput {
  planId?: string;
}

export function createPlanStatusTool(options: PlanToolOptions): ToolDefinition<PlanStatusInput> {
  return {
    name: 'plan_status',
    description:
      '查询当前计划的状态与各步进度。宣称「计划已完成」之前先用它确认——' +
      '没有跑完的步骤与失败的步骤都会在这里列出来。',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: '计划 id。省略时取当前会话的活跃计划。' },
      },
      additionalProperties: false,
    },

    parseInput(raw): PlanStatusInput {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (obj.planId !== undefined && typeof obj.planId !== 'string') {
        throw new Error('planId 必须是字符串');
      }
      return typeof obj.planId === 'string' ? { planId: obj.planId } : {};
    },

    async execute(input, ctx): Promise<ToolResult> {
      const repo = options.repo(ctx.conversationId);
      const plan =
        input.planId === undefined ? repo.activeOf(ctx.conversationId) : repo.get(input.planId);

      if (plan === null) {
        return {
          ok: true,
          output: textOutput('当前会话没有活跃计划。目标较大时可以用 generate_plan 生成一个。'),
        };
      }

      const steps = repo.steps(plan.id);
      const progress = repo.progress(plan.id);

      const lines = [
        `计划 ${plan.id}　状态：${plan.status}`,
        `目标：${plan.spec.goal}`,
        `进度：完成 ${String(progress.byStatus.done)} / ${String(progress.total)}` +
          `（进行中 ${String(progress.byStatus.running)}，失败 ${String(progress.byStatus.failed)}，` +
          `跳过 ${String(progress.byStatus.skipped)}）`,
        progress.currentPhase === null
          ? '全部步骤已终结。'
          : `当前阶段：${String(progress.currentPhase)}`,
        '',
      ];

      for (const step of steps) {
        const mark =
          step.status === 'done'
            ? '✓'
            : step.status === 'failed'
              ? '✗'
              : step.status === 'running'
                ? '▶'
                : step.status === 'skipped'
                  ? '－'
                  : '·';
        lines.push(
          `${mark} [阶段 ${String(step.phase)}] ${step.ref} ${step.title ?? ''}` +
            (step.resultRef === null ? '' : `　产出：${step.resultRef}`),
        );
      }

      if (progress.byStatus.failed > 0) {
        lines.push(
          '',
          '有步骤失败。不要跳过它们直接宣称完成——失败的步骤意味着它的产物不存在，' +
            '而依赖它的结论没有依据。',
        );
      }

      return { ok: true, output: textOutput(lines.join('\n')) };
    },
  };
}
