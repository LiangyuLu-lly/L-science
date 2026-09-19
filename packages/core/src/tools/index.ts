/**
 * 工具面（需求 2.4、4.x、6.8、6.9、9.6）。
 *
 * 核心机制是**按运行时能力条件注册**：不可用的工具不进工具列表。让它出现在
 * 列表里的后果是模型调用它、拿到执行期错误、然后重试——而模型无法从一个失败
 * 的调用里学到「这个环境没装 R」，因为它看到的不是一份不含该工具的清单。
 */

export {
  ToolRegistry,
  ToolInputError,
  ToolUnavailableError,
  toolErrorEnvelope,
  textOutput,
  errorOutput,
} from './registry.js';
export type { ToolRegistryOptions } from './registry.js';

export type {
  CapabilityProbe,
  ToolContext,
  ToolDefinition,
  ToolRequirement,
  ToolResult,
  UnavailableTool,
} from './types.js';

export {
  CAPABILITY,
  REMEDIATION,
  capabilityProbe,
  describeCapabilities,
  detectCapabilities,
  resetCapabilityCache,
} from './capabilities.js';
export type { CapabilitySnapshot } from './capabilities.js';

export { collectEnvDoctorBlockers } from './env-doctor.js';
export type { EnvDoctorBlocker } from './env-doctor.js';

export { createShellTool, formatShellResult, truncateStream } from './shell.js';
export type { ShellInput, ShellToolOptions } from './shell.js';

export { BackgroundRunner, BackgroundTooManyError } from './background.js';
export type {
  BackgroundNotice,
  BackgroundRunnerOptions,
  BackgroundState,
  BackgroundTask,
} from './background.js';

export {
  collectExecution,
  createKernelTool,
  describeMimeBundle,
  formatExecution,
} from './kernel-tools.js';
export type { CodeInput, ExecutionCollected, KernelToolOptions } from './kernel-tools.js';

export { extractPdfPage } from './pdf-text.js';

export {
  createEditFileTool,
  createReadFileTool,
  isPdf,
  looksBinary,
  replaceOnce,
  sliceLines,
} from './files.js';
export type {
  EditFileInput,
  EditFileToolOptions,
  EditMode,
  ReadFileInput,
  ReadFileToolOptions,
  ReplaceOutcome,
} from './files.js';

export { createAskUserTool } from './ask-user.js';
export type { AskUserInput, AskUserToolOptions } from './ask-user.js';
