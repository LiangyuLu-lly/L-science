/**
 * 手稿与 Claim Ledger（任务 13.4-13.6，需求 13）。
 *
 * 分层：`extract` 从手稿里识别可核查断言（纯规则，可复现），`ledger` 串起登记、
 * 证据绑定与核验记录，`tools` 是模型面。
 */

export type { ClaimKind, ExtractOptions, ExtractResult, ExtractedClaim } from './extract.js';
export {
  CLAIM_KIND_LABEL,
  classifyClaim,
  describeExtraction,
  extractClaims,
  splitSentences,
} from './extract.js';

export type {
  BindResult,
  ClaimLedgerDeps,
  ExtractRegisterResult,
  RegisterResult,
} from './ledger.js';
export { ClaimLedger } from './ledger.js';

export type { ClaimAction, ClaimToolInput, ClaimToolOptions } from './tools.js';
export { createManageClaimsTool } from './tools.js';
