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

export type { CitationShape, ParsedCitation } from './citations.js';
export {
  CITATION_SHAPE_LABEL,
  describeCitation,
  parseCitation,
  parseReferenceList,
} from './citations.js';

export type { CitationVerifierDeps, CitationVerifyResult } from './verify.js';
export {
  CITATION_VERDICT_LABEL,
  CitationVerifier,
  buildQuery,
  compareFields,
  describeCheck,
  journalNamesMatch,
  renderVerifyResults,
} from './verify.js';

export type { VerifyCitationsInput, VerifyCitationsOptions } from './verify-tools.js';
export { createVerifyCitationsTool } from './verify-tools.js';

export type { ParsedFrontMatter, YamlMap, YamlValue } from './frontmatter.js';
export {
  FrontMatterError,
  asBoolean,
  asMapList,
  asString,
  asStringList,
  frontMatterErrorMessage,
  parseManuscriptFrontMatter,
} from './frontmatter.js';

export type {
  CitationMarker,
  DisplayItem,
  ManuscriptAuthor,
  ManuscriptDocument,
  ManuscriptMeta,
  ManuscriptSection,
} from './document.js';
export { authorNames, countWords, parseManuscript, resolveAbstract } from './document.js';

export type {
  CitationStyleFamily,
  JournalProfile,
  LengthLimits,
  NumberingRule,
} from './journals.js';
export {
  BUILTIN_JOURNAL_PROFILES,
  CITATION_STYLE_LABEL,
  describeProfile,
  findJournalProfile,
  parseJournalProfile,
} from './journals.js';

export type {
  CompileIssue,
  CompileIssueSeverity,
  CompileOptions,
  CompileResult,
  SelfCitationLeak,
} from './compile.js';
export {
  BLINDING_DISCLAIMER,
  buildCitationMap,
  compileManuscript,
  compileSummary,
  detectSelfCitationLeaks,
  surnameOf,
} from './compile.js';

export type { CompileOutcome, CompileRequest, CompileServiceDeps } from './compile-service.js';
export { ManuscriptCompiler } from './compile-service.js';

export type { CompileToolInput, CompileToolOptions } from './compile-tools.js';
export { createCompileManuscriptTool } from './compile-tools.js';
