/**
 * Plan Engine 测试（任务 12.5，需求 10.1-10.4）。
 *
 * 重点在校验：计划的价值是「用户能在执行前看懂并批准」，而一个绑到不存在能力上的
 * 计划让用户批准的是一个做不到的承诺。因此每一类落空都必须在生成时被拦住，
 * 而不是执行到那一步才失败。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  PlanRepo,
  PlanSpecError,
  findSuspectValues,
  parsePlanSpec,
  planBatches,
  planExecutable,
  planStepId,
  renderPlan,
  validatePlan,
  type PlanSpec,
  type PlanStepSpec,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 结构解析
 * ------------------------------------------------------------------ */

const step = (over: Partial<PlanStepSpec> & { ref: string }): Record<string, unknown> => ({
  phase: 1,
  title: `步骤 ${over.ref}`,
  description: '做点什么。',
  ...over,
});

const rawPlan = (steps: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => ({
  goal: '弄清老年人慢波与记忆的关系',
  steps,
});

describe('计划解析', () => {
  it('解析最小计划并补出阶段', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 's1' }), step({ ref: 's2', phase: 2 })]));
    expect(spec.steps).toHaveLength(2);
    // 阶段标题可省略：省略时按出现的阶段号补出来
    expect(spec.phases.map((p) => p.phase)).toEqual([1, 2]);
    expect(spec.phases[0]?.title).toBe('阶段 1');
  });

  it('保留显式给出的阶段标题', () => {
    const spec = parsePlanSpec({
      ...rawPlan([step({ ref: 's1' })]),
      phases: [{ phase: 1, title: '数据准备' }],
    });
    expect(spec.phases[0]?.title).toBe('数据准备');
  });

  it('默认值：retrieval 假、delegation 空、数组空', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 's1' })]));
    expect(spec.steps[0]).toMatchObject({
      retrieval: false,
      delegation: null,
      tools: [],
      produces: [],
      dependsOn: [],
      skillSlug: null,
    });
  });

  it('委派默认阻塞', () => {
    // 「转后台」必须是显式选择，否则用户中断之后仍有东西在跑而他以为停了
    const spec = parsePlanSpec(rawPlan([step({ ref: 's1', delegation: { parallel: true } })]));
    expect(spec.steps[0]?.delegation).toMatchObject({ parallel: true, blocking: true });
  });

  it('ref 重复直接报错', () => {
    // 重复 ref 会让 dependsOn 指向不确定的那一步，而这个歧义没有地方会报
    expect(() => parsePlanSpec(rawPlan([step({ ref: 's1' }), step({ ref: 's1' })]))).toThrow(
      /ref 重复/,
    );
  });

  it('ref 含非法字符报错', () => {
    expect(() => parsePlanSpec(rawPlan([step({ ref: '../x' })]))).toThrow(PlanSpecError);
  });

  it('空 steps 报错', () => {
    expect(() => parsePlanSpec(rawPlan([]))).toThrow(/至少要有一步/);
  });

  it('goal 为空报错', () => {
    expect(() => parsePlanSpec({ goal: '  ', steps: [step({ ref: 's1' })] })).toThrow(
      PlanSpecError,
    );
  });

  it('phase 非正整数报错', () => {
    expect(() => parsePlanSpec(rawPlan([step({ ref: 's1', phase: 0 })]))).toThrow(PlanSpecError);
  });
});

/* ------------------------------------------------------------------ *
 * 批次划分
 * ------------------------------------------------------------------ */

describe('执行批次', () => {
  it('无依赖的同阶段步骤在同一批次', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 'a' }), step({ ref: 'b' })]));
    const batches = planBatches(spec);
    expect(batches).toHaveLength(1);
    expect(batches?.[0]?.map((s) => s.ref)).toEqual(['a', 'b']);
  });

  it('有依赖的步骤排到后续批次', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 'a' }), step({ ref: 'b', dependsOn: ['a'] })]));
    const batches = planBatches(spec);
    expect(batches?.map((b) => b.map((s) => s.ref))).toEqual([['a'], ['b']]);
  });

  it('阶段之间不并行', () => {
    // 阶段是用户可见的推进单位，跨阶段并行会让「现在做到第几阶段」失去意义
    const spec = parsePlanSpec(rawPlan([step({ ref: 'a' }), step({ ref: 'b', phase: 2 })]));
    expect(planBatches(spec)?.map((b) => b.map((s) => s.ref))).toEqual([['a'], ['b']]);
  });

  it('成环时返回 null', () => {
    const spec = parsePlanSpec(
      rawPlan([step({ ref: 'a', dependsOn: ['b'] }), step({ ref: 'b', dependsOn: ['a'] })]),
    );
    expect(planBatches(spec)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

describe('计划校验（需求 10.2）', () => {
  const base = {
    availableSkills: new Set(['sleep-staging', 'spectral-analysis']),
    availableTools: new Set(['python', 'read_file', 'save_artifacts']),
  };

  const check = (steps: ReadonlyArray<Record<string, unknown>>, over = {}) =>
    validatePlan({ spec: parsePlanSpec(rawPlan(steps)), ...base, ...over });

  it('合法计划无问题', () => {
    const issues = check([
      step({ ref: 'a', skillSlug: 'sleep-staging', tools: ['python'], produces: ['hypno.csv'] }),
      step({ ref: 'b', dependsOn: ['a'], tools: ['save_artifacts'], produces: ['fig.pdf'] }),
    ]);
    expect(issues, JSON.stringify(issues)).toHaveLength(0);
  });

  it('绑定不存在的技能是错误，并给出最相近的候选', () => {
    const issues = check([step({ ref: 'a', skillSlug: 'sleep-stageing' })]);
    const issue = issues.find((i) => i.code === 'unknown-skill');
    expect(issue?.severity).toBe('error');
    // 「技能不存在」只说了症状，「最相近的是 sleep-staging」才能让模型自己改对
    expect(issue?.remediation).toContain('sleep-staging');
  });

  it('绑定被禁用的技能与绑定不存在的技能分开报', () => {
    const issues = check([step({ ref: 'a', skillSlug: 'hrv-analysis' })], {
      disabledSkills: new Set(['hrv-analysis']),
    });
    expect(issues[0]?.code).toBe('disabled-skill');
    expect(issues[0]?.remediation).toContain('重新启用');
  });

  it('技能依赖未满足是警告而非错误', () => {
    // 依赖能补齐，计划本身没错；拦掉它会让用户连计划都看不到
    const issues = check([step({ ref: 'a', skillSlug: 'sleep-staging' })], {
      skillsWithMissingRequirements: new Map([['sleep-staging', '  · yasa → pip install yasa']]),
    });
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'skill-requirements-missing' });
    expect(issues[0]?.remediation).toContain('pip install yasa');
    expect(issues[0]?.message).toContain('yasa');
  });

  it('声明未注册的工具是错误', () => {
    const issues = check([step({ ref: 'a', tools: ['matlab'] })]);
    const issue = issues.find((i) => i.code === 'unknown-tool');
    expect(issue?.severity).toBe('error');
    expect(issue?.remediation).toContain('python');
  });

  it('依赖不存在的步骤是错误', () => {
    const issues = check([step({ ref: 'a', dependsOn: ['nope'] })]);
    expect(issues.find((i) => i.code === 'unknown-dependency')?.severity).toBe('error');
  });

  it('自依赖是错误', () => {
    const issues = check([step({ ref: 'a', dependsOn: ['a'] })]);
    expect(issues.some((i) => i.code === 'dependency-cycle')).toBe(true);
  });

  it('成环时报出具体的环', () => {
    const issues = check([
      step({ ref: 'a', dependsOn: ['c'] }),
      step({ ref: 'b', dependsOn: ['a'] }),
      step({ ref: 'c', dependsOn: ['b'] }),
    ]);
    const cycle = issues.find((i) => i.code === 'dependency-cycle');
    expect(cycle?.severity).toBe('error');
    // 「存在环」没用，报出是哪个环才能改
    expect(cycle?.message).toMatch(/→/);
  });

  it('依赖后面阶段的产物是错误', () => {
    const issues = check([
      step({ ref: 'a', phase: 1, dependsOn: ['b'] }),
      step({ ref: 'b', phase: 2, produces: ['x'] }),
    ]);
    expect(issues.find((i) => i.code === 'cross-phase-dependency')?.severity).toBe('error');
  });

  it('被依赖的步骤没声明产物是警告', () => {
    const issues = check([step({ ref: 'a' }), step({ ref: 'b', dependsOn: ['a'] })]);
    const issue = issues.find((i) => i.code === 'no-produces');
    expect(issue?.severity).toBe('warning');
    // 写不出产物通常说明这一步实际什么都没交出去
    expect(issue?.remediation).toContain('交接');
  });

  it('标了并行但有同阶段依赖时给警告', () => {
    const issues = check([
      step({ ref: 'a', produces: ['x'] }),
      step({ ref: 'b', dependsOn: ['a'], delegation: { parallel: true } }),
    ]);
    expect(issues.find((i) => i.code === 'parallel-with-dependency')?.severity).toBe('warning');
  });

  it('后段的孤立步骤给警告', () => {
    const issues = check([step({ ref: 'a' }), step({ ref: 'b', phase: 2 })]);
    expect(issues.find((i) => i.code === 'orphan-dependency')?.stepRef).toBe('b');
  });

  it('planExecutable 只看 error 级', () => {
    expect(
      planExecutable([
        { severity: 'warning', code: 'no-produces', stepRef: null, message: '', remediation: '' },
      ]),
    ).toBe(true);
    expect(
      planExecutable([
        { severity: 'error', code: 'unknown-tool', stepRef: null, message: '', remediation: '' },
      ]),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 硬编码数值（需求 10.3）
 * ------------------------------------------------------------------ */

describe('硬编码数值检测（需求 10.3）', () => {
  it('抓出带单位的阈值', () => {
    const found = findSuspectValues('用 75 µV 作为慢波峰峰值下限');
    expect(found.map((f) => f.value)).toContain('75 µV');
  });

  it('抓出频段边界与时长判据', () => {
    expect(findSuspectValues('带通 0.3-35 Hz').length).toBeGreaterThan(0);
    expect(findSuspectValues('持续至少 10 秒').length).toBeGreaterThan(0);
  });

  it('抓出阈值语境里的裸数值', () => {
    expect(findSuspectValues('把判据设为 20').length).toBeGreaterThan(0);
  });

  it('不抓方法学选择里的普通数字', () => {
    // 「分 5 折」「置换 1000 次」是本次的方法学选择，不是需要查证的领域事实。
    // 把它们也报出来会让警告失去意义
    expect(findSuspectValues('做 5 折交叉验证，重复 1000 次置换')).toHaveLength(0);
    expect(findSuspectValues('纳入 44 名被试并分成两组')).toHaveLength(0);
  });

  const base = {
    availableSkills: new Set(['sleep-staging']),
    availableTools: new Set(['python']),
  };

  it('数值步骤没有取证前置时报警告', () => {
    const issues = validatePlan({
      spec: parsePlanSpec(
        rawPlan([step({ ref: 'a', description: '用 75 µV 作为慢波幅度阈值检测慢波' })]),
      ),
      ...base,
    });
    const issue = issues.find((i) => i.code === 'hardcoded-value');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('75 µV');
    expect(issue?.remediation).toContain('retrieval');
  });

  it('依赖链上有取证步骤时不再报', () => {
    const issues = validatePlan({
      spec: parsePlanSpec(
        rawPlan([
          step({
            ref: 'q',
            retrieval: true,
            description: '从 AASM 手册确认慢波幅度判据',
            produces: ['thresholds.json'],
          }),
          step({ ref: 'a', dependsOn: ['q'], description: '用 75 µV 作为慢波幅度阈值检测慢波' }),
        ]),
      ),
      ...base,
    });
    expect(issues.some((i) => i.code === 'hardcoded-value')).toBe(false);
  });

  it('取证步骤跨一层间接依赖也算', () => {
    // 常见形态是「查阈值 → 整理成参数表 → 用参数表跑分析」
    const issues = validatePlan({
      spec: parsePlanSpec(
        rawPlan([
          step({ ref: 'q', retrieval: true, description: '查判据', produces: ['raw.json'] }),
          step({
            ref: 'm',
            dependsOn: ['q'],
            description: '整理成参数表',
            produces: ['params.json'],
          }),
          step({ ref: 'a', dependsOn: ['m'], description: '按 75 µV 阈值检测' }),
        ]),
      ),
      ...base,
    });
    expect(issues.some((i) => i.code === 'hardcoded-value')).toBe(false);
  });

  it('取证步骤本身出现数值不报', () => {
    const issues = validatePlan({
      spec: parsePlanSpec(
        rawPlan([step({ ref: 'q', retrieval: true, description: '确认阈值是否为 75 µV' })]),
      ),
      ...base,
    });
    expect(issues.some((i) => i.code === 'hardcoded-value')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

describe('计划渲染', () => {
  it('含目标、阶段、步骤、依赖与产出', () => {
    const spec = parsePlanSpec({
      ...rawPlan([
        step({ ref: 'a', skillSlug: 'sleep-staging', tools: ['python'], produces: ['hypno.csv'] }),
        step({ ref: 'b', dependsOn: ['a'], retrieval: true }),
      ]),
      phases: [{ phase: 1, title: '准备' }],
    });
    const text = renderPlan(spec);
    expect(text).toContain('弄清老年人慢波与记忆的关系');
    expect(text).toContain('阶段 1：准备');
    expect(text).toContain('技能 sleep-staging');
    expect(text).toContain('依赖：a');
    expect(text).toContain('产出：hypno.csv');
    expect(text).toContain('取证步骤');
    // 批次信息要给出来，否则执行器只能退回顺序执行
    expect(text).toContain('执行批次');
  });
});

/* ------------------------------------------------------------------ *
 * 仓储
 * ------------------------------------------------------------------ */

describe('PlanRepo', () => {
  let root: string;
  let store: AppStore;
  let repo: PlanRepo;
  let conversationId: string;

  const spec = (): PlanSpec =>
    parsePlanSpec(
      rawPlan([
        step({ ref: 'a', produces: ['x.csv'] }),
        step({ ref: 'b', phase: 2, dependsOn: ['a'] }),
      ]),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-plan-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: '计划测试' });
    const project = store.openProject(created.id);
    conversationId = project.conversations.create({}).id;
    repo = new PlanRepo(project.db);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('创建后状态是草稿，步骤全部 pending', () => {
    // 未经用户批准不执行（需求 10.4）
    const plan = repo.create({ conversationId, spec: spec() });
    expect(plan.status).toBe('draft');
    expect(repo.steps(plan.id).every((s) => s.status === 'pending')).toBe(true);
  });

  it('步骤主键可反解出 ref', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    const step0 = repo.step(plan.id, 'a');
    expect(step0?.id).toBe(planStepId(plan.id, 'a'));
    expect(step0?.ref).toBe('a');
  });

  it('阶段内 seq 从 1 开始各自计数', () => {
    const plan = repo.create({
      conversationId,
      spec: parsePlanSpec(
        rawPlan([step({ ref: 'a' }), step({ ref: 'b' }), step({ ref: 'c', phase: 2 })]),
      ),
    });
    const steps = repo.steps(plan.id);
    expect(steps.filter((s) => s.phase === 1).map((s) => s.seq)).toEqual([1, 2]);
    expect(steps.filter((s) => s.phase === 2).map((s) => s.seq)).toEqual([1]);
  });

  it('更新步骤状态与产出', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    expect(
      repo.setStepStatus({ planId: plan.id, ref: 'a', status: 'done', resultRef: 'av_123' }),
    ).toBe(true);
    expect(repo.step(plan.id, 'a')).toMatchObject({ status: 'done', resultRef: 'av_123' });
  });

  it('进度摘要给出当前阶段', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    repo.setStepStatus({ planId: plan.id, ref: 'a', status: 'done' });
    const p = repo.progress(plan.id);
    expect(p).toMatchObject({ total: 2 });
    expect(p.byStatus.done).toBe(1);
    // 当前阶段 = 最小的还有未完成步骤的阶段
    expect(p.currentPhase).toBe(2);
  });

  it('全部终结后当前阶段为 null', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    repo.setStepStatus({ planId: plan.id, ref: 'a', status: 'done' });
    repo.setStepStatus({ planId: plan.id, ref: 'b', status: 'skipped' });
    expect(repo.progress(plan.id).currentPhase).toBeNull();
  });

  it('活跃计划只取草稿/已批准/执行中', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    expect(repo.activeOf(conversationId)?.id).toBe(plan.id);
    repo.setStatus(plan.id, 'done');
    expect(repo.activeOf(conversationId)).toBeNull();
  });

  it('草稿状态下可替换本体', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    const next = parsePlanSpec(rawPlan([step({ ref: 'only' })]));
    expect(repo.replaceSpec(plan.id, next)).toEqual({ ok: true });
    expect(repo.steps(plan.id).map((s) => s.ref)).toEqual(['only']);
  });

  it('非草稿状态拒绝替换本体', () => {
    // 执行中改计划会让已完成的步骤与新步骤集合对不上，而那个问题没有好答案
    const plan = repo.create({ conversationId, spec: spec() });
    repo.setStatus(plan.id, 'executing');
    const result = repo.replaceSpec(plan.id, spec());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('executing');
  });

  it('替换后旧步骤的状态被清掉', () => {
    const plan = repo.create({ conversationId, spec: spec() });
    repo.setStepStatus({ planId: plan.id, ref: 'a', status: 'done' });
    repo.replaceSpec(plan.id, parsePlanSpec(rawPlan([step({ ref: 'a' })])));
    expect(repo.step(plan.id, 'a')?.status).toBe('pending');
  });

  it('按会话列出，最新在前', () => {
    const first = repo.create({ conversationId, spec: spec() });
    repo.setStatus(first.id, 'rejected');
    const second = repo.create({ conversationId, spec: spec() });
    expect(repo.byConversation(conversationId).map((p) => p.id)[0]).toBe(second.id);
  });

  it('委派设置随步骤落库', () => {
    const plan = repo.create({
      conversationId,
      spec: parsePlanSpec(
        rawPlan([step({ ref: 'a', delegation: { parallel: true, blocking: false } })]),
      ),
    });
    expect(repo.step(plan.id, 'a')?.delegation).toMatchObject({
      parallel: true,
      blocking: false,
    });
  });
});

describe('同毫秒创建的排序', () => {
  /*
   * 这条曾经是个真问题：两个计划落在同一毫秒时（拒绝一版后立刻重新生成恰好如此），
   * 按 UUID 排序的结果是任意的，界面上「最新在前」会显示成旧的那一版。
   * 次级排序改用 rowid（插入顺序）之后才是确定的。
   */
  let root: string;
  let store: AppStore;
  let repo: PlanRepo;
  let conversationId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-plan-ord-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: '排序' });
    const project = store.openProject(created.id);
    conversationId = project.conversations.create({}).id;
    repo = new PlanRepo(project.db);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('连续创建十个计划，列出顺序严格是插入的逆序', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 's1' })]));
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const plan = repo.create({ conversationId, spec });
      repo.setStatus(plan.id, 'rejected');
      ids.push(plan.id);
    }

    expect(repo.byConversation(conversationId, 10).map((p) => p.id)).toEqual([...ids].reverse());
  });

  it('活跃计划取的是最后创建的那个', () => {
    const spec = parsePlanSpec(rawPlan([step({ ref: 's1' })]));
    repo.create({ conversationId, spec });
    const second = repo.create({ conversationId, spec });
    expect(repo.activeOf(conversationId)?.id).toBe(second.id);
  });
});
