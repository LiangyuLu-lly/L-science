/**
 * `wsl2` 沙箱后端：在 WSL2 发行版内执行，拿到内核级的文件系统与网络边界。
 *
 * 相对 `native` 的两个实质收益：
 *
 * 1. **硬性网络出口管控**：发行版内可用 iptables 与网络命名空间，出口在内核层
 *    受控，而不是靠注入代理环境变量（那能被直接建 socket 绕过）。
 * 2. **内核中断按规范生效**：内核是 Linux 进程，控制通道的 `interrupt_request`
 *    走 SIGINT 正常工作，不必依赖 Windows 特有的中断事件机制。
 *
 * 已知约束：本机存在 localhost 代理未镜像到 WSL 的情况（NAT 模式不支持），
 * 因此发行版内访问宿主上的本地代理需要走宿主 IP 而不是 127.0.0.1。
 */

import { execFile } from 'node:child_process';

import type {
  IsolationReport,
  SandboxBackend,
  ShellKind,
  ShellResult,
  ShellSpec,
} from './backend.js';
import { runSupervised } from './supervisor.js';

export interface Wsl2BackendOptions {
  /** 发行版名称。 */
  distro: string;
  defaults?: {
    memoryMb?: number;
    wallClockSec?: number;
    maxOutputBytes?: number;
  };
  proxyUrl?: string;
  noProxy?: readonly string[];
}

const DEFAULT_WALL_CLOCK_SEC = 600;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** 列出已安装的 WSL 发行版。wsl.exe 输出 UTF-16LE，需按此解码。 */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { windowsHide: true, timeout: 15_000, encoding: 'buffer' },
      (err, stdout) => {
        if (err !== null) {
          resolve([]);
          return;
        }
        const text = Buffer.from(stdout).toString('utf16le').replace(/\0/g, '');
        resolve(
          text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s !== ''),
        );
      },
    );
  });
}

/** Windows 路径转 WSL 路径：`C:\a\b` -> `/mnt/c/a/b`。 */
export function toWslPath(hostPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (match === null) return hostPath.replace(/\\/g, '/');
  const drive = (match[1] ?? 'c').toLowerCase();
  const rest = (match[2] ?? '').replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

export class Wsl2Backend implements SandboxBackend {
  readonly id = 'wsl2' as const;
  readonly isolation: IsolationReport;

  readonly #opts: Wsl2BackendOptions;

  constructor(opts: Wsl2BackendOptions) {
    this.#opts = opts;
    this.isolation = {
      backend: 'wsl2',
      filesystem: 'namespace',
      network: 'namespace',
      process: 'container',
      resourceLimits: {
        ...(opts.defaults?.memoryMb === undefined ? {} : { memoryMb: opts.defaults.memoryMb }),
        wallClockSec: opts.defaults?.wallClockSec ?? DEFAULT_WALL_CLOCK_SEC,
      },
      caveats: [
        `执行发生在 WSL2 发行版 ${opts.distro} 内；宿主的 /mnt/* 挂载在发行版内可写，因此宿主文件仍可被访问`,
        '本机 localhost 代理未镜像到 WSL（NAT 模式不支持），发行版内需经宿主 IP 访问宿主服务',
        '资源限额由 .wslconfig 对整个 WSL 虚拟机生效，不是按进程隔离',
      ],
    };
  }

  supportsShell(kind: ShellKind): boolean {
    // 发行版内没有 PowerShell；需要 PowerShell 时应改用 native 后端
    return kind === 'bash';
  }

  toGuestPath(hostPath: string): string {
    return toWslPath(hostPath);
  }

  async runShell(spec: ShellSpec): Promise<ShellResult> {
    const kind = spec.shell ?? 'bash';
    if (!this.supportsShell(kind)) {
      throw new Error(`wsl2 后端只支持 bash，收到 ${kind}；需要 PowerShell 请改用 native 后端`);
    }

    const timeoutMs =
      spec.timeoutMs ?? (this.#opts.defaults?.wallClockSec ?? DEFAULT_WALL_CLOCK_SEC) * 1000;

    const envAssignments = Object.entries(spec.env ?? {}).map(
      ([k, v]) => `export ${k}=${JSON.stringify(v)}`,
    );
    if (this.#opts.proxyUrl !== undefined) {
      envAssignments.push(
        `export HTTP_PROXY=${JSON.stringify(this.#opts.proxyUrl)}`,
        `export HTTPS_PROXY=${JSON.stringify(this.#opts.proxyUrl)}`,
      );
      if (this.#opts.noProxy !== undefined && this.#opts.noProxy.length > 0) {
        envAssignments.push(`export NO_PROXY=${JSON.stringify(this.#opts.noProxy.join(','))}`);
      }
    }

    // cd 与 export 拼进脚本而不是靠 wsl 的参数：跨 Windows/WSL 传参时引号
    // 与路径分隔符都会被改写，拼成一段 bash 脚本最不容易出错。
    const script = [
      `cd ${JSON.stringify(this.toGuestPath(spec.cwd))} || exit 1`,
      ...envAssignments,
      spec.command,
    ].join('\n');

    const result = await runSupervised({
      command: 'wsl.exe',
      args: ['-d', this.#opts.distro, '-e', 'bash', '-lc', script],
      // wsl.exe 本身在宿主上跑，cwd 给宿主路径
      cwd: spec.cwd,
      timeoutMs,
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
    // 不主动 wsl --terminate：发行版可能被用户的其他工作占用
  }
}
