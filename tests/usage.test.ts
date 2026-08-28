/**
 * 用量与路由记录测试（任务 11.10，需求 18）。
 *
 * 重点在需求 18.5：可观测性数据里不留凭据、不留完整请求正文。这类数据留存久、
 * 易导出、常被贴进 issue，是凭据泄漏最容易发生的地方。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RoutingDecision } from '@l-science/shared';
import {
  AppStore,
  RoutingRepo,
  SIGNAL_WEIGHT,
  UsageRepo,
  classifyFailure,
  experienceKey,
  redactError,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let usage: UsageRepo;
let routing: RoutingRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-usage-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '用量测试' });
  project = store.openProject(created.id);
  usage = new UsageRepo(project.db);
  routing = new RoutingRepo(project.db);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (overrides: Partial<Parameters<UsageRepo['record']>[0]> = {}) => ({
  conversationId: 'conv-1',
  providerId: 'deepseek',
  modelId: 'deepseek-v4-flash',
  tokensIn: 100,
  tokensOut: 50,
  cost: 0.0001,
  latencyMs: 500,
  status: 'ok' as const,
  ...overrides,
});

describe('凭据脱敏（需求 18.5）', () => {
  it('替换 OpenAI 风格的 key', () => {
    const result = redactError('Invalid API key: sk-6eec112511df4d65bd0e7dcec0fbe24a');
    expect(result).not.toContain('sk-6eec1125');
    expect(result).toContain('已脱敏');
  });

  it('替换 Anthropic 风格的 key', () => {
    const result = redactError('auth failed for sk-ant-api03-AbCdEfGhIjKlMnOpQrSt');
    expect(result).not.toContain('AbCdEfGh');
  });

  it('替换 Authorization 头', () => {
    const result = redactError('request: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9abcdefgh');
  });

  it('替换 JWT', () => {
    const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`;
    expect(redactError(`token=${jwt}`)).not.toContain(jwt);
  });

  it('替换 Google 与 Groq 风格的 key', () => {
    expect(redactError(`key=AIza${'B'.repeat(35)}`)).not.toContain('AIzaB');
    expect(redactError(`key=gsk_${'C'.repeat(25)}`)).not.toContain('gsk_CCC');
  });

  it('一条消息里的多个凭据都被替换', () => {
    const result = redactError('first sk-aaaaaaaaaaaaaaaaaaa then sk-bbbbbbbbbbbbbbbbbbb');
    expect(result).not.toContain('sk-aaa');
    expect(result).not.toContain('sk-bbb');
  });

  it('截断超长错误并说明原因', () => {
    /*
     * 供应商在 400 响应里回显整个请求是常见行为，而那份正文可能包含用户的
     * 原始数据。一条两万字的错误消息里有用的信息几乎总在开头。
     */
    const result = redactError('x'.repeat(50_000));
    expect(result?.length).toBeLessThan(3000);
    expect(result).toContain('回显请求正文');
    expect(result).toContain('50000');
  });

  it('正常长度的错误原样保留', () => {
    expect(redactError('model not found')).toBe('model not found');
  });

  it('空值归一为 null', () => {
    expect(redactError(null)).toBeNull();
    expect(redactError(undefined)).toBeNull();
    expect(redactError('')).toBeNull();
  });

  it('落盘的记录里不含凭据', () => {
    // 在写入前脱敏而不是读取时——读取时脱敏意味着敏感内容已经落盘，
    // 而落盘的东西会被备份、导出、贴进 issue
    usage.record(
      call({ status: 'auth-failed', error: 'bad key sk-6eec112511df4d65bd0e7dcec0fbe24a' }),
    );

    const raw = project.db.prepare('SELECT error FROM egress_log').get() as { error: string };
    expect(raw.error).not.toContain('sk-6eec');
    expect(raw.error).toContain('已脱敏');
  });
});

describe('失败分类（需求 18.3）', () => {
  it('按 HTTP 状态码分类', () => {
    expect(classifyFailure({ status: 401 })).toBe('auth-failed');
    expect(classifyFailure({ status: 403 })).toBe('auth-failed');
    expect(classifyFailure({ status: 408 })).toBe('timeout');
    expect(classifyFailure({ status: 429 })).toBe('rate-limited');
    expect(classifyFailure({ status: 500 })).toBe('server-error');
    expect(classifyFailure({ status: 503 })).toBe('server-error');
    expect(classifyFailure({ status: 400 })).toBe('bad-request');
  });

  it('中止与内容安全优先于状态码', () => {
    // 用户中断时可能同时有个 500 在飞，但「用户不想等了」是更准确的描述
    expect(classifyFailure({ status: 500, aborted: true })).toBe('aborted');
    expect(classifyFailure({ status: 400, isContentFilter: true })).toBe('content-filtered');
  });

  it('无状态码时按消息推断', () => {
    expect(classifyFailure({ message: 'request timed out' })).toBe('timeout');
    expect(classifyFailure({ message: 'connect ECONNREFUSED' })).toBe('network-error');
    expect(classifyFailure({ message: 'fetch failed' })).toBe('network-error');
  });

  it('认不出时归到 unknown 而不是猜一个', () => {
    // 猜错的分类会让降级链分析得出错误结论
    expect(classifyFailure({ message: '某种没见过的错误' })).toBe('unknown-error');
    expect(classifyFailure({})).toBe('unknown-error');
  });

  it('限流与凭据错误是两类，运维动作不同', () => {
    // 前者说明该换供应商分摊，后者说明配置有问题
    expect(classifyFailure({ status: 429 })).not.toBe(classifyFailure({ status: 401 }));
  });
});

describe('记录与汇总（需求 18.1、18.2）', () => {
  it('记录全部必需字段', () => {
    usage.record(call());
    const recent = usage.recent();
    expect(recent[0]).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      tokensIn: 100,
      tokensOut: 50,
      cost: 0.0001,
      latencyMs: 500,
      status: 'ok',
    });
    expect(recent[0]?.ts).toBeGreaterThan(0);
  });

  it('按会话汇总', () => {
    usage.record(call({ conversationId: 'a', cost: 0.001 }));
    usage.record(call({ conversationId: 'a', cost: 0.002 }));
    usage.record(call({ conversationId: 'b', cost: 0.005 }));

    const a = usage.byConversation('a');
    expect(a.calls).toBe(2);
    expect(a.cost).toBeCloseTo(0.003, 10);
    expect(a.tokensIn).toBe(200);
  });

  it('按项目汇总含全部会话', () => {
    usage.record(call({ conversationId: 'a', cost: 0.001 }));
    usage.record(call({ conversationId: 'b', cost: 0.005 }));
    expect(usage.byProject().calls).toBe(2);
    expect(usage.byProject().cost).toBeCloseTo(0.006, 10);
  });

  it('按时间区间过滤', () => {
    usage.record(call());
    const now = Date.now();

    // 未来的区间应为空
    expect(usage.byProject({ from: now + 10_000 }).calls).toBe(0);
    // 过去到现在应包含
    expect(usage.byProject({ from: now - 10_000, to: now + 10_000 }).calls).toBe(1);
  });

  it('区分成功与失败次数', () => {
    usage.record(call());
    usage.record(call({ status: 'rate-limited', cost: 0 }));
    usage.record(call({ status: 'server-error', cost: 0 }));

    const summary = usage.byProject();
    expect(summary.calls).toBe(3);
    expect(summary.succeeded).toBe(1);
  });

  it('延迟用中位数而不是均值', () => {
    /*
     * 一次 30 秒的超时会把一百次 500ms 的均值拉到 800ms，而那个数字既不代表
     * 典型体验也不代表最坏情况。
     */
    for (const latencyMs of [100, 200, 300, 400, 30_000]) {
      usage.record(call({ latencyMs }));
    }
    const median = usage.byProject().medianLatencyMs;
    expect(median).toBe(300);
    // 均值会是 6200，中位数不受那个离群值影响
    expect(median).toBeLessThan(1000);
  });

  it('空表的汇总是零而不是报错', () => {
    expect(usage.byProject()).toMatchObject({ calls: 0, cost: 0, medianLatencyMs: 0 });
  });

  it('按模型分组，按成本降序', () => {
    usage.record(call({ modelId: 'cheap', cost: 0.0001 }));
    usage.record(call({ modelId: 'pricey', cost: 0.01 }));
    usage.record(call({ modelId: 'pricey', cost: 0.02 }));

    const byModel = usage.byModel();
    expect(byModel[0]?.modelId).toBe('pricey');
    expect(byModel[0]?.calls).toBe(2);
    expect(byModel[0]?.cost).toBeCloseTo(0.03, 10);
  });

  it('失败分布带上最近一次错误', () => {
    usage.record(call({ status: 'rate-limited', error: '第一次限流' }));
    usage.record(call({ status: 'rate-limited', error: '第二次限流' }));
    usage.record(call({ status: 'auth-failed', error: 'key 无效' }));

    const failures = usage.failures();
    const rateLimited = failures.find((f) => f.status === 'rate-limited');
    expect(rateLimited?.count).toBe(2);
    expect(rateLimited?.lastError).toContain('限流');

    // 成功的调用不进失败分布
    usage.record(call());
    expect(usage.failures().some((f) => f.status === 'ok')).toBe(false);
  });

  it('按天汇总', () => {
    usage.record(call({ cost: 0.001 }));
    usage.record(call({ cost: 0.002 }));

    const daily = usage.daily();
    expect(daily).toHaveLength(1);
    expect(daily[0]?.calls).toBe(2);
    expect(daily[0]?.cost).toBeCloseTo(0.003, 10);
    expect(daily[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recent 最新在前且有上限', () => {
    for (let i = 0; i < 5; i += 1) usage.record(call({ tokensIn: i }));
    const recent = usage.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.tokensIn).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * 路由决策与反馈
 * ------------------------------------------------------------------ */

const decision = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
  id: `rd_${Math.random().toString(36).slice(2, 10)}`,
  taskType: 'stats.reason',
  chosenModelId: 'deepseek-v4-pro',
  scores: [
    { modelId: 'deepseek-v4-pro', total: 80, breakdown: { 能力得分: 83 } },
    { modelId: 'deepseek-v4-flash', total: 70, breakdown: { 能力得分: 72 } },
  ],
  excluded: [{ modelId: 'qwen3:4b', reason: 'context-too-small' }],
  reason: '选中 pro，差距主要来自能力得分',
  createdAt: Date.now(),
  ...overrides,
});

describe('决策落库（需求 7.6、18.3）', () => {
  it('写入后可完整读回', () => {
    const d = decision();
    routing.record(d, { conversationId: 'conv-1', messageId: 'msg-1' });

    const loaded = routing.get(d.id);
    expect(loaded).toMatchObject({
      id: d.id,
      taskType: 'stats.reason',
      chosenModelId: 'deepseek-v4-pro',
      reason: d.reason,
    });
    expect(loaded?.scores).toHaveLength(2);
    expect(loaded?.excluded[0]).toMatchObject({ modelId: 'qwen3:4b' });
  });

  it('重复写同一 id 不报错', () => {
    const d = decision();
    routing.record(d);
    expect(() => routing.record(d)).not.toThrow();
  });

  it('按会话取历史，最新在前', () => {
    routing.record(decision({ createdAt: 1000 }), { conversationId: 'c1' });
    routing.record(decision({ createdAt: 2000 }), { conversationId: 'c1' });
    routing.record(decision({ createdAt: 3000 }), { conversationId: 'c2' });

    const history = routing.byConversation('c1');
    expect(history).toHaveLength(2);
    expect(history[0]?.createdAt).toBe(2000);
  });

  it('降级决策保留 fallbackOf 关联', () => {
    const original = decision();
    routing.record(original);
    const fallback = decision({ fallbackOf: original.id, chosenModelId: 'deepseek-v4-flash' });
    routing.record(fallback);

    expect(routing.get(fallback.id)?.fallbackOf).toBe(original.id);
  });

  it('损坏的 JSON 不让整条记录读不出来', () => {
    const d = decision();
    routing.record(d);
    project.db.prepare("UPDATE routing_decisions SET score_json = 'broken' WHERE id = ?").run(d.id);

    // 得分读不出来，但决策本身与选中的模型仍然可查——那是最关键的信息
    const loaded = routing.get(d.id);
    expect(loaded?.chosenModelId).toBe('deepseek-v4-pro');
    expect(loaded?.scores).toEqual([]);
  });

  it('不存在的 id 返回 null', () => {
    expect(routing.get('rd_nope')).toBeNull();
  });
});

describe('反馈信号与经验修正（需求 7.11）', () => {
  it('按信号类型使用预设权重', () => {
    const d = decision();
    routing.record(d);
    routing.addSignal(d.id, 'accepted', 'user');

    const feedback = routing.feedbackOf(d.id);
    expect(feedback[0]).toMatchObject({
      signal: 'accepted',
      value: SIGNAL_WEIGHT.accepted,
      source: 'user',
    });
  });

  it('Reviewer 发现的权重最高', () => {
    /*
     * 它是独立审查发现的实质问题，比用户的即时反应可靠得多——用户可能因为答案
     * 「读起来顺」而接受一个统计用法错误的结论。
     */
    expect(Math.abs(SIGNAL_WEIGHT['reviewer-finding'])).toBeGreaterThanOrEqual(
      Math.abs(SIGNAL_WEIGHT.retried),
    );
  });

  it('编辑的负权重有限', () => {
    // 用户编辑输出是正常的写作过程。当强负信号会让路由偏向「输出短、
    // 不给用户可改的东西」的模型
    expect(Math.abs(SIGNAL_WEIGHT.edited)).toBeLessThan(Math.abs(SIGNAL_WEIGHT.retried));
  });

  it('汇总成经验修正表，键与 experienceKey 一致', () => {
    const d = decision({ taskType: 'stats.reason', chosenModelId: 'model-a' });
    routing.record(d);
    routing.addSignal(d.id, 'accepted', 'user');

    const exp = routing.experience();
    const key = experienceKey('stats.reason', 'model-a');
    expect(exp.get(key)).toMatchObject({ value: 1, sampleCount: 1 });
  });

  it('按任务类型分组，不同任务的修正互不干扰', () => {
    /*
     * 一个模型在写作上好不代表在统计推理上也好。混在一起会让修正值互相抵消，
     * 最后趋近于零而失去作用。
     */
    const good = decision({ taskType: 'manuscript.draft', chosenModelId: 'model-a' });
    const bad = decision({ taskType: 'stats.reason', chosenModelId: 'model-a' });
    routing.record(good);
    routing.record(bad);
    routing.addSignal(good.id, 'accepted', 'user');
    routing.addSignal(bad.id, 'reviewer-finding', 'reviewer');

    const exp = routing.experience();
    expect(exp.get(experienceKey('manuscript.draft', 'model-a'))?.value).toBeGreaterThan(0);
    expect(exp.get(experienceKey('stats.reason', 'model-a'))?.value).toBeLessThan(0);
  });

  it('多条信号取均值并累计样本数', () => {
    const d1 = decision({ chosenModelId: 'model-a' });
    const d2 = decision({ chosenModelId: 'model-a' });
    routing.record(d1);
    routing.record(d2);
    routing.addSignal(d1.id, 'accepted', 'user'); // +1
    routing.addSignal(d2.id, 'retried', 'user'); // -0.8

    const adj = routing.experience().get(experienceKey('stats.reason', 'model-a'));
    expect(adj?.sampleCount).toBe(2);
    expect(adj?.value).toBeCloseTo((1 - 0.8) / 2, 6);
  });

  it('修正值夹在 -1 到 1 之间', () => {
    const d = decision({ chosenModelId: 'model-a' });
    routing.record(d);
    // 手工塞一个越界值
    routing.addFeedback({
      routingDecisionId: d.id,
      signal: 'accepted',
      value: 5,
      source: 'system',
    });

    const adj = routing.experience().get(experienceKey('stats.reason', 'model-a'));
    expect(adj?.value).toBe(1);
  });

  it('没有选中模型的决策不进经验表', () => {
    // chosenModelId 为 null 说明没有可用模型，那次失败不该归咎于任何模型
    const d = decision({ chosenModelId: null });
    routing.record(d);
    routing.addSignal(d.id, 'retried', 'user');
    expect(routing.experience().size).toBe(0);
  });

  it('删除决策时级联删除其反馈', () => {
    const d = decision();
    routing.record(d);
    routing.addSignal(d.id, 'accepted', 'user');
    project.db.prepare('DELETE FROM routing_decisions WHERE id = ?').run(d.id);
    expect(routing.feedbackOf(d.id)).toEqual([]);
  });
});
