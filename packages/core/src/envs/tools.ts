/**
 * 环境与包管理的模型面工具（任务 14.4，需求 15.1-15.6）。
 *
 * 一个工具带 action 判别，理由与 `manage_references` 相同：环境操作之间有强顺序依赖
 * （看有哪些环境 → 看包清单 → 算安装计划 → 装），拆成六个工具之后模型要在六份描述里
 * 推断这个顺序。
 *
 * 两处刻意的边界：
 *
 * - **不暴露 `register`**。登记用户的 venv 需要一个只有用户知道的绝对路径，模型面对
 *   这个字段会填出看起来合理的值，而失败要等探测时才出现。
 * - **不暴露 `setDefault`**。切换默认环境影响此后**所有会话**的新内核，那是全局配置，
 *   不该由一次对话里的判断改掉。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

import { renderConflicts } from './conflicts.js';
import type { EnvService } from './service.js';
import { restartNotice } from './installers.js';
import {
  ENV_STATUS_LABEL,
  PACKAGE_SOURCE_LABEL,
  type InstallerFamily,
  type PackageSource,
} from './types.js';

export interface EnvToolOptions {
  service: () => EnvService;
  onChanged?: (info: { action: string; envId: string | null }) => void;
}

export type EnvAction =
  'list' | 'sync' | 'probe' | 'packages' | 'plan' | 'install' | 'uninstall' | 'create' | 'mixups';

export interface EnvToolInput {
  action: EnvAction;
  env?: string;
  specs?: readonly string[];
  family?: InstallerFamily;
  channel?: string;
  name?: string;
  language?: 'python' | 'r';
  pythonVersion?: string;
  rVersion?: string;
  query?: string;
  source?: PackageSource;
  limit?: number;
  force?: boolean;
}

const ACTIONS: readonly EnvAction[] = [
  'list',
  'sync',
  'probe',
  'packages',
  'plan',
  'install',
  'uninstall',
  'create',
  'mixups',
];

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description:
        'list：列出已登记的环境（含状态、包数量与来源分布）。' +
        'sync：把本机的 conda 环境同步进登记表。probe：重新探测一个环境。' +
        'packages：看一个环境里装了什么，可按来源筛选。' +
        'plan：算一次安装计划但**不执行**——它会告出用哪个安装器、要不要重启、有没有' +
        'conda/pip 混装冲突。install / uninstall：装或卸。' +
        'create：新建一个托管 conda 环境（后台跑）。' +
        'mixups：查这个环境里**已经存在**的 conda/pip 混装。\n' +
        '装包之前先 plan：混装冲突的后果是算出错的数值而不报错，而 plan 是唯一能在' +
        '动手之前看到它的地方。',
    },
    env: { type: 'string', description: '环境名或 id。名字优先（list 里显示的就是名字）。' },
    specs: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 100,
      description:
        '包名，可带版本约束（numpy、numpy>=1.26、numpy==1.26.4）。' +
        '不接受 URL、本地路径与 git 地址，也不接受以 - 开头的安装器选项。',
    },
    family: {
      type: 'string',
      enum: ['pypi', 'conda', 'cran'],
      description:
        '强制用哪个来源。省略时由环境类型与包性质决定：conda 环境里，' +
        '对原生库敏感的包（numpy、torch、gdal 这类）默认走 conda，其余走 PyPI。' +
        '**不要随手指定它**——指定错了正是造成混装的方式。',
    },
    channel: { type: 'string', description: 'conda 频道。省略时用 conda-forge。' },
    name: { type: 'string', description: 'action=create 时的新环境名。' },
    language: {
      type: 'string',
      enum: ['python', 'r'],
      description:
        'action=create 时新环境的语言。R 环境与 Python 环境完全分开（需求 15.7）：' +
        '在 R 环境里装 R 包不会影响 Python 内核。',
    },
    pythonVersion: {
      type: 'string',
      description: 'action=create 且 language=python 时的版本，默认 3.13。',
    },
    rVersion: { type: 'string', description: 'action=create 且 language=r 时的 R 版本。' },
    query: { type: 'string', description: 'action=packages 时按包名做子串筛选。' },
    source: {
      type: 'string',
      enum: ['conda', 'pypi', 'cran', 'unknown'],
      description:
        'action=packages 时按来源筛选。查「这个环境里有哪些包是 pip 装的」是排查导入' +
        '错误时第一个要问的。',
    },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回条数上限。' },
    force: {
      type: 'boolean',
      description:
        'action=install 时明知有混装风险仍要继续。**只在用户明确要求之后用**：' +
        '混装最坏的后果是算出错的数值而完全不报错。',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

function str(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function int(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${name} 必须是整数`);
}

export function createManageEnvironmentsTool(
  options: EnvToolOptions,
): ToolDefinition<EnvToolInput> {
  return {
    name: 'manage_environments',
    description:
      '环境与包管理：列出/创建/探测环境、看包清单、装卸包。\n' +
      '安装器按「同家族里最快的可用」选（uv > pip；micromamba > mamba > conda），' +
      '不可用时回退（需求 15.3）。\n' +
      '**conda 与 pip 不会被允许混装同一个科学计算依赖**（需求 15.4）：两份编译好的 ' +
      'BLAS/HDF5/CUDA 同时进一个进程时，最坏的结果不是报错，是算出错的数值而完全不报错。\n' +
      '装卸包如果需要重启内核，输出里会明确告知——内存里的变量会丢，工作区文件不受影响。\n' +
      '创建环境与装包是后台任务，不会占住这次回复；结果会自动回到对话里。\n' +
      '登记用户自己的 venv 与切换默认环境不在这里：前者需要只有用户知道的路径，' +
      '后者影响所有会话。',
    inputSchema: SCHEMA as unknown as Record<string, unknown>,

    parseInput: (raw): EnvToolInput => {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      const action = obj.action;
      if (typeof action !== 'string' || !ACTIONS.includes(action as EnvAction)) {
        throw new Error(`action 必须是 ${ACTIONS.join('/')} 之一，收到 ${String(action)}`);
      }

      const specs: string[] = [];
      if (Array.isArray(obj.specs)) {
        for (const entry of obj.specs) {
          if (typeof entry !== 'string') throw new Error('specs 的每一项必须是字符串');
          const trimmed = entry.trim();
          if (trimmed !== '') specs.push(trimmed);
        }
      } else if (typeof obj.specs === 'string') {
        // 模型经常把单个包名直接写成字符串。接受它比报错更有用
        const trimmed = obj.specs.trim();
        if (trimmed !== '') specs.push(trimmed);
      }

      const family = obj.family;
      if (family !== undefined && family !== 'pypi' && family !== 'conda' && family !== 'cran') {
        throw new Error(`family 必须是 pypi/conda/cran 之一，收到 ${String(family)}`);
      }
      const language = obj.language;
      if (language !== undefined && language !== 'python' && language !== 'r') {
        throw new Error(`language 必须是 python 或 r，收到 ${String(language)}`);
      }
      const source = obj.source;
      if (
        source !== undefined &&
        !['conda', 'pypi', 'cran', 'unknown'].includes(source as string)
      ) {
        throw new Error(`source 必须是 conda/pypi/cran/unknown 之一`);
      }

      return {
        action: action as EnvAction,
        ...(str(obj.env, 'env') === undefined ? {} : { env: str(obj.env, 'env') as string }),
        ...(specs.length === 0 ? {} : { specs }),
        ...(family === undefined ? {} : { family: family as InstallerFamily }),
        ...(str(obj.channel, 'channel') === undefined
          ? {}
          : { channel: str(obj.channel, 'channel') as string }),
        ...(str(obj.name, 'name') === undefined ? {} : { name: str(obj.name, 'name') as string }),
        ...(language === undefined ? {} : { language: language as 'python' | 'r' }),
        ...(str(obj.pythonVersion, 'pythonVersion') === undefined
          ? {}
          : { pythonVersion: str(obj.pythonVersion, 'pythonVersion') as string }),
        ...(str(obj.rVersion, 'rVersion') === undefined
          ? {}
          : { rVersion: str(obj.rVersion, 'rVersion') as string }),
        ...(str(obj.query, 'query') === undefined
          ? {}
          : { query: str(obj.query, 'query') as string }),
        ...(source === undefined ? {} : { source: source as PackageSource }),
        ...(int(obj.limit, 'limit') === undefined
          ? {}
          : { limit: int(obj.limit, 'limit') as number }),
        ...(obj.force === undefined ? {} : { force: obj.force === true }),
      };
    },

    execute: async (input, ctx): Promise<ToolResult> => {
      const service = options.service();

      const resolveEnv = (
        ref: string | undefined,
      ): { ok: true; id: string; name: string } | { ok: false; output: ToolResult } => {
        if (ref === undefined) {
          return {
            ok: false,
            output: {
              ok: false,
              output: errorOutput('MissingEnv', `action=${input.action} 需要 env`),
            },
          };
        }
        const env = service.repo.resolve(ref);
        if (env === null) {
          return {
            ok: false,
            output: {
              ok: false,
              output: errorOutput(
                'EnvNotFound',
                `找不到环境：${ref}。已登记的：${
                  service
                    .list()
                    .map((e) => e.name)
                    .join('、') || '（一个都没有，先 action=sync）'
                }`,
              ),
            },
          };
        }
        return { ok: true, id: env.id, name: env.name };
      };

      switch (input.action) {
        case 'list': {
          const installers = await service.installers();
          const separation = service.separationCheck();
          const lines = [service.render(), ''];
          lines.push('安装器（需求 15.3，同家族内取最快可用的）：');
          for (const [family, choice] of Object.entries(installers.chosen)) {
            lines.push(`  ${family}：${choice.reason}`);
          }
          if (!separation.ok) {
            lines.push('');
            lines.push(separation.summary);
            for (const violation of separation.violations) lines.push(`  ⚠ ${violation}`);
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'sync': {
          const result = await service.sync();
          options.onChanged?.({ action: 'sync', envId: null });
          const lines = [
            `同步完成：新增 ${String(result.added)} 个，已有 ${String(result.existing)} 个。`,
          ];
          if (result.skipped.length > 0) {
            lines.push('');
            lines.push('跳过的：');
            for (const skipped of result.skipped) lines.push(`  - ${skipped}`);
          }
          lines.push('');
          lines.push(service.render());
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'probe': {
          const resolved = resolveEnv(input.env);
          if (!resolved.ok) return resolved.output;
          const env = await service.probe(resolved.id);
          if (env === null) {
            return { ok: false, output: errorOutput('ProbeFailed', '探测没有返回结果') };
          }
          const lines = [
            `${env.name}：${ENV_STATUS_LABEL[env.status]}`,
            env.lastProbe?.summary ?? '',
            '',
          ];
          for (const check of env.lastProbe?.checks ?? []) {
            lines.push(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
          }
          return { ok: env.status === 'ready', output: textOutput(lines.join('\n')) };
        }

        case 'packages': {
          const resolved = resolveEnv(input.env);
          if (!resolved.ok) return resolved.output;
          const result = service.packages(resolved.id, {
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(input.query === undefined ? {} : { query: input.query }),
            limit: input.limit ?? 200,
          });

          if (result.packages.length === 0) {
            return {
              ok: true,
              output: textOutput(
                `${resolved.name} 里没有匹配的包。` +
                  (result.stats.total === 0
                    ? '这个环境的包清单是空的——先 action=probe 刷新一次。'
                    : `（共 ${String(result.stats.total)} 个包）`),
              ),
            };
          }

          const lines = [
            `${resolved.name}：${String(result.packages.length)} 个匹配（共 ${String(result.stats.total)} 个）`,
            Object.entries(result.stats.bySource)
              .map(
                ([source, n]) =>
                  `${PACKAGE_SOURCE_LABEL[source as PackageSource] ?? source} ${String(n)}`,
              )
              .join('　'),
            '',
          ];
          for (const pkg of result.packages) {
            lines.push(
              `  ${pkg.name}${pkg.version === null ? '' : ` ${pkg.version}`}` +
                `　[${pkg.source}]${pkg.installedBy === null ? '' : `　由 ${pkg.installedBy} 装`}`,
            );
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'mixups': {
          const resolved = resolveEnv(input.env);
          if (!resolved.ok) return resolved.output;
          const result = service.mixups(resolved.id);
          return {
            ok: result.mixups.length === 0,
            output: textOutput(`${resolved.name}：\n${result.rendered}`),
          };
        }

        case 'plan': {
          const resolved = resolveEnv(input.env);
          if (!resolved.ok) return resolved.output;
          if (input.specs === undefined) {
            return { ok: false, output: errorOutput('MissingSpecs', 'action=plan 需要 specs') };
          }

          const plan = await service.plan({
            envId: resolved.id,
            request: {
              specs: input.specs,
              ...(input.family === undefined ? {} : { family: input.family }),
              ...(input.channel === undefined ? {} : { channel: input.channel }),
            },
          });

          const lines = [
            `环境：${resolved.name}`,
            `来源家族：${plan.family ?? '未定'}`,
            `安装器：${plan.installerReason}`,
            `命令：${plan.command ?? '（构造不出来）'}`,
            `需要重启内核：${plan.restartRequired ? '是' : '否'}`,
          ];
          if (plan.conflicts.length > 0) {
            lines.push('');
            lines.push(renderConflicts(plan.conflicts));
          }
          if (plan.reason !== null && plan.conflicts.length === 0) {
            lines.push('');
            lines.push(plan.reason);
          }
          return { ok: plan.ok, output: textOutput(lines.join('\n')) };
        }

        case 'install':
        case 'uninstall': {
          const resolved = resolveEnv(input.env);
          if (!resolved.ok) return resolved.output;
          if (input.specs === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingSpecs', `action=${input.action} 需要 specs`),
            };
          }

          const result = await service.install({
            envId: resolved.id,
            request: {
              specs: input.specs,
              ...(input.family === undefined ? {} : { family: input.family }),
              ...(input.channel === undefined ? {} : { channel: input.channel }),
            },
            ...(input.action === 'uninstall' ? { uninstall: true } : {}),
            conversationId: ctx.conversationId,
            ...(input.force === undefined ? {} : { force: input.force }),
            // 发起者进审批卡片：用户要知道是哪个模型想装这个包
            ...(ctx.modelId === undefined ? {} : { modelId: ctx.modelId }),
          });

          if (!result.ok) {
            /*
             * 三种失败用三个不同的错误名。
             *
             * 模型看到具体的名字才有机会走对下一步，而三者对的下一步完全不同：
             * 混装要问用户选哪种解决办法；审批被拒要换做法或问用户；参数错要改参数。
             * 笼统的「失败」会让它统一走「加个 force 再试」。
             */
            if (result.approval.source === 'denied') {
              return {
                ok: false,
                output: errorOutput(
                  'PackageInstallDenied',
                  `${result.reason ?? '未获批准'}\n` +
                    (result.approval.retryable
                      ? '（超时或取消导致，可以稍后重新发起）'
                      : '（用户明确拒绝，不要重新发起同一请求。' +
                        '需要这个包的话说明它是做什么用的，让用户决定。）'),
                ),
              };
            }
            const ename = result.plan.conflicts.length > 0 ? 'PackageConflict' : 'InstallRejected';
            return {
              ok: false,
              output: errorOutput(
                ename,
                `${result.reason ?? '失败'}\n\n` +
                  (result.plan.conflicts.length > 0
                    ? '不要直接加 force 重试——先问用户要哪种解决办法。' +
                      'force 会造成一个「能导入但数值可能是错的」环境，而那种问题不报错。'
                    : ''),
              ),
            };
          }

          const lines = [
            `已提交后台任务：${input.action === 'uninstall' ? '卸载' : '安装'} ${input.specs.join('、')}`,
            `环境：${resolved.name}　安装器：${result.plan.installer?.id ?? '?'}`,
            `命令：${result.plan.command ?? ''}`,
            result.approval.source === 'existing-grant' ? '（放行依据：此前已批准的持久授权）' : '',
            '',
            restartNotice({
              required: result.plan.restartRequired,
              why: result.plan.restartRequired
                ? '装完之后内核里的模块缓存不会自动失效。'
                : '这个环境当前没有活着的内核。',
            }),
            '',
            '完成后结果会自动回到对话里，不需要反复查。',
          ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));
          return {
            ok: true,
            output: textOutput(lines.join('\n')),
            ...(result.taskId === null ? {} : { backgroundTaskId: result.taskId }),
          };
        }

        case 'create': {
          if (input.name === undefined) {
            return { ok: false, output: errorOutput('MissingName', 'action=create 需要 name') };
          }
          const result = await service.create({
            name: input.name,
            language: input.language ?? 'python',
            ...(input.pythonVersion === undefined ? {} : { pythonVersion: input.pythonVersion }),
            ...(input.rVersion === undefined ? {} : { rVersion: input.rVersion }),
            ...(input.specs === undefined ? {} : { packages: input.specs }),
            ...(input.channel === undefined ? {} : { channel: input.channel }),
            conversationId: ctx.conversationId,
          });

          if (!result.ok) {
            return {
              ok: false,
              output: errorOutput('EnvCreateRejected', result.reason ?? '创建失败'),
            };
          }
          options.onChanged?.({ action: 'create', envId: result.env?.id ?? null });

          return {
            ok: true,
            output: textOutput(
              [
                `已提交后台任务：创建环境 ${input.name}（${input.language ?? 'python'}）`,
                `路径（推测）：${result.env?.path ?? ''}`,
                input.specs === undefined ? '' : `一并安装：${input.specs.join('、')}`,
                '',
                '创建带编译依赖的环境要几分钟。它是后台任务，不受会话中断影响——' +
                  '完成后结果会自动回到对话里。',
              ]
                .filter((line) => line !== '')
                .join('\n'),
            ),
            ...(result.taskId === null ? {} : { backgroundTaskId: result.taskId }),
          };
        }
      }
    },
  };
}
