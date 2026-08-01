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
  }),
  z.object({ method: z.literal('conversation.interrupt'), conversationId: idSchema }),

  z.object({
    method: z.literal('approval.decide'),
    approvalId: idSchema,
    decision: z.enum(['approve', 'deny']),
    note: z.string().max(2000).optional(),
  }),
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
