/**
 * 环境与包管理（任务 14.4，需求 15.1-15.7）。
 *
 * 分层：`types` 是数据形状；`detect` 只问事实不改东西；`conflicts` 是需求 15.4 的
 * 判定（纯函数，可完整测试）；`installers` 构造命令（纯函数）；`service` 串起来并管
 * 后台任务与重启告知；`tools` 是模型面。
 */

export type {
  EnvKind,
  EnvLanguage,
  EnvMode,
  EnvProbe,
  EnvStatus,
  InstallPlan,
  InstallerFamily,
  InstallerId,
  InstallerInfo,
  PackageConflict,
  PackageRecord,
  PackageRequest,
  PackageSource,
} from './types.js';
export {
  ENV_STATUS_LABEL,
  INSTALLER_FAMILY,
  INSTALLER_PRIORITY,
  PACKAGE_SOURCE_LABEL,
} from './types.js';

export type { NativeGroup } from './conflicts.js';
export {
  NATIVE_GROUPS,
  checkConflicts,
  existingMixups,
  groupsOf,
  isNativeSensitive,
  normalizePackageName,
  renderConflicts,
  renderMixups,
  specName,
} from './conflicts.js';

export type { CondaEnvInfo } from './detect.js';
export {
  commonVenvLocations,
  condaAvailable,
  detectEnvKind,
  detectInstallers,
  listCondaEnvironments,
  listPackages,
  parseCondaList,
  parsePipList,
  parseRPackages,
  pickInstaller,
  prefixOfInterpreter,
  probeEnv,
  pythonInterpreterIn,
  readVenvConfig,
  remediationForInstaller,
  resetInstallerCache,
  rscriptIn,
  sourceOfChannel,
} from './detect.js';

export type { CommandSpec, InstallCommandInput } from './installers.js';
export {
  createCondaEnvCommand,
  installCommand,
  needsRestart,
  removeCondaEnvCommand,
  restartNotice,
  validateSpecs,
} from './installers.js';

export type {
  CreateResult as EnvCreateResult,
  EnvGrantStore,
  EnvServiceDeps,
  // 技能那边也有一个 `InstallResult`（安装内置技能）。改名而不是让两者撞在一起：
  // 撞了之后 `export *` 会静默丢掉一个，而丢掉的那个的调用点报的是「找不到类型」
  InstallResult as PackageInstallResult,
} from './service.js';
export { EnvService, MemoryEnvGrantStore } from './service.js';

export type { EnvAction, EnvToolInput, EnvToolOptions } from './tools.js';
export { createManageEnvironmentsTool } from './tools.js';

export type {
  NumbaNumpyConstraint,
  NumbaNumpyVerdict,
  NumpyInterval,
  VersionTriple,
} from './numba-numpy.js';
export {
  NUMBA_NUMPY_CONSTRAINTS,
  formatNumbaNumpyDoctorDetail,
  judgeNumbaNumpyCompat,
  parseVersion,
} from './numba-numpy.js';

export { MICROMAMBA_URLS, ensureMicromamba, micromambaExe, micromambaRoot } from './micromamba.js';
export type { BootstrapReport, BootstrapStep } from './bootstrap-kernels.js';
export {
  bootstrapKernelsStatus,
  resetBootstrapState,
  startBootstrapKernels,
} from './bootstrap-kernels.js';
