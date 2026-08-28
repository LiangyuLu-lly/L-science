/**
 * Plan Engine（需求 10.1-10.4）。
 *
 * 三层：计划结构与批次划分、校验、工具。执行侧（委派与子 agent）在
 * `orchestrator` 里，见任务 12.6。
 */

export { parsePlanSpec, planBatches, PlanSpecError } from './spec.js';
export type {
  DelegationSpec,
  PlanPhaseSpec,
  PlanSpec,
  PlanStatus,
  PlanStepSpec,
  PlanStepStatus,
} from './spec.js';

export { describeIssues, findSuspectValues, planExecutable, validatePlan } from './validate.js';
export type { PlanIssue, PlanIssueCode, SuspectValue, ValidatePlanInput } from './validate.js';

export { createGeneratePlanTool, createPlanStatusTool, renderPlan } from './tools.js';
export type { PlanStatusInput, PlanToolOptions } from './tools.js';
