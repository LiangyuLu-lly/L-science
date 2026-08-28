/**
 * 会话编排（任务 8.5、12.6）。
 *
 * 编排器是唯一有权发起模型调用与工具调用的组件。这个约束的实际价值：模型调用要
 * 计费、走路由、记用量；工具调用要过审批、落血缘。散落在各处发起就意味着这些
 * 横切关注点必然有地方被漏掉，而漏掉的症状是「有些调用没进用量统计」这类事后
 * 才发现、且无法回溯补齐的问题。
 *
 * 子 agent 是这个约束下的例外形态而不是绕过：它走同一份 `agent-runtime`，
 * 记同一份用量，用同一个工具注册表，只是有自己的会话、工作目录与内核。
 */

export { Orchestrator, inferTaskType, toolOutputForModel } from './orchestrator.js';
export type { OrchestratorDeps } from './orchestrator.js';

export { executeToolCall, modelMaxOutput, streamModel, truncateForModel } from './agent-runtime.js';

export { SubAgentRunner, extractVersionIds } from './subagent.js';
export type {
  SubAgentHandle,
  SubAgentResult,
  SubAgentRunnerDeps,
  SubAgentSpec,
  SubAgentStatus,
} from './subagent.js';

export {
  createAgentStatusTool,
  createDelegateTool,
  createGuideAgentTool,
  createStopAgentTool,
} from './delegate-tools.js';
export type {
  AgentStatusInput,
  DelegateInput,
  DelegateToolsOptions,
  GuideAgentInput,
  StopAgentInput,
} from './delegate-tools.js';

export {
  ALLOWED_TRANSITIONS,
  ConversationBusyError,
  IllegalTransitionError,
  canTransition,
} from './types.js';
export type { TurnStopReason, TurnSummary } from './types.js';
