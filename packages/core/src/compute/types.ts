/**
 * 算力目标与作业的类型定义（任务 14.2，需求 14.3、14.4、14.6、14.7）。
 *
 * 三类目标（本地 / SSH / BYOC）共用一套作业模型，但**能力不同**，因此配置按
 * `family` 做判别联合而不是一张什么都有的可选字段表。可选字段表的问题很具体：
 * `partition` 对本地目标没有意义，而一张平表允许它被填上，于是「为什么我设了分区
 * 却没生效」变成一个无法从类型上看出答案的问题。
 */

/** 目标类别。 */
export type ComputeFamily = 'local' | 'ssh' | 'byoc';

/** 远端作业调度器。`none` 表示直接跑命令（裸机或单机 GPU 服务器）。 */
export type SchedulerKind = 'none' | 'slurm' | 'pbs';

/**
 * 作业状态。
 *
 * `lost` 是这套状态机里最重要的一档：调度器不再报告这个作业，而历史记录
 * （`sacct` / `qstat -x`）不可用或查不到。此时**结果不明**——它可能成功、可能被
 * 管理员杀了、可能节点掉了。
 *
 * 把它并进 `completed` 是最省事也最坏的做法：用户会拿一份不存在的输出继续往下做。
 * 并进 `failed`同样不对：它会让用户去排查一个可能根本没发生的失败。这与引文核实
 * 里 `not-found` 与 `unverifiable` 必须分开是同一条道理——「查不到」不是一种结论。
 */
export type JobState =
  /** 命令已发出，调度器还没回执 */
  | 'submitted'
  | 'queued'
  | 'running'
  /** 明确成功（退出码 0 / 调度器报 COMPLETED） */
  | 'completed'
  /** 明确失败（非零退出 / FAILED / NODE_FAIL / OUT_OF_MEMORY） */
  | 'failed'
  | 'cancelled'
  /** 超墙钟被调度器杀掉 */
  | 'timeout'
  /** 调度器不再报告它，且拿不到历史记录——结果不明 */
  | 'lost';

/** 终止态。到了这里就不再轮询。 */
export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'lost',
];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export const JOB_STATE_LABEL: Readonly<Record<JobState, string>> = {
  submitted: '已提交',
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时被终止',
  lost: '结果不明',
};

/* ------------------------------------------------------------------ *
 * 目标配置
 * ------------------------------------------------------------------ */

export interface LocalTargetConfig {
  family: 'local';
  /**
   * 同时允许跑几个作业。
   *
   * 本地目标共用一台机器的显存与内存，两个并行的训练作业通常是双双 OOM 而不是
   * 各跑一半速度。默认 1。
   */
  maxConcurrent: number;
  /** 限制可见的 GPU（写进 `CUDA_VISIBLE_DEVICES`）。null 表示不限制。 */
  visibleDevices: string | null;
  shell: 'powershell' | 'bash';
}

export interface SshTargetConfig {
  family: 'ssh';
  /**
   * 主机。**可以是 `~/.ssh/config` 里的 Host 别名**。
   *
   * 支持别名是刻意的：实验室集群的接入方式常常是「先跳板机再登录节点」，而那套
   * ProxyJump / IdentityFile / Match 配置用户早就写好了。要求他在这里重新填一遍
   * 等于把已经能用的配置作废，而且填漏一项的表现是连不上但看不出为什么。
   */
  host: string;
  user: string | null;
  port: number | null;
  scheduler: SchedulerKind;
  /** 远端工作目录。作业脚本、stdout/stderr 都落在这里。 */
  remoteWorkdir: string;
  /** 提交作业前先执行的环境激活命令（`module load` / `conda activate`）。 */
  activate: string | null;
  partition: string | null;
  account: string | null;
  /** 额外 ssh 选项。只接受白名单内的键，见 `ssh.ts` 的 `SAFE_SSH_OPTIONS`。 */
  sshOptions: Readonly<Record<string, string>>;
  /**
   * 已由用户确认过的主机公钥指纹。
   *
   * null 表示还没确认。**不确认就不连**：`StrictHostKeyChecking=no` 等于对中间人
   * 完全不设防，而这条通道上要跑的是凭据与研究数据。
   */
  hostKeyFingerprint: string | null;
}

/**
 * BYOC（用户自带云算力）。
 *
 * 刻意**不绑定任何一家云的 SDK**，而是让用户给出三条命令模板。理由：绑 SDK 会把
 * 「自带云算力」变成「自带我们支持的那家云」，而需求 14.3 说的是用户自己的算力。
 * 命令模板的覆盖面是「任何有 CLI 或能用 curl 提交作业的云」，包括机构自建的
 * Kubernetes/Run:ai/Volcano 这类不会有专用 SDK 的平台。
 *
 * 代价要说清楚：模板由用户负责正确，平台只做占位符替换与状态映射。
 */
export interface ByocTargetConfig {
  family: 'byoc';
  /** 供人识别的平台名（`aws-batch`、`gcp-vertex`、`runai`……）。 */
  platform: string;
  /**
   * 提交命令模板。占位符：`{{script}}`（远端/本地脚本路径）、`{{name}}`、
   * `{{cpus}}`、`{{gpus}}`、`{{memoryMb}}`、`{{minutes}}`、`{{workdir}}`。
   */
  submitTemplate: string;
  /** 查询命令模板。占位符：`{{jobId}}`。 */
  statusTemplate: string;
  /** 取消命令模板。占位符：`{{jobId}}`。为空表示这个平台不支持取消。 */
  cancelTemplate: string | null;
  /** 从提交输出里抓作业 id 的正则（需要一个捕获组）。 */
  jobIdPattern: string;
  /**
   * 平台状态字符串 → 本平台状态。键不区分大小写。
   *
   * 映射不到的状态**不猜**，记成 `lost` 并把原文留在 detail 里：猜错的方向是
   * 把一个还在跑的作业当成完成，然后去读一份还没写出来的输出。
   */
  stateMap: Readonly<Record<string, JobState>>;
  /** 模板在哪执行：本机，或另一个已登记的 ssh 目标 id。 */
  runVia: 'local' | { targetId: string };
  /** 平台端点。只用于展示与域名门提示，不参与命令构造。 */
  endpoint: string | null;
}

export type ComputeTargetConfig = LocalTargetConfig | SshTargetConfig | ByocTargetConfig;

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/** 一块 GPU 的探测结果。 */
export interface GpuInfo {
  index: number;
  name: string;
  memoryTotalMb: number | null;
  memoryUsedMb: number | null;
  /** 驱动报告的算力版本（`8.9`）。null 表示拿不到。 */
  computeCapability: string | null;
  utilizationPercent: number | null;
}

/**
 * 目标探测报告。
 *
 * `reachable` 与 `usable` 分开：一台 ssh 能连上但调度器命令不存在的机器是
 * 「连得上但用不了」，而这两种情况的补救动作完全不同。
 */
export interface ProbeReport {
  at: number;
  reachable: boolean;
  usable: boolean;
  /** 一句话结论，直接给用户看。 */
  summary: string;
  /** 逐项检查。失败项要能自己解释。 */
  checks: readonly { name: string; ok: boolean; detail: string }[];
  gpus: readonly GpuInfo[];
  scheduler: SchedulerKind | null;
  /** 调度器版本、分区列表这类只对这个目标有意义的事实。 */
  facts: Readonly<Record<string, string>>;
  /**
   * 未确认的主机公钥指纹。
   *
   * 只在「连不上是因为 host key 没确认过」时非空。它要经用户审批才能写进配置，
   * 因此探测阶段只是把它取回来给审批卡片用。
   */
  pendingHostKey: { fingerprint: string; keyType: string; raw: string } | null;
}

/* ------------------------------------------------------------------ *
 * 作业
 * ------------------------------------------------------------------ */

/** 提交一个作业要说清的东西。 */
export interface JobSpec {
  /** 作业名。进调度器的 job name，也用于生成远端脚本文件名。 */
  name: string;
  /** 要跑的脚本正文（bash / powershell，按目标决定）。 */
  script: string;
  cpus: number | null;
  gpus: number | null;
  memoryMb: number | null;
  /** 墙钟上限（分钟）。调度器几乎都要求它，不给会用队列默认值。 */
  minutes: number | null;
  partition: string | null;
  account: string | null;
  /** 额外的调度器指令行，原样插进脚本头部。 */
  extraDirectives: readonly string[];
  /** 环境变量。 */
  env: Readonly<Record<string, string>>;
}

export interface JobRecordLike {
  id: string;
  targetId: string;
  state: JobState;
  externalId: string | null;
}
