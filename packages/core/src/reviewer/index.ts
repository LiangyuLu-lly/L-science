/**
 * Reviewer Service（任务 12.8，需求 11.1-11.8）。
 *
 * 后台独立审查，模型强制异厂商。两层检查：确定性层不用模型且结论可指到库行，
 * 模型层读内容但每条发现都要经证据清单校验。
 */

export {
  checkArtifactLineage,
  checkCitationIntegrity,
  checkClaimSupport,
  checkDanglingArtifactRefs,
  extractText,
  runDeterministicChecks,
} from './checks.js';
export type {
  CitationCheckSnapshot,
  ClaimSnapshot,
  DeterministicInput,
  DraftFinding,
} from './checks.js';

export { extractJsonObject, parseReviewOutput } from './parse.js';
export type { ParseOptions, ParsedRecheck, ParsedReview, RecheckVerdict } from './parse.js';

export { buildReviewContext, reviewerSystemPrompt, reviewerUserPrompt } from './prompt.js';
export type { ReviewClaim, ReviewContext, ReviewContextInput } from './prompt.js';

export { ReviewerService } from './service.js';
export type { ReviewOutcome, ReviewerServiceDeps } from './service.js';

export {
  createCheckFindingsTool,
  createMarkFindingAddressedTool,
  createRequestReviewTool,
} from './tools.js';
export type { CheckFindingsInput, FindingToolOptions, MarkAddressedInput } from './tools.js';
