/**
 * 控制平面与渲染层之间的消息契约。
 *
 * 类型由 zod schema 推导而不是手写一份再单独写校验：两边分开维护必然漂移，
 * 而这条通道恰好是不可信输入的入口（渲染层可能被注入的 HTML 或恶意 artifact
 * 内容影响），漂移的代价是校验形同虚设。
 */

import { z } from 'zod';

/** 协议版本。两端不一致时应拒绝握手而不是尝试兼容。 */
export const IPC_PROTOCOL_VERSION = 1 as const;

/* ------------------------------------------------------------------ *
 * 错误信封
 * ------------------------------------------------------------------ */

/**
 * 错误码。刻意区分「可重试」与「不可重试」两类语义：
 *
 * - `content_filtered` 与 `policy_denied` 永不可重试。前者是内容安全边界，
 *   换提示词或换模型绕过在设计上被禁止；后者是用户已明确拒绝的审批。
 * - `provider_error` / `timeout` 可重试，由路由降级链处理。
 */
export const errorCodeSchema = z.enum([
  'bad_request',
  'not_found',
  'conflict',
  'policy_denied',
  'content_filtered',
  'sandbox_denied',
  'kernel_error',
  'provider_error',
  'timeout',
  'aborted',
  /**
   * 该能力在这台机器上不存在。
   *
   * 与 `internal` 的区别是它不是 bug，与 `bad_request` 的区别是请求本身没错——
   * 凭据库依赖 Windows DPAPI，在别的平台上不管怎么调用都不会有。重试无意义，
   * 用户需要的是知道「这台机器做不到这件事，替代方案是什么」。
   */
  'unavailable',
  'internal',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** 天然不可重试的错误码。`isRetryable` 以此为准，不看调用方传什么。 */
const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'bad_request',
  'not_found',
  'conflict',
  'policy_denied',
  'content_filtered',
  'sandbox_denied',
  // 平台缺失的能力不会因为重试而出现
  'unavailable',
]);

export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  /** 面向用户的可读说明。不得包含凭据、完整请求正文或内部栈信息。 */
  message: z.string().min(1),
  /** 排障用的补充信息，同样不得含敏感值。 */
  detail: z.string().optional(),
  /** 若错误可恢复，给出用户能执行的下一步。 */
  remediation: z.string().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function isRetryable(code: ErrorCode): boolean {
  return !NON_RETRYABLE.has(code);
}

/** 构造错误信封。`retryable` 由错误码决定，不接受调用方覆盖。 */
export function makeError(
  code: ErrorCode,
  message: string,
  opts?: { detail?: string; remediation?: string },
): ErrorEnvelope {
  return {
    code,
    message,
    ...(opts?.detail === undefined ? {} : { detail: opts.detail }),
    ...(opts?.remediation === undefined ? {} : { remediation: opts.remediation }),
  };
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

const idSchema = z.string().min(1).max(128);

/** 能力维度名。与 `ModelStrengths` 的键一致，权重覆盖按维度给值。 */
const strengthKeySchema = z.enum([
  'reasoning',
  'coding',
  'math',
  'longContextRecall',
  'writingZh',
  'writingEn',
  'toolUse',
  'structuredOutput',
  'citationFidelity',
  'instructionFollowing',
]);

const taskTypeSchema = z.enum([
  'route.classify',
  'literature.screen',
  'pdf.deepread',
  'analysis.codegen',
  'stats.reason',
  'signal.pipeline',
  'figure.compose',
  'manuscript.draft',
  'manuscript.polish',
  'manuscript.translate',
  'review.simulate',
  'citation.verify',
  'reviewer.audit',
]);

/**
 * 用户对本次路由的干预（需求 7.14）。
 *
 * `weightOverrides` 给出的是**完整替换**用的权重表，不是增量合并——合并会让
 * 「把某个维度调到 0」无法表达（0 与「没给」在合并语义下不可区分）。这个语义由
 * `buildTaskProfile` 保证，这里只负责把它原样带过去。
 */
export const routingOverrideSchema = z.object({
  forcedModelId: idSchema.optional(),
  weightOverrides: z.partialRecord(strengthKeySchema, z.number().min(0).max(100)).optional(),
  taskType: taskTypeSchema.optional(),
  preferLocal: z.boolean().optional(),
  requireTrainingOptOut: z.boolean().optional(),
  costBudget: z.number().nonnegative().optional(),
  latencyBudgetMs: z.number().int().positive().optional(),
});

/**
 * 路由覆盖的 TS 类型。
 *
 * 从 schema 推导而不是手写一份 interface：手写的那份与校验规则会分头演进，
 * 而分歧的表现是「类型上允许的字段被运行时拒收」。
 */
export type RoutingOverride = z.infer<typeof routingOverrideSchema>;

/**
 * M1 阶段的方法面。
 *
 * 每个方法一个独立 schema 而不是 `method: string` + `params: unknown`：
 * 判别联合让参数类型跟着方法名收窄，调用方拿不到错误的参数组合。
 */
export const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('app.status') }),
  z.object({ method: z.literal('env.doctor'), refresh: z.boolean().default(false) }),

  z.object({ method: z.literal('project.list'), includeArchived: z.boolean().default(false) }),
  z.object({
    method: z.literal('project.create'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  }),
  z.object({ method: z.literal('project.archive'), projectId: idSchema }),

  z.object({ method: z.literal('conversation.list'), projectId: idSchema }),

  /**
   * 某个会话派出的子 agent 会话（需求 10.5）。
   *
   * 子会话默认不出现在会话列表里——五个并行子任务混进侧栏之后用户找不到主线对话。
   * 要看它们做了什么走这条。
   */
  z.object({
    method: z.literal('conversation.children'),
    projectId: idSchema,
    conversationId: idSchema,
  }),
  z.object({
    method: z.literal('conversation.create'),
    projectId: idSchema,
    title: z.string().max(200).optional(),
  }),
  z.object({
    method: z.literal('conversation.history'),
    conversationId: idSchema,
    /** 游标为上一页最小 seq，用于向前增量加载，避免长会话一次性加载。 */
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    method: z.literal('conversation.send'),
    conversationId: idSchema,
    text: z.string().min(1),
    /**
     * 本次回合的路由覆盖（需求 7.14）。
     *
     * 刻意是**按回合**而不是按会话的设置：用户想「这一次用更强的模型」是常见
     * 需求，而把它做成会话级开关意味着他必须记得改回来，忘了就会在后续几十次
     * 廉价调用上一直付高价。
     */
    routing: routingOverrideSchema.optional(),
    /**
     * 用户在输入框里用 `/` 显式插入的技能（任务 12.16，需求 9.5）。
     *
     * 后端会把这些技能的内容直接放进本回合的历史，而不是指望模型自己去
     * `search_skills` 加载——「显式」意味着保证生效。上限 5 个：技能文档动辄
     * 几千字符，一次塞十个会把上下文预算吃光，而那时症状是模型忽略后面的内容。
     */
    skills: z.array(idSchema).max(5).default([]),
  }),
  z.object({ method: z.literal('conversation.interrupt'), conversationId: idSchema }),

  z.object({
    method: z.literal('approval.decide'),
    approvalId: idSchema,
    decision: z.enum(['approve', 'deny']),
    note: z.string().max(2000).optional(),
    // 用户选择的授权作用域（需求 17.5）。省略时后端取最保守的可选项
    scope: z.enum(['once', 'session', 'project', 'always']).optional(),
  }),

  z.object({
    method: z.literal('question.answer'),
    questionId: idSchema,
    // 允许空串：用户明确表示「没有补充」也是一个有效答案，
    // 强制非空会让他被迫编一个内容
    answer: z.string().max(10_000),
  }),

  /** 撤销一条宿主路径授权或域名白名单条目（需求 17.5）。 */
  z.object({
    method: z.literal('grant.revoke'),
    grantId: idSchema,
  }),

  /**
   * 请求访问沙箱之外的宿主路径（需求 5.5、17.1）。
   *
   * 已有有效授权时直接返回，否则发起审批并阻塞等待。
   */
  z.object({
    method: z.literal('host.requestAccess'),
    hostPath: z.string().min(1).max(4096),
    mode: z.enum(['ro', 'rw']),
    /** 为什么需要它。会原文展示在审批卡片上，因此不能为空。 */
    purpose: z.string().min(1).max(1000),
    projectId: idSchema,
    conversationId: idSchema.optional(),
  }),

  /** 列出当前有效的宿主路径授权与域名白名单（需求 17.5 的可查看与可撤销）。 */
  z.object({
    method: z.literal('grant.list'),
    includeInactive: z.boolean().optional(),
  }),

  /* --- Artifacts 视图（任务 9.3，需求 6.2、6.4）--- */

  z.object({
    method: z.literal('artifact.list'),
    projectId: idSchema,
    includeDeleted: z.boolean().optional(),
  }),

  /** 某个制品的版本序列。「更新即新版本」的可见性依赖这个接口。 */
  z.object({
    method: z.literal('artifact.versions'),
    projectId: idSchema,
    artifactId: idSchema,
  }),

  /** 某个版本的血缘：向上追溯到输入，向下追溯到派生产物。 */
  z.object({
    method: z.literal('artifact.lineage'),
    projectId: idSchema,
    versionId: idSchema,
  }),

  /**
   * 删除前的影响预览。
   *
   * 与实际删除分开：UI 需要在弹出确认之前就能显示「有几个版本、多大、被谁依赖」，
   * 而实际删除会走审批阻塞等待，不适合用来渲染列表。
   */
  z.object({
    method: z.literal('artifact.describeDeletion'),
    projectId: idSchema,
    artifactIds: z.array(idSchema).min(1).max(200),
  }),

  z.object({
    method: z.literal('artifact.restore'),
    projectId: idSchema,
    artifactId: idSchema,
  }),

  /* --- 环境与能力（任务 9.4，需求 2.5、2.6）--- */

  /**
   * 当前沙箱隔离强度与 caveats。
   *
   * UI 必须持续展示它并原文显示 caveats——设计目标里的「诚实降级」依赖这一点，
   * 不允许把弱隔离包装成强隔离。
   */
  z.object({ method: z.literal('sandbox.isolation') }),

  /** 可用与不可用的工具清单。不可用的要带上安装指引（需求 9.6）。 */
  z.object({ method: z.literal('tool.list'), projectId: idSchema }),

  /* --- 用量与成本（任务 11.10，需求 18）--- */

  /**
   * 用量汇总。
   *
   * `conversationId` 省略时返回整个项目的汇总。时间区间用毫秒时间戳，
   * 两端都可省略。
   */
  z.object({
    method: z.literal('usage.summary'),
    projectId: idSchema,
    conversationId: idSchema.optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
  }),

  /** 按模型分组的用量、失败分布与按天趋势。诊断面板用。 */
  z.object({
    method: z.literal('usage.breakdown'),
    projectId: idSchema,
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
  }),

  /** 某个会话的路由决策历史（需求 7.6 的事后可解释）。 */
  z.object({
    method: z.literal('routing.history'),
    projectId: idSchema,
    conversationId: idSchema,
    limit: z.number().int().min(1).max(200).default(50),
  }),

  /**
   * 记录一条反馈信号（需求 7.11）。
   *
   * 由 UI 在用户点「重试」「接受」等动作时发起。信号必须挂在具体决策上——
   * 「用户重试了」本身不说明什么，「用户重试了那次选中 X 的决策」才是训练信号。
   */
  z.object({
    method: z.literal('routing.feedback'),
    projectId: idSchema,
    routingDecisionId: idSchema,
    signal: z.enum([
      'accepted',
      'retried',
      'edited',
      'reviewer-finding',
      'tool-failure',
      'user-override',
    ]),
    source: z.enum(['user', 'reviewer', 'system']),
  }),

  /**
   * 试算一次路由，不发起任何模型调用（需求 7.6、7.14）。
   *
   * 存在的意义是让「覆盖权重」这件事可验证：用户调完权重需要先看到它会把选择
   * 改成什么，再决定要不要这样发出去。`route()` 是纯函数、不碰网络，因此这个
   * 试算的代价只有一次数据库读取。
   */
  z.object({
    method: z.literal('routing.preview'),
    taskType: taskTypeSchema,
    /** 预计输入 token。UI 用当前输入框内容粗估，缺省给一个典型值。 */
    estimatedInputTokens: z.number().int().nonnegative().default(4000),
    expectedOutputTokens: z.number().int().nonnegative().default(2000),
    needToolUse: z.boolean().default(true),
    requiredModalities: z.array(z.enum(['text', 'image', 'pdf', 'audio'])).default(['text']),
    /** 与 `conversation.send` 用同一份覆盖结构，两处行为因此不会分歧。 */
    routing: routingOverrideSchema.optional(),
    /** 带上项目 id 时会把该项目积累的经验修正计入试算。 */
    projectId: idSchema.optional(),
  }),

  /* --- 供应商与模型注册表（任务 11.1b，需求 8.5、8.6）--- */

  /** 列出全部供应商（含被禁用的）及其模型数与凭据绑定状态。 */
  z.object({ method: z.literal('provider.list') }),

  z.object({
    method: z.literal('provider.setEnabled'),
    providerId: idSchema,
    enabled: z.boolean(),
  }),

  /**
   * 绑定或解绑凭据引用名。传 null 解绑。
   *
   * 传的是**引用名**而不是密钥：密钥走 `credential.set`，两件事分开的理由是
   * 一份凭据可以被多家供应商条目共用（同一个 key 配不同 baseUrl 的场景），
   * 而且绑定关系的变更不应要求用户重新输入密钥。
   */
  z.object({
    method: z.literal('provider.setCredentialRef'),
    providerId: idSchema,
    credentialRef: z.string().min(1).max(200).nullable(),
  }),

  /** 向供应商查询当前可用模型并同步进注册表。线上消失的模型会被禁用而非删除。 */
  z.object({ method: z.literal('provider.sync'), providerId: idSchema }),

  /** 轻量健康检查，结果写入模型行供路由硬过滤使用。 */
  z.object({ method: z.literal('provider.checkHealth'), providerId: idSchema }),

  z.object({
    method: z.literal('model.list'),
    providerId: idSchema.optional(),
    includeDisabled: z.boolean().default(true),
  }),

  z.object({ method: z.literal('model.setEnabled'), modelId: idSchema, enabled: z.boolean() }),

  /* --- 凭据（任务 11.1b，需求 8.5、8.6、18.5）--- */

  /**
   * 列出已存凭据的**键名与指纹**。
   *
   * 永不返回密钥本身。指纹只有长度与末四位，足够用户确认「我存进去的是哪一个」，
   * 又不足以重建它。
   */
  z.object({ method: z.literal('credential.list') }),

  /**
   * 写入一条凭据。
   *
   * 密钥经这条通道（渲染进程 → 主进程 → 后端 stdin）传输，全程不落磁盘、
   * 不进命令行参数、不进进程列表——命令行工具刻意只从环境变量读密钥，正是因为
   * 参数会进进程列表与 shell 历史。
   *
   * **不变量：请求载荷不得进入任何日志。** 当前实现满足它（传输层与分派器都只
   * 记录方法名与错误消息，不记录载荷；shell 只转发后端 stderr），有测试守住这条。
   * 往这些路径上加「打印完整请求便于调试」的代码会直接泄漏密钥。
   */
  z.object({
    method: z.literal('credential.set'),
    ref: z.string().min(1).max(200),
    secret: z.string().min(1).max(8192),
  }),

  z.object({ method: z.literal('credential.delete'), ref: z.string().min(1).max(200) }),

  /* --- 技能系统（任务 12.1-12.3，需求 9.1、9.2、9.6、9.8）--- */

  /** 全部技能（含被禁用的）、被用户覆盖的内置技能、加载失败的技能及原因。 */
  z.object({ method: z.literal('skill.list') }),

  /** 重新扫描技能目录。改完 SKILL.md 之后用它生效，不必重启后端。 */
  z.object({
    method: z.literal('skill.reload'),
    /** 顺带重建嵌入向量。默认不重建——它要向本机推理服务发几十段文本。 */
    rebuildVectors: z.boolean().default(false),
  }),

  z.object({ method: z.literal('skill.setEnabled'), slug: idSchema, enabled: z.boolean() }),

  /** 检索技能。界面上用它让用户确认「这句话会命中哪些技能」。 */
  z.object({
    method: z.literal('skill.search'),
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(20).default(5),
  }),

  /** 某个会话加载过哪些技能及原因（需求 9.8）。 */
  z.object({
    method: z.literal('skill.audit'),
    projectId: idSchema,
    conversationId: idSchema,
    limit: z.number().int().min(1).max(500).default(200),
  }),

  /* --- 技能创建与导入（任务 12.15，需求 9.6）--- */

  /**
   * 读一个技能的源文件，供编辑界面用。
   *
   * 参考材料只给文件名与大小而不给内容：一个技能可能带几百 KB 的参数表，
   * 打开设置页就把它们全传一遍是浪费，而编辑器是按文件打开的。
   */
  z.object({ method: z.literal('skill.source'), slug: idSchema }),

  /** 读一份参考材料的内容。编辑界面按需取。 */
  z.object({
    method: z.literal('skill.reference'),
    slug: idSchema,
    name: z.string().min(1).max(200),
  }),

  /**
   * 从零写或改一个技能（路径 2）。
   *
   * `manifest` 是 skill.json 的文本而不是对象：编辑器里用户编辑的就是文本，
   * 传对象会把「JSON 语法错误」这个最常见的问题在传输层就丢掉，而那时用户
   * 得到的是一条 zod 校验消息而不是「第 7 行少了个逗号」。
   */
  z.object({
    method: z.literal('skill.write'),
    manifest: z.string().min(2).max(64_000),
    instructions: z.string().min(1).max(512_000),
    references: z.record(z.string().max(200), z.string().max(512_000)).default({}),
    /** provider.json 与 provider.py，成对提供。 */
    providerJson: z.string().max(64_000).nullable().default(null),
    providerScript: z.string().max(512_000).nullable().default(null),
    overwrite: z.boolean().default(false),
  }),

  /** 只校验不写入。编辑器保存前用它给即时反馈。 */
  z.object({
    method: z.literal('skill.validate'),
    manifest: z.string().min(1).max(64_000),
    instructions: z.string().max(512_000).default(''),
  }),

  /** 删除一个用户技能。内置技能不可删，只能禁用。 */
  z.object({ method: z.literal('skill.delete'), slug: idSchema }),

  /**
   * 导入压缩包（路径 3）。
   *
   * 内容用 base64 传：IPC 是 JSON 通道，二进制没法直接放。
   * 上限与 `ARCHIVE_LIMITS.maxArchiveBytes` 对齐（base64 膨胀约 4/3）。
   */
  z.object({
    method: z.literal('skill.importArchive'),
    fileName: z.string().min(1).max(400),
    contentBase64: z.string().min(4).max(46_000_000),
    overwrite: z.boolean().default(false),
  }),

  /** 导入本机目录（路径 3 的另一种形态：用户已经把技能放在磁盘上）。 */
  z.object({
    method: z.literal('skill.importDirectory'),
    directory: z.string().min(1).max(4096),
    overwrite: z.boolean().default(false),
  }),

  /**
   * 从 GitHub 导入（路径 4）。
   *
   * 私库令牌传的是**凭据引用名**而不是令牌本身：请求载荷不得含密钥
   * （见本文件对凭据的约定）。令牌先用 `credential.set` 存进 vault。
   */
  z.object({
    method: z.literal('skill.importGithub'),
    /** `owner/repo`、`owner/repo@ref`，或直接粘贴仓库网址。 */
    spec: z.string().min(3).max(500),
    credentialRef: z.string().max(200).nullable().default(null),
    overwrite: z.boolean().default(false),
  }),

  /**
   * 从历史会话蒸馏（路径 5）。
   *
   * 只返回草稿，不落盘——蒸馏的输入是一次具体分析，它天然倾向于把一次性细节
   * 写成通用规则，必须让用户看过再存。确认后走 `skill.write`。
   */
  z.object({
    method: z.literal('skill.distill'),
    projectId: idSchema,
    conversationId: idSchema,
    /** 指定要提炼什么。留空则由模型判断。 */
    focus: z.string().max(2000).nullable().default(null),
    modelId: z.string().max(200).nullable().default(null),
  }),

  /* --- 计划（任务 12.5，需求 10.1、10.4）--- */

  /** 某个会话的计划及各步实时状态。 */
  z.object({
    method: z.literal('plan.list'),
    projectId: idSchema,
    conversationId: idSchema,
    limit: z.number().int().min(1).max(50).default(20),
  }),

  z.object({ method: z.literal('plan.get'), projectId: idSchema, planId: idSchema }),

  /**
   * 批准或拒绝计划（需求 10.4）。
   *
   * **批准是用户动作，模型不能自己批准自己的计划**——否则「可审阅」只是个说法。
   * 因此它是一个 IPC 方法而不是工具。
   */
  z.object({
    method: z.literal('plan.decide'),
    projectId: idSchema,
    planId: idSchema,
    decision: z.enum(['approve', 'reject']),
    /** 拒绝时给出理由，会作为下一轮生成的输入。 */
    note: z.string().max(2000).optional(),
  }),

  /**
   * 执行前修改计划（需求 10.4）。
   *
   * 只在草稿状态下可用。载荷是完整的计划本体——局部补丁在「删掉一个被依赖的步骤」
   * 这类改动上无法表达，而那正是用户最想做的修改之一。
   */
  z.object({
    method: z.literal('plan.replace'),
    projectId: idSchema,
    planId: idSchema,
    spec: z.unknown(),
  }),

  /* --- 审查与 findings（任务 12.8，需求 11）--- */

  /** 某个会话的发现。省略 status 时返回未关闭的（open + claimed-fixed）。 */
  z.object({
    method: z.literal('finding.list'),
    projectId: idSchema,
    conversationId: idSchema,
    status: z.enum(['open', 'claimed-fixed', 'resolved', 'dismissed', 'unresolved']).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),

  /**
   * 用户对某条发现的处置。
   *
   * `dismiss`（判为误报）与 `resolve`（确认已修）都**只有用户能做**：agent 只能
   * 自报待复核（`mark_finding_addressed`），因为被审查者给自己判分会让一次错误的
   * 判断永久掩盖问题。`reopen` 用于用户不同意审查者的关闭判定。
   */
  z.object({
    method: z.literal('finding.decide'),
    projectId: idSchema,
    findingId: idSchema,
    decision: z.enum(['resolve', 'dismiss', 'reopen']),
    note: z.string().max(2000).optional(),
  }),

  /** 显式请求一次审查（需求 11.3）。后台跑，结果经 reviewer.finished 事件通知。 */
  z.object({
    method: z.literal('reviewer.run'),
    projectId: idSchema,
    conversationId: idSchema,
  }),

  /** 审查历史。模型 id 在这里可见，异厂商约束因此可核查（需求 11.2）。 */
  z.object({
    method: z.literal('reviewer.runs'),
    projectId: idSchema,
    conversationId: idSchema,
    limit: z.number().int().min(1).max(100).default(20),
  }),

  /* --- 记忆（任务 12.9，需求 16）--- */

  /** 列出记忆。省略 scope 时返回全局 + 本项目 + 算力三类。 */
  z.object({
    method: z.literal('memory.list'),
    projectId: idSchema,
    scope: z.enum(['global', 'project', 'compute']).optional(),
    scopeId: z.string().min(1).max(200).optional(),
    kind: z
      .enum(['preference', 'background', 'convention', 'decision', 'data', 'environment'])
      .optional(),
  }),

  /**
   * 用户新增或编辑一条记忆（需求 16.3）。
   *
   * 用户写入同样要过一次性细节的准入判定：他手工写一条「这次的 p 值是 0.03」也会
   * 造成同样的膨胀，而准入的理由与是谁写的无关。
   */
  z.object({
    method: z.literal('memory.upsert'),
    projectId: idSchema,
    scope: z.enum(['global', 'project', 'compute']),
    scopeId: z.string().min(1).max(200).optional(),
    kind: z.enum(['preference', 'background', 'convention', 'decision', 'data', 'environment']),
    content: z.string().min(1).max(4000),
    reason: z.string().min(1).max(2000),
    /** 编辑时给出要覆盖的条目 id。 */
    replaceId: idSchema.optional(),
  }),

  z.object({ method: z.literal('memory.delete'), projectId: idSchema, memoryId: idSchema }),

  /* --- 连接器（任务 12.13、12.14，需求 14.1、14.2）--- */

  /** 连接器目录与状态。按组返回，组是用户操作的单位。 */
  z.object({ method: z.literal('connector.list'), projectId: idSchema.optional() }),

  /**
   * 开关某个连接器或整组。
   *
   * 两级开关都要有：用户关的是「结构与相互作用」这一组，不会逐个去关五十个连接器。
   */
  z.object({
    method: z.literal('connector.setEnabled'),
    connectorId: idSchema.optional(),
    groupId: z.string().min(1).max(120).optional(),
    enabled: z.boolean(),
  }),

  /** 测试连接。会真的握手一次并拉取工具清单。 */
  z.object({ method: z.literal('connector.check'), projectId: idSchema, connectorId: idSchema }),

  /** 某个连接器暴露的工具清单。 */
  z.object({ method: z.literal('connector.tools'), projectId: idSchema, connectorId: idSchema }),

  /**
   * 登记用户自建的连接器。
   *
   * `kind` 决定 config 的形状：mcp-stdio 要 command/args/env，mcp-http 要 url/headers。
   * 凭据用 `${credential}` 占位，明文进凭据库而不落配置文件。
   */
  z.object({
    method: z.literal('connector.upsert'),
    connectorId: idSchema,
    name: z.string().min(1).max(200),
    kind: z.enum(['mcp-stdio', 'mcp-http']),
    config: z.record(z.string(), z.unknown()),
    credentialRef: z.string().min(1).max(200).nullable().optional(),
    domains: z.array(z.string().min(1).max(253)).max(50).optional(),
  }),

  z.object({ method: z.literal('connector.delete'), connectorId: idSchema }),

  /** 工具级授权列表与撤销（需求 17.5）。 */
  z.object({ method: z.literal('connector.grants'), includeRevoked: z.boolean().default(false) }),

  z.object({ method: z.literal('connector.revokeGrant'), grantId: idSchema }),

  /* --- 文献库（任务 13.1，需求 12.1、12.2）--- */

  /** 库内条目列表与统计。 */
  z.object({
    method: z.literal('ref.list'),
    projectId: idSchema,
    query: z.string().max(500).optional(),
    year: z.number().int().min(1000).max(3000).optional(),
    type: z.string().min(1).max(60).optional(),
    hasFulltext: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().nonnegative().default(0),
  }),

  z.object({ method: z.literal('ref.get'), projectId: idSchema, refId: idSchema }),

  /**
   * 按标识解析并入库。
   *
   * `identifiers` 是原始字符串而不是「DOI 数组」：用户会直接粘贴链接、PMID、
   * 甚至混着来的一堆，后端负责嗅探。要求前端先分类等于把同一段逻辑写两遍。
   */
  z.object({
    method: z.literal('ref.resolve'),
    projectId: idSchema,
    identifiers: z.array(z.string().min(1).max(500)).min(1).max(200),
    refresh: z.boolean().default(false),
  }),

  /** 检索上游。不入库，返回候选。 */
  z.object({
    method: z.literal('ref.search'),
    projectId: idSchema,
    query: z.string().min(2).max(500),
    author: z.string().max(200).optional(),
    year: z.number().int().min(1000).max(3000).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  }),

  z.object({ method: z.literal('ref.delete'), projectId: idSchema, refId: idSchema }),

  /**
   * 合并两条重复记录。
   *
   * 方向由用户给：保留 preprint 还是正式版是他的决定，正文里引的可能就是 preprint。
   */
  z.object({
    method: z.literal('ref.merge'),
    projectId: idSchema,
    keepId: idSchema,
    dropId: idSchema,
  }),

  /** 全库重复扫描。返回 same 与 likely 两类，前者可批量合并，后者要用户拍板。 */
  z.object({
    method: z.literal('ref.duplicates'),
    projectId: idSchema,
    limit: z.number().int().min(1).max(200).default(50),
  }),

  /* --- 全文抓取（任务 13.2，需求 12.3、12.4、12.6）--- */

  /**
   * 按开放获取优先的顺序抓全文。
   *
   * `sources` 省略时按文献实际拥有的标识自动排序。给出时只试指定的——用户想
   * 「只从 PMC 拿，别去出版商站点」时需要这个。
   */
  z.object({
    method: z.literal('ref.fetchFulltext'),
    projectId: idSchema,
    refId: idSchema,
    sources: z
      .array(
        z.enum([
          'pmc-oa-package',
          'europepmc-xml',
          'unpaywall',
          'openalex-oa',
          'arxiv',
          'biorxiv',
          'publisher-url',
        ]),
      )
      .max(8)
      .optional(),
    force: z.boolean().default(false),
  }),

  /** 已抓到的全文、插图、补充材料，外加逐次尝试的历史（需求 12.6）。 */
  z.object({ method: z.literal('ref.assets'), projectId: idSchema, refId: idSchema }),

  /**
   * 绑定用户手工下载的全文。
   *
   * 付费墙后的论文只能这样进来，而那是绝大多数期刊。内容走 base64：IPC 是一条
   * 行分隔的 JSON 通道，二进制必须先编码。
   */
  z.object({
    method: z.literal('ref.attachFulltext'),
    projectId: idSchema,
    refId: idSchema,
    fileName: z.string().min(1).max(255),
    contentBase64: z.string().min(1),
    note: z.string().max(500).optional(),
  }),

  /* --- 引用导出（任务 13.3，需求 12.5）--- */

  /**
   * 导出引用并存为制品。
   *
   * `refIds` 省略时按筛选条件取全库。三种格式共用同一套引用键，因此同一批文献
   * 可以同时导出 .bib 与 .csl.json 而不会让手稿里的引用失配。
   */
  z.object({
    method: z.literal('ref.export'),
    projectId: idSchema,
    format: z.enum(['bibtex', 'csl-json', 'ris']),
    refIds: z.array(idSchema).max(1000).optional(),
    query: z.string().max(500).optional(),
    year: z.number().int().min(1000).max(3000).optional(),
    type: z.string().min(1).max(60).optional(),
    stem: z.string().min(1).max(80).optional(),
    asciiOnly: z.boolean().default(false),
    includeAbstract: z.boolean().default(false),
    sort: z.enum(['key', 'author-year', 'year-desc', 'added']).default('key'),
  }),

  /* --- Claim Ledger（任务 13.4，需求 13.1-13.4）--- */

  /** 断言列表与整体状态。 */
  z.object({
    method: z.literal('claim.list'),
    projectId: idSchema,
    conversationId: idSchema.optional(),
    manuscriptId: idSchema.optional(),
    status: z
      .enum([
        'open',
        'supported',
        'insufficient',
        'refuted',
        'retracted',
        'dismissed',
        'unresolved',
        'all',
      ])
      .default('unresolved'),
    kind: z.enum(['numeric', 'comparison', 'causal', 'citation', 'other']).optional(),
    unsupportedOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100),
  }),

  z.object({ method: z.literal('claim.get'), projectId: idSchema, claimId: idSchema }),

  /**
   * 从手稿抽取断言。
   *
   * `markdown` 与 `artifactVersionId` 二选一。后者让界面能直接对一个手稿制品跑抽取，
   * 不必把几万字正文经 IPC 传一遍。
   */
  z.object({
    method: z.literal('claim.extract'),
    projectId: idSchema,
    conversationId: idSchema.optional(),
    manuscriptId: idSchema.optional(),
    markdown: z.string().max(600_000).optional(),
    artifactVersionId: idSchema.optional(),
    limit: z.number().int().min(1).max(2000).default(300),
  }),

  /** 用户手写一条断言。origin 固定为 user——它一开始就是确认状态。 */
  z.object({
    method: z.literal('claim.register'),
    projectId: idSchema,
    conversationId: idSchema.optional(),
    manuscriptId: idSchema.optional(),
    text: z.string().min(1).max(4000),
    locator: z.string().max(500).optional(),
    note: z.string().max(2000).optional(),
  }),

  z.object({
    method: z.literal('claim.bind'),
    projectId: idSchema,
    claimId: idSchema,
    evidenceKind: z.enum(['artifact-version', 'ref', 'doi', 'compute', 'quote', 'message']),
    evidenceRef: z.string().min(1).max(500),
    locator: z.string().max(500).optional(),
    quote: z.string().max(4000).optional(),
    note: z.string().max(2000).optional(),
  }),

  z.object({
    method: z.literal('claim.unbind'),
    projectId: idSchema,
    claimId: idSchema,
    evidenceKind: z.enum(['artifact-version', 'ref', 'doi', 'compute', 'quote', 'message']),
    evidenceRef: z.string().min(1).max(500),
  }),

  /**
   * 用户手工记录核验结论。
   *
   * `modelId` 不在参数里：界面发起的核验一律记成 `user:manual`。让前端传模型标识
   * 等于让它可以冒充任何模型，而这一列的用途正是判断结论的可信度（需求 13.4）。
   */
  z.object({
    method: z.literal('claim.verify'),
    projectId: idSchema,
    claimId: idSchema,
    evidenceKind: z.enum(['artifact-version', 'ref', 'doi', 'compute', 'quote', 'message']),
    evidenceRef: z.string().min(1).max(500),
    verdict: z.enum(['supports', 'contradicts', 'insufficient', 'unrelated']),
    note: z.string().max(2000).optional(),
  }),

  /** 确认一条自动抽取的断言。确认后它无证据时会开 FAIL 级发现。 */
  z.object({
    method: z.literal('claim.confirm'),
    projectId: idSchema,
    claimId: idSchema,
    note: z.string().max(2000).optional(),
  }),

  z.object({
    method: z.literal('claim.close'),
    projectId: idSchema,
    claimId: idSchema,
    status: z.enum(['retracted', 'dismissed']),
    note: z.string().min(1).max(2000),
  }),

  z.object({
    method: z.literal('claim.reopen'),
    projectId: idSchema,
    claimId: idSchema,
    note: z.string().max(2000).optional(),
  }),

  z.object({ method: z.literal('claim.delete'), projectId: idSchema, claimId: idSchema }),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestMethod = Request['method'];

/** 按方法名取出对应的请求类型。 */
export type RequestOf<M extends RequestMethod> = Extract<Request, { method: M }>;

/* ------------------------------------------------------------------ *
 * 传输信封
 * ------------------------------------------------------------------ */

export const requestFrameSchema = z.object({
  v: z.literal(IPC_PROTOCOL_VERSION),
  type: z.literal('request'),
  /** 关联 id。响应与该请求触发的全部事件都带上它。 */
  id: idSchema,
  payload: requestSchema,
});

export type RequestFrame = z.infer<typeof requestFrameSchema>;

export const responseFrameSchema = z.union([
  z.object({
    v: z.literal(IPC_PROTOCOL_VERSION),
    type: z.literal('response'),
    id: idSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: z.literal(IPC_PROTOCOL_VERSION),
    type: z.literal('response'),
    id: idSchema,
    ok: z.literal(false),
    error: errorEnvelopeSchema,
  }),
]);

export type ResponseFrame = z.infer<typeof responseFrameSchema>;

export const eventFrameSchema = z.object({
  v: z.literal(IPC_PROTOCOL_VERSION),
  type: z.literal('event'),
  /** 触发该事件的请求 id；无关联的广播事件为 null。 */
  id: idSchema.nullable(),
  /** 事件体的结构由 TurnEvent 等既有类型约定，此处不重复校验以免两处漂移。 */
  payload: z.unknown(),
});

export type EventFrame = z.infer<typeof eventFrameSchema>;

export const frameSchema = z.union([requestFrameSchema, responseFrameSchema, eventFrameSchema]);

export type Frame = z.infer<typeof frameSchema>;

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ErrorEnvelope };

/**
 * 从 zod 的 issue 列表里挑一条最有信息量的。
 *
 * 取路径最深的那条：union 分支失败时 zod 会同时报根节点的泛化错误与各分支的
 * 具体错误，只取 `issues[0]` 往往只能拿到「Invalid input」这种毫无指向的消息。
 */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string | undefined {
  if (issues.length === 0) return undefined;

  let best = issues[0] as z.core.$ZodIssue;
  for (const issue of issues) {
    if (issue.path.length > best.path.length) best = issue;
  }
  const where = best.path.join('.');
  return `${where === '' ? '(根)' : where}: ${best.message}`;
}

/**
 * 解析一条入站帧。
 *
 * 失败时返回错误信封而不是抛异常：这条通道处理的是不可信输入，抛异常会让
 * 调用方很容易漏掉 try/catch 从而拖垮整个传输循环。
 *
 * 先按 `type` 分派再用对应 schema 校验，而不是直接喂给 `frameSchema` 这个 union。
 * union 全分支失败时 zod 只在根节点报泛化错误，定位不到真正出问题的字段。
 */
export function parseFrame(raw: unknown): ParseResult<Frame> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: makeError('bad_request', '消息必须是对象') };
  }

  const type = (raw as { type?: unknown }).type;
  const schema =
    type === 'request'
      ? requestFrameSchema
      : type === 'response'
        ? responseFrameSchema
        : type === 'event'
          ? eventFrameSchema
          : null;

  if (schema === null) {
    return {
      ok: false,
      error: makeError('bad_request', '未知的消息类型', {
        detail: `type=${JSON.stringify(type)}`,
        remediation: '合法值为 request、response、event',
      }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: makeError('bad_request', '消息格式不符合协议', {
      detail: describeIssues(parsed.error.issues),
    }),
  };
}

/** 解析一条请求帧的载荷，用于已确认 type 之后的二次收窄。 */
export function parseRequest(raw: unknown): ParseResult<Request> {
  const parsed = requestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: makeError('bad_request', '请求参数不合法', {
      detail: describeIssues(parsed.error.issues),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 构造辅助
 * ------------------------------------------------------------------ */

export function requestFrame(id: string, payload: Request): RequestFrame {
  return { v: IPC_PROTOCOL_VERSION, type: 'request', id, payload };
}

export function okResponse(id: string, result: unknown): ResponseFrame {
  return { v: IPC_PROTOCOL_VERSION, type: 'response', id, ok: true, result };
}

export function errResponse(id: string, error: ErrorEnvelope): ResponseFrame {
  return { v: IPC_PROTOCOL_VERSION, type: 'response', id, ok: false, error };
}

export function eventFrame(id: string | null, payload: unknown): EventFrame {
  return { v: IPC_PROTOCOL_VERSION, type: 'event', id, payload };
}
