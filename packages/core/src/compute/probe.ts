/**
 * 算力目标探测（任务 14.2，需求 14.3、14.6）。
 *
 * 探测要回答两个不同的问题，因此 `ProbeReport` 里 `reachable` 与 `usable` 是两列：
 *
 * - **连得上吗**（reachable）：网络、认证、主机公钥。
 * - **用得了吗**（usable）：调度器命令在不在、工作目录写不写得进去、GPU 认不认得出。
 *
 * 合成一个布尔的话，「ssh 通了但 sbatch 不存在」与「连不上」长得一样，而这两种情况
 * 用户要做的事完全不同：前者是选错了调度器类型，后者是网络或密钥问题。
 *
 * 探测**不抛错**。一台机器连不上是常态（不在校园网里、VPN 没开），用异常表达会让
 * 列表页在有一台机器离线时整个报错。
 */

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

import { platform } from '../platform/index.js';
import { runSupervised } from '../sandbox/supervisor.js';

import { parseSchedulerProbe, schedulerProbeCommand } from './schedulers.js';
import { detectSshClient, explainSshFailure, runSsh, scanHostKey, sshDestination } from './ssh.js';
import type {
  ByocTargetConfig,
  ComputeTargetConfig,
  GpuInfo,
  LocalTargetConfig,
  ProbeReport,
  SshTargetConfig,
} from './types.js';

/** 探测的总超时。比单条 ssh 命令的默认值短——探测要快，不然列表页会卡住。 */
const PROBE_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ *
 * GPU
 * ------------------------------------------------------------------ */

/**
 * `nvidia-smi` 的查询字段。
 *
 * 用 `--format=csv,noheader,nounits` 而不是默认的表格输出：表格输出的列宽随驱动版本
 * 与显卡名长度变化，按位置切分迟早切错。`nounits` 让 `memory.total` 是 `24564` 而不是
 * `24564 MiB`，省掉一次容易出错的单位剥离。
 */
const NVIDIA_QUERY = 'index,name,memory.total,memory.used,compute_cap,utilization.gpu';

/** nvidia-smi 表达「这块卡/这个驱动报不出这一项」的几种写法。 */
function unsupported(raw: string | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  return (
    trimmed === '' || trimmed === '[N/A]' || trimmed === 'N/A' || /not\s*supported/iu.test(trimmed)
  );
}

function numOrNull(raw: string | undefined): number | null {
  if (unsupported(raw)) return null;
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

/** 解析 `nvidia-smi --query-gpu` 的 CSV 输出。 */
export function parseNvidiaSmi(stdout: string): readonly GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const cols = trimmed.split(',').map((c) => c.trim());
    const index = numOrNull(cols[0]);
    const name = cols[1] ?? '';
    if (index === null || name === '') continue;

    gpus.push({
      index,
      name,
      memoryTotalMb: numOrNull(cols[2]),
      memoryUsedMb: numOrNull(cols[3]),
      /*
       * compute_cap 在老驱动上取不到。
       *
       * nvidia-smi 在这种情况下有三种写法：空、`[N/A]`、或
       * `[Not Supported]`。三种都要认成 null——留着 `[N/A]` 会让界面显示
       * 「算力版本 [N/A]」，而那看起来像一个真的版本号。
       */
      computeCapability: unsupported(cols[4]) ? null : (cols[4] ?? '').trim(),
      utilizationPercent: numOrNull(cols[5]),
    });
  }
  return gpus;
}

/** 本机 GPU 探测。没有 nvidia-smi 时返回空数组而不是报错——没有 GPU 是正常配置。 */
export async function detectLocalGpus(): Promise<{ gpus: readonly GpuInfo[]; detail: string }> {
  const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'nvidia-smi',
      [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 15_000 },
      (err, stdout, stderr) => {
        resolve({ ok: err === null, stdout, stderr });
      },
    );
  });

  if (!result.ok && result.stdout.trim() === '') {
    return {
      gpus: [],
      detail:
        'nvidia-smi 不可用。本机可能没有 NVIDIA GPU，或驱动未安装。' +
        'AMD 卡请用 BYOC 或 SSH 目标——平台目前只认 nvidia-smi 的输出格式。',
    };
  }

  const gpus = parseNvidiaSmi(result.stdout);
  return {
    gpus,
    detail:
      gpus.length === 0
        ? `nvidia-smi 能跑但没报告任何 GPU。${result.stderr.trim()}`
        : gpus
            .map(
              (g) =>
                `#${String(g.index)} ${g.name}` +
                (g.memoryTotalMb === null ? '' : ` ${String(g.memoryTotalMb)}MB`) +
                (g.computeCapability === null ? '' : ` sm_${g.computeCapability.replace('.', '')}`),
            )
            .join('；'),
  };
}

/* ------------------------------------------------------------------ *
 * 本地目标
 * ------------------------------------------------------------------ */

async function probeLocal(config: LocalTargetConfig): Promise<ProbeReport> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const gpu = await detectLocalGpus();

  checks.push({
    name: 'GPU',
    ok: gpu.gpus.length > 0,
    detail: gpu.detail,
  });

  /*
   * 显存与算力版本一起报。
   *
   * 只报显存不够：一块 24GB 但算力版本比工具链新的卡（比如 sm_120 遇上只编到
   * sm_90 的 CUDA 11.8）会在第一次 kernel 启动时报「no kernel image is available」，
   * 而那条错误信息不会提到版本不匹配。把 sm_ 版本摆出来，用户至少有的可查。
   */
  const adapter = platform();
  const shellOk = adapter.supportsShell(config.shell === 'bash' ? 'posix' : 'powershell');
  checks.push({
    name: 'shell',
    ok: shellOk,
    detail: shellOk
      ? `用 ${config.shell}`
      : `本机是 ${adapter.label}，用不了 ${config.shell}（可用的是 ${adapter.defaultShell}）`,
  });

  const facts: Record<string, string> = {
    platform: adapter.id,
    maxConcurrent: String(config.maxConcurrent),
  };
  if (config.visibleDevices !== null) facts['visibleDevices'] = config.visibleDevices;

  return {
    at: Date.now(),
    reachable: true,
    usable: shellOk,
    summary: shellOk
      ? gpu.gpus.length > 0
        ? `本机可用，${String(gpu.gpus.length)} 块 GPU`
        : '本机可用，没有可用的 NVIDIA GPU（CPU 作业仍可提交）'
      : `本机 shell 配置不可用：${config.shell}`,
    checks,
    gpus: gpu.gpus,
    scheduler: 'none',
    facts,
    pendingHostKey: null,
  };
}

/* ------------------------------------------------------------------ *
 * SSH 目标
 * ------------------------------------------------------------------ */

/**
 * SSH 目标探测。
 *
 * 顺序刻意如此：客户端 → 主机公钥 → 连通与认证 → 远端能力。前一步不成立时**不做**
 * 后一步，因为后面的失败会掩盖真正的原因。最典型的是主机公钥没确认时去跑调度器
 * 探测，得到的报告是「sbatch 不存在」——而真正的问题跟 sbatch 毫无关系。
 */
async function probeSsh(config: SshTargetConfig): Promise<ProbeReport> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const at = Date.now();
  const dest = sshDestination(config);

  const client = await detectSshClient();
  checks.push({
    name: 'ssh 客户端',
    ok: client.available,
    detail: client.available ? (client.version ?? '可用') : '本机没有 ssh 客户端',
  });
  if (!client.available) {
    return {
      at,
      reachable: false,
      usable: false,
      summary: '本机没有 ssh 客户端，无法连接任何远程目标',
      checks,
      gpus: [],
      scheduler: null,
      facts: {},
      pendingHostKey: null,
    };
  }

  checks.push({
    name: '主机公钥',
    ok: config.hostKeyFingerprint !== null,
    detail:
      config.hostKeyFingerprint === null
        ? '还没确认过。确认之前不会连接——首次连接自动信任正是中间人需要的窗口。'
        : config.hostKeyFingerprint,
  });

  const probe = await runSsh({
    config,
    script: schedulerProbeCommand(),
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (!probe.ok) {
    /*
     * host-key 失败时顺手取回指纹。
     *
     * 不取的话用户看到「主机公钥未通过验证」之后还要自己去跑 ssh-keyscan，而那正是
     * 平台该替他做的部分——需要他做的只有核对那串指纹。
     */
    let pendingHostKey: ProbeReport['pendingHostKey'] = null;
    if (probe.connectionError === 'host-key' || config.hostKeyFingerprint === null) {
      const scan = await scanHostKey(config);
      if (scan.ok && scan.fingerprint !== null && scan.raw !== null) {
        pendingHostKey = {
          fingerprint: scan.fingerprint,
          keyType: scan.keyType ?? 'unknown',
          raw: scan.raw,
        };
      }
    }

    checks.push({
      name: '连接',
      ok: false,
      detail:
        probe.connectionError === null
          ? probe.stderr.trim() || '连接失败但 ssh 没有给出原因'
          : explainSshFailure(probe.connectionError, config, probe.stderr),
    });

    return {
      at,
      reachable: false,
      usable: false,
      summary: `连不上 ${dest}：${probe.connectionError ?? 'unknown'}`,
      checks,
      gpus: [],
      scheduler: null,
      facts: {},
      pendingHostKey,
    };
  }

  checks.push({ name: '连接', ok: true, detail: `${dest} 可达，公钥认证通过` });

  const caps = parseSchedulerProbe(probe.stdout);
  const schedulerOk = config.scheduler === 'none' || caps.detected === config.scheduler;

  checks.push({
    name: '调度器',
    ok: schedulerOk,
    detail: schedulerOk
      ? config.scheduler === 'none'
        ? '按无调度器使用（直接跑命令）'
        : `${config.scheduler} 可用`
      : caps.detected === null
        ? `配置写的是 ${config.scheduler}，但远端既没有 sbatch 也没有 qsub。` +
          '若这台机器本来就没有调度器，把类型改成 none。'
        : `配置写的是 ${config.scheduler}，但远端装的是 ${caps.detected}。`,
  });

  /*
   * accounting 缺失只是警告而不是不可用。
   *
   * 没有 sacct 的集群照样能提交与运行作业，只是作业结束后我们无法拿到成败——
   * 那些作业会以 `lost` 收尾。这件事必须**提前**说，而不是等用户跑完一个八小时的
   * 作业才发现结果查不到。
   */
  if (config.scheduler === 'slurm') {
    checks.push({
      name: '作业历史（sacct）',
      ok: caps.hasAccounting,
      detail: caps.hasAccounting
        ? 'sacct 可用，作业结束后能拿到成败与退出码'
        : 'sacct 不可用。作业能提交也能跑，但结束之后平台拿不到它的成败——' +
          '那些作业会以「结果不明」收尾。这不是平台的缺陷，是集群没开 accounting。',
    });
  }

  const workdirCheck = await runSsh({
    config,
    script: [
      `mkdir -p '${config.remoteWorkdir}' 2>/dev/null || true`,
      `if [ -w '${config.remoteWorkdir}' ]; then echo WRITABLE; else echo NO; fi`,
      `df -P '${config.remoteWorkdir}' 2>/dev/null | tail -n 1 || true`,
    ].join('; '),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const writable = workdirCheck.stdout.includes('WRITABLE');
  checks.push({
    name: '工作目录',
    ok: writable,
    detail: writable
      ? `${config.remoteWorkdir} 可写。${workdirCheck.stdout.split('\n').slice(1).join(' ').trim()}`
      : `${config.remoteWorkdir} 不可写或建不出来。作业脚本与输出都要落在这里，` +
        '不可写的话提交一定失败。常见原因是把路径写成了 /home 之外的只读挂载点。',
  });

  let gpus: readonly GpuInfo[] = [];
  if (caps.hasNvidiaSmi) {
    const gpuProbe = await runSsh({
      config,
      script: `nvidia-smi --query-gpu=${NVIDIA_QUERY} --format=csv,noheader,nounits 2>/dev/null || true`,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    gpus = parseNvidiaSmi(gpuProbe.stdout);
  }
  checks.push({
    name: 'GPU',
    ok: true,
    detail: caps.hasNvidiaSmi
      ? gpus.length === 0
        ? // 登录节点通常没有 GPU，计算节点才有——这不是问题
          '登录节点上 nvidia-smi 没报告 GPU。集群通常只在计算节点上有卡，这是正常的。'
        : gpus.map((g) => `#${String(g.index)} ${g.name}`).join('；')
      : '远端没有 nvidia-smi。若这是纯 CPU 集群则属正常。',
  });

  const facts: Record<string, string> = {
    host: config.host,
    scheduler: config.scheduler,
    remoteWorkdir: config.remoteWorkdir,
  };
  if (caps.detected !== null) facts['detectedScheduler'] = caps.detected;
  facts['accounting'] = caps.hasAccounting ? 'available' : 'missing';

  const usable = schedulerOk && writable;
  return {
    at,
    reachable: true,
    usable,
    summary: usable
      ? `${dest} 可用（${config.scheduler === 'none' ? '无调度器' : config.scheduler}${
          gpus.length > 0 ? `，${String(gpus.length)} 块 GPU` : ''
        }）`
      : `${dest} 连得上但用不了：${checks
          .filter((c) => !c.ok)
          .map((c) => c.name)
          .join('、')}`,
    checks,
    gpus,
    scheduler: config.scheduler,
    facts,
    pendingHostKey: null,
  };
}

/* ------------------------------------------------------------------ *
 * BYOC
 * ------------------------------------------------------------------ */

/**
 * BYOC 探测。
 *
 * 只能检查**形式**上的东西：模板里的占位符是否齐、状态映射是否非空、要用的可执行
 * 文件在不在。真正的可用性要等第一次提交才知道，因此 summary 里要如实说这一点，
 * 而不是让一个「探测通过」给出它撑不起的保证。
 */
async function probeByoc(config: ByocTargetConfig): Promise<ProbeReport> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const at = Date.now();

  const hasScript = config.submitTemplate.includes('{{script}}');
  checks.push({
    name: '提交模板',
    ok: hasScript,
    detail: hasScript
      ? config.submitTemplate
      : '提交模板里没有 {{script}} 占位符。没有它平台无法把作业脚本交给平台。',
  });

  const hasJobId = config.statusTemplate.includes('{{jobId}}');
  checks.push({
    name: '查询模板',
    ok: hasJobId,
    detail: hasJobId
      ? config.statusTemplate
      : '查询模板里没有 {{jobId}} 占位符，无法查询具体作业。',
  });

  let patternOk = false;
  let patternDetail = '';
  try {
    const re = new RegExp(config.jobIdPattern, 'u');
    patternOk = /\([^?]/u.test(config.jobIdPattern);
    patternDetail = patternOk
      ? `/${re.source}/`
      : '正则里没有捕获组。平台要靠捕获组从提交输出里取作业 id。';
  } catch (err) {
    patternDetail = `作业 id 正则无法编译：${err instanceof Error ? err.message : String(err)}`;
  }
  checks.push({ name: '作业 id 正则', ok: patternOk, detail: patternDetail });

  const mapSize = Object.keys(config.stateMap).length;
  checks.push({
    name: '状态映射',
    ok: mapSize > 0,
    detail:
      mapSize > 0
        ? `${String(mapSize)} 条映射：${Object.entries(config.stateMap)
            .slice(0, 8)
            .map(([k, v]) => `${k}→${v}`)
            .join('、')}`
        : '状态映射为空。映射不到的状态会被记成「结果不明」——平台不猜，' +
          '因为猜错的方向是把还在跑的作业当成完成，然后去读一份没写出来的输出。',
  });

  /*
   * 检查可执行文件在不在。
   *
   * 取模板的第一个词。这是个近似（模板可能以 `env FOO=1 aws ...` 开头），但它能挡住
   * 最常见的一种失败：CLI 根本没装。近似判断报错时说清它是近似的。
   */
  const firstWord = config.submitTemplate.trim().split(/\s+/u)[0] ?? '';
  if (config.runVia === 'local' && firstWord !== '' && !firstWord.includes('{{')) {
    const found = await new Promise<boolean>((resolve) => {
      const probe = platform().whichCommand(firstWord);
      execFile(probe.command, [...probe.args], { windowsHide: true, timeout: 8000 }, (err) => {
        resolve(err === null);
      });
    });
    checks.push({
      name: `可执行文件 ${firstWord}`,
      ok: found,
      detail: found
        ? '在 PATH 里'
        : `${firstWord} 不在 PATH 里。这是按模板第一个词做的近似判断——` +
          '若你的模板以环境变量赋值开头，这条可以忽略。',
    });
  }

  const formOk = checks.every((c) => c.ok);
  return {
    at,
    reachable: true,
    usable: formOk,
    summary: formOk
      ? `${config.platform} 的模板形式检查通过。真正的可用性要等第一次提交才知道——` +
        '平台只校验占位符与映射，命令本身由你负责。'
      : `${config.platform} 的模板有问题：${checks
          .filter((c) => !c.ok)
          .map((c) => c.name)
          .join('、')}`,
    checks,
    gpus: [],
    scheduler: null,
    facts: {
      platform: config.platform,
      runVia: config.runVia === 'local' ? 'local' : `ssh:${config.runVia.targetId}`,
      ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
    },
    pendingHostKey: null,
  };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function probeTarget(config: ComputeTargetConfig): Promise<ProbeReport> {
  try {
    switch (config.family) {
      case 'local':
        return await probeLocal(config);
      case 'ssh':
        return await probeSsh(config);
      case 'byoc':
        return await probeByoc(config);
      default:
        return {
          at: Date.now(),
          reachable: false,
          usable: false,
          summary: `未知的目标类型：${String((config as { family?: unknown }).family)}`,
          checks: [],
          gpus: [],
          scheduler: null,
          facts: {},
          pendingHostKey: null,
        };
    }
  } catch (err) {
    // 探测不抛错：一台机器的探测崩了不该让整个列表报错
    return {
      at: Date.now(),
      reachable: false,
      usable: false,
      summary: `探测过程本身出错：${err instanceof Error ? err.message : String(err)}`,
      checks: [],
      gpus: [],
      scheduler: null,
      facts: {},
      pendingHostKey: null,
    };
  }
}

/** 本机 shell 探测结果，供「要不要建一个本地目标」的引导用。 */
export async function suggestLocalTarget(): Promise<{
  gpus: readonly GpuInfo[];
  detail: string;
  config: LocalTargetConfig;
}> {
  const gpu = await detectLocalGpus();
  return {
    gpus: gpu.gpus,
    detail: gpu.detail,
    config: {
      family: 'local',
      // 默认 1：两个并行的训练作业通常是双双 OOM 而不是各跑一半速度
      maxConcurrent: 1,
      visibleDevices: null,
      shell: platform().defaultShell === 'powershell' ? 'powershell' : 'bash',
    },
  };
}

/** 用一次极短的 ssh 往返测活。列表页刷新时用它，比完整探测快得多。 */
export async function pingSsh(config: SshTargetConfig): Promise<{ ok: boolean; detail: string }> {
  const result = await runSsh({ config, script: 'echo ok', timeoutMs: 15_000 });
  if (result.ok) return { ok: true, detail: 'ok' };
  return {
    ok: false,
    detail:
      result.connectionError === null
        ? result.stderr.trim() || '连接失败'
        : explainSshFailure(result.connectionError, config, result.stderr),
  };
}

/**
 * 本机默认用哪种 shell，用 `runLocalShell` 认的取值表示。
 *
 * 存在的理由是**只做一次映射**。在这之前，「判一下是不是 Windows，是就 powershell
 * 否则 bash」这句三元在 envs 与 compute 里出现了五遍；五遍都对的时候它只是重复，而
 * 其中一遍写反的时候没有任何编译信号——那一处会在非 Windows 上去起 powershell。
 */
export function defaultLocalShell(): 'powershell' | 'bash' {
  return platform().defaultShell === 'powershell' ? 'powershell' : 'bash';
}

/**
 * 本机 shell 执行（本地目标与 BYOC 的 `runVia: 'local'` 用它）。
 *
 * 命令构造走平台适配层（需求 20.4.1）：PowerShell 的 `-EncodedCommand` 与输出编码
 * 前导都在那一层。以前这段是内联的，而它与 `sandbox/native.ts`、`envs/service.ts`
 * 各有一份——三份里有两份漏了完整的编码前导，表现是中文输出乱码。
 */
export async function runLocalShell(input: {
  command: string;
  /**
   * shell 种类沿用 `'bash'` 而不是平台层的 `'posix'`。
   *
   * 这个取值出现在**已落库的** `LocalTargetConfig.shell` 里（compute_targets 的
   * config_json）。改名意味着要给一条迁移只为了换一个字符串，而映射在边界上做一次
   * 就够了。
   */
  shell: 'powershell' | 'bash';
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}): Promise<{
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}> {
  const adapter = platform();
  const invocation = adapter.shellInvocation({
    family: input.shell === 'bash' ? 'posix' : 'powershell',
    command: input.command,
  });
  if (invocation === null) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr:
        `当前平台（${adapter.label}）起不了 ${input.shell}。` +
        `可用的是 ${adapter.defaultShell}。`,
      truncated: false,
      timedOut: false,
      durationMs: 0,
    };
  }

  const result = await runSupervised({
    command: invocation.command,
    args: invocation.args,
    cwd: input.cwd ?? tmpdir(),
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs ?? 120_000,
    maxOutputBytes: 1024 * 1024,
  });

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
}
