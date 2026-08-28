/**
 * 路由第一阶段：硬过滤（需求 7.3、7.4、7.13）。
 *
 * 硬过滤只回答「这个模型能不能做这件事」，不回答「做得好不好」。两者混在一起
 * 打分是常见的错误设计：一个不支持工具调用的模型在需要工具的任务上不该是
 * 「得分低」，而该是「不可选」——否则当所有候选都很弱时，它可能因为便宜而
 * 胜出，然后在运行时失败。
 *
 * 候选为空时**如实报告缺什么**，绝不放宽约束（需求 7.4）。自动放宽是最坏的
 * 行为：用户以为任务按要求跑了，实际上系统偷偷降低了标准，而这件事不会出现
 * 在任何输出里。
 */

import type { ExcludedCandidate, ModelDescriptor, TaskProfile } from '@l-science/shared';

/** 运行时状态。由健康检查与用量统计提供，不属于模型的静态描述。 */
export interface ModelRuntimeState {
  /** 最近一次健康检查的结果。未检查过时视为健康——不能因为没检查就排除。 */
  healthy?: boolean;
  /**
   * 健康检查失败的具体原因。
   *
   * 「健康检查未通过」对用户毫无帮助——连不上、密钥过期、模型被下线三种情况的
   * 处置办法完全不同。把探测时拿到的原文带上，用户才知道该改什么。
   */
  healthDetail?: string;
  /** 剩余速率余量（0-1）。低于阈值时排除，避免把请求打进必然限流的模型。 */
  rateHeadroom?: number;
  /** 用户是否在设置里禁用了该模型。 */
  userDisabled?: boolean;
  /** 该模型所属供应商的凭据是否已配置。 */
  hasCredential?: boolean;
}

export interface FilterInput {
  models: readonly ModelDescriptor[];
  profile: TaskProfile;
  /** 按模型 id 索引的运行时状态。缺失的模型按「无不利信息」处理。 */
  runtime?: ReadonlyMap<string, ModelRuntimeState>;
  /** 用户为本次请求强制指定的模型（需求 7.14）。 */
  forcedModelId?: string;
}

export interface FilterResult {
  candidates: readonly ModelDescriptor[];
  excluded: readonly ExcludedCandidate[];
  /** 候选为空时的可执行说明。非空时为 null。 */
  emptyReport: string | null;
}

/** 速率余量低于此值即视为不可用。留一点余量比撞上限流再重试便宜。 */
const MIN_RATE_HEADROOM = 0.05;

/**
 * 上下文窗口检查要预留输出空间。
 *
 * 只比较输入 token 是经典错误：模型能装下 prompt 不等于能装下 prompt 加回答。
 * 症状是生成到一半被截断，而截断的输出往往看起来像是「模型能力不足」，
 * 于是被误诊成选错了模型。
 */
function fitsContext(model: ModelDescriptor, profile: TaskProfile): boolean {
  const needed = profile.estimatedInputTokens + profile.expectedOutputTokens;
  if (needed > model.contextWindow) return false;
  // 输出还受单独的上限约束
  return profile.expectedOutputTokens <= model.maxOutputTokens;
}

function supportsModalities(model: ModelDescriptor, profile: TaskProfile): boolean {
  return profile.requiredModalities.every((m) => model.modalities.includes(m));
}

/**
 * 训练策略约束（需求 7.13）。
 *
 * 只接受明确承诺不用于训练的模型。`unknown` 被排除而不是放行——「不知道」
 * 在这个语境下必须当作「不满足」，否则这个开关就是装饰性的。
 */
function satisfiesPolicy(model: ModelDescriptor, profile: TaskProfile): boolean {
  if (profile.requireTrainingOptOut !== true) return true;
  return model.policy.trainingUse === 'none' || model.local;
}

/** 排除原因的中文说明，用于候选为空时的报告。 */
const REASON_TEXT: Readonly<Record<ExcludedCandidate['reason'], string>> = {
  'modality-unsupported': '不支持所需模态',
  'context-too-small': '上下文窗口装不下（含预留输出）',
  'tool-use-unsupported': '不支持工具调用',
  unhealthy: '健康检查未通过',
  'rate-limited': '速率余量不足',
  'user-disabled': '被用户禁用',
  'policy-mismatch': '数据使用策略不满足要求',
  'no-credential': '缺少凭据',
};

export function hardFilter(input: FilterInput): FilterResult {
  const { models, profile, runtime, forcedModelId } = input;

  // 强制指定模型时仍然执行硬过滤：用户可以指定模型，但不能指定一个
  // 物理上做不到的组合（比如让纯文本模型读图）。区别在于候选集只有它一个，
  // 因此被排除时报告会明确指出「你指定的模型为什么不行」
  const pool = forcedModelId === undefined ? models : models.filter((m) => m.id === forcedModelId);

  const candidates: ModelDescriptor[] = [];
  const excluded: ExcludedCandidate[] = [];

  /*
   * 统一从这里构造排除记录，`reasonText` 因此不可能漏填。
   *
   * 逐处 push 时手写文案的做法迟早会漏一处，而漏掉的表现是界面上冒出一个裸的
   * 英文原因码——那正是最需要解释的时刻（用户在问「为什么没选它」）。
   */
  const exclude = (modelId: string, reason: ExcludedCandidate['reason'], detail?: string): void => {
    excluded.push({
      modelId,
      reason,
      reasonText: REASON_TEXT[reason],
      ...(detail === undefined ? {} : { detail }),
    });
  };

  for (const model of pool) {
    const state = runtime?.get(model.id);

    if (state?.userDisabled === true) {
      exclude(model.id, 'user-disabled');
      continue;
    }

    // 凭据检查放在健康检查之前：没凭据时健康检查必然失败，
    // 但报「缺凭据」比报「不健康」可执行得多
    if (state?.hasCredential === false) {
      exclude(model.id, 'no-credential', `供应商 ${model.providerId} 未配置凭据`);
      continue;
    }

    if (!supportsModalities(model, profile)) {
      exclude(
        model.id,
        'modality-unsupported',
        `需要 ${profile.requiredModalities.join('、')}，该模型支持 ${model.modalities.join('、')}`,
      );
      continue;
    }

    if (!fitsContext(model, profile)) {
      const needed = profile.estimatedInputTokens + profile.expectedOutputTokens;
      exclude(
        model.id,
        'context-too-small',
        `需要 ${String(needed)} token（输入 ${String(profile.estimatedInputTokens)} + 预留输出 ${String(profile.expectedOutputTokens)}），窗口 ${String(model.contextWindow)}、输出上限 ${String(model.maxOutputTokens)}`,
      );
      continue;
    }

    if (profile.needToolUse && !model.features.toolUse) {
      exclude(model.id, 'tool-use-unsupported');
      continue;
    }

    if (!satisfiesPolicy(model, profile)) {
      exclude(
        model.id,
        'policy-mismatch',
        `会话要求供应商承诺不用于训练，该模型的策略为 ${model.policy.trainingUse}`,
      );
      continue;
    }

    // 健康状态未知时视为健康：没检查过不等于不可用，
    // 否则冷启动时全部模型都会被排除
    if (state?.healthy === false) {
      exclude(model.id, 'unhealthy', state.healthDetail);
      continue;
    }

    if (state?.rateHeadroom !== undefined && state.rateHeadroom < MIN_RATE_HEADROOM) {
      exclude(model.id, 'rate-limited', `剩余余量 ${(state.rateHeadroom * 100).toFixed(0)}%`);
      continue;
    }

    candidates.push(model);
  }

  return {
    candidates,
    excluded,
    emptyReport:
      candidates.length > 0
        ? null
        : buildEmptyReport({ profile, excluded, poolSize: pool.length, forcedModelId }),
  };
}

/**
 * 候选为空时的报告（需求 7.4）。
 *
 * 目标是让用户知道**改什么能解决**，而不只是「没有可用模型」。因此按原因
 * 分组统计，并针对最主要的原因给出具体建议。
 */
function buildEmptyReport(input: {
  profile: TaskProfile;
  excluded: readonly ExcludedCandidate[];
  poolSize: number;
  forcedModelId?: string;
}): string {
  const { profile, excluded, poolSize, forcedModelId } = input;

  if (poolSize === 0) {
    return forcedModelId === undefined
      ? '模型注册表为空。请先在设置里配置至少一家供应商的凭据，或启动本地 Ollama。'
      : `强制指定的模型 ${forcedModelId} 不在注册表中。`;
  }

  const byReason = new Map<ExcludedCandidate['reason'], ExcludedCandidate[]>();
  for (const item of excluded) {
    const list = byReason.get(item.reason) ?? [];
    list.push(item);
    byReason.set(item.reason, list);
  }

  const lines: string[] = [
    forcedModelId === undefined
      ? `任务 ${profile.taskType} 没有可用模型：${String(poolSize)} 个候选全部被排除。`
      : `强制指定的模型 ${forcedModelId} 无法执行任务 ${profile.taskType}。`,
  ];

  // 按影响的模型数降序，最主要的原因排在前面
  const ordered = [...byReason.entries()].sort(([, a], [, b]) => b.length - a.length);
  for (const [reason, items] of ordered) {
    const names = items.map((i) => i.modelId).join('、');
    lines.push(`  · ${REASON_TEXT[reason]}（${String(items.length)} 个）：${names}`);
    const detail = items.find((i) => i.detail !== undefined)?.detail;
    if (detail !== undefined) lines.push(`    例：${detail}`);
  }

  const primary = ordered[0]?.[0];
  const suggestion = suggestFix(primary, profile);
  if (suggestion !== null) lines.push(`  建议：${suggestion}`);

  return lines.join('\n');
}

/** 针对最主要的排除原因给出可执行建议。给不出建议时返回 null，不说空话。 */
function suggestFix(
  reason: ExcludedCandidate['reason'] | undefined,
  profile: TaskProfile,
): string | null {
  switch (reason) {
    case 'no-credential':
      return '用 `npm run credential set provider:<供应商>` 录入凭据。';
    case 'context-too-small':
      return `本次需要约 ${String(profile.estimatedInputTokens + profile.expectedOutputTokens)} token。可减少输入范围，或接入更大上下文窗口的模型。`;
    case 'tool-use-unsupported':
      return '该任务需要执行工具。接入支持工具调用的模型，或换用不需要工具的任务类型。';
    case 'policy-mismatch':
      return '会话开启了「要求供应商承诺不用于训练」。可关闭该要求，或使用本地模型（本地推理数据不出本机）。';
    case 'unhealthy':
      return '检查网络与供应商状态。本地模型需确认 Ollama 正在运行。';
    case 'rate-limited':
      return '稍后重试，或接入其他供应商分摊请求。';
    case 'modality-unsupported':
      return `本次需要 ${profile.requiredModalities.join('、')} 模态。接入支持该模态的模型（如视觉型号）。`;
    case 'user-disabled':
      return '在设置里重新启用相关模型。';
    default:
      return null;
  }
}

export { REASON_TEXT, MIN_RATE_HEADROOM };
