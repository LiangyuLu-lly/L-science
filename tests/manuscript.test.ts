/**
 * 手稿编译测试（任务 13.6，需求 13.5-13.8）。
 *
 * 五块重点：
 *
 * 1. **front matter 的嵌套解析**。需求 13.6 要「按结构化元数据移除作者、机构」，
 *    而作者与机构的对应关系是嵌套的。解析错会让双盲版漏掉一位作者——那是静默的
 *    身份泄露。同时验证不支持的语法**报错而不是猜**。
 * 2. **字数、图表编号、章节结构检查**（需求 13.5）。重点是「只报告不改稿」。
 * 3. **双盲版**（需求 13.6）：身份字段整组移除、移除清单必须给出、正文一个字不改。
 * 4. **自引泄露检测**（需求 13.7）：两个条件同时成立才报，缺一个都不报。
 * 5. **需求 13.8 的明示**：局限说明必须同时出现在报告与输出文件里。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  BLINDING_DISCLAIMER,
  BUILTIN_JOURNAL_PROFILES,
  FrontMatterError,
  ManuscriptCompiler,
  ManuscriptRepo,
  RefsRepo,
  buildCitationMap,
  compileManuscript,
  countWords,
  createCompileManuscriptTool,
  detectSelfCitationLeaks,
  findJournalProfile,
  frontMatterErrorMessage,
  parseJournalProfile,
  parseManuscript,
  parseManuscriptFrontMatter,
  surnameOf,
  type CslItem,
  type ProjectStore,
  type RefRecord,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let refsRepo: RefsRepo;
let manuscriptRepo: ManuscriptRepo;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-ms-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '手稿测试' });
  project = store.openProject(created.id);
  refsRepo = new RefsRepo(project.db);
  manuscriptRepo = new ManuscriptRepo(project.db);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const FULL_MANUSCRIPT = `---
title: Sleep spindles predict overnight memory consolidation
shortTitle: Spindles and memory
journal: Nature Communications
language: en
authors:
  - name: Jane Smith
    affiliations: [1, 2]
    email: jane@example.org
    corresponding: true
    equalContribution: true
  - name: Bob Jones
    affiliations: [2]
    equalContribution: true
  - name: Wei Zhang
    affiliations: [3]
affiliations:
  - Department of Neuroscience, University X
  - Center for Sleep Research, University X
  - Institute of Psychology, Academy Y
abstract: |
  Sleep spindles are implicated in memory consolidation.
  We recorded overnight polysomnography in 42 participants.
keywords: [sleep, spindles, memory]
funding: [NIH R01-MH123456, NSFC 32000000]
grantNumbers: [R01-MH123456]
acknowledgements: We thank the staff of the University X sleep laboratory.
authorContributions: J.S. designed the study. B.J. analysed the data.
dataAvailability: Data are available at https://example.org/data
codeAvailability: Code is at https://example.org/code
competingInterests: The authors declare no competing interests.
---

## Introduction

Sleep spindles are 11-16 Hz oscillations [1]. Our previous work showed
that spindle density predicts recall [2].

## Methods

Recordings were made at 250 Hz.

## Results

Spindle density was higher in good sleepers (p = 0.003). See Figure 1 and Table 1.

![pipeline](fig1.png)

**Figure 1.** Analysis pipeline for spindle detection.

**Table 1.** Participant characteristics.

| Group | N |
| --- | --- |
| Good | 20 |

## Discussion

The effect replicates earlier reports [1,3].
`;

/** 造一条文献。 */
function addRef(overrides: Partial<CslItem> = {}): RefRecord {
  return refsRepo.add({
    csl: {
      id: 'x',
      type: 'article-journal',
      title: 'Spindles and memory',
      author: [{ family: 'Other', given: 'A' }],
      issued: { 'date-parts': [[2020]] },
      'container-title': 'Journal of Sleep Research',
      ...overrides,
    },
    source: 'crossref',
  });
}

function compiler(): ManuscriptCompiler {
  return new ManuscriptCompiler({
    repo: manuscriptRepo,
    artifacts,
    refs: () => refsRepo.list({ limit: 100 }),
  });
}

/**
 * 编译失败的主界面必须是「front matter 第 N 行」，不能把整份 YAML 转储当唯一提示。
 *
 * Given / When / Then 的 Then：行号定位是机器可消费的主信号；源文档转储不是。
 */
function assertFrontMatterLineUi(message: string | null, source: string): void {
  expect(message).toMatch(/front matter 第 \d+ 行/);
  const text = message ?? '';
  const trimmed = text.trim();
  expect(trimmed).not.toBe(source.trim());
  expect(trimmed.startsWith('---')).toBe(false);
  expect(/^---\s*\n[\s\S]*\n---\s*$/u.test(trimmed)).toBe(false);
  expect(text).not.toContain('meta: {a: 1}');
}

/* ------------------------------------------------------------------ *
 * 1. front matter
 * ------------------------------------------------------------------ */

describe('front matter 解析', () => {
  it('嵌套的作者列表带机构对应关系', () => {
    const parsed = parseManuscriptFrontMatter(FULL_MANUSCRIPT);
    expect(parsed.present).toBe(true);

    const authors = parsed.meta.authors;
    expect(Array.isArray(authors)).toBe(true);
    const first = (authors as readonly Record<string, unknown>[])[0];
    expect(first?.name).toBe('Jane Smith');
    expect(first?.affiliations).toEqual([1, 2]);
    expect(first?.corresponding).toBe(true);
    expect(first?.email).toBe('jane@example.org');
  });

  it('块标量保留多行', () => {
    const parsed = parseManuscriptFrontMatter(FULL_MANUSCRIPT);
    expect(String(parsed.meta.abstract)).toContain('\n');
    expect(String(parsed.meta.abstract)).toContain('42 participants');
  });

  it('折叠块标量把换行折成空格', () => {
    const parsed = parseManuscriptFrontMatter('---\nnote: >\n  first\n  second\n---\nbody');
    expect(parsed.meta.note).toBe('first second');
  });

  it('流式序列', () => {
    const parsed = parseManuscriptFrontMatter(FULL_MANUSCRIPT);
    expect(parsed.meta.keywords).toEqual(['sleep', 'spindles', 'memory']);
  });

  it('引号里的逗号不当分隔符', () => {
    const parsed = parseManuscriptFrontMatter('---\nfunding: ["NIH R01, part A", NSFC]\n---\n');
    expect(parsed.meta.funding).toEqual(['NIH R01, part A', 'NSFC']);
  });

  it('不做隐式类型转换：no 不变成 false', () => {
    // YAML 会把 no 转成 false（挪威国家代码）。作者姓氏叫 No 时那是数据损坏
    const parsed = parseManuscriptFrontMatter('---\nsurname: No\nversion: 1.10\ncount: 3\n---\n');
    expect(parsed.meta.surname).toBe('No');
    expect(parsed.meta.version).toBe(1.1);
    expect(parsed.meta.count).toBe(3);
  });

  it('前导零保持字符串（那通常是编号）', () => {
    const parsed = parseManuscriptFrontMatter('---\ngrant: 007\n---\n');
    expect(parsed.meta.grant).toBe('007');
  });

  it('URL 里的冒号不当键值分隔', () => {
    const parsed = parseManuscriptFrontMatter(
      '---\ndataAvailability: https://example.org/x\n---\n',
    );
    expect(parsed.meta.dataAvailability).toBe('https://example.org/x');
  });

  it('不支持的语法报错而不是猜', () => {
    // 静默忽略会让用户以为写的东西生效了
    expect(() => parseManuscriptFrontMatter('---\ndefaults: &d\n  a: 1\n---\n')).toThrow(
      FrontMatterError,
    );
    expect(() => parseManuscriptFrontMatter('---\n<<: *defaults\n---\n')).toThrow(/合并键/);
    expect(() => parseManuscriptFrontMatter('---\nmeta: {a: 1}\n---\n')).toThrow(/流式映射/);
  });

  it('Tab 缩进报错', () => {
    expect(() => parseManuscriptFrontMatter('---\nauthors:\n\t- name: X\n---\n')).toThrow(/Tab/);
  });

  it('重复键报错而不是后者覆盖', () => {
    // 覆盖是静默的数据丢失
    expect(() => parseManuscriptFrontMatter('---\ntitle: A\ntitle: B\n---\n')).toThrow(/重复/);
  });

  it('没有 front matter 时返回空元数据而不是报错', () => {
    const parsed = parseManuscriptFrontMatter('# Just a heading\n\nBody text.\n');
    expect(parsed.present).toBe(false);
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toContain('Just a heading');
  });

  it('正文起始行号让定位串能对回原文', () => {
    const parsed = parseManuscriptFrontMatter(FULL_MANUSCRIPT);
    expect(parsed.bodyStartLine).toBeGreaterThan(20);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 文档模型
 * ------------------------------------------------------------------ */

describe('手稿文档模型', () => {
  it('身份字段与非身份字段分开', () => {
    const doc = parseManuscript(FULL_MANUSCRIPT);
    expect(doc.meta.identifying.authors).toHaveLength(3);
    expect(doc.meta.identifying.affiliations).toHaveLength(3);
    expect(doc.meta.identifying.funding).toEqual(['NIH R01-MH123456', 'NSFC 32000000']);
    expect(doc.meta.identifying.grantNumbers).toEqual(['R01-MH123456']);
    expect(doc.meta.identifying.acknowledgements).toContain('sleep laboratory');
    expect(doc.meta.identifying.authorContributions).toContain('J.S.');
    expect(doc.meta.identifying.correspondingEmail).toBe('jane@example.org');

    // 数据与代码可得性不是身份信息，双盲版保留
    expect(doc.meta.statements['Data availability']).toContain('example.org/data');
    expect(doc.meta.statements['Code availability']).toContain('example.org/code');
  });

  it('平等贡献标记被解析', () => {
    const doc = parseManuscript(FULL_MANUSCRIPT);
    expect(doc.meta.identifying.authors.filter((a) => a.equalContribution)).toHaveLength(2);
  });

  it('标量作者列表也能解析（不写机构的最简形式）', () => {
    const doc = parseManuscript('---\nauthors: [Jane Smith, Bob Jones]\n---\nBody here now.\n');
    expect(doc.meta.identifying.authors.map((a) => a.name)).toEqual(['Jane Smith', 'Bob Jones']);
  });

  it('章节、图、表都被抽出并带行号', () => {
    const doc = parseManuscript(FULL_MANUSCRIPT);
    expect(doc.sections.map((s) => s.title)).toEqual([
      'Introduction',
      'Methods',
      'Results',
      'Discussion',
    ]);
    expect(doc.figures).toHaveLength(1);
    expect(doc.figures[0]?.number).toBe(1);
    expect(doc.figures[0]?.caption).toContain('Analysis pipeline');
    expect(doc.figures[0]?.source).toBe('fig1.png');
    expect(doc.figures[0]?.line).toBeGreaterThan(0);
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0]?.number).toBe(1);
  });

  it('引用标记被抽出，区间被展开', () => {
    const doc = parseManuscript(FULL_MANUSCRIPT);
    const keys = new Set(doc.citations.flatMap((c) => c.keys));
    expect(keys.has('1')).toBe(true);
    expect(keys.has('2')).toBe(true);
    expect(keys.has('3')).toBe(true);
  });

  it('引用标记带所在句子（自引检测要用）', () => {
    const doc = parseManuscript(FULL_MANUSCRIPT);
    const selfCite = doc.citations.find((c) => c.keys.includes('2'));
    expect(selfCite?.sentence).toContain('previous work');
  });

  it('中英字数分别计', () => {
    expect(countWords('one two three')).toBe(3);
    // 中文按字符：按空白分词会得出「一段八百字的中文摘要只有 3 个词」
    expect(countWords('睡眠纺锤波')).toBe(5);
    expect(countWords('睡眠 spindles 研究')).toBe(5);
  });

  it('字数不含代码块、链接目标与引用标记', () => {
    expect(countWords('alpha ```beta gamma``` delta')).toBe(2);
    expect(countWords('see [link](https://example.org/very/long/path) here')).toBe(3);
    expect(countWords('supported by evidence [1,2,3]')).toBe(3);
  });

  it('正文字数不含摘要与参考文献节', () => {
    const doc = parseManuscript(
      '---\nabstract: one two three four five\n---\n' +
        '## Results\n\nsix seven eight\n\n## References\n\n1. nine ten eleven twelve\n',
    );
    // 只算 Results 里的三个词
    expect(doc.counts.body).toBe(3);
    expect(doc.counts.abstract).toBe(5);
  });

  it('代码块里的标题与引用标记不被误认', () => {
    const doc = parseManuscript(
      '## Results\n\n```python\n# Fake Section\nx = data[0]\n```\n\nReal text here.\n',
    );
    expect(doc.sections.map((s) => s.title)).toEqual(['Results']);
    expect(doc.citations).toHaveLength(0);
  });

  it('中文图表标签与全角数字', () => {
    const doc = parseManuscript('## 结果\n\n**图 １**　分析流程。\n\n**表 2**　被试特征。\n');
    expect(doc.figures[0]?.number).toBe(1);
    expect(doc.tables[0]?.number).toBe(2);
  });

  it('缺 front matter 时给出告警', () => {
    const doc = parseManuscript('# Title\n\nBody text goes here.\n');
    expect(doc.hasFrontMatter).toBe(false);
    expect(doc.warnings.some((w) => w.message.includes('双盲'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 期刊档案
 * ------------------------------------------------------------------ */

describe('期刊档案', () => {
  it('按别名匹配，更具体的别名优先', () => {
    // `nature` 不能抢走 `nature communications`
    expect(findJournalProfile('Nature Communications').profile.id).toBe('nature-communications');
    expect(findJournalProfile('Nature').profile.id).toBe('nature');
    expect(findJournalProfile('NeurIPS 2024').profile.id).toBe('neurips');
  });

  it('匹配不到时回落到通用档案，并如实说明没匹配上', () => {
    const found = findJournalProfile('Journal of Very Obscure Studies');
    expect(found.profile.id).toBe('generic');
    expect(found.matched).toBe(false);
  });

  it('空目标回落到通用档案', () => {
    expect(findJournalProfile(null).matched).toBe(false);
    expect(findJournalProfile('  ').profile.id).toBe('generic');
  });

  it('通用档案不施加任何篇幅限制', () => {
    const generic = findJournalProfile('generic').profile;
    expect(generic.limits.bodyWords).toBeNull();
    expect(generic.limits.abstractWords).toBeNull();
  });

  it('每个内置档案都有 note 说明数值来源', () => {
    // 一个记错的字数上限会让作者白删两千字，因此可靠性说明是必要信息
    for (const profile of BUILTIN_JOURNAL_PROFILES) {
      expect(profile.note.length, profile.id).toBeGreaterThan(10);
    }
  });

  it('自定义档案缺字段时用通用档案补', () => {
    const custom = parseJournalProfile({ limits: { bodyWords: 1234 } }, 'mine');
    expect(custom.id).toBe('mine');
    expect(custom.limits.bodyWords).toBe(1234);
    expect(custom.limits.abstractWords).toBeNull();
    expect(custom.citationStyle).toBe('numeric-citation-order');
    expect(custom.note).toContain('用户自定义');
  });

  it('双盲会议档案标了默认双盲', () => {
    expect(findJournalProfile('ICML').profile.doubleBlindByDefault).toBe(true);
    expect(findJournalProfile('Nature').profile.doubleBlindByDefault).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 引用重编号
 * ------------------------------------------------------------------ */

describe('引用重编号', () => {
  it('按正文首次出现顺序编号', () => {
    const doc = parseManuscript('## A\n\nfirst [5]. second [3]. third [5] again.\n');
    const refByKey = new Map<string, RefRecord>();
    const { map } = buildCitationMap({
      citations: doc.citations,
      refByKey,
      style: 'numeric-citation-order',
    });
    // 5 先出现，因此它是 1
    expect(map.get('5')).toBe('1');
    expect(map.get('3')).toBe('2');
  });

  it('作者年份样式输出 (Smith et al., 2023)', () => {
    const ref = addRef({
      author: [{ family: 'Smith' }, { family: 'Jones' }, { family: 'Lee' }],
      issued: { 'date-parts': [[2023]] },
    });
    const doc = parseManuscript('## A\n\nsee [1] for details.\n');
    const { map } = buildCitationMap({
      citations: doc.citations,
      refByKey: new Map([['1', ref]]),
      style: 'author-year',
    });
    expect(map.get('1')).toBe('(Smith et al., 2023)');
  });

  it('两位作者用 &，一位直接给姓', () => {
    const two = addRef({ DOI: '10.1000/a', author: [{ family: 'Smith' }, { family: 'Jones' }] });
    const one = addRef({ DOI: '10.1000/b', author: [{ family: 'Solo' }] });
    const doc = parseManuscript('## A\n\nboth [1] and [2] here.\n');
    const { map } = buildCitationMap({
      citations: doc.citations,
      refByKey: new Map([
        ['1', two],
        ['2', one],
      ]),
      style: 'author-year',
    });
    expect(map.get('1')).toContain('&');
    expect(map.get('2')).toBe('(Solo, 2020)');
  });

  it('找不到的键仍出现在映射里，正文标记不会变空白', () => {
    const doc = parseManuscript('## A\n\ncited [99] here.\n');
    const { map } = buildCitationMap({
      citations: doc.citations,
      refByKey: new Map(),
      style: 'numeric-citation-order',
    });
    expect(map.has('99')).toBe(true);
  });

  it('重编号后的连续区间被合并，且顺序正确', () => {
    for (let i = 1; i <= 5; i += 1) addRef({ DOI: `10.1000/${String(i)}` });
    const doc = parseManuscript('## A\n\nfirst [3,1,2]. then [5].\n');
    const result = compileManuscript(doc, {
      profile: findJournalProfile('generic').profile,
      refs: refsRepo.list({ limit: 10 }),
    });
    // 3 先出现 → 1；1 → 2；2 → 3。合成 [1-3]
    expect(result.content).toContain('[1-3]');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 检查
 * ------------------------------------------------------------------ */

describe('编译检查', () => {
  function compile(markdown: string, journal = 'generic', blinded = false) {
    const found = findJournalProfile(journal);
    return compileManuscript(parseManuscript(markdown), {
      profile: found.profile,
      profileMatched: found.matched,
      blinded,
      refs: refsRepo.list({ limit: 100 }),
    });
  }

  it('字数超限报警但不改稿', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${String(i)}`).join(' ');
    const result = compile(
      `---\nabstract: ${long}\njournal: Nature\n---\n\n## Main\n\nx.\n`,
      'Nature',
    );
    const lengthIssues = result.issues.filter((i) => i.category === 'length');
    expect(lengthIssues.length).toBeGreaterThan(0);
    expect(lengthIssues[0]?.message).toContain('摘要');
    // 自动删字会毁掉论证
    expect(result.content).toContain('word199');
  });

  it('字数提示说明上限来自档案而不是断言该刊规则', () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${String(i)}`).join(' ');
    const result = compile(`---\nabstract: ${long}\n---\n## Main\n\nx.\n`, 'Nature');
    const issue = result.issues.find((i) => i.category === 'length');
    expect(issue?.remedy).toContain('核对官方要求');
  });

  it('图编号重复报 error', () => {
    const result = compile(
      '## Results\n\nSee Figure 1 and Figure 2.\n\n**Figure 1.** a\n\n**Figure 1.** b\n',
    );
    const issue = result.issues.find((i) => i.message.includes('出现了 2 次'));
    expect(issue?.severity).toBe('error');
  });

  it('图编号缺号报 error', () => {
    const result = compile(
      '## Results\n\nSee Figure 1 and Figure 3.\n\n**Figure 1.** a\n\n**Figure 3.** c\n',
    );
    expect(result.issues.some((i) => i.message.includes('缺 2'))).toBe(true);
  });

  it('图表在正文里从未被引用时报警', () => {
    const result = compile(
      '## Results\n\nNo mention of any display item here.\n\n**Figure 1.** a\n',
    );
    const issue = result.issues.find((i) => i.message.includes('从未被引用'));
    expect(issue?.severity).toBe('warn');
    expect(issue?.remedy).toContain('删了一段正文');
  });

  it('编号顺序与正文出现顺序不一致时报警', () => {
    const result = compile(
      '## Results\n\nSee Figure 1 and Figure 2.\n\n**Figure 2.** b\n\n**Figure 1.** a\n',
    );
    expect(result.issues.some((i) => i.message.includes('编号与正文出现顺序不一致'))).toBe(true);
  });

  it('图题为空时报警', () => {
    const result = compile('## Results\n\nSee Figure 1.\n\n**Figure 1.**\n');
    expect(result.issues.some((i) => i.message.includes('没有图题'))).toBe(true);
  });

  it('正文引用了库里没有的条目报 error', () => {
    const result = compile('## A\n\nSupported by prior work [42].\n');
    const issue = result.issues.find((i) => i.category === 'citation' && i.severity === 'error');
    expect(issue?.message).toContain('42');
    expect(issue?.remedy).toContain('manage_references');
  });

  it('引用了撤稿文献报 error', () => {
    addRef({ DOI: '10.1000/retracted', extra: { retracted: true }, title: 'A retracted study' });
    const result = compile('## A\n\nAs shown before [1].\n');
    const issue = result.issues.find((i) => i.message.includes('撤稿'));
    expect(issue?.severity).toBe('error');
  });

  it('章节顺序不符只报 info 且明说不重排', () => {
    const result = compile(
      '---\njournal: Nature Communications\n---\n## Results\n\nx.\n\n## Introduction\n\ny.\n',
      'Nature Communications',
    );
    const issue = result.issues.find(
      (i) => i.category === 'structure' && i.message.includes('之前'),
    );
    expect(issue?.severity).toBe('info');
    expect(issue?.remedy).toContain('不重排是刻意的');
  });

  it('要求结构化摘要的档案在摘要没小标题时报警', () => {
    const result = compile(
      '---\nabstract: A plain abstract without headings.\n---\n## Main\n\nx.\n',
      'BMJ',
    );
    expect(result.issues.some((i) => i.message.includes('摘要里没有小标题'))).toBe(true);
  });

  it('结构化摘要满足要求时不报', () => {
    const result = compile(
      '---\nabstract: "Background: x. Methods: y. Results: z. Conclusions: w."\n---\n## Main\n\nq.\n',
      'BMJ',
    );
    // 不能只查「结构化摘要」四个字：BMJ 档案的名字本身就叫「医学类（结构化摘要）」，
    // 而它会出现在「缺少 Ethics approval 声明（BMJ / 医学类（结构化摘要））要求」里
    expect(result.issues.some((i) => i.message.includes('摘要里没有小标题'))).toBe(false);
  });

  it('缺必需声明时报警', () => {
    const result = compile('---\ntitle: X\n---\n## Main\n\nx.\n', 'Nature');
    expect(result.issues.some((i) => i.message.includes('Data availability'))).toBe(true);
  });

  it('声明已在 front matter 里时不报', () => {
    const result = compile(
      '---\ntitle: X\ndataAvailability: at example.org\ncodeAvailability: at example.org\ncompetingInterests: none\n---\n## Main\n\nx.\n',
      'Nature',
    );
    expect(result.issues.some((i) => i.message.includes('Data availability'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 6. 双盲
 * ------------------------------------------------------------------ */

describe('双盲送审版', () => {
  function compileBlinded(blinded = true) {
    const found = findJournalProfile('Nature Communications');
    return compileManuscript(parseManuscript(FULL_MANUSCRIPT), {
      profile: found.profile,
      profileMatched: found.matched,
      blinded,
      refs: refsRepo.list({ limit: 100 }),
    });
  }

  it('身份字段整组从输出里消失', () => {
    const result = compileBlinded();
    expect(result.blinded).toBe(true);

    for (const secret of [
      'Jane Smith',
      'Bob Jones',
      'Wei Zhang',
      'jane@example.org',
      'Department of Neuroscience',
      'NIH R01-MH123456',
      'R01-MH123456',
      'sleep laboratory',
      'J.S. designed',
    ]) {
      expect(result.content, secret).not.toContain(secret);
    }
  });

  it('非身份声明保留', () => {
    const result = compileBlinded();
    expect(result.content).toContain('example.org/data');
    expect(result.content).toContain('example.org/code');
  });

  it('平等贡献标记保留（它不泄露身份）', () => {
    const result = compileBlinded();
    expect(result.content).toContain('equalContributionCount: 2');
  });

  it('移除清单逐项列出，用户能核对删对了没有', () => {
    const result = compileBlinded();
    // 「已处理」这句话核对不了任何东西
    expect(result.removedFields.join(' ')).toContain('Jane Smith');
    expect(result.removedFields.join(' ')).toContain('affiliations');
    expect(result.removedFields.join(' ')).toContain('acknowledgements');
    expect(result.removedFields.join(' ')).toContain('R01-MH123456');
    expect(result.removedFields.join(' ')).toContain('authorContributions');
  });

  it('正文一个字都没改', () => {
    const blinded = compileBlinded(true);
    const normal = compileBlinded(false);
    const bodyOf = (text: string): string => text.slice(text.lastIndexOf('---') + 3);
    // 双盲版的正文与正式版逐字相同（引用重编号在两版里一样）
    expect(bodyOf(blinded.content).replace(BLINDING_DISCLAIMER, '').trim()).toBe(
      bodyOf(normal.content).trim(),
    );
  });

  it('需求 13.8：局限说明同时在输出文件与报告里', () => {
    const result = compileBlinded();
    // 只放文件里的话，界面上看报告的用户看不到；只放报告里的话，
    // 把文件发给合作者时那句话就丢了
    expect(result.content).toContain('对正文里的隐式身份线索不作任何保证');
    expect(result.report).toContain('正文一个字都没改');
    expect(result.report).toContain('隐式身份线索');
  });

  it('局限说明列出了需要人工检查的具体项', () => {
    const result = compileBlinded();
    for (const item of ['伦理批号', '水印', '代码仓库']) {
      expect(result.content, item).toContain(item);
    }
  });

  it('正式版保留全部身份信息', () => {
    const result = compileBlinded(false);
    expect(result.content).toContain('Jane Smith');
    expect(result.content).toContain('NIH R01-MH123456');
    expect(result.removedFields).toHaveLength(0);
    expect(result.content).not.toContain(BLINDING_DISCLAIMER);
  });

  it('front matter 里没有身份信息时如实说明而不是假装处理了', () => {
    const found = findJournalProfile('generic');
    const result = compileManuscript(parseManuscript('## A\n\nBody text here now.\n'), {
      profile: found.profile,
      blinded: true,
    });
    expect(result.report).toContain('没有移除任何字段');
    expect(result.report).toContain('元数据还没写');
  });
});

/* ------------------------------------------------------------------ *
 * 7. 自引泄露（需求 13.7）
 * ------------------------------------------------------------------ */

describe('自引身份泄露检测', () => {
  it('自我指代措辞 + 作者交集 → 报告', () => {
    const own = addRef({
      DOI: '10.1000/own',
      author: [{ family: 'Smith', given: 'Jane' }, { family: 'Other' }],
      title: 'Our earlier spindle study',
    });
    const doc = parseManuscript(
      '---\nauthors: [Jane Smith, Bob Jones]\n---\n## A\n\nOur previous work showed this [1].\n',
    );
    const leaks = detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own]]) });

    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.phrase).toBe('our previous work');
    expect(leaks[0]?.sharedAuthors).toContain('Smith');
    expect(leaks[0]?.citedWork).toContain('earlier spindle study');
  });

  it('有措辞但作者无交集 → 不报', () => {
    // 「our previous work」后面引的可能确实是合作者独立发表的
    const other = addRef({ DOI: '10.1000/other', author: [{ family: 'Nobody' }] });
    const doc = parseManuscript(
      '---\nauthors: [Jane Smith]\n---\n## A\n\nOur previous work showed this [1].\n',
    );
    expect(detectSelfCitationLeaks({ doc, refByKey: new Map([['1', other]]) })).toHaveLength(0);
  });

  it('有作者交集但无自我指代措辞 → 不报', () => {
    // 引自己的文献本身完全正常，双盲送审也允许
    const own = addRef({ DOI: '10.1000/own', author: [{ family: 'Smith' }] });
    const doc = parseManuscript(
      '---\nauthors: [Jane Smith]\n---\n## A\n\nEarlier studies found this [1].\n',
    );
    expect(detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own]]) })).toHaveLength(0);
  });

  it('中文自我指代措辞', () => {
    const own = addRef({ DOI: '10.1000/own', author: [{ family: '张' }] });
    const doc = parseManuscript(
      '---\nauthors: [张伟]\n---\n## 结果\n\n我们此前的工作已经证明了这一点 [1]。\n',
    );
    const leaks = detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own]]) });
    expect(leaks).toHaveLength(0);

    // 中文姓名整体作为姓氏，因此要 csl 里也是整体才匹配
    const own2 = addRef({ DOI: '10.1000/own2', author: [{ family: '张伟' }] });
    const leaks2 = detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own2]]) });
    expect(leaks2).toHaveLength(1);
    expect(leaks2[0]?.phrase).toBe('我们此前');
  });

  it('同一句里多个引用只报一次', () => {
    const own = addRef({ DOI: '10.1000/a', author: [{ family: 'Smith' }] });
    const own2 = addRef({ DOI: '10.1000/b', author: [{ family: 'Smith' }] });
    const doc = parseManuscript(
      '---\nauthors: [Jane Smith]\n---\n## A\n\nWe previously showed this [1] and that [2].\n',
    );
    expect(
      detectSelfCitationLeaks({
        doc,
        refByKey: new Map([
          ['1', own],
          ['2', own2],
        ]),
      }),
    ).toHaveLength(1);
  });

  it('没有作者信息时不报（没有比对基准）', () => {
    const own = addRef({ DOI: '10.1000/own', author: [{ family: 'Smith' }] });
    const doc = parseManuscript('## A\n\nOur previous work showed this [1].\n');
    expect(detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own]]) })).toHaveLength(0);
  });

  it('双盲版下自引泄露是 error，正式版下是 warn', () => {
    addRef({ DOI: '10.1000/own', author: [{ family: 'Smith', given: 'Jane' }] });
    const md = '---\nauthors: [Jane Smith]\n---\n## A\n\nOur previous work showed this [1].\n';
    const profile = findJournalProfile('generic').profile;

    const blinded = compileManuscript(parseManuscript(md), {
      profile,
      blinded: true,
      refs: refsRepo.list({ limit: 10 }),
    });
    const normal = compileManuscript(parseManuscript(md), {
      profile,
      blinded: false,
      refs: refsRepo.list({ limit: 10 }),
    });

    expect(blinded.issues.find((i) => i.category === 'blinding')?.severity).toBe('error');
    expect(normal.issues.find((i) => i.category === 'blinding')?.severity).toBe('warn');
    expect(blinded.report).toContain('自引身份泄露');
  });

  it('姓氏提取：三种格式', () => {
    expect(surnameOf('Jane Smith')).toBe('Smith');
    expect(surnameOf('Smith, Jane')).toBe('Smith');
    // 中文名整体作为姓氏：按最后一个字取姓是错的
    expect(surnameOf('张伟')).toBe('张伟');
    expect(surnameOf('  ')).toBe('');
  });

  it('重音差异不影响作者匹配', () => {
    const own = addRef({ DOI: '10.1000/own', author: [{ family: 'Muller' }] });
    const doc = parseManuscript(
      '---\nauthors: [Hans Müller]\n---\n## A\n\nOur previous work showed this [1].\n',
    );
    expect(detectSelfCitationLeaks({ doc, refByKey: new Map([['1', own]]) })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 8. 编译服务
 * ------------------------------------------------------------------ */

describe('编译服务', () => {
  it('编译产出制品并记编译历史', async () => {
    addRef({ DOI: '10.1000/a' });
    const outcome = await compiler().compile({ markdown: FULL_MANUSCRIPT });

    expect(outcome.ok).toBe(true);
    expect(outcome.outputs).toHaveLength(1);
    const output = outcome.outputs[0];
    expect(output?.blinded).toBe(false);

    const content = artifacts.readVersion(output?.versionId ?? '')?.toString('utf8') ?? '';
    expect(content).toContain('Sleep spindles predict');

    const runs = manuscriptRepo.compileRuns(outcome.manuscript?.id ?? '');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.profileId).toBe('nature-communications');
    expect(runs[0]?.report).toContain('格式档案');
  });

  it('both 同时产出正式版与双盲版', async () => {
    const outcome = await compiler().compile({ markdown: FULL_MANUSCRIPT, both: true });
    expect(outcome.outputs).toHaveLength(2);
    expect(outcome.outputs.map((o) => o.blinded).sort()).toEqual([false, true]);

    // 两版分列存放：共用一列会让「上次编的是哪个版本」不可知
    const manuscript = manuscriptRepo.get(outcome.manuscript?.id ?? '');
    expect(manuscript?.compiledVersionId).not.toBeNull();
    expect(manuscript?.blindedVersionId).not.toBeNull();
    expect(manuscript?.compiledVersionId).not.toBe(manuscript?.blindedVersionId);
  });

  it('参考文献落成单独的制品', async () => {
    addRef({ DOI: '10.1000/a', title: 'Cited paper one' });
    const outcome = await compiler().compile({ markdown: FULL_MANUSCRIPT });
    const output = outcome.outputs[0];
    expect(output?.bibVersionId).not.toBeNull();
    const bib = artifacts.readVersion(output?.bibVersionId ?? '')?.toString('utf8') ?? '';
    expect(bib).toContain('@article');
  });

  it('从制品版本读源稿并建立血缘', async () => {
    const saved = artifacts.save({
      filename: 'draft.md',
      content: Buffer.from(FULL_MANUSCRIPT, 'utf8'),
    });
    const outcome = await compiler().compile({ sourceVersionId: saved.version.id });

    expect(outcome.ok).toBe(true);
    const compiled = artifacts.getVersion(outcome.outputs[0]?.versionId ?? '');
    expect(compiled?.codeLineage?.inputVersionIds).toContain(saved.version.id);
  });

  it('同一份源稿制品重复编译复用同一条手稿记录', async () => {
    const saved = artifacts.save({
      filename: 'draft.md',
      content: Buffer.from(FULL_MANUSCRIPT, 'utf8'),
    });
    const c = compiler();
    const first = await c.compile({ sourceVersionId: saved.version.id });
    const second = await c.compile({ sourceVersionId: saved.version.id });
    expect(second.manuscript?.id).toBe(first.manuscript?.id);
    expect(manuscriptRepo.compileRuns(first.manuscript?.id ?? '')).toHaveLength(2);
  });

  it('默认双盲的档案在未指定时自动出双盲版', async () => {
    const outcome = await compiler().compile({
      markdown: FULL_MANUSCRIPT,
      targetJournal: 'NeurIPS',
    });
    expect(outcome.outputs[0]?.blinded).toBe(true);
  });

  it('显式指定 blinded=false 覆盖档案默认', async () => {
    const outcome = await compiler().compile({
      markdown: FULL_MANUSCRIPT,
      targetJournal: 'NeurIPS',
      blinded: false,
    });
    expect(outcome.outputs[0]?.blinded).toBe(false);
  });

  it('没有源稿时给出可执行的下一步', async () => {
    const outcome = await compiler().compile({});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('sourceVersionId');
  });

  it('不存在的制品版本如实报错', async () => {
    const outcome = await compiler().compile({ sourceVersionId: 'av_nope' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('不存在');
  });

  it('front matter 语法错误时报错并说明支持范围', async () => {
    const markdown = '---\nmeta: {a: 1}\n---\nbody\n';
    const outcome = await compiler().compile({ markdown });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('受限的 YAML 子集');
    assertFrontMatterLineUi(outcome.reason, markdown);

    const parsed = compiler().parse({ markdown });
    expect(parsed.ok).toBe(false);
    assertFrontMatterLineUi(parsed.reason, markdown);

    const tool = createCompileManuscriptTool({ compiler });
    const compiled = await tool.execute(
      { action: 'compile', markdown },
      { projectId: 'p', conversationId: 'c', workspaceDir: root },
    );
    expect(compiled.ok).toBe(false);
    expect(compiled.output.kind).toBe('error');
    if (compiled.output.kind === 'error') {
      assertFrontMatterLineUi(compiled.output.evalue, markdown);
    }

    const parsedTool = await tool.execute(
      { action: 'parse', markdown },
      { projectId: 'p', conversationId: 'c', workspaceDir: root },
    );
    expect(parsedTool.ok).toBe(false);
    expect(parsedTool.output.kind).toBe('error');
    if (parsedTool.output.kind === 'error') {
      assertFrontMatterLineUi(parsedTool.output.evalue, markdown);
    }
  });

  it('解开把整份 YAML stringify 进去的包装错误', () => {
    const inner = new FrontMatterError('不支持流式映射 {}，请用缩进写法', 2);
    const dumped = '---\nmeta: {a: 1}\n---\n';
    const wrapped = new Error(JSON.stringify({ yaml: dumped }), { cause: inner });
    assertFrontMatterLineUi(frontMatterErrorMessage(wrapped), dumped);
  });

  it('编译前触发审查', async () => {
    // 会话必须真实存在：manuscripts.conversation_id 有外键，而 foreign_keys 是开着的。
    // 传一个编造的 id 会让手稿记录写入失败——那是正确行为
    const conversation = project.conversations.create({ title: '编译会话' });
    const triggered: string[] = [];
    const c = new ManuscriptCompiler({
      repo: manuscriptRepo,
      artifacts,
      refs: () => [],
      onBeforeCompile: ({ manuscriptId }) => {
        triggered.push(manuscriptId);
      },
    });
    const outcome = await c.compile({
      markdown: FULL_MANUSCRIPT,
      conversationId: conversation.id,
    });
    expect(outcome.ok).toBe(true);
    expect(triggered).toHaveLength(1);
  });

  it('审查触发失败不让编译失败', async () => {
    const conversation = project.conversations.create({ title: '编译会话' });
    const c = new ManuscriptCompiler({
      repo: manuscriptRepo,
      artifacts,
      refs: () => [],
      onBeforeCompile: () => {
        throw new Error('审查服务挂了');
      },
    });
    const outcome = await c.compile({
      markdown: FULL_MANUSCRIPT,
      conversationId: conversation.id,
    });
    // 编译本身是纯粹的格式处理，不该被审查触发失败带下去
    expect(outcome.ok).toBe(true);
  });

  it('parse 只解析不产生制品', () => {
    const before = artifacts.listArtifacts().length;
    const parsed = compiler().parse({ markdown: FULL_MANUSCRIPT });
    expect(parsed.ok).toBe(true);
    expect(parsed.doc?.meta.identifying.authors).toHaveLength(3);
    expect(artifacts.listArtifacts().length).toBe(before);
  });

  it('界面贴进来的 markdown 存成源稿，重开能读回', async () => {
    const c = compiler();
    const outcome = await c.compile({ markdown: FULL_MANUSCRIPT });
    const id = outcome.manuscript?.id ?? '';
    // 没有这一步，手稿记录里的 sourceVersionId 是空的，UI 重开时正文就是空的
    expect(outcome.manuscript?.sourceVersionId).not.toBeNull();
    expect(c.readSourceText(id)).toContain('Sleep spindles predict overnight memory consolidation');
  });

  it('趋势按时间正序返回，用于判断收敛还是发散', async () => {
    const c = compiler();
    const first = await c.compile({ markdown: '## A\n\nCited [99] here.\n' });
    const manuscriptId = first.manuscript?.id ?? '';
    // 第二次把坏引用去掉：问题数应当下降
    await c.compile({ manuscriptId, markdown: '## A\n\nNo citations here at all.\n' });

    const trend = manuscriptRepo.trend(manuscriptId);
    expect(trend).toHaveLength(2);
    expect(trend[1]?.errors).toBeLessThanOrEqual(trend[0]?.errors ?? 0);
  });

  it('删手稿时编译记录级联删除', async () => {
    const outcome = await compiler().compile({ markdown: FULL_MANUSCRIPT });
    const id = outcome.manuscript?.id ?? '';
    expect(manuscriptRepo.compileRuns(id).length).toBeGreaterThan(0);
    manuscriptRepo.delete(id);
    expect(manuscriptRepo.compileRuns(id)).toHaveLength(0);
  });
});
