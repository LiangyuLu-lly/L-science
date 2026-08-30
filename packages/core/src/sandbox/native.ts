/**
 * `native` 沙箱后端：不依赖容器或虚拟机，在用户态尽力隔离。
 *
 * 实际强度必须如实透出（`IsolationReport.caveats`），因为它与 `wsl2` 差得远：
 * 文件系统边界只靠工具层的路径校验，网络出口只靠注入代理环境变量——两者都能被
 * 有意为之的代码绕过。它的价值是零安装可用，以及在 Job Object 支持下能兜住
 * 「失控」而非「恶意」。
 */

import { platform } from '../platform/index.js';
import { nativeCapabilities } from '../win32/index.js';
import type {
  IsolationReport,
  SandboxBackend,
  ShellKind,
  ShellResult,
  ShellSpec,
} from './backend.js';
import { runSupervised } from './supervisor.js';

export interface NativeBackendOptions {
  /** 默认资源限额，可被单次调用覆盖。 */
  defaults?: {
    memoryMb?: number;
    wallClockSec?: number;
    maxOutputBytes?: number;
  };
  /** 本地转发代理地址。设置后注入到子进程环境。 */
  proxyUrl?: string;
  /** 不经代理的主机列表。 */
  noProxy?: readonly string[];
}

const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_WALL_CLOCK_SEC = 600;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 构造 native 后端的隔离报告。
 *
 * 单独导出是因为有第二个调用方：`sandbox.isolation` 这个 IPC 要在还没打开任何
 * 项目时就回答「当前隔离强度是什么」。让它自己拼一份报告的话，两份实现迟早
 * 分歧——而分歧的表现是 UI 上的隔离徽章与执行平面的实际管控不一致，也就是
 * 「诚实降级」这条设计目标正好失效的地方。
 */
export function nativeIsolationReport(opts: {
  proxyEnabled: boolean;
  memoryMb?: number;
  wallClockSec?: number;
}): IsolationReport {
  const caps = nativeCapabilities();
  const memoryMb = opts.memoryMb ?? DEFAULT_MEMORY_MB;
  const wallClockSec = opts.wallClockSec ?? DEFAULT_WALL_CLOCK_SEC;

  const caveats = [
    '文件系统边界只由工具层的路径校验保证；内核或 shell 里的代码可以绕过工具直接访问任意路径',
    opts.proxyEnabled
      ? '网络出口只靠注入代理环境变量；代码可以直接建 socket 绕过'
      : '未启用出口代理：执行平面的网络访问不受管控',
    '没有 CPU 配额，只有墙钟上限',
    ...caps.notes,
  ];
  if (caps.jobObject) {
    caveats.push(
      '内存限额与「退出不留孤儿」由 Windows Job Object 内核级强制执行（含 KILL_ON_JOB_CLOSE）',
    );
  }

  return {
    backend: 'native',
    filesystem: 'advisory',
    network: opts.proxyEnabled ? 'proxy' : 'none',
    process: caps.jobObject ? 'job-object' : 'monitor',
    resourceLimits: { memoryMb, wallClockSec },
    caveats,
  };
}

export class NativeBackend implements SandboxBackend {
  readonly id = 'native' as const;
  readonly isolation: IsolationReport;

  readonly #opts: NativeBackendOptions;
  readonly #wslAvailable: boolean;

  constructor(opts: NativeBackendOptions & { wslAvailable?: boolean } = {}) {
    this.#opts = opts;
    this.#wslAvailable = opts.wslAvailable ?? false;

    this.isolation = nativeIsolationReport({
      proxyEnabled: opts.proxyUrl !== undefined,
      ...(opts.defaults?.memoryMb === undefined ? {} : { memoryMb: opts.defaults.memoryMb }),
      ...(opts.defaults?.wallClockSec === undefined
        ? {}
        : { wallClockSec: opts.defaults.wallClockSec }),
    });
  }

  supportsShell(kind: ShellKind): boolean {
    return kind === 'powershell' || (kind === 'bash' && this.#wslAvailable);
  }

  /** native 后端直接在宿主上跑，路径无需翻译。 */
  toGuestPath(hostPath: string): string {
    return hostPath;
  }

  async runShell(spec: ShellSpec): Promise<ShellResult> {
    const kind = spec.shell ?? 'powershell';
    if (!this.supportsShell(kind)) {
      throw new Error(
        kind === 'bash'
          ? 'bash 不可用：需要已安装 WSL2 发行版。可执行 wsl --install -d Ubuntu（需管理员 + 重启）'
          : `不支持的 shell：${kind}`,
      );
    }

    const timeoutMs =
      spec.timeoutMs ?? (this.#opts.defaults?.wallClockSec ?? DEFAULT_WALL_CLOCK_SEC) * 1000;

    const env: Record<string, string> = { ...(spec.env ?? {}) };
    if (this.#opts.proxyUrl !== undefined) {
      env['HTTP_PROXY'] = this.#opts.proxyUrl;
      env['HTTPS_PROXY'] = this.#opts.proxyUrl;
      env['http_proxy'] = this.#opts.proxyUrl;
      env['https_proxy'] = this.#opts.proxyUrl;
      if (this.#opts.noProxy !== undefined && this.#opts.noProxy.length > 0) {
        env['NO_PROXY'] = this.#opts.noProxy.join(',');
        env['no_proxy'] = env['NO_PROXY'];
      }
    }

    /*
     * 命令构造走平台适配层（需求 20.4.1）。
     *
     * PowerShell 的 `-EncodedCommand`、输出编码前导、以及经 WSL 起 bash 的形式都在
     * 那一层，这里只做 shell 种类的映射。以前这段是内联的，于是同一套 PowerShell
     * 参数在这个文件、`compute/probe.ts` 与 `envs/service.ts` 各写了一份——三份里
     * 有两份漏了编码前导，表现是中文输出乱码。
     */
    const invocation = platform().shellInvocation({
      family: kind === 'bash' ? 'posix' : 'powershell',
      command: spec.command,
    });
    if (invocation === null) {
      throw new Error(
        `当前平台（${platform().label}）起不了 ${kind}。` +
          `可用的 shell：${platform().defaultShell}。`,
      );
    }
    const { command, args } = invocation;

    const result = await runSupervised({
      command,
      args,
      cwd: spec.cwd,
      env,
      timeoutMs,
      memoryMb: this.#opts.defaults?.memoryMb ?? DEFAULT_MEMORY_MB,
      maxOutputBytes:
        spec.maxOutputBytes ?? this.#opts.defaults?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }

  async dispose(): Promise<void> {
    // 无常驻资源
  }
}
