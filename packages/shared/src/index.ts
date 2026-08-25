/**
 * @l-science/shared — 跨进程共享的契约定义。
 *
 * 这个包只放类型与不可变常量，不放实现。控制平面（core）、内核客户端（kernel）、
 * 供应商适配器（adapters）、Electron 外壳（shell）与渲染层（ui）都依赖它，
 * 因此任何实现细节泄漏到这里都会造成不必要的耦合。
 */

export const PROTOCOL_VERSION = '0.1.0' as const;

export {
  IPC_PROTOCOL_VERSION,
  errorCodeSchema,
  errorEnvelopeSchema,
  requestSchema,
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
  frameSchema,
  isRetryable,
  makeError,
  parseFrame,
  parseRequest,
  requestFrame,
  okResponse,
  errResponse,
  eventFrame,
} from './ipc.js';

export type {
  ErrorCode,
  ErrorEnvelope,
  Request,
  RequestMethod,
  RequestOf,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  Frame,
  ParseResult,
} from './ipc.js';

/* ------------------------------------------------------------------ *
 * 任务与路由
 * ------------------------------------------------------------------ */

/** 任务类型。路由器按此选择权重预设，见设计文档「写论文场景的默认权重预设」。 */
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

export type Modality = 'text' | 'image' | 'pdf' | 'audio';

/** 模型能力维度。0-100，来自公开基准并由本地反馈闭环校正。 */
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

export type StrengthKey = keyof ModelStrengths;

/** 供应商数据使用策略。保留为路由的可选过滤条件，不是强制约束。 */
export interface ProviderPolicy {
  trainingUse: 'none' | 'opt-out-required' | 'yes' | 'unknown';
  retentionDays: number | null;
  zdr: boolean;
  region: string;
  evidenceUrl?: string;
}

export interface ModelDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  modalities: readonly Modality[];
  strengths: ModelStrengths;
  pricing: { inputPer1k: number; outputPer1k: number; currency: string };
  performance: { medianLatencyMs: number; tokensPerSec: number };
  policy: ProviderPolicy;
  local: boolean;
  features: {
    streaming: boolean;
    toolUse: boolean;
    promptCache: boolean;
    vision: boolean;
    /**
     * 是否会产出思维链。
     *
     * 这不是「有没有更强推理」的标记，而是**预算相关的事实**：思维模式下
     * 模型先消耗输出配额做思考，再产出答案。实测把 max_tokens 设成 16 给
     * qwen3:4b，结果 17 个分片全是思考、正文一个字都没有。因此调用方在给
     * thinking 模型定输出上限时必须留出思考的余量。
     */
    thinking: boolean;
  };
}

export interface TaskProfile {
  taskType: TaskType;
  requiredModalities: readonly Modality[];
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  needToolUse: boolean;
  needStructuredOutput: boolean;
  weights: Partial<ModelStrengths>;
  latencyBudgetMs?: number;
  costBudget?: number;
  committeeSize?: number;
  preferLocal?: boolean;
  requireTrainingOptOut?: boolean;
}

/** 被排除的候选模型及原因。路由可解释性的基础。 */
export interface ExcludedCandidate {
  modelId: string;
  reason:
    | 'modality-unsupported'
    | 'context-too-small'
    | 'tool-use-unsupported'
    | 'unhealthy'
    | 'rate-limited'
    | 'user-disabled'
    | 'policy-mismatch'
    | 'no-credential';
  detail?: string;
}

export interface RoutingDecision {
  id: string;
  taskType: TaskType;
  chosenModelId: string | null;
  scores: ReadonlyArray<{ modelId: string; total: number; breakdown: Record<string, number> }>;
  excluded: readonly ExcludedCandidate[];
  reason: string;
  /** 若本次是降级重试，指向被降级的原决策 id。 */
  fallbackOf?: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * 会话事件流
 * ------------------------------------------------------------------ */

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  currency: string;
}

export interface MimeBundle {
  [mimeType: string]: string;
}

export type ToolOutput =
  | { kind: 'text'; text: string }
  | { kind: 'rich'; data: MimeBundle }
  | { kind: 'error'; ename: string; evalue: string; traceback: readonly string[] };

export type FindingSeverity = 'WARN' | 'FAIL';

export type FindingCategory =
  'evidence' | 'statistics' | 'reproducibility' | 'consistency' | 'integrity';

export interface Finding {
  id: string;
  conversationId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  evidence: ReadonlyArray<{
    kind: 'artifact' | 'message' | 'claim';
    ref: string;
    excerpt?: string;
  }>;
  status: 'open' | 'addressed_pending_review' | 'confirmed_fixed' | 'dismissed';
  reviewerModelId: string;
}

export interface ArtifactVersionRef {
  artifactId: string;
  versionId: string;
  filename: string;
  versionNo: number;
}

/** 需求 17.1 列出的五类需审批操作。 */
export type ApprovalKind =
  'artifact-delete' | 'host-access' | 'ssh-command' | 'compute-provider' | 'domain-allowlist';

/**
 * 授权的作用域（需求 17.5）。
 *
 * `once` 存在的意义是让用户能在不建立长期授权的情况下放行一次。没有它的话，
 * 用户面对「要么拒绝、要么永久授权」的二选一，多数人会选永久——审批就退化成
 * 一次性的形式主义。
 */
export type GrantScope = 'once' | 'session' | 'project' | 'always';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  /** 一句话说明将要发生什么。 */
  title: string;
  /** 补充细节，可多行。 */
  detail: string;
  /**
   * 影响范围（需求 17.2）。
   *
   * 与 `detail` 分开是刻意的：UI 需要把它单独醒目展示，而且分成独立字段会
   * 强迫每个调用点真的回答「这会影响什么」，而不是写一句含糊的说明糊过去。
   */
  impact: string;
  /**
   * 是否可逆（需求 17.2）。
   *
   * 不可逆的操作在 UI 上需要更强的确认。这个字段必须如实填写——把不可逆
   * 操作标成可逆，等于把审批变成用户会习惯性点过的弹窗。
   */
  reversible: boolean;
  /** 若操作可逆，说明怎么撤销。不可逆时为 null。 */
  undoHint: string | null;
  /**
   * 允许用户选择的授权作用域。空数组表示这是一次性确认，不产生持久授权。
   */
  scopeOptions: readonly GrantScope[];
  payload: unknown;
}

/**
 * agent 向用户提问（需求 17.4）。
 *
 * `kind` 区分一般提问与算力配置提问。这个区分不是分类癖：算力配置类提问需要
 * 展示当前可用的算力目标、分区、账户等上下文，UI 渲染方式与一般提问完全不同。
 * 把两者合成一种，结果是算力问题以纯文本形式抛给用户，而用户根本不知道
 * 有哪些合法取值。
 */
export interface UserQuestion {
  id: string;
  kind: 'general' | 'compute-config';
  question: string;
  /** 补充上下文，可多行。 */
  detail: string | null;
  /**
   * 预设选项。为空表示自由作答。
   *
   * 有选项时 UI 应同时允许自由输入——预设选项常常漏掉用户真正想说的那个，
   * 强制只能选会把用户逼到「选一个最接近的」，而那个答案是错的。
   */
  choices: readonly string[];
}

export type TurnEvent =
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string }
  | { kind: 'tool.start'; callId: string; tool: string; input: unknown }
  | { kind: 'tool.output'; callId: string; output: ToolOutput }
  | { kind: 'routing.decision'; decision: RoutingDecision }
  | { kind: 'approval.request'; approval: ApprovalRequest }
  | { kind: 'question.request'; question: UserQuestion }
  | { kind: 'finding.raised'; finding: Finding }
  | { kind: 'artifact.saved'; artifact: ArtifactVersionRef }
  | { kind: 'turn.end'; usage: Usage };

/* ------------------------------------------------------------------ *
 * 沙箱隔离报告
 * ------------------------------------------------------------------ */

export type SandboxBackendId = 'native' | 'wsl2' | 'docker';

/**
 * 隔离强度报告。`caveats` 必须在 UI 上原文展示——设计目标里的「诚实降级」
 * 依赖这一点，不允许把弱隔离包装成强隔离。
 */
export interface IsolationReport {
  backend: SandboxBackendId;
  filesystem: 'namespace' | 'acl' | 'advisory';
  network: 'namespace' | 'proxy' | 'none';
  process: 'container' | 'job-object' | 'none';
  resourceLimits: {
    cpuPercent?: number;
    memoryMb?: number;
    wallClockSec?: number;
  };
  caveats: readonly string[];
}
