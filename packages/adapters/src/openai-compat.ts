/**
 * 通用 OpenAI 兼容适配器。
 *
 * 用户自备基地址（OpenRouter、vLLM、各类聚合网关）。模型能力无法从
 * `/models` 得知，因此 `describeModel` 给保守先验：不宣称工具、视觉、思维链，
 * 上下文按 8K 计。编造能力会让路由把做不了的活派给它。
 */

import type { ModelDescriptor, ModelStrengths, ProviderPolicy } from '@l-science/shared';

import { OpenAICompatibleAdapter } from './openai-compatible.js';

export const OPENAI_COMPAT_ID = 'openai-compat' as const;

const CONSERVATIVE_STRENGTHS: ModelStrengths = {
  reasoning: 50,
  coding: 50,
  math: 50,
  longContextRecall: 45,
  writingZh: 50,
  writingEn: 50,
  toolUse: 40,
  structuredOutput: 50,
  citationFidelity: 45,
  instructionFollowing: 50,
};

const CONSERVATIVE_POLICY: ProviderPolicy = {
  trainingUse: 'unknown',
  retentionDays: null,
  zdr: false,
  region: 'unknown',
};

export class OpenAICompatAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({
      id: OPENAI_COMPAT_ID,
      displayName: 'OpenAI 兼容',
      requiresApiKey: true,
      // 未知网关经常不认 stream_options；带上会直接 400
      supportsStreamUsage: false,
    });
  }

  protected describeModel(rawId: string): ModelDescriptor | null {
    if (rawId === '') return null;
    return {
      id: rawId,
      providerId: OPENAI_COMPAT_ID,
      displayName: rawId,
      contextWindow: 8192,
      maxOutputTokens: 4096,
      modalities: ['text'],
      strengths: CONSERVATIVE_STRENGTHS,
      pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
      performance: { medianLatencyMs: 800, tokensPerSec: 30 },
      policy: CONSERVATIVE_POLICY,
      local: false,
      features: {
        streaming: true,
        toolUse: false,
        promptCache: false,
        vision: false,
        thinking: false,
      },
    };
  }
}
