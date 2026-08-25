/**
 * 多模型能力路由（需求 7）。
 *
 * 三段结构：硬过滤决定「能不能做」，打分决定「谁做最合适」，编排层把两者
 * 组装成可解释的决策并提供降级、committee、escalation 三种执行策略。
 *
 * 整个路由不发起网络请求：健康与速率信息由调用方注入。这既让它可以被纯函数式
 * 测试，也避免在「选哪个模型」这一步引入额外延迟。
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
