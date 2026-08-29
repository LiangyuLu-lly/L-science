/**
 * 作业调度器适配（任务 14.2，需求 14.3、14.7）。
 *
 * 三种后端（Slurm / PBS / 无调度器）各自提供四件事：生成提交脚本、提交并取回作业
 * id、查状态、取消。全部是**纯函数 + 命令字符串**，实际执行由 `ssh.ts` 或本地
 * shell 完成——这样这一层可以完整测试，而不需要一台集群。
 *
 * ## 状态查询为什么要两步
 *
 * 作业结束之后，`squeue` / `qstat` 就不再返回它了。此时只有历史记录能回答「它成功了
 * 吗」：Slurm 是 `sacct`（需要开 accounting），PBS 是 `qstat -x`（需要 job history）。
 * 两者都可能在集群上没开。
 *
 * 因此顺序是：**当前队列 → 历史记录 → 判定不明**。最后那一档不能省，也不能合进
 * 「已完成」：一个只跑了三分钟就消失的八小时作业几乎一定是失败了，而报「已完成」
 * 会让用户去读一份根本没写出来的输出。
 */

import type { JobSpec, JobState, SchedulerKind } from './types.js';
import type { TerminalSource } from '../repo/compute.js';

/* ------------------------------------------------------------------ *
 * 脚本生成
 * ------------------------------------------------------------------ */

/** 作业脚本里的文件名。`{id}` 由调用方替换成平台的作业 id。 */
export interface JobPaths {
  scriptPath: string;
  stdoutPath: string;
  stderrPath: string;
  /** 无调度器时用来存退出码与 pid 的文件。 */
  exitCodePath: string;
  pidPath: string;
}

export function jobPaths(remoteWorkdir: string, jobId: string): JobPaths {
  const base = `${remoteWorkdir.replace(/\/+$/u, '')}/lsci-${jobId}`;
  return {
    scriptPath: `${base}.sh`,
    stdoutPath: `${base}.out`,
    stderrPath: `${base}.err`,
    exitCodePath: `${base}.rc`,
    pidPath: `${base}.pid`,
  };
}

/**
 * 校验作业名。
 *
 * 名字会进调度器的 job name，也会进远端文件名。放开任意字符的话，一个带 `;` 或
 * 空格的名字会在远端 shell 里变成两条命令——而作业名是模型可以自由填的字段。
 */
export function sanitizeJobName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return cleaned === '' ? 'job' : cleaned.slice(0, 64);
}

function slurmDirectives(spec: JobSpec, paths: JobPaths): string[] {
  const lines = [`#SBATCH --job-name=${sanitizeJobName(spec.name)}`];
  lines.push(`#SBATCH --output=${paths.stdoutPath}`);
  lines.push(`#SBATCH --error=${paths.stderrPath}`);
  if (spec.partition !== null) lines.push(`#SBATCH --partition=${spec.partition}`);
  if (spec.account !== null) lines.push(`#SBATCH --account=${spec.account}`);
  if (spec.cpus !== null) lines.push(`#SBATCH --cpus-per-task=${String(spec.cpus)}`);
  if (spec.memoryMb !== null) lines.push(`#SBATCH --mem=${String(spec.memoryMb)}M`);
  if (spec.minutes !== null) {
    // Slurm 接受 MM 或 HH:MM:SS。用后者：MM 在超过一天时表达不了，而分钟数
    // 上限本身是常见需求（--time=2880 会被某些配置解释成 2880 分钟以外的东西）
    const h = Math.floor(spec.minutes / 60);
    const m = spec.minutes % 60;
    lines.push(`#SBATCH --time=${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  }
  if (spec.gpus !== null && spec.gpus > 0) lines.push(`#SBATCH --gres=gpu:${String(spec.gpus)}`);
  lines.push(...spec.extraDirectives);
  return lines;
}

function pbsDirectives(spec: JobSpec, paths: JobPaths): string[] {
  const lines = [`#PBS -N ${sanitizeJobName(spec.name)}`];
  lines.push(`#PBS -o ${paths.stdoutPath}`);
  lines.push(`#PBS -e ${paths.stderrPath}`);
  if (spec.partition !== null) lines.push(`#PBS -q ${spec.partition}`);
  if (spec.account !== null) lines.push(`#PBS -A ${spec.account}`);

  /*
   * PBS 的资源请求要拼成一行 `-l select=...`。
   *
   * 分开写成多个 `-l` 在 PBS Pro 上会**互相覆盖**而不是合并，表现是只有最后一条
   * 生效——于是「我申请了 4 张卡怎么只给了 CPU」这类问题没有报错可查。
   */
  const select: string[] = ['1'];
  if (spec.cpus !== null) select.push(`ncpus=${String(spec.cpus)}`);
  if (spec.gpus !== null && spec.gpus > 0) select.push(`ngpus=${String(spec.gpus)}`);
  if (spec.memoryMb !== null) select.push(`mem=${String(spec.memoryMb)}mb`);
  if (select.length > 1) lines.push(`#PBS -l select=${select.join(':')}`);

  if (spec.minutes !== null) {
    const h = Math.floor(spec.minutes / 60);
    const m = spec.minutes % 60;
    lines.push(`#PBS -l walltime=${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  }
  lines.push(...spec.extraDirectives);
  return lines;
}

/**
 * 环境变量导出行。
 *
 * 值用单引号包住并转义内部的单引号。不转义的话，一个含 `'` 的值（比如作业名里
 * 带撇号）会让脚本从那里开始被错误解析。
 */
function exportLines(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(
    ([key, value]) => `export ${key}='${value.replace(/'/gu, `'\\''`)}'`,
  );
}

/**
 * 生成完整的作业脚本。
 *
 * 三件事在这里是刻意的：
 *
 * - `set -euo pipefail`：不加的话，脚本中间一条命令失败后**后面照样跑完**，作业以
 *   退出码 0 结束，用户拿到一份缺了一半的输出而系统报「已完成」。
 * - 激活命令排在 `set -e` 之后但在正文之前：`module load` 与 `conda activate` 失败
 *   必须让作业直接死掉，否则后面用的是系统默认的 python，而那通常缺依赖，
 *   报的错离真正的原因很远。
 * - 无调度器时把退出码写进文件：没有调度器可查，退出码是判断成败的唯一依据。
 */
export function buildJobScript(input: {
  scheduler: SchedulerKind;
  spec: JobSpec;
  paths: JobPaths;
  /** 环境激活命令（`module load` / `conda activate`）。 */
  activate: string | null;
}): string {
  const { scheduler, spec, paths } = input;
  const lines: string[] = ['#!/bin/sh'];

  if (scheduler === 'slurm') lines.push(...slurmDirectives(spec, paths));
  else if (scheduler === 'pbs') lines.push(...pbsDirectives(spec, paths));

  lines.push('');
  // sh 没有 pipefail；用 `set -eu` 并显式声明，而不是写一条在 sh 下直接报错的指令
  lines.push('set -eu');
  lines.push('');
  lines.push('# 由 L-science 生成。改这个文件不会影响下次提交。');

  if (spec.gpus !== null && spec.gpus > 0 && scheduler === 'none') {
    lines.push('');
    lines.push('# 无调度器时 GPU 不由任何东西分配，这里只是把请求数记下来');
    lines.push(`# 请求的 GPU 数：${String(spec.gpus)}`);
  }

  const envLines = exportLines(spec.env);
  if (envLines.length > 0) {
    lines.push('');
    lines.push(...envLines);
  }

  if (input.activate !== null && input.activate.trim() !== '') {
    lines.push('');
    lines.push('# 环境激活。失败要让作业直接结束——否则后面用的是系统默认解释器');
    lines.push(input.activate.trim());
  }

  lines.push('');
  lines.push(spec.script.trim());
  lines.push('');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 提交
 * ------------------------------------------------------------------ */

export interface SubmitCommands {
  /** 写脚本 + 提交，一次 ssh 往返完成。 */
  command: string;
  /** 从输出里抓作业 id。 */
  parseJobId: (stdout: string) => string | null;
}

/**
 * 写脚本的命令。
 *
 * 脚本经 base64 传输的理由与 `wrapRemoteCommand` 一样，但这里是**第二层**：外层已经
 * 把整条命令 base64 过一次，如果内层直接用 heredoc 写脚本正文，脚本里的 `$` 与
 * 反引号会在 heredoc 展开时被求值。用 base64 + `base64 -d` 落盘，脚本内容按字节
 * 原样到达远端。
 */
function writeScriptCommand(scriptPath: string, content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return [
    `mkdir -p "$(dirname '${scriptPath}')"`,
    `printf '%s' '${encoded}' | base64 -d > '${scriptPath}'`,
    `chmod +x '${scriptPath}'`,
  ].join(' && ');
}

export function submitCommands(input: {
  scheduler: SchedulerKind;
  script: string;
  paths: JobPaths;
}): SubmitCommands {
  const write = writeScriptCommand(input.paths.scriptPath, input.script);

  switch (input.scheduler) {
    case 'slurm':
      return {
        // --parsable 让 sbatch 只输出 `jobid` 或 `jobid;cluster`，
        // 而不是那句「Submitted batch job 12345」——后者的措辞在不同版本里变过
        command: `${write} && sbatch --parsable '${input.paths.scriptPath}'`,
        parseJobId: (stdout) => {
          const first = stdout.trim().split('\n').pop()?.trim() ?? '';
          const id = first.split(';')[0]?.trim() ?? '';
          return /^\d+$/u.test(id) ? id : null;
        },
      };

    case 'pbs':
      return {
        command: `${write} && qsub '${input.paths.scriptPath}'`,
        parseJobId: (stdout) => {
          // PBS 输出形如 `12345.headnode`。整串都是作业 id，截掉后缀会让 qstat 查不到
          const line = stdout.trim().split('\n').pop()?.trim() ?? '';
          return /^\d+(\.\S+)?$/u.test(line) ? line : null;
        },
      };

    case 'none':
      return {
        /*
         * 无调度器：nohup + setsid 让进程脱离 ssh 会话。
         *
         * 不脱离的话，ssh 连接一断（我们每条命令都是一次独立连接，所以是**立刻**断）
         * 远端 shell 收到 SIGHUP，作业跟着死。这是「在没有调度器的机器上提交作业」
         * 最容易踩的坑，而它的表现是作业看起来提交成功了然后瞬间消失。
         *
         * 退出码写进 .rc 文件：没有调度器可查，它是判断成败的唯一依据。
         */
        command: [
          write,
          `cd '${input.paths.scriptPath.replace(/\/[^/]+$/u, '')}'`,
          `nohup setsid sh -c "sh '${input.paths.scriptPath}' > '${input.paths.stdoutPath}' 2> '${input.paths.stderrPath}'; echo \\$? > '${input.paths.exitCodePath}'" > /dev/null 2>&1 &`,
          `echo $! > '${input.paths.pidPath}'`,
          `cat '${input.paths.pidPath}'`,
        ].join(' && '),
        parseJobId: (stdout) => {
          const line = stdout.trim().split('\n').pop()?.trim() ?? '';
          return /^\d+$/u.test(line) ? line : null;
        },
      };
  }
}

/* ------------------------------------------------------------------ *
 * 状态查询
 * ------------------------------------------------------------------ */

export interface StatusProbe {
  /** 一条命令问完当前队列与历史记录。 */
  command: string;
  parse: (stdout: string, stderr: string) => StatusReading;
}

export interface StatusReading {
  state: JobState;
  source: TerminalSource | null;
  exitCode: number | null;
  /** 原文摘要。判定不明时它是唯一的线索。 */
  detail: string;
}

/** Slurm 状态字符串 → 本平台状态。 */
const SLURM_STATES: Readonly<Record<string, JobState>> = {
  PENDING: 'queued',
  CONFIGURING: 'queued',
  REQUEUED: 'queued',
  RESIZING: 'running',
  RUNNING: 'running',
  SUSPENDED: 'running',
  COMPLETING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  NODE_FAIL: 'failed',
  OUT_OF_MEMORY: 'failed',
  BOOT_FAIL: 'failed',
  DEADLINE: 'timeout',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  PREEMPTED: 'cancelled',
  REVOKED: 'cancelled',
};

/** PBS 的 job_state 单字母。 */
const PBS_STATES: Readonly<Record<string, JobState>> = {
  Q: 'queued',
  W: 'queued',
  H: 'queued',
  T: 'queued',
  M: 'queued',
  R: 'running',
  E: 'running',
  S: 'running',
  B: 'running',
  F: 'completed',
  C: 'completed',
  X: 'completed',
};

/** 标记：查询输出里用它分隔「当前队列」与「历史记录」两段。 */
const SPLIT = '__LSCI_ACCT__';

export function statusProbe(input: {
  scheduler: SchedulerKind;
  externalId: string;
  paths: JobPaths;
}): StatusProbe {
  const { externalId } = input;

  switch (input.scheduler) {
    case 'slurm':
      return {
        /*
         * 一次往返问两处。
         *
         * 分两次 ssh 的代价不只是慢：两次连接之间作业可能刚好结束，于是第一次说
         * 「不在队列里」、第二次 sacct 又还没写进去，得到一个假的「判定不明」。
         *
         * `|| true` 是必须的：sacct 在没开 accounting 的集群上直接报错退出，
         * 而那不该让整条查询失败——那种情况下我们要的正是「历史记录不可用」这个事实。
         */
        command: [
          `squeue -h -j '${externalId}' -o '%T' 2>/dev/null || true`,
          `echo '${SPLIT}'`,
          `sacct -j '${externalId}' -n -X -P -o State,ExitCode 2>/dev/null || true`,
        ].join('; '),
        parse: (stdout) => {
          const [queueRaw = '', acctRaw = ''] = stdout.split(SPLIT);
          const queued = queueRaw.trim().split('\n')[0]?.trim() ?? '';

          if (queued !== '') {
            // squeue 会在状态后加原因，例如 `PENDING (Resources)`
            const token = queued.split(/[\s(]/u)[0]?.toUpperCase() ?? '';
            const state = SLURM_STATES[token];
            if (state !== undefined) {
              return {
                state,
                source: isTerminal(state) ? 'queue' : null,
                exitCode: null,
                detail: `squeue: ${queued}`,
              };
            }
            return {
              state: 'running',
              source: null,
              exitCode: null,
              detail: `squeue 报了一个未知状态：${queued}（暂按运行中处理）`,
            };
          }

          const acctLine = acctRaw
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l !== '');

          if (acctLine === undefined || acctLine === '') {
            return {
              state: 'lost',
              source: 'unavailable',
              exitCode: null,
              detail:
                '作业已不在 squeue 里，而 sacct 也查不到它。' +
                '集群可能没开 accounting，或者作业记录已被清理。' +
                '结果不明——不要假定它成功了。',
            };
          }

          const [stateRaw = '', exitRaw = ''] = acctLine.split('|');
          const token = stateRaw.split(/\s+/u)[0]?.toUpperCase() ?? '';
          const state = SLURM_STATES[token] ?? 'lost';
          // ExitCode 形如 `0:0`（退出码:信号）
          const exitCode = Number.parseInt(exitRaw.split(':')[0] ?? '', 10);

          return {
            state,
            source: state === 'lost' ? 'unavailable' : 'accounting',
            exitCode: Number.isFinite(exitCode) ? exitCode : null,
            detail:
              state === 'lost'
                ? `sacct 报了一个无法映射的状态：${stateRaw}。结果不明。`
                : `sacct: ${acctLine}`,
          };
        },
      };

    case 'pbs':
      return {
        command: [
          `qstat -f '${externalId}' 2>/dev/null || true`,
          `echo '${SPLIT}'`,
          `qstat -x -f '${externalId}' 2>/dev/null || true`,
        ].join('; '),
        parse: (stdout) => {
          const [liveRaw = '', histRaw = ''] = stdout.split(SPLIT);
          const text = liveRaw.trim() !== '' ? liveRaw : histRaw;
          const fromHistory = liveRaw.trim() === '' && histRaw.trim() !== '';

          if (text.trim() === '') {
            return {
              state: 'lost',
              source: 'unavailable',
              exitCode: null,
              detail:
                'qstat 查不到这个作业，qstat -x（历史记录）也没有。' +
                '集群可能没开 job history，或者记录已过期。结果不明。',
            };
          }

          const stateMatch = /job_state\s*=\s*(\w)/u.exec(text);
          const exitMatch = /Exit_status\s*=\s*(-?\d+)/u.exec(text);
          const letter = stateMatch?.[1]?.toUpperCase() ?? '';
          let state = PBS_STATES[letter] ?? 'lost';
          const exitCode = exitMatch === null ? null : Number.parseInt(exitMatch[1] ?? '', 10);

          /*
           * PBS 的 `F`（finished）不区分成败，成败只在 Exit_status 里。
           *
           * 只看 job_state 会把每个失败的作业都报成「已完成」——这是 PBS 适配最容易
           * 写错的一处，因为 Slurm 那边 FAILED 是一个独立状态。
           */
          if (state === 'completed' && exitCode !== null && exitCode !== 0) {
            // 大于 128 通常是被信号杀掉；PBS 用 271 表示超墙钟（128+143=SIGTERM）
            state = exitCode === 271 || exitCode === 143 ? 'timeout' : 'failed';
          }

          return {
            state,
            source: isTerminal(state)
              ? state === 'lost'
                ? 'unavailable'
                : fromHistory
                  ? 'accounting'
                  : 'queue'
              : null,
            exitCode,
            detail:
              state === 'lost'
                ? `qstat 报了一个无法映射的 job_state：${letter || '(空)'}。结果不明。`
                : `qstat: job_state=${letter}${exitCode === null ? '' : ` exit=${String(exitCode)}`}`,
          };
        },
      };

    case 'none':
      return {
        /*
         * 无调度器：先看进程还在不在，再读退出码文件。
         *
         * `kill -0` 只测存在性不发信号。顺序不能反：先读 .rc 的话，一个刚开始跑的
         * 作业（.rc 还不存在）与一个进程已死但 .rc 没写成的作业分不开。
         */
        command: [
          `if kill -0 '${externalId}' 2>/dev/null; then echo RUNNING; else echo GONE; fi`,
          `echo '${SPLIT}'`,
          `cat '${input.paths.exitCodePath}' 2>/dev/null || true`,
        ].join('; '),
        parse: (stdout) => {
          const [aliveRaw = '', rcRaw = ''] = stdout.split(SPLIT);
          const alive = aliveRaw.trim().includes('RUNNING');
          const rcText = rcRaw.trim();

          if (alive) {
            return { state: 'running', source: null, exitCode: null, detail: '进程仍在运行' };
          }
          if (rcText === '') {
            return {
              state: 'lost',
              source: 'unavailable',
              exitCode: null,
              detail:
                '进程已经不在了，但退出码文件也不存在。' +
                '作业可能被 OOM killer 或管理员杀掉，也可能机器重启过。结果不明。',
            };
          }

          const code = Number.parseInt(rcText.split('\n')[0] ?? '', 10);
          if (!Number.isFinite(code)) {
            return {
              state: 'lost',
              source: 'unavailable',
              exitCode: null,
              detail: `退出码文件内容不是数字：${rcText.slice(0, 80)}`,
            };
          }
          return {
            state: code === 0 ? 'completed' : 'failed',
            source: 'exit-code',
            exitCode: code,
            detail: `退出码 ${String(code)}`,
          };
        },
      };
  }
}

function isTerminal(state: JobState): boolean {
  return (['completed', 'failed', 'cancelled', 'timeout', 'lost'] as readonly JobState[]).includes(
    state,
  );
}

/* ------------------------------------------------------------------ *
 * 取消与输出
 * ------------------------------------------------------------------ */

export function cancelCommand(scheduler: SchedulerKind, externalId: string): string {
  switch (scheduler) {
    case 'slurm':
      return `scancel '${externalId}'`;
    case 'pbs':
      return `qdel '${externalId}'`;
    case 'none':
      /*
       * 杀进程组而不是单个进程。
       *
       * 提交时用了 setsid，所以作业自己是组长，pid 就是 pgid。只杀 pid 会留下它拉起的
       * python/mpirun 继续占着 GPU——而那台机器上没有调度器来回收资源。
       */
      return `kill -TERM -'${externalId}' 2>/dev/null || kill -TERM '${externalId}' 2>/dev/null || true`;
  }
}

/** 取输出。`tailLines` 为 0 表示取全文。 */
export function fetchOutputCommand(paths: JobPaths, tailLines: number): string {
  const grab = (path: string): string =>
    tailLines > 0
      ? `tail -n ${String(tailLines)} '${path}' 2>/dev/null || true`
      : `cat '${path}' 2>/dev/null || true`;
  return [grab(paths.stdoutPath), `echo '${SPLIT}'`, grab(paths.stderrPath)].join('; ');
}

export function parseOutputs(stdout: string): { stdout: string; stderr: string } {
  const [out = '', err = ''] = stdout.split(SPLIT);
  return { stdout: out.replace(/^\n+/u, ''), stderr: err.replace(/^\n+/u, '') };
}

/** 探测调度器是否可用。返回一条命令与解析函数。 */
export function schedulerProbeCommand(): string {
  return [
    'echo "sinfo:$(command -v sinfo >/dev/null 2>&1 && echo yes || echo no)"',
    'echo "sbatch:$(command -v sbatch >/dev/null 2>&1 && echo yes || echo no)"',
    'echo "qsub:$(command -v qsub >/dev/null 2>&1 && echo yes || echo no)"',
    'echo "sacct:$(command -v sacct >/dev/null 2>&1 && echo yes || echo no)"',
    'echo "nvidiasmi:$(command -v nvidia-smi >/dev/null 2>&1 && echo yes || echo no)"',
  ].join('; ');
}

export function parseSchedulerProbe(stdout: string): {
  detected: SchedulerKind | null;
  hasAccounting: boolean;
  hasNvidiaSmi: boolean;
  found: Readonly<Record<string, boolean>>;
} {
  const found: Record<string, boolean> = {};
  for (const line of stdout.split('\n')) {
    const [key, value] = line.trim().split(':');
    if (key !== undefined && value !== undefined) found[key] = value.trim() === 'yes';
  }
  const detected: SchedulerKind | null =
    found['sbatch'] === true ? 'slurm' : found['qsub'] === true ? 'pbs' : null;
  return {
    detected,
    hasAccounting: found['sacct'] === true,
    hasNvidiaSmi: found['nvidiasmi'] === true,
    found,
  };
}
