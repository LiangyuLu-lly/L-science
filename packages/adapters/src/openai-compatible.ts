/**
 * OpenAI 兼容端点的共享适配器实现。
 *
 * DeepSeek、Ollama、vLLM、以及多数第三方聚合网关都讲 OpenAI 的 `/chat/completions`
 * 方言，差异集中在少数几处（模型清单、鉴权头、错误包裹层、思维链字段名）。
 * 把共同部分放在这里，各家只覆盖差异，避免 SSE 解析与工具调用累积这类
 * 易错逻辑被复制多份——复制多份的直接后果是修好一处、另一处继续错。
 */

import type { ModelDescriptor, Usage } from '@l-science/shared';

import type {
  AdapterContext,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  StopReason,
  ToolSchema,
} from './types.js';
import { sseDataLines } from './sse.js';

/* ------------------------------------------------------------------ *
 * 线上格式（只声明我们实际读取的字段）
 * ------------------------------------------------------------------ */

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireDelta {
  content?: string | null;
  /** DeepSeek reasoner 系列把思维链放在这里；OpenAI o 系列不返回。 */
  reasoning_content?: string | null;
  /** 部分网关用这个名字。 */
  reasoning?: string | null;
  tool_calls?: WireToolCallDelta[];
}

interface WireChoice {
  delta?: WireDelta;
  message?: WireDelta;
  finish_reason?: string | null;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: WireUsage | null;
}

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

/**
 * 供应商返回的错误。
 *
 * `retryable` 与 `isContentFilter` 是给降级链看的：前者决定是否值得换模型重试，
 * 后者决定**绝对不能**重试——内容安全拒答是安全边界，换模型绕过它等于把
 * 安全判断当故障处理。
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly providerId: string;
  readonly type: string | undefined;
  readonly retryable: boolean;
  readonly isContentFilter: boolean;

  constructor(init: {
    providerId: string;
    status: number;
    message: string;
    type?: string;
    retryable: boolean;
    isContentFilter: boolean;
  }) {
    super(`[${init.providerId}] HTTP ${String(init.status)}: ${init.message}`);
    this.name = 'ProviderError';
    this.providerId = init.providerId;
    this.status = init.status;
    this.type = init.type;
    this.retryable = init.retryable;
    this.isContentFilter = init.isContentFilter;
  }
}

/**
 * 判断错误是否值得重试或降级。
 *
 * 401/403 不重试：凭据错了，换模型也一样错，重试只是把错误放大成一串。
 * 400 一般不重试：请求本身不合法。但上下文超限是例外——降级到更大窗口的
 * 模型正好能解决，所以单独识别出来。
 */
function classifyRetryable(status: number, message: string): boolean {
  if (status === 408 || status === 409 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 400) return /context|token|too long|maximum|length/i.test(message);
  return false;
}

/* ------------------------------------------------------------------ *
 * 停止原因归一化
 * ------------------------------------------------------------------ */

function normalizeStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'end_turn';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      // 未知原因按正常结束处理，但不猜成 tool_use——那会让上层去等一个
      // 永远不来的工具调用
      return 'end_turn';
  }
}

/* ------------------------------------------------------------------ *
 * 工具调用累积
 * ------------------------------------------------------------------ */

/**
 * 流式工具调用的累积器。
 *
 * OpenAI 方言把 `function.arguments` 拆成任意多个片段推送，且 `id` 与 `name`
 * 通常只在第一片出现。必须按 `index` 归并，不能假设「一片就是一个完整调用」。
 * 这里也不做 JSON 合法性校验——参数拼完才可能合法，中途解析必然失败。
 */
class ToolCallAccumulator {
  readonly #byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(delta: WireToolCallDelta): void {
    const index = delta.index ?? 0;
    const existing = this.#byIndex.get(index) ?? { id: '', name: '', args: '' };

    if (delta.id !== undefined && delta.id !== '') existing.id = delta.id;
    if (delta.function?.name !== undefined && delta.function.name !== '') {
      existing.name = delta.function.name;
    }
    if (delta.function?.arguments !== undefined) existing.args += delta.function.arguments;

    this.#byIndex.set(index, existing);
  }

  /** 按 index 升序产出，保持模型给出的调用顺序。 */
  drain(): ReadonlyArray<{ id: string; name: string; argumentsJson: string }> {
    return [...this.#byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, v]) => v.name !== '')
      .map(([index, v]) => ({
        // 少数端点（含部分 Ollama 版本）不给 id，此时合成一个稳定值，
        // 否则后续「工具结果对应哪次调用」无法关联
        id: v.id === '' ? `call_${String(index)}` : v.id,
        name: v.name,
        argumentsJson: v.args === '' ? '{}' : v.args,
      }));
  }

  get isEmpty(): boolean {
    return this.#byIndex.size === 0;
  }
}

/* ------------------------------------------------------------------ *
 * 基类
 * ------------------------------------------------------------------ */

export interface OpenAICompatibleOptions {
  id: string;
  displayName: string;
  /** 是否必须有 API key。本地端点（Ollama）不需要。 */
  requiresApiKey: boolean;
  /** 流式请求是否附带 `stream_options.include_usage`。不支持的端点会因此报错。 */
  supportsStreamUsage: boolean;
}

export abstract class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly #requiresApiKey: boolean;
  readonly #supportsStreamUsage: boolean;

  protected constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#requiresApiKey = options.requiresApiKey;
    this.#supportsStreamUsage = options.supportsStreamUsage;
  }

  /** 由子类把线上模型 id 映射成完整描述（能力、价格、上下文窗口）。 */
  protected abstract describeModel(rawId: string): ModelDescriptor | null;

  /* ---------------- HTTP 基础设施 ---------------- */

  protected headers(ctx: AdapterContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.apiKey !== undefined && ctx.apiKey !== '') {
      headers.Authorization = `Bearer ${ctx.apiKey}`;
    }
    return { ...headers, ...ctx.headers };
  }

  protected url(ctx: AdapterContext, path: string): string {
    return `${ctx.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  #assertCredential(ctx: AdapterContext): void {
    if (this.#requiresApiKey && (ctx.apiKey === undefined || ctx.apiKey === '')) {
      throw new ProviderError({
        providerId: this.id,
        status: 401,
        message: '缺少 API key。请先用 `node scripts/credential.mjs set` 录入凭据。',
        retryable: false,
        isContentFilter: false,
      });
    }
  }

  /**
   * 把非 2xx 响应转成 ProviderError。
   *
   * 各家的错误包裹层不一致：OpenAI 与多数网关用 `{error:{message,type}}`，
   * DeepSeek 直接给 `{message,type}`，Ollama 给 `{error:"..."}`。三种都认，
   * 认不出时退回原始文本——**不要**在这里抛解析错误，那会把「供应商说了什么」
   * 这条关键诊断信息吃掉，只留下一个无用的 SyntaxError。
   */
  protected async toError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');
    let message = raw;
    let type: string | undefined;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const inner = obj.error;
        if (typeof inner === 'string') {
          message = inner;
        } else if (typeof inner === 'object' && inner !== null) {
          const e = inner as Record<string, unknown>;
          if (typeof e.message === 'string') message = e.message;
          if (typeof e.type === 'string') type = e.type;
        } else {
          if (typeof obj.message === 'string') message = obj.message;
          if (typeof obj.type === 'string') type = obj.type;
        }
      }
    } catch {
      // 不是 JSON，保留原始文本
    }

    if (message === '') message = response.statusText;

    return new ProviderError({
      providerId: this.id,
      status: response.status,
      message,
      type,
      retryable: classifyRetryable(response.status, message),
      isContentFilter: /content[_ ]?filter|safety|blocked/i.test(`${type ?? ''} ${message}`),
    });
  }

  /* ---------------- 请求体构造 ---------------- */

  protected toWireMessages(messages: readonly ChatMessage[]): unknown[] {
    return messages.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
        : { role: m.role, content: m.content },
    );
  }

  protected toWireTools(tools: readonly ToolSchema[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  protected buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.modelName,
      messages: this.toWireMessages(req.messages),
      stream: req.stream,
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = this.toWireTools(req.tools);
    }
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.stream && this.#supportsStreamUsage) {
      // 不带这个，流式响应就没有 usage，成本核算只能靠估算
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /* ---------------- 用量与成本 ---------------- */

  protected usageFrom(ctx: AdapterContext, wire: WireUsage | null | undefined): Usage {
    const tokensIn = wire?.prompt_tokens ?? 0;
    const tokensOut = wire?.completion_tokens ?? 0;
    const pricing = ctx.pricing;
    const cost =
      pricing === undefined
        ? 0
        : (tokensIn / 1000) * pricing.inputPer1k + (tokensOut / 1000) * pricing.outputPer1k;
    return { tokensIn, tokensOut, cost, currency: pricing?.currency ?? 'USD' };
  }

  /* ---------------- 对话 ---------------- */

  chat(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatChunk> {
    return req.stream ? this.#streamChat(ctx, req) : this.#blockingChat(ctx, req);
  }

  async *#blockingChat(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.#assertCredential(ctx);

    const response = await fetch(this.url(ctx, '/chat/completions'), {
      method: 'POST',
      headers: this.headers(ctx),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });
    if (!response.ok) throw await this.toError(response);

    const parsed = (await response.json()) as WireResponse;
    const choice = parsed.choices?.[0];
    const message = choice?.message;

    const thinking = message?.reasoning_content ?? message?.reasoning ?? null;
    if (thinking !== null && thinking !== '') yield { kind: 'thinking', text: thinking };

    if (message?.content !== undefined && message.content !== null && message.content !== '') {
      yield { kind: 'text', text: message.content };
    }

    const accumulator = new ToolCallAccumulator();
    for (const call of message?.tool_calls ?? []) accumulator.add(call);
    for (const call of accumulator.drain()) {
      yield { kind: 'tool_call', ...call };
    }

    yield {
      kind: 'done',
      usage: this.usageFrom(ctx, parsed.usage),
      stopReason: normalizeStopReason(choice?.finish_reason),
    };
  }

  async *#streamChat(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.#assertCredential(ctx);

    const response = await fetch(this.url(ctx, '/chat/completions'), {
      method: 'POST',
      headers: this.headers(ctx),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });
    if (!response.ok) throw await this.toError(response);
    if (response.body === null) {
      throw new ProviderError({
        providerId: this.id,
        status: response.status,
        message: '流式响应没有 body',
        retryable: true,
        isContentFilter: false,
      });
    }

    const accumulator = new ToolCallAccumulator();
    let stopReason: StopReason | null = null;
    let usage: WireUsage | null = null;
    let sawAnyContent = false;

    try {
      for await (const payload of sseDataLines(response.body, req.signal)) {
        if (payload === '[DONE]') break;

        let event: WireResponse;
        try {
          event = JSON.parse(payload) as WireResponse;
        } catch {
          // 单个畸形事件不该终止整个流：已产出的内容仍然有效，
          // 直接丢掉这一片继续读，比抛错让用户丢失全部输出更好
          continue;
        }

        // 带 include_usage 时，最后一个事件的 choices 为空、只有 usage
        if (event.usage !== undefined && event.usage !== null) usage = event.usage;

        const choice = event.choices?.[0];
        if (choice === undefined) continue;

        const delta = choice.delta;
        const thinking = delta?.reasoning_content ?? delta?.reasoning ?? null;
        if (thinking !== null && thinking !== '') {
          sawAnyContent = true;
          yield { kind: 'thinking', text: thinking };
        }
        if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
          sawAnyContent = true;
          yield { kind: 'text', text: delta.content };
        }
        for (const call of delta?.tool_calls ?? []) accumulator.add(call);

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          stopReason = normalizeStopReason(choice.finish_reason);
        }
      }
    } catch (error) {
      // 中止是预期路径，不是故障：产出 aborted 让上层能干净收尾
      if (req.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
        yield { kind: 'done', usage: this.usageFrom(ctx, usage), stopReason: 'aborted' };
        return;
      }
      throw error;
    }

    // 工具调用必须等参数拼完才能产出，因此统一在流结束后发
    for (const call of accumulator.drain()) {
      yield { kind: 'tool_call', ...call };
    }

    if (req.signal?.aborted === true) {
      yield { kind: 'done', usage: this.usageFrom(ctx, usage), stopReason: 'aborted' };
      return;
    }

    yield {
      kind: 'done',
      usage: this.usageFrom(ctx, usage),
      // 有工具调用但没收到 finish_reason 时按 tool_use 处理，否则上层会
      // 以为轮次正常结束而把已解析出的调用丢掉
      stopReason:
        stopReason ??
        (accumulator.isEmpty ? (sawAnyContent ? 'end_turn' : 'end_turn') : 'tool_use'),
    };
  }

  /* ---------------- 模型清单 ---------------- */

  async listModels(ctx: AdapterContext): Promise<readonly ModelDescriptor[]> {
    this.#assertCredential(ctx);

    const response = await fetch(this.url(ctx, '/models'), { headers: this.headers(ctx) });
    if (!response.ok) throw await this.toError(response);

    const parsed = (await response.json()) as { data?: Array<{ id?: string }> };
    const descriptors: ModelDescriptor[] = [];
    for (const entry of parsed.data ?? []) {
      if (entry.id === undefined) continue;
      const descriptor = this.describeModel(entry.id);
      // 认不出的模型跳过而不是编造能力值：路由靠这些数字打分，
      // 编出来的分数会让它自信地选错模型
      if (descriptor !== null) descriptors.push(descriptor);
    }
    return descriptors;
  }

  /* ---------------- 健康检查 ---------------- */

  /**
   * 健康检查走 `/models` 而不是发一次真实补全：后者会计费，而这个方法
   * 会被路由的硬过滤反复调用。
   */
  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      const response = await fetch(this.url(ctx, '/models'), {
        headers: this.headers(ctx),
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const error = await this.toError(response);
        return { ok: false, latencyMs, detail: error.message };
      }
      return { ok: true, latencyMs };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export { normalizeStopReason, classifyRetryable, ToolCallAccumulator };
