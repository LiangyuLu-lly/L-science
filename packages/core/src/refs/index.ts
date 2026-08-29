/**
 * 文献库（任务 13.1-13.3，需求 12）。
 *
 * 分层：`http` 收敛网络与限速，`sources` 把六家上游翻成 CSL，`dedupe` 判定重复，
 * `resolver` 编排多源，`library` 串起仓储与去重，`bibtex` 负责导出。
 */

export type { CslDate, CslItem, CslName, CslType } from './csl.js';
export {
  authorSummary,
  citeLine,
  cleanAbstract,
  compact,
  containerLabel,
  cslYear,
  dateParts,
  ensureCsl,
  familyKey,
  firstAuthorKey,
  intOrUndefined,
  nameLabel,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  normalizeTitle,
  str,
} from './csl.js';

export type { FetchImpl, HttpOptions, HttpResult, RefSourceId } from './http.js';
export {
  DEFAULT_REF_TIMEOUT_MS,
  HostRateLimiter,
  REF_USER_AGENT,
  arr,
  httpBytes,
  httpJson,
  httpRequest,
  httpText,
  pick,
} from './http.js';

export type {
  PubmedOptions,
  SourceCandidate,
  SourceResult,
  SourceSearchResult,
} from './sources.js';
export {
  crossrefByDoi,
  crossrefSearch,
  crossrefToCsl,
  dataCiteByDoi,
  dataCiteToCsl,
  europePmcByDoi,
  europePmcQuery,
  europePmcToCsl,
  openAlexByDoi,
  openAlexSearch,
  openAlexToCsl,
  pubmedByDoi,
  pubmedByPmid,
  pubmedSummaryToCsl,
  rebuildInvertedAbstract,
  semanticScholarByDoi,
  semanticScholarSearch,
  semanticScholarToCsl,
} from './sources.js';

export type {
  DedupeCluster,
  MatchResult,
  MatchVerdict,
  RefFingerprint,
  TitleSimilarity,
} from './dedupe.js';
export {
  DEDUPE_THRESHOLDS,
  clusterRefs,
  completeness,
  fingerprint,
  levenshtein,
  matchRefs,
  mergeAll,
  mergeCsl,
  titleSimilarity,
} from './dedupe.js';

export type {
  IdentifierKind,
  ResolveOptions,
  ResolveReport,
  SearchReport,
  SniffedIdentifier,
} from './resolver.js';
export {
  DEFAULT_DOI_SOURCES,
  DEFAULT_SEARCH_SOURCES,
  resolveByArxiv,
  resolveByDoi,
  resolveByPmcid,
  resolveByPmid,
  resolveIdentifier,
  searchRefs,
  sniffIdentifier,
} from './resolver.js';

export type { XmlElement, XmlNode, XmlText } from './xml.js';
export {
  XML_LIMITS,
  XmlError,
  at,
  attr,
  child,
  childElements,
  decodeXmlEntities,
  find,
  findAll,
  isElement,
  parseXml,
  textOf,
  trimmedText,
} from './xml.js';

export type {
  JatsArticle,
  JatsFigure,
  JatsReference,
  JatsTable,
  ParseJatsOptions,
} from './jats.js';
export { describeAssets, jatsToMarkdown, parseJats } from './jats.js';

export type {
  FulltextAttemptRecord,
  FulltextDeps,
  FulltextResult,
  FulltextSource,
} from './fulltext.js';
export { FULLTEXT_HOSTS, FULLTEXT_SOURCE_LABEL, FulltextFetcher } from './fulltext.js';

export type { AddOutcome, DuplicateSuspect, RefLibraryDeps } from './library.js';
export { REF_SOURCE_HOSTS, RefLibrary, SOURCE_LABEL, bibtexKeyFor } from './library.js';

export type { RefAction, RefToolInput, RefToolOptions } from './tools.js';
export { createManageReferencesTool } from './tools.js';

export type { BibtexOptions } from './bibtex.js';
export { escapeLatex, protectAcronyms, sanitizeKey, toBibtex, toBibtexFile } from './bibtex.js';
