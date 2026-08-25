/**
 * @l-science/adapters — 模型供应商适配器。
 *
 * 每个适配器把统一的 `ChatRequest` 翻译成某家供应商的 HTTP API，并把响应
 * 归一化回 `ChatChunk` 流。路由器只与 `types.ts` 里的接口打交道，因此新增
 * 一家供应商不需要改动路由逻辑。
 */

import { AdapterRegistry } from './types.js';
import { DeepSeekAdapter } from './deepseek.js';
import { OllamaAdapter } from './ollama.js';

export type {
  AdapterContext,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatRole,
  ProviderAdapter,
  StopReason,
  ToolSchema,
} from './types.js';
export { AdapterRegistry } from './types.js';

export {
  OpenAICompatibleAdapter,
  ProviderError,
  classifyRetryable,
  normalizeStopReason,
  ToolCallAccumulator,
} from './openai-compatible.js';
export type { OpenAICompatibleOptions } from './openai-compatible.js';

export { sseDataLines } from './sse.js';

export {
  DeepSeekAdapter,
  DEEPSEEK_BASE_URL,
  canonicalizeDeepSeekModel,
  deepseekPricing,
  isPeakPricing,
} from './deepseek.js';

export { OllamaAdapter, OLLAMA_BASE_URL } from './ollama.js';

/**
 * 注册全部内置适配器。
 *
 * 集中在一处而不是让调用方逐个 register：漏注册一家的症状是「这家供应商
 * 在设置里看不见」，而不是报错，很容易被当成配置问题排查半天。
 */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new DeepSeekAdapter());
  registry.register(new OllamaAdapter());
  return registry;
}
