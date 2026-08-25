/**
 * 运行时能力探测（任务 6.1）。
 *
 * 探测结果被缓存：`detectKernels()` 要枚举 conda 环境并检查文件系统，代价在
 * 几十到几百毫秒量级。而能力探测在每次注册工具时都要用，且在一次进程生命周期
 * 内不会变化——用户中途装了 R 也需要重启后端才生效，这个限制是可接受的。
 */

import { basename } from 'node:path';

import { detectKernels } from '@l-science/kernel';

import { isolationStrength, type SandboxBackend } from '../sandbox/backend.js';

/** 能力标识。用字符串而不是枚举，便于第三方工具声明自己的依赖。 */
export const CAPABILITY = {
  kernelPython: 'kernel:python',
  kernelR: 'kernel:r',
  shellPowershell: 'shell:powershell',
  shellBash: 'shell:bash',
  filesystem: 'filesystem',
} as const;

/** 各能力缺失时的安装指引。必须可执行到复制粘贴就能跑的程度。 */
export const REMEDIATION: Readonly<Record<string, string>> = {
  [CAPABILITY.kernelPython]:
    '托管 Python 环境缺失。执行：conda create -n lsci python=3.13 -y && conda run -n lsci pip install ipykernel',
  [CAPABILITY.kernelR]:
    'R 内核缺失。执行：conda create -n lsci-r -c conda-forge r-base r-irkernel -y' +
    '（R 依赖体量大，刻意用独立环境以免拖坏 Python 侧的领域包版本）',
  [CAPABILITY.shellPowershell]: 'PowerShell 不可用。Windows 自带 powershell.exe，请检查 PATH。',
  [CAPABILITY.shellBash]:
    'bash 不可用。安装 WSL2：以管理员身份执行 wsl --install -d Ubuntu，然后重启。',
  [CAPABILITY.filesystem]: '文件系统不可用。',
};

export interface CapabilitySnapshot {
  available: ReadonlySet<string>;
  /** Python 内核所在的 conda 环境名，用于诊断显示。 */
  pythonEnv: string | null;
  rEnv: string | null;
}

let cached: CapabilitySnapshot | null = null;

/**
 * 探测当前可用的能力。
 *
 * `bash` 的判定依据是沙箱后端而不是 PATH 里有没有 bash.exe：Git for Windows
 * 也提供 bash.exe，但它跑在 Windows 上，与「WSL2 里的 bash」在路径语义、
 * 权限模型、可用工具链上都不同。把两者混为一谈会让脚本在开发机上能跑、
 * 在别处莫名失败。
 */
export function detectCapabilities(backend?: SandboxBackend): CapabilitySnapshot {
  if (cached !== null && backend === undefined) return cached;

  const kernels = detectKernels();
  const available = new Set<string>([CAPABILITY.filesystem]);

  if (kernels.python !== null) available.add(CAPABILITY.kernelPython);
  if (kernels.r !== null) available.add(CAPABILITY.kernelR);

  // Windows 上 PowerShell 总是存在。真不存在时 bash 工具也没法用，
  // 因此不做额外探测——省下的那次进程启动在启动路径上是可感知的
  if (process.platform === 'win32') available.add(CAPABILITY.shellPowershell);

  if (backend !== undefined && backend.id === 'wsl2') {
    available.add(CAPABILITY.shellBash);
  }

  const snapshot: CapabilitySnapshot = {
    available,
    // 显示环境目录名而不是完整 prefix：诊断时用户关心的是「用的哪个环境」，
    // 完整路径太长会把摘要挤爆
    pythonEnv: kernels.python === null ? null : basename(kernels.python.prefix),
    rEnv: kernels.r === null ? null : basename(kernels.r.prefix),
  };

  if (backend === undefined) cached = snapshot;
  return snapshot;
}

/** 构造供 ToolRegistry 使用的探测函数。 */
export function capabilityProbe(snapshot: CapabilitySnapshot): (capability: string) => boolean {
  return (capability) => snapshot.available.has(capability);
}

/** 清空缓存。仅供测试与「用户装了新环境后手动刷新」使用。 */
export function resetCapabilityCache(): void {
  cached = null;
}

/** 人类可读的能力摘要，用于 doctor 与设置页。 */
export function describeCapabilities(
  snapshot: CapabilitySnapshot,
  backend?: SandboxBackend,
): string {
  const lines = [
    `Python 内核：${snapshot.available.has(CAPABILITY.kernelPython) ? `可用（${snapshot.pythonEnv ?? '未知环境'}）` : '不可用'}`,
    `R 内核：${snapshot.available.has(CAPABILITY.kernelR) ? `可用（${snapshot.rEnv ?? '未知环境'}）` : '不可用'}`,
    `PowerShell：${snapshot.available.has(CAPABILITY.shellPowershell) ? '可用' : '不可用'}`,
    `bash：${snapshot.available.has(CAPABILITY.shellBash) ? '可用（WSL2）' : '不可用（需要 WSL2 后端）'}`,
  ];
  if (backend !== undefined) {
    const strength = isolationStrength(backend.isolation);
    lines.push(`沙箱后端：${backend.id}（隔离强度 ${strength}）`);
  }
  return lines.join('\n');
}
