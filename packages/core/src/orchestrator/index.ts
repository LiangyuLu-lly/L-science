/**
 * 会话编排（任务 8.5）。
 *
 * 编排器是唯一有权发起模型调用与工具调用的组件。这个约束的实际价值：模型调用要
 * 计费、走路由、记用量；工具调用要过审批、落血缘。散落在各处发起就意味着这些
 * 横切关注点必然有地方被漏掉，而漏掉的症状是「有些调用没进用量统计」这类事后
 * 才发现、且无法回溯补齐的问题。
 */

export { Orchestrator, inferTaskType, toolOutputForModel } from './orchestrator.js';
export type { OrchestratorDeps } from './orchestrator.js';

export {
  ALLOWED_TRANSITIONS,
  ConversationBusyError,
  IllegalTransitionError,
  canTransition,
} from './types.js';
export type { TurnStopReason, TurnSummary } from './types.js';
