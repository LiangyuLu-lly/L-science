/**
 * 多模型能力路由（需求 7）。
 *
 * 硬过滤决定能不能做，打分决定谁做最合适，编排层组装可解释决策。发送路径只执行降级（failover）；selectCommittee 仅预览候选 id，planEscalation 与 compareCommitteeAnswers 不在发送路径上调用。路由本身不发起网络请求，健康与速率由调用方注入。
 */

export { TASK_WEIGHTS, TASK_REQUIREMENTS, TASK_SENSITIVITY, buildTaskProfile } from './weights.js';
export type { WeightPreset } from './weights.js';

export { hardFilter, REASON_TEXT, MIN_RATE_HEADROOM } from './filter.js';
export type { FilterInput, FilterResult, ModelRuntimeState } from './filter.js';

export {
  scoreCandidates,
  estimateCost,
  estimateLatency,
  experienceKey,
  capabilityScore,
  normalize,
  confidenceFactor,
  MAX_PENALTY,
  MAX_EXPERIENCE,
  LOCAL_BONUS,
} from './score.js';
export type { ExperienceAdjustment, ScoreInput, ScoredCandidate } from './score.js';

export {
  route,
  buildFallbackChain,
  shouldFallback,
  linkFallbackDecision,
  selectCommittee,
  compareCommitteeAnswers,
  planEscalation,
  pickCrossVendor,
} from './router.js';
export type {
  RouteInput,
  RouteResult,
  FailureClassification,
  FallbackStep,
  CommitteeSelection,
  CommitteeAnswer,
  CommitteeDisagreement,
  EscalationPlan,
  CrossVendorPick,
} from './router.js';
