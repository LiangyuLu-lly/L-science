/**
 * 引用导出测试（任务 13.3，需求 12.5）。
 *
 * 四块重点：
 *
 * 1. **三种格式的引用键必须一致**。这是最重要的不变量：手稿在 pandoc（读 CSL-JSON）
 *    与 LaTeX（读 .bib）之间切换时全部引用都靠它。不一致的表现是
 *    `Citation undefined`，而 LaTeX 不会说出原因。
 * 2. **CSL-JSON 的合规性**。非标准字段必须进 `custom`，塞在顶层会让严格的 CSL
 *    处理器整条跳过，而「参考文献列表里少一条」很难被发现。
 * 3. **RIS 的格式细节**。标签宽度、CRLF、ER 结尾写错任何一条，多数导入器会静默
 *    丢掉整条记录。
 * 4. **数据缺陷警告**。导出是用户最后一次能看见这些问题的机会；之后 LaTeX 会
 *    静默输出畸形引用。撤稿必须报——那是唯一一条「结论会错」而不是「格式会错」的。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  EXPORT_FORMAT_EXT,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMAT_MIME,
  RefLibrary,
  RefsRepo,
  assignKeys,
  bibtexKeyFor,
  checkExportQuality,
  exportRefs,
  inferKind,
  renderExportWarnings,
  toCslJsonFile,
  toCslJsonItem,
  toRisFile,
  type CslItem,
  type ExportFormat,
  type ProjectStore,
  type RefRecord,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let repo: RefsRepo;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-exp-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '导出测试' });
  project = store.openProject(created.id);
  repo = new RefsRepo(project.db);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

function csl(overrides: Partial<CslItem> = {}): CslItem {
  return {
    id: 'x',
    type: 'article-journal',
    title: 'Sleep spindles and memory consolidation',
    author: [
      { family: 'Smith', given: 'John' },
      { family: 'Jones', given: 'Alice' },
    ],
    issued: { 'date-parts': [[2023, 5, 12]] },
    'container-title': 'Journal of Sleep Research',
    volume: '32',
    issue: '2',
    page: '100-110',
    DOI: '10.1111/jsr.13000',
    ISSN: ['0962-1105'],
    ...overrides,
  };
}

function addRef(overrides: Partial<CslItem> = {}): RefRecord {
  return repo.add({ csl: csl(overrides), source: 'test' });
}

function library(): RefLibrary {
  return new RefLibrary({ repo, artifacts });
}

/* ------------------------------------------------------------------ *
 * 1. 引用键
 * ------------------------------------------------------------------ */

describe('引用键', () => {
  it('形式是姓氏 + 年份 + 标题首个实词', () => {
    const ref = addRef();
    expect(bibtexKeyFor(ref)).toBe('smith2023sleep');
  });

  it('跳过标题开头的停用词', () => {
    const ref = addRef({ DOI: '10.1000/a', title: 'The effects of sleep on memory' });
    expect(bibtexKeyFor(ref)).toBe('smith2023effects');
  });

  it('缺姓氏与年份时退回记录 id，仍然唯一', () => {
    const ref = repo.add({
      csl: { id: 'y', type: 'document', title: '之' },
      source: 'test',
    });
    const key = bibtexKeyFor(ref);
    expect(key).not.toBe('');
    expect(key.startsWith('ref')).toBe(true);
  });

  it('冲突时加字母后缀而不是数字', () => {
    // 数字后缀与年份在视觉上区分不开（smith2023sleep2）
    const a = addRef({ DOI: '10.1000/a' });
    const b = addRef({ DOI: '10.1000/b' });
    const keys = assignKeys([a, b]).map((k) => k.key);
    expect(keys).toEqual(['smith2023sleep', 'smith2023sleepa']);
  });

  it('同一批同一顺序得到同一组键（后缀不会换人）', () => {
    const a = addRef({ DOI: '10.1000/a' });
    const b = addRef({ DOI: '10.1000/b' });
    const first = assignKeys([a, b]);
    const second = assignKeys([a, b]);
    expect(second.map((k) => k.key)).toEqual(first.map((k) => k.key));
    expect(second[0]?.ref.id).toBe(first[0]?.ref.id);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 三种格式共用同一套键
 * ------------------------------------------------------------------ */

describe('跨格式一致性', () => {
  it('三种格式的引用键完全一致', () => {
    const refs = [
      addRef({ DOI: '10.1000/a' }),
      addRef({ DOI: '10.1000/b', title: 'Another study of dreams', author: [{ family: 'Lee' }] }),
      addRef({ DOI: '10.1000/c', title: 'Third paper about spindles' }),
    ];

    const results = (['bibtex', 'csl-json', 'ris'] as const).map((format) =>
      exportRefs(refs, { format }),
    );

    expect(results[0]?.keys).toEqual(results[1]?.keys);
    expect(results[1]?.keys).toEqual(results[2]?.keys);

    // 键真的出现在各自的文件里
    for (const key of results[0]?.keys ?? []) {
      expect(results[0]?.content).toContain(`{${key},`);
      expect(results[1]?.content).toContain(`"id": "${key}"`);
      expect(results[2]?.content).toContain(`ID  - ${key}`);
    }
  });

  it('条目数与顺序一致', () => {
    const refs = [addRef({ DOI: '10.1000/a' }), addRef({ DOI: '10.1000/b', title: 'Zebra study' })];
    for (const format of ['bibtex', 'csl-json', 'ris'] as const) {
      const result = exportRefs(refs, { format });
      expect(result.entryCount).toBe(2);
      expect(result.keys).toHaveLength(2);
    }
  });

  it('默认按引用键排序，让两次导出的 diff 可读', () => {
    const zebra = addRef({ DOI: '10.1000/z', author: [{ family: 'Zebra' }], title: 'Zzz' });
    const alpha = addRef({ DOI: '10.1000/a', author: [{ family: 'Alpha' }], title: 'Aaa' });
    const result = exportRefs([zebra, alpha], { format: 'bibtex' });
    expect(result.keys[0]?.startsWith('alpha')).toBe(true);
  });

  it('排序选项生效', () => {
    const old = addRef({ DOI: '10.1000/a', issued: { 'date-parts': [[2010]] } });
    const recent = addRef({ DOI: '10.1000/b', issued: { 'date-parts': [[2024]] }, title: 'Newer' });
    const desc = exportRefs([old, recent], { format: 'bibtex', sort: 'year-desc' });
    expect(desc.keys[0]).toContain('2024');
  });

  it('文件名与 MIME 按格式给对', () => {
    const refs = [addRef()];
    expect(exportRefs(refs, { format: 'bibtex' }).filename).toBe('references.bib');
    expect(exportRefs(refs, { format: 'csl-json' }).filename).toBe('references.csl.json');
    expect(exportRefs(refs, { format: 'ris' }).filename).toBe('references.ris');
    expect(exportRefs(refs, { format: 'bibtex' }).mime).toBe(EXPORT_FORMAT_MIME.bibtex);
  });

  it('自定义文件名被清洗但保留可读部分', () => {
    const result = exportRefs([addRef()], { format: 'bibtex', stem: '我的 论文/refs' });
    expect(result.filename.endsWith('.bib')).toBe(true);
    expect(result.filename).not.toContain('/');
  });

  it('格式表三项齐全', () => {
    for (const format of ['bibtex', 'csl-json', 'ris'] as ExportFormat[]) {
      expect(EXPORT_FORMAT_LABEL[format]).toBeTruthy();
      expect(EXPORT_FORMAT_EXT[format]).toBeTruthy();
      expect(EXPORT_FORMAT_MIME[format]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. CSL-JSON
 * ------------------------------------------------------------------ */

describe('CSL-JSON 导出', () => {
  it('标准字段原样输出', () => {
    const item = toCslJsonItem(csl(), 'smith2023sleep');
    expect(item.id).toBe('smith2023sleep');
    expect(item.type).toBe('article-journal');
    expect(item.title).toBe('Sleep spindles and memory consolidation');
    expect(item['container-title']).toBe('Journal of Sleep Research');
    expect(item.volume).toBe('32');
    expect(item.page).toBe('100-110');
    expect(item.DOI).toBe('10.1111/jsr.13000');
    expect(item.issued).toEqual({ 'date-parts': [[2023, 5, 12]] });
    expect(item.author).toHaveLength(2);
  });

  it('非标准字段进 custom 的私有命名空间，不平铺', () => {
    const item = toCslJsonItem(
      csl({ extra: { retracted: true, citedByCount: 42, oaStatus: 'gold' } }),
      'k',
    );
    // 顶层不能出现自定义键：严格的 CSL 处理器会整条跳过
    expect(item.extra).toBeUndefined();
    expect(item.retracted).toBeUndefined();
    expect(item.custom).toEqual({
      'l-science': { retracted: true, citedByCount: 42, oaStatus: 'gold' },
    });
  });

  it('撤稿同时进 note：custom 是给程序读的，note 才会被渲染', () => {
    const item = toCslJsonItem(csl({ extra: { retracted: true } }), 'k');
    expect(String(item.note)).toContain('RETRACTED');
  });

  it('preprint 在 note 里标注', () => {
    const item = toCslJsonItem(
      { id: 'x', type: 'article', title: 'A preprint', DOI: '10.1101/x' },
      'k',
    );
    expect(String(item.note)).toContain('Preprint');
  });

  it('摘要默认不输出，显式要求时才有', () => {
    const withAbstract = csl({ abstract: '一段摘要' });
    expect(toCslJsonItem(withAbstract, 'k').abstract).toBeUndefined();
    expect(toCslJsonItem(withAbstract, 'k', { includeAbstract: true }).abstract).toBe('一段摘要');
  });

  it('空字符串与空数组不输出', () => {
    const item = toCslJsonItem({ id: 'x', type: 'book', title: '', ISSN: [] }, 'k');
    expect(item.title).toBeUndefined();
    expect(item.ISSN).toBeUndefined();
  });

  it('输出是合法 JSON 数组且缩进两格', () => {
    const file = toCslJsonFile([{ csl: csl(), key: 'k' }]);
    const parsed = JSON.parse(file) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    // 缩进让新增一条文献的 diff 只有那一条
    expect(file).toContain('\n  {\n');
  });

  it('extra 为空时不输出 custom', () => {
    const item = toCslJsonItem(csl(), 'k');
    expect(item.custom).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 4. RIS
 * ------------------------------------------------------------------ */

describe('RIS 导出', () => {
  it('标签格式是两字符 + 两空格 + 短横 + 空格', () => {
    const file = toRisFile([{ csl: csl(), key: 'k' }]);
    expect(file).toContain('TY  - JOUR');
    expect(file).toContain('AU  - Smith, John');
    expect(file).toContain('TI  - Sleep spindles and memory consolidation');
    expect(file).toContain('JO  - Journal of Sleep Research');
    expect(file).toContain('DO  - 10.1111/jsr.13000');
  });

  it('TY 是第一行，ER 是最后一行', () => {
    const file = toRisFile([{ csl: csl(), key: 'k' }]);
    const lines = file.split('\r\n');
    expect(lines[0]).toBe('TY  - JOUR');
    expect(lines.filter((l) => l.startsWith('ER'))).toHaveLength(1);
    expect(lines[lines.length - 2]).toBe('ER  - ');
  });

  it('用 CRLF 换行：EndNote 与投稿系统按 CRLF 切行', () => {
    const file = toRisFile([{ csl: csl(), key: 'k' }]);
    expect(file).toContain('\r\n');
    // 不能出现裸 LF
    expect(/[^\r]\n/u.test(file)).toBe(false);
  });

  it('页码拆成 SP 与 EP', () => {
    const file = toRisFile([{ csl: csl({ page: '583-589' }), key: 'k' }]);
    expect(file).toContain('SP  - 583');
    expect(file).toContain('EP  - 589');
  });

  it('单页时只有 SP', () => {
    const file = toRisFile([{ csl: csl({ page: 'e4375' }), key: 'k' }]);
    expect(file).toContain('SP  - e4375');
    expect(file).not.toContain('EP  -');
  });

  it('书章与会议论文的容器名走 T2 而不是 JO', () => {
    const chapter = toRisFile([
      { csl: csl({ type: 'chapter', 'container-title': 'Handbook of Sleep' }), key: 'k' },
    ]);
    expect(chapter).toContain('TY  - CHAP');
    expect(chapter).toContain('T2  - Handbook of Sleep');
    expect(chapter).not.toContain('JO  -');

    const conf = toRisFile([
      { csl: csl({ type: 'paper-conference', 'container-title': 'Proceedings of KDD' }), key: 'k' },
    ]);
    expect(conf).toContain('TY  - CONF');
    expect(conf).toContain('T2  - Proceedings of KDD');
  });

  it('值里的换行被折成空格：RIS 的值不能跨行', () => {
    const file = toRisFile([{ csl: csl({ abstract: '第一行\n第二行' }), key: 'k' }]);
    expect(file).toContain('AB  - 第一行 第二行');
  });

  it('日期用 YYYY/MM/DD/ 形式', () => {
    const file = toRisFile([{ csl: csl(), key: 'k' }]);
    expect(file).toContain('PY  - 2023');
    expect(file).toContain('DA  - 2023/05/12/');
  });

  it('撤稿与 PMID 进 N1', () => {
    const file = toRisFile([
      { csl: csl({ extra: { retracted: true }, PMID: '123456' }), key: 'k' },
    ]);
    expect(file).toContain('N1  -');
    expect(file).toContain('RETRACTED');
    expect(file).toContain('PMID: 123456');
  });

  it('机构作者原样一行', () => {
    const file = toRisFile([
      { csl: csl({ author: [{ literal: 'World Health Organization' }] }), key: 'k' },
    ]);
    expect(file).toContain('AU  - World Health Organization');
  });

  it('多条记录之间空一行', () => {
    const file = toRisFile([
      { csl: csl({ DOI: '10.1000/a' }), key: 'a' },
      { csl: csl({ DOI: '10.1000/b' }), key: 'b' },
    ]);
    expect(file).toContain('ER  - \r\n\r\nTY  - JOUR');
  });

  it('未知类型落到 GEN 而不是丢掉', () => {
    const file = toRisFile([{ csl: { id: 'x', type: 'document', title: 'X' }, key: 'k' }]);
    expect(file).toContain('TY  - GEN');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 数据缺陷警告
 * ------------------------------------------------------------------ */

describe('导出体检', () => {
  it('撤稿排在最前并说明该怎么办', () => {
    const ref = addRef({ extra: { retracted: true } });
    const warnings = checkExportQuality([{ ref, key: 'k' }]);
    expect(warnings[0]?.issue).toContain('撤稿');
    expect(warnings[0]?.issue).toContain('明确说明理由');
    expect(warnings[0]?.refId).toBe(ref.id);
  });

  it('缺年份、缺作者、缺标题都报', () => {
    const ref = repo.add({
      csl: { id: 'x', type: 'article-journal', DOI: '10.1000/bare' },
      source: 'test',
    });
    const issues = checkExportQuality([{ ref, key: 'k' }]).map((w) => w.issue);
    expect(issues.some((i) => i.includes('年份'))).toBe(true);
    expect(issues.some((i) => i.includes('作者'))).toBe(true);
    expect(issues.some((i) => i.includes('标题'))).toBe(true);
  });

  it('期刊论文缺期刊名会报（BibTeX 的 journal 会缺失）', () => {
    const ref = addRef({ 'container-title': undefined });
    const issues = checkExportQuality([{ ref, key: 'k' }]).map((w) => w.issue);
    expect(issues.some((i) => i.includes('期刊名'))).toBe(true);
  });

  it('兜底类型 document 会报：引用格式可能不符实际类型', () => {
    const ref = repo.add({ csl: { id: 'x', type: 'document', title: 'X' }, source: 'test' });
    const issues = checkExportQuality([{ ref, key: 'k' }]).map((w) => w.issue);
    expect(issues.some((i) => i.includes('未能确定'))).toBe(true);
  });

  it('preprint 提示应当标注', () => {
    const ref = repo.add({
      csl: { id: 'x', type: 'article', title: 'A preprint', DOI: '10.1101/x' },
      source: 'test',
    });
    const issues = checkExportQuality([{ ref, key: 'k' }]).map((w) => w.issue);
    expect(issues.some((i) => i.includes('未经同行评议'))).toBe(true);
  });

  it('既无 DOI 也无 PMID/URL 时报「读者无法定位」', () => {
    const ref = repo.add({
      csl: { id: 'x', type: 'article-journal', title: 'Orphan', 'container-title': 'J' },
      source: 'test',
    });
    const issues = checkExportQuality([{ ref, key: 'k' }]).map((w) => w.issue);
    expect(issues.some((i) => i.includes('无法定位'))).toBe(true);
  });

  it('完整的条目不产生警告', () => {
    const ref = addRef();
    expect(checkExportQuality([{ ref, key: 'k' }])).toHaveLength(0);
  });

  it('警告按条目分组渲染，而不是按问题类型', () => {
    const bad = repo.add({
      csl: { id: 'x', type: 'article-journal', DOI: '10.1000/bad' },
      source: 'test',
    });
    const text = renderExportWarnings(checkExportQuality([{ ref: bad, key: 'badkey' }]));
    expect(text).toContain('1 条文献');
    expect(text).toContain('badkey');
    // 同一条的多个问题聚在它下面
    expect((text.match(/ {4}· /gu) ?? []).length).toBeGreaterThan(1);
  });

  it('警告过多时截断并说明还有多少', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      ref: repo.add({
        csl: { id: `x${String(i)}`, type: 'document', title: `T${String(i)}` },
        source: 'test',
      }),
      key: `k${String(i)}`,
    }));
    const text = renderExportWarnings(checkExportQuality(entries), 5);
    expect(text).toContain('还有 25 条');
  });

  it('无警告时渲染成空串', () => {
    expect(renderExportWarnings([])).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * 6. 服务层：落成制品
 * ------------------------------------------------------------------ */

describe('导出落盘', () => {
  it('导出存成制品并返回版本 id', () => {
    addRef();
    const outcome = library().exportRefs({ format: 'bibtex' });

    expect(outcome.ok).toBe(true);
    expect(outcome.artifactId).not.toBeNull();
    expect(outcome.versionId).not.toBeNull();

    const content = artifacts.readVersion(outcome.versionId as string)?.toString('utf8') ?? '';
    expect(content).toContain('@article{smith2023sleep,');
  });

  it('.bib 被归类成 document 而不是 other', () => {
    // 分类决定 UI 分组。书目文件是参考文献列表的可投稿形态，与手稿同类
    expect(inferKind('references.bib', null)).toBe('document');
    expect(inferKind('references.ris', null)).toBe('document');
  });

  it('BibTeX 导出顺手把引用键缓存回记录', () => {
    const ref = addRef();
    const lib = library();
    expect(lib.repo.get(ref.id)?.bibtex).toBeNull();

    lib.exportRefs({ format: 'bibtex' });
    const cached = lib.repo.get(ref.id)?.bibtex ?? '';
    // 详情页显示的键必须与刚导出那份文件一致
    expect(cached).toContain('@article{smith2023sleep,');
  });

  it('按 refIds 导出，不存在的 id 被报出来而不是静默少几条', () => {
    const ref = addRef();
    const outcome = library().exportRefs({
      format: 'csl-json',
      refIds: [ref.id, 'rf_nope', 'rf_also_nope'],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.entryCount).toBe(1);
    expect(outcome.missingIds).toEqual(['rf_nope', 'rf_also_nope']);
  });

  it('全部 id 都不存在时报错并列出它们', () => {
    const outcome = library().exportRefs({ format: 'bibtex', refIds: ['rf_a', 'rf_b'] });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('rf_a');
  });

  it('空库导出时给出可执行的下一步', () => {
    const outcome = library().exportRefs({ format: 'bibtex' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('resolve');
  });

  it('筛选条件生效', () => {
    addRef({ DOI: '10.1000/a', issued: { 'date-parts': [[2020]] } });
    addRef({ DOI: '10.1000/b', issued: { 'date-parts': [[2023]] }, title: 'Recent work' });
    const outcome = library().exportRefs({ format: 'bibtex', filter: { year: 2023 } });
    expect(outcome.result?.entryCount).toBe(1);
    expect(outcome.result?.content).toContain('Recent work');
  });

  it('没有制品库时仍返回内容并说明未落盘', () => {
    addRef();
    const lib = new RefLibrary({ repo });
    const outcome = lib.exportRefs({ format: 'ris' });
    expect(outcome.ok).toBe(true);
    expect(outcome.artifactId).toBeNull();
    expect(outcome.result?.content).toContain('TY  - JOUR');
    expect(outcome.reason).toContain('未落盘');
  });

  it('导出的警告一路传到调用方', () => {
    repo.add({ csl: { id: 'x', type: 'document', title: 'Bad' }, source: 'test' });
    const outcome = library().exportRefs({ format: 'bibtex' });
    expect(outcome.result?.warnings.length).toBeGreaterThan(0);
  });

  it('asciiOnly 只影响 BibTeX', () => {
    addRef({ author: [{ family: 'Müller', given: 'José' }] });
    const lib = library();
    const bib = lib.exportRefs({ format: 'bibtex', asciiOnly: true });
    expect(bib.result?.content).toContain('M\\"{u}ller');

    // CSL-JSON 与 RIS 都是 UTF-8，不做转义
    const json = lib.exportRefs({ format: 'csl-json', asciiOnly: true });
    expect(json.result?.content).toContain('Müller');
  });

  it('同一批文献导出两次内容完全一致（除时间戳）', () => {
    addRef({ DOI: '10.1000/a' });
    addRef({ DOI: '10.1000/b', title: 'Second paper' });
    const lib = library();
    const a = lib.exportRefs({ format: 'csl-json' });
    const b = lib.exportRefs({ format: 'csl-json' });
    expect(a.result?.content).toBe(b.result?.content);
    // 内容相同 → blob 去重命中 → 同一个 sha
    expect(a.artifactId).not.toBe(b.artifactId);
  });
});
