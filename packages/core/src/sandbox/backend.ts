/**
 * 沙箱后端抽象。
 *
 * 两种实现（native / wsl2）的隔离强度差异很大，因此 `IsolationReport.caveats` 不是装饰——
 * 设计目标里的「诚实降级」要求它原文透出到 UI。任何在传递过程中裁剪或美化
 * caveats 的做法都违背这条。
 */

export type SandboxBackendId = 'native' | 'wsl2';

export type FilesystemIsolation =
  /** 独立命名空间，越界在内核层被阻止 */
  | 'namespace'
  /** 操作系统 ACL */
  | 'acl'
  /** 仅靠工具层路径校验，恶意代码可绕过 */
  | 'advisory';

export type NetworkIsolation =
  /** 独立网络命名空间，出口在内核层受控 */
  | 'namespace'
  /** 注入代理环境变量，代码可直接建 socket 绕过 */
  | 'proxy'
  | 'none';

export type ProcessIsolation =
  | 'container'
  /** Windows Job Object：需要原生 API，当前实现拿不到 */
  | 'job-object'
  /** 轮询监控 + 进程树终止：能兜住失控进程，但不是硬限额 */
  | 'monitor'
  | 'none';

export interface IsolationReport {
  backend: SandboxBackendId;
  filesystem: FilesystemIsolation;
  network: NetworkIsolation;
  process: ProcessIsolation;
  resourceLimits: {
    cpuPercent?: number;
    memoryMb?: number;
    wallClockSec?: number;
  };
  /** 必须在 UI 上原文展示，不得裁剪。 */
  caveats: readonly string[];
}

export type ShellKind = 'powershell' | 'bash';

export interface ShellSpec {
  command: string;
  /** 工作目录。必须已通过 PathGuard 校验。 */
  cwd: string;
  shell?: ShellKind;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** 输出上限。超出后截断并标注，而不是无界缓冲。 */
  maxOutputBytes?: number;
}

export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 输出是否被截断。UI 必须显示这一点，否则用户会以为看到了全部。 */
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  readonly isolation: IsolationReport;

  runShell(spec: ShellSpec): Promise<ShellResult>;

  /** 把宿主路径翻译成该后端内可用的路径（WSL 下需要 /mnt/c 形式）。 */
  toGuestPath(hostPath: string): string;

  /** 是否支持指定的 shell 种类。 */
  supportsShell(kind: ShellKind): boolean;

  dispose(): Promise<void>;
}

/** 供 UI 展示的隔离强度分级。 */
export function isolationStrength(report: IsolationReport): 'strong' | 'weak' {
  return report.filesystem === 'namespace' && report.network === 'namespace' ? 'strong' : 'weak';
}
