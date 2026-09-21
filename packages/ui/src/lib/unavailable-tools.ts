/**
 * 不可用工具的排序与 Python 内核缺口文案。
 *
 * 注册表按名字排序，bash 会排在 python 前面。缺 lsci 时人要先看到这件事，
 * 而不是先看到 WSL。不可用项全部保留——藏起来等于告诉用户功能不存在。
 */

export const PYTHON_KERNEL_CAPABILITY = 'kernel:python' as const;

export const PYTHON_KERNEL_GAP_COPY = '还没有 lsci' as const;

export const PYTHON_KERNEL_ONE_CLICK =
  '点『一键安装 Python / R 内核』；装不上时再用手动命令' as const;

export const LSCI_CONDA_CREATE = 'conda create -n lsci python=3.13' as const;

export type UnavailableCapabilityGap = {
  readonly capability: string;
  readonly remediation: string;
};

export type UnavailableToolRow = {
  readonly name: string;
  readonly missing: readonly UnavailableCapabilityGap[];
};

export type EnvDoctorBlockerRow = {
  readonly id: string;
  readonly command: string;
};

export type PythonKernelGapBannerInput = {
  readonly blockers?: readonly EnvDoctorBlockerRow[];
  readonly remediations?: readonly string[];
};

export function missingPythonKernel(tool: UnavailableToolRow): boolean {
  return tool.missing.some((gap) => gap.capability === PYTHON_KERNEL_CAPABILITY);
}

export function rankUnavailableTools<T extends UnavailableToolRow>(
  tools: readonly T[],
): readonly T[] {
  return [...tools].sort((a, b) => Number(missingPythonKernel(b)) - Number(missingPythonKernel(a)));
}

export function pythonKernelGapBanner(input: PythonKernelGapBannerInput): string | null {
  const lsci = input.blockers?.find((blocker) => blocker.id === 'lsci');
  const fromRemediation =
    input.remediations?.some(
      (text) => text.includes(LSCI_CONDA_CREATE) || text.includes(PYTHON_KERNEL_CAPABILITY),
    ) ?? false;
  if (lsci === undefined && !fromRemediation) return null;
  const command = lsci !== undefined && lsci.command !== '' ? lsci.command : LSCI_CONDA_CREATE;
  return `${PYTHON_KERNEL_GAP_COPY}。${PYTHON_KERNEL_ONE_CLICK}\n${command}`;
}
