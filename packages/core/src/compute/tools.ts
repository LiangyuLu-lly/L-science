/**
 * 算力的模型面工具（任务 14.2，需求 14.3、14.4、14.6、14.7）。
 *
 * 三个工具而不是一个：**登记不在模型面上**。
 *
 * 模型可以查、可以用，但不能登记算力目标。理由不是权限而是有效性——登记需要主机名、
 * 跳板机配置、远端工作目录、分区名这些只有用户知道的事实，而模型面对这些字段时会
 * 填出看起来合理的值。一条填错的目标在探测时才会失败，那时用户看到的是「连不上
 * hpc.example.edu」，而他从没提过这个主机名。登记走界面与控制面。
 *
 * `run_remote_command` 与 `submit_compute_job` 分开，理由与审批分类同源：一条 `ls`
 * 与一个八小时的作业在代价、生命周期与需要的参数上都不一样。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

import { describeTarget } from './gate.js';
import { RISK_LABEL } from './risk.js';
import type { ComputeService } from './service.js';
import { renderCommandResult } from './service.js';
import { JOB_STATE_LABEL, type JobState } from './types.js';

export interface ComputeToolOptions {
  service: () => ComputeService;
  onJobsChanged?: (info: { action: string; jobId: string | null }) => void;
}

/* ------------------------------------------------------------------ *
 * manage_compute
 * ------------------------------------------------------------------ */

export type ComputeAction =
  'list' | 'describe' | 'probe' | 'jobs' | 'job' | 'outputs' | 'cancel' | 'notes' | 'addNote';

export interface ComputeToolInput {
  action: ComputeAction;
  target?: string;
  jobId?: string;
  state?: JobState | 'active' | 'all';
  limit?: number;
  tailLines?: number;
  note?: string;
  reason?: string;
  replaceId?: string;
}

const MANAGE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'describe', 'probe', 'jobs', 'job', 'outputs', 'cancel', 'notes', 'addNote'],
      description:
        'list：列出可用的算力目标（用户中途新增的会立刻出现，不需要重启）。' +
        'describe：看某个目标的配置、上次探测结果与环境笔记。' +
        'probe：重新探测一个目标（会连接远端，慢）。' +
        'jobs：列出作业。job：看一个作业的状态。' +
        'outputs：取一个作业的 stdout/stderr。cancel：取消一个未结束的作业。\n' +
        'notes：看某个目标的环境笔记。' +
        'addNote：给某个目标记一条环境笔记（踩过一次的坑就该记下来）。\n' +
        '开始规划远程计算之前先 list：目标的调度器类型、分区与 GPU 情况决定作业脚本怎么写。',
    },
    target: {
      type: 'string',
      description: '算力目标的名字或 id。名字优先（list 里显示的就是名字）。',
    },
    jobId: {
      type: 'string',
      description: 'action=job / outputs / cancel 时的作业 id（形如 cj_…）。',
    },
    state: {
      type: 'string',
      enum: [
        'active',
        'all',
        'submitted',
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
        'timeout',
        'lost',
      ],
      description:
        'action=jobs 时的状态筛选。active 表示未终止的。' +
        'lost 表示「结果不明」——调度器不再报告它而历史记录拿不到，**不等于成功也不等于失败**。',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限。' },
    tailLines: {
      type: 'integer',
      minimum: 1,
      maximum: 5000,
      description: 'action=outputs 时只取末尾多少行。省略取全文（作业输出可能很大）。',
    },
    note: {
      type: 'string',
      description:
        'action=addNote 的笔记内容。只写**这台机器自身**的事实：分区上限、账户、' +
        '文件系统清理策略、环境激活顺序、调度器的坑、接入方式、维护窗口。\n' +
        '环境笔记是**跨项目共享**的，因此不要写研究问题、被试、分组或统计结论——' +
        '那些换个项目就不成立，会被拒。',
    },
    reason: {
      type: 'string',
      description:
        'action=addNote 时说明为什么值得长期记住。用户日后审查这些笔记时靠它判断该不该留。',
    },
    replaceId: {
      type: 'string',
      description: 'action=addNote 时要覆盖的既有笔记 id（先用 action=notes 拿到它）。',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

const MANAGE_ACTIONS: readonly ComputeAction[] = [
  'list',
  'describe',
  'probe',
  'jobs',
  'job',
  'outputs',
  'cancel',
  'notes',
  'addNote',
];

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

export function createManageComputeTool(
  options: ComputeToolOptions,
): ToolDefinition<ComputeToolInput> {
  return {
    name: 'manage_compute',
    description:
      '算力目标与作业：列出可用目标、看配置与探测结果、查作业状态、取输出、取消作业，' +
      '以及读写每个目标的**环境笔记**。\n' +
      '登记新目标不在这里——那需要主机名、跳板机与分区这些只有用户知道的事实，' +
      '由用户在界面上完成。你能看到的是他已经登记好的那些。\n' +
      '作业状态里的「结果不明」（lost）是一档独立状态：调度器不再报告它而历史记录拿不到。' +
      '它既不是成功也不是失败，不要按成功继续往下做。\n' +
      '在某台机器上踩过一次坑（默认墙钟太短、要先 module load、/scratch 会被清理）' +
      '就用 addNote 记下来：环境笔记跨项目共享，下次换个项目也还在。',
    inputSchema: MANAGE_SCHEMA as unknown as Record<string, unknown>,
    parseInput: (raw): ComputeToolInput => {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      const action = obj.action;
      if (typeof action !== 'string' || !MANAGE_ACTIONS.includes(action as ComputeAction)) {
        throw new Error(`action 必须是 ${MANAGE_ACTIONS.join('/')} 之一，收到 ${String(action)}`);
      }
      const state = obj.state;
      if (state !== undefined && typeof state !== 'string') throw new Error('state 必须是字符串');

      return {
        action: action as ComputeAction,
        ...(str(obj.target, 'target') === undefined
          ? {}
          : { target: str(obj.target, 'target') as string }),
        ...(str(obj.jobId, 'jobId') === undefined
          ? {}
          : { jobId: str(obj.jobId, 'jobId') as string }),
        ...(state === undefined ? {} : { state: state as JobState | 'active' | 'all' }),
        ...(int(obj.limit, 'limit') === undefined
          ? {}
          : { limit: int(obj.limit, 'limit') as number }),
        ...(int(obj.tailLines, 'tailLines') === undefined
          ? {}
          : { tailLines: int(obj.tailLines, 'tailLines') as number }),
        ...(str(obj.note, 'note') === undefined ? {} : { note: str(obj.note, 'note') as string }),
        ...(str(obj.reason, 'reason') === undefined
          ? {}
          : { reason: str(obj.reason, 'reason') as string }),
        ...(str(obj.replaceId, 'replaceId') === undefined
          ? {}
          : { replaceId: str(obj.replaceId, 'replaceId') as string }),
      };
    },

    execute: async (input, ctx): Promise<ToolResult> => {
      const service = options.service();

      switch (input.action) {
        case 'list': {
          const targets = service.list();
          if (targets.length === 0) {
            return {
              ok: true,
              output: textOutput(
                '还没有登记任何算力目标。\n' +
                  '登记要在界面的「算力」页完成——它需要主机名、跳板机配置、远端工作目录与' +
                  '分区名这些只有用户知道的事实。\n' +
                  '需要远程算力的话，请让用户先登记一个目标。',
              ),
            };
          }

          const lines = [`${String(targets.length)} 个算力目标：`, ''];
          for (const target of targets) {
            const probe = target.lastProbe;
            lines.push(`- ${describeTarget(target)}`);
            if (target.config.family === 'ssh') {
              lines.push(
                `  调度器：${target.config.scheduler}` +
                  (target.config.partition === null
                    ? ''
                    : `　默认分区：${target.config.partition}`),
              );
              lines.push(`  远端工作目录：${target.config.remoteWorkdir}`);
              if (target.hostKeyFingerprint === null) {
                lines.push('  ⚠ 主机公钥还没确认，暂时不能连接（要用户在界面上确认）');
              }
            }
            if (probe !== null) {
              lines.push(`  上次探测：${probe.usable ? '可用' : '不可用'} —— ${probe.summary}`);
              if (probe.gpus.length > 0) {
                lines.push(
                  `  GPU：${probe.gpus
                    .map(
                      (g) =>
                        `${g.name}${g.memoryTotalMb === null ? '' : ` ${String(g.memoryTotalMb)}MB`}`,
                    )
                    .join('、')}`,
                );
              }
            } else {
              lines.push('  还没探测过。要知道它能不能用请 action=probe。');
            }
            const jobs = service.jobs.summary({ targetId: target.id });
            if (jobs.total > 0) {
              lines.push(
                `  作业：${String(jobs.total)} 个（${String(jobs.active)} 未结束、` +
                  `${String(jobs.completed)} 完成、${String(jobs.failed)} 失败、` +
                  `${String(jobs.lost)} 结果不明）`,
              );
            }
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'describe': {
          const ref = input.target;
          if (ref === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingTarget', 'action=describe 需要 target'),
            };
          }
          const target = service.targets.resolve(ref);
          if (target === null) {
            return {
              ok: false,
              output: errorOutput(
                'TargetNotFound',
                `找不到算力目标：${ref}。已登记的：${
                  service
                    .list()
                    .map((t) => t.name)
                    .join('、') || '（一个都没有）'
                }`,
              ),
            };
          }

          const lines = [describeTarget(target), ''];
          lines.push('配置：');
          lines.push(JSON.stringify(target.config, null, 2));
          if (target.notesMd !== null && target.notesMd.trim() !== '') {
            lines.push('');
            lines.push('用户写的环境说明：');
            lines.push(target.notesMd.trim());
          }
          if (target.lastProbe !== null) {
            lines.push('');
            lines.push(`上次探测（${new Date(target.lastProbe.at).toLocaleString('zh-CN')}）：`);
            lines.push(target.lastProbe.summary);
            for (const check of target.lastProbe.checks) {
              lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
            }
          }

          /*
           * 环境笔记跟着 describe 一起给（需求 14.5）。
           *
           * 不给的话模型要多一次调用才能知道「这个集群不给 --time 会用 10 分钟默认值」，
           * 而它通常不会去多调一次——它已经拿到配置了，看起来够写作业脚本了。
           */
          lines.push('');
          lines.push(service.renderNotes(target.id));
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'notes': {
          const ref = input.target;
          if (ref === undefined) {
            return { ok: false, output: errorOutput('MissingTarget', 'action=notes 需要 target') };
          }
          const target = service.targets.resolve(ref);
          if (target === null) {
            return { ok: false, output: errorOutput('TargetNotFound', `找不到算力目标：${ref}`) };
          }
          return {
            ok: true,
            output: textOutput(`${describeTarget(target)}\n\n${service.renderNotes(target.id)}`),
          };
        }

        case 'addNote': {
          const ref = input.target;
          if (ref === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingTarget', 'action=addNote 需要 target'),
            };
          }
          if (input.note === undefined) {
            return { ok: false, output: errorOutput('MissingNote', 'action=addNote 需要 note') };
          }
          if (input.reason === undefined || input.reason.length < 4) {
            return {
              ok: false,
              output: errorOutput(
                'MissingReason',
                'action=addNote 需要 reason：用户日后审查这些笔记时靠它判断该不该留，' +
                  '「重要」这类话起不到这个作用。',
              ),
            };
          }
          const target = service.targets.resolve(ref);
          if (target === null) {
            return { ok: false, output: errorOutput('TargetNotFound', `找不到算力目标：${ref}`) };
          }

          const result = service.addNote({
            targetId: target.id,
            content: input.note,
            reason: input.reason,
            ...(input.replaceId === undefined ? {} : { replaceId: input.replaceId }),
          });
          if (!result.ok) {
            // 拒绝理由已经带改写建议：只说「不许写」会让模型放弃使用这个能力
            return { ok: false, output: errorOutput('EnvironmentNoteRejected', result.reason) };
          }
          return {
            ok: true,
            output: textOutput(
              `${result.created ? '已记下' : '已覆盖'}（${target.name} 的环境笔记，id ${result.note.id}）：` +
                `${result.note.content}\n` +
                '这条笔记跨项目共享，换个项目用这台机器时也会看到。',
            ),
          };
        }

        case 'probe': {
          const ref = input.target;
          if (ref === undefined) {
            return { ok: false, output: errorOutput('MissingTarget', 'action=probe 需要 target') };
          }
          const target = service.targets.resolve(ref);
          if (target === null) {
            return { ok: false, output: errorOutput('TargetNotFound', `找不到算力目标：${ref}`) };
          }
          const report = await service.probe(target.id);
          if (report === null) {
            return { ok: false, output: errorOutput('ProbeFailed', '探测没有返回结果') };
          }
          const lines = [`${target.name}：${report.summary}`, ''];
          for (const check of report.checks) {
            lines.push(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
          }
          if (report.pendingHostKey !== null) {
            lines.push('');
            lines.push(
              `取到了未确认的主机公钥：${report.pendingHostKey.fingerprint}` +
                `（${report.pendingHostKey.keyType}）。` +
                '确认要由用户在界面上做——指纹必须由人去和管理员公布的值核对。',
            );
          }
          return { ok: report.usable, output: textOutput(lines.join('\n')) };
        }

        case 'jobs': {
          const jobs = service.jobs.list({
            ...(input.target === undefined
              ? {}
              : { targetId: service.targets.resolve(input.target)?.id ?? input.target }),
            ...(ctx.conversationId === '' ? {} : { conversationId: ctx.conversationId }),
            state: input.state ?? 'all',
            limit: input.limit ?? 30,
          });

          if (jobs.length === 0) {
            return {
              ok: true,
              output: textOutput(
                `本会话没有匹配的作业。${service.activeSummary(ctx.conversationId)}`,
              ),
            };
          }

          const lines = [service.activeSummary(ctx.conversationId), ''];
          for (const job of jobs) {
            const target = service.targets.get(job.targetId);
            lines.push(
              `- ${job.id}　${job.name ?? '(未命名)'}　${JOB_STATE_LABEL[job.state]}` +
                `　@${target?.name ?? job.targetId}` +
                (job.externalId === null ? '' : `　调度器 id ${job.externalId}`),
            );
            if (job.state === 'lost') {
              lines.push(`  ${job.detail ?? '结果不明'}`);
            }
            if (job.pollError !== null) {
              lines.push(`  最近查询失败：${job.pollError}（作业本身可能仍在正常运行）`);
            }
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'job': {
          const jobId = input.jobId;
          if (jobId === undefined) {
            return { ok: false, output: errorOutput('MissingJobId', 'action=job 需要 jobId') };
          }
          // 主动问一次而不是读缓存：用户问「跑完了吗」时应该现在就去查
          await service.pollOnce(jobId);
          const job = service.jobs.get(jobId);
          if (job === null) {
            return { ok: false, output: errorOutput('JobNotFound', `作业不存在：${jobId}`) };
          }
          return { ok: true, output: textOutput(service.renderJob(job)) };
        }

        case 'outputs': {
          const jobId = input.jobId;
          if (jobId === undefined) {
            return { ok: false, output: errorOutput('MissingJobId', 'action=outputs 需要 jobId') };
          }
          const job = service.jobs.get(jobId);
          if (job === null) {
            return { ok: false, output: errorOutput('JobNotFound', `作业不存在：${jobId}`) };
          }

          const outputs = await service.collectOutputs(jobId, {
            ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
          });
          const lines: string[] = [service.renderJob(job), ''];
          if (outputs.stdout.trim() !== '') {
            lines.push('<stdout>');
            lines.push(outputs.stdout.trimEnd());
            lines.push('</stdout>');
          }
          if (outputs.stderr.trim() !== '') {
            lines.push('<stderr>');
            lines.push(outputs.stderr.trimEnd());
            lines.push('</stderr>');
          }
          if (outputs.stdout.trim() === '' && outputs.stderr.trim() === '') {
            lines.push(
              '两个输出文件都是空的或还不存在。' +
                (job.state === 'queued' ? '作业还在排队，输出文件要等它开始跑才有。' : ''),
            );
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'cancel': {
          const jobId = input.jobId;
          if (jobId === undefined) {
            return { ok: false, output: errorOutput('MissingJobId', 'action=cancel 需要 jobId') };
          }
          const result = await service.cancelJob(jobId);
          options.onJobsChanged?.({ action: 'cancel', jobId });
          if (!result.ok) {
            return { ok: false, output: errorOutput('CancelFailed', result.reason ?? '取消失败') };
          }
          return { ok: true, output: textOutput(`作业 ${jobId} 已取消。已消耗的机时不会退回。`) };
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * run_remote_command
 * ------------------------------------------------------------------ */

export interface RemoteCommandInput {
  target: string;
  command: string;
  purpose: string;
  timeoutMs?: number;
}

const REMOTE_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: '算力目标的名字或 id（先用 manage_compute list 看有哪些）。',
    },
    command: {
      type: 'string',
      description:
        '要执行的命令。远端按 /bin/sh 解析。' +
        '命令经 base64 传输，因此引号、$、反引号与换行都会原样到达远端，不需要额外转义。',
    },
    purpose: {
      type: 'string',
      description:
        '为什么要跑它，一句话。这句话会**原样**出现在给用户的审批卡片上——' +
        '「查看情况」这类说法帮不了他判断要不要同意。',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600_000,
      description: '墙钟上限，默认 120 秒。超过它命令会被终止。长任务请用 submit_compute_job。',
    },
  },
  required: ['target', 'command', 'purpose'],
  additionalProperties: false,
} as const;

export function createRunRemoteCommandTool(
  options: ComputeToolOptions,
): ToolDefinition<RemoteCommandInput> {
  return {
    name: 'run_remote_command',
    description:
      '在一个算力目标上执行一条命令。**每次都要经过用户审批**（需求 14.4）。\n' +
      '只读命令（ls、squeue、cat、nvidia-smi 这类）在用户给过持久授权后直接放行；' +
      '写命令会问一次；**破坏性命令（rm -r、scancel、sudo、kill -9）每次都单独问，' +
      '持久授权对它们无效**。\n' +
      '这个工具用于交互式操作与排查。要跑计算请用 submit_compute_job：' +
      '这里有墙钟上限，而且命令跑在登录节点上——在登录节点上跑计算会被管理员制止。',
    inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown>,
    parseInput: (raw): RemoteCommandInput => {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;
      const target = str(obj.target, 'target');
      const command = typeof obj.command === 'string' ? obj.command : undefined;
      const purpose = str(obj.purpose, 'purpose');

      if (target === undefined) throw new Error('target 不能为空');
      if (command === undefined || command.trim() === '') throw new Error('command 不能为空');
      if (purpose === undefined) {
        throw new Error(
          'purpose 不能为空：它会原样出现在用户的审批卡片上，是他判断要不要同意的依据',
        );
      }
      if (purpose.length < 4) {
        throw new Error('purpose 太短，说清楚要用这条命令达到什么目的');
      }

      return {
        target,
        command,
        purpose,
        ...(int(obj.timeoutMs, 'timeoutMs') === undefined
          ? {}
          : { timeoutMs: int(obj.timeoutMs, 'timeoutMs') as number }),
      };
    },

    execute: async (input, ctx): Promise<ToolResult> => {
      const service = options.service();
      const result = await service.runCommand({
        targetRef: input.target,
        command: input.command,
        purpose: input.purpose,
        conversationId: ctx.conversationId,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(ctx.modelId === undefined ? {} : { modelId: ctx.modelId }),
      });

      /*
       * 被拒绝时把「可不可以重试」说清楚（需求 17.3）。
       *
       * 不说的话模型会在用户明确拒绝之后再问一次——而反复被问同一件事的用户最终会
       * 为了脱身而点同意，那比不问更糟。
       */
      if (!result.ok && result.gate.source === 'denied') {
        return {
          ok: false,
          output: errorOutput(
            'ComputeApprovalDenied',
            `${result.reason ?? '未获批准'}\n` +
              (result.gate.retryable
                ? '（超时或取消导致，可以稍后重新发起）'
                : '（用户明确拒绝，不要重新发起同一请求。换个做法或问用户想怎么做。）'),
          ),
        };
      }

      return { ok: result.ok, output: renderCommandResult(result) };
    },
  };
}

/* ------------------------------------------------------------------ *
 * submit_compute_job
 * ------------------------------------------------------------------ */

export interface SubmitJobInput {
  target: string;
  name: string;
  script: string;
  cpus?: number;
  gpus?: number;
  memoryMb?: number;
  minutes?: number;
  partition?: string;
  account?: string;
  env?: Readonly<Record<string, string>>;
  extraDirectives?: readonly string[];
}

const SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '算力目标的名字或 id。' },
    name: {
      type: 'string',
      description:
        '作业名。会进调度器的 job name，也用于生成远端文件名。用能认出是什么分析的名字。',
    },
    script: {
      type: 'string',
      description:
        '作业脚本正文（sh 语法，不要写 #!/… 也不要写 #SBATCH/#PBS 指令——' +
        '平台会按目标的调度器加上它们，你写重了会冲突）。\n' +
        '脚本以 set -eu 开头运行：任何一条命令失败作业就结束。' +
        '不这样的话失败之后后面照样跑完，作业以退出码 0 结束，而输出缺了一半。',
    },
    cpus: { type: 'integer', minimum: 1, description: 'CPU 核数。' },
    gpus: { type: 'integer', minimum: 0, description: 'GPU 数量。' },
    memoryMb: { type: 'integer', minimum: 1, description: '内存，MB。' },
    minutes: {
      type: 'integer',
      minimum: 1,
      description:
        '墙钟上限（分钟）。不给会用队列默认值，而默认值常常只有几分钟——' +
        '一个长作业因此在开始不久就被杀掉，报错里不会提到是墙钟的原因。',
    },
    partition: { type: 'string', description: '分区/队列。省略时用目标上配的默认值。' },
    account: { type: 'string', description: '记账账户。省略时用目标上配的默认值。' },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: '环境变量。',
    },
    extraDirectives: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 20,
      description:
        '额外的调度器指令行，原样插进脚本头部（例如 #SBATCH --nodelist=gpu01）。' +
        '要带上 #SBATCH / #PBS 前缀。',
    },
  },
  required: ['target', 'name', 'script'],
  additionalProperties: false,
} as const;

export function createSubmitJobTool(options: ComputeToolOptions): ToolDefinition<SubmitJobInput> {
  return {
    name: 'submit_compute_job',
    description:
      '向一个算力目标提交作业。**每次都要经过用户审批**（需求 14.4），审批卡片上会列出' +
      '你请求的 CPU/GPU/内存/墙钟——因为「提交一个作业」与「提交一个占 8 张卡跑 48 小时' +
      '的作业」在用户要不要同意上是两个问题。\n' +
      '提交之后平台自动跟踪到终止态并把结果关联回本会话，你不需要反复轮询；' +
      '想主动看用 manage_compute action=job。\n' +
      '不要写 #SBATCH / #PBS 指令与 shebang，平台按目标的调度器生成。',
    inputSchema: SUBMIT_SCHEMA as unknown as Record<string, unknown>,
    parseInput: (raw): SubmitJobInput => {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      const target = str(obj.target, 'target');
      const name = str(obj.name, 'name');
      const script = typeof obj.script === 'string' ? obj.script : undefined;
      if (target === undefined) throw new Error('target 不能为空');
      if (name === undefined) throw new Error('name 不能为空');
      if (script === undefined || script.trim() === '') throw new Error('script 不能为空');

      /*
       * 挡住自带指令的脚本。
       *
       * 模型很容易照着教程把 #SBATCH 写进脚本，而平台也会加一份——两份指令里后出现的
       * 通常胜出，于是「我申请了 4 张卡」变成了别的数字，且没有任何报错。
       */
      if (/^\s*#\s*(SBATCH|PBS)\b/imu.test(script)) {
        throw new Error(
          'script 里不要写 #SBATCH / #PBS 指令：平台会按目标的调度器生成一份，' +
            '两份指令同时存在时哪一份生效取决于顺序，而且不会报错。' +
            '资源请求请用 cpus/gpus/memoryMb/minutes 参数；' +
            '确实需要平台没覆盖的指令时用 extraDirectives。',
        );
      }
      if (/^\s*#!/u.test(script)) {
        throw new Error('script 里不要写 shebang：平台会加 #!/bin/sh 作为第一行。');
      }

      const env: Record<string, string> = {};
      if (typeof obj.env === 'object' && obj.env !== null && !Array.isArray(obj.env)) {
        for (const [key, value] of Object.entries(obj.env as Record<string, unknown>)) {
          if (!/^[A-Za-z_]\w*$/u.test(key)) {
            throw new Error(`环境变量名不合法：${key}`);
          }
          env[key] = String(value);
        }
      }

      const extraDirectives: string[] = [];
      if (Array.isArray(obj.extraDirectives)) {
        for (const entry of obj.extraDirectives) {
          if (typeof entry !== 'string') throw new Error('extraDirectives 的每一项必须是字符串');
          const trimmed = entry.trim();
          if (trimmed !== '') extraDirectives.push(trimmed);
        }
      }

      return {
        target,
        name,
        script,
        ...(int(obj.cpus, 'cpus') === undefined ? {} : { cpus: int(obj.cpus, 'cpus') as number }),
        ...(int(obj.gpus, 'gpus') === undefined ? {} : { gpus: int(obj.gpus, 'gpus') as number }),
        ...(int(obj.memoryMb, 'memoryMb') === undefined
          ? {}
          : { memoryMb: int(obj.memoryMb, 'memoryMb') as number }),
        ...(int(obj.minutes, 'minutes') === undefined
          ? {}
          : { minutes: int(obj.minutes, 'minutes') as number }),
        ...(str(obj.partition, 'partition') === undefined
          ? {}
          : { partition: str(obj.partition, 'partition') as string }),
        ...(str(obj.account, 'account') === undefined
          ? {}
          : { account: str(obj.account, 'account') as string }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
        ...(extraDirectives.length === 0 ? {} : { extraDirectives }),
      };
    },

    execute: async (input, ctx): Promise<ToolResult> => {
      const service = options.service();
      const result = await service.submitJob({
        targetRef: input.target,
        spec: {
          name: input.name,
          script: input.script,
          ...(input.cpus === undefined ? {} : { cpus: input.cpus }),
          ...(input.gpus === undefined ? {} : { gpus: input.gpus }),
          ...(input.memoryMb === undefined ? {} : { memoryMb: input.memoryMb }),
          ...(input.minutes === undefined ? {} : { minutes: input.minutes }),
          ...(input.partition === undefined ? {} : { partition: input.partition }),
          ...(input.account === undefined ? {} : { account: input.account }),
          ...(input.env === undefined ? {} : { env: input.env }),
          ...(input.extraDirectives === undefined
            ? {}
            : { extraDirectives: input.extraDirectives }),
        },
        conversationId: ctx.conversationId,
      });

      if (!result.ok || result.job === null) {
        const denied = result.gate !== null && result.gate.source === 'denied';
        return {
          ok: false,
          output: errorOutput(
            denied ? 'ComputeApprovalDenied' : 'JobSubmitFailed',
            `${result.reason ?? '提交失败'}` +
              (denied && result.gate !== null
                ? result.gate.retryable
                  ? '\n（超时或取消导致，可以稍后重新发起）'
                  : '\n（用户明确拒绝，不要重新发起同一请求。）'
                : ''),
          ),
        };
      }

      options.onJobsChanged?.({ action: 'submit', jobId: result.job.id });

      const target = service.targets.get(result.job.targetId);
      const lines = [
        `作业已提交：${result.job.id}`,
        `目标：${target === null ? result.job.targetId : describeTarget(target)}`,
        `调度器 id：${result.job.externalId ?? '(未取到)'}`,
        `状态：${JOB_STATE_LABEL[result.job.state]}`,
        '',
        '平台会自动跟踪到终止态并把结果关联回本会话——不需要你反复查。',
        '要主动看状态：manage_compute action=job jobId=' + result.job.id,
      ];
      if (result.gate?.source === 'existing-grant') {
        lines.push('');
        lines.push('（这次放行依据是此前已批准的持久授权）');
      }
      return { ok: true, output: textOutput(lines.join('\n')) };
    },
  };
}

/** 危险度标签，供 IPC 层与 UI 复用。 */
export { RISK_LABEL };
