/**
 * 路由编排（需求 7.6、7.7、7.8、7.9、7.10）。
 *
 * 把硬过滤与打分组装成一次可解释的决策，并提供三种执行策略：
 * 单模型（带降级链）、committee（跨厂商独立作答后上报分歧）、escalation
 * （先廉价批处理，只对低置信样本升级）。
 *
 * 「可解释」在这里是硬要求而非附加功能：用户需要知道为什么是这个模型，
 * 否则无法判断该不该覆盖它。因此每次决策都完整记录候选集、得分构成与
 * 被排除模型及原因（需求 7.6）。
 */

import type { ModelDescriptor, RoutingDecision, TaskProfile } from '@l-science/shared';

import { hardFilter, type ModelRuntimeState } from './filter.js';
import { scoreCandidates, type ExperienceAdjustment, type ScoredCandidate } from './score.js';

export interface RouteInput {
  models: readonly ModelDescriptor[];
  profile: TaskProfile;
  runtime?: ReadonlyMap<string, ModelRuntimeState>;
  experience?: ReadonlyMap<string, ExperienceAdjustment>;
  forcedModelId?: string;
  explorationRate?: number;
}

export interface RouteResult {
  decision: RoutingDecision;
  /** 按得分降序的候选，供降级链依次尝试。候选为空时为空数组。 */
  ranked: readonly ModelDescriptor[];
  /** 候选为空时的可执行说明。 */
  emptyReport: string | null;
}

/** 生成决策 id。用时间加随机后缀，避免同一毫秒内的并发决策撞 id。 */
function newDecisionId(): string {
  return `rd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 执行一次路由决策。
 *
 * 不发起任何网络请求——健康与速率信息由调用方通过 `runtime` 注入。这让路由
 * 可以被纯函数式地测试，也避免在选模型这一步引入额外延迟。
 */
export function route(input: RouteInput): RouteResult {
  const { models, profile, runtime, experience, forcedModelId, explorationRate } = input;

  const filtered = hardFilter({
    models,
    profile,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(forcedModelId !== undefined ? { forcedModelId } : {}),
  });

  if (filtered.candidates.length === 0) {
    return {
      decision: {
        id: newDecisionId(),
        taskType: profile.taskType,
        chosenModelId: null,
        scores: [],
        excluded: filtered.excluded,
        // 决策记录里直接带上报告，事后回看时不需要重新推导为什么失败
        reason: filtered.emptyReport ?? '没有可用模型',
        createdAt: Date.now(),
      },
      ranked: [],
      emptyReport: filtered.emptyReport,
    };
  }

  const scores = scoreCandidates({
    candidates: filtered.candidates,
    profile,
    ...(experience !== undefined ? { experience } : {}),
    ...(explorationRate !== undefined ? { explorationRate } : {}),
  });

  const byId = new Map(filtered.candidates.map((m) => [m.id, m]));
  const ranked = scores
    .map((s) => byId.get(s.modelId))
    .filter((m): m is ModelDescriptor => m !== undefined);

  const winner = scores[0];

  return {
    decision: {
      id: newDecisionId(),
      taskType: profile.taskType,
      chosenModelId: winner?.modelId ?? null,
      scores,
      excluded: filtered.excluded,
      reason: explainChoice({ winner, runnerUp: scores[1], profile, forcedModelId }),
      createdAt: Date.now(),
    },
    ranked,
    emptyReport: null,
  };
}

/**
 * 生成人类可读的选择理由（需求 7.6）。
 *
 * 刻意说明「与第二名的差距来自哪里」而不只是「得分最高」：得分最高是同义
 * 反复，用户真正想知道的是这个选择建立在什么之上——如果差距主要来自成本
 * 惩罚，那么当用户不在意成本时就该覆盖它。
 */
function explainChoice(input: {
  winner: ScoredCandidate | undefined;
  runnerUp: ScoredCandidate | undefined;
  profile: TaskProfile;
  forcedModelId?: string;
}): string {
  const { winner, runnerUp, profile, forcedModelId } = input;
  if (winner === undefined) return '没有可用模型';

  if (forcedModelId !== undefined) {
    return `用户为本次请求强制指定了 ${forcedModelId}，已通过硬过滤检查。`;
  }

  const parts = [
    `任务 ${profile.taskType}：选中 ${winner.modelId}（得分 ${winner.total.toFixed(1)}）`,
  ];

  if (runnerUp === undefined) {
    parts.push('它是硬过滤后唯一的候选。');
    return parts.join('，');
  }

  const margin = winner.total - runnerUp.total;
  parts.push(`次选 ${runnerUp.modelId}（${runnerUp.total.toFixed(1)}），差距 ${margin.toFixed(1)}`);

  // 找出造成差距的最大单项，让用户知道该覆盖什么
  const dominant = dominantFactor(winner.breakdown, runnerUp.breakdown);
  if (dominant !== null) {
    parts.push(
      `差距主要来自「${dominant.key}」（${dominant.delta > 0 ? '+' : ''}${dominant.delta.toFixed(1)}）`,
    );
  }

  return `${parts.join('，')}。`;
}

/** 找出两个得分构成之间差异最大的项。忽略纯信息项（预估成本、预估耗时）。 */
function dominantFactor(
  winner: Record<string, number>,
  runnerUp: Record<string, number>,
): { key: string; delta: number } | null {
  const informational = new Set(['预估成本', '预估耗时毫秒']);
  let best: { key: string; delta: number } | null = null;

  for (const key of new Set([...Object.keys(winner), ...Object.keys(runnerUp)])) {
    if (informational.has(key)) continue;
    const delta = (winner[key] ?? 0) - (runnerUp[key] ?? 0);
    if (best === null || Math.abs(delta) > Math.abs(best.delta)) best = { key, delta };
  }

  return best === null || Math.abs(best.delta) < 0.05 ? null : best;
}

/* ------------------------------------------------------------------ *
 * 降级链（需求 7.7、7.8）
 * ------------------------------------------------------------------ */

/** 判断一次失败是否应触发降级。 */
export interface FailureClassification {
  /** 是否值得换模型重试。 */
  retryable: boolean;
  /** 是否为内容安全拒答。为真时**绝不**重试（需求 7.8）。 */
  isContentFilter: boolean;
}

export interface FallbackStep {
  model: ModelDescriptor;
  /** 该次尝试在降级链中的序号，从 0 开始。 */
  attempt: number;
}

/**
 * 构造降级链。
 *
 * 跨供应商是刻意的（需求 7.7）：同一供应商出限流或服务端错误时，换它自己的
 * 另一个模型往往同样失败——限流通常是账户级的，服务端故障通常是整站的。
 * 因此优先跳到不同供应商，同供应商的其他模型排在后面作为兜底。
 */
export function buildFallbackChain(
  ranked: readonly ModelDescriptor[],
  failedModelId: string,
): readonly FallbackStep[] {
  const failed = ranked.find((m) => m.id === failedModelId);
  const rest = ranked.filter((m) => m.id !== failedModelId);

  if (failed === undefined) return rest.map((model, attempt) => ({ model, attempt }));

  const otherVendors = rest.filter((m) => m.providerId !== failed.providerId);
  const sameVendor = rest.filter((m) => m.providerId === failed.providerId);

  return [...otherVendors, ...sameVendor].map((model, attempt) => ({ model, attempt }));
}

/**
 * 判断是否允许降级。
 *
 * 内容安全拒答返回 false 并附带理由：它是安全边界，不是基础设施故障。
 * 换模型绕过等于把安全判断当故障处理——这条必须在代码里显式挡住，
 * 因为「重试直到成功」是重试逻辑的自然默认行为。
 */
export function shouldFallback(failure: FailureClassification): {
  allowed: boolean;
  reason: string;
} {
  if (failure.isContentFilter) {
    return {
      allowed: false,
      reason:
        '供应商以内容安全为由拒绝了本次请求。这是安全边界而不是故障，因此不会更换模型或改写提示词重试。',
    };
  }
  if (!failure.retryable) {
    return {
      allowed: false,
      reason: '失败原因不可重试（如凭据无效或请求本身不合法），换模型也会同样失败。',
    };
  }
  return { allowed: true, reason: '失败可重试，按得分降序跨供应商降级。' };
}

/** 把降级重试关联回原决策（需求 7.7）。 */
export function linkFallbackDecision(
  original: RoutingDecision,
  chosenModelId: string,
  attempt: number,
): RoutingDecision {
  return {
    ...original,
    id: newDecisionId(),
    chosenModelId,
    fallbackOf: original.id,
    reason: `原决策 ${original.id} 选中的模型失败，降级到 ${chosenModelId}（第 ${String(attempt + 1)} 次重试）。`,
    createdAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * committee 模式（需求 7.9）
 * ------------------------------------------------------------------ */

export interface CommitteeSelection {
  members: readonly ModelDescriptor[];
  /** 实际厂商数。小于请求数时说明降级了，需要如实告知用户。 */
  vendorCount: number;
  /** 无法满足请求规模时的说明。满足时为 null。 */
  degradedReason: string | null;
}

/**
 * 选出 committee 成员（需求 7.9）。
 *
 * 关键约束是**跨供应商**：同一家的两个模型往往共享训练数据与对齐策略，
 * 它们的错误是相关的。让它们互相校验会得到一致的错误答案，而一致性会被
 * 误读成可信——这比单模型更危险，因为它给了用户虚假的信心。
 *
 * 因此优先每家取一个，只有在厂商数不足时才在同厂商内补足，并明确报告降级。
 */
export function selectCommittee(
  ranked: readonly ModelDescriptor[],
  size: number,
): CommitteeSelection {
  if (size <= 0 || ranked.length === 0) {
    return { members: [], vendorCount: 0, degradedReason: '没有可用模型组成 committee。' };
  }

  // 按供应商分组，组内保持得分顺序
  const byVendor = new Map<string, ModelDescriptor[]>();
  for (const model of ranked) {
    const list = byVendor.get(model.providerId) ?? [];
    list.push(model);
    byVendor.set(model.providerId, list);
  }

  // 轮转取用：先每家取最优的一个，不够再取每家第二个
  const members: ModelDescriptor[] = [];
  let round = 0;
  while (members.length < size) {
    let addedThisRound = false;
    for (const list of byVendor.values()) {
      const candidate = list[round];
      if (candidate === undefined) continue;
      members.push(candidate);
      addedThisRound = true;
      if (members.length >= size) break;
    }
    if (!addedThisRound) break; // 所有供应商的模型都取完了
    round += 1;
  }

  const vendorCount = new Set(members.map((m) => m.providerId)).size;

  let degradedReason: string | null = null;
  if (members.length < size) {
    degradedReason = `请求 ${String(size)} 个成员，实际只有 ${String(members.length)} 个可用模型。`;
  } else if (vendorCount < 2 && size > 1) {
    degradedReason =
      `committee 的 ${String(members.length)} 个成员来自同一家供应商（${members[0]?.providerId ?? '未知'}）。` +
      '同一家的模型错误相关，交叉比对得到的一致性不能当作可信度。请接入第二家供应商或启动本地模型。';
  }

  return { members, vendorCount, degradedReason };
}

/** 一个 committee 成员的作答。 */
export interface CommitteeAnswer {
  modelId: string;
  providerId: string;
  content: string;
}

export interface CommitteeDisagreement {
  /** 参与作答的成员数。 */
  answerCount: number;
  /** 是否存在分歧。 */
  hasDisagreement: boolean;
  /** 按内容归一化后的分组，用于向用户展示「谁和谁说的一样」。 */
  groups: ReadonlyArray<{ normalized: string; modelIds: readonly string[]; answer: string }>;
}

/**
 * 比对 committee 的作答（需求 7.9）。
 *
 * **不做多数表决**。这是刻意的：多数表决会把分歧藏起来，只给出一个答案，
 * 而分歧本身往往是最有价值的信号——它说明这个问题存在真实的不确定性，
 * 用户应该知道。静默表决等于系统替用户做了一个它没资格做的判断。
 */
export function compareCommitteeAnswers(
  answers: readonly CommitteeAnswer[],
): CommitteeDisagreement {
  const groups = new Map<string, { modelIds: string[]; answer: string }>();

  for (const answer of answers) {
    // 归一化只做空白与大小写折叠。更激进的归一化（如去标点、词干化）会把
    // 真实分歧误判成一致，而在科研语境下一个「不」字的差别就是结论反转
    const normalized = answer.content.trim().toLowerCase().replace(/\s+/g, ' ');
    const group = groups.get(normalized) ?? { modelIds: [], answer: answer.content };
    group.modelIds.push(answer.modelId);
    groups.set(normalized, group);
  }

  return {
    answerCount: answers.length,
    hasDisagreement: groups.size > 1,
    groups: [...groups.entries()].map(([normalized, g]) => ({
      normalized,
      modelIds: g.modelIds,
      answer: g.answer,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * escalation 模式（需求 7.10）
 * ------------------------------------------------------------------ */

export interface EscalationPlan {
  /** 批量处理阶段使用的模型：最廉价，本地优先。 */
  bulkModel: ModelDescriptor | null;
  /** 升级阶段使用的模型：能力最强。 */
  escalateModel: ModelDescriptor | null;
  /** 置信度低于此值的样本升级。 */
  confidenceThreshold: number;
  /** 两阶段用了同一个模型时的说明——此时 escalation 没有意义。 */
  degradedReason: string | null;
}

/**
 * 制定 escalation 计划（需求 7.10）。
 *
 * 批量阶段挑「最便宜」而不是「得分最高」：escalation 的全部意义在于用廉价
 * 模型过滤掉大部分简单样本，如果批量阶段就用了强模型，成本一点没省。
 * 本地模型优先——它的边际成本为零，是天然的批处理选择。
 */
export function planEscalation(
  ranked: readonly ModelDescriptor[],
  profile: TaskProfile,
  confidenceThreshold = 0.7,
): EscalationPlan {
  if (ranked.length === 0) {
    return {
      bulkModel: null,
      escalateModel: null,
      confidenceThreshold,
      degradedReason: '没有可用模型。',
    };
  }

  const costOf = (m: ModelDescriptor): number =>
    (profile.estimatedInputTokens / 1000) * m.pricing.inputPer1k +
    (profile.expectedOutputTokens / 1000) * m.pricing.outputPer1k;

  // 本地优先，其次按预估成本升序
  const cheapest = [...ranked].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    return costOf(a) - costOf(b);
  })[0];

  // 升级用得分最高的（ranked 已按得分降序）
  const strongest = ranked[0];

  if (cheapest === undefined || strongest === undefined) {
    return {
      bulkModel: null,
      escalateModel: null,
      confidenceThreshold,
      degradedReason: '没有可用模型。',
    };
  }

  return {
    bulkModel: cheapest,
    escalateModel: strongest,
    confidenceThreshold,
    degradedReason:
      cheapest.id === strongest.id
        ? `批量与升级阶段都只能用 ${cheapest.id}，escalation 无法节省成本。接入更多模型后才有意义。`
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * 异厂商约束（需求 11：Reviewer 必须异厂商）
 * ------------------------------------------------------------------ */

export interface CrossVendorPick {
  model: ModelDescriptor | null;
  /** 找不到异厂商模型时的说明。 */
  degradedReason: string | null;
}

/**
 * 挑一个与给定供应商不同厂商的模型（需求 11 的 Reviewer 约束）。
 *
 * Reviewer 的职责是独立审查主链路的结论。用同一家的模型审查自己，会因为
 * 训练数据与对齐策略相同而错过同类错误——审查通过因此不构成任何额外保证。
 * 找不到异厂商模型时**明确告知降级**，不静默用同厂商顶上。
 */
export function pickCrossVendor(
  ranked: readonly ModelDescriptor[],
  excludeProviderId: string,
): CrossVendorPick {
  const crossVendor = ranked.find((m) => m.providerId !== excludeProviderId);
  if (crossVendor !== undefined) return { model: crossVendor, degradedReason: null };

  const fallback = ranked[0];
  return {
    model: fallback ?? null,
    degradedReason:
      fallback === undefined
        ? '没有可用模型执行独立审查。'
        : `只有 ${excludeProviderId} 一家供应商可用，独立审查只能由同厂商模型执行。` +
          '同厂商模型的错误相关，审查通过不构成额外保证。接入第二家供应商或启动本地 Ollama 可解决。',
  };
}
