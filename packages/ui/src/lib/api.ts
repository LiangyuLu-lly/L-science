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

export const sendMessage = (
  conversationId: string,
  text: string,
  routing?: RoutingOverride,
  /** 用 `/` 显式插入的技能 slug。后端会直接把内容放进本回合历史。 */
  skills?: readonly string[],
) =>
  invoke<{ delivered: boolean; events: number }>({
    method: 'conversation.send',
    conversationId,
    text,
    // 空对象也不传：后端会把它当成「没有覆盖」，但传过去会让请求里多一个
    // 无意义的字段，日后排查时看着像是用户真的设置过什么
    ...(routing === undefined || Object.keys(routing).length === 0 ? {} : { routing }),
    ...(skills === undefined || skills.length === 0 ? {} : { skills: [...skills] }),
  });

export const interruptConversation = (conversationId: string) =>
  invoke<{ interrupted: boolean }>({ method: 'conversation.interrupt', conversationId });

/* ------------------------------------------------------------------ *
 * 审批与提问
 * ------------------------------------------------------------------ */

export type GrantScope = 'once' | 'session' | 'project' | 'always';

export interface ApprovalRequest {
  id: string;
  kind:
    | 'artifact-delete'
    | 'host-access'
    | 'compute-target'
    | 'ssh-command'
    | 'compute-job'
    | 'compute-provider'
    | 'domain-allowlist'
    | 'skill-write'
    | 'package-install';
  title: string;
  detail: string;
  impact: string;
  reversible: boolean;
  undoHint: string | null;
  scopeOptions: GrantScope[];
  /**
   * 可选的有效期档位（毫秒），null 表示「不过期」（需求 17.5）。
   *
   * 可选属性而不是必填：后端可能是旧版本，那时缺这个字段应当退化成「不显示有效期
   * 选择」，而不是让整张卡片渲染失败——审批卡片是阻塞交互，渲染失败等于用户卡住了。
   */
  expiryOptions?: (number | null)[];
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
  options: { note?: string; scope?: GrantScope; expiresInMs?: number | null } = {},
) =>
  invoke<{ settled: boolean }>({
    method: 'approval.decide',
    approvalId,
    decision,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    // null 是有意义的取值（「不过期」），因此只在 undefined 时省略
    ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
  });

/* --- 审批审计（需求 17.1、17.5）--- */

export interface ApprovalHistoryEntry {
  id: string;
  conversationId: string | null;
  kind: ApprovalRequest['kind'];
  state: 'pending' | 'approved' | 'denied' | 'timeout' | 'abandoned';
  note: string | null;
  requestedAt: number;
  decidedAt: number | null;
  title: string;
  detail: string;
  impact: string;
  reversible: boolean;
  payload: unknown;
  /** 这条拒绝是否仍在本次运行的拒绝记忆里，即同一请求还会被自动拒绝。 */
  stillDenied: boolean;
}

export const listPendingApprovals = (projectId?: string) =>
  invoke<{
    pending: { request: ApprovalRequest; conversationId: string | null; projectId: string }[];
  }>({
    method: 'approval.pending',
    ...(projectId === undefined ? {} : { projectId }),
  });

export const listApprovalHistory = (
  projectId: string,
  options: { conversationId?: string; state?: ApprovalHistoryEntry['state']; limit?: number } = {},
) =>
  invoke<{ approvals: ApprovalHistoryEntry[]; note: string }>({
    method: 'approval.history',
    projectId,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

/**
 * 撤销一条拒绝记忆（需求 17.5）。
 *
 * 需求 17.3 要求拒绝后不得重试同一请求，而这条规则在用户改主意时会挡住他自己——
 * 他明确说「现在可以了」，系统仍然直接拒绝且不给被询问的机会。
 */
export const forgetApprovalDenial = (approvalId: string) =>
  invoke<{ forgotten: boolean }>({ method: 'approval.forgetDenial', approvalId });

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

/* ------------------------------------------------------------------ *
 * 论文主路径：文献 / 断言 / 手稿（IPC 已有，视图此前没接）
 * ------------------------------------------------------------------ */

export interface RefListItem {
  id: string;
  doi: string | null;
  cite: string;
  title: string | null;
  year: number | null;
  container: string | null;
  firstAuthor: string | null;
  oaStatus: string | null;
  fulltextArtifactId: string | null;
  retracted: boolean;
}

export const listRefs = (projectId: string) =>
  invoke<{ refs: RefListItem[]; stats: { total: number } }>({ method: 'ref.list', projectId });

export type RefResolveOutcome = {
  readonly input: string;
  readonly ok: boolean;
  readonly refId: string | null;
  readonly cite: string | null;
  readonly created: boolean;
  readonly reason: string | null;
};

export const resolveRefs = (projectId: string, identifiers: readonly string[]) =>
  invoke<{
    created: number;
    duplicates: number;
    failed: number;
    outcomes: readonly RefResolveOutcome[];
  }>({
    method: 'ref.resolve',
    projectId,
    identifiers: [...identifiers],
  });

export interface ClaimListItem {
  id: string;
  text: string;
  status: string;
  kind: string;
  origin: string;
  unsupported: boolean;
  verifiedCount: number;
  locator: string | null;
  section: string | null;
}

export interface ClaimListSummary {
  total: number;
  unresolved: number;
  unsupported: number;
  refuted: number;
  supported: number;
}

export const listClaims = (projectId: string) =>
  invoke<{ claims: ClaimListItem[]; summary: ClaimListSummary }>({
    method: 'claim.list',
    projectId,
    status: 'all',
  });

export interface ManuscriptListItem {
  id: string;
  title: string | null;
  status: string;
  targetJournal: string | null;
  updatedAt: number | null;
}

export const listManuscripts = (projectId: string) =>
  invoke<{ manuscripts: ManuscriptListItem[] }>({ method: 'manuscript.list', projectId });

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
  /**
   * 平台缺口（需求 20.4.1）。Windows 上 `gaps` 为空数组。
   *
   * 与隔离报告放在同一个响应里，因为它们是同一个问题的两半：「沙箱能做到什么」加上
   * 「这个平台上哪几项能力是降级的」。
   */
  platform: {
    id: string;
    label: string;
    unknown: boolean;
    gaps: Array<{ id: string; what: string; consequence: string; plan: string | null }>;
  };
  /**
   * 被跳过的更强后端。
   *
   * 字段名是 `id` 而不是 `backend`：控制面用的是 `SkippedBackend { id, reason }`，
   * 而这里曾经写成 `backend`，于是「为什么没用更强的隔离」那一段里后端名渲染成空白。
   */
  skipped: Array<{ id: string; reason: string }>;
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

export type EnvDoctorGap = {
  readonly id: string;
  readonly what: string;
  readonly consequence: string;
  readonly plan: string | null;
};

export type EnvDoctorBlocker = {
  readonly id: string;
  readonly what: string;
  readonly consequence: string;
  readonly command: string;
};

export type EnvDoctor = {
  readonly dataDir: string;
  readonly dataDirSource: 'env' | 'platform-default';
  readonly dataDirLabel: string;
  readonly platform: string;
  readonly gaps: readonly EnvDoctorGap[];
  readonly capabilities: string;
  readonly blockers: readonly EnvDoctorBlocker[];
};

export const loadEnvDoctor = (refresh = false) =>
  invoke<EnvDoctor>({ method: 'env.doctor', refresh });

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
  // 这两个此前漏在这份副本里，导致 findings 视图想按 kind 匹配时 TS 说它不是合法值
  | { kind: 'finding.raised'; finding: Finding }
  | {
      kind: 'artifact.saved';
      artifact: { versionId: string; artifactId: string; filename: string };
    }
  | { kind: 'turn.end'; usage: Usage };

/**
 * 后端推来的**广播**事件（`id === null` 的那些）。
 *
 * 与 `TurnEvent` 分开是因为它们不属于任何一个回合：计划被创建、审查跑完、
 * 技能目录变了，都可能发生在没有活跃回合的时候。
 *
 * 这份类型在 shared 里不存在——`eventFrameSchema.payload` 是 `z.unknown()`，
 * 刻意不在传输层重复校验以免两处漂移。因此它的权威来源是 backend 里的
 * `d.broadcast({...})` 字面量，改那边时要同步改这里。
 */
export type BroadcastEvent =
  | { kind: 'plan.created'; planId: string; conversationId: string; projectId: string }
  | {
      kind: 'plan.decided';
      planId: string;
      conversationId: string;
      projectId: string;
      decision: 'approve' | 'reject';
      note: string | null;
    }
  | { kind: 'finding.raised'; projectId: string; finding: Finding }
  | {
      kind: 'reviewer.finished';
      projectId: string;
      conversationId: string;
      runId: string;
      status: 'done' | 'failed' | 'degraded';
      summary: string;
    }
  /** 技能是全局的，因此这个事件没有 projectId。 */
  | { kind: 'skill.changed'; slug: string; action: 'created' | 'updated' | 'deleted' }
  | {
      kind: 'background.notice';
      projectId: string;
      conversationId: string;
      taskId: string;
      label: string;
      state: string;
      output: unknown;
      durationMs: number;
    };

/**
 * 判断一个事件载荷是不是回合事件。
 *
 * **它是宽松判定**：只看有没有字符串 `kind`。事件通道上广播事件也长这样，
 * 所以它们会一并被交给回合处理器然后落到无匹配分支被忽略——功能上无害，但
 * 这意味着**不能靠它区分回合事件与广播事件**。要区分请用 `isBroadcastKind`。
 */
export function isTurnEvent(payload: unknown): payload is TurnEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { kind?: unknown }).kind === 'string'
  );
}

const BROADCAST_KINDS: ReadonlySet<string> = new Set([
  'plan.created',
  'plan.decided',
  'finding.raised',
  'reviewer.finished',
  'skill.changed',
  'background.notice',
]);

/** 精确判定广播事件。新视图按它过滤，避免把回合分片也当成刷新信号。 */
export function isBroadcastEvent(payload: unknown): payload is BroadcastEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    BROADCAST_KINDS.has(String((payload as { kind?: unknown }).kind))
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
  | 'reviewer.audit'
  | 'skill.distill';

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
  'skill.distill': '蒸馏技能',
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

export type ProvisionSkipReason = 'missing_key' | 'health_failed' | 'not_requested';

export type ProvisionProviderResult =
  | {
      readonly id: string;
      readonly name: string;
      readonly status: 'registered';
      readonly latencyMs: number;
      readonly added: readonly string[];
      readonly updated: readonly string[];
      readonly disappeared: readonly string[];
      readonly modelIds: readonly string[];
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly status: 'skipped';
      readonly reason: ProvisionSkipReason;
      readonly detail?: string;
    };

export type ProvisionResult = {
  readonly providers: readonly ProvisionProviderResult[];
};

export const provisionProviders = (
  input: { readonly deepseekKey?: string; readonly detectOllama?: boolean } = {},
) =>
  invoke<ProvisionResult>({
    method: 'provider.provision',
    ...(input.deepseekKey === undefined ? {} : { deepseekKey: input.deepseekKey }),
    ...(input.detectOllama === undefined ? {} : { detectOllama: input.detectOllama }),
  });

export const registerCompatProvider = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly name?: string;
}) =>
  invoke<{
    providerId: string;
    name: string;
    added: string[];
    updated: string[];
    disappeared: string[];
    modelIds: string[];
  }>({
    method: 'provider.registerCompat',
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    ...(input.name === undefined ? {} : { name: input.name }),
  });

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

/* ------------------------------------------------------------------ *
 * 技能（任务 12.16，需求 9.1、9.2、9.6、9.8）
 * ------------------------------------------------------------------ */

export type SkillScope = 'builtin' | 'user';

export interface SkillRequires {
  python?: string[];
  r?: string[];
  commands?: string[];
  connectors?: string[];
  capabilities?: string[];
}

export interface SkillListItem {
  slug: string;
  name: string;
  version: string | null;
  scope: SkillScope;
  domain: string | null;
  description: string;
  triggers: string[];
  tools: string[];
  requires: SkillRequires;
  enabled: boolean;
  path: string;
  /**
   * 文件系统上是否还在。
   *
   * 同步只禁用不删行，所以库里有记录不等于文件还在。区分两者是必要的：
   * 「我删了目录但列表里还有」与「它被禁用了」是完全不同的两件事。
   */
  present: boolean;
  references: string[];
  scripts: string[];
  warnings: string[];
  requirementsSatisfied: boolean | null;
  missing: Array<{ kind: string; name: string; remediation: string }>;
  probeFailures: Array<{ kind: string; reason: string }>;
}

export interface SkillCatalogView {
  /** 词法检索永远可用；向量层可选。界面要能说出当前是哪种状态。 */
  vectorsReady: boolean;
  embedFailure: string | null;
  builtinDir: string;
  userDir: string;
  skills: SkillListItem[];
  /** 被用户技能遮蔽的内置技能。查不到它，「我的改动生效了吗」无从确认。 */
  shadowed: Array<{ slug: string; name: string; version: string | null; path: string }>;
  broken: Array<{ path: string; scope: SkillScope; dirName: string; reason: string }>;
  /** 清单合法但不启用的技能。必须带原因展示。 */
  unavailable: Array<{
    slug: string;
    name: string;
    path: string;
    scope: SkillScope;
    reason: string;
  }>;
}

export interface SkillSearchHitView {
  slug: string;
  name: string;
  domain: string | null;
  description: string;
  scope: SkillScope;
  score: number;
  lexicalScore: number;
  vectorScore: number | null;
  matchedTerms: string[];
  requirementsSatisfied: boolean;
  missingSummary: string | null;
  references: string[];
}

export type SkillOriginKind =
  'authored' | 'model' | 'archive' | 'directory' | 'github' | 'distilled';

export interface SkillOriginView {
  kind: SkillOriginKind;
  source: string | null;
  detail: string | null;
  createdAt: number;
  contentSha256: string | null;
}

/** 来源的中文名。`kind` 分得细是有用的：github 能重拉，authored 不能。 */
export const SKILL_ORIGIN_LABEL: Readonly<Record<SkillOriginKind, string>> = {
  authored: '手工编写',
  model: '对话中生成',
  archive: '压缩包导入',
  directory: '本机目录导入',
  github: 'GitHub 导入',
  distilled: '会话蒸馏',
};

export interface SkillSourceView {
  slug: string;
  scope: SkillScope;
  path: string;
  manifest: string;
  skillMd: string;
  references: string[];
  scripts: string[];
  provider: unknown;
  hasProviderScript: boolean;
  warnings: string[];
  origin: SkillOriginView | null;
  /** 内置技能不能原地改：改动会在下次启动被同步覆盖。 */
  editable: boolean;
}

export interface SkillWriteResult {
  ok: boolean;
  slug: string | null;
  path: string | null;
  errors: string[];
  warnings: string[];
  replaced: boolean;
  shadowsBuiltin: boolean;
}

export interface SkillValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  slug: string | null;
  conflictsWith: { slug: string; name: string; scope: SkillScope } | null;
}

export interface SkillImportOutcome {
  ok: boolean;
  errors: string[];
  skipped: string[];
  source: string | null;
  skills: Array<SkillWriteResult & { location: string }>;
}

export interface SkillDistillResult {
  ok: boolean;
  reason?: string;
  insufficient?: boolean;
  modelId?: string;
  context?: { included: number; truncated: boolean };
  slug?: string;
  manifest?: string;
  instructions?: string;
  contentWarnings?: string[];
  manifestWarnings?: string[];
  conflictsWith?: { slug: string; name: string; scope: SkillScope } | null;
}

export interface SkillAuditView {
  events: Array<{
    id: number;
    conversationId: string;
    slug: string;
    reason: 'search' | 'explicit' | 'plan-step' | 'reference';
    detail: string | null;
    injectedChars: number;
    at: number;
  }>;
  summary: Array<{ slug: string; loads: number; lastAt: number }>;
}

/** 加载原因的中文名。区分它们是审计的全部价值所在。 */
export const SKILL_REASON_LABEL: Readonly<Record<string, string>> = {
  search: '检索命中',
  explicit: '点名加载',
  'plan-step': '计划绑定',
  reference: '参考材料',
};

export const listSkills = () => invoke<SkillCatalogView>({ method: 'skill.list' });

export const reloadSkills = (rebuildVectors = false) =>
  invoke<{
    active: number;
    shadowed: number;
    broken: number;
    vectors: { built: number; cached: number; failed: string | null };
  }>({ method: 'skill.reload', rebuildVectors });

export const setSkillEnabled = (slug: string, enabled: boolean) =>
  invoke<{ slug: string; enabled: boolean }>({ method: 'skill.setEnabled', slug, enabled });

export const searchSkills = (query: string, limit = 8) =>
  invoke<{ vectorsReady: boolean; hits: SkillSearchHitView[] }>({
    method: 'skill.search',
    query,
    limit,
  });

export const loadSkillAudit = (projectId: string, conversationId: string, limit = 200) =>
  invoke<SkillAuditView>({ method: 'skill.audit', projectId, conversationId, limit });

export const loadSkillSource = (slug: string) =>
  invoke<SkillSourceView>({ method: 'skill.source', slug });

export const loadSkillReferenceFile = (slug: string, name: string) =>
  invoke<{ slug: string; name: string; content: string }>({
    method: 'skill.reference',
    slug,
    name,
  });

export const validateSkill = (manifest: string, instructions: string) =>
  invoke<SkillValidateResult>({ method: 'skill.validate', manifest, instructions });

export const writeSkill = (input: {
  manifest: string;
  instructions: string;
  references?: Record<string, string>;
  providerJson?: string | null;
  providerScript?: string | null;
  overwrite?: boolean;
}) =>
  invoke<SkillWriteResult>({
    method: 'skill.write',
    manifest: input.manifest,
    instructions: input.instructions,
    references: input.references ?? {},
    providerJson: input.providerJson ?? null,
    providerScript: input.providerScript ?? null,
    overwrite: input.overwrite ?? false,
  });

export const deleteSkill = (slug: string) =>
  invoke<{ slug: string; deleted: boolean }>({ method: 'skill.delete', slug });

export const importSkillArchive = (fileName: string, contentBase64: string, overwrite = false) =>
  invoke<SkillImportOutcome>({
    method: 'skill.importArchive',
    fileName,
    contentBase64,
    overwrite,
  });

export const importSkillDirectory = (directory: string, overwrite = false) =>
  invoke<SkillImportOutcome>({ method: 'skill.importDirectory', directory, overwrite });

export const importSkillFromGithub = (
  spec: string,
  credentialRef: string | null = null,
  overwrite = false,
) =>
  invoke<SkillImportOutcome>({
    method: 'skill.importGithub',
    spec,
    credentialRef,
    overwrite,
  });

export const distillSkillFromConversation = (input: {
  projectId: string;
  conversationId: string;
  focus?: string | null;
  modelId?: string | null;
}) =>
  invoke<SkillDistillResult>({
    method: 'skill.distill',
    projectId: input.projectId,
    conversationId: input.conversationId,
    focus: input.focus ?? null,
    modelId: input.modelId ?? null,
  });

/* ------------------------------------------------------------------ *
 * 连接器（任务 12.16，需求 14.1、17.1）
 * ------------------------------------------------------------------ */

export interface ConnectorGroupView {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
}

export interface ConnectorView {
  id: string;
  name: string;
  groupId: string | null;
  kind: 'mcp-stdio' | 'mcp-http';
  /**
   * 两级开关的合成结果：自身启用**且**所属组启用。
   *
   * 与 `selfEnabled` / `groupEnabled` 分开是必要的：只给合成值会让
   * 「我关了整组但这一项还显示开着」变成一个说不清的状态，而只给自身值会让
   * 界面上的「已启用」与实际可用不一致。
   */
  enabled: boolean;
  selfEnabled: boolean;
  groupEnabled: boolean;
  builtin: boolean;
  connected: boolean;
  toolCount: number;
  serverInfo: { name: string; version: string } | null;
  credentialRef: string | null;
  health: { ok: boolean; checkedAt: number; detail?: string } | null;
  lastError: string | null;
  description: string | null;
  domains: string[];
  sources: string[];
}

export interface ConnectorCatalogView {
  groups: ConnectorGroupView[];
  connectors: ConnectorView[];
  /**
   * 因连接器而进入出口白名单的域名。
   *
   * 单独给出来是为了让「关掉一组之后网络是不是真的断了」可以被看见——
   * 界面上关了而内核里的代码照样能连，是最容易出现的半开状态。
   */
  effectiveDomains: string[];
}

export interface ConnectorToolView {
  name: string;
  description: string;
  inputSchema: unknown;
  /** 只读工具不需要每次审批。这个标记由服务端自己填，界面要如实显示。 */
  readOnly: boolean;
  destructive: boolean;
}

export interface ToolGrantView {
  id: string;
  connectorId: string;
  toolName: string;
  scope: GrantScope;
  scopeId: string | null;
  grantedAt: number;
  revokedAt: number | null;
}

export const listConnectors = (projectId?: string) =>
  invoke<ConnectorCatalogView>({
    method: 'connector.list',
    ...(projectId === undefined ? {} : { projectId }),
  });

export const setConnectorEnabled = (
  target: { connectorId: string } | { groupId: string },
  enabled: boolean,
) =>
  invoke<{ groups: ConnectorGroupView[]; effective: number }>({
    method: 'connector.setEnabled',
    ...('connectorId' in target
      ? { connectorId: target.connectorId }
      : { groupId: target.groupId }),
    enabled,
  });

export const checkConnector = (projectId: string, connectorId: string) =>
  invoke<{ ok: boolean; detail: string; toolCount: number }>({
    method: 'connector.check',
    projectId,
    connectorId,
  });

export const listConnectorTools = (projectId: string, connectorId: string) =>
  invoke<{ tools: ConnectorToolView[]; resources: number; prompts: number }>({
    method: 'connector.tools',
    projectId,
    connectorId,
  });

export const listToolGrants = (includeRevoked = false) =>
  invoke<{ grants: ToolGrantView[] }>({ method: 'connector.grants', includeRevoked });

export const revokeToolGrant = (grantId: string) =>
  invoke<{ revoked: boolean }>({ method: 'connector.revokeGrant', grantId });

/* ------------------------------------------------------------------ *
 * 计划（任务 12.5、#10，需求 10.1、10.4）
 * ------------------------------------------------------------------ */

export type PlanStatus = 'draft' | 'approved' | 'executing' | 'done' | 'failed' | 'rejected';
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export const PLAN_STATUS_LABEL: Readonly<Record<PlanStatus, string>> = {
  draft: '待批准',
  approved: '已批准',
  executing: '执行中',
  done: '已完成',
  failed: '失败',
  rejected: '已拒绝',
};

export const PLAN_STEP_STATUS_LABEL: Readonly<Record<PlanStepStatus, string>> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export interface DelegationSpec {
  parallel: boolean;
  blocking: boolean;
  maxConcurrent?: number;
}

export interface PlanStepSpec {
  ref: string;
  phase: number;
  title: string;
  description: string;
  skillSlug: string | null;
  tools: string[];
  /** 步骤间的交接界面。空着说明下一步不知道该拿什么当输入。 */
  produces: string[];
  dependsOn: string[];
  /** 这一步是去查事实/数值。影响「硬编码数值」这类校验的判定。 */
  retrieval: boolean;
  delegation: DelegationSpec | null;
}

export interface PlanSpec {
  goal: string;
  phases: Array<{ phase: number; title: string }>;
  steps: PlanStepSpec[];
}

export interface PlanStepRecord {
  id: string;
  planId: string;
  ref: string;
  phase: number;
  seq: number;
  title: string | null;
  description: string | null;
  skillSlug: string | null;
  status: PlanStepStatus;
  delegation: Record<string, unknown> | null;
  resultRef: string | null;
}

export interface PlanProgress {
  total: number;
  byStatus: Record<PlanStepStatus, number>;
  /** 最小的「还有未完成步骤」的阶段。全部完成时为 null。 */
  currentPhase: number | null;
}

export interface PlanView {
  id: string;
  conversationId: string;
  status: PlanStatus;
  createdAt: number;
  spec: PlanSpec;
  steps: PlanStepRecord[];
  progress: PlanProgress;
}

/** 计划校验问题。`level === 'error'` 阻止执行。 */
export interface PlanIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  ref?: string;
  suggestion?: string;
}

export const listPlans = (projectId: string, conversationId: string, limit = 20) =>
  invoke<{ plans: PlanView[] }>({ method: 'plan.list', projectId, conversationId, limit });

export const loadPlan = (projectId: string, planId: string) =>
  invoke<{ plan: PlanView }>({ method: 'plan.get', projectId, planId });

export const decidePlan = (
  projectId: string,
  planId: string,
  decision: 'approve' | 'reject',
  note?: string,
) =>
  invoke<{ planId: string; status: 'approved' | 'rejected' }>({
    method: 'plan.decide',
    projectId,
    planId,
    decision,
    ...(note === undefined || note === '' ? {} : { note }),
  });

export const replacePlan = (projectId: string, planId: string, spec: unknown) =>
  invoke<{ plan: PlanView | null; issues: PlanIssue[] }>({
    method: 'plan.replace',
    projectId,
    planId,
    spec,
  });

/* ------------------------------------------------------------------ *
 * 审查发现（任务 12.8、#10，需求 11）
 * ------------------------------------------------------------------ */

export type FindingSeverity = 'warn' | 'fail';
export type FindingCategory =
  'evidence' | 'statistics' | 'reproducibility' | 'consistency' | 'integrity' | 'claim';
export type FindingStatus = 'open' | 'claimed-fixed' | 'resolved' | 'dismissed';

export const FINDING_CATEGORY_LABEL: Readonly<Record<FindingCategory, string>> = {
  evidence: '证据',
  statistics: '统计',
  reproducibility: '可复现',
  consistency: '一致性',
  integrity: '完整性',
  claim: '断言依据',
};

export const FINDING_STATUS_LABEL: Readonly<Record<FindingStatus, string>> = {
  open: '待处理',
  'claimed-fixed': '已自报待复核',
  resolved: '已解决',
  dismissed: '判为误报',
};

export interface FindingEvidence {
  kind: 'artifact-version' | 'message' | 'claim' | 'plan-step';
  id: string;
  note?: string;
}

export interface Finding {
  id: string;
  conversationId: string;
  reviewerRunId: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string | null;
  /** 必非空——引不到真实对象的发现在写入时就被拒了（需求 11.8）。 */
  evidence: FindingEvidence[];
  status: FindingStatus;
  /** agent 自报的修复说明，或审查者的复核依据。 */
  addressedNote: string | null;
  addressedAt: number | null;
  createdAt: number;
}

export interface FindingSummary {
  /** FAIL 级未关闭数。非零时不该宣称任务完成。 */
  blocking: number;
  warnings: number;
  claimedFixed: number;
  byCategory: Record<string, number>;
}

export type ReviewerTrigger = 'turn-end' | 'artifact-saved' | 'pre-compile' | 'user-request';
export type ReviewerRunStatus = 'running' | 'done' | 'failed' | 'degraded';

export const REVIEWER_TRIGGER_LABEL: Readonly<Record<ReviewerTrigger, string>> = {
  'turn-end': '回合结束',
  'artifact-saved': '制品保存',
  'pre-compile': '编译前',
  'user-request': '用户请求',
};

export interface ReviewerRun {
  id: string;
  conversationId: string;
  trigger: ReviewerTrigger;
  /** 执行审查的模型。异厂商约束靠它可核查（需求 11.2）。 */
  modelId: string;
  status: ReviewerRunStatus;
  summary: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export const listFindings = (
  projectId: string,
  conversationId: string,
  options: { status?: FindingStatus | 'unresolved'; limit?: number } = {},
) =>
  invoke<{ findings: Finding[]; summary: FindingSummary }>({
    method: 'finding.list',
    projectId,
    conversationId,
    ...(options.status === undefined ? {} : { status: options.status }),
    limit: options.limit ?? 200,
  });

export const decideFinding = (
  projectId: string,
  findingId: string,
  decision: 'resolve' | 'dismiss' | 'reopen',
  note?: string,
) =>
  invoke<{ finding: Finding | null }>({
    method: 'finding.decide',
    projectId,
    findingId,
    decision,
    ...(note === undefined || note === '' ? {} : { note }),
  });

export const runReviewer = (projectId: string, conversationId: string) =>
  invoke<{ scheduled: true; merged: boolean }>({
    method: 'reviewer.run',
    projectId,
    conversationId,
  });

export const listReviewerRuns = (projectId: string, conversationId: string, limit = 20) =>
  invoke<{ runs: ReviewerRun[] }>({
    method: 'reviewer.runs',
    projectId,
    conversationId,
    limit,
  });

/* ------------------------------------------------------------------ *
 * 子 agent（任务 12.6、#10，需求 10.5-10.7）
 * ------------------------------------------------------------------ */

export type SubAgentStatus = 'running' | 'done' | 'failed' | 'stopped';

export const SUBAGENT_STATUS_LABEL: Readonly<Record<SubAgentStatus, string>> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export interface ChildConversation {
  id: string;
  title: string | null;
  agentId: string | null;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  parentConversationId: string | null;
  /**
   * 此刻是否还有活的 runner。
   *
   * 已结束的子 agent 只剩库里的会话行，`agentStatus` 与 `blocking` 都是 null——
   * 句柄清理之后 done 与 failed 的区别就丢了，最终陈述在子会话的消息里。
   */
  running: boolean;
  agentStatus: SubAgentStatus | null;
  blocking: boolean | null;
}

export const listChildConversations = (projectId: string, conversationId: string) =>
  invoke<{ children: ChildConversation[] }>({
    method: 'conversation.children',
    projectId,
    conversationId,
  });
