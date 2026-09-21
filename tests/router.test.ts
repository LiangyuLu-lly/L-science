/**
 * 多模型能力路由测试（需求 7、任务 11.4-11.9）。
 *
 * 路由是本平台的核心差异化，因此测试不只验证「函数返回了东西」，而是验证
 * 几条产品判断确实成立：
 * - 不同任务类型确实选出不同模型（否则路由等于不存在）
 * - 候选为空时报告缺什么，绝不放宽约束
 * - 内容安全拒答绝不重试
 * - committee 与 Reviewer 的异厂商约束真的生效，不满足时明确降级
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModelDescriptor, ModelStrengths } from '@l-science/shared';
import {
  TASK_REQUIREMENTS,
  TASK_SENSITIVITY,
  TASK_WEIGHTS,
  buildFallbackChain,
  buildTaskProfile,
  compareCommitteeAnswers,
  estimateCost,
  estimateLatency,
  experienceKey,
  hardFilter,
  linkFallbackDecision,
  pickCrossVendor,
  planEscalation,
  route,
  scoreCandidates,
  selectCommittee,
  shouldFallback,
  type ModelRuntimeState,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 测试用模型
 * ------------------------------------------------------------------ */

const flatStrengths = (value: number): ModelStrengths => ({
  reasoning: value,
  coding: value,
  math: value,
  longContextRecall: value,
  writingZh: value,
  writingEn: value,
  toolUse: value,
  structuredOutput: value,
  citationFidelity: value,
  instructionFollowing: value,
});

function model(overrides: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
  return {
    providerId: 'vendorA',
    displayName: overrides.id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    modalities: ['text'],
    strengths: flatStrengths(70),
    pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
    performance: { medianLatencyMs: 800, tokensPerSec: 40 },
    policy: { trainingUse: 'unknown', retentionDays: null, zdr: false, region: 'us' },
    local: false,
    features: {
      streaming: true,
      toolUse: true,
      promptCache: false,
      vision: false,
      thinking: false,
    },
    ...overrides,
  };
}

const profileOf = (
  taskType: Parameters<typeof buildTaskProfile>[0],
  extra: Partial<Parameters<typeof buildTaskProfile>[1]> = {},
) =>
  buildTaskProfile(taskType, { estimatedInputTokens: 2000, expectedOutputTokens: 500, ...extra });

/* ------------------------------------------------------------------ *
 * 权重预设
 * ------------------------------------------------------------------ */

describe('权重预设（需求 7.2）', () => {
  it('三张表覆盖同一组任务类型', () => {
    /*
     * 断言「三张表的键集合完全一致」而不是「都有 N 条」。
     *
     * 写死条数的版本在加一个任务类型时会红，但它红的原因是数字过期，不是真出了问题——
     * 那种失败只会让人把 13 改成 14 然后继续，而真正要防的「加了类型但漏了某张表」
     * 反而被这次修改掩盖过去。`TASK_WEIGHTS` 的类型是 Record<TaskType, ...>，
     * 漏一张表编译期就会报，这里守的是运行期键集合的一致性。
     */
    const weights = Object.keys(TASK_WEIGHTS).sort();
    expect(Object.keys(TASK_REQUIREMENTS).sort()).toEqual(weights);
    expect(Object.keys(TASK_SENSITIVITY).sort()).toEqual(weights);
    expect(weights.length).toBeGreaterThanOrEqual(13);
  });

  it('每种任务类型都在三张表里都有条目', () => {
    for (const taskType of Object.keys(TASK_WEIGHTS)) {
      expect(TASK_REQUIREMENTS[taskType as keyof typeof TASK_REQUIREMENTS]).toBeDefined();
      expect(TASK_SENSITIVITY[taskType as keyof typeof TASK_SENSITIVITY]).toBeDefined();
    }
  });

  it('权重不是平均分配', () => {
    // 平均分配会让所有任务选出同一个「综合最强」模型，等于没有路由
    for (const [taskType, weights] of Object.entries(TASK_WEIGHTS)) {
      const values = Object.values(weights).filter((v): v is number => v !== undefined);
      expect(values.length, `${taskType} 应有权重`).toBeGreaterThan(0);
      expect(new Set(values).size, `${taskType} 权重不应全部相同`).toBeGreaterThan(1);
    }
  });

  it('核引文任务把引文可靠性放在首位', () => {
    const weights = TASK_WEIGHTS['citation.verify'];
    const max = Math.max(...Object.values(weights).filter((v): v is number => v !== undefined));
    expect(weights.citationFidelity).toBe(max);
    // 文笔在这个任务上毫无价值
    expect(weights.writingEn ?? 0).toBe(0);
  });

  it('筛文献对成本极度敏感，核引文几乎不敏感', () => {
    // 真正把这两个任务推向不同模型的是敏感度，不是能力权重
    expect(TASK_SENSITIVITY['literature.screen'].cost).toBeGreaterThan(0.9);
    expect(TASK_SENSITIVITY['citation.verify'].cost).toBeLessThan(0.2);
  });

  it('中英写作分开加权', () => {
    // 合成一个「写作」维度会让写英文稿时选中中文好但英文平庸的模型
    const draft = TASK_WEIGHTS['manuscript.draft'];
    expect(draft.writingEn).toBeDefined();
    expect(draft.writingZh).toBeDefined();
    expect(draft.writingEn).not.toBe(draft.writingZh);
  });

  it('需要跑代码的任务标记为需要工具调用', () => {
    expect(TASK_REQUIREMENTS['analysis.codegen'].needToolUse).toBe(true);
    expect(TASK_REQUIREMENTS['signal.pipeline'].needToolUse).toBe(true);
    expect(TASK_REQUIREMENTS['figure.compose'].needToolUse).toBe(true);
    // 纯写作不需要
    expect(TASK_REQUIREMENTS['manuscript.polish'].needToolUse).toBe(false);
  });

  it('用户覆盖权重时替换而非合并', () => {
    // 合并会让「把某个维度调到 0」的意图无法表达
    const profile = profileOf('manuscript.draft', { weightOverrides: { math: 100 } });
    expect(profile.weights).toEqual({ math: 100 });
    expect(profile.weights.writingEn).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 硬过滤
 * ------------------------------------------------------------------ */

describe('硬过滤（需求 7.3）', () => {
  it('剔除不支持所需模态的模型', () => {
    const result = hardFilter({
      models: [model({ id: 'text-only' }), model({ id: 'vision', modalities: ['text', 'image'] })],
      profile: profileOf('pdf.deepread', { requiredModalities: ['text', 'image'] }),
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['vision']);
    expect(result.excluded[0]).toMatchObject({
      modelId: 'text-only',
      reason: 'modality-unsupported',
    });
  });

  it('上下文检查预留输出空间', () => {
    // 只比输入 token 是经典错误：装得下 prompt 不等于装得下 prompt 加回答
    const result = hardFilter({
      models: [model({ id: 'small', contextWindow: 2200 })],
      profile: profileOf('pdf.deepread', {
        estimatedInputTokens: 2000,
        expectedOutputTokens: 500,
      }),
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0]).toMatchObject({ reason: 'context-too-small' });
    expect(result.excluded[0]?.detail).toContain('2500');
  });

  it('输出上限单独约束', () => {
    const result = hardFilter({
      models: [model({ id: 'short-out', contextWindow: 1_000_000, maxOutputTokens: 100 })],
      profile: profileOf('manuscript.draft', {
        estimatedInputTokens: 1000,
        expectedOutputTokens: 4000,
      }),
    });
    expect(result.candidates).toHaveLength(0);
  });

  it('需要工具时剔除不支持工具的模型', () => {
    const noTools = model({
      id: 'no-tools',
      features: {
        streaming: true,
        toolUse: false,
        promptCache: false,
        vision: false,
        thinking: false,
      },
    });
    const result = hardFilter({
      models: [noTools, model({ id: 'with-tools' })],
      profile: profileOf('analysis.codegen'),
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['with-tools']);
    expect(result.excluded[0]).toMatchObject({ reason: 'tool-use-unsupported' });
  });

  it('剔除用户禁用的模型', () => {
    const runtime = new Map<string, ModelRuntimeState>([['banned', { userDisabled: true }]]);
    const result = hardFilter({
      models: [model({ id: 'banned' }), model({ id: 'ok' })],
      profile: profileOf('manuscript.polish'),
      runtime,
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['ok']);
  });

  it('缺凭据的报「缺凭据」而不是「不健康」', () => {
    // 后者虽然也对，但前者可执行得多
    const runtime = new Map<string, ModelRuntimeState>([
      ['nokey', { hasCredential: false, healthy: false }],
    ]);
    const result = hardFilter({
      models: [model({ id: 'nokey' })],
      profile: profileOf('manuscript.polish'),
      runtime,
    });
    expect(result.excluded[0]).toMatchObject({ reason: 'no-credential' });
  });

  it('健康状态未知视为健康，避免冷启动时全部被排除', () => {
    const result = hardFilter({
      models: [model({ id: 'unchecked' })],
      profile: profileOf('manuscript.polish'),
      runtime: new Map(),
    });
    expect(result.candidates).toHaveLength(1);
  });

  it('速率余量不足时剔除', () => {
    const runtime = new Map<string, ModelRuntimeState>([['throttled', { rateHeadroom: 0.01 }]]);
    const result = hardFilter({
      models: [model({ id: 'throttled' })],
      profile: profileOf('manuscript.polish'),
      runtime,
    });
    expect(result.excluded[0]).toMatchObject({ reason: 'rate-limited' });
    expect(result.excluded[0]?.detail).toContain('1%');
  });
});

describe('训练策略约束（需求 7.13）', () => {
  const optOut = model({
    id: 'opt-out',
    policy: { trainingUse: 'none', retentionDays: 0, zdr: true, region: 'us' },
  });
  const unknown = model({ id: 'unknown-policy' });
  const local = model({ id: 'local-m', local: true, providerId: 'ollama' });

  it('开启要求时只留明确承诺不用于训练的模型', () => {
    const result = hardFilter({
      models: [optOut, unknown],
      profile: profileOf('manuscript.draft', { requireTrainingOptOut: true }),
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['opt-out']);
  });

  it('unknown 被排除而不是放行', () => {
    // 「不知道」在这里必须当作「不满足」，否则这个开关就是装饰性的
    const result = hardFilter({
      models: [unknown],
      profile: profileOf('manuscript.draft', { requireTrainingOptOut: true }),
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0]).toMatchObject({ reason: 'policy-mismatch' });
    expect(result.excluded[0]?.detail).toContain('unknown');
  });

  it('本地模型总是满足该约束', () => {
    const result = hardFilter({
      models: [local],
      profile: profileOf('manuscript.draft', { requireTrainingOptOut: true }),
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['local-m']);
  });

  it('未开启要求时不过滤策略', () => {
    const result = hardFilter({ models: [unknown], profile: profileOf('manuscript.draft') });
    expect(result.candidates).toHaveLength(1);
  });
});

describe('候选为空时的报告（需求 7.4）', () => {
  it('不放宽约束，如实返回空候选', () => {
    const result = hardFilter({
      models: [model({ id: 'small', contextWindow: 100 })],
      profile: profileOf('pdf.deepread'),
    });
    // 自动放宽是最坏的行为：用户以为按要求跑了，实际标准被偷偷降低
    expect(result.candidates).toHaveLength(0);
    expect(result.emptyReport).not.toBeNull();
  });

  it('按原因分组统计并给出可执行建议', () => {
    const runtime = new Map<string, ModelRuntimeState>([
      ['a', { hasCredential: false }],
      ['b', { hasCredential: false }],
    ]);
    const result = hardFilter({
      models: [model({ id: 'a' }), model({ id: 'b' })],
      profile: profileOf('manuscript.draft'),
      runtime,
    });
    expect(result.emptyReport).toContain('缺少凭据');
    expect(result.emptyReport).toContain('2 个');
    expect(result.emptyReport).toContain('credential set');
  });

  it('上下文不足时报告具体需要多少 token', () => {
    const result = hardFilter({
      models: [model({ id: 'small', contextWindow: 1000 })],
      profile: profileOf('pdf.deepread', {
        estimatedInputTokens: 50_000,
        expectedOutputTokens: 2000,
      }),
    });
    expect(result.emptyReport).toContain('52000');
  });

  it('注册表为空时提示去配置供应商', () => {
    const result = hardFilter({ models: [], profile: profileOf('manuscript.draft') });
    expect(result.emptyReport).toContain('注册表为空');
    expect(result.emptyReport).toContain('Ollama');
  });

  it('策略不满足时提示可用本地模型解决', () => {
    const result = hardFilter({
      models: [model({ id: 'x' })],
      profile: profileOf('manuscript.draft', { requireTrainingOptOut: true }),
    });
    expect(result.emptyReport).toContain('本地模型');
  });

  it('有候选时报告为 null', () => {
    const result = hardFilter({
      models: [model({ id: 'x' })],
      profile: profileOf('manuscript.draft'),
    });
    expect(result.emptyReport).toBeNull();
  });
});

describe('强制指定模型（需求 7.14）', () => {
  it('只考虑被指定的模型', () => {
    const result = hardFilter({
      models: [model({ id: 'a' }), model({ id: 'b' })],
      profile: profileOf('manuscript.draft'),
      forcedModelId: 'b',
    });
    expect(result.candidates.map((m) => m.id)).toEqual(['b']);
  });

  it('指定的模型仍需通过硬过滤，且说明为什么不行', () => {
    // 用户可以指定模型，但不能指定一个物理上做不到的组合
    const result = hardFilter({
      models: [model({ id: 'text-only' })],
      profile: profileOf('pdf.deepread', { requiredModalities: ['text', 'image'] }),
      forcedModelId: 'text-only',
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.emptyReport).toContain('text-only');
    expect(result.emptyReport).toContain('无法执行');
  });

  it('指定不存在的模型时明确指出', () => {
    const result = hardFilter({
      models: [model({ id: 'a' })],
      profile: profileOf('manuscript.draft'),
      forcedModelId: 'ghost',
    });
    expect(result.emptyReport).toContain('不在注册表中');
  });
});

/* ------------------------------------------------------------------ *
 * 打分
 * ------------------------------------------------------------------ */

describe('打分（需求 7.5）', () => {
  it('能力强的胜出（其他条件相同）', () => {
    const scores = scoreCandidates({
      candidates: [
        model({ id: 'weak', strengths: flatStrengths(40) }),
        model({ id: 'strong', strengths: flatStrengths(90) }),
      ],
      profile: profileOf('stats.reason'),
      explorationRate: 0,
    });
    expect(scores[0]?.modelId).toBe('strong');
  });

  it('成本与延迟在候选集内归一化，而不是用绝对值', () => {
    // 绝对值的问题是量纲不可比：成本量级 1e-4，延迟量级 1e3，直接相减
    // 等于让延迟完全支配结果
    const scores = scoreCandidates({
      candidates: [
        model({
          id: 'cheap',
          pricing: { inputPer1k: 0.0001, outputPer1k: 0.0002, currency: 'USD' },
        }),
        model({ id: 'pricey', pricing: { inputPer1k: 0.01, outputPer1k: 0.02, currency: 'USD' } }),
      ],
      profile: profileOf('literature.screen'),
      explorationRate: 0,
    });
    // 筛文献对成本极敏感，便宜的应胜出
    expect(scores[0]?.modelId).toBe('cheap');
    // 最便宜的那个成本惩罚为 0（它是归一化的下界）
    expect(scores.find((s) => s.modelId === 'cheap')?.breakdown['成本惩罚']).toBe(0);
  });

  it('全部同价时成本不影响排序，且惩罚项为 0', () => {
    // 返回 0.5 会给每个候选扣同样的分，虽不改排序但会在得分构成里
    // 留下一个看似有意义、实则无意义的惩罚项
    const scores = scoreCandidates({
      candidates: [model({ id: 'a' }), model({ id: 'b' })],
      profile: profileOf('literature.screen'),
      explorationRate: 0,
    });
    for (const score of scores) {
      expect(score.breakdown['成本惩罚']).toBe(0);
      expect(score.breakdown['延迟惩罚']).toBe(0);
    }
  });

  it('不同任务类型选出不同模型', () => {
    // 这是路由存在的意义。如果所有任务都选同一个，路由就是装饰
    const cheapFast = model({
      id: 'cheap-fast',
      strengths: { ...flatStrengths(55), citationFidelity: 40 },
      pricing: { inputPer1k: 0.00005, outputPer1k: 0.0001, currency: 'USD' },
      performance: { medianLatencyMs: 200, tokensPerSec: 90 },
    });
    const strongPricey = model({
      id: 'strong-pricey',
      strengths: { ...flatStrengths(88), citationFidelity: 92 },
      pricing: { inputPer1k: 0.02, outputPer1k: 0.04, currency: 'USD' },
      performance: { medianLatencyMs: 2500, tokensPerSec: 15 },
    });

    const screening = scoreCandidates({
      candidates: [cheapFast, strongPricey],
      profile: profileOf('literature.screen'),
      explorationRate: 0,
    });
    const citation = scoreCandidates({
      candidates: [cheapFast, strongPricey],
      profile: profileOf('citation.verify'),
      explorationRate: 0,
    });

    expect(screening[0]?.modelId).toBe('cheap-fast');
    expect(citation[0]?.modelId).toBe('strong-pricey');
  });

  it('得分构成包含全部分项，便于 UI 解释决策', () => {
    const scores = scoreCandidates({
      candidates: [
        model({ id: 'a' }),
        model({ id: 'b', pricing: { inputPer1k: 0.5, outputPer1k: 0.5, currency: 'USD' } }),
      ],
      profile: profileOf('stats.reason'),
      explorationRate: 0,
    });
    const breakdown = scores[0]?.breakdown ?? {};
    expect(breakdown).toHaveProperty('能力得分');
    expect(breakdown).toHaveProperty('成本惩罚');
    expect(breakdown).toHaveProperty('延迟惩罚');
    expect(breakdown).toHaveProperty('经验修正');
    expect(breakdown).toHaveProperty('预估成本');
    expect(breakdown).toHaveProperty('预估耗时毫秒');
  });

  it('得分相同时按 id 稳定排序', () => {
    // 不稳定的排序会让同一输入产生不同决策，调试时无法复现
    const candidates = [model({ id: 'zebra' }), model({ id: 'alpha' })];
    for (let i = 0; i < 5; i += 1) {
      const scores = scoreCandidates({
        candidates,
        profile: profileOf('stats.reason'),
        explorationRate: 0,
      });
      expect(scores.map((s) => s.modelId)).toEqual(['alpha', 'zebra']);
    }
  });

  it('本地偏好加成只在开启时生效', () => {
    const cloud = model({ id: 'cloud' });
    const local = model({ id: 'local', local: true, providerId: 'ollama' });

    const without = scoreCandidates({
      candidates: [cloud, local],
      profile: profileOf('stats.reason'),
      explorationRate: 0,
    });
    const with_ = scoreCandidates({
      candidates: [cloud, local],
      profile: profileOf('stats.reason', { preferLocal: true }),
      explorationRate: 0,
    });

    expect(without.find((s) => s.modelId === 'local')?.breakdown['本地偏好']).toBeUndefined();
    expect(with_.find((s) => s.modelId === 'local')?.breakdown['本地偏好']).toBeGreaterThan(0);
  });

  it('超预算重罚但不排除', () => {
    // 预算通常是软约束：用户宁可超一点也不愿任务做不了
    const scores = scoreCandidates({
      candidates: [
        model({ id: 'over', pricing: { inputPer1k: 1, outputPer1k: 1, currency: 'USD' } }),
      ],
      profile: profileOf('stats.reason', { costBudget: 0.001 }),
      explorationRate: 0,
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]?.breakdown['超出成本预算']).toBeLessThan(0);
  });

  it('预估成本按 token 数算，不用历史均值', () => {
    const m = model({
      id: 'x',
      pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
    });
    const small = estimateCost(
      m,
      profileOf('stats.reason', { estimatedInputTokens: 1000, expectedOutputTokens: 100 }),
    );
    const large = estimateCost(
      m,
      profileOf('stats.reason', { estimatedInputTokens: 100_000, expectedOutputTokens: 10_000 }),
    );
    // 差两个数量级，用均值会让长任务成本被严重低估
    expect(large / small).toBeGreaterThan(50);
  });

  it('预估耗时含生成时间，不只看首字延迟', () => {
    const fastFirstSlowGen = model({
      id: 'a',
      performance: { medianLatencyMs: 100, tokensPerSec: 5 },
    });
    const slowFirstFastGen = model({
      id: 'b',
      performance: { medianLatencyMs: 1000, tokensPerSec: 200 },
    });
    const profile = profileOf('manuscript.draft', {
      estimatedInputTokens: 1000,
      expectedOutputTokens: 4000,
    });
    // 长输出任务对生成速度更敏感
    expect(estimateLatency(fastFirstSlowGen, profile)).toBeGreaterThan(
      estimateLatency(slowFirstFastGen, profile),
    );
  });
});

describe('经验修正与探索（需求 7.11、7.12）', () => {
  const a = model({ id: 'a' });
  const b = model({ id: 'b' });

  it('正向经验提升排序', () => {
    const experience = new Map([
      [experienceKey('stats.reason', 'b'), { value: 1, sampleCount: 20 }],
    ]);
    const scores = scoreCandidates({
      candidates: [a, b],
      profile: profileOf('stats.reason'),
      experience,
      explorationRate: 0,
    });
    expect(scores[0]?.modelId).toBe('b');
  });

  it('样本少时经验修正被折减', () => {
    // 「跑了两次碰巧不错」不该永久锁定某个模型
    const few = new Map([[experienceKey('stats.reason', 'b'), { value: 1, sampleCount: 1 }]]);
    const many = new Map([[experienceKey('stats.reason', 'b'), { value: 1, sampleCount: 20 }]]);

    const withFew = scoreCandidates({
      candidates: [a, b],
      profile: profileOf('stats.reason'),
      experience: few,
      explorationRate: 0,
    });
    const withMany = scoreCandidates({
      candidates: [a, b],
      profile: profileOf('stats.reason'),
      experience: many,
      explorationRate: 0,
    });

    const fewAdj = withFew.find((s) => s.modelId === 'b')?.breakdown['经验修正'] ?? 0;
    const manyAdj = withMany.find((s) => s.modelId === 'b')?.breakdown['经验修正'] ?? 0;
    expect(fewAdj).toBeLessThan(manyAdj);
    expect(fewAdj).toBeGreaterThan(0);
  });

  it('未试过的模型拿到探索加成，已充分采样的几乎没有', () => {
    // 纯贪心的失败模式：某模型早期偶然表现好，此后一直被选中，
    // 其他模型再也拿不到样本，「它最好」永远无法被推翻
    const experience = new Map([
      [experienceKey('stats.reason', 'a'), { value: 0, sampleCount: 100 }],
    ]);
    const scores = scoreCandidates({
      candidates: [a, b],
      profile: profileOf('stats.reason'),
      experience,
      explorationRate: 1,
    });

    const explored = scores.find((s) => s.modelId === 'a')?.breakdown['探索加成'] ?? 0;
    const unexplored = scores.find((s) => s.modelId === 'b')?.breakdown['探索加成'] ?? 0;
    expect(unexplored).toBeGreaterThan(explored);
  });

  it('探索加成随样本积累衰减', () => {
    const bonusAt = (sampleCount: number): number => {
      const experience = new Map([[experienceKey('stats.reason', 'a'), { value: 0, sampleCount }]]);
      const scores = scoreCandidates({
        candidates: [a],
        profile: profileOf('stats.reason'),
        experience,
        explorationRate: 1,
      });
      return scores[0]?.breakdown['探索加成'] ?? 0;
    };
    expect(bonusAt(0)).toBeGreaterThan(bonusAt(5));
    expect(bonusAt(5)).toBeGreaterThan(bonusAt(50));
  });

  it('探索率为 0 时退化为纯贪心', () => {
    const scores = scoreCandidates({
      candidates: [a, b],
      profile: profileOf('stats.reason'),
      explorationRate: 0,
    });
    for (const score of scores) expect(score.breakdown['探索加成']).toBe(0);
  });

  it('经验修正的影响力小于能力差异', () => {
    // 避免少量反馈就颠覆排序
    const experience = new Map([
      [experienceKey('stats.reason', 'weak'), { value: 1, sampleCount: 1000 }],
    ]);
    const scores = scoreCandidates({
      candidates: [
        model({ id: 'weak', strengths: flatStrengths(30) }),
        model({ id: 'strong', strengths: flatStrengths(95) }),
      ],
      profile: profileOf('stats.reason'),
      experience,
      explorationRate: 0,
    });
    expect(scores[0]?.modelId).toBe('strong');
  });
});

/* ------------------------------------------------------------------ *
 * 决策与可解释性
 * ------------------------------------------------------------------ */

describe('决策记录（需求 7.6）', () => {
  it('记录候选得分与被排除模型及原因', () => {
    const runtime = new Map<string, ModelRuntimeState>([['banned', { userDisabled: true }]]);
    const result = route({
      models: [model({ id: 'ok' }), model({ id: 'banned' })],
      profile: profileOf('stats.reason'),
      runtime,
      explorationRate: 0,
    });

    expect(result.decision.chosenModelId).toBe('ok');
    expect(result.decision.scores).toHaveLength(1);
    // reasonText 与决策一起落库，渲染层因此不需要自己维护一份原因码到文案的
    // 映射表，历史记录也能自我解释
    expect(result.decision.excluded).toEqual([
      { modelId: 'banned', reason: 'user-disabled', reasonText: '被用户禁用' },
    ]);
    expect(result.decision.taskType).toBe('stats.reason');
    expect(result.decision.createdAt).toBeGreaterThan(0);
  });

  it('每个排除项都带人类可读文案，一个不漏', () => {
    /*
     * 逐处 push 时手写文案迟早会漏一处，而漏掉的表现是界面上冒出一个裸的英文
     * 原因码——恰好在用户问「为什么没选它」的时候。这条断言覆盖全部排除分支。
     */
    const runtime = new Map<string, ModelRuntimeState>([
      ['disabled', { userDisabled: true }],
      ['nokey', { hasCredential: false }],
      ['sick', { healthy: false }],
      ['throttled', { rateHeadroom: 0.01 }],
    ]);

    const result = route({
      models: [
        model({ id: 'disabled' }),
        model({ id: 'nokey' }),
        model({ id: 'sick' }),
        model({ id: 'throttled' }),
        model({ id: 'tiny', contextWindow: 100, maxOutputTokens: 50 }),
        model({ id: 'blind', modalities: ['text'] }),
        model({ id: 'ok' }),
      ],
      profile: { ...profileOf('stats.reason'), requiredModalities: ['text'] },
      runtime,
      explorationRate: 0,
    });

    expect(result.decision.excluded.length).toBeGreaterThan(0);
    for (const item of result.decision.excluded) {
      expect(item.reasonText, `${item.modelId} 缺文案`).toBeTruthy();
      // 文案不能就是原因码本身
      expect(item.reasonText).not.toBe(item.reason);
    }
  });

  it('理由说明差距来自哪一项，而不只是「得分最高」', () => {
    // 得分最高是同义反复。用户想知道选择建立在什么之上——若差距主要来自
    // 成本惩罚，那么在不在意成本时就该覆盖它
    const result = route({
      models: [
        model({
          id: 'cheap',
          pricing: { inputPer1k: 0.00001, outputPer1k: 0.00001, currency: 'USD' },
        }),
        model({ id: 'pricey', pricing: { inputPer1k: 0.05, outputPer1k: 0.05, currency: 'USD' } }),
      ],
      profile: profileOf('literature.screen'),
      explorationRate: 0,
    });
    expect(result.decision.reason).toContain('差距主要来自');
    expect(result.decision.reason).toContain('成本惩罚');
  });

  it('唯一候选时说明它是唯一候选', () => {
    const result = route({ models: [model({ id: 'only' })], profile: profileOf('stats.reason') });
    expect(result.decision.reason).toContain('唯一');
  });

  it('候选为空时决策里带上完整报告', () => {
    const result = route({ models: [], profile: profileOf('stats.reason') });
    expect(result.decision.chosenModelId).toBeNull();
    expect(result.decision.scores).toEqual([]);
    // 事后回看时不需要重新推导为什么失败
    expect(result.decision.reason).toContain('注册表为空');
    expect(result.emptyReport).not.toBeNull();
  });

  it('ranked 按得分降序，供降级链使用', () => {
    const result = route({
      models: [
        model({ id: 'mid', strengths: flatStrengths(60) }),
        model({ id: 'best', strengths: flatStrengths(90) }),
        model({ id: 'worst', strengths: flatStrengths(30) }),
      ],
      profile: profileOf('stats.reason'),
      explorationRate: 0,
    });
    expect(result.ranked.map((m) => m.id)).toEqual(['best', 'mid', 'worst']);
  });

  it('强制指定时理由里说明是用户指定', () => {
    const result = route({
      models: [model({ id: 'a' }), model({ id: 'b' })],
      profile: profileOf('stats.reason'),
      forcedModelId: 'b',
    });
    expect(result.decision.chosenModelId).toBe('b');
    expect(result.decision.reason).toContain('强制指定');
  });

  it('决策 id 不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(
        route({ models: [model({ id: 'a' })], profile: profileOf('stats.reason') }).decision.id,
      );
    }
    expect(ids.size).toBe(50);
  });
});

/* ------------------------------------------------------------------ *
 * 降级链
 * ------------------------------------------------------------------ */

describe('降级链（需求 7.7）', () => {
  const a1 = model({ id: 'a1', providerId: 'vendorA' });
  const a2 = model({ id: 'a2', providerId: 'vendorA' });
  const b1 = model({ id: 'b1', providerId: 'vendorB' });

  it('优先跨供应商，同供应商排在后面兜底', () => {
    // 限流通常是账户级的，服务端故障通常是整站的——换同一家的另一个模型
    // 往往同样失败
    const chain = buildFallbackChain([a1, a2, b1], 'a1');
    expect(chain.map((s) => s.model.id)).toEqual(['b1', 'a2']);
  });

  it('排除已失败的模型', () => {
    const chain = buildFallbackChain([a1, a2, b1], 'a1');
    expect(chain.map((s) => s.model.id)).not.toContain('a1');
  });

  it('尝试序号从 0 递增', () => {
    const chain = buildFallbackChain([a1, a2, b1], 'a1');
    expect(chain.map((s) => s.attempt)).toEqual([0, 1]);
  });

  it('失败的模型不在列表里时返回全部候选', () => {
    const chain = buildFallbackChain([a1, b1], 'ghost');
    expect(chain.map((s) => s.model.id)).toEqual(['a1', 'b1']);
  });

  it('只有一个候选时降级链为空', () => {
    expect(buildFallbackChain([a1], 'a1')).toEqual([]);
  });
});

describe('内容安全拒答不重试（需求 7.8）', () => {
  it('拒绝降级并说明这是安全边界', () => {
    // 「重试直到成功」是重试逻辑的自然默认行为，必须在代码里显式挡住
    const result = shouldFallback({ retryable: true, isContentFilter: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('安全边界');
    expect(result.reason).toContain('不会更换模型');
  });

  it('即便标记为可重试也不重试', () => {
    expect(shouldFallback({ retryable: true, isContentFilter: true }).allowed).toBe(false);
  });

  it('不可重试的失败也不降级', () => {
    const result = shouldFallback({ retryable: false, isContentFilter: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('换模型也会同样失败');
  });

  it('可重试的基础设施失败允许降级', () => {
    expect(shouldFallback({ retryable: true, isContentFilter: false }).allowed).toBe(true);
  });
});

describe('降级决策关联原决策（需求 7.7）', () => {
  it('fallbackOf 指向原决策且换了新 id', () => {
    const original = route({
      models: [model({ id: 'a' }), model({ id: 'b' })],
      profile: profileOf('stats.reason'),
    }).decision;

    const linked = linkFallbackDecision(original, 'b', 0);
    expect(linked.fallbackOf).toBe(original.id);
    expect(linked.id).not.toBe(original.id);
    expect(linked.chosenModelId).toBe('b');
    expect(linked.reason).toContain(original.id);
    expect(linked.reason).toContain('第 1 次重试');
    // 保留原始的排除记录与得分，便于完整回溯
    expect(linked.excluded).toEqual(original.excluded);
  });
});

/* ------------------------------------------------------------------ *
 * committee
 * ------------------------------------------------------------------ */

describe('committee 模式（需求 7.9）', () => {
  const a1 = model({ id: 'a1', providerId: 'vendorA' });
  const a2 = model({ id: 'a2', providerId: 'vendorA' });
  const b1 = model({ id: 'b1', providerId: 'vendorB' });
  const c1 = model({ id: 'c1', providerId: 'vendorC' });

  it('优先每家取一个', () => {
    // 同一家的模型往往共享训练数据与对齐策略，错误是相关的。
    // 让它们互相校验会得到一致的错误答案，而一致性会被误读成可信
    const result = selectCommittee([a1, a2, b1, c1], 3);
    expect(result.vendorCount).toBe(3);
    expect(new Set(result.members.map((m) => m.providerId)).size).toBe(3);
  });

  it('厂商数不足时在同厂商内补足，并明确报告降级', () => {
    const result = selectCommittee([a1, a2], 2);
    expect(result.members).toHaveLength(2);
    expect(result.vendorCount).toBe(1);
    expect(result.degradedReason).toContain('同一家供应商');
    expect(result.degradedReason).toContain('错误相关');
  });

  it('可用模型不足请求数时如实报告', () => {
    const result = selectCommittee([a1], 3);
    expect(result.members).toHaveLength(1);
    expect(result.degradedReason).toContain('请求 3 个成员');
  });

  it('两家供应商各一个时不报降级', () => {
    const result = selectCommittee([a1, b1], 2);
    expect(result.vendorCount).toBe(2);
    expect(result.degradedReason).toBeNull();
  });

  it('单成员 committee 不因同厂商报降级', () => {
    const result = selectCommittee([a1, a2], 1);
    expect(result.members).toHaveLength(1);
    expect(result.degradedReason).toBeNull();
  });

  it('无可用模型时报告', () => {
    const result = selectCommittee([], 3);
    expect(result.members).toEqual([]);
    expect(result.degradedReason).toContain('没有可用模型');
  });

  it('组内保持得分顺序', () => {
    // ranked 已按得分降序，每家应先取自己最优的
    const result = selectCommittee([a1, a2, b1], 2);
    expect(result.members.map((m) => m.id)).toEqual(['a1', 'b1']);
  });
});

describe('committee 分歧比对（需求 7.9）', () => {
  it('一致时不报分歧', () => {
    const result = compareCommitteeAnswers([
      { modelId: 'a', providerId: 'A', content: '结论：显著' },
      { modelId: 'b', providerId: 'B', content: '结论：显著' },
    ]);
    expect(result.hasDisagreement).toBe(false);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.modelIds).toEqual(['a', 'b']);
  });

  it('不做多数表决，分歧显式上报', () => {
    // 多数表决会把分歧藏起来。分歧本身往往是最有价值的信号——
    // 它说明这个问题存在真实的不确定性，用户应该知道
    const result = compareCommitteeAnswers([
      { modelId: 'a', providerId: 'A', content: '显著' },
      { modelId: 'b', providerId: 'B', content: '显著' },
      { modelId: 'c', providerId: 'C', content: '不显著' },
    ]);
    expect(result.hasDisagreement).toBe(true);
    expect(result.groups).toHaveLength(2);
    // 少数意见必须保留，不能被 2:1 表决掉
    const minority = result.groups.find((g) => g.modelIds.includes('c'));
    expect(minority?.answer).toBe('不显著');
  });

  it('归一化只折叠空白与大小写', () => {
    const result = compareCommitteeAnswers([
      { modelId: 'a', providerId: 'A', content: 'Significant' },
      { modelId: 'b', providerId: 'B', content: '  significant  ' },
    ]);
    expect(result.hasDisagreement).toBe(false);
  });

  it('一个「不」字的差别被当作真实分歧', () => {
    // 更激进的归一化（去标点、词干化）会把真实分歧误判成一致，
    // 而在科研语境下这个差别就是结论反转
    const result = compareCommitteeAnswers([
      { modelId: 'a', providerId: 'A', content: '该效应显著' },
      { modelId: 'b', providerId: 'B', content: '该效应不显著' },
    ]);
    expect(result.hasDisagreement).toBe(true);
  });

  it('记录参与作答的成员数', () => {
    const result = compareCommitteeAnswers([
      { modelId: 'a', providerId: 'A', content: 'x' },
      { modelId: 'b', providerId: 'B', content: 'y' },
    ]);
    expect(result.answerCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * escalation 与异厂商
 * ------------------------------------------------------------------ */

describe('escalation 模式（需求 7.10）', () => {
  const strong = model({
    id: 'strong',
    strengths: flatStrengths(95),
    pricing: { inputPer1k: 0.02, outputPer1k: 0.04, currency: 'USD' },
  });
  const cheap = model({
    id: 'cheap',
    strengths: flatStrengths(50),
    pricing: { inputPer1k: 0.0001, outputPer1k: 0.0002, currency: 'USD' },
  });
  const local = model({
    id: 'local',
    providerId: 'ollama',
    local: true,
    strengths: flatStrengths(45),
    pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
  });

  it('批量阶段用最便宜的，升级阶段用最强的', () => {
    // 若批量阶段就用强模型，成本一点没省，escalation 失去意义
    const plan = planEscalation([strong, cheap], profileOf('literature.screen'));
    expect(plan.bulkModel?.id).toBe('cheap');
    expect(plan.escalateModel?.id).toBe('strong');
    expect(plan.degradedReason).toBeNull();
  });

  it('本地模型优先做批量处理', () => {
    // 本地推理边际成本为零，是天然的批处理选择
    const plan = planEscalation([strong, cheap, local], profileOf('literature.screen'));
    expect(plan.bulkModel?.id).toBe('local');
  });

  it('两阶段同一模型时说明 escalation 无意义', () => {
    const plan = planEscalation([strong], profileOf('literature.screen'));
    expect(plan.bulkModel?.id).toBe('strong');
    expect(plan.escalateModel?.id).toBe('strong');
    expect(plan.degradedReason).toContain('无法节省成本');
  });

  it('无可用模型时报告', () => {
    const plan = planEscalation([], profileOf('literature.screen'));
    expect(plan.bulkModel).toBeNull();
    expect(plan.degradedReason).toContain('没有可用模型');
  });

  it('置信度阈值可配置，默认 0.7', () => {
    expect(planEscalation([cheap], profileOf('literature.screen')).confidenceThreshold).toBe(0.7);
    expect(planEscalation([cheap], profileOf('literature.screen'), 0.9).confidenceThreshold).toBe(
      0.9,
    );
  });
});

describe('Reviewer 异厂商约束（需求 11）', () => {
  const a = model({ id: 'a', providerId: 'vendorA' });
  const b = model({ id: 'b', providerId: 'vendorB' });

  it('挑出与主链路不同厂商的模型', () => {
    // 用同一家的模型审查自己，会因训练数据与对齐策略相同而错过同类错误
    const pick = pickCrossVendor([a, b], 'vendorA');
    expect(pick.model?.id).toBe('b');
    expect(pick.degradedReason).toBeNull();
  });

  it('只有一家时明确告知降级，不静默用同厂商顶上', () => {
    const pick = pickCrossVendor([a], 'vendorA');
    expect(pick.model?.id).toBe('a');
    expect(pick.degradedReason).toContain('只有 vendorA 一家');
    expect(pick.degradedReason).toContain('不构成额外保证');
    // 给出可执行的解决路径
    expect(pick.degradedReason).toContain('Ollama');
  });

  it('无可用模型时报告', () => {
    const pick = pickCrossVendor([], 'vendorA');
    expect(pick.model).toBeNull();
    expect(pick.degradedReason).toContain('没有可用模型');
  });

  it('按得分顺序挑第一个异厂商模型', () => {
    const b2 = model({ id: 'b2', providerId: 'vendorB' });
    const pick = pickCrossVendor([a, b, b2], 'vendorA');
    expect(pick.model?.id).toBe('b');
  });
});

/* ------------------------------------------------------------------ *
 * 端到端：真实的 DeepSeek + Ollama 组合
 * ------------------------------------------------------------------ */

describe('端到端场景', () => {
  // 按实测的真实参数构造，验证路由在真实模型组合下的行为
  const dsFlash = model({
    id: 'deepseek-v4-flash',
    providerId: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    strengths: { ...flatStrengths(72), writingZh: 80, citationFidelity: 65 },
    pricing: { inputPer1k: 0.00022, outputPer1k: 0.00066, currency: 'USD' },
    performance: { medianLatencyMs: 650, tokensPerSec: 45 },
  });
  const dsPro = model({
    id: 'deepseek-v4-pro',
    providerId: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    strengths: { ...flatStrengths(83), writingZh: 85, citationFidelity: 70 },
    pricing: { inputPer1k: 0.00066, outputPer1k: 0.00198, currency: 'USD' },
    performance: { medianLatencyMs: 1200, tokensPerSec: 25 },
  });
  const localQwen = model({
    id: 'qwen3:8b',
    providerId: 'ollama',
    local: true,
    contextWindow: 40_960,
    maxOutputTokens: 20_480,
    strengths: flatStrengths(48),
    pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
    performance: { medianLatencyMs: 400, tokensPerSec: 30 },
    policy: { trainingUse: 'none', retentionDays: 0, zdr: true, region: 'local' },
  });

  const all = [dsFlash, dsPro, localQwen];

  it('筛文献不选最贵的模型', () => {
    // 不断言具体赢家：free 的本地模型（能力先验 48）与便宜的 flash（72）
    // 在这个任务上是真实的接近取舍，钉死胜负等于测试一个任意的平局裁决。
    // 真正该守住的是「不会选最贵的那个」
    const result = route({
      models: all,
      profile: profileOf('literature.screen', {
        estimatedInputTokens: 3000,
        expectedOutputTokens: 200,
      }),
      explorationRate: 0,
    });
    expect(result.decision.chosenModelId).not.toBe('deepseek-v4-pro');
  });

  it('筛文献比统计推理更偏向便宜的模型', () => {
    // 这才是路由的核心价值：同一组候选，不同任务给出不同答案
    const screening = route({
      models: all,
      profile: profileOf('literature.screen', {
        estimatedInputTokens: 3000,
        expectedOutputTokens: 200,
      }),
      explorationRate: 0,
    });
    const reasoning = route({
      models: all,
      profile: profileOf('stats.reason', { estimatedInputTokens: 3000, expectedOutputTokens: 200 }),
      explorationRate: 0,
    });

    const costOf = (id: string | null): number =>
      all.find((m) => m.id === id)?.pricing.inputPer1k ?? Number.POSITIVE_INFINITY;
    expect(costOf(screening.decision.chosenModelId)).toBeLessThan(
      costOf(reasoning.decision.chosenModelId),
    );
  });

  it('本地模型的成本惩罚为零', () => {
    const result = route({
      models: all,
      profile: profileOf('literature.screen', {
        estimatedInputTokens: 3000,
        expectedOutputTokens: 200,
      }),
      explorationRate: 0,
    });
    const local = result.decision.scores.find((s) => s.modelId === 'qwen3:8b');
    expect(local?.breakdown['成本惩罚']).toBe(0);
  });

  it('开启本地优先时选本地模型', () => {
    const result = route({
      models: all,
      profile: profileOf('literature.screen', {
        estimatedInputTokens: 3000,
        expectedOutputTokens: 200,
        preferLocal: true,
      }),
      explorationRate: 0,
    });
    expect(result.decision.chosenModelId).toBe('qwen3:8b');
  });

  it('统计推理选能力最强的，不在意成本', () => {
    const result = route({
      models: all,
      profile: profileOf('stats.reason', {
        estimatedInputTokens: 5000,
        expectedOutputTokens: 2000,
      }),
      explorationRate: 0,
    });
    expect(result.decision.chosenModelId).toBe('deepseek-v4-pro');
  });

  it('超长输入时本地模型因窗口不足被排除', () => {
    const result = route({
      models: all,
      profile: profileOf('pdf.deepread', {
        estimatedInputTokens: 200_000,
        expectedOutputTokens: 4000,
      }),
      explorationRate: 0,
    });
    expect(result.decision.excluded.map((e) => e.modelId)).toContain('qwen3:8b');
    expect(result.decision.chosenModelId).toMatch(/^deepseek/);
  });

  it('要求不用于训练时只剩本地模型', () => {
    const result = route({
      models: all,
      profile: profileOf('manuscript.draft', {
        requireTrainingOptOut: true,
        estimatedInputTokens: 3000,
        expectedOutputTokens: 2000,
      }),
      explorationRate: 0,
    });
    // DeepSeek 的策略标为 unknown，被排除
    expect(result.decision.chosenModelId).toBe('qwen3:8b');
    expect(result.decision.excluded.filter((e) => e.reason === 'policy-mismatch')).toHaveLength(2);
  });

  it('committee 能凑出跨厂商组合', () => {
    const result = route({ models: all, profile: profileOf('stats.reason'), explorationRate: 0 });
    const committee = selectCommittee(result.ranked, 2);
    expect(committee.vendorCount).toBe(2);
    expect(committee.degradedReason).toBeNull();
  });

  it('Reviewer 能找到异厂商模型审查 DeepSeek 的输出', () => {
    const result = route({ models: all, profile: profileOf('reviewer.audit'), explorationRate: 0 });
    const pick = pickCrossVendor(result.ranked, 'deepseek');
    expect(pick.model?.providerId).toBe('ollama');
    expect(pick.degradedReason).toBeNull();
  });

  it('只有 DeepSeek 时 Reviewer 明确报降级', () => {
    const result = route({
      models: [dsFlash, dsPro],
      profile: profileOf('reviewer.audit'),
      explorationRate: 0,
    });
    const pick = pickCrossVendor(result.ranked, 'deepseek');
    expect(pick.degradedReason).not.toBeNull();
  });
});

describe('本地偏好的边界（preferLocal 是偏好而非强制）', () => {
  const cloud = model({ id: 'cloud', providerId: 'deepseek', strengths: flatStrengths(72) });

  it('能力差距在一个档位内时选本地', () => {
    const decentLocal = model({
      id: 'local-decent',
      providerId: 'ollama',
      local: true,
      strengths: flatStrengths(50),
      pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
    });
    const result = route({
      models: [cloud, decentLocal],
      profile: profileOf('stats.reason', { preferLocal: true }),
      explorationRate: 0,
    });
    expect(result.decision.chosenModelId).toBe('local-decent');
  });

  it('本地模型差太多时仍然不选它', () => {
    // 「偏好」不等于「无论多差都用」——后者会在需要强推理的任务上产出垃圾
    const toyLocal = model({
      id: 'local-toy',
      providerId: 'ollama',
      local: true,
      strengths: flatStrengths(20),
      pricing: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
    });
    const result = route({
      models: [cloud, toyLocal],
      profile: profileOf('stats.reason', { preferLocal: true }),
      explorationRate: 0,
    });
    expect(result.decision.chosenModelId).toBe('cloud');
  });

  it('需要绝对强制时用 forcedModelId', () => {
    const toyLocal = model({
      id: 'local-toy',
      providerId: 'ollama',
      local: true,
      strengths: flatStrengths(20),
    });
    const result = route({
      models: [cloud, toyLocal],
      profile: profileOf('stats.reason'),
      forcedModelId: 'local-toy',
    });
    expect(result.decision.chosenModelId).toBe('local-toy');
  });
});

describe('发送路径诚实性', () => {
  it('UI 与路由注释都不声称委员会会在发送时执行', () => {
    // Given: 发送只会跑主模型；committee / escalation 不是执行策略
    // When: 读 RoutingPanel 文案与 router 模块注释
    // Then: UI 仍写明不会自动连发；注释用「仅预览」钉住 planner-only
    const panel = readFileSync(join('packages', 'ui', 'src', 'components', 'RoutingPanel.tsx'), 'utf8');
    const router = readFileSync(join('packages', 'core', 'src', 'router', 'index.ts'), 'utf8');
    expect(panel).toContain('不会自动连发');
    expect(router).toContain('仅预览');
    expect(router).not.toContain('三种执行策略');
  });
});
