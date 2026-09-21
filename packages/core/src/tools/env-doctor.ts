/**
 * env.doctor 的紧凑 blocker 列表。
 *
 * 只覆盖会挡住内核 / 原生能力的两项：koffi 加载失败、lsci / ipykernel 缺失。
 * 不搬 doctor.mjs 的 GPU / 磁盘 / 提权探测。
 */

import { win32UnavailableReason } from '../win32/index.js';

import { CAPABILITY, type CapabilitySnapshot } from './capabilities.js';

export type EnvDoctorBlocker = {
  readonly id: string;
  readonly what: string;
  readonly consequence: string;
  readonly command: string;
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

export function collectEnvDoctorBlockers(
  snapshot: CapabilitySnapshot,
  ffiReason: string | null = win32UnavailableReason(),
): readonly EnvDoctorBlocker[] {
  const blockers: EnvDoctorBlocker[] = [];
  if (ffiReason !== null && ffiReason.includes('koffi')) {
    blockers.push(KOFFI_BLOCKER);
  }
  if (!snapshot.available.has(CAPABILITY.kernelPython)) {
    blockers.push(LSCI_BLOCKER);
  }
  return blockers;
}
