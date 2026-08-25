/**
 * Ollama 适配器（本地模型，一等供应商）。
 *
 * 对话走 Ollama 的 OpenAI 兼容端点（`/v1/chat/completions`），因此复用基类。
 * 但**模型发现不走** `/v1/models`：那个端点只给模型名，而路由需要知道上下文
 * 窗口、是否支持工具调用、是否支持视觉。Ollama 的原生 `/api/tags` + `/api/show`
 * 会如实报告这些——用真实能力做硬过滤，比按模型名猜测可靠得多。
 *
 * 按名字猜的具体危害：本地模型的命名毫无规范（同一个 `llama3.2` 可能是 1B 也
 * 可能是 90B，量化后缀千奇百怪），猜错上下文窗口会让路由把超长任务派给装不下
 * 的模型，症状是运行时截断而非明确失败——最难排查的一类错。
 */

import type { ModelDescriptor, Modality, ModelStrengths, ProviderPolicy } from '@l-science/shared';

import { OpenAICompatibleAdapter, ProviderError } from './openai-compatible.js';
import type { AdapterContext } from './types.js';

/** Ollama 的默认监听地址。OpenAI 兼容层挂在 /v1 下。 */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

/** 从 OpenAI 兼容基地址推回原生 API 根，用于调 /api/tags 与 /api/show。 */
function nativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/* ------------------------------------------------------------------ *
 * 原生 API 的响应形状（只声明实际读取的字段）
 * ------------------------------------------------------------------ */

interface TagEntry {
  name?: string;
  model?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

interface ShowResponse {
  /** 例如 ['completion','tools','vision','thinking']。 */
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { family?: string; parameter_size?: string };
}

/**
 * 本地模型不产生 API 费用，也不把数据交给第三方——这正是它作为「异厂商第二家」
 * 之外的另一个价值：需要不出本机的内容可以强制走它。
 */
const LOCAL_POLICY: ProviderPolicy = {
  trainingUse: 'none',
  retentionDays: 0,
  zdr: true,
  region: 'local',
};

/**
 * 按参数量给出的能力先验。
 *
 * 本地模型的实际水平差异极大，任何静态表都会有大量例外，因此这里只按参数量
 * 分三档给粗粒度起点，全部取 5 的整数倍以明示其非测量值。真实排序由反馈闭环
 * 建立——这也是本地模型比云端模型更依赖反馈闭环的原因：云端模型有公开基准，
 * 本地模型的具体量化版本没有。
 */
function strengthPrior(parameterBillions: number | null): ModelStrengths {
  // 参数量未知时按中档处理：低估会让它永远选不上，高估会让它接下做不好的活，
  // 中档配合反馈闭环收敛最快
  const base =
    parameterBillions === null
      ? 60
      : parameterBillions >= 60
        ? 70
        : parameterBillions >= 20
          ? 60
          : 45;

  return {
    reasoning: base,
    coding: base,
    math: base - 5,
    longContextRecall: base - 10,
    writingZh: base - 5,
    writingEn: base,
    toolUse: base - 10,
    structuredOutput: base - 10,
    citationFidelity: base - 15,
    instructionFollowing: base - 5,
  };
}

/** 从 `parameter_size`（如 "7.6B"、"70B"）解析出十亿参数数。 */
function parseParameterBillions(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^([\d.]+)\s*([BbMm])$/.exec(raw.trim());
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || unit === undefined) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return unit.toLowerCase() === 'm' ? value / 1000 : value;
}

/**
 * 从 model_info 里找上下文长度。
 *
 * 键名带架构前缀（`llama.context_length`、`qwen3.context_length` 等），
 * 架构名不可预知，因此按后缀匹配而不是枚举架构。
 */
function findContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (modelInfo === undefined) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({
      id: 'ollama',
      displayName: 'Ollama（本地）',
      requiresApiKey: false,
      // 实测（0.32.15）：不带 stream_options 时流式响应完全没有 usage 字段，
      // 带上之后最后一个事件给出 prompt_tokens/completion_tokens。
      // 起初以为本地端点不需要它，结果本地模型的 token 统计全是 0
      supportsStreamUsage: true,
    });
  }

  /**
   * 基类要求实现，但 Ollama 不走静态表——模型是用户 pull 下来的，
   * 元数据只能运行时查。`listModels` 被完全覆盖，因此这里不会被调用到。
   */
  protected describeModel(): ModelDescriptor | null {
    return null;
  }

  /** 覆盖基类：走原生 API 拿真实能力，而不是只拿一串模型名。 */
  override async listModels(ctx: AdapterContext): Promise<readonly ModelDescriptor[]> {
    const root = nativeRoot(ctx.baseUrl);

    const tagsResponse = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!tagsResponse.ok) throw await this.toError(tagsResponse);

    const tags = (await tagsResponse.json()) as { models?: TagEntry[] };
    const entries = tags.models ?? [];

    // 逐个查 /api/show。串行是刻意的：Ollama 单进程，并发查询在装了很多
    // 模型时会明显拖慢，而这个调用不在热路径上
    const descriptors: ModelDescriptor[] = [];
    for (const entry of entries) {
      const name = entry.model ?? entry.name;
      if (name === undefined || name === '') continue;

      let show: ShowResponse = {};
      try {
        const showResponse = await fetch(`${root}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name }),
          signal: AbortSignal.timeout(10_000),
        });
        if (showResponse.ok) show = (await showResponse.json()) as ShowResponse;
      } catch {
        // 查不到详情时仍然登记该模型，但用保守的能力假设——
        // 假设它不支持工具与视觉，宁可少派活也不要派了执行不了的活
      }

      const capabilities = new Set(show.capabilities ?? []);
      const parameterBillions = parseParameterBillions(
        show.details?.parameter_size ?? entry.details?.parameter_size,
      );
      const contextWindow = findContextLength(show.model_info) ?? 8192;
      const vision = capabilities.has('vision');
      const modalities: Modality[] = vision ? ['text', 'image'] : ['text'];

      descriptors.push({
        id: name,
        providerId: 'ollama',
        displayName: `${name}（本地）`,
        contextWindow,
        // Ollama 不单独限制输出长度，上限由上下文窗口决定。
        // 留出输入空间，取窗口的一半而不是全部
        maxOutputTokens: Math.max(512, Math.floor(contextWindow / 2)),
        modalities,
        strengths: strengthPrior(parameterBillions),
        // 本地推理没有按 token 计费。电费与折旧不在本系统的核算范围内，
        // 记 0 让成本维度如实反映「用它不花钱」
        pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
        performance: { medianLatencyMs: 400, tokensPerSec: 30 },
        policy: LOCAL_POLICY,
        local: true,
        features: {
          streaming: true,
          toolUse: capabilities.has('tools'),
          promptCache: true, // Ollama 默认复用 KV cache
          vision,
          thinking: capabilities.has('thinking'),
        },
      });
    }

    return descriptors;
  }

  /**
   * 健康检查走原生 `/api/tags`。
   *
   * 与云端供应商的区别在于失败语义：Ollama 没在跑是**常态**（用户可能没启动它），
   * 因此这里把连接失败与「服务在跑但出错」区分开，给出可执行的提示而不是
   * 一个裸的 ECONNREFUSED。
   */
  override async health(
    ctx: AdapterContext,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    const root = nativeRoot(ctx.baseUrl);

    try {
      const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const error = await this.toError(response);
        return { ok: false, latencyMs, detail: error.message };
      }
      const tags = (await response.json()) as { models?: TagEntry[] };
      const count = tags.models?.length ?? 0;
      return count === 0
        ? {
            ok: false,
            latencyMs,
            detail: 'Ollama 在运行但没有已下载的模型。执行 `ollama pull <模型名>` 后再试。',
          }
        : { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      const refused = /ECONNREFUSED|fetch failed|network|timeout|abort/i.test(message);
      return {
        ok: false,
        latencyMs,
        detail: refused
          ? `连不上 Ollama（${ctx.baseUrl}）。确认它已启动：命令行执行 \`ollama serve\`，或启动 Ollama 应用。`
          : message,
      };
    }
  }

  /** 拉取模型。首次使用某个本地模型前需要先下载。 */
  async pull(ctx: AdapterContext, model: string): Promise<void> {
    const root = nativeRoot(ctx.baseUrl);
    const response = await fetch(`${root}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    });
    if (!response.ok) throw await this.toError(response);
  }
}

export { ProviderError };
