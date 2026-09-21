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
  routingOverrideSchema,
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
  RoutingOverride,
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
  | 'reviewer.audit'
  | 'skill.distill';

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
  /**
   * `reason` 的人类可读说明，由路由层填充。
   *
   * 随决策一起落库、一起推给 UI，而不是让渲染层各自维护一份原因码到文案的
   * 映射表。两个理由：新增一种排除原因时不必同步改多处（漏改的表现是界面上
   * 出现一个裸的英文原因码），以及历史决策记录能自我解释——事后回看半年前
   * 为什么没选某个模型时，不依赖当时那版文案表还在。
   *
   * 可选是为了兼容此字段出现之前落库的决策记录。
   */
  reasonText?: string;
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

/**
 * Jupyter MIME bundle。
 *
 * 值类型是 `unknown` 而不是 `string`：`application/json` 与各种
 * `application/vnd.*+json` 表示本身就是对象。声明成 string 会迫使内核层先
 * stringify、消费层再 parse，一来一回既多余又会在往返中丢掉类型信息。
 */
export interface MimeBundle {
  [mimeType: string]: unknown;
}

export type ToolOutput =
  | { kind: 'text'; text: string }
  | { kind: 'rich'; data: MimeBundle }
  | { kind: 'error'; ename: string; evalue: string; traceback: readonly string[] };

/**
 * 发现的严重度（需求 11.5）。
 *
 * 设计文档里写作 `WARN` / `FAIL`，这里用小写：它要作为 SQLite 里的列值存储，
 * 而大小写不同的同义值最终会变成「查出来少了一半」这类问题。
 */
export type FindingSeverity = 'warn' | 'fail';

/**
 * 发现的类别。
 *
 * `claim` 是 M4 加的（任务 13.4，需求 13.3）：无证据断言与证据矛盾的断言不属于
 * 已有的任何一类。`evidence` 说的是「这条发现指向什么」，而 `claim` 说的是
 * 「手稿里有一句话没有依据」——后者是论文层面的问题，前者是审查记录的形式要求。
 * 混在一起之后，用户无法在 findings 列表里筛出「手稿还有哪些话没有依据」。
 */
export type FindingCategory =
  'evidence' | 'statistics' | 'reproducibility' | 'consistency' | 'integrity' | 'claim';

/**
 * 发现的状态（需求 11.7）。
 *
 * `claimed-fixed` 是独立状态而不是 `resolved` 的一种：agent 说它修好了不等于修好了，
 * 关闭权在审查者。少了这个中间态，一次错误的自我判断会永久掩盖问题。
 */
export type FindingStatus = 'open' | 'claimed-fixed' | 'resolved' | 'dismissed';

/** 证据指向。必须给出具体 id（需求 11.8）。 */
export interface FindingEvidence {
  kind: 'artifact-version' | 'message' | 'claim' | 'plan-step';
  id: string;
  /** 为什么这条证据支持该发现。 */
  note?: string;
}

export interface Finding {
  id: string;
  conversationId: string;
  /** 哪次审查提出的。为 null 表示提出它的审查运行已被删除。 */
  reviewerRunId: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string | null;
  evidence: readonly FindingEvidence[];
  status: FindingStatus;
  /** agent 自报的修复说明，或审查者的复核依据。 */
  addressedNote: string | null;
  addressedAt: number | null;
  createdAt: number;
}

export interface ArtifactVersionRef {
  artifactId: string;
  versionId: string;
  filename: string;
  versionNo: number;
}

/**
 * 需审批操作的类别（需求 17.1 列出五类，其余是同类推广）。
 *
 * `skill-write`：模型在对话里创建或改写一个技能。它需要审批的理由与其他几类不同——
 * 技能不是一次性动作，而是**会被注入到以后每一次相关对话里**的指令。一份方法学写错的
 * 技能，影响的是此后所有命中它的分析，而那种影响不会以报错的形式出现。
 *
 * 算力那三类刻意分开，不合成一个 `compute`（任务 14.2、14.5）：
 *
 * - `compute-target`：**登记**一个算力目标。它一次性地建立起一条通往外部主机的通道，
 *   此后的每次使用都以它为前提。把它与「用这条通道跑一条命令」合成一类，会让指纹
 *   （`kind` + payload）把两件事算成同一件，于是批准一次注册等于批准了此后所有命令。
 * - `ssh-command`：在远程主机执行命令。
 * - `compute-job`：提交作业。与执行命令分开是因为**代价量级不同**：一条 `ls` 什么也不
 *   消耗，一个作业消耗集群配额，在云上直接是钱。用同一类会让用户为了不被 `ls` 烦到
 *   而给出持久授权，顺带把提交作业也放行了。
 * - `compute-provider`：使用已存的算力凭据（BYOC 的 token、私钥口令）。
 */
export type ApprovalKind =
  | 'artifact-delete'
  | 'host-access'
  | 'compute-target'
  | 'ssh-command'
  | 'compute-job'
  | 'compute-provider'
  | 'domain-allowlist'
  | 'skill-write'
  /**
   * 装包（任务 14.5，需求 15.3-15.5、17.1）。
   *
   * 需求 17.1 没点名它，但它属于同一类：`pip install` 会执行包自带的构建脚本，
   * 也就是**任意代码执行**——而且执行在用户自己的机器上、用他的权限。这一点与
   * 「远程命令执行」在性质上没有区别，只是它长得像一次无害的依赖管理。
   *
   * 第二个理由是影响范围：装包改动的是环境，而环境被此后**所有**会话的内核共用。
   * 一次装错版本的 numpy 会让之后每一次分析都跑在它上面。
   */
  | 'package-install';

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
  /**
   * 可选的有效期（毫秒），供用户挑（需求 17.5）。
   *
   * `null` 表示「不设过期」。空数组表示这个请求不提供有效期选择——一次性确认
   * （`scopeOptions` 为空）显然不需要，而「删除这个制品」也不需要。
   *
   * 有效期与作用域是两件事，因此分成两个字段：作用域回答「在哪些上下文里生效」，
   * 有效期回答「生效多久」。合成一个下拉框（「本项目 7 天」这类组合项）会让选项
   * 数量变成两者的乘积，而多数组合是没人会选的。
   */
  expiryOptions: readonly (number | null)[];
  payload: unknown;
}

/** 常用的有效期档位（毫秒）。UI 用它渲染下拉框。 */
export const APPROVAL_EXPIRY_PRESETS: readonly (number | null)[] = [
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  null,
];

/** 有效期档位的中文标签。 */
export function describeExpiry(ms: number | null): string {
  if (ms === null) return '不过期';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${String(Math.round(hours))} 小时`;
  const days = hours / 24;
  return `${String(Math.round(days))} 天`;
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

export type SandboxBackendId = 'native' | 'wsl2';

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
