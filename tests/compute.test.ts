/**
 * 算力目标与作业测试（任务 14.2，需求 14.3、14.4、14.6、14.7）。
 *
 * 六块重点：
 *
 * 1. **危险度判定**（需求 14.4）。这是「不被 ls 烦到」与「rm -rf 要经过我」能同时
 *    成立的全部依据。判错的两个方向代价不对称，因此正例负例都要有，尤其是
 *    `ls && rm -rf` 这类「第一段是只读」的组合。
 * 2. **作业脚本生成**。`#SBATCH` 与 `#PBS` 的指令形式、`set -eu`、环境激活的位置。
 *    PBS 的 `-l select=` 必须拼成一行——分开写会互相覆盖而不报错。
 * 3. **状态解析**（需求 14.7）。重点是 `lost` 这一档：队列里没有且历史记录拿不到时
 *    必须报「结果不明」，不能报完成。PBS 的 `F` 状态还要看 `Exit_status`。
 * 4. **审批门控**。破坏性命令即使有 always 授权也要重新问；显式拒绝不可重试。
 * 5. **仓储约束**。终止态必须带来源；停用必须给原因；轮询错误与作业状态分开记。
 * 6. **配置校验**。每条拒绝都要带可执行的说明。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  ComputeGate,
  ComputeGrantsRepo,
  ComputeJobsRepo,
  ComputeService,
  ComputeTargetsRepo,
  JOB_STATE_LABEL,
  MAX_GRANT_SCOPE,
  SAFE_SSH_OPTIONS,
  buildJobScript,
  checkSshOptions,
  clampGrantScope,
  classifyCommand,
  fetchOutputCommand,
  fillTemplate,
  grantScopeOptions,
  isTerminalJobState,
  jobPaths,
  parseNvidiaSmi,
  parseOutputs,
  parseSchedulerProbe,
  pollIntervalMs,
  sanitizeJobName,
  statusProbe,
  submitCommands,
  validateConfig,
  wrapRemoteCommand,
  type ByocTargetConfig,
  type JobSpec,
  type LocalTargetConfig,
  type ProjectStore,
  type SshTargetConfig,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 固定装置
 * ------------------------------------------------------------------ */

const SSH_CONFIG: SshTargetConfig = {
  family: 'ssh',
  host: 'hpc.example.edu',
  user: 'zhang',
  port: null,
  scheduler: 'slurm',
  remoteWorkdir: '/scratch/zhang/lsci',
  activate: 'module load python/3.11',
  partition: 'gpu',
  account: 'lab-a',
  sshOptions: {},
  hostKeyFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

const LOCAL_CONFIG: LocalTargetConfig = {
  family: 'local',
  maxConcurrent: 1,
  visibleDevices: null,
  shell: 'bash',
};

const BYOC_CONFIG: ByocTargetConfig = {
  family: 'byoc',
  platform: 'runai',
  submitTemplate: 'runai submit {{name}} --gpu {{gpus}} --file {{script}}',
  statusTemplate: 'runai describe job {{jobId}}',
  cancelTemplate: 'runai delete job {{jobId}}',
  jobIdPattern: 'job-id:\\s*(\\S+)',
  stateMap: { Pending: 'queued', Running: 'running', Succeeded: 'completed', Failed: 'failed' },
  runVia: 'local',
  endpoint: null,
};

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    name: 'fit-model',
    script: 'python fit.py',
    cpus: null,
    gpus: null,
    memoryMb: null,
    minutes: null,
    partition: null,
    account: null,
    extraDirectives: [],
    env: {},
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * 1. 危险度判定
 * ------------------------------------------------------------------ */

describe('远程命令危险度', () => {
  it('常见的查看命令判成只读', () => {
    for (const command of [
      'ls -la /scratch',
      'squeue -u zhang',
      'sinfo',
      'nvidia-smi',
      'cat /etc/hostname',
      'df -h /scratch',
      'sacct -j 12345',
      'grep -n error run.log',
      'tail -n 100 job.out',
      'module avail',
      'conda list',
      'pip list',
      'git status',
    ]) {
      expect(classifyCommand(command).risk, command).toBe('read');
    }
  });

  it('破坏性命令逐个被认出来，并说清为什么', () => {
    const cases: readonly [string, RegExp][] = [
      ['rm -rf /scratch/zhang/old', /递归|强制/u],
      ['rm --recursive data', /递归|强制/u],
      ['sudo systemctl restart slurmd', /特权/u],
      ['scancel 12345', /取消作业/u],
      ['qdel 12345', /取消作业/u],
      ['kill -9 4242', /强杀/u],
      ['chmod -R 777 /scratch', /递归改权限/u],
      ['chown -R zhang /data', /递归改所有者/u],
      ['dd if=/dev/zero of=/dev/sda', /块设备|覆盖/u],
      ['mkfs.ext4 /dev/sdb1', /格式化/u],
      ['shutdown -h now', /关机/u],
      ['git push --force origin main', /破坏性/u],
      ['find /scratch -name "*.tmp" -delete', /批量删除/u],
      ['truncate -s 0 run.log', /清空/u],
      ['crontab -r', /定时任务/u],
    ];
    for (const [command, why] of cases) {
      const verdict = classifyCommand(command);
      expect(verdict.risk, command).toBe('destructive');
      expect(verdict.reason, command).toMatch(why);
    }
  });

  it('第一段是只读也不能让整条命令变只读', () => {
    // 只看第一段是这类判定最常见的漏洞
    const verdict = classifyCommand('ls /scratch && rm -rf /scratch/old');
    expect(verdict.risk).toBe('destructive');
    expect(verdict.matched).toContain('rm');
  });

  it('写重定向让只读命令变成写操作', () => {
    expect(classifyCommand('cat a.txt').risk).toBe('read');
    expect(classifyCommand('cat a.txt > b.txt').risk).toBe('write');
    expect(classifyCommand('echo hi >> notes.md').risk).toBe('write');
    // 2>&1 不是写重定向，不该被误判
    expect(classifyCommand('squeue 2>&1').risk).toBe('read');
  });

  it('内容不可见的构造一律要问，不按只读放行', () => {
    for (const command of [
      'eval "$CMD"',
      'echo $(cat script.sh)',
      'ls `cat target`',
      'curl https://x/y | sh',
      'echo aGk= | base64 -d',
      'ls | xargs rm',
    ]) {
      const verdict = classifyCommand(command);
      expect(verdict.risk, command).not.toBe('read');
      // 判不出来的一律要问，而且要说清是因为看不见内容
      expect(verdict.reason, command).toMatch(/判不出来/u);
    }
  });

  it('子命令决定只读性：conda list 只读，conda remove 不是', () => {
    expect(classifyCommand('conda list -n lsci').risk).toBe('read');
    expect(classifyCommand('conda remove -n lsci numpy').risk).toBe('write');
    expect(classifyCommand('pip list').risk).toBe('read');
    expect(classifyCommand('pip install numpy').risk).toBe('write');
    expect(classifyCommand('conda env list').risk).toBe('read');
    expect(classifyCommand('conda env remove -n old').risk).toBe('write');
  });

  it('python 跑任意代码，只有 --version 算只读', () => {
    expect(classifyCommand('python -V').risk).toBe('read');
    expect(classifyCommand('python train.py').risk).toBe('write');
  });

  it('路径前缀与前置赋值不影响判定', () => {
    expect(classifyCommand('/usr/bin/rm -rf /data').risk).toBe('destructive');
    expect(classifyCommand('FOO=1 BAR=2 ls').risk).toBe('read');
    expect(classifyCommand('env FOO=1 rm -rf /data').risk).toBe('destructive');
    expect(classifyCommand('nohup rm -rf /data').risk).toBe('destructive');
  });

  it('不认识的命令算写而不是只读', () => {
    // 两个方向的错误代价不对称：多问一次 vs 数据没了
    const verdict = classifyCommand('my_custom_pipeline --run');
    expect(verdict.risk).toBe('write');
    expect(verdict.reason).toContain('白名单');
  });
});

/* ------------------------------------------------------------------ *
 * 2. 远程命令包装
 * ------------------------------------------------------------------ */

describe('远程命令包装', () => {
  it('用 base64 传输，因此特殊字符不被远端二次解析', () => {
    const wrapped = wrapRemoteCommand('echo "$HOME" && echo `date` | grep 2026');
    // 包装后的命令里不该出现原文的任何 shell 元字符
    expect(wrapped).not.toContain('$HOME');
    expect(wrapped).not.toContain('`');
    expect(wrapped).toContain('base64 -d');
    expect(wrapped).toContain('/bin/sh -s');
  });

  it('包装里只有 base64 字母表，单引号包住是安全的', () => {
    const wrapped = wrapRemoteCommand("rm -rf '; evil'");
    // 第一段引号是 printf 的 '%s'，第二段才是负载
    const quoted = [...wrapped.matchAll(/'([^']*)'/gu)].map((m) => m[1] ?? '');
    const encoded = quoted[1] ?? '';
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/u);
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe("rm -rf '; evil'");
  });
});

/* ------------------------------------------------------------------ *
 * 3. ssh 选项白名单
 * ------------------------------------------------------------------ */

describe('ssh 选项白名单', () => {
  it('ProxyJump 之类「怎么连上」的选项允许', () => {
    expect(checkSshOptions({ ProxyJump: 'bastion', IdentityFile: '~/.ssh/id_hpc' })).toEqual([]);
    expect(SAFE_SSH_OPTIONS).toContain('ProxyJump');
  });

  it('能撤掉安全约束的选项被逐个拒绝并说明理由', () => {
    const issues = checkSshOptions({
      StrictHostKeyChecking: 'no',
      BatchMode: 'no',
      PasswordAuthentication: 'yes',
      UserKnownHostsFile: '/dev/null',
    });
    expect(issues.map((i) => i.key).sort()).toEqual([
      'BatchMode',
      'PasswordAuthentication',
      'StrictHostKeyChecking',
      'UserKnownHostsFile',
    ]);
    expect(issues.find((i) => i.key === 'StrictHostKeyChecking')?.reason).toContain('审批');
    expect(issues.find((i) => i.key === 'BatchMode')?.reason).toContain('挂住');
  });

  it('白名单外的未知选项也拒绝，并列出可用的', () => {
    const issues = checkSshOptions({ SomethingElse: 'x' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain('ProxyJump');
  });
});

/* ------------------------------------------------------------------ *
 * 4. 作业脚本生成
 * ------------------------------------------------------------------ */

describe('作业脚本生成', () => {
  const paths = jobPaths('/scratch/zhang/lsci', 'cj_x');

  it('Slurm 指令齐全，墙钟写成 HH:MM:SS', () => {
    const script = buildJobScript({
      scheduler: 'slurm',
      spec: spec({
        cpus: 8,
        gpus: 2,
        memoryMb: 32_000,
        minutes: 150,
        partition: 'gpu',
        account: 'lab-a',
      }),
      paths,
      activate: 'module load python/3.11',
    });
    expect(script).toContain('#SBATCH --job-name=fit-model');
    expect(script).toContain('#SBATCH --partition=gpu');
    expect(script).toContain('#SBATCH --account=lab-a');
    expect(script).toContain('#SBATCH --cpus-per-task=8');
    expect(script).toContain('#SBATCH --mem=32000M');
    expect(script).toContain('#SBATCH --gres=gpu:2');
    // MM 形式在超过一天时表达不了，因此固定用 HH:MM:SS
    expect(script).toContain('#SBATCH --time=02:30:00');
    expect(script).toContain(`#SBATCH --output=${paths.stdoutPath}`);
  });

  it('PBS 的资源请求拼成一行 -l select', () => {
    const script = buildJobScript({
      scheduler: 'pbs',
      spec: spec({ cpus: 4, gpus: 1, memoryMb: 8000, minutes: 60, partition: 'workq' }),
      paths,
      activate: null,
    });
    // 分开写多个 -l 在 PBS Pro 上会互相覆盖而不报错
    expect(script).toContain('#PBS -l select=1:ncpus=4:ngpus=1:mem=8000mb');
    expect(script).toContain('#PBS -l walltime=01:00:00');
    expect(script).toContain('#PBS -q workq');
    expect(script.match(/#PBS -l select=/gu)).toHaveLength(1);
  });

  it('set -eu 在指令之后、正文之前；激活命令排在正文之前', () => {
    const script = buildJobScript({
      scheduler: 'slurm',
      spec: spec({ script: 'python fit.py' }),
      paths,
      activate: 'conda activate lsci',
    });
    const lines = script.split('\n');
    const setIdx = lines.findIndex((l) => l.trim() === 'set -eu');
    const activateIdx = lines.findIndex((l) => l.includes('conda activate lsci'));
    const bodyIdx = lines.findIndex((l) => l.trim() === 'python fit.py');
    const directiveIdx = lines.findIndex((l) => l.startsWith('#SBATCH'));

    expect(directiveIdx).toBeLessThan(setIdx);
    // 不加 set -eu 的话，中间一条命令失败后脚本照样跑完并以退出码 0 结束
    expect(setIdx).toBeGreaterThan(0);
    expect(setIdx).toBeLessThan(activateIdx);
    expect(activateIdx).toBeLessThan(bodyIdx);
  });

  it('环境变量值里的单引号被转义', () => {
    const script = buildJobScript({
      scheduler: 'none',
      spec: spec({ env: { NOTE: "it's fine" } }),
      paths,
      activate: null,
    });
    expect(script).toContain(`export NOTE='it'\\''s fine'`);
  });

  it('无调度器时不写任何调度器指令', () => {
    const script = buildJobScript({ scheduler: 'none', spec: spec(), paths, activate: null });
    expect(script).not.toContain('#SBATCH');
    expect(script).not.toContain('#PBS');
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });

  it('作业名里的危险字符被替换', () => {
    // 作业名会进远端文件名，带 ; 或空格的名字会在远端 shell 里变成两条命令
    expect(sanitizeJobName('rm -rf /; evil')).not.toMatch(/[;\s/]/u);
    expect(sanitizeJobName('睡眠分期 v2')).toBe('睡眠分期_v2');
    expect(sanitizeJobName('   ')).toBe('job');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 提交命令与作业 id 解析
 * ------------------------------------------------------------------ */

describe('提交命令', () => {
  const paths = jobPaths('/scratch/zhang/lsci', 'cj_x');

  it('Slurm 用 --parsable，只取数字 id', () => {
    const commands = submitCommands({ scheduler: 'slurm', script: '#!/bin/sh\ntrue\n', paths });
    expect(commands.command).toContain('sbatch --parsable');
    expect(commands.parseJobId('12345\n')).toBe('12345');
    // --parsable 在有 cluster 名时输出 `jobid;cluster`
    expect(commands.parseJobId('12345;cluster1\n')).toBe('12345');
    expect(commands.parseJobId('Submitted batch job 12345\n')).toBeNull();
  });

  it('PBS 的作业 id 带后缀，整串都要留着', () => {
    const commands = submitCommands({ scheduler: 'pbs', script: 'x', paths });
    // 截掉 .headnode 会让 qstat 查不到
    expect(commands.parseJobId('12345.headnode\n')).toBe('12345.headnode');
    expect(commands.parseJobId('12345\n')).toBe('12345');
  });

  it('无调度器时用 setsid 脱离 ssh 会话，并把退出码写进文件', () => {
    const commands = submitCommands({ scheduler: 'none', script: 'x', paths });
    // 不脱离的话 ssh 一断远端 shell 收到 SIGHUP，作业跟着死
    expect(commands.command).toContain('setsid');
    expect(commands.command).toContain('nohup');
    expect(commands.command).toContain(paths.exitCodePath);
    expect(commands.parseJobId('4242\n')).toBe('4242');
  });

  it('脚本经 base64 落盘，正文里的 $ 与反引号不被展开', () => {
    const commands = submitCommands({
      scheduler: 'slurm',
      script: '#!/bin/sh\necho $SLURM_JOB_ID `date`\n',
      paths,
    });
    expect(commands.command).not.toContain('$SLURM_JOB_ID');
    expect(commands.command).toContain('base64 -d');
  });
});

/* ------------------------------------------------------------------ *
 * 6. 状态解析
 * ------------------------------------------------------------------ */

describe('Slurm 状态解析', () => {
  const probe = statusProbe({
    scheduler: 'slurm',
    externalId: '12345',
    paths: jobPaths('/scratch', 'cj_x'),
  });

  /** 拼出「squeue 段 + 分隔符 + sacct 段」的输出。 */
  const out = (queue: string, acct: string): string => {
    const split = /echo '([^']+)'/u.exec(probe.command)?.[1] ?? '';
    return `${queue}\n${split}\n${acct}\n`;
  };

  it('一次往返同时问队列与历史记录', () => {
    expect(probe.command).toContain('squeue');
    expect(probe.command).toContain('sacct');
    // sacct 在没开 accounting 的集群上会报错退出，不能让整条查询失败
    expect(probe.command).toContain('|| true');
  });

  it('队列里在跑就报 running，不去看历史记录', () => {
    const reading = probe.parse(out('RUNNING', 'COMPLETED|0:0'), '');
    expect(reading.state).toBe('running');
    expect(reading.source).toBeNull();
  });

  it('PENDING 带原因也能解析', () => {
    expect(probe.parse(out('PENDING (Resources)', ''), '').state).toBe('queued');
  });

  it('队列里没有但 sacct 有：按历史记录定结论', () => {
    const done = probe.parse(out('', 'COMPLETED|0:0'), '');
    expect(done.state).toBe('completed');
    expect(done.source).toBe('accounting');
    expect(done.exitCode).toBe(0);

    const failed = probe.parse(out('', 'FAILED|1:0'), '');
    expect(failed.state).toBe('failed');
    expect(failed.exitCode).toBe(1);

    expect(probe.parse(out('', 'TIMEOUT|0:15'), '').state).toBe('timeout');
    expect(probe.parse(out('', 'OUT_OF_MEMORY|0:125'), '').state).toBe('failed');
    expect(probe.parse(out('', 'CANCELLED by 1001|0:0'), '').state).toBe('cancelled');
  });

  it('两处都查不到时报「结果不明」，不报完成', () => {
    // 报完成会让用户去读一份根本没写出来的输出
    const reading = probe.parse(out('', ''), '');
    expect(reading.state).toBe('lost');
    expect(reading.source).toBe('unavailable');
    expect(reading.detail).toContain('accounting');
    expect(reading.detail).toContain('不要假定它成功');
  });

  it('sacct 报了无法映射的状态也算不明', () => {
    const reading = probe.parse(out('', 'WEIRD_STATE|0:0'), '');
    expect(reading.state).toBe('lost');
    expect(reading.detail).toContain('WEIRD_STATE');
  });
});

describe('PBS 状态解析', () => {
  const probe = statusProbe({
    scheduler: 'pbs',
    externalId: '12345.head',
    paths: jobPaths('/scratch', 'cj_x'),
  });
  const split = /echo '([^']+)'/u.exec(probe.command)?.[1] ?? '';
  const out = (live: string, hist: string): string => `${live}\n${split}\n${hist}\n`;

  it('R 是运行，Q 是排队', () => {
    expect(probe.parse(out('job_state = R', ''), '').state).toBe('running');
    expect(probe.parse(out('job_state = Q', ''), '').state).toBe('queued');
  });

  it('F 不区分成败，必须看 Exit_status', () => {
    // 只看 job_state 会把每个失败的作业都报成「已完成」
    expect(probe.parse(out('', 'job_state = F\nExit_status = 0'), '').state).toBe('completed');
    const failed = probe.parse(out('', 'job_state = F\nExit_status = 2'), '');
    expect(failed.state).toBe('failed');
    expect(failed.exitCode).toBe(2);
    expect(probe.parse(out('', 'job_state = F\nExit_status = 271'), '').state).toBe('timeout');
  });

  it('历史记录来源标成 accounting', () => {
    const reading = probe.parse(out('', 'job_state = F\nExit_status = 0'), '');
    expect(reading.source).toBe('accounting');
  });

  it('两处都空报不明', () => {
    const reading = probe.parse(out('', ''), '');
    expect(reading.state).toBe('lost');
    expect(reading.detail).toContain('job history');
  });
});

describe('无调度器状态解析', () => {
  const paths = jobPaths('/tmp/lsci-jobs', 'cj_x');
  const probe = statusProbe({ scheduler: 'none', externalId: '4242', paths });
  const split = /echo '([^']+)'/u.exec(probe.command)?.[1] ?? '';
  const out = (alive: string, rc: string): string => `${alive}\n${split}\n${rc}\n`;

  it('先看进程在不在，再读退出码', () => {
    // 顺序反了的话，刚开始跑（.rc 不存在）与进程已死但 .rc 没写成分不开
    expect(probe.command.indexOf('kill -0')).toBeLessThan(probe.command.indexOf('cat'));
    expect(probe.parse(out('RUNNING', ''), '').state).toBe('running');
  });

  it('进程没了且有退出码：按退出码定成败', () => {
    expect(probe.parse(out('GONE', '0'), '').state).toBe('completed');
    const failed = probe.parse(out('GONE', '137'), '');
    expect(failed.state).toBe('failed');
    expect(failed.exitCode).toBe(137);
    expect(failed.source).toBe('exit-code');
  });

  it('进程没了但退出码文件也没有：不明', () => {
    const reading = probe.parse(out('GONE', ''), '');
    expect(reading.state).toBe('lost');
    expect(reading.detail).toContain('OOM');
  });
});

describe('输出与探测解析', () => {
  it('parseOutputs 按分隔符切开 stdout 与 stderr', () => {
    const paths = jobPaths('/scratch', 'cj_x');
    const command = fetchOutputCommand(paths, 0);
    const split = /echo '([^']+)'/u.exec(command)?.[1] ?? '';
    const parsed = parseOutputs(`hello\n${split}\nboom\n`);
    expect(parsed.stdout.trim()).toBe('hello');
    expect(parsed.stderr.trim()).toBe('boom');
  });

  it('调度器探测识别 slurm / pbs / 都没有', () => {
    expect(
      parseSchedulerProbe('sinfo:yes\nsbatch:yes\nqsub:no\nsacct:yes\nnvidiasmi:yes'),
    ).toMatchObject({ detected: 'slurm', hasAccounting: true, hasNvidiaSmi: true });
    expect(parseSchedulerProbe('sbatch:no\nqsub:yes\nsacct:no\nnvidiasmi:no')).toMatchObject({
      detected: 'pbs',
      hasAccounting: false,
    });
    expect(parseSchedulerProbe('sbatch:no\nqsub:no').detected).toBeNull();
  });

  it('nvidia-smi 的 CSV 输出被解析成结构', () => {
    const gpus = parseNvidiaSmi(
      '0, NVIDIA GeForce RTX 5080, 16303, 1024, 12.0, 3\n1, NVIDIA A100-SXM4-40GB, 40960, 0, 8.0, 0\n',
    );
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({ index: 0, memoryTotalMb: 16303, computeCapability: '12.0' });
    expect(gpus[1]?.name).toContain('A100');
  });

  it('老驱动不报 compute_cap 时给 null 而不是空串', () => {
    const gpus = parseNvidiaSmi('0, Tesla K80, 11441, 0, [N/A], [N/A]\n');
    expect(gpus[0]?.computeCapability).toBeNull();
    expect(gpus[0]?.utilizationPercent).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 7. 模板与配置校验
 * ------------------------------------------------------------------ */

describe('BYOC 模板', () => {
  it('占位符被替换，未提供的替换成空串', () => {
    // 留着 {{gpus}} 会把它原样传给 CLI
    expect(fillTemplate('run --gpu {{gpus}} --name {{name}}', { name: 'x' })).toBe(
      'run --gpu  --name x',
    );
    expect(fillTemplate('a {{ script }} b', { script: '/tmp/s.sh' })).toBe('a /tmp/s.sh b');
  });
});

describe('配置校验', () => {
  it('ssh 目标要绝对路径的工作目录，并说清为什么', () => {
    const result = validateConfig({ ...SSH_CONFIG, remoteWorkdir: 'work' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不同集群上不一样');
  });

  it('~ 开头的工作目录接受', () => {
    expect(validateConfig({ ...SSH_CONFIG, remoteWorkdir: '~/lsci' }).ok).toBe(true);
  });

  it('主机名里有空白直接拒', () => {
    const result = validateConfig({ ...SSH_CONFIG, host: 'a b' });
    expect(result.ok).toBe(false);
  });

  it('危险的 ssh 选项在登记时就被挡住', () => {
    const result = validateConfig({
      ...SSH_CONFIG,
      sshOptions: { StrictHostKeyChecking: 'no' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('StrictHostKeyChecking');
  });

  it('BYOC 必须有 {{script}} 与 {{jobId}}', () => {
    expect(validateConfig({ ...BYOC_CONFIG, submitTemplate: 'runai submit' }).ok).toBe(false);
    expect(validateConfig({ ...BYOC_CONFIG, statusTemplate: 'runai list' }).ok).toBe(false);
  });

  it('BYOC 的作业 id 正则必须有捕获组', () => {
    const result = validateConfig({ ...BYOC_CONFIG, jobIdPattern: 'job-id:\\s*\\S+' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('捕获组');
  });

  it('BYOC 的状态映射不能为空，理由要说出来', () => {
    const result = validateConfig({ ...BYOC_CONFIG, stateMap: {} });
    expect(result.ok).toBe(false);
    // 空映射意味着每个作业都会以「结果不明」收尾
    if (!result.ok) expect(result.reason).toContain('结果不明');
  });

  it('本地目标的并发上限至少 1', () => {
    expect(validateConfig({ ...LOCAL_CONFIG, maxConcurrent: 0 }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 8. 轮询间隔
 * ------------------------------------------------------------------ */

describe('轮询间隔', () => {
  it('刚提交问得密，跑久了拉开', () => {
    expect(pollIntervalMs(5_000, 0)).toBe(10_000);
    expect(pollIntervalMs(5 * 60_000, 0)).toBe(30_000);
    expect(pollIntervalMs(30 * 60_000, 0)).toBe(60_000);
    expect(pollIntervalMs(5 * 60 * 60_000, 0)).toBe(300_000);
  });

  it('连续失败时指数退避，但有上限——不放弃跟踪', () => {
    expect(pollIntervalMs(5_000, 1)).toBe(20_000);
    expect(pollIntervalMs(5_000, 3)).toBe(80_000);
    expect(pollIntervalMs(5 * 60 * 60_000, 10)).toBe(10 * 60_000);
  });
});

/* ------------------------------------------------------------------ *
 * 9. 授权档位
 * ------------------------------------------------------------------ */

describe('授权档位', () => {
  it('只读可以给到 always，写与作业最多到 project', () => {
    expect(MAX_GRANT_SCOPE.read).toBe('always');
    expect(MAX_GRANT_SCOPE.write).toBe('project');
    expect(MAX_GRANT_SCOPE.job).toBe('project');
  });

  it('超出上限的作用域被收敛', () => {
    expect(clampGrantScope('write', 'always')).toBe('project');
    expect(clampGrantScope('read', 'always')).toBe('always');
    expect(clampGrantScope('job', 'session')).toBe('session');
  });

  it('可选作用域不含超上限的那些', () => {
    expect(grantScopeOptions('write')).not.toContain('always');
    expect(grantScopeOptions('read')).toContain('always');
  });
});

/* ------------------------------------------------------------------ *
 * 10. 仓储
 * ------------------------------------------------------------------ */

describe('算力仓储', () => {
  let root: string;
  let store: AppStore;
  let project: ProjectStore;
  let targets: ComputeTargetsRepo;
  let jobs: ComputeJobsRepo;
  let grants: ComputeGrantsRepo;
  let projectId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-compute-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: '算力测试' });
    projectId = created.id;
    project = store.openProject(created.id);
    targets = new ComputeTargetsRepo(store.db);
    jobs = new ComputeJobsRepo(project.db);
    grants = new ComputeGrantsRepo(store.db);
  });

  afterEach(() => {
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const addTarget = (name = 'hpc1'): string =>
    targets.add({ name, family: 'ssh', config: SSH_CONFIG }).id;

  it('同名目标被拒：名字要能一眼分清是哪台机器', () => {
    addTarget();
    expect(() => addTarget()).toThrow(/同名/u);
  });

  it('按名字或 id 都能找到，名字优先', () => {
    const id = addTarget('hpc1');
    expect(targets.resolve('hpc1')?.id).toBe(id);
    expect(targets.resolve(id)?.id).toBe(id);
    expect(targets.resolve('HPC1')?.id).toBe(id);
    expect(targets.resolve('不存在')).toBeNull();
  });

  it('revision 随改动变化——需求 14.6 的廉价发现靠它', () => {
    const before = targets.revision();
    const id = addTarget();
    const after = targets.revision();
    expect(after.count).toBe(before.count + 1);
    expect(after.latest).toBeGreaterThan(0);

    targets.update(id, { notesMd: '分区叫 gpu' });
    expect(targets.revision().latest).toBeGreaterThanOrEqual(after.latest);
  });

  it('停用必须给原因', () => {
    const id = addTarget();
    expect(() => targets.setEnabled(id, false, '  ')).toThrow(/原因/u);
    targets.setEnabled(id, false, '集群在维护');
    expect(targets.get(id)?.disabledReason).toBe('集群在维护');
    expect(targets.list()).toHaveLength(0);
    expect(targets.list({ includeDisabled: true })).toHaveLength(1);
  });

  it('config_json 损坏时列表仍可用，不让整张表读不出来', () => {
    const id = addTarget();
    store.db.prepare('UPDATE compute_targets SET config_json = ? WHERE id = ?').run('{坏', id);
    // 一条坏数据不该让用户连「删掉这一条」都做不到
    expect(targets.list()).toHaveLength(1);
    expect(targets.delete(id)).toBe(true);
  });

  it('终止态必须说明结论来源', () => {
    const targetId = addTarget();
    const job = jobs.add({ targetId, name: 'j', scheduler: 'slurm', spec: spec() });
    expect(() => jobs.setState({ id: job.id, state: 'completed' })).toThrow(/来源/u);
    expect(jobs.setState({ id: job.id, state: 'running' })).toBe(true);
    expect(jobs.setState({ id: job.id, state: 'lost', terminalSource: 'unavailable' })).toBe(true);
    expect(jobs.get(job.id)?.terminalSource).toBe('unavailable');
    expect(jobs.get(job.id)?.finishedAt).not.toBeNull();
  });

  it('非终止态不留 terminalSource：「已经定论」不该变得可疑', () => {
    const targetId = addTarget();
    const job = jobs.add({ targetId, name: 'j', scheduler: 'slurm', spec: spec() });
    jobs.setState({ id: job.id, state: 'running', terminalSource: 'queue' });
    expect(jobs.get(job.id)?.terminalSource).toBeNull();
  });

  it('轮询错误与作业状态分开记，成功时清掉旧错误', () => {
    const targetId = addTarget();
    const job = jobs.add({ targetId, name: 'j', scheduler: 'slurm', spec: spec() });
    jobs.recordPoll(job.id, '连不上');
    // 「作业卡住了」与「问不到调度器」必须能分开
    expect(jobs.get(job.id)?.pollError).toBe('连不上');
    expect(jobs.get(job.id)?.pollCount).toBe(1);
    expect(jobs.get(job.id)?.state).toBe('submitted');

    jobs.recordPoll(job.id, null);
    expect(jobs.get(job.id)?.pollError).toBeNull();
    expect(jobs.get(job.id)?.pollCount).toBe(2);
  });

  it('pending 只返回未终止的', () => {
    const targetId = addTarget();
    const a = jobs.add({ targetId, name: 'a', scheduler: 'slurm', spec: spec() });
    const b = jobs.add({ targetId, name: 'b', scheduler: 'slurm', spec: spec() });
    jobs.setState({ id: b.id, state: 'completed', terminalSource: 'accounting' });

    expect(jobs.pending().map((j) => j.id)).toEqual([a.id]);
    const summary = jobs.summary({ targetId });
    expect(summary).toMatchObject({ total: 2, active: 1, completed: 1 });
  });

  it('lost 单独计数，不混进 completed 或 failed', () => {
    const targetId = addTarget();
    const job = jobs.add({ targetId, name: 'j', scheduler: 'slurm', spec: spec() });
    jobs.setState({ id: job.id, state: 'lost', terminalSource: 'unavailable' });
    const summary = jobs.summary({ targetId });
    expect(summary.lost).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('命令审计记下危险度与被拒绝的那些', () => {
    const targetId = addTarget();
    jobs.addCommand({
      targetId,
      command: 'rm -rf /data',
      risk: 'destructive',
      stderrHead: '用户拒绝',
    });
    jobs.addCommand({ targetId, command: 'ls', risk: 'read', exitCode: 0 });

    const commands = jobs.commands({ targetId });
    expect(commands).toHaveLength(2);
    // 「模型试过要执行 rm -rf 但被拒了」是事后回看最有价值的一条记录
    expect(commands.find((c) => c.risk === 'destructive')?.stderrHead).toContain('拒绝');
  });

  it('read 档接受 write 授权，反向不成立', () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'write', scope: 'project', scopeId: projectId });

    expect(grants.check({ targetId, risk: 'read', projectId })).not.toBeNull();
    expect(grants.check({ targetId, risk: 'write', projectId })).not.toBeNull();
    // 作业是另一档，不该被写授权顺带放行
    expect(grants.check({ targetId, risk: 'job', projectId })).toBeNull();
  });

  it('作用域不覆盖时不命中', () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'read', scope: 'project', scopeId: 'other-project' });
    expect(grants.check({ targetId, risk: 'read', projectId })).toBeNull();
  });

  it('写授权即使请求 always 也被收敛到 project', () => {
    const targetId = addTarget();
    const grant = grants.grant({ targetId, risk: 'write', scope: 'always' });
    expect(grant.scope).toBe('project');
    // scopeId 为 null 的 project 授权命中不了，这是调用方的责任；这里只验收敛发生了
    expect(grants.check({ targetId, risk: 'write', projectId })).toBeNull();
  });

  it('撤销是软删，审计能回答「曾被授权过什么」', () => {
    const targetId = addTarget();
    const grant = grants.grant({ targetId, risk: 'read', scope: 'always' });
    expect(grants.revoke(grant.id)).toBe(true);
    expect(grants.check({ targetId, risk: 'read', projectId })).toBeNull();
    expect(grants.list({ targetId })).toHaveLength(0);
    expect(grants.list({ targetId, includeRevoked: true })).toHaveLength(1);
  });

  it('过期的授权不命中', () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'read', scope: 'always', expiresAt: Date.now() - 1000 });
    expect(grants.check({ targetId, risk: 'read', projectId })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 11. 审批门控
 * ------------------------------------------------------------------ */

describe('审批门控', () => {
  let root: string;
  let store: AppStore;
  let project: ProjectStore;
  let projectId: string;
  let targets: ComputeTargetsRepo;
  let grants: ComputeGrantsRepo;
  let jobs: ComputeJobsRepo;
  let artifacts: ArtifactStore;

  /** 假审批服务：按 kind 决定同意还是拒绝，并记下收到的卡片。 */
  interface FakeApproval {
    request: (draft: Record<string, unknown>) => Promise<Record<string, unknown>>;
    cards: Record<string, unknown>[];
  }

  const makeApprovals = (
    decide: (draft: Record<string, unknown>) => Record<string, unknown>,
  ): FakeApproval => {
    const cards: Record<string, unknown>[] = [];
    return {
      cards,
      request: async (draft) => {
        cards.push(draft);
        return decide(draft);
      },
    };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-gate-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: '门控测试' });
    projectId = created.id;
    project = store.openProject(created.id);
    targets = new ComputeTargetsRepo(store.db);
    grants = new ComputeGrantsRepo(store.db);
    jobs = new ComputeJobsRepo(project.db);
    artifacts = new ArtifactStore(project.db, project.paths.blobs);
  });

  afterEach(() => {
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const makeService = (approvals: FakeApproval): ComputeService =>
    new ComputeService({
      projectId,
      targets,
      jobs,
      grants,
      gate: new ComputeGate({
        approvals: () => approvals as never,
        grants,
        projectId,
      }),
      artifacts,
    });

  const addTarget = (): string =>
    targets.add({
      name: 'hpc1',
      family: 'ssh',
      config: SSH_CONFIG,
      hostKeyFingerprint: SSH_CONFIG.hostKeyFingerprint,
    }).id;

  it('破坏性命令即使有 always 授权也重新问', () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'read', scope: 'always' });
    grants.grant({ targetId, risk: 'write', scope: 'project', scopeId: projectId });

    const approvals = makeApprovals(() => ({ state: 'denied', fromPriorDenial: false }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    return gate
      .authorizeCommand({
        target: targets.get(targetId) as never,
        command: 'rm -rf /scratch/old',
        purpose: '清理',
        conversationId: null,
      })
      .then((decision) => {
        // 查授权就会命中那条为了不被 ls 烦到而给的 always，于是 rm -rf 直接放行
        expect(approvals.cards).toHaveLength(1);
        expect(decision.ok).toBe(false);
        expect(decision.verdict.risk).toBe('destructive');
        // 这一档不提供持久授权
        expect(approvals.cards[0]?.scopeOptions).toEqual([]);
      });
  });

  it('只读命令有 always 授权时直接放行，不弹卡片', async () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'read', scope: 'always' });

    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    const decision = await gate.authorizeCommand({
      target: targets.get(targetId) as never,
      command: 'squeue -u zhang',
      purpose: '看排队情况',
      conversationId: null,
    });
    expect(decision.ok).toBe(true);
    expect(decision.source).toBe('existing-grant');
    expect(approvals.cards).toHaveLength(0);
  });

  it('批准并选 project 作用域时落一条授权', async () => {
    const targetId = addTarget();
    const approvals = makeApprovals(() => ({
      state: 'approved',
      scope: 'project',
      expiresAt: null,
    }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    const decision = await gate.authorizeCommand({
      target: targets.get(targetId) as never,
      command: 'mkdir -p /scratch/zhang/run1',
      purpose: '建输出目录',
      conversationId: 'conv-1',
    });
    expect(decision.ok).toBe(true);
    expect(decision.grant?.scope).toBe('project');
    expect(grants.check({ targetId, risk: 'write', projectId })).not.toBeNull();
  });

  it('显式拒绝不可重试，超时可以（需求 17.3）', async () => {
    const targetId = addTarget();

    const denied = makeApprovals(() => ({ state: 'denied', fromPriorDenial: false }));
    const deniedGate = new ComputeGate({ approvals: () => denied as never, grants, projectId });
    const a = await deniedGate.authorizeCommand({
      target: targets.get(targetId) as never,
      command: 'touch x',
      purpose: 'p',
      conversationId: null,
    });
    expect(a.retryable).toBe(false);

    const timeout = makeApprovals(() => ({ state: 'timeout', waitedMs: 1000 }));
    const timeoutGate = new ComputeGate({ approvals: () => timeout as never, grants, projectId });
    const b = await timeoutGate.authorizeCommand({
      target: targets.get(targetId) as never,
      command: 'touch x',
      purpose: 'p',
      conversationId: null,
    });
    expect(b.retryable).toBe(true);
  });

  it('作业审批卡片列出资源请求', async () => {
    const targetId = addTarget();
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    await gate.authorizeJob({
      target: targets.get(targetId) as never,
      spec: spec({ gpus: 8, minutes: 2880, memoryMb: 64_000 }),
      conversationId: null,
    });

    const card = approvals.cards[0];
    // 「提交一个作业」与「提交一个占 8 张卡跑 48 小时的作业」是两个问题
    expect(String(card?.detail)).toContain('8 GPU');
    expect(String(card?.detail)).toContain('2880 分钟');
    expect(String(card?.impact)).toContain('配额');
    expect(card?.kind).toBe('compute-job');
    // 作业不给 always：跨项目的「随便花钱」不该出现在下拉框里
    expect(card?.scopeOptions).not.toContain('always');
  });

  it('登记不提供持久授权，本地目标不弹卡片', async () => {
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    const local = await gate.authorizeRegister({
      name: 'this-pc',
      config: LOCAL_CONFIG,
      credentialRef: null,
      conversationId: null,
    });
    expect(local.ok).toBe(true);
    expect(approvals.cards).toHaveLength(0);

    await gate.authorizeRegister({
      name: 'hpc1',
      config: SSH_CONFIG,
      credentialRef: null,
      conversationId: null,
    });
    expect(approvals.cards).toHaveLength(1);
    // 「以后登记任何算力目标都不用问我」不是一个应该存在的选项
    expect(approvals.cards[0]?.scopeOptions).toEqual([]);
    expect(approvals.cards[0]?.kind).toBe('compute-target');
  });

  it('主机公钥确认标成不可逆，且不给持久授权', async () => {
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const gate = new ComputeGate({ approvals: () => approvals as never, grants, projectId });

    await gate.authorizeHostKey({
      targetName: 'hpc1',
      config: SSH_CONFIG,
      fingerprint: 'SHA256:xyz',
      keyType: 'ssh-ed25519',
      conversationId: null,
    });
    const card = approvals.cards[0];
    // 标成可逆会让用户按「反正能撤销」的心态点同意，而确认之后发出去的凭据收不回来
    expect(card?.reversible).toBe(false);
    expect(card?.scopeOptions).toEqual([]);
    expect(String(card?.detail)).toContain('SHA256:xyz');
    expect(String(card?.detail)).toContain('再连一次');
  });

  it('未确认公钥的 ssh 目标不执行命令，也不弹审批', async () => {
    const targetId = targets.add({ name: 'hpc2', family: 'ssh', config: SSH_CONFIG }).id;
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = await service.runCommand({
      targetRef: targetId,
      command: 'ls',
      purpose: '看一下',
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('主机公钥');
    // 连接根本不该发生，因此也不该为它弹卡片
    expect(approvals.cards).toHaveLength(0);
  });

  it('BYOC 目标拒绝直接执行命令并说明替代做法', async () => {
    targets.add({ name: 'cloud', family: 'byoc', config: BYOC_CONFIG });
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = await service.runCommand({
      targetRef: 'cloud',
      command: 'ls',
      purpose: '看一下',
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('写成一个作业');
  });

  it('停用的目标拒绝执行，并给出停用原因', async () => {
    const targetId = addTarget();
    targets.setEnabled(targetId, false, '集群在维护');
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = await service.runCommand({
      targetRef: targetId,
      command: 'ls',
      purpose: '看一下',
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('集群在维护');
  });

  it('找不到目标时把已登记的列出来', async () => {
    addTarget();
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = await service.runCommand({
      targetRef: 'hpc9',
      command: 'ls',
      purpose: '看一下',
      conversationId: null,
    });
    expect(result.reason).toContain('hpc1');
  });

  it('删除还有活跃作业的目标被拒', () => {
    const targetId = addTarget();
    jobs.add({ targetId, name: 'j', scheduler: 'slurm', spec: spec() });
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = service.remove(targetId);
    expect(result.ok).toBe(false);
    // 删掉目标之后平台再也问不到调度器，那些作业会永远停在当前状态
    expect(result.reason).toContain('未结束');
  });

  it('删除目标时撤销它的授权而不是让外键把记录删掉', () => {
    const targetId = addTarget();
    grants.grant({ targetId, risk: 'read', scope: 'always' });
    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = service.remove(targetId);
    expect(result.ok).toBe(true);
    expect(result.revokedGrants).toBe(1);
  });

  it('本地目标的并发上限挡住第二个作业，并解释为什么默认是 1', async () => {
    const targetId = targets.add({ name: 'this-pc', family: 'local', config: LOCAL_CONFIG }).id;
    jobs.add({ targetId, name: 'running', scheduler: 'none', spec: spec() });

    const approvals = makeApprovals(() => ({ state: 'approved', scope: 'once', expiresAt: null }));
    const service = makeService(approvals);

    const result = await service.submitJob({
      targetRef: 'this-pc',
      spec: { name: 'second', script: 'python x.py' },
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('OOM');
    // 被并发上限挡住时不该已经弹过审批卡片
    expect(approvals.cards).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 12. 状态标签
 * ------------------------------------------------------------------ */

describe('作业状态', () => {
  it('lost 有独立标签，读起来不像成功也不像失败', () => {
    expect(JOB_STATE_LABEL.lost).toBe('结果不明');
    expect(isTerminalJobState('lost')).toBe(true);
    expect(isTerminalJobState('running')).toBe(false);
    expect(isTerminalJobState('queued')).toBe(false);
  });
});
