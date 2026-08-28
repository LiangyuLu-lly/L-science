/**
 * `native` 沙箱后端：不依赖容器或虚拟机，在用户态尽力隔离。
 *
 * 实际强度必须如实透出（`IsolationReport.caveats`），因为它与 `wsl2` 差得远：
 * 文件系统边界只靠工具层的路径校验，网络出口只靠注入代理环境变量——两者都能被
 * 有意为之的代码绕过。它的价值是零安装可用，以及在 Job Object 支持下能兜住
 * 「失控」而非「恶意」。
 */

import { existsSync } from 'node:fs';

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
 * 给 PowerShell 命令加编码前导。
 *
 * 命令文本本身经 `-EncodedCommand`（UTF-16LE）传入不会有问题，但 PowerShell 的
 * **输出**默认用控制台的 OEM 代码页（简体中文机器上是 936/GBK）。我们按 UTF-8
 * 解码 stdout，于是任何非 ASCII 输出都会变成乱码——对一个中文平台来说这是
 * 必然会撞上的问题，而不是边缘情况。
 *
 * `$OutputEncoding` 管 PowerShell 传给原生命令的编码，`[Console]::OutputEncoding`
 * 管读取原生命令输出与写自身输出的编码，两者都要设。
 */
function withUtf8Preamble(command: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    command,
  ].join('\n');
}

function findPowerShell(): string {
  // 优先 PowerShell 7，回落到系统自带的 5.1
  const pwsh = 'pwsh.exe';
  const legacy = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return existsSync(legacy) ? legacy : pwsh;
}

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

    const { command, args } =
      kind === 'bash'
        ? { command: 'wsl.exe', args: ['-e', 'bash', '-lc', spec.command] }
        : {
            command: findPowerShell(),
            args: [
              '-NoProfile',
              '-NonInteractive',
              // 用 Base64 传命令：命令文本经多层传参时引号会被剥掉，
              // 这是实测反复踩到的问题（IRkernel 启动、conda run 都撞过）
              '-EncodedCommand',
              Buffer.from(withUtf8Preamble(spec.command), 'utf16le').toString('base64'),
            ],
          };

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
