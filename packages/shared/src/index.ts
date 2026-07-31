/**
 * @l-science/shared — 跨进程共享的契约定义。
 *
 * 这个包只放类型与不可变常量，不放实现。控制平面（core）、内核客户端（kernel）、
 * 供应商适配器（adapters）、Electron 外壳（shell）与渲染层（ui）都依赖它，
 * 因此任何实现细节泄漏到这里都会造成不必要的耦合。
 */

export const PROTOCOL_VERSION = '0.1.0' as const;

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

export interface ApprovalRequest {
  id: string;
  kind: 'artifact-delete' | 'host-access' | 'ssh-command' | 'compute-provider' | 'domain-allowlist';
  title: string;
  detail: string;
  payload: unknown;
}

export type TurnEvent =
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string }
  | { kind: 'tool.start'; callId: string; tool: string; input: unknown }
  | { kind: 'tool.output'; callId: string; output: ToolOutput }
  | { kind: 'routing.decision'; decision: RoutingDecision }
  | { kind: 'approval.request'; approval: ApprovalRequest }
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
