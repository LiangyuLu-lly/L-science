/**
 * 按方法名定型的后端调用。
 *
 * 与 `backend.ts` 的分工：那一层负责桥接与错误码还原，这一层负责把「有哪些方法、
 * 各自要什么参数返回什么」写成类型。分开是因为前者在没有 Electron 时也要能
 * 加载（浏览器里直接开 UI 会走 no-bridge 分支），而后者纯粹是类型层。
 */

import { invoke } from './backend.js';

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type ConversationStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'awaiting_approval'
  | 'awaiting_user_input'
  | 'background_pending';

export interface Conversation {
  id: string;
  title: string | null;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  modelId: string | null;
  providerId: string | null;
  usage: { tokensIn: number; tokensOut: number; cost: number; currency: string } | null;
  createdAt: number;
}

export interface ToolCallRecord {
  id: string;
  messageId: string;
  toolName: string;
  status: 'running' | 'ok' | 'error' | 'denied' | 'interrupted';
  input: unknown;
  output: unknown;
  startedAt: number;
  endedAt: number | null;
}

export const listProjects = (includeArchived = false) =>
  invoke<{ projects: Project[] }>({ method: 'project.list', includeArchived });

export const createProject = (name: string) =>
  invoke<{ project: Project }>({ method: 'project.create', name });

export const listConversations = (projectId: string) =>
  invoke<{ conversations: Conversation[] }>({ method: 'conversation.list', projectId });

export const createConversation = (projectId: string, title?: string) =>
  invoke<{ conversation: Conversation }>({
    method: 'conversation.create',
    projectId,
    ...(title === undefined ? {} : { title }),
  });

export const loadHistory = (conversationId: string, beforeSeq?: number) =>
  invoke<{
    projectId: string;
    page: { messages: StoredMessage[]; hasMore: boolean; oldestSeq: number | null };
  }>({
    method: 'conversation.history',
    conversationId,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
  });

export const sendMessage = (conversationId: string, text: string) =>
  invoke<{ delivered: boolean; events: number }>({
    method: 'conversation.send',
    conversationId,
    text,
  });

export const interruptConversation = (conversationId: string) =>
  invoke<{ interrupted: boolean }>({ method: 'conversation.interrupt', conversationId });

/* ------------------------------------------------------------------ *
 * 审批与提问
 * ------------------------------------------------------------------ */

export type GrantScope = 'once' | 'session' | 'project' | 'always';

export interface ApprovalRequest {
  id: string;
  kind: 'artifact-delete' | 'host-access' | 'ssh-command' | 'compute-provider' | 'domain-allowlist';
  title: string;
  detail: string;
  impact: string;
  reversible: boolean;
  undoHint: string | null;
  scopeOptions: GrantScope[];
  payload: unknown;
}

export interface UserQuestion {
  id: string;
  kind: 'general' | 'compute-config';
  question: string;
  detail: string | null;
  choices: string[];
}

export const decideApproval = (
  approvalId: string,
  decision: 'approve' | 'deny',
  options: { note?: string; scope?: GrantScope } = {},
) =>
  invoke<{ settled: boolean }>({
    method: 'approval.decide',
    approvalId,
    decision,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });

export const answerQuestion = (questionId: string, answer: string) =>
  invoke<{ answered: boolean }>({ method: 'question.answer', questionId, answer });

/* ------------------------------------------------------------------ *
 * 制品
 * ------------------------------------------------------------------ */

export type ArtifactKind = 'image' | 'table' | 'document' | 'data' | 'code' | 'other';

export interface ArtifactSummary {
  id: string;
  filename: string;
  mime: string | null;
  kind: ArtifactKind | null;
  latestVersionId: string | null;
  createdAt: number;
  deletedAt: number | null;
  versionCount: number;
  /** 最新版本是否具备可复现血缘。false 时 UI 要标出来（需求 6.6）。 */
  reproducible: boolean;
}

export interface ArtifactVersionInfo {
  id: string;
  artifactId: string;
  versionNo: number;
  blobSha256: string;
  language: string | null;
  codeLineage: {
    code: string | null;
    language: string | null;
    inputVersionIds: string[];
    reproducible: boolean;
    gap: string | null;
  } | null;
  createdAt: number;
}

export interface LineageNode {
  versionId: string;
  artifactId: string;
  filename: string;
  versionNo: number;
  depth: number;
  relation: string | null;
}

export interface DeleteCandidate {
  artifactId: string;
  filename: string;
  versionCount: number;
  totalBytes: number;
  dependentCount: number;
}

export const listArtifacts = (projectId: string, includeDeleted = false) =>
  invoke<{ artifacts: ArtifactSummary[] }>({ method: 'artifact.list', projectId, includeDeleted });

export const listArtifactVersions = (projectId: string, artifactId: string) =>
  invoke<{ versions: ArtifactVersionInfo[] }>({
    method: 'artifact.versions',
    projectId,
    artifactId,
  });

export const loadLineage = (projectId: string, versionId: string) =>
  invoke<{ ancestors: LineageNode[]; descendants: LineageNode[] }>({
    method: 'artifact.lineage',
    projectId,
    versionId,
  });

export const describeDeletion = (projectId: string, artifactIds: string[]) =>
  invoke<{ candidates: DeleteCandidate[] }>({
    method: 'artifact.describeDeletion',
    projectId,
    artifactIds,
  });

export const restoreArtifact = (projectId: string, artifactId: string) =>
  invoke<{ restored: boolean }>({ method: 'artifact.restore', projectId, artifactId });

/* ------------------------------------------------------------------ *
 * 环境
 * ------------------------------------------------------------------ */

export interface IsolationInfo {
  backend: 'native' | 'wsl2' | 'docker';
  isolation: {
    backend: string;
    filesystem: 'namespace' | 'acl' | 'advisory';
    network: 'namespace' | 'proxy' | 'none';
    process: 'job-object' | 'cgroup' | 'none';
    /** 必须原文展示。诚实降级依赖这一点，不允许把弱隔离包装成强隔离。 */
    caveats: string[];
  };
  strength: 'strong' | 'weak';
  skipped: Array<{ backend: string; reason: string }>;
}

export interface ToolListing {
  available: Array<{ name: string; description: string; parameters: unknown }>;
  unavailable: Array<{
    name: string;
    missing: Array<{ capability: string; remediation: string }>;
    explanation: string;
  }>;
  capabilities: string[];
  pythonEnv: string | null;
  rEnv: string | null;
}

export const loadIsolation = () => invoke<IsolationInfo>({ method: 'sandbox.isolation' });

export const listTools = (projectId: string) =>
  invoke<ToolListing>({ method: 'tool.list', projectId });

/* ------------------------------------------------------------------ *
 * 回合事件
 * ------------------------------------------------------------------ */

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  currency: string;
}

export type ToolOutput =
  | { kind: 'text'; text: string }
  | { kind: 'rich'; data: Record<string, unknown> }
  | { kind: 'error'; ename: string; evalue: string; traceback: string[] };

export interface RoutingDecision {
  id: string;
  taskType: string;
  chosenModelId: string | null;
  scores: Array<{ modelId: string; total: number; breakdown: Record<string, number> }>;
  excluded: Array<{ modelId: string; reason: string; detail?: string }>;
  reason: string;
  createdAt: number;
}

export type TurnEvent =
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string }
  | { kind: 'tool.start'; callId: string; tool: string; input: unknown }
  | { kind: 'tool.output'; callId: string; output: ToolOutput }
  | { kind: 'routing.decision'; decision: RoutingDecision }
  | { kind: 'approval.request'; approval: ApprovalRequest }
  | { kind: 'question.request'; question: UserQuestion }
  | { kind: 'turn.end'; usage: Usage };

/** 判断一个事件载荷是不是回合事件。事件通道上还有别的东西（审批广播等）。 */
export function isTurnEvent(payload: unknown): payload is TurnEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { kind?: unknown }).kind === 'string'
  );
}

/* ------------------------------------------------------------------ *
 * 用量与成本（需求 18）
 * ------------------------------------------------------------------ */

export type CallStatus =
  | 'ok'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'aborted'
  | 'auth-failed'
  | 'content-filtered'
  | 'bad-request'
  | 'network-error'
  | 'unknown-error';

export interface UsageSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  succeeded: number;
  medianLatencyMs: number;
}

export interface ModelUsageSummary extends UsageSummary {
  providerId: string;
  modelId: string;
}

export interface FailureBreakdown {
  status: CallStatus;
  count: number;
  lastError: string | null;
  lastAt: number;
}

export interface UsageRow {
  id: number;
  ts: number;
  conversationId: string | null;
  providerId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  status: CallStatus;
  error: string | null;
}

export type FeedbackSignal =
  'accepted' | 'retried' | 'edited' | 'reviewer-finding' | 'tool-failure' | 'user-override';

export const loadUsageSummary = (
  projectId: string,
  options: { conversationId?: string; from?: number; to?: number } = {},
) =>
  invoke<{ scope: 'project' | 'conversation'; summary: UsageSummary }>({
    method: 'usage.summary',
    projectId,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });

export const loadUsageBreakdown = (
  projectId: string,
  options: { from?: number; to?: number } = {},
) =>
  invoke<{
    byModel: ModelUsageSummary[];
    failures: FailureBreakdown[];
    daily: Array<{ date: string; calls: number; cost: number }>;
    recent: UsageRow[];
  }>({
    method: 'usage.breakdown',
    projectId,
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });

export const loadRoutingHistory = (projectId: string, conversationId: string, limit = 50) =>
  invoke<{ decisions: RoutingDecision[] }>({
    method: 'routing.history',
    projectId,
    conversationId,
    limit,
  });

export const sendFeedback = (
  projectId: string,
  routingDecisionId: string,
  signal: FeedbackSignal,
  source: 'user' | 'reviewer' | 'system' = 'user',
) =>
  invoke<{ recorded: true }>({
    method: 'routing.feedback',
    projectId,
    routingDecisionId,
    signal,
    source,
  });
