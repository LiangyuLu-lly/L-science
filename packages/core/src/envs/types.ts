/**
 * 环境与包管理的类型（任务 14.4，需求 15.1-15.7）。
 */

/** 环境的实现方式。 */
export type EnvKind = 'conda' | 'venv';

/**
 * 谁在管这个环境。
 *
 * - `managed`：平台建的、平台可以删的。
 * - `registered`：用户既有的环境，平台只是登记了它的位置（需求 15.2）。
 *
 * 这个区分决定**能不能删**：删掉一个用户自己建的 venv 是不可接受的，那里面可能有
 * 他花了一天装好的 GDAL。平台只能取消登记。
 */
export type EnvMode = 'managed' | 'registered';

export type EnvLanguage = 'python' | 'r';

/** 环境状态。 */
export type EnvStatus =
  /** 探测通过，可以起内核 */
  | 'ready'
  /** 正在创建（后台任务在跑） */
  | 'creating'
  /** 目录还在但缺关键组件（通常是 ipykernel） */
  | 'incomplete'
  /** 目录不在了：用户删掉或移动了它 */
  | 'missing'
  /** 创建失败 */
  | 'failed';

export const ENV_STATUS_LABEL: Readonly<Record<EnvStatus, string>> = {
  ready: '可用',
  creating: '正在创建',
  incomplete: '缺组件',
  missing: '找不到',
  failed: '创建失败',
};

/* ------------------------------------------------------------------ *
 * 安装器
 * ------------------------------------------------------------------ */

/**
 * 包安装器。
 *
 * 分成两个**家族**，这是这一层最重要的区分：
 *
 * - PyPI 家族（`uv` / `pip`）：装 PyPI 上的 wheel。
 * - conda 家族（`micromamba` / `mamba` / `conda`）：装 conda 频道的包。
 * - CRAN（`R`）：R 包。
 *
 * 需求 15.3 说「默认使用最快可用的安装器，不可用时回退」。回退**只能在家族内**做：
 * 让 `uv` 去顶替 `conda` 不是回退，是换了一个包来源——而那正是需求 15.4 要防的事
 * （同一个科学计算依赖被两个来源各装一份，两份编译好的 BLAS/HDF5 同时进一个进程）。
 */
export type InstallerId = 'uv' | 'pip' | 'micromamba' | 'mamba' | 'conda' | 'R';

export type InstallerFamily = 'pypi' | 'conda' | 'cran';

export const INSTALLER_FAMILY: Readonly<Record<InstallerId, InstallerFamily>> = {
  uv: 'pypi',
  pip: 'pypi',
  micromamba: 'conda',
  mamba: 'conda',
  conda: 'conda',
  R: 'cran',
};

/**
 * 各家族内的优先顺序（需求 15.3）。前面的更快。
 *
 * `uv` 比 pip 快一到两个数量级（Rust 实现、并行下载、全局缓存），而它与 pip 用同一份
 * PyPI 元数据，因此在同一家族内替换是安全的。
 *
 * conda 家族里 `micromamba` 是单个静态二进制，`mamba` 是 conda 的 C++ 求解器替代，
 * 两者都比 conda 自带的求解器快得多。把 `conda` 留在最后是因为它一定存在（我们的
 * 托管环境就是它建的），是保底而不是首选。
 */
export const INSTALLER_PRIORITY: Readonly<Record<InstallerFamily, readonly InstallerId[]>> = {
  pypi: ['uv', 'pip'],
  conda: ['micromamba', 'mamba', 'conda'],
  cran: ['R'],
};

export interface InstallerInfo {
  id: InstallerId;
  family: InstallerFamily;
  available: boolean;
  /** 可执行文件路径或命令名。 */
  command: string | null;
  version: string | null;
  /** 不可用时的原因。 */
  reason: string | null;
}

/* ------------------------------------------------------------------ *
 * 环境记录
 * ------------------------------------------------------------------ */

export interface EnvProbe {
  at: number;
  status: EnvStatus;
  /** 一句话结论。 */
  summary: string;
  /** 解释器版本（`3.13.14`）。 */
  version: string | null;
  /** ipykernel 在不在。不在就起不了内核。 */
  hasKernelSpec: boolean;
  /** 逐项检查。 */
  checks: readonly { name: string; ok: boolean; detail: string }[];
  /** 包数量。完整清单在 env_packages 里。 */
  packageCount: number;
  /** 从 PyPI 装进 conda 环境的包数量。需求 15.4 的风险面。 */
  pypiInCondaCount: number;
}

/* ------------------------------------------------------------------ *
 * 包
 * ------------------------------------------------------------------ */

/** 包的安装来源。与 `conda list --json` 的 channel 语义对齐。 */
export type PackageSource = 'conda' | 'pypi' | 'cran' | 'unknown';

export const PACKAGE_SOURCE_LABEL: Readonly<Record<PackageSource, string>> = {
  conda: 'conda 频道',
  pypi: 'PyPI（pip/uv）',
  cran: 'CRAN',
  unknown: '来源不明',
};

export interface PackageRecord {
  name: string;
  version: string | null;
  source: PackageSource;
  channel: string | null;
  installedBy: string | null;
  installedAt: number;
}

/** 一次安装/卸载请求。 */
export interface PackageRequest {
  /** 包名，可带版本约束（`numpy>=1.26`）。 */
  specs: readonly string[];
  /** 强制用某个家族。省略时由冲突检查与环境类型决定。 */
  family?: InstallerFamily;
  /** conda 家族的频道。省略时用 conda-forge。 */
  channel?: string;
}

/**
 * 安装计划。
 *
 * 把「用哪个安装器、为什么、会不会需要重启、有没有冲突」在执行之前就算出来，
 * 是为了让审批卡片与工具输出能说清代价——而不是先跑起来再解释。
 */
export interface InstallPlan {
  ok: boolean;
  envId: string;
  installer: InstallerInfo | null;
  family: InstallerFamily | null;
  /** 实际要跑的命令。 */
  command: string | null;
  /** 为什么选了这个安装器（含回退说明）。 */
  installerReason: string;
  /** 冲突检查结果。非空时 `ok` 为假。 */
  conflicts: readonly PackageConflict[];
  /** 装完要不要重启内核（需求 15.5）。 */
  restartRequired: boolean;
  reason: string | null;
}

/**
 * conda 与 pip 混装同一依赖的冲突（需求 15.4）。
 */
export interface PackageConflict {
  name: string;
  /** 已装的来源。 */
  existingSource: PackageSource;
  existingVersion: string | null;
  /** 这次要用的来源。 */
  requestedSource: PackageSource;
  /** 为什么这个包混装会出事。 */
  why: string;
  /** 可执行的解决办法。 */
  remediation: string;
}
