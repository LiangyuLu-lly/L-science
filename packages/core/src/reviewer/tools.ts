/**
 * findings 的 agent 侧工具（任务 12.8，需求 11.6、11.7）。
 *
 * 三个刻意的边界：
 *
 * 1. **agent 能自报已修，不能关闭。** `mark_finding_addressed` 只把发现推进到
 *    「待复核」。给它关闭权等于让被审查者给自己判分——一次错误的自我判断会永久
 *    掩盖问题，而那正是审查机制存在的理由。
 * 2. **agent 不能 dismiss。** 判定误报是用户的权力：模型说「这条是误报」时，它
 *    通常就是那个搞错了的一方。
 * 3. **`check_findings` 要在宣称完成前被调用。** 描述里把这句写死，因为需求 11.6
 *    的价值全在这个时机上——事后才看的清单没有拦住任何东西。
 */

import type { FindingsRepo, ReviewerTrigger } from '../repo/findings.js';
import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

export interface FindingToolOptions {
  repo: (projectId: string) => FindingsRepo;
  /** 排一次审查。返回 null 表示服务不可用。 */
  schedule?: (input: { conversationId: string; trigger: ReviewerTrigger }) => void;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

const SEVERITY_LABEL = { fail: '阻断', warn: '警告' } as const;
const CATEGORY_LABEL = {
  evidence: '证据',
  statistics: '统计',
  reproducibility: '可复现性',
  consistency: '一致性',
  integrity: '学术诚信',
  claim: '断言依据',
} as const;

function renderFindings(findings: readonly ReturnType<FindingsRepo['list']>[number][]): string {
  return findings
    .map((f) => {
      const head =
        `[${SEVERITY_LABEL[f.severity]}/${CATEGORY_LABEL[f.category]}] ${f.title}` +
        (f.status === 'claimed-fixed' ? '（已自报待复核）' : '');
      const lines = [`${head}`, `  id: ${f.id}`];
      if (f.detail !== null && f.detail !== '') lines.push(`  ${f.detail.replace(/\n/g, '\n  ')}`);
      lines.push(`  证据：${f.evidence.map((e) => `${e.kind}:${e.id}`).join('、')}`);
      if (f.addressedNote !== null) lines.push(`  上次自报：${f.addressedNote}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/* ------------------------------------------------------------------ *
 * check_findings
 * ------------------------------------------------------------------ */

export interface CheckFindingsInput {
  includeClaimedFixed?: boolean;
}

export function createCheckFindingsTool(
  options: FindingToolOptions,
): ToolDefinition<CheckFindingsInput> {
  return {
    name: 'check_findings',
    description:
      '查看独立审查者对本次会话提出的未关闭发现。' +
      '**在你宣称任务完成之前必须调用一次**：阻断级（FAIL）发现意味着结论还不成立，' +
      '而警告级（WARN）你至少要在回复里如实提到，不能装作没有。' +
      '审查者用的是与你不同厂商的模型，它看到的问题往往是你这一类模型看不见的。',
    inputSchema: {
      type: 'object',
      properties: {
        includeClaimedFixed: {
          type: 'boolean',
          description: '是否包含你此前自报已修、正在等复核的那些。默认包含。',
        },
      },
      additionalProperties: false,
    },

    parseInput(raw): CheckFindingsInput {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (obj.includeClaimedFixed !== undefined && typeof obj.includeClaimedFixed !== 'boolean') {
        throw new Error('includeClaimedFixed 必须是布尔值');
      }
      return typeof obj.includeClaimedFixed === 'boolean'
        ? { includeClaimedFixed: obj.includeClaimedFixed }
        : {};
    },

    async execute(input, ctx): Promise<ToolResult> {
      const repo = options.repo(ctx.projectId);
      const all = repo.list({ conversationId: ctx.conversationId, limit: 200 });
      const findings =
        input.includeClaimedFixed === false ? all.filter((f) => f.status === 'open') : all;

      const summary = repo.summary(ctx.conversationId);
      const runs = repo.runs(ctx.conversationId, 1);
      const latest = runs[0];

      if (findings.length === 0) {
        return {
          ok: true,
          output: textOutput(
            [
              '当前没有未关闭的发现。',
              latest === undefined
                ? '注意：本会话还没有跑过审查，因此「没有发现」不等于「已被审查过」。' +
                  '需要审查可以用 request_review。'
                : `最近一次审查：${latest.trigger}，模型 ${latest.modelId}，状态 ${latest.status}。` +
                  (latest.status === 'degraded'
                    ? `\n它是降级状态：${latest.summary ?? '原因未记录'}`
                    : ''),
            ].join('\n'),
          ),
        };
      }

      return {
        ok: true,
        output: textOutput(
          [
            `未关闭发现 ${String(findings.length)} 条：阻断 ${String(summary.blocking)}，` +
              `警告 ${String(summary.warnings)}，其中 ${String(summary.claimedFixed)} 条已自报待复核。`,
            summary.blocking > 0
              ? '**有阻断级发现，不要宣称任务完成。** 逐条处理，改完用 mark_finding_addressed 说明改了什么。'
              : '没有阻断级发现。警告级的请在回复里如实提及，或处理掉。',
            '',
            renderFindings(findings),
          ].join('\n'),
        ),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * mark_finding_addressed
 * ------------------------------------------------------------------ */

export interface MarkAddressedInput {
  findingId: string;
  note: string;
}

export function createMarkFindingAddressedTool(
  options: FindingToolOptions,
): ToolDefinition<MarkAddressedInput> {
  return {
    name: 'mark_finding_addressed',
    description:
      '声明你已经处理了某条发现。它会被标为「已自报待复核」，由下一轮审查确认或打回。' +
      '**这不等于关闭它**——关闭权在审查者，因为自己给自己判分会让一次错误的判断永久掩盖问题。' +
      '如果你认为某条发现是误报，不要用这个工具，在回复里向用户说明理由，由他决定。',
    inputSchema: {
      type: 'object',
      properties: {
        findingId: { type: 'string', description: '发现的 id，从 check_findings 的输出里取' },
        note: {
          type: 'string',
          description:
            '具体改了什么。要写到下一轮审查能照着核对的程度：' +
            '「已修复」这种话无法核对，会被直接打回。',
        },
      },
      required: ['findingId', 'note'],
      additionalProperties: false,
    },

    parseInput(raw): MarkAddressedInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      if (typeof obj.findingId !== 'string' || obj.findingId.trim() === '') {
        throw new Error('findingId 必须是非空字符串');
      }
      if (typeof obj.note !== 'string' || obj.note.trim() === '') {
        throw new Error('note 必须是非空字符串：不说明改了什么，下一轮审查无从核对');
      }
      return { findingId: obj.findingId.trim(), note: obj.note.trim() };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const repo = options.repo(ctx.projectId);
      const finding = repo.get(input.findingId);

      if (finding === null) {
        return {
          ok: false,
          output: errorOutput(
            'FindingNotFound',
            `没有这条发现：${input.findingId}。先用 check_findings 拿到真实的 id。`,
          ),
        };
      }
      if (finding.conversationId !== ctx.conversationId) {
        // 跨会话改发现会让审计变得无从解释
        return {
          ok: false,
          output: errorOutput(
            'FindingNotInConversation',
            `发现 ${input.findingId} 属于别的会话，不能在这里标记。`,
          ),
        };
      }

      if (!repo.claimFixed(input.findingId, input.note)) {
        return {
          ok: false,
          output: errorOutput(
            'FindingNotOpen',
            `发现 ${input.findingId} 当前状态是 ${finding.status}，不能再次自报。` +
              (finding.status === 'claimed-fixed'
                ? '它已经在等复核了。'
                : '它已经关闭或被判为误报。'),
          ),
        };
      }

      return {
        ok: true,
        output: textOutput(
          `已标记为待复核：${finding.title}\n` +
            '下一轮审查会核对你的说明。如果核对不通过它会被打回 open，' +
            '因此说明要与实际改动一致。',
        ),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * request_review
 * ------------------------------------------------------------------ */

export function createRequestReviewTool(options: FindingToolOptions): ToolDefinition<null> {
  return {
    name: 'request_review',
    description:
      '请审查者立刻过一遍当前的结论与产物。审查在后台跑，不阻塞你继续工作，' +
      '结果稍后用 check_findings 查。' +
      '适合在做完一段有结论的分析之后、或准备交付之前主动调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    parseInput(): null {
      return null;
    },

    async execute(_input, ctx): Promise<ToolResult> {
      if (options.schedule === undefined) {
        return {
          ok: false,
          output: errorOutput(
            'ReviewerUnavailable',
            '审查服务未启用。确定性检查仍会在制品保存时运行，但模型层的审查不可用。',
          ),
        };
      }

      options.schedule({ conversationId: ctx.conversationId, trigger: 'user-request' });
      return {
        ok: true,
        output: textOutput(
          '已排入审查。它在后台跑，你可以继续工作；' +
            '过一会儿用 check_findings 看结果。如果此刻已有审查在跑，本次会与它合并。',
        ),
      };
    },
  };
}
