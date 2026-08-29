/**
 * Memory Service 测试（任务 12.9，需求 16.1-16.4）。
 *
 * 三条重点：
 *
 * 1. **三层作用域真的分开存。** 全局与算力在应用库、项目在项目库——放错库的症状是
 *    「另一个项目也看到了这条记忆」或者「删了项目还剩一堆孤儿记忆」。
 * 2. **一次性细节进不来（需求 16.4）。** 这是这个模块唯一有难度的地方：拦得太松记忆
 *    会被具体数字填满，拦得太紧模型会放弃使用它。两个方向都要有用例。
 * 3. **注入有预算且按类别优先。** 纯按时间排序时，一条刚写的偏好会把影响分析正确性的
 *    约定挤出预算。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  MEMORY_LIMITS,
  MemoryRepo,
  MemoryService,
  buildSystemPrompt,
  classifyEnvironmentNote,
  classifyMemoryCandidate,
  createRecallMemoryTool,
  createRememberTool,
  environmentNoteGuidance,
  memoryGuidance,
  normalizeMemoryContent,
  type MemoryKind,
  type MemoryScope,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let projectId: string;
let repo: MemoryRepo;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-memory-'));
  store = AppStore.open(join(root, 'app'));
  const created = store.createProject({ name: '记忆测试' });
  projectId = created.id;
  project = store.openProject(created.id);
  repo = new MemoryRepo({ appDb: store.db, projectDb: project.db, projectId });
  service = new MemoryService({ repo, computeTargetExists: (id) => id === 'ct_cluster' });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 作用域与存储
 * ------------------------------------------------------------------ */

describe('MemoryRepo 作用域', () => {
  it('全局记忆存进应用库', () => {
    const { note } = repo.upsert({
      scope: 'global',
      kind: 'preference',
      content: '图表默认导出 300 dpi 的 PNG，并同时留一份矢量版。',
      reason: '投稿要求普遍是 300 dpi，每次问一遍是浪费。',
    });

    expect(note.scope).toBe('global');
    expect(note.scopeId).toBeNull();
    const row = store.db.prepare('SELECT scope FROM memory_notes WHERE id = ?').get(note.id);
    expect(row).toEqual({ scope: 'global' });
    // 项目库里不该有它
    expect(project.db.prepare('SELECT COUNT(*) AS n FROM memory_notes').get()).toEqual({ n: 0 });
  });

  it('项目记忆存进项目库并带上 projectId', () => {
    const { note } = repo.upsert({
      scope: 'project',
      kind: 'convention',
      content: '被试编号统一用 S01 到 S24，不带前导零之外的其他格式。',
      reason: '原始文件名就是这个格式，改写会与采集记录对不上。',
    });

    expect(note.scope).toBe('project');
    expect(note.scopeId).toBe(projectId);
    expect(project.db.prepare('SELECT COUNT(*) AS n FROM memory_notes').get()).toEqual({ n: 1 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM memory_notes').get()).toEqual({ n: 0 });
  });

  it('算力记忆必须指名目标', () => {
    expect(() =>
      repo.upsert({
        scope: 'compute',
        kind: 'environment',
        content: 'GPU 分区叫 gpu-v100，提交时要指定 --account=lab01。',
        reason: '不指定 account 会被调度器直接拒。',
      }),
    ).toThrow(/必须指定算力目标/);
  });

  it('算力记忆按目标隔离', () => {
    repo.upsert({
      scope: 'compute',
      scopeId: 'ct_a',
      kind: 'environment',
      content: 'A 集群的 GPU 分区叫 gpu-v100。',
      reason: '每次查一遍分区名很浪费。',
    });
    repo.upsert({
      scope: 'compute',
      scopeId: 'ct_b',
      kind: 'environment',
      content: 'B 集群的 GPU 分区叫 gpu-a100。',
      reason: '同上。',
    });

    // 不隔离的话「这个集群的分区叫 gpu」会被套到所有集群上
    expect(repo.list({ scope: 'compute', scopeId: 'ct_a' })).toHaveLength(1);
    expect(repo.list({ scope: 'compute', scopeId: 'ct_a' })[0]?.content).toContain('v100');
  });

  it('不带 scope 的 list 汇总两个库', () => {
    repo.upsert({
      scope: 'global',
      kind: 'preference',
      content: '统计结果要同时给效应量与置信区间。',
      reason: '期刊普遍要求，不给会被退回补。',
    });
    repo.upsert({
      scope: 'project',
      kind: 'background',
      content: '本项目的被试来自睡眠中心的连续入组队列，2023 至 2024 年。',
      reason: '写方法学部分每次都要交代来源。',
    });

    const all = repo.list();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((n) => n.scope))).toEqual(new Set(['global', 'project']));
  });

  it('按 id 读取会查两个库', () => {
    const g = repo.upsert({
      scope: 'global',
      kind: 'preference',
      content: '回复里先给结论再给过程。',
      reason: '先看结论能更快判断方向对不对。',
    }).note;
    const p = repo.upsert({
      scope: 'project',
      kind: 'data',
      content: 'EDF 文件的通道命名不统一，C3 有时写成 EEG C3-A2。',
      reason: '每次读数据都要处理这个，忘了就会漏通道。',
    }).note;

    expect(repo.get(g.id)?.scope).toBe('global');
    expect(repo.get(p.id)?.scope).toBe('project');
    expect(repo.get('mem_不存在')).toBeNull();
  });

  it('删除会查两个库', () => {
    const p = repo.upsert({
      scope: 'project',
      kind: 'decision',
      content: '本项目统一用线性混合效应模型而不是重复测量 ANOVA。',
      reason: '被试间缺失值多，ANOVA 会丢掉整条记录。',
    }).note;

    expect(repo.delete(p.id)).toBe(true);
    expect(repo.get(p.id)).toBeNull();
    expect(repo.delete(p.id)).toBe(false);
  });

  it('内容归一化后相同的写入更新既有条目而不是新增', () => {
    const first = repo.upsert({
      scope: 'global',
      kind: 'convention',
      content: '显著性阈值用 p < .05，并对多重比较做 FDR 校正。',
      reason: '统一口径。',
    });
    const second = repo.upsert({
      scope: 'global',
      kind: 'convention',
      content: '显著性阈值用 p < .05， 并对多重比较做 FDR 校正',
      reason: '再次确认。',
    });

    // 同一条约定被反复写入是最常见的记忆膨胀来源
    expect(second.created).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.note.id).toBe(first.note.id);
    expect(second.note.reason).toBe('再次确认。');
    expect(repo.count('global')).toBe(1);
  });

  it('replaceId 覆盖既有条目', () => {
    const first = repo.upsert({
      scope: 'project',
      kind: 'data',
      content: '数据放在 D 盘的 psg 目录下，按被试分子目录。',
      reason: '每次都要问路径。',
    }).note;

    const updated = repo.upsert({
      scope: 'project',
      kind: 'data',
      content: '数据已迁到 E 盘的 psg 目录，仍然按被试分子目录。',
      reason: 'D 盘空间不够，已经搬走了。',
      replaceId: first.id,
    });

    expect(updated.note.id).toBe(first.id);
    expect(updated.note.content).toContain('E 盘');
    expect(repo.count('project')).toBe(1);
  });

  it('replaceId 指向不存在的条目时抛错', () => {
    expect(() =>
      repo.upsert({
        scope: 'global',
        kind: 'preference',
        content: '这是一条足够长的内容用于测试。',
        reason: '测试。',
        replaceId: 'mem_不存在',
      }),
    ).toThrow(/不存在/);
  });

  it('写入必须有理由（需求 16.2）', () => {
    expect(() =>
      repo.upsert({
        scope: 'global',
        kind: 'preference',
        content: '这是一条足够长的内容用于测试。',
        reason: '   ',
      }),
    ).toThrow(/必须说明理由/);
  });

  it('没有项目库时项目作用域不可用', () => {
    const appOnly = new MemoryRepo({ appDb: store.db });
    expect(appOnly.hasProjectScope).toBe(false);
    expect(() =>
      appOnly.upsert({
        scope: 'project',
        kind: 'background',
        content: '一条足够长的项目背景说明。',
        reason: '测试。',
      }),
    ).toThrow(/没有项目上下文/);
  });

  it('给了 projectDb 却不给 projectId 直接拒绝构造', () => {
    // 空的 scopeId 会让 compute 与 project 两类记忆在 UI 上分不开
    expect(() => new MemoryRepo({ appDb: store.db, projectDb: project.db })).toThrow(/projectId/);
  });

  it('normalizeMemoryContent 去掉空白与标点', () => {
    expect(normalizeMemoryContent('用 p < .05，并做 FDR 校正。')).toBe(
      normalizeMemoryContent('用 p<.05 并做FDR校正'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 准入判定（需求 16.4）
 * ------------------------------------------------------------------ */

describe('classifyMemoryCandidate 放行', () => {
  const ok = (over: { scope?: MemoryScope; kind?: MemoryKind; content: string }) =>
    classifyMemoryCandidate({
      scope: over.scope ?? 'project',
      kind: over.kind ?? 'convention',
      content: over.content,
      reason: '这是一条足够具体的理由说明。',
    });

  it.each([
    ['术语约定', '被试编号统一用 S01 到 S24，事件标记 N2 指睡眠第二阶段。'],
    ['阈值约定（有阈值语境但没有观测值）', '显著性阈值用 p < .05，并对多重比较做 FDR 校正。'],
    ['方法决策', '本项目统一用线性混合效应模型，因为缺失值多而 ANOVA 会丢整条记录。'],
    ['数据布局', '原始 EDF 放在 E 盘 psg 目录，按被试分子目录，通道命名不统一。'],
    ['长期偏好', '图表默认导出 300 dpi PNG，同时保留一份矢量版。'],
    ['带具体编号的约定', '事件文件的第 3 列是时间戳，单位是秒，从记录开始计。'],
    ['置换次数这类方法学选择', '置换检验统一做 5000 次置换。'],
  ])('放行：%s', (_label, content) => {
    const verdict = ok({ content });
    expect(verdict.ok).toBe(true);
    expect(verdict.rule).toBeNull();
  });

  it('数据类必须是项目作用域', () => {
    expect(ok({ scope: 'global', kind: 'data', content: '数据在 E 盘 psg 目录下。' }).rule).toBe(
      'scope-mismatch',
    );
  });

  it('算力笔记只能用 compute 作用域', () => {
    expect(
      ok({ scope: 'project', kind: 'environment', content: 'GPU 分区叫 gpu-v100。' }).rule,
    ).toBe('scope-mismatch');
    expect(ok({ scope: 'compute', kind: 'environment', content: 'GPU 分区叫 gpu-v100。' }).ok).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 环境笔记的内容门（任务 14.3，需求 14.5）
 * ------------------------------------------------------------------ */

describe('环境笔记内容门（需求 14.5）', () => {
  const env = (content: string) => classifyEnvironmentNote(content);

  it('收各类真实的环境事实', () => {
    for (const content of [
      'gpu 分区最长 24 小时，long 分区要走管理员审批。',
      '记账账户是 lab-a，每月配额 5000 机时。',
      '/scratch 上的文件 30 天后被清理，家目录只有 20 GB。',
      '先 module load python/3.11 再 conda activate lsci，顺序反了会用到系统 python。',
      '不给 --time 会用默认 10 分钟然后被杀掉，报错里不会提到墙钟。',
      '要经跳板机 bastion 才连得上，直连不通。',
      '周三 8 点到 10 点例行维护，作业会被排空。',
      'sacct 没开，作业结束后查不到成败。',
      '数据放在 /scratch/eeg 下按被试编号分目录。',
      '登录节点上没有 GPU，nvidia-smi 只在计算节点上有输出。',
    ]) {
      expect(env(content).ok, content).toBe(true);
    }
  });

  it('研究内容被拒，并指向 project 作用域', () => {
    // 环境笔记跨项目共享：写进来之后，另一个研究方向完全不同的项目也会看到它
    for (const content of [
      '本研究的研究问题是睡眠剥夺是否影响工作记忆。',
      '实验设计是被试内设计，每人做两次。',
      '干预组做正念训练，对照组只做放松。',
      '用 PSQI 量表测睡眠质量。',
      '被试招募走学校的伦理审查流程。',
      '投稿目标是 Sleep，参考文献用 APA 格式。',
      '自变量是睡眠时长，因变量是反应时。',
    ]) {
      const verdict = env(content);
      expect(verdict.ok, content).toBe(false);
      expect(verdict.rule, content).toBe('project-content-in-environment-note');
      expect(verdict.reason, content).toContain('跨项目共享');
      // 拒绝要给出去处，否则模型只会放弃使用这个能力
      expect(verdict.reason, content).toContain('scope=project');
    }
  });

  it('没有任何环境信号的空话被拒', () => {
    // 黑名单挡不住这些：它们一个禁用词都没有
    for (const content of [
      '这台机器很好用，速度也快。',
      '以后优先用这个目标跑分析。',
      '整体来说没什么问题。',
    ]) {
      const verdict = env(content);
      expect(verdict.ok, content).toBe(false);
      expect(verdict.rule, content).toBe('not-environment-knowledge');
      expect(verdict.reason, content).toContain('环境笔记要落到具体的环境事实上');
    }
  });

  it('提到被试但说的是目录布局的，不该被误伤', () => {
    // 文件系统布局是环境知识里最有用的一类，为了挡「被试」这个词把它一起挡掉是过头的
    expect(env('/scratch/proj 下每个被试一个子目录，命名是 sub-01 这种。').ok).toBe(true);
  });

  it('统计结果先被通用规则挡住，建议指向数值而不是环境信号', () => {
    // 顺序反了的话，一条既有 p 值又不像环境知识的笔记会得到「加上路径或分区」这种
    // 帮不上忙的建议，而它真正的问题是里面有个 p 值
    const verdict = classifyMemoryCandidate({
      scope: 'compute',
      kind: 'environment',
      content: 'gpu 分区上跑出来的结果 p = 0.03。',
      reason: '这是一条足够具体的理由说明。',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('stat-result');
  });

  it('内容门只对 compute 作用域生效', () => {
    // 「这台机器很好用」在项目作用域下不该被这道门拦（它有别的问题，但不是这一条）
    const verdict = classifyMemoryCandidate({
      scope: 'project',
      kind: 'convention',
      content: '图表统一用深色主题，字号不小于 8pt。',
      reason: '这是一条足够具体的理由说明。',
    });
    expect(verdict.ok).toBe(true);
  });

  it('指引里同时说清该写什么与不该写什么', () => {
    const guidance = environmentNoteGuidance();
    expect(guidance).toContain('跨项目共享');
    expect(guidance).toContain('分区与队列');
    expect(guidance).toContain('调度器的坑');
    expect(guidance).toContain('不该写的');
  });
});

describe('classifyMemoryCandidate 拦截（需求 16.4）', () => {
  const check = (content: string, kind: MemoryKind = 'convention') =>
    classifyMemoryCandidate({
      scope: 'project',
      kind,
      content,
      reason: '这是一条足够具体的理由说明。',
    });

  it.each([
    ['刚才', '刚才跑出来的额叶结果比其他脑区强。'],
    ['这次', '这次分析用的是第二版预处理管线。'],
    ['今天', '今天把预处理跑完了，明天做统计。'],
    ['正在跑', '正在跑第 12 个被试的预处理。'],
  ])('拦截时间指代：%s', (_label, content) => {
    const verdict = check(content);
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('episodic-time');
    // 拒绝要带改写建议，否则模型会放弃使用记忆
    expect(verdict.reason).toContain('记忆存的是');
  });

  it.each([
    ['已完成', '被试 S01 到 S12 的预处理已完成。'],
    ['已保存', '统计结果已保存为 summary.csv 制品。'],
    ['跑完了', '混合效应模型跑完了，收敛正常。'],
  ])('拦截完成陈述：%s', (_label, content) => {
    expect(check(content).rule).toBe('completion');
  });

  it.each([
    ['p 值', '额叶的配对 t 检验结果 p = 0.03，其他脑区不显著。'],
    ['中文 p 值', '额叶的 p 值是 0.031，达到显著。'],
    // `\b均值` 永远匹配不上：`的` 与 `均` 都不是 word 字符，两者之间没有边界
    ['中文均值（紧跟中文）', '睡眠效率的均值 = 82.4，标准差略大。'],
    ['中文均值（是）', '入睡潜伏期的中位数是 14.2 分钟。'],
    ['SD', '入睡潜伏期 SD = 14.2 分钟。'],
    ['t 统计量', '额叶的 t(23) = 2.41，达到显著水平。'],
    ['F 统计量', '组间差异 F(2, 45) = 5.12。'],
    ['效应量', "额叶的 Cohen's d = 0.62，属于中等效应。"],
    ['置信区间', '差值的 95% CI = [0.12, 0.88]。'],
  ])('拦截具体统计结果：%s', (_label, content) => {
    const verdict = check(content);
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('stat-result');
    // 要说清结果该去哪：制品与断言有版本与血缘，记忆没有
    expect(verdict.reason).toContain('制品');
  });

  it.each([
    ['制品版本 id', '主要结果在 av_11111111-2222-3333-4444-555555555555 里。'],
    ['finding id', '审查提的 fd_11111111-2222-3333-4444-555555555555 已经处理了。'],
  ])('拦截一次性 id：%s', (_label, content) => {
    expect(check(content).rule).toBe('episodic-id');
  });

  it('太短的内容被拒', () => {
    const verdict = check('用 FDR');
    expect(verdict.rule).toBe('too-short');
  });

  it('太长的内容被拒并指向技能与制品', () => {
    const verdict = check('约定：'.repeat(500));
    expect(verdict.rule).toBe('too-long');
    // 记忆进每一轮提示词，长笔记等于每轮都多花预算
    expect(verdict.reason).toContain('技能');
  });

  it('理由太短被拒', () => {
    const verdict = classifyMemoryCandidate({
      scope: 'project',
      kind: 'convention',
      content: '被试编号统一用 S01 到 S24。',
      reason: '重要',
    });
    expect(verdict.rule).toBe('no-reason');
  });

  it('指引里列出了全部类别', () => {
    const guidance = memoryGuidance();
    for (const kind of [
      'preference',
      'background',
      'convention',
      'decision',
      'data',
      'environment',
    ]) {
      expect(guidance).toContain(kind);
    }
  });
});

/* ------------------------------------------------------------------ *
 * MemoryService
 * ------------------------------------------------------------------ */

describe('MemoryService', () => {
  const remember = (over: Partial<Parameters<MemoryService['remember']>[0]> = {}) =>
    service.remember({
      scope: 'project',
      kind: 'convention',
      content: '被试编号统一用 S01 到 S24，与原始文件名保持一致。',
      reason: '改写会与采集记录对不上。',
      ...over,
    });

  it('写入成功返回条目', () => {
    const result = remember();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.note.scope).toBe('project');
    }
  });

  it('被拒是正常返回而不是抛错', () => {
    // 用异常表达会让调用方倾向于 catch 之后忽略
    const result = remember({ content: '刚才那个结果不错。' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe('episodic-time');
  });

  it('compute 作用域校验目标存在', () => {
    const bad = service.remember({
      scope: 'compute',
      scopeId: 'ct_不存在',
      kind: 'environment',
      content: 'GPU 分区叫 gpu-v100，要指定 account。',
      reason: '不指定会被调度器拒。',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.rule).toBe('unknown-target');

    const good = service.remember({
      scope: 'compute',
      scopeId: 'ct_cluster',
      kind: 'environment',
      content: 'GPU 分区叫 gpu-v100，要指定 --account=lab01。',
      reason: '不指定会被调度器拒。',
    });
    expect(good.ok).toBe(true);
  });

  it('compute 作用域缺 scopeId 时明确说明为什么', () => {
    const result = service.remember({
      scope: 'compute',
      kind: 'environment',
      content: 'GPU 分区叫 gpu-v100。',
      reason: '省得每次查。',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe('missing-target');
      expect(result.reason).toContain('套到所有集群');
    }
  });

  it('达到条数上限时拒绝并要求合并', () => {
    for (let i = 0; i < MEMORY_LIMITS.global; i += 1) {
      const r = service.remember({
        scope: 'global',
        kind: 'preference',
        content: `第 ${String(i)} 条长期偏好，内容足够长以通过准入判定。`,
        reason: '测试用的理由说明。',
      });
      expect(r.ok).toBe(true);
    }

    const overflow = service.remember({
      scope: 'global',
      kind: 'preference',
      content: '再来一条长期偏好，内容也足够长。',
      reason: '测试用的理由说明。',
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.rule).toBe('limit-reached');
      // 无上限的记忆最终会把上下文预算吃掉，表现为「模型越用越笨」
      expect(overflow.reason).toContain('合并');
    }
  });

  it('替换不受条数上限约束', () => {
    const notes = [];
    for (let i = 0; i < MEMORY_LIMITS.global; i += 1) {
      const r = service.remember({
        scope: 'global',
        kind: 'preference',
        content: `第 ${String(i)} 条长期偏好，内容足够长以通过准入判定。`,
        reason: '测试用的理由说明。',
      });
      if (r.ok) notes.push(r.note);
    }

    // 替换不会让记忆变多，正是我们希望鼓励的行为
    const replaced = service.remember({
      scope: 'global',
      kind: 'preference',
      content: '把前面几条合并成的一条更完整的偏好说明。',
      reason: '合并掉重复的条目。',
      replaceId: notes[0]?.id ?? '',
    });
    expect(replaced.ok).toBe(true);
    expect(service.repo.count('global')).toBe(MEMORY_LIMITS.global);
  });

  it('删除后不再出现在列表里', () => {
    const result = remember();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(service.delete(result.note.id)).toBe(true);
    expect(service.list({ scope: 'project' })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 注入
 * ------------------------------------------------------------------ */

describe('记忆注入', () => {
  it('没有记忆时返回空串', () => {
    expect(service.injection()).toBe('');
  });

  it('按类别分组并给出标签', () => {
    service.remember({
      scope: 'project',
      kind: 'convention',
      content: '被试编号统一用 S01 到 S24。',
      reason: '与原始文件名一致。',
    });
    service.remember({
      scope: 'global',
      kind: 'preference',
      content: '图表默认导出 300 dpi。',
      reason: '投稿普遍要求。',
    });

    const injected = service.injection();
    expect(injected).toContain('术语与约定');
    expect(injected).toContain('用户偏好');
    expect(injected).toContain('S01 到 S24');
  });

  it('约定与决策排在偏好之前', () => {
    // 纯按时间排序时，刚写的偏好会把影响分析正确性的约定挤出预算
    service.remember({
      scope: 'global',
      kind: 'preference',
      content: '回复里先给结论再给过程。',
      reason: '更快判断方向。',
    });
    service.remember({
      scope: 'project',
      kind: 'decision',
      content: '本项目统一用线性混合效应模型。',
      reason: '缺失值多，ANOVA 会丢整条记录。',
    });

    const injected = service.injection();
    expect(injected.indexOf('既定决策')).toBeLessThan(injected.indexOf('用户偏好'));
  });

  it('算力笔记只在指定目标时注入', () => {
    service.remember({
      scope: 'compute',
      scopeId: 'ct_cluster',
      kind: 'environment',
      content: 'GPU 分区叫 gpu-v100，要指定 --account=lab01。',
      reason: '不指定会被拒。',
    });

    // 不在用远程算力时带上它们是纯噪声，而噪声会挤掉真正相关的内容
    expect(service.injection()).not.toContain('gpu-v100');
    expect(service.injection({ computeTargetIds: ['ct_cluster'] })).toContain('gpu-v100');
  });

  it('超出预算时截断并说明还有多少条', () => {
    for (let i = 0; i < MEMORY_LIMITS.project; i += 1) {
      service.remember({
        scope: 'project',
        kind: 'background',
        content: `第 ${String(i)} 条背景说明，${'内容'.repeat(60)}`,
        reason: '测试用的理由说明。',
      });
    }

    const injected = service.injection();
    // 静默截断会让模型以为它看到的就是全部记忆
    expect(injected).toContain('未展示');
    expect(injected).toContain('recall_memory');
  });
});

/* ------------------------------------------------------------------ *
 * 系统提示词
 * ------------------------------------------------------------------ */

describe('buildSystemPrompt', () => {
  it('只提当前存在的工具', () => {
    const withSkills = buildSystemPrompt({ toolNames: ['search_skills', 'python'] });
    expect(withSkills).toContain('search_skills');

    const without = buildSystemPrompt({ toolNames: ['python'] });
    // 提了不存在的工具会让模型反复尝试调用它
    expect(without).not.toContain('search_skills');
  });

  it('没有 ask_user 时改说直接在回复里问', () => {
    expect(buildSystemPrompt({ toolNames: ['ask_user'] })).toContain('`ask_user`');
    expect(buildSystemPrompt({ toolNames: [] })).toContain('直接在回复里问');
  });

  it('把可靠性要求写进去', () => {
    const prompt = buildSystemPrompt({ toolNames: [] });
    expect(prompt).toContain('数字必须来自实际计算');
    expect(prompt).toContain('引用必须核实过');
    expect(prompt).toContain('信息不足时问');
  });

  it('注入记忆并说明它是既定选择', () => {
    const prompt = buildSystemPrompt({
      toolNames: ['remember'],
      memory: '术语与约定：\n- 被试编号统一用 S01 到 S24。',
    });
    expect(prompt).toContain('已经记住的内容');
    expect(prompt).toContain('S01 到 S24');
    expect(prompt).toContain('既定选择');
  });

  it('没有记忆时不出现记忆段落', () => {
    expect(buildSystemPrompt({ toolNames: [], memory: '   ' })).not.toContain('已经记住的内容');
  });

  it('如实说明网络管控状态', () => {
    const proxied = buildSystemPrompt({
      toolNames: [],
      isolation: { backend: 'native', network: 'proxy' },
    });
    expect(proxied).toContain('审批');

    const none = buildSystemPrompt({
      toolNames: [],
      isolation: { backend: 'native', network: 'none' },
    });
    expect(none).toContain('不受管控');
  });

  it('带上项目名与环境名', () => {
    const prompt = buildSystemPrompt({
      projectName: '睡眠分期研究',
      toolNames: ['python', 'r'],
      pythonEnv: 'lsci',
      rEnv: 'lsci-r',
    });
    expect(prompt).toContain('睡眠分期研究');
    expect(prompt).toContain('lsci');
    expect(prompt).toContain('lsci-r');
  });
});

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

describe('记忆工具', () => {
  const ctx = () => ({ projectId, conversationId: 'conv_1', workspaceDir: root });
  const options = () => ({ service: () => service });

  it('remember 写入成功', async () => {
    const tool = createRememberTool(options());
    const result = await tool.execute(
      {
        scope: 'project',
        kind: 'convention',
        content: '被试编号统一用 S01 到 S24，与原始文件名保持一致。',
        reason: '改写会与采集记录对不上。',
      },
      ctx() as never,
    );
    expect(result.ok).toBe(true);
    if (result.output.kind === 'text') expect(result.output.text).toContain('已记住');
  });

  it('remember 被拒时把改写建议给模型', async () => {
    const tool = createRememberTool(options());
    const result = await tool.execute(
      {
        scope: 'project',
        kind: 'convention',
        content: '额叶的 p = 0.03，达到显著。',
        reason: '这是主要结果。',
      },
      ctx() as never,
    );
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error') {
      expect(result.output.ename).toBe('MemoryRejected');
      expect(result.output.evalue).toContain('制品');
    }
  });

  it('remember 校验 scope 与 kind', () => {
    const tool = createRememberTool(options());
    expect(() =>
      tool.parseInput({ scope: 'session', kind: 'convention', content: 'x', reason: 'y' }),
    ).toThrow(/scope/);
    expect(() =>
      tool.parseInput({ scope: 'global', kind: 'note', content: 'x', reason: 'y' }),
    ).toThrow(/kind/);
    expect(() =>
      tool.parseInput({ scope: 'global', kind: 'preference', content: 'x', reason: '  ' }),
    ).toThrow(/reason/);
  });

  it('remember 的描述里带上写入指引', () => {
    const tool = createRememberTool(options());
    expect(tool.description).toContain('跨会话仍然成立');
    expect(tool.description).toContain('replaceId');
  });

  it('工具里没有 forget：删除是用户的权力', () => {
    const names = [createRememberTool(options()).name, createRecallMemoryTool(options()).name];
    expect(names).toEqual(['remember', 'recall_memory']);
    expect(names.some((n) => n.includes('forget') || n.includes('delete'))).toBe(false);
  });

  it('recall_memory 列出记忆并给出 id', async () => {
    service.remember({
      scope: 'project',
      kind: 'data',
      content: 'EDF 通道命名不统一，C3 有时写成 EEG C3-A2。',
      reason: '忘了就会漏通道。',
    });

    const tool = createRecallMemoryTool(options());
    const result = await tool.execute({}, ctx() as never);
    expect(result.ok).toBe(true);
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('EEG C3-A2');
      // 没有 id 就没法用 replaceId 覆盖它
      expect(result.output.text).toMatch(/id: mem_/);
      expect(result.output.text).toContain('理由：');
    }
  });

  it('recall_memory 支持按内容筛选', async () => {
    service.remember({
      scope: 'project',
      kind: 'data',
      content: 'EDF 通道命名不统一，C3 有时写成 EEG C3-A2。',
      reason: '忘了就会漏通道。',
    });
    service.remember({
      scope: 'global',
      kind: 'preference',
      content: '图表默认导出 300 dpi。',
      reason: '投稿普遍要求。',
    });

    const tool = createRecallMemoryTool(options());
    const hit = await tool.execute({ query: 'dpi' }, ctx() as never);
    if (hit.output.kind === 'text') {
      expect(hit.output.text).toContain('300 dpi');
      expect(hit.output.text).not.toContain('EEG C3-A2');
    }
  });

  it('recall_memory 在没有匹配时明确说没有', async () => {
    const tool = createRecallMemoryTool(options());
    const result = await tool.execute({ query: '不存在的东西' }, ctx() as never);
    if (result.output.kind === 'text') expect(result.output.text).toBe('没有匹配的记忆。');
  });
});
