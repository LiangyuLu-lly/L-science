/**
 * 任务类型的权重预设（需求 7.2、7.14）。
 *
 * 每组权重编码的是「这个任务真正看重什么」这个产品判断，不是平均分配。
 * 平均分配的后果是所有任务都选出同一个「综合最强」的模型——那等于没有路由，
 * 也就丢掉了本平台的核心价值。
 *
 * 权重不需要归一化：打分阶段会按权重和归一，因此这里只表达相对重视程度。
 * 未列出的维度权重为 0，即该任务不关心它。
 */

import type { ModelStrengths, TaskProfile, TaskType } from '@l-science/shared';

export type WeightPreset = Partial<ModelStrengths>;

/**
 * 十三种任务类型的默认权重。
 *
 * 几处刻意的取舍：
 *
 * - `citation.verify` 把 `citationFidelity` 压倒性地放在首位。核对引文时
 *   「宁可说不确定，也不要编一个看起来对的」，而这正是 citationFidelity 想
 *   捕捉的性质。文笔在这里毫无价值。
 * - `literature.screen` 只给很低的能力权重。这个任务要跑成百上千次，成本与
 *   延迟的惩罚项会主导选择，而这是对的——筛文献是粗筛，用贵模型是浪费。
 * - `manuscript.draft` 与 `manuscript.polish` 分开，且中英分别加权。中文写作
 *   与英文写作在不同模型上差距很大，合成一个「写作」维度会让路由在写英文
 *   稿时选中一个中文很好但英文平庸的模型。
 * - `reviewer.audit` 与 `review.simulate` 权重相近但用途不同：前者是系统内部
 *   的独立审查（必须异厂商），后者是模拟审稿人视角帮用户预演。
 */
export const TASK_WEIGHTS: Readonly<Record<TaskType, WeightPreset>> = {
  // 极短的分类任务：只要指令跟随可靠，其余不重要。成本延迟主导
  'route.classify': {
    instructionFollowing: 60,
    structuredOutput: 40,
  },

  // 粗筛，量大。能力要求低，让成本与延迟惩罚主导选择
  'literature.screen': {
    instructionFollowing: 40,
    structuredOutput: 30,
    longContextRecall: 20,
  },

  // 深读单篇，要在长文里准确定位事实
  'pdf.deepread': {
    longContextRecall: 50,
    reasoning: 25,
    citationFidelity: 25,
    instructionFollowing: 15,
  },

  // 生成分析代码：能跑起来比写得漂亮重要
  'analysis.codegen': {
    coding: 50,
    reasoning: 25,
    instructionFollowing: 20,
    toolUse: 20,
    structuredOutput: 10,
  },

  // 统计推理：这里出错会一路传到结论，权重给足
  'stats.reason': {
    math: 45,
    reasoning: 40,
    citationFidelity: 15,
    instructionFollowing: 10,
  },

  // 信号处理流水线：代码 + 领域推理
  'signal.pipeline': {
    coding: 40,
    reasoning: 25,
    math: 25,
    toolUse: 20,
  },

  // 出图：代码为主，但要能理解「图要表达什么」
  'figure.compose': {
    coding: 45,
    instructionFollowing: 25,
    reasoning: 15,
    toolUse: 15,
  },

  // 起草手稿：文笔是主项，中英分开加权
  'manuscript.draft': {
    writingEn: 40,
    writingZh: 25,
    reasoning: 20,
    instructionFollowing: 20,
    citationFidelity: 15,
  },

  // 润色：改写能力与指令跟随（要遵守期刊格式与作者意图）
  'manuscript.polish': {
    writingEn: 45,
    writingZh: 25,
    instructionFollowing: 30,
  },

  // 翻译：两端语言能力都要，且不能自由发挥
  'manuscript.translate': {
    writingZh: 40,
    writingEn: 40,
    instructionFollowing: 30,
  },

  // 模拟审稿：找问题的能力，需要较强推理
  'review.simulate': {
    reasoning: 45,
    citationFidelity: 20,
    writingEn: 15,
    instructionFollowing: 15,
  },

  // 核对引文：宁可说不确定，也不要编一个看起来对的
  'citation.verify': {
    citationFidelity: 60,
    longContextRecall: 25,
    instructionFollowing: 20,
    toolUse: 15,
  },

  // 系统内部的独立审查，尤其盯统计用法与引文
  'reviewer.audit': {
    reasoning: 40,
    math: 25,
    citationFidelity: 30,
    instructionFollowing: 15,
  },
};

/**
 * 任务类型对基础设施能力的硬性要求。
 *
 * 与权重不同，这些是**能不能做**而不是**做得好不好**：需要跑工具的任务派给
 * 不支持工具调用的模型，结果不是「做得差一点」而是根本无法完成。因此它们
 * 进硬过滤，不进打分。
 */
export const TASK_REQUIREMENTS: Readonly<
  Record<TaskType, { needToolUse: boolean; needStructuredOutput: boolean }>
> = {
  'route.classify': { needToolUse: false, needStructuredOutput: true },
  'literature.screen': { needToolUse: false, needStructuredOutput: true },
  'pdf.deepread': { needToolUse: false, needStructuredOutput: false },
  'analysis.codegen': { needToolUse: true, needStructuredOutput: false },
  'stats.reason': { needToolUse: true, needStructuredOutput: false },
  'signal.pipeline': { needToolUse: true, needStructuredOutput: false },
  'figure.compose': { needToolUse: true, needStructuredOutput: false },
  'manuscript.draft': { needToolUse: false, needStructuredOutput: false },
  'manuscript.polish': { needToolUse: false, needStructuredOutput: false },
  'manuscript.translate': { needToolUse: false, needStructuredOutput: false },
  'review.simulate': { needToolUse: false, needStructuredOutput: false },
  'citation.verify': { needToolUse: true, needStructuredOutput: true },
  'reviewer.audit': { needToolUse: false, needStructuredOutput: true },
};

/**
 * 成本与延迟的相对敏感度（0-1）。
 *
 * 1 表示极度在意，0 表示不在意。这个维度必须与能力权重分开：`literature.screen`
 * 和 `citation.verify` 的能力权重形状不同，但真正把它们推向不同模型的是这里
 * ——筛文献要跑上千次，核引文一次几分钱无所谓。
 */
export const TASK_SENSITIVITY: Readonly<Record<TaskType, { cost: number; latency: number }>> = {
  'route.classify': { cost: 0.9, latency: 0.9 },
  'literature.screen': { cost: 0.95, latency: 0.7 },
  'pdf.deepread': { cost: 0.4, latency: 0.3 },
  'analysis.codegen': { cost: 0.3, latency: 0.4 },
  'stats.reason': { cost: 0.15, latency: 0.15 },
  'signal.pipeline': { cost: 0.3, latency: 0.3 },
  'figure.compose': { cost: 0.4, latency: 0.4 },
  'manuscript.draft': { cost: 0.2, latency: 0.2 },
  'manuscript.polish': { cost: 0.3, latency: 0.3 },
  'manuscript.translate': { cost: 0.4, latency: 0.3 },
  'review.simulate': { cost: 0.25, latency: 0.2 },
  // 核引文错一次的代价远高于省下的钱
  'citation.verify': { cost: 0.1, latency: 0.1 },
  'reviewer.audit': { cost: 0.15, latency: 0.1 },
};

/**
 * 构造任务画像。
 *
 * `overrides` 支持需求 7.14 的「用户覆盖权重预设」：传入的权重会**替换**而不是
 * 合并对应维度，因为合并会让用户「把某个维度调到 0」的意图无法表达。
 */
export function buildTaskProfile(
  taskType: TaskType,
  input: {
    estimatedInputTokens: number;
    expectedOutputTokens: number;
    requiredModalities?: readonly import('@l-science/shared').Modality[];
    weightOverrides?: WeightPreset;
    latencyBudgetMs?: number;
    costBudget?: number;
    committeeSize?: number;
    preferLocal?: boolean;
    requireTrainingOptOut?: boolean;
    needToolUse?: boolean;
  },
): TaskProfile {
  const defaults = TASK_REQUIREMENTS[taskType];

  return {
    taskType,
    requiredModalities: input.requiredModalities ?? ['text'],
    estimatedInputTokens: input.estimatedInputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
    needToolUse: input.needToolUse ?? defaults.needToolUse,
    needStructuredOutput: defaults.needStructuredOutput,
    weights: input.weightOverrides ?? TASK_WEIGHTS[taskType],
    ...(input.latencyBudgetMs !== undefined ? { latencyBudgetMs: input.latencyBudgetMs } : {}),
    ...(input.costBudget !== undefined ? { costBudget: input.costBudget } : {}),
    ...(input.committeeSize !== undefined ? { committeeSize: input.committeeSize } : {}),
    ...(input.preferLocal !== undefined ? { preferLocal: input.preferLocal } : {}),
    ...(input.requireTrainingOptOut !== undefined
      ? { requireTrainingOptOut: input.requireTrainingOptOut }
      : {}),
  };
}
