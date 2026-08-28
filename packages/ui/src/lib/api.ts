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

/**
 * 本次回合的路由覆盖（需求 7.14）。
 *
 * 与后端 `routingOverrideSchema` 同形。`weightOverrides` 是**完整替换**用的
 * 权重表而不是增量——合并语义下「把某个维度调到 0」无法表达。
 */
export interface RoutingOverride {
  forcedModelId?: string;
  weightOverrides?: Partial<Record<StrengthKey, number>>;
  taskType?: TaskType;
  preferLocal?: boolean;
  requireTrainingOptOut?: boolean;
  costBudget?: number;
  latencyBudgetMs?: number;
}

export const sendMessage = (conversationId: string, text: string, routing?: RoutingOverride) =>
  invoke<{ delivered: boolean; events: number }>({
    method: 'conversation.send',
    conversationId,
    text,
    // 空对象也不传：后端会把它当成「没有覆盖」，但传过去会让请求里多一个
    // 无意义的字段，日后排查时看着像是用户真的设置过什么
    ...(routing === undefined || Object.keys(routing).length === 0 ? {} : { routing }),
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
  excluded: Array<{
    modelId: string;
    reason: string;
    detail?: string;
    /**
     * 原因的中文说明，由路由层随决策一起给出。
     *
     * 刻意不在这里维护一份原因码到文案的映射表：新增一种排除原因时会漏改，
     * 而漏改的表现是界面上冒出一个裸的英文原因码。旧决策记录可能没有这个字段。
     */
    reasonText?: string;
  }>;
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

/* ------------------------------------------------------------------ *
 * 供应商与模型注册表（任务 11.1b，需求 8.5、8.6）
 * ------------------------------------------------------------------ */

/** 能力维度。与后端 `ModelStrengths` 的键一一对应。 */
export type StrengthKey =
  | 'reasoning'
  | 'coding'
  | 'math'
  | 'longContextRecall'
  | 'writingZh'
  | 'writingEn'
  | 'toolUse'
  | 'structuredOutput'
  | 'citationFidelity'
  | 'instructionFollowing';

export type TaskType =
  | 'route.classify'
  | 'literature.screen'
  | 'pdf.deepread'
  | 'analysis.codegen'
  | 'stats.reason'
  | 'signal.pipeline'
  | 'figure.compose'
  | 'manuscript.draft'
  | 'manuscript.polish'
  | 'manuscript.translate'
  | 'review.simulate'
  | 'citation.verify'
  | 'reviewer.audit';

/** 能力维度的中文名。设置页与决策面板都要显示它们。 */
export const STRENGTH_LABEL: Readonly<Record<StrengthKey, string>> = {
  reasoning: '推理',
  coding: '写代码',
  math: '数学与统计',
  longContextRecall: '长文召回',
  writingZh: '中文写作',
  writingEn: '英文写作',
  toolUse: '工具调用',
  structuredOutput: '结构化输出',
  citationFidelity: '引文可靠性',
  instructionFollowing: '指令跟随',
};

/** 任务类型的中文名。 */
export const TASK_LABEL: Readonly<Record<TaskType, string>> = {
  'route.classify': '任务分类',
  'literature.screen': '文献粗筛',
  'pdf.deepread': 'PDF 深读',
  'analysis.codegen': '生成分析代码',
  'stats.reason': '统计推理',
  'signal.pipeline': '信号处理流水线',
  'figure.compose': '出图',
  'manuscript.draft': '起草手稿',
  'manuscript.polish': '润色',
  'manuscript.translate': '翻译',
  'review.simulate': '模拟审稿',
  'citation.verify': '核对引文',
  'reviewer.audit': '独立审查',
};

export interface ModelStrengths {
  reasoning: number;
  coding: number;
  math: number;
  longContextRecall: number;
  writingZh: number;
  writingEn: number;
  toolUse: number;
  structuredOutput: number;
  citationFidelity: number;
  instructionFollowing: number;
}

export interface ModelDescriptorView {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  modalities: string[];
  strengths: ModelStrengths;
  pricing: { inputPer1k: number; outputPer1k: number; currency: string };
  performance: { medianLatencyMs: number; tokensPerSec: number };
  policy: {
    trainingUse: 'none' | 'opt-out-required' | 'yes' | 'unknown';
    retentionDays: number | null;
    zdr: boolean;
    region: string;
    evidenceUrl?: string;
  };
  local: boolean;
  features: {
    streaming: boolean;
    toolUse: boolean;
    promptCache: boolean;
    vision: boolean;
    thinking: boolean;
  };
}

export interface ModelHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  checkedAt: number;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelName: string;
  descriptor: ModelDescriptorView;
  enabled: boolean;
  health: ModelHealth | null;
}

export interface ProviderView {
  id: string;
  name: string;
  adapter: string;
  baseUrl: string | null;
  /** 凭据库里的引用名。**不是密钥**。 */
  credentialRef: string | null;
  policy: Record<string, unknown> | null;
  enabled: boolean;
  /** 该 adapter 是否在后端注册过。为假说明这条记录指向一个不存在的适配器。 */
  adapterRegistered: boolean;
  /** 绑定的引用名在凭据库里是否真的存在。 */
  credentialPresent: boolean;
  modelCount: number;
  enabledModelCount: number;
}

export const listProviders = () =>
  invoke<{ vaultAvailable: boolean; providers: ProviderView[] }>({ method: 'provider.list' });

export const setProviderEnabled = (providerId: string, enabled: boolean) =>
  invoke<{ providerId: string; enabled: boolean }>({
    method: 'provider.setEnabled',
    providerId,
    enabled,
  });

export const setProviderCredentialRef = (providerId: string, credentialRef: string | null) =>
  invoke<{ providerId: string; credentialRef: string | null }>({
    method: 'provider.setCredentialRef',
    providerId,
    credentialRef,
  });

export const syncProvider = (providerId: string) =>
  invoke<{
    added: string[];
    updated: string[];
    disappeared: string[];
    models: ModelRecord[];
  }>({ method: 'provider.sync', providerId });

export const checkProviderHealth = (providerId: string) =>
  invoke<{ providerId: string; health: ModelHealth; appliedTo: number }>({
    method: 'provider.checkHealth',
    providerId,
  });

export const listModels = (providerId?: string) =>
  invoke<{ models: ModelRecord[] }>({
    method: 'model.list',
    includeDisabled: true,
    ...(providerId === undefined ? {} : { providerId }),
  });

export const setModelEnabled = (modelId: string, enabled: boolean) =>
  invoke<{ modelId: string; enabled: boolean }>({
    method: 'model.setEnabled',
    modelId,
    enabled,
  });

/* ------------------------------------------------------------------ *
 * 凭据（只出键名与指纹，永不出密钥）
 * ------------------------------------------------------------------ */

export interface CredentialFingerprint {
  length: number;
  tail: string;
}

export const listCredentials = () =>
  invoke<{
    /** 这台机器能否加密存储凭据（依赖 Windows DPAPI）。 */
    available: boolean;
    credentials: Array<{ ref: string; fingerprint: CredentialFingerprint | null }>;
  }>({ method: 'credential.list' });

export const setCredential = (ref: string, secret: string) =>
  invoke<{ ref: string; fingerprint: CredentialFingerprint | null }>({
    method: 'credential.set',
    ref,
    secret,
  });

export const deleteCredential = (ref: string) =>
  invoke<{ deleted: boolean }>({ method: 'credential.delete', ref });

/* ------------------------------------------------------------------ *
 * 路由试算（任务 11.11，需求 7.6、7.14）
 * ------------------------------------------------------------------ */

export interface RoutingCandidate {
  id: string;
  providerId: string;
  displayName: string;
  local: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputPer1k: number; outputPer1k: number; currency: string };
}

export interface RoutingPreview {
  decision: RoutingDecision;
  candidates: RoutingCandidate[];
  /** 候选为空时的可执行说明。非空时为 null。 */
  emptyReport: string | null;
  /** 本次生效的权重表。用户据此看清没覆盖的维度默认是多少。 */
  weights: Partial<Record<StrengthKey, number>>;
}

export const previewRouting = (input: {
  taskType: TaskType;
  estimatedInputTokens?: number;
  expectedOutputTokens?: number;
  needToolUse?: boolean;
  projectId?: string;
  routing?: RoutingOverride;
}) =>
  invoke<RoutingPreview>({
    method: 'routing.preview',
    taskType: input.taskType,
    ...(input.estimatedInputTokens === undefined
      ? {}
      : { estimatedInputTokens: input.estimatedInputTokens }),
    ...(input.expectedOutputTokens === undefined
      ? {}
      : { expectedOutputTokens: input.expectedOutputTokens }),
    ...(input.needToolUse === undefined ? {} : { needToolUse: input.needToolUse }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.routing === undefined || Object.keys(input.routing).length === 0
      ? {}
      : { routing: input.routing }),
  });
