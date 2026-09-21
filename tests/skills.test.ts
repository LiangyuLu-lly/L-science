/**
 * 技能系统测试（任务 12.1-12.4）。
 *
 * 三块重点：
 * 1. **清单校验**：坏清单必须报错而不是降级成一个「装了但从不生效」的技能。
 * 2. **作用域覆盖**：用户技能整体替换同名内置技能，被遮蔽的那份要能查到。
 * 3. **全部内置技能真的能加载**——这一条是对 32 份手写清单的实际校验，
 *    一个逗号写错就会被抓到。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  BUILTIN_CONNECTORS,
  SkillManager,
  SkillManifestError,
  SkillSearchIndex,
  checkRequirements,
  countBuiltinSkills,
  cosineSimilarity,
  describeMissing,
  installBuiltinSkills,
  isValidSlug,
  loadSkillCatalog,
  parseFrontMatter,
  parseSkillManifest,
  tokenize,
  type RequirementProbes,
  type SkillManifest,
} from '@l-science/core';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtinSource = join(repoRoot, 'resources', 'skills', 'builtin');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-skill-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写一个最小可用的技能目录。 */
function writeSkill(
  scopeDir: string,
  slug: string,
  overrides: Partial<Record<string, unknown>> = {},
  body = '正文内容。',
): string {
  const dir = join(scopeDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'skill.json'),
    JSON.stringify({
      slug,
      name: `技能 ${slug}`,
      version: '1.0.0',
      domain: '测试',
      description: `${slug} 的描述`,
      triggers: [`触发 ${slug}`],
      ...overrides,
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'SKILL.md'), `---\nslug: ${slug}\n---\n\n${body}`, 'utf8');
  return dir;
}

/* ------------------------------------------------------------------ *
 * 清单校验
 * ------------------------------------------------------------------ */

describe('slug 校验', () => {
  it('接受小写字母数字与连字符', () => {
    expect(isValidSlug('sleep-staging')).toBe(true);
    expect(isValidSlug('edf2')).toBe(true);
  });

  it('拒绝大写、下划线、点与路径分隔符', () => {
    // slug 同时是目录名与覆盖的键，放宽字符集会让「../」这类值有机会进来
    for (const bad of ['Sleep', 'sleep_staging', 'a.b', '../x', 'x/y', '-lead', '']) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
  });
});

describe('skill.json 解析', () => {
  const base = {
    slug: 'x',
    name: '名字',
    description: '描述',
    triggers: ['触发'],
  };

  it('解析完整清单', () => {
    const m = parseSkillManifest(
      {
        ...base,
        version: '2.1.0',
        domain: '统计',
        tools: ['python'],
        requires: { python: ['mne'] },
      },
      'p',
    );
    expect(m.version).toBe('2.1.0');
    expect(m.requires.python).toEqual(['mne']);
    expect(m.tools).toEqual(['python']);
  });

  it('description 为空直接报错', () => {
    // 空描述的技能进了索引也永远不会被命中，表现是「装了但从不生效」——
    // 那比加载时报错难查得多
    expect(() => parseSkillManifest({ ...base, description: '  ' }, 'p')).toThrow(
      SkillManifestError,
    );
  });

  it('triggers 为空直接报错', () => {
    expect(() => parseSkillManifest({ ...base, triggers: [] }, 'p')).toThrow(SkillManifestError);
  });

  it('requires 里的未知字段报错而不是静默忽略', () => {
    // 拼错的键被忽略等于「声明了依赖但从不检查」，比不声明更危险
    expect(() => parseSkillManifest({ ...base, requires: { pyton: ['mne'] } }, 'p')).toThrow(
      /未知字段/,
    );
  });

  it('省略可选字段时给 null 而不是 undefined', () => {
    const m = parseSkillManifest(base, 'p');
    expect(m.version).toBeNull();
    expect(m.domain).toBeNull();
    expect(m.requires).toEqual({});
  });
});

describe('front matter', () => {
  it('剥离并解析标量与单行数组', () => {
    const { fields, body } = parseFrontMatter(
      '---\nslug: a-b\nname: "带引号"\ntags: [x, y]\n---\n\n正文',
    );
    expect(fields.slug).toBe('a-b');
    expect(fields.name).toBe('带引号');
    expect(fields.tags).toEqual(['x', 'y']);
    expect(body.trim()).toBe('正文');
  });

  it('没有 front matter 时原样返回正文', () => {
    const { fields, body } = parseFrontMatter('# 标题\n内容');
    expect(fields).toEqual({});
    expect(body).toBe('# 标题\n内容');
  });

  it('容忍 BOM 与 CRLF', () => {
    // Windows 上用记事本存的文件两者都会有
    const { fields, body } = parseFrontMatter('\uFEFF---\r\nslug: a\r\n---\r\n\r\n正文');
    expect(fields.slug).toBe('a');
    expect(body.trim()).toBe('正文');
  });

  it('只认文件开头的分隔块', () => {
    // 正文里的 --- 是 Markdown 水平线，不该被当成 front matter
    const { fields } = parseFrontMatter('正文\n---\nslug: a\n---\n');
    expect(fields).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * 作用域与覆盖
 * ------------------------------------------------------------------ */

describe('作用域与覆盖', () => {
  let builtinDir: string;
  let userDir: string;

  beforeEach(() => {
    builtinDir = join(root, 'builtin');
    userDir = join(root, 'user');
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
  });

  it('两个作用域的技能都加载', () => {
    writeSkill(builtinDir, 'a');
    writeSkill(userDir, 'b');
    const catalog = loadSkillCatalog({ builtinDir, userDir });
    expect([...catalog.skills.keys()].sort()).toEqual(['a', 'b']);
  });

  it('同名时用户技能胜出，被遮蔽的内置技能可查', () => {
    writeSkill(builtinDir, 'a', { name: '内置版' }, '内置正文');
    writeSkill(userDir, 'a', { name: '用户版' }, '用户正文');

    const catalog = loadSkillCatalog({ builtinDir, userDir });
    expect(catalog.skills.get('a')?.scope).toBe('user');
    expect(catalog.skills.get('a')?.instructions).toBe('用户正文');
    // 查不到被遮蔽的那份，「我的改动生效了吗」就无从确认
    expect(catalog.shadowed).toHaveLength(1);
    expect(catalog.shadowed[0]?.manifest.name).toBe('内置版');
  });

  it('覆盖是整体替换而非字段合并', () => {
    writeSkill(builtinDir, 'a', { domain: '内置领域', requires: { python: ['mne'] } });
    writeSkill(userDir, 'a', { domain: '用户领域' });

    const skill = loadSkillCatalog({ builtinDir, userDir }).skills.get('a');
    expect(skill?.manifest.domain).toBe('用户领域');
    // 合并会造出「文档来自用户、依赖来自内置」的混合体，而这种不一致没有地方会报
    expect(skill?.manifest.requires).toEqual({});
  });

  it('一个技能坏掉不影响其余', () => {
    writeSkill(builtinDir, 'good');
    const badDir = join(builtinDir, 'bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'skill.json'), '{ 这不是 JSON', 'utf8');
    writeFileSync(join(badDir, 'SKILL.md'), '正文', 'utf8');

    const catalog = loadSkillCatalog({ builtinDir, userDir });
    expect([...catalog.skills.keys()]).toEqual(['good']);
    expect(catalog.broken).toHaveLength(1);
    expect(catalog.broken[0]?.dirName).toBe('bad');
  });

  it('缺 SKILL.md 视为坏技能', () => {
    const dir = join(builtinDir, 'nodoc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({ slug: 'nodoc', name: 'n', description: 'd', triggers: ['t'] }),
      'utf8',
    );
    const catalog = loadSkillCatalog({ builtinDir, userDir });
    expect(catalog.broken[0]?.reason).toMatch(/SKILL\.md/);
  });

  it('目录名与 slug 不一致时给警告但仍加载', () => {
    const dir = join(builtinDir, 'wrong-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({ slug: 'right-slug', name: 'n', description: 'd', triggers: ['t'] }),
      'utf8',
    );
    writeFileSync(join(dir, 'SKILL.md'), '正文', 'utf8');

    const catalog = loadSkillCatalog({ builtinDir, userDir });
    expect(catalog.skills.has('right-slug')).toBe(true);
    expect(catalog.skills.get('right-slug')?.warnings.join()).toMatch(/目录名/);
  });

  it('front matter 与清单不一致时给警告而不是拒绝加载', () => {
    const dir = join(builtinDir, 'a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({ slug: 'a', name: '清单里的名字', description: 'd', triggers: ['t'] }),
      'utf8',
    );
    writeFileSync(join(dir, 'SKILL.md'), '---\nslug: a\nname: 文档里的名字\n---\n\n正文', 'utf8');

    const catalog = loadSkillCatalog({ builtinDir, userDir });
    // 文档写错不该让一个可用的技能整个消失
    expect(catalog.skills.get('a')?.manifest.name).toBe('清单里的名字');
    expect(catalog.skills.get('a')?.warnings.join()).toMatch(/name 不一致/);
  });

  it('目录不存在时返回空目录而不是抛错', () => {
    const catalog = loadSkillCatalog({
      builtinDir: join(root, 'nope'),
      userDir: join(root, 'nope2'),
    });
    expect(catalog.skills.size).toBe(0);
    expect(catalog.broken).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 检索
 * ------------------------------------------------------------------ */

describe('切分', () => {
  it('英文按词切分并转小写', () => {
    expect(tokenize('Sleep Staging')).toContain('sleep');
    expect(tokenize('Sleep Staging')).toContain('staging');
  });

  it('连字符切开，让 sleep-staging 能被 sleep 命中', () => {
    expect(tokenize('sleep-staging')).toEqual(['sleep', 'staging']);
  });

  it('中文产出单字与二元组', () => {
    const t = tokenize('睡眠分期');
    expect(t).toContain('睡眠');
    expect(t).toContain('眠分');
    expect(t).toContain('睡');
  });

  it('中英混排都能切出来', () => {
    const t = tokenize('把这段 EEG 做睡眠分期');
    expect(t).toContain('eeg');
    expect(t).toContain('睡眠');
  });
});

describe('检索索引', () => {
  const manifest = (over: Partial<SkillManifest>): SkillManifest => ({
    slug: 'x',
    name: 'x',
    version: null,
    domain: null,
    description: 'x',
    triggers: ['x'],
    requires: {},
    tools: [],
    ...over,
  });

  const index = new SkillSearchIndex([
    manifest({
      slug: 'sleep-staging',
      name: '睡眠分期',
      description: 'AASM 判读规则与自动分期',
      triggers: ['睡眠分期 / 判读分期 / hypnogram'],
    }),
    manifest({
      slug: 'hrv-analysis',
      name: '心率变异性分析',
      description: '从 ECG 提取 RR 间期并计算 HRV 指标',
      triggers: ['心率变异性 / HRV / RR 间期'],
    }),
    manifest({
      slug: 'figure-standards',
      name: '图表规范',
      description: '投稿级图表的制作规范',
      triggers: ['画图 / 出图 / 图表规范'],
    }),
  ]);

  it('中文查询命中正确的技能', () => {
    expect(index.search('帮我做睡眠分期')[0]?.slug).toBe('sleep-staging');
  });

  it('英文缩写命中', () => {
    expect(index.search('计算 HRV')[0]?.slug).toBe('hrv-analysis');
  });

  it('slug 里的词能命中', () => {
    expect(index.search('figure standards')[0]?.slug).toBe('figure-standards');
  });

  it('完全无关的查询返回空而不是硬凑一个', () => {
    // 硬凑一个会让模型加载一份不相关的长文档，而它只能带着它继续
    expect(index.search('量子色动力学')).toHaveLength(0);
  });

  it('报告命中了哪些词元，便于解释为什么检索到它', () => {
    const hit = index.search('睡眠分期')[0];
    expect(hit?.matchedTerms.length).toBeGreaterThan(0);
  });

  it('没有向量时 vectorScore 为 null', () => {
    expect(index.search('睡眠分期')[0]?.vectorScore).toBeNull();
    expect(index.hasVectors).toBe(false);
  });

  it('注入向量后参与融合打分', () => {
    const idx = new SkillSearchIndex([
      manifest({ slug: 'a', name: 'a', description: 'aaa', triggers: ['aaa'] }),
      manifest({ slug: 'b', name: 'b', description: 'bbb', triggers: ['bbb'] }),
    ]);
    idx.setVectors(
      new Map([
        ['a', [1, 0]],
        ['b', [0, 1]],
      ]),
    );
    expect(idx.hasVectors).toBe(true);

    const hits = idx.search('aaa', { queryVector: [1, 0] });
    expect(hits[0]?.slug).toBe('a');
    expect(hits[0]?.vectorScore).toBeCloseTo(1, 5);
  });

  it('限制返回条数', () => {
    expect(index.search('分期 HRV 图表', { limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});

describe('余弦相似度', () => {
  it('同向为 1，正交为 0', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('维度不一致返回 0 而不是抛错', () => {
    // 维度不同说明两个向量来自不同模型，比不了。抛错会让一次换模型
    // 变成整个检索不可用
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('零向量返回 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 依赖检查
 * ------------------------------------------------------------------ */

describe('依赖检查', () => {
  const probes = (
    present: Record<string, boolean>,
    failure: string | null = null,
  ): RequirementProbes => ({
    python: (names) => ({
      present: new Map(names.map((n) => [n, present[n] ?? false])),
      failure,
    }),
    r: (names) => ({ present: new Map(names.map((n) => [n, present[n] ?? false])), failure: null }),
    commands: (names) => ({
      present: new Map(names.map((n) => [n, present[n] ?? false])),
      failure: null,
    }),
    connectors: () => new Set(Object.keys(present).filter((k) => present[k] === true)),
    capabilities: () => new Set(Object.keys(present).filter((k) => present[k] === true)),
  });

  it('全部满足时 satisfied 为真', () => {
    const r = checkRequirements({
      requires: { python: ['mne'] },
      probes: probes({ mne: true }),
    });
    expect(r.satisfied).toBe(true);
    expect(r.missing).toHaveLength(0);
  });

  it('缺失项带可执行的安装命令', () => {
    const r = checkRequirements({
      requires: { python: ['yasa'] },
      probes: probes({}),
      pythonEnv: 'lsci',
    });
    expect(r.satisfied).toBe(false);
    // 「缺 yasa」没用，「conda run -n lsci python -m pip install yasa」有用
    expect(r.missing[0]?.remediation).toContain('pip install yasa');
  });

  it('探测失败与确定缺失分开报告', () => {
    // 混为一谈会让「conda 恰好没响应」表现成「你没装 mne」，
    // 用户于是去装一个已经装好的包
    const r = checkRequirements({
      requires: { python: ['mne'] },
      probes: probes({}, 'conda 无响应'),
    });
    expect(r.probeFailures).toHaveLength(1);
    expect(describeMissing(r)).toMatch(/可能是误报/);
  });

  it('能力缺失时用传入的指引表', () => {
    const r = checkRequirements({
      requires: { capabilities: ['kernel:r'] },
      probes: probes({}),
      capabilityRemediation: { 'kernel:r': '装 R 内核的具体命令' },
    });
    expect(r.missing[0]?.remediation).toBe('装 R 内核的具体命令');
  });

  it('未声明依赖时直接满足，不做任何探测', () => {
    let called = false;
    const r = checkRequirements({
      requires: {},
      probes: {
        python: () => {
          called = true;
          return { present: new Map(), failure: null };
        },
        r: () => ({ present: new Map(), failure: null }),
        commands: () => ({ present: new Map(), failure: null }),
        connectors: () => new Set(),
        capabilities: () => new Set(),
      },
    });
    expect(r.satisfied).toBe(true);
    expect(called).toBe(false);
  });

  it('连接器缺失时 kind 为 connector 并给出启用指引', () => {
    const r = checkRequirements({
      requires: { connectors: ['pubmed'] },
      probes: probes({}),
    });
    expect(r.satisfied).toBe(false);
    expect(r.missing[0]?.kind).toBe('connector');
    expect(r.missing[0]?.remediation).toContain('启用连接器');
  });

  it('连接器在探针集合内时满足', () => {
    const r = checkRequirements({
      requires: { connectors: ['pubmed'] },
      probes: probes({ pubmed: true }),
    });
    expect(r.satisfied).toBe(true);
    expect(r.missing).toHaveLength(0);
  });

  it('连接器探针变化后必须 reload 才会更新依赖缓存', () => {
    const builtinDir = join(root, 'builtin-conn');
    const userDir = join(root, 'user-conn');
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeSkill(builtinDir, 'needs-conn', { requires: { connectors: ['pubmed'] } });

    const present = new Set<string>();
    const store = AppStore.open(join(root, 'app-conn'));
    try {
      const manager = new SkillManager({
        builtinDir,
        userDir,
        db: store.db,
        probes: {
          python: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
          r: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
          commands: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
          connectors: () => present,
          capabilities: () => new Set(),
        },
      });

      manager.reload();
      expect(manager.requirementsOf('needs-conn')?.satisfied).toBe(false);
      expect(manager.requirementsOf('needs-conn')?.missing[0]?.kind).toBe('connector');

      present.add('pubmed');
      expect(manager.requirementsOf('needs-conn')?.satisfied).toBe(false);

      manager.reload();
      expect(manager.requirementsOf('needs-conn')?.satisfied).toBe(true);
    } finally {
      store.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 内置技能目录（对 32 份手写清单的实际校验）
 * ------------------------------------------------------------------ */

describe('内置技能目录（需求 9.7）', () => {
  it('源目录存在且有足够多的技能', () => {
    const n = countBuiltinSkills(builtinSource);
    // 设计文档列了 32 个。少于这个数说明有技能缺文件或被误删
    expect(n).toBeGreaterThanOrEqual(32);
  });

  it('全部内置技能都能无错加载', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });

    // 这一条是对全部手写清单的实际校验：一个逗号写错就会被抓到
    expect(catalog.broken, JSON.stringify(catalog.broken, null, 2)).toHaveLength(0);
    expect(catalog.skills.size).toBeGreaterThanOrEqual(32);
  });

  it('全部内置技能都没有加载警告', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });
    const withWarnings = [...catalog.skills.values()]
      .filter((s) => s.warnings.length > 0)
      .map((s) => ({ slug: s.manifest.slug, warnings: s.warnings }));
    expect(withWarnings, JSON.stringify(withWarnings, null, 2)).toHaveLength(0);
  });

  it('覆盖设计文档列出的六个领域', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });
    const domains = new Set(
      [...catalog.skills.values()].map((s) => s.manifest.domain).filter((d) => d !== null),
    );
    for (const d of [
      '信号与数据',
      '统计与建模',
      '文献',
      '写作与投稿',
      '规范与可复现',
      '平台自身',
    ]) {
      expect(domains, d).toContain(d);
    }
  });

  it('每个技能的 SKILL.md 都有实质正文', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });
    const thin = [...catalog.skills.values()]
      .filter((s) => s.instructions.length < 500)
      .map((s) => `${s.manifest.slug}:${String(s.instructions.length)}`);
    // 一份两百字的方法学文档基本上等于没写
    expect(thin, thin.join(', ')).toHaveLength(0);
  });

  it('indication-dossier 的连接器 id 都出现在内置连接器目录里', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });
    const skill = catalog.skills.get('indication-dossier');
    expect(skill).toBeDefined();
    const builtinIds = new Set(BUILTIN_CONNECTORS.map((c) => c.id));
    const required = skill?.manifest.requires.connectors ?? [];
    const unknown = required.filter((id) => !builtinIds.has(id));
    expect(unknown, unknown.join(', ')).toEqual([]);
  });

  it('proteinmpnn / diffdock / borzoi 必须声明技能自身的依赖，只有共享库时不能算可跑', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });

    const specific: Readonly<Record<string, string>> = {
      proteinmpnn: 'protein_mpnn_run.py',
      diffdock: 'diffdock',
      borzoi: 'borzoi',
    };
    const sharedPython = new Set([
      'torch',
      'numpy',
      'pandas',
      'Bio',
      'rdkit',
      'posebusters',
      'matplotlib',
      'pysam',
    ]);
    const probes: RequirementProbes = {
      python: (mods) => ({
        present: new Map(mods.map((m) => [m, sharedPython.has(m)])),
        failure: null,
      }),
      r: (pkgs) => ({ present: new Map(pkgs.map((p) => [p, false])), failure: null }),
      commands: (names) => ({ present: new Map(names.map((n) => [n, false])), failure: null }),
      connectors: () => new Set(),
      capabilities: () => new Set(['kernel:python']),
    };

    for (const [slug, token] of Object.entries(specific)) {
      const skill = catalog.skills.get(slug);
      expect(skill, slug).toBeDefined();
      const requires = skill?.manifest.requires ?? {};
      const named = [...(requires.python ?? []), ...(requires.commands ?? [])];
      expect(named, slug).toContain(token);

      const report = checkRequirements({ requires, probes });
      expect(report.satisfied, slug).toBe(false);
    }
  });

  it('关键技能的典型说法能被检索命中', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });
    const index = new SkillSearchIndex([...catalog.skills.values()].map((s) => s.manifest));

    // triggers 写得对不对，只有真检索一次才知道
    const cases: ReadonlyArray<[string, string]> = [
      ['帮我做睡眠分期', 'sleep-staging'],
      ['读取 EDF 文件', 'edf-psg-io'],
      ['计算 HRV 指标', 'hrv-analysis'],
      ['多重比较要不要校正', 'multiple-comparisons'],
      ['需要多少被试', 'power-analysis'],
      ['核实这条引文', 'citation-verify'],
      ['画一张投稿用的图', 'figure-standards'],
      ['写投稿信', 'cover-letter'],
      ['回复审稿意见', 'response-to-reviewers'],
      ['提交到 Slurm 集群', 'compute-hpc'],
    ];

    for (const [query, expected] of cases) {
      const hits = index.search(query, { limit: 3 });
      const slugs = hits.map((h) => h.slug);
      expect(slugs, `${query} -> ${slugs.join(',')}`).toContain(expected);
    }
  });

  it('pdf-explore is in the catalog and still has no pdfjs dependency', () => {
    const catalog = loadSkillCatalog({
      builtinDir: builtinSource,
      userDir: join(root, 'empty-user'),
    });

    expect(catalog.skills.has('pdf-explore')).toBe(true);
    expect(catalog.unavailable.some((s) => s.manifest.slug === 'pdf-explore')).toBe(false);

    const pkgFiles = [
      join(repoRoot, 'package.json'),
      ...readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(repoRoot, 'packages', e.name, 'package.json'))
        .filter((p) => existsSync(p)),
    ];
    expect(pkgFiles.length).toBeGreaterThan(0);
    for (const pkg of pkgFiles) {
      const text = readFileSync(pkg, 'utf8');
      expect(text, pkg).not.toMatch(/pdfjs-dist|pdf-parse|pdfjs/);
    }
  });
});

describe('内置技能安装', () => {
  it('首次安装把全部技能拷进目标目录', () => {
    const target = join(root, 'installed');
    const r = installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    expect(r.installed).toBeGreaterThanOrEqual(32);
    expect(countBuiltinSkills(target)).toBe(countBuiltinSkills(builtinSource));
  });

  it('内容未变时第二次安装不写任何文件', () => {
    const target = join(root, 'installed');
    installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    const second = installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    // 每次启动都重写三十几个技能既是几百次文件写入，也会让「用户改过没有」
    // 这个问题无从判断
    expect(second).toMatchObject({ installed: 0, updated: 0, removed: 0 });
  });

  it('目标里被就地改过的内置技能会被恢复', () => {
    const target = join(root, 'installed');
    installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    writeFileSync(join(target, 'sleep-staging', 'SKILL.md'), '被改坏了', 'utf8');

    const r = installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    expect(r.updated).toBe(1);
  });

  it('源里已下架的内置技能会被移除', () => {
    const target = join(root, 'installed');
    writeSkill(target, 'retired-skill');
    const r = installBuiltinSkills({ targetDir: target, sourceDir: builtinSource });
    // 留着它会让一个已被撤下（可能因为内容有错）的技能继续被检索到
    expect(r.removed).toBe(1);
  });

  it('源目录不存在时什么都不做而不是抛错', () => {
    const r = installBuiltinSkills({
      targetDir: join(root, 'installed'),
      sourceDir: join(root, 'no-such-source'),
    });
    expect(r).toMatchObject({ sourceDir: null, installed: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * SkillManager
 * ------------------------------------------------------------------ */

describe('SkillManager', () => {
  let store: AppStore;
  let manager: SkillManager;
  let builtinDir: string;
  let userDir: string;

  const allPresent: RequirementProbes = {
    python: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
    r: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
    commands: (n) => ({ present: new Map(n.map((x) => [x, true])), failure: null }),
    connectors: () => new Set(),
    capabilities: () => new Set(['kernel:python']),
  };

  beforeEach(() => {
    builtinDir = join(root, 'builtin');
    userDir = join(root, 'user');
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeSkill(builtinDir, 'alpha', { description: '第一个技能' }, 'alpha 的指令。');
    writeSkill(builtinDir, 'beta', { description: '第二个技能' }, 'beta 的指令。');

    store = AppStore.open(join(root, 'app'));
    manager = new SkillManager({ builtinDir, userDir, db: store.db, probes: allPresent });
    manager.reload();
  });

  afterEach(() => {
    store.close();
  });

  it('加载后可列出并注入', () => {
    expect(
      manager
        .list()
        .map((m) => m.slug)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    const injection = manager.inject('alpha');
    expect(injection?.content).toContain('alpha 的指令。');
    expect(injection?.content).toContain('技能 alpha');
  });

  it('注入不存在的技能返回 null', () => {
    expect(manager.inject('nope')).toBeNull();
  });

  it('禁用后不再进入检索索引', async () => {
    expect((await manager.search('第一个技能')).map((h) => h.slug)).toContain('alpha');
    manager.setEnabled('alpha', false);
    expect((await manager.search('第一个技能')).map((h) => h.slug)).not.toContain('alpha');
  });

  it('禁用状态在重扫后保留', () => {
    manager.setEnabled('alpha', false);
    manager.reload();
    expect(manager.records().find((r) => r.slug === 'alpha')?.enabled).toBe(false);
  });

  it('文件系统上消失的技能被禁用而不是删记录', () => {
    rmSync(join(builtinDir, 'beta'), { recursive: true, force: true });
    manager.reload();
    const record = manager.records().find((r) => r.slug === 'beta');
    // 删记录会连带丢掉用户的启用选择，而技能目录被临时移走是常事
    expect(record).toBeDefined();
    expect(record?.enabled).toBe(false);
  });

  it('依赖缺失时不注入操作步骤', () => {
    writeSkill(builtinDir, 'needs', { requires: { python: ['nonexistent-pkg'] } }, '正文 colabfold_batch');
    const m = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: {
        ...allPresent,
        python: (n) => ({ present: new Map(n.map((x) => [x, false])), failure: null }),
      },
      pythonEnv: 'lsci',
    });
    m.reload();

    const injection = m.inject('needs');
    expect(injection?.content).not.toContain('colabfold_batch');
    expect(injection?.content).toContain('本机不能跑');
    expect(injection?.content).toContain('pip install nonexistent-pkg');
    expect(injection?.requirements.satisfied).toBe(false);
  });

  it('参考材料按需读取，且不能越出 references 目录', () => {
    const dir = writeSkill(builtinDir, 'withref');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'table.md'), '参考内容', 'utf8');
    manager.reload();

    expect(manager.readReference('withref', 'table.md')).toEqual({
      ok: true,
      content: '参考内容',
    });

    // name 来自模型输出，一个 ../.. 就能把凭据库读成上下文
    const escape = manager.readReference('withref', '../../SKILL.md');
    expect(escape.ok).toBe(false);
  });

  it('检索命中里带上依赖状态与参考材料清单', async () => {
    const dir = writeSkill(builtinDir, 'gamma', { description: '第三个技能' });
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'a.md'), 'x', 'utf8');
    manager.reload();

    const hit = (await manager.search('第三个技能'))[0];
    expect(hit?.slug).toBe('gamma');
    expect(hit?.requirementsSatisfied).toBe(true);
    expect(hit?.references).toEqual(['a.md']);
  });

  it('没有嵌入器时向量层保持关闭且不报错', async () => {
    const r = await manager.buildVectors();
    expect(r).toMatchObject({ built: 0, cached: 0, failed: null });
    expect(manager.vectorsReady).toBe(false);
  });

  it('嵌入器抛错时退回词法层并记录原因', async () => {
    const m = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: allPresent,
      embedder: {
        id: 'test:broken',
        embed: () => Promise.reject(new Error('模型没拉取')),
      },
    });
    m.reload();

    const r = await m.buildVectors();
    expect(r.failed).toMatch(/模型没拉取/);
    expect(m.vectorsReady).toBe(false);
    // 向量层挂掉时检索必须继续可用
    expect((await m.search('第一个技能')).length).toBeGreaterThan(0);
  });

  it('嵌入向量按内容哈希缓存，文本未变时命中缓存', async () => {
    let calls = 0;
    const embedder = {
      id: 'test:fake',
      embed: (texts: readonly string[]) => {
        calls += 1;
        return Promise.resolve(texts.map(() => [1, 0]));
      },
    };

    const m1 = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: allPresent,
      embedder,
    });
    m1.reload();
    const first = await m1.buildVectors();
    expect(first.built).toBe(2);
    expect(calls).toBe(1);

    const m2 = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: allPresent,
      embedder,
    });
    m2.reload();
    const second = await m2.buildVectors();
    // 重算三十几个技能的嵌入要几秒，落在用户第一次检索的时候
    expect(second.cached).toBe(2);
    expect(second.built).toBe(0);
    expect(calls).toBe(1);
  });

  it('技能描述改了之后缓存失效', async () => {
    const embedder = {
      id: 'test:fake',
      embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => [1, 0])),
    };
    const m1 = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: allPresent,
      embedder,
    });
    m1.reload();
    await m1.buildVectors();

    writeSkill(builtinDir, 'alpha', { description: '改过的描述' }, 'alpha 的指令。');
    const m2 = new SkillManager({
      builtinDir,
      userDir,
      db: store.db,
      probes: allPresent,
      embedder,
    });
    m2.reload();
    const r = await m2.buildVectors();
    // 文本变了还用旧向量，表现是「我改了 triggers 但搜不到」
    expect(r.built).toBe(1);
    expect(r.cached).toBe(1);
  });
});

describe('检索精度门', () => {
  /*
   * 这条曾经是个真问题：单字与二元组等价参与打分时，「量子色动力学」会命中睡眠
   * 分期技能——它的描述里有「自动分期」，共享了一个「动」字。模型拿到这个结果
   * 只能带着一份无关的长文档继续。
   */
  const index = new SkillSearchIndex([
    {
      slug: 'sleep-staging',
      name: '睡眠分期',
      version: null,
      domain: null,
      description: 'AASM 判读规则与自动分期',
      triggers: ['睡眠分期 / 判读分期'],
      requires: {},
      tools: [],
    },
    {
      slug: 'figure-standards',
      name: '图表规范',
      version: null,
      domain: null,
      description: '投稿级图表的制作规范',
      triggers: ['画图 / 出图'],
      requires: {},
      tools: [],
    },
  ]);

  it('只共享单个汉字不构成命中', () => {
    expect(index.search('量子色动力学')).toHaveLength(0);
  });

  it('共享多字词元仍然命中', () => {
    expect(index.search('自动分期怎么做')[0]?.slug).toBe('sleep-staging');
  });

  it('查询全是单字时不设门，否则那种查询永远无结果', () => {
    // 用户只打一个「图」也该有结果
    expect(index.search('图').length).toBeGreaterThan(0);
  });

  it('命中项里至少有一个多字词元', () => {
    for (const hit of index.search('睡眠分期')) {
      expect(hit.matchedTerms.some((t) => t.length >= 2)).toBe(true);
    }
  });
});
