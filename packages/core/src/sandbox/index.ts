/**
 * 沙箱后端选择。
 *
 * 选择结果与实际隔离强度必须一起透出到 UI——设计目标里的「诚实降级」要求
 * 用户随时能看到自己实际处于哪种保护之下，而不是看到一个「已启用沙箱」的绿灯。
 */

export {
  isolationStrength,
  type FilesystemIsolation,
  type IsolationReport,
  type NetworkIsolation,
  type ProcessIsolation,
  type SandboxBackend,
  type SandboxBackendId,
  type ShellKind,
  type ShellResult,
  type ShellSpec,
} from './backend.js';

export { PathGuard, PathDeniedError } from './path-guard.js';
export type { AccessMode, PathDecision, PathDenyReason, PathGuardOptions } from './path-guard.js';

export { runSupervised, killTree } from './supervisor.js';
export type { LimitEnforcement, SupervisedResult, SupervisedSpawn } from './supervisor.js';

export { NativeBackend, nativeIsolationReport } from './native.js';
export type { NativeBackendOptions } from './native.js';

export { Wsl2Backend, listWslDistros, toWslPath } from './wsl2.js';
export type { Wsl2BackendOptions } from './wsl2.js';

import { NativeBackend, type NativeBackendOptions } from './native.js';
import { Wsl2Backend, listWslDistros } from './wsl2.js';
import type { SandboxBackend, SandboxBackendId } from './backend.js';

export interface SelectBackendOptions extends NativeBackendOptions {
  /** 用户显式指定的后端。省略时自动选择最强可用的。 */
  prefer?: SandboxBackendId;
}

export interface BackendSelection {
  backend: SandboxBackend;
  /** 被跳过的候选及原因，供 UI 说明「为什么没用更强的隔离」。 */
  skipped: Array<{ id: SandboxBackendId; reason: string }>;
}

/**
 * 选择沙箱后端。
 *
 * 顺序是 wsl2 > native。docker 暂不实现：它的后端本身就依赖 WSL2，
 * 在已有 WSL2 的前提下多一层容器带来的隔离增益，不值得为其引入
 * Docker Desktop 的常驻开销。
 */
export async function selectBackend(opts: SelectBackendOptions = {}): Promise<BackendSelection> {
  const skipped: BackendSelection['skipped'] = [];

  if (opts.prefer === 'native') {
    return { backend: new NativeBackend({ ...opts, wslAvailable: false }), skipped };
  }

  const distros = await listWslDistros();
  const distro = distros[0];

  if (distro === undefined) {
    skipped.push({
      id: 'wsl2',
      reason:
        'WSL2 无已安装发行版。执行 wsl --install -d Ubuntu（需管理员 + 重启）后可获得内核级文件系统与网络边界',
    });
    return { backend: new NativeBackend({ ...opts, wslAvailable: false }), skipped };
  }

  if (opts.prefer === 'wsl2' || opts.prefer === undefined) {
    return {
      backend: new Wsl2Backend({
        distro,
        ...(opts.defaults === undefined ? {} : { defaults: opts.defaults }),
        ...(opts.proxyUrl === undefined ? {} : { proxyUrl: opts.proxyUrl }),
        ...(opts.noProxy === undefined ? {} : { noProxy: opts.noProxy }),
      }),
      skipped,
    };
  }

  return { backend: new NativeBackend({ ...opts, wslAvailable: true }), skipped };
}
