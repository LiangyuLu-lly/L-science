/**
 * 算力目标与作业（任务 14.2，需求 14.3、14.4、14.6、14.7）。
 *
 * 分层：`types` 是数据形状，`ssh` / `schedulers` / `probe` 是与外部世界打交道的三块
 * （全部可单独测），`risk` + `gate` 是审批门控，`service` 把它们串起来并管作业跟踪，
 * `tools` 是模型面。
 */

export type {
  ByocTargetConfig,
  ComputeFamily,
  ComputeTargetConfig,
  GpuInfo,
  JobRecordLike,
  JobSpec,
  JobState,
  LocalTargetConfig,
  ProbeReport,
  SchedulerKind,
  SshTargetConfig,
} from './types.js';
export { JOB_STATE_LABEL, TERMINAL_JOB_STATES, isTerminalJobState } from './types.js';

export type { CommandRisk, RiskVerdict } from './risk.js';
export { RISK_LABEL, classifyCommand, riskRank } from './risk.js';

export type { HostKeyScan, SshConnectionError, SshOptionIssue, SshResult } from './ssh.js';
export {
  DEFAULT_SSH_TIMEOUT_MS,
  SAFE_SSH_OPTIONS,
  checkSshOptions,
  classifySshFailure,
  detectSshClient,
  explainSshFailure,
  resetSshClientCache,
  runSsh,
  scanHostKey,
  sshClientRemediation,
  sshDestination,
  trustHostKey,
  wrapRemoteCommand,
} from './ssh.js';

export type { JobPaths, StatusProbe, StatusReading, SubmitCommands } from './schedulers.js';
export {
  buildJobScript,
  cancelCommand,
  fetchOutputCommand,
  jobPaths,
  parseOutputs,
  parseSchedulerProbe,
  sanitizeJobName,
  schedulerProbeCommand,
  statusProbe,
  submitCommands,
} from './schedulers.js';

export {
  defaultLocalShell,
  detectLocalGpus,
  parseNvidiaSmi,
  pingSsh,
  probeTarget,
  runLocalShell,
  suggestLocalTarget,
} from './probe.js';

export type { ComputeGateDeps, GateDecision } from './gate.js';
export { ComputeGate, describeTarget } from './gate.js';

export type { ComputeServiceDeps, JobEvent, RunCommandResult, SubmitResult } from './service.js';
export {
  ComputeService,
  fillTemplate,
  normalizeSpec,
  pollIntervalMs,
  renderCommandResult,
  validateConfig,
  worstRisk,
} from './service.js';

export type {
  ComputeAction,
  ComputeToolInput,
  ComputeToolOptions,
  RemoteCommandInput,
  SubmitJobInput,
} from './tools.js';
export {
  createManageComputeTool,
  createRunRemoteCommandTool,
  createSubmitJobTool,
} from './tools.js';
