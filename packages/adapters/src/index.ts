/**
 * @l-science/adapters — 模型供应商适配器。
 *
 * 每个适配器把统一的 `ChatRequest` 翻译成某家供应商的 HTTP API，并把响应
 * 归一化回 `ChatChunk` 流。路由器只与本文件的接口打交道，因此新增一家供应商
 * 不需要改动路由逻辑。
 */

import type { ModelDescriptor, Usage } from '@l-science/shared';

/* ------------------------------------------------------------------ *
 * 统一请求 / 响应
 * ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 当 role 为 'tool' 时，指向发起该调用的 tool_call id。 */
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema。各家格式差异由适配器内部消化。 */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  modelName: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
  stream: boolean;
  /** 中止信号。降级链在切换模型前需要能干净地取消上一次请求。 */
  signal?: AbortSignal;
}

export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; argumentsJson: string }
  | { kind: 'done'; usage: Usage; stopReason: StopReason };

/**
 * 停止原因。`content_filter` 与其他原因在语义上不同——按设计文档的错误处理约定，
 * 内容安全拒答是安全边界而非基础设施故障，不允许换 prompt 或换模型绕过。
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'content_filter' | 'aborted';

/* ------------------------------------------------------------------ *
 * 适配器契约
 * ------------------------------------------------------------------ */

export interface AdapterContext {
  /** 供应商 API 基地址。本地模型（Ollama/vLLM）也走这条路。 */
  baseUrl: string;
  /** 由凭据库解密后注入，适配器不自己读磁盘。 */
  apiKey?: string;
  /** 额外请求头，例如各家的 opt-out 或组织标识。 */
  headers?: Readonly<Record<string, string>>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  /** 列出该供应商当前可用的模型。用于注册表自动发现。 */
  listModels(ctx: AdapterContext): Promise<readonly ModelDescriptor[]>;

  /** 发起对话请求，返回归一化后的增量流。 */
  chat(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatChunk>;

  /** 轻量健康检查，用于路由硬过滤。不应产生计费。 */
  health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export class AdapterRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`供应商适配器 id 重复：${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) {
      throw new Error(`未注册的供应商适配器：${id}`);
    }
    return adapter;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  list(): readonly ProviderAdapter[] {
    return [...this.#adapters.values()];
  }
}
