/**
 * @l-science/core — 控制平面。
 *
 * 按 AD-1，这个包跑在一个独立的系统 Node 24 进程里（不是 Electron 内置 Node），
 * 因此可以自由使用 Node-API 原生模块，且 UI 崩溃不会带走正在运行的长任务。
 */

export { openDatabase, migrate, schemaVersion, sqliteVersion } from './db.js';
export type { Db, Migration } from './db.js';

export { APP_MIGRATIONS } from './migrations/app.js';
export { PROJECT_MIGRATIONS } from './migrations/project.js';

export {
  appPaths,
  projectPaths,
  dataDir,
  dataDirSource,
  describeDataDir,
  blobRelPath,
  APP_DIR_NAME,
} from './paths.js';
export type { AppPaths, DataDirSource, ProjectPaths } from './paths.js';

export * from './platform/index.js';

export {
  INSTANCE_LOCK_EXIT_CODE,
  acquireInstanceLock,
  describeLockConflict,
  instanceLockPath,
} from './instance-lock.js';
export type {
  AcquireLockOptions,
  AcquireLockResult,
  InstanceLockHandle,
  InstanceLockInfo,
} from './instance-lock.js';

export { AppStore, ProjectStore } from './store.js';

export { ProjectRepo } from './repo/projects.js';
export type { Project, CreateProjectInput } from './repo/projects.js';

export { ConversationRepo, MessageRepo, ToolCallRepo } from './repo/conversations.js';
export type {
  Conversation,
  ConversationStatus,
  Message,
  MessageRole,
  MessagePage,
  AppendMessageInput,
  ToolCall,
  ToolCallStatus,
  Usage,
} from './repo/conversations.js';

export * from './sandbox/index.js';

export {
  CredentialVault,
  providerRef,
  dpapiAvailable,
  DpapiUnavailableError,
} from './credentials/vault.js';
export type { CredentialRef } from './credentials/vault.js';

export * from './router/index.js';

export { RegistryRepo, RegistrySync, buildRouterView, HEALTH_TTL_MS } from './repo/registry.js';
export type { ProviderRecord, ModelRecord, ModelHealth, SyncResult } from './repo/registry.js';

export { UsageRepo, classifyFailure, redactError } from './repo/usage.js';
export type {
  CallStatus,
  FailureBreakdown,
  ModelUsageSummary,
  TimeRange,
  UsageRecord,
  UsageRow,
  UsageSummary,
} from './repo/usage.js';

export { RoutingRepo, SIGNAL_WEIGHT } from './repo/routing.js';
export type { FeedbackRecord, FeedbackSignal, FeedbackSource } from './repo/routing.js';

export * from './skills/index.js';

export * from './plan/index.js';

export * from './hostapi/index.js';

export * from './reviewer/index.js';

export * from './memory/index.js';

export * from './mcp/index.js';

export * from './refs/index.js';

export * from './manuscript/index.js';

export * from './compute/index.js';

export * from './envs/index.js';

export { EnvsRepo } from './repo/envs.js';
export type { EnvRecord } from './repo/envs.js';

export {
  ComputeGrantsRepo,
  ComputeJobsRepo,
  ComputeTargetsRepo,
  MAX_GRANT_SCOPE,
  clampGrantScope,
  grantScopeOptions,
} from './repo/compute.js';
export type {
  ComputeGrant,
  ComputeGrantRisk,
  ComputeJobRecord,
  ComputeTargetRecord,
  TerminalSource,
} from './repo/compute.js';

export { ClaimsRepo } from './repo/claims.js';
export type {
  CitationCheckRecord,
  CitationVerdict,
  ClaimEvidence,
  ClaimEvidenceKind,
  ClaimOrigin,
  ClaimRecord,
  ClaimStatus,
  ClaimVerdict,
} from './repo/claims.js';
export {
  CLAIM_ORIGIN_LABEL,
  CLAIM_STATUS_LABEL,
  EVIDENCE_KIND_LABEL,
  OPEN_CLAIM_STATUSES,
  VERDICT_LABEL,
} from './repo/claims.js';

export { MANUSCRIPT_STATUS_LABEL, ManuscriptRepo } from './repo/manuscripts.js';
export type { CompileRunRecord, ManuscriptRecord, ManuscriptStatus } from './repo/manuscripts.js';

export { FULL_SCAN_LIMIT, RefsRepo, mergeSourceLabel } from './repo/refs.js';
export type {
  FetchOutcome,
  RefAlias,
  RefAliasScheme,
  RefAsset,
  RefAssetKind,
  RefFetchAttempt,
  RefRecord,
} from './repo/refs.js';

export { ConnectorRepo } from './repo/connectors.js';
export type {
  ConnectorGroup,
  ConnectorKind,
  ConnectorRecord,
  ToolGrant,
} from './repo/connectors.js';

export { MemoryRepo, normalizeMemoryContent } from './repo/memory.js';
export type { MemoryKind, MemoryNote, MemoryRepoOptions, MemoryScope } from './repo/memory.js';

export { PlanRepo, planStepId } from './repo/plans.js';
export type { PlanRecord, PlanStepRecord } from './repo/plans.js';

export { FindingsRepo } from './repo/findings.js';
export type {
  Finding,
  FindingCategory,
  FindingEvidence,
  FindingSeverity,
  FindingStatus,
  ReviewerRun,
  ReviewerRunStatus,
  ReviewerTrigger,
} from './repo/findings.js';

export { SkillAuditRepo, SkillRepo } from './repo/skills.js';
export type {
  SkillLoadEvent,
  SkillLoadReason,
  SkillRecord,
  SkillSyncResult,
} from './repo/skills.js';

export * from './approval/index.js';
export { ApprovalRepo } from './repo/approvals.js';
export type { ApprovalRow, ApprovalState } from './repo/approvals.js';

export { GrantRepo } from './repo/grants.js';
export type { HostGrant, DomainGrant, GrantMode, GrantInvalidReason } from './repo/grants.js';

export { requestHostAccess, normalizeHostPath, assessHostPath } from './sandbox/host-access.js';
export type { HostAccessDecision, RequestHostAccessInput } from './sandbox/host-access.js';

export { EgressProxy, isLoopback, parseTarget } from './sandbox/egress-proxy.js';
export type { EgressAttempt, EgressProxyOptions, EgressVerdict } from './sandbox/egress-proxy.js';

export * from './tools/index.js';

export * from './artifact/index.js';

export * from './orchestrator/index.js';

export {
  JobObject,
  InterruptEvent,
  nativeCapabilities,
  resetWin32Cache,
  win32,
  win32Available,
  win32UnavailableReason,
} from './win32/index.js';
export type { JobLimits, NativeCapabilities, Win32Api } from './win32/index.js';

export { Dispatcher, DispatchError } from './dispatcher.js';
export type { HandlerContext, RequestHandler, EventSink } from './dispatcher.js';

export { LineDecoder, StdioTransport, DEFAULT_MAX_FRAME_BYTES } from './transport.js';
export type { TransportOptions, DecodeResult } from './transport.js';
