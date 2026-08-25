/**
 * 路由第二阶段：打分排序（需求 7.5、7.11、7.12）。
 *
 * 公式：加权能力得分 − 归一化成本惩罚 − 归一化延迟惩罚 + 经验修正 + 探索项。
 *
 * 成本与延迟必须**在候选集内归一化**，不能用绝对值。绝对值的问题是量纲不可比：
 * 成本以美元计（量级 1e-4），延迟以毫秒计（量级 1e3），直接相减等于让延迟
 * 完全支配结果。在候选集内归一化到 0-1 之后，「贵」与「慢」的含义变成
 * 「在当前可选范围内相对最贵/最慢」，这才是决策真正需要的语义。
 */

import type { ModelDescriptor, ModelStrengths, TaskProfile } from '@l-science/shared';

import { TASK_SENSITIVITY } from './weights.js';

/** 经验修正项。由反馈闭环维护，取值范围约定为 -1 到 +1。 */
export interface ExperienceAdjustment {
  /** 综合修正值。正数表示这个模型在这类任务上历史表现好于其静态能力评分。 */
  value: number;
  /** 支撑该修正的样本数。样本少时修正被折减，见 `confidenceFactor`。 */
  sampleCount: number;
}

export interface ScoreInput {
  candidates: readonly ModelDescriptor[];
  profile: TaskProfile;
  /** 键为 `${taskType}:${modelId}`。缺失视为无修正。 */
  experience?: ReadonlyMap<string, ExperienceAdjustment>;
  /** 探索强度（0-1）。0 表示纯贪心。见 `explorationBonus` 的说明。 */
  explorationRate?: number;
  /** 注入随机源以便测试可重复。 */
  random?: () => number;
}

export interface ScoredCandidate {
  modelId: string;
  total: number;
  breakdown: Record<string, number>;
}

/** 能力得分满分 100，惩罚与加成都在这个量纲上表达，便于阅读得分构成。 */
const CAPABILITY_SCALE = 100;

/** 成本与延迟惩罚的最大扣分。取 40 是让它能改变排序但不能压倒能力差异。 */
const MAX_PENALTY = 40;

/** 经验修正的最大影响。刻意小于能力权重的影响力，避免少量反馈就颠覆排序。 */
const MAX_EXPERIENCE = 15;

/**
 * 本地模型偏好加成。仅在 `profile.preferLocal` 为真时生效。
 *
 * 取 30 分是一个明确的语义选择：它足以跨过约一个模型档位的能力差距
 * （实测本地 8B 与云端便宜档的能力先验差约 24 分），但顶不住两个档位以上的
 * 差距。因此「偏好本地」的含义是「本地够用就用本地」，而不是「无论多差都用
 * 本地」——后者会在需要强推理的任务上产出垃圾。
 *
 * 加成太小（比如 12）会让这个开关变成装饰：用户勾了它，结果从不改变。
 * 需要绝对强制时应使用 `forcedModelId`，那是显式且可解释的路径。
 */
const LOCAL_BONUS = 30;

export function experienceKey(taskType: string, modelId: string): string {
  return `${taskType}:${modelId}`;
}

/**
 * 加权能力得分。
 *
 * 按权重和归一化，因此不同任务的得分可比——这一点对「跨任务比较路由质量」
 * 有用，也让权重表可以自由增删维度而不需要手工保持总和为 100。
 */
function capabilityScore(strengths: ModelStrengths, weights: Partial<ModelStrengths>): number {
  let weighted = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    if (weight === undefined || weight <= 0) continue;
    const value = strengths[key as keyof ModelStrengths];
    weighted += value * weight;
    totalWeight += weight;
  }

  // 权重全为 0（或空表）时退化为不区分能力，交由成本延迟决定
  return totalWeight === 0 ? CAPABILITY_SCALE / 2 : weighted / totalWeight;
}

/**
 * 在候选集内把一组数值归一化到 0-1。
 *
 * 全部相等时返回全 0 而不是全 0.5：如果所有候选一样贵，成本就不该影响排序。
 * 返回 0.5 会给每个候选扣同样的分，虽然不改变排序，但会让得分构成里出现
 * 一个看起来有意义、实际上无意义的惩罚项，干扰用户理解决策。
 *
 * **已知局限**：min-max 归一化对「无关备选」不是免疫的。加入一个更贵的第三个
 * 候选，会让中间那个候选的相对成本变小，从而可能翻转前两者的排序。极端值是
 * 稳定的（最便宜的恒为 0 惩罚，最贵的恒为满惩罚），不稳定只发生在中间位置。
 *
 * 选择保留这个性质而不是改用绝对成本档位，理由是绝对档位有更糟的失败模式：
 * 单次请求的成本几乎总是微不足道（量级 1e-3 美元），用绝对档位会让成本在
 * 所有单次任务上完全失效，「筛文献用便宜的」这个需求就无法实现。真正的解法
 * 是让任务画像携带批量规模，把成本乘上去——那需要调用方提供它还没有的信息，
 * 留待批量执行功能落地时一并处理。
 */
function normalize(values: readonly number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  if (span === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / span);
}

/**
 * 单次请求的预估成本。
 *
 * 用预估 token 数而不是历史均值：同一个模型处理 1K token 和 100K token 的
 * 成本差两个数量级，用均值会让长任务的成本被严重低估。
 */
export function estimateCost(model: ModelDescriptor, profile: TaskProfile): number {
  return (
    (profile.estimatedInputTokens / 1000) * model.pricing.inputPer1k +
    (profile.expectedOutputTokens / 1000) * model.pricing.outputPer1k
  );
}

/**
 * 单次请求的预估耗时。
 *
 * 首字延迟加生成时间。只看首字延迟会让「响应快但生成慢」的模型被高估，
 * 而长输出任务恰恰对生成速度更敏感。
 */
export function estimateLatency(model: ModelDescriptor, profile: TaskProfile): number {
  const generationMs =
    model.performance.tokensPerSec > 0
      ? (profile.expectedOutputTokens / model.performance.tokensPerSec) * 1000
      : 0;
  return model.performance.medianLatencyMs + generationMs;
}

/**
 * 经验修正的置信折减（需求 7.12）。
 *
 * 样本少时把修正按比例缩小，避免「跑了两次碰巧不错」就永久锁定某个模型。
 * 取 10 个样本达到满置信：再高会让反馈闭环反应过慢，再低则挡不住噪声。
 */
function confidenceFactor(sampleCount: number): number {
  return Math.min(1, sampleCount / 10);
}

/**
 * 探索加成（需求 7.12）。
 *
 * 纯贪心策略有个具体的失败模式：某模型早期偶然表现好，此后一直被选中，
 * 其他模型再也拿不到样本，于是「它最好」这个结论永远无法被推翻。
 *
 * 这里用「样本越少、加成越大」的乐观初始化，而不是 ε-贪心的随机跳选。
 * 原因是随机跳选在科研写作场景里代价不对称：用户会看到一次莫名其妙的
 * 低质量输出，而且不知道那是系统在探索。乐观初始化让探索集中在
 * 「还没试过的模型」上，且随样本积累自然衰减。
 */
function explorationBonus(
  adjustment: ExperienceAdjustment | undefined,
  explorationRate: number,
): number {
  if (explorationRate <= 0) return 0;
  const samples = adjustment?.sampleCount ?? 0;
  // 未试过时给满额加成，此后按 1/(1+n) 衰减
  return explorationRate * MAX_EXPERIENCE * (1 / (1 + samples));
}

export function scoreCandidates(input: ScoreInput): readonly ScoredCandidate[] {
  const { candidates, profile, experience, explorationRate = 0.3 } = input;
  if (candidates.length === 0) return [];

  const sensitivity = TASK_SENSITIVITY[profile.taskType];

  const costs = candidates.map((m) => estimateCost(m, profile));
  const latencies = candidates.map((m) => estimateLatency(m, profile));
  const normalizedCosts = normalize(costs);
  const normalizedLatencies = normalize(latencies);

  const scored = candidates.map((model, index) => {
    const capability = capabilityScore(model.strengths, profile.weights);

    const costPenalty = (normalizedCosts[index] ?? 0) * sensitivity.cost * MAX_PENALTY;
    const latencyPenalty = (normalizedLatencies[index] ?? 0) * sensitivity.latency * MAX_PENALTY;

    const adjustment = experience?.get(experienceKey(profile.taskType, model.id));
    const experienceScore =
      adjustment === undefined
        ? 0
        : adjustment.value * MAX_EXPERIENCE * confidenceFactor(adjustment.sampleCount);

    const exploration = explorationBonus(adjustment, explorationRate);
    const localBonus = profile.preferLocal === true && model.local ? LOCAL_BONUS : 0;

    // 预算超限不直接排除（那是硬过滤的职责），而是重罚。
    // 理由是预算通常是软约束：用户宁可超一点也不愿任务做不了
    const overBudget =
      profile.costBudget !== undefined && (costs[index] ?? 0) > profile.costBudget
        ? -MAX_PENALTY
        : 0;
    const overLatencyBudget =
      profile.latencyBudgetMs !== undefined && (latencies[index] ?? 0) > profile.latencyBudgetMs
        ? -MAX_PENALTY / 2
        : 0;

    const total =
      capability -
      costPenalty -
      latencyPenalty +
      experienceScore +
      exploration +
      localBonus +
      overBudget +
      overLatencyBudget;

    return {
      modelId: model.id,
      total,
      breakdown: {
        能力得分: round(capability),
        成本惩罚: round(-costPenalty),
        延迟惩罚: round(-latencyPenalty),
        经验修正: round(experienceScore),
        探索加成: round(exploration),
        ...(localBonus !== 0 ? { 本地偏好: round(localBonus) } : {}),
        ...(overBudget !== 0 ? { 超出成本预算: round(overBudget) } : {}),
        ...(overLatencyBudget !== 0 ? { 超出延迟预算: round(overLatencyBudget) } : {}),
        预估成本: round(costs[index] ?? 0, 6),
        预估耗时毫秒: Math.round(latencies[index] ?? 0),
      },
    };
  });

  // 得分相同时按模型 id 排序，保证结果稳定可复现——
  // 不稳定的排序会让同一输入产生不同决策，调试时无法复现
  return scored.sort((a, b) => b.total - a.total || a.modelId.localeCompare(b.modelId));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  // 加 0 把 -0 归一成 0。不处理的话 -0 会原样进 JSON 传到 UI，
  // 在得分构成里显示成「成本惩罚 -0」，看起来像是有一个极小的负值
  return rounded === 0 ? 0 : rounded;
}

export { capabilityScore, normalize, confidenceFactor, MAX_PENALTY, MAX_EXPERIENCE, LOCAL_BONUS };
