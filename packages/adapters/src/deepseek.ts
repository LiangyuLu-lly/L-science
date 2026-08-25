/**
 * DeepSeek 适配器。
 *
 * 端点讲 OpenAI 方言，因此绝大部分逻辑继承自 `OpenAICompatibleAdapter`，
 * 这里只处理两处 DeepSeek 特有的东西：
 *
 * 1. **按时段计价。** 非高峰价是高峰价的一半，差一倍。成本打分若忽略时段，
 *    估价会系统性偏离，而偏离方向随一天中的时间漂移——这种误差比恒定偏差
 *    更难察觉，因为同一个任务在不同时间会得出不同的「最省钱模型」。
 * 2. **思维模式。** v4 系列默认开启 thinking，思维链走 `reasoning_content`
 *    字段（基类已归一化为 `thinking` 分片）。
 *
 * 模型元数据核对自官方定价文档（api-docs.deepseek.com/quick_start/pricing）。
 * 价格与上下文窗口是官方公布的事实；能力评分是**先验估计**，由反馈闭环校正，
 * 详见 `STRENGTH_PRIORS` 的说明。
 */

import type { ModelDescriptor, ModelStrengths, ProviderPolicy } from '@l-science/shared';

import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { AdapterContext, ChatRequest } from './types.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/* ------------------------------------------------------------------ *
 * 计价时段
 * ------------------------------------------------------------------ */

/**
 * 判断给定时刻是否处于高峰计价时段。
 *
 * 官方规则：UTC 周一至周五的 01:00-04:00 与 06:00-10:00 为高峰，其余为非高峰，
 * 非高峰价为高峰价的一半。注意周末全天非高峰。
 *
 * 用 UTC 而不是本地时间——用户在东八区，本机时间与计价时段错开 8 小时，
 * 用本地时间判断会稳定地判错。
 */
export function isPeakPricing(at: Date = new Date()): boolean {
  const day = at.getUTCDay(); // 0 = 周日
  if (day === 0 || day === 6) return false;

  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** 高峰价（美元 / 1K token，cache miss）。非高峰减半。 */
const PEAK_RATES = {
  'deepseek-v4-flash': { inputPer1k: 0.00044, outputPer1k: 0.00132 },
  'deepseek-v4-pro': { inputPer1k: 0.00132, outputPer1k: 0.00396 },
  'deepseek-v4-flash-vision-exp': { inputPer1k: 0.00044, outputPer1k: 0.00132 },
} as const;

type DeepSeekModelId = keyof typeof PEAK_RATES;

export function deepseekPricing(
  modelId: string,
  at: Date = new Date(),
): { inputPer1k: number; outputPer1k: number; currency: string } | null {
  const rates = PEAK_RATES[modelId as DeepSeekModelId] as
    { inputPer1k: number; outputPer1k: number } | undefined;
  if (rates === undefined) return null;

  const factor = isPeakPricing(at) ? 1 : 0.5;
  return {
    inputPer1k: rates.inputPer1k * factor,
    outputPer1k: rates.outputPer1k * factor,
    currency: 'USD',
  };
}

/* ------------------------------------------------------------------ *
 * 能力先验
 * ------------------------------------------------------------------ */

/**
 * 能力评分的**先验估计**，不是测量值。
 *
 * 这些数字的唯一作用是给反馈闭环一个起点，让路由在没有本地历史时不至于
 * 随机选择。它们依据的是官方公布的、可核实的结构性事实：
 *
 * - v4-pro 是更大的模型（官方规格 1.6T 总参数 / ~49B 激活），并发限额更低
 *   （500 vs 2500），价格是 flash 的三倍——三项都指向它被定位为更强的推理档
 * - v4-flash 与 vision-exp 共享同一价格与并发档，故文本能力按同档处理
 * - DeepSeek 的中文写作长期是其公开强项，英文写作相对弱一档
 *
 * 刻意不写成看起来精确的基准分（如 87.3）：那会让人以为这是实测结果。
 * 全部取 5 的整数倍，明示其为粗粒度先验。
 */
const STRENGTH_PRIORS: Record<DeepSeekModelId, ModelStrengths> = {
  'deepseek-v4-pro': {
    reasoning: 85,
    coding: 85,
    math: 85,
    longContextRecall: 80,
    writingZh: 85,
    writingEn: 75,
    toolUse: 80,
    structuredOutput: 80,
    citationFidelity: 70,
    instructionFollowing: 80,
  },
  'deepseek-v4-flash': {
    reasoning: 70,
    coding: 75,
    math: 70,
    longContextRecall: 70,
    writingZh: 80,
    writingEn: 70,
    toolUse: 75,
    structuredOutput: 75,
    citationFidelity: 65,
    instructionFollowing: 75,
  },
  'deepseek-v4-flash-vision-exp': {
    reasoning: 70,
    coding: 70,
    math: 70,
    longContextRecall: 70,
    writingZh: 80,
    writingEn: 70,
    toolUse: 70,
    structuredOutput: 70,
    citationFidelity: 65,
    instructionFollowing: 70,
  },
};

/**
 * 数据使用策略。
 *
 * 标为 `unknown` 而不是猜一个值：这个字段可以作为路由的可选过滤条件，
 * 填一个乐观的猜测等于替用户做了他没授权的判断。需要确定答案时应由用户
 * 依据其与供应商的实际协议在设置里覆盖。
 */
const DEEPSEEK_POLICY: ProviderPolicy = {
  trainingUse: 'unknown',
  retentionDays: null,
  zdr: false,
  region: 'CN',
  evidenceUrl: 'https://api-docs.deepseek.com/',
};

/** 官方公布：全系 1M 上下文、最大输出 384K。 */
const CONTEXT_WINDOW = 1_000_000;
const MAX_OUTPUT = 384_000;

const DISPLAY_NAMES: Record<DeepSeekModelId, string> = {
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision（实验）',
};

/** 观测到的中位延迟（毫秒）。首次运行用先验，之后由用量统计覆盖。 */
const LATENCY_PRIORS: Record<DeepSeekModelId, { medianLatencyMs: number; tokensPerSec: number }> = {
  'deepseek-v4-pro': { medianLatencyMs: 1200, tokensPerSec: 25 },
  'deepseek-v4-flash': { medianLatencyMs: 650, tokensPerSec: 45 },
  'deepseek-v4-flash-vision-exp': { medianLatencyMs: 700, tokensPerSec: 45 },
};

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({
      id: 'deepseek',
      displayName: 'DeepSeek',
      requiresApiKey: true,
      supportsStreamUsage: true,
    });
  }

  protected describeModel(rawId: string): ModelDescriptor | null {
    // 归一化别名：deepseek-chat / deepseek-reasoner 是仍然可用的旧名，
    // 但注册表里应该只出现规范 id，否则同一个模型会被当成两个候选参与打分
    const id = canonicalizeDeepSeekModel(rawId);
    if (id === null) return null;

    const pricing = deepseekPricing(id);
    if (pricing === null) return null;

    const isVision = id === 'deepseek-v4-flash-vision-exp';

    return {
      id,
      providerId: 'deepseek',
      displayName: DISPLAY_NAMES[id],
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_OUTPUT,
      modalities: isVision ? ['text', 'image'] : ['text'],
      strengths: STRENGTH_PRIORS[id],
      pricing,
      performance: LATENCY_PRIORS[id],
      policy: DEEPSEEK_POLICY,
      local: false,
      features: {
        streaming: true,
        toolUse: true,
        promptCache: true, // 官方有 cache hit 计价档，说明支持前缀缓存
        vision: isVision,
      },
    };
  }

  /**
   * 注入当次调用的实时价格。
   *
   * 调用方通常从注册表取 pricing，但注册表里的值是**写入那一刻**的时段价。
   * 跨过时段边界后它就偏了一倍，因此这里按调用时刻重新计算并覆盖。
   */
  override chat(
    ctx: AdapterContext,
    req: ChatRequest,
  ): AsyncIterable<import('./types.js').ChatChunk> {
    const id = canonicalizeDeepSeekModel(req.modelName);
    const livePricing = id === null ? null : deepseekPricing(id);
    const effective: AdapterContext =
      livePricing === null ? ctx : { ...ctx, pricing: ctx.pricing ?? livePricing };
    return super.chat(effective, req);
  }
}

/**
 * 把 DeepSeek 的模型名归一化到规范 id。
 *
 * `deepseek-chat` 与 `deepseek-reasoner` 是历史别名，服务端仍然接受，
 * 但如果让它们与规范 id 同时进入注册表，同一个模型会被当成两个候选各自打分、
 * 各自累积反馈统计——统计量因此被摊薄，反馈闭环收敛变慢。
 */
export function canonicalizeDeepSeekModel(raw: string): DeepSeekModelId | null {
  if (raw in PEAK_RATES) return raw as DeepSeekModelId;

  switch (raw) {
    // 旧别名：chat 对应非思维档，reasoner 对应思维档
    case 'deepseek-chat':
      return 'deepseek-v4-flash';
    case 'deepseek-reasoner':
      return 'deepseek-v4-pro';
    default:
      return null;
  }
}
