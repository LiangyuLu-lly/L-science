/**
 * `compile_manuscript` 工具（任务 13.6，需求 13.5-13.8）。
 *
 * 工具描述里写死了两条：
 *
 * 1. **编译只检查不改稿**。字数超了、章节顺序不符、图编号有缺口——全部报告，不动手改。
 *    不写清这一点，模型会以为「编译成功」意味着稿子已经符合要求了，然后告诉用户
 *    可以投了。
 * 2. **双盲处理只作用于结构化元数据**（需求 13.8）。这句话必须出现在模型看到的
 *    描述里，否则它会把「已生成双盲版」转述成「已完成匿名化」——而后者是一个
 *    我们无法保证的断言。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ManuscriptCompiler } from './compile-service.js';
import { BUILTIN_JOURNAL_PROFILES } from './journals.js';

export interface CompileToolOptions {
  compiler: () => ManuscriptCompiler;
  onCompiled?: (info: {
    conversationId: string;
    manuscriptId: string;
    errors: number;
    warnings: number;
    leaks: number;
  }) => void;
}

export interface CompileToolInput {
  action: 'compile' | 'parse' | 'profiles' | 'history';
  markdown?: string;
  sourceVersionId?: string;
  manuscriptId?: string;
  targetJournal?: string;
  blinded?: boolean;
  both?: boolean;
  stem?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['compile', 'parse', 'profiles', 'history'],
      description:
        'compile：编译为目标期刊格式（可同时生成双盲送审版）。' +
        'parse：只解析手稿元数据与结构，不编译——用于先确认作者、机构、图表都解析对了。' +
        'profiles：列出内置的期刊格式档案。' +
        'history：看某份手稿的编译历史与问题数变化趋势。',
    },
    markdown: {
      type: 'string',
      description:
        '手稿原文（Markdown + front matter）。与 sourceVersionId 二选一。' +
        'front matter 里的 authors / affiliations / acknowledgements / funding 是双盲处理的依据——' +
        '没有它们，双盲版无从下手。',
    },
    sourceVersionId: {
      type: 'string',
      description:
        '手稿制品的版本 id（save_artifacts 的返回值）。比把整篇稿子贴进参数里省上下文，' +
        '而且编译产物会与源稿建立血缘。',
    },
    manuscriptId: {
      type: 'string',
      description: '已有手稿记录的 id（ms_…）。action=history 时必填。',
    },
    targetJournal: {
      type: 'string',
      description:
        '目标期刊名。省略时用 front matter 里的 journal 字段。匹配不到内置档案时用通用档案，' +
        '并在报告里说明——不会假装匹配上了。',
    },
    blinded: {
      type: 'boolean',
      description:
        '生成双盲送审版。省略时按档案的默认（NeurIPS/ICML/APA 类默认双盲）。' +
        '**双盲处理只移除 front matter 里的结构化字段，正文一个字都不改。**',
    },
    both: {
      type: 'boolean',
      description: '同时生成正式版与双盲版。投稿时两份都要用。',
    },
    stem: { type: 'string', description: '输出文件名主干。默认按标题生成。' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

function parseInput(raw: unknown): CompileToolInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
  const obj = raw as Record<string, unknown>;

  const action = obj.action;
  if (action !== 'compile' && action !== 'parse' && action !== 'profiles' && action !== 'history') {
    throw new Error(`action 必须是 compile/parse/profiles/history 之一，收到 ${String(action)}`);
  }

  const text = (value: unknown, name: string, max: number): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.length > max) throw new Error(`${name} 超过 ${String(max)} 字符上限`);
    return trimmed;
  };

  return {
    action,
    ...(text(obj.markdown, 'markdown', 600_000) === undefined
      ? {}
      : { markdown: text(obj.markdown, 'markdown', 600_000) as string }),
    ...(text(obj.sourceVersionId, 'sourceVersionId', 200) === undefined
      ? {}
      : { sourceVersionId: text(obj.sourceVersionId, 'sourceVersionId', 200) as string }),
    ...(text(obj.manuscriptId, 'manuscriptId', 200) === undefined
      ? {}
      : { manuscriptId: text(obj.manuscriptId, 'manuscriptId', 200) as string }),
    ...(text(obj.targetJournal, 'targetJournal', 200) === undefined
      ? {}
      : { targetJournal: text(obj.targetJournal, 'targetJournal', 200) as string }),
    ...(text(obj.stem, 'stem', 80) === undefined
      ? {}
      : { stem: text(obj.stem, 'stem', 80) as string }),
    ...(obj.blinded === undefined ? {} : { blinded: obj.blinded === true }),
    ...(obj.both === undefined ? {} : { both: obj.both === true }),
  };
}

export function createCompileManuscriptTool(
  options: CompileToolOptions,
): ToolDefinition<CompileToolInput> {
  return {
    name: 'compile_manuscript',
    description:
      '把结构化手稿（Markdown + front matter）编译为目标期刊格式，并可生成双盲送审版。\n' +
      '处理引用样式（数字/作者年份，按正文出现顺序或字母序）、字数限制、图表编号规范。\n' +
      '**只检查不改稿**：字数超了、章节顺序不符、图编号有缺口都只报告，不动手改——' +
      '自动删字会毁掉论证，自动重排章节会打乱交叉引用。唯一自动做的是引用重编号。\n' +
      '**双盲版只移除 front matter 里的结构化字段（作者、机构、致谢、基金号），' +
      '正文一个字都不改。** 正文里的隐式身份线索只报告不处理，' +
      '因此不要把「已生成双盲版」说成「已完成匿名化」。\n' +
      '会检出自引造成的身份泄露：正文有「我们此前的工作」这类措辞、且所引文献的作者' +
      '与本文作者有交集。',
    inputSchema: SCHEMA as unknown as Record<string, unknown>,
    parseInput,
    execute: async (input, ctx): Promise<ToolResult> => {
      const compiler = options.compiler();

      switch (input.action) {
        case 'profiles': {
          const lines = ['内置期刊格式档案：', ''];
          for (const profile of BUILTIN_JOURNAL_PROFILES) {
            const limits: string[] = [];
            if (profile.limits.abstractWords !== null) {
              limits.push(`摘要 ${String(profile.limits.abstractWords)}`);
            }
            if (profile.limits.bodyWords !== null) {
              limits.push(`正文 ${String(profile.limits.bodyWords)}`);
            }
            if (profile.limits.references !== null) {
              limits.push(`文献 ${String(profile.limits.references)}`);
            }
            lines.push(
              `- ${profile.id}　${profile.name}` +
                `　引用样式 ${profile.citationStyle}` +
                (limits.length === 0 ? '' : `　${limits.join('/')}`) +
                (profile.doubleBlindByDefault ? '　默认双盲' : ''),
            );
            lines.push(`    别名：${profile.aliases.join('、')}`);
          }
          lines.push('');
          lines.push(
            '这些数值来自各刊作者指南的近似值，会随期刊改版而过期。' +
              '编译报告里的字数提示是「按 <档案> 档案的上限」，不是对该刊当前规则的断言。' +
              '改稿前请核对官方要求。',
          );
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'parse': {
          const parsed = compiler.parse({
            ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
            ...(input.sourceVersionId === undefined
              ? {}
              : { sourceVersionId: input.sourceVersionId }),
          });
          if (!parsed.ok || parsed.doc === null) {
            return { ok: false, output: errorOutput('ParseFailed', parsed.reason ?? '解析失败') };
          }

          const doc = parsed.doc;
          const lines = [
            `标题：${doc.meta.title ?? '（未给）'}`,
            `目标期刊：${doc.meta.targetJournal ?? '（未给）'}`,
            `作者：${
              doc.meta.identifying.authors.length === 0
                ? '（未给——双盲处理与自引检测都需要它）'
                : doc.meta.identifying.authors
                    .map((a) => `${a.name}${a.corresponding ? '（通讯）' : ''}`)
                    .join('、')
            }`,
            `机构：${doc.meta.identifying.affiliations.length === 0 ? '（未给）' : String(doc.meta.identifying.affiliations.length) + ' 条'}`,
            `基金：${doc.meta.identifying.funding.length === 0 ? '（未给）' : doc.meta.identifying.funding.join('；')}`,
            `致谢：${doc.meta.identifying.acknowledgements === null ? '（未给）' : '有'}`,
            '',
            `章节 ${String(doc.sections.length)} 个：${doc.sections
              .filter((s) => s.level <= 2)
              .map((s) => s.title)
              .join(' → ')}`,
            `图 ${String(doc.figures.length)}、表 ${String(doc.tables.length)}、` +
              `引用标记 ${String(doc.citations.length)} 处（${String(doc.counts.distinctCitations)} 个不同键）`,
            `字数：标题 ${String(doc.counts.title)}、摘要 ${String(doc.counts.abstract)}、正文 ${String(doc.counts.body)}`,
          ];

          if (doc.warnings.length > 0) {
            lines.push('', '解析告警：');
            for (const warning of doc.warnings) lines.push(`  · ${warning.message}`);
          }

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'history': {
          if (input.manuscriptId === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingManuscriptId', 'action=history 需要 manuscriptId。'),
            };
          }
          const manuscript = compiler.repo.get(input.manuscriptId);
          if (manuscript === null) {
            return {
              ok: false,
              output: errorOutput('ManuscriptNotFound', `手稿不存在：${input.manuscriptId}`),
            };
          }

          const runs = compiler.repo.compileRuns(input.manuscriptId, 20);
          const trend = compiler.repo.trend(input.manuscriptId, 10);

          const lines = [
            `手稿 ${manuscript.id}　${manuscript.title ?? '（无标题）'}`,
            `目标期刊 ${manuscript.targetJournal ?? '（未定）'}　档案 ${manuscript.profileId ?? '（未定）'}　状态 ${manuscript.status}`,
            '',
            `编译过 ${String(runs.length)} 次：`,
          ];
          for (const run of runs.slice(0, 10)) {
            lines.push(
              `- ${new Date(run.createdAt).toISOString()}　${run.blinded ? '双盲版' : '正式版'}　` +
                `${String(run.errors)} 必须处理 / ${String(run.warnings)} 建议处理` +
                (run.selfCitationLeaks === 0 ? '' : ` / 自引泄露 ${String(run.selfCitationLeaks)}`),
            );
          }

          if (trend.length >= 2) {
            const first = trend[0] as (typeof trend)[number];
            const last = trend[trend.length - 1] as (typeof trend)[number];
            const delta = last.errors + last.warnings - (first.errors + first.warnings);
            lines.push('');
            lines.push(
              /*
               * 趋势比单次计数有用得多：12 个问题可能是从 40 降下来的，也可能是从
               * 3 涨上去的，而两者该做的事完全不同。
               */
              delta < 0
                ? `趋势：问题数从 ${String(first.errors + first.warnings)} 降到 ${String(last.errors + last.warnings)}，在收敛。`
                : delta > 0
                  ? `趋势：问题数从 ${String(first.errors + first.warnings)} 涨到 ${String(last.errors + last.warnings)}，在发散——改稿引入了新问题。`
                  : `趋势：问题数没有变化（${String(last.errors + last.warnings)}）。`,
            );
          }

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'compile': {
          const outcome = await compiler.compile({
            ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
            ...(input.sourceVersionId === undefined
              ? {}
              : { sourceVersionId: input.sourceVersionId }),
            ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
            ...(input.targetJournal === undefined ? {} : { targetJournal: input.targetJournal }),
            ...(input.blinded === undefined ? {} : { blinded: input.blinded }),
            ...(input.both === undefined ? {} : { both: input.both }),
            ...(input.stem === undefined ? {} : { stem: input.stem }),
            conversationId: ctx.conversationId,
            ...(ctx.modelId === undefined ? {} : { modelId: ctx.modelId }),
          });

          if (!outcome.ok || outcome.manuscript === null) {
            return {
              ok: false,
              output: errorOutput('CompileFailed', outcome.reason ?? '编译失败'),
            };
          }

          const lines = [`手稿记录：${outcome.manuscript.id}`, ''];
          let totalErrors = 0;
          let totalWarnings = 0;
          let totalLeaks = 0;

          for (const output of outcome.outputs) {
            const errors = output.result.issues.filter((i) => i.severity === 'error').length;
            const warnings = output.result.issues.filter((i) => i.severity === 'warn').length;
            totalErrors += errors;
            totalWarnings += warnings;
            totalLeaks = Math.max(totalLeaks, output.result.selfCitationLeaks.length);

            lines.push(`## ${output.blinded ? '双盲送审版' : '正式版'}`);
            lines.push('');
            lines.push(`文件：${output.filename}`);
            lines.push(`制品：${output.artifactId}　路径占位符 {{artifact:${output.versionId}}}`);
            if (output.bibVersionId !== null) {
              lines.push(`参考文献：{{artifact:${output.bibVersionId}}}`);
            }
            lines.push('');
            lines.push(output.result.report);
            lines.push('');
          }

          /*
           * 编译成功不等于可以投稿。
           *
           * 这句话必须在输出里，否则模型会把「编译成功」转述成「稿子已经符合要求」。
           */
          lines.push('---');
          lines.push(
            totalErrors > 0
              ? `**还有 ${String(totalErrors)} 项必须处理的问题。** 编译产出了文件，` +
                  '但这些问题会让编辑部退稿。逐项改完再重新编译。'
              : totalWarnings > 0
                ? `编译没有阻断性问题，${String(totalWarnings)} 项建议处理。` + '投稿前过一遍它们。'
                : '编译没有发现问题。',
          );
          lines.push(
            '编译前已触发一次审查（需求 11.3）。用 check_findings 看有没有新的' +
              '无证据断言或编造引文——那些不在编译报告里，但它们比格式问题严重。',
          );

          options.onCompiled?.({
            conversationId: ctx.conversationId,
            manuscriptId: outcome.manuscript.id,
            errors: totalErrors,
            warnings: totalWarnings,
            leaks: totalLeaks,
          });

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        default:
          return {
            ok: false,
            output: errorOutput('UnknownAction', `未知 action：${String(input.action)}`),
          };
      }
    },
  };
}
