/**
 * env.doctor 的紧凑 blocker 列表。
 *
 * 覆盖会挡住内核 / 原生能力的项：koffi 加载失败、lsci / ipykernel 缺失、
 * numba 与 numpy 版本不兼容。不搬 doctor.mjs 的 GPU / 磁盘 / 提权探测。
 *
 * numba/numpy 判定与 scripts/doctor.mjs 共用 packages/core/src/envs/numba-numpy.ts。
 */

import { judgeNumbaNumpyCompat } from '../envs/numba-numpy.js';
import { win32UnavailableReason } from '../win32/index.js';

import { CAPABILITY, type CapabilitySnapshot } from './capabilities.js';

export type EnvDoctorBlocker = {
  readonly id: string;
  readonly what: string;
  readonly consequence: string;
  readonly command: string;
};

export type EnvDoctorPackages = {
  readonly numba: string | null;
  readonly numpy: string | null;
};

const KOFFI_BLOCKER = {
  id: 'koffi',
  what: 'koffi 加载失败',
  consequence: 'Job Object 限额退化为轮询，内核中断退化为重启',
  command: '',
} as const satisfies EnvDoctorBlocker;

const LSCI_BLOCKER = {
  id: 'lsci',
  what: '托管环境 lsci / ipykernel 缺失',
  consequence: '无法启动 Python 内核。点『一键安装 Python / R 内核』；装不上时再用手动命令',
  command: 'conda create -n lsci python=3.13',
} as const satisfies EnvDoctorBlocker;

const ONE_CLICK_THEN_MANUAL = '点『一键安装 Python / R 内核』；装不上时再用手动命令';

function numbaNumpyBlocker(packages: EnvDoctorPackages): EnvDoctorBlocker | null {
  const verdict = judgeNumbaNumpyCompat(packages.numba, packages.numpy);
  if (verdict.kind !== 'incompatible') return null;
  const numpy = verdict.numpy ?? '未安装';
  return {
    id: 'numba-numpy',
    what: `numba ${verdict.numba} 与 numpy ${numpy} 不兼容`,
    consequence: `numba ${verdict.numba} 与 numpy ${numpy} 不兼容，${ONE_CLICK_THEN_MANUAL}`,
    command: verdict.command,
  };
}

export function collectEnvDoctorBlockers(
  snapshot: CapabilitySnapshot,
  ffiReason: string | null = win32UnavailableReason(),
  packages?: EnvDoctorPackages,
): readonly EnvDoctorBlocker[] {
  const blockers: EnvDoctorBlocker[] = [];
  if (ffiReason !== null && ffiReason.includes('koffi')) {
    blockers.push(KOFFI_BLOCKER);
  }
  if (!snapshot.available.has(CAPABILITY.kernelPython)) {
    blockers.push(LSCI_BLOCKER);
  }
  if (packages !== undefined) {
    const numba = numbaNumpyBlocker(packages);
    if (numba !== null) blockers.push(numba);
  }
  return blockers;
}
