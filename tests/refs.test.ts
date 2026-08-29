/**
 * 文献库测试（任务 13.1，需求 12.1、12.2）。
 *
 * 五块重点：
 *
 * 1. **标识归一化**。DOI 有六种写法，不归一化就会让同一篇文献以四条记录入库——
 *    而那正是需求 12.2 要防的。
 * 2. **六家上游的 CSL 翻译**。用真实响应形状的样本数据，覆盖各家的特有字段
 *    （OpenAlex 的倒排摘要、PubMed 的 `Smith JB` 作者名、Crossref 的 JATS 摘要）。
 * 3. **去重判定的三档**。重点是 `likely` 不会被自动合并——preprint 与正式版
 *    合并掉一个之后无法恢复。
 * 4. **多源合并的互补性**：合并后的记录必须比任何单一来源更完整，且被合并掉那条
 *    独有的信号（撤稿标记）不能丢。
 * 5. **仓储与服务**：派生列与 CSL 一致、别名在合并后仍可查、批准门未通过时如实报告。
 *
 * 网络一律用注入的 fetch 桩，不打真实上游：测试要在离线环境下可重复。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  DEDUPE_THRESHOLDS,
  HostRateLimiter,
  RefLibrary,
  RefsRepo,
  citeLine,
  clusterRefs,
  completeness,
  crossrefToCsl,
  cslYear,
  dataCiteToCsl,
  europePmcToCsl,
  fingerprint,
  httpJson,
  levenshtein,
  matchRefs,
  mergeAll,
  mergeCsl,
  mergeSourceLabel,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  normalizeTitle,
  openAlexToCsl,
  protectAcronyms,
  pubmedSummaryToCsl,
  rebuildInvertedAbstract,
  resolveByDoi,
  sanitizeKey,
  semanticScholarToCsl,
  sniffIdentifier,
  titleSimilarity,
  toBibtex,
  toBibtexFile,
  type CslItem,
  type FetchImpl,
  type ProjectStore,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

let root: string;
let store: AppStore;
let project: ProjectStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-refs-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '文献测试' });
  project = store.openProject(created.id);
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

/** 造一条最小可用的 CSL。 */
function csl(overrides: Partial<CslItem> = {}): CslItem {
  return {
    id: 'x',
    type: 'article-journal',
    title: 'Sleep spindles and memory consolidation',
    author: [{ family: 'Smith', given: 'John' }],
    issued: { 'date-parts': [[2023, 5, 12]] },
    'container-title': 'Journal of Sleep Research',
    ...overrides,
  };
}

/** 一个只按 URL 前缀匹配的 fetch 桩。 */
function stubFetch(
  routes: Readonly<Record<string, unknown>>,
  options: { status?: number } = {},
): FetchImpl {
  return async (input: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (input.startsWith(prefix)) {
        return new Response(JSON.stringify(body), {
          status: options.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
}

/* ------------------------------------------------------------------ *
 * 1. 标识归一化
 * ------------------------------------------------------------------ */

describe('标识归一化', () => {
  it('DOI 的六种常见写法归一化为同一串', () => {
    const expected = '10.1038/s41586-021-03819-2';
    for (const raw of [
      '10.1038/s41586-021-03819-2',
      '10.1038/S41586-021-03819-2',
      'doi:10.1038/s41586-021-03819-2',
      'DOI: 10.1038/s41586-021-03819-2',
      'https://doi.org/10.1038/s41586-021-03819-2',
      'http://dx.doi.org/10.1038/s41586-021-03819-2',
    ]) {
      expect(normalizeDoi(raw), raw).toBe(expected);
    }
  });

  it('从 PDF 复制来的尾随标点被去掉', () => {
    expect(normalizeDoi('10.1038/nature12373.')).toBe('10.1038/nature12373');
    expect(normalizeDoi('(10.1038/nature12373)')).toBe('10.1038/nature12373');
    expect(normalizeDoi('10.1038/nature12373,')).toBe('10.1038/nature12373');
  });

  it('不合法的 DOI 返回 null 而不是原样通过', () => {
    // 这一条是去重的前提：坏值以精确匹配的身份入库会把两篇文献判成一篇
    for (const bad of [
      '',
      '   ',
      '10.foo/bar',
      '10.1/x',
      'nature12373',
      '10.1038/',
      'https://example.com/a',
    ]) {
      expect(normalizeDoi(bad), bad).toBeNull();
    }
  });

  it('PMID 只认纯数字，PMCID 统一带前缀', () => {
    expect(normalizePmid('23456789')).toBe('23456789');
    expect(normalizePmid('PMID: 23456789')).toBe('23456789');
    expect(normalizePmid('PMC23456789')).toBeNull();
    expect(normalizePmcid('3539452')).toBe('PMC3539452');
    expect(normalizePmcid('pmc3539452')).toBe('PMC3539452');
    expect(normalizePmcid('PMC3539452')).toBe('PMC3539452');
  });

  it('arXiv 版本号被去掉：v1 与 v3 是同一篇', () => {
    expect(normalizeArxivId('2401.01234v3')).toBe('2401.01234');
    expect(normalizeArxivId('arXiv:2401.01234')).toBe('2401.01234');
    expect(normalizeArxivId('https://arxiv.org/abs/2401.01234v2')).toBe('2401.01234');
    expect(normalizeArxivId('https://arxiv.org/pdf/2401.01234.pdf')).toBe('2401.01234');
    // 2007 年之前的旧式编号
    expect(normalizeArxivId('math.GT/0309136')).toBe('math.GT/0309136');
    expect(normalizeArxivId('nonsense')).toBeNull();
  });

  it('标题归一化吸收标点、HTML 标签与重音', () => {
    expect(normalizeTitle('Sleep spindles: a review')).toBe('sleep spindles a review');
    expect(normalizeTitle('Sleep spindles - a review')).toBe('sleep spindles a review');
    expect(normalizeTitle('<i>In vivo</i> imaging')).toBe('in vivo imaging');
    expect(normalizeTitle('Rôle de la mémoire')).toBe('role de la memoire');
    expect(normalizeTitle('  Multiple   spaces  ')).toBe('multiple spaces');
  });

  it('标题归一化不删停用词：and 与 or 的含义不同', () => {
    expect(normalizeTitle('Sleep and memory')).not.toBe(normalizeTitle('Sleep or memory'));
  });

  it('嗅探：四位数字不当 PMID（那通常是年份）', () => {
    expect(sniffIdentifier('2024').kind).toBe('title');
    expect(sniffIdentifier('23456789')).toEqual({ kind: 'pmid', value: '23456789' });
    expect(sniffIdentifier('10.1038/nature12373').kind).toBe('doi');
    expect(sniffIdentifier('PMC3539452')).toEqual({ kind: 'pmcid', value: 'PMC3539452' });
    expect(sniffIdentifier('2401.01234')).toEqual({ kind: 'arxiv', value: '2401.01234' });
    expect(sniffIdentifier('Sleep spindles and memory').kind).toBe('title');
  });

  it('嗅探能从出版商链接里抠出内嵌的 DOI', () => {
    const sniffed = sniffIdentifier('https://link.springer.com/article/10.1007/s00415-020-09974-2');
    expect(sniffed).toEqual({ kind: 'doi', value: '10.1007/s00415-020-09974-2' });
  });

  it('嗅探认 PubMed 链接', () => {
    expect(sniffIdentifier('https://pubmed.ncbi.nlm.nih.gov/23456789/')).toEqual({
      kind: 'pmid',
      value: '23456789',
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. 上游 → CSL
 * ------------------------------------------------------------------ */

describe('上游元数据翻译', () => {
  it('Crossref：期刊论文的书目字段与 JATS 摘要', () => {
    const item = crossrefToCsl({
      DOI: '10.1038/S41586-021-03819-2',
      type: 'journal-article',
      title: ['Highly accurate protein structure prediction with AlphaFold'],
      'container-title': ['Nature'],
      'short-container-title': ['Nature'],
      author: [
        { family: 'Jumper', given: 'John' },
        { family: 'Evans', given: 'Richard' },
      ],
      issued: { 'date-parts': [[2021, 7, 15]] },
      volume: '596',
      issue: '7873',
      page: '583-589',
      publisher: 'Springer Science and Business Media LLC',
      ISSN: ['0028-0836', '1476-4687'],
      abstract: '<jats:p>Proteins are essential to life.</jats:p>',
      'is-referenced-by-count': 12000,
      language: 'en',
    });

    expect(item).not.toBeNull();
    expect(item?.DOI).toBe('10.1038/s41586-021-03819-2');
    expect(item?.type).toBe('article-journal');
    expect(item?.title).toBe('Highly accurate protein structure prediction with AlphaFold');
    expect(item?.['container-title']).toBe('Nature');
    expect(item?.page).toBe('583-589');
    expect(cslYear(item as CslItem)).toBe(2021);
    // JATS 标签被剥掉而不是原样进摘要
    expect(item?.abstract).toBe('Proteins are essential to life.');
    expect(item?.extra?.citedByCount).toBe(12000);
  });

  it('Crossref：preprint 不被当成期刊论文', () => {
    const item = crossrefToCsl({
      DOI: '10.1101/2023.01.01.522000',
      type: 'posted-content',
      subtype: 'preprint',
      title: ['A preprint'],
      issued: { 'date-parts': [[2023]] },
    });
    expect(item?.type).toBe('article');
    expect(item?.extra?.preprint).toBe(true);
  });

  it('Crossref：会议论文映射到 paper-conference', () => {
    const item = crossrefToCsl({
      DOI: '10.1145/3292500.3330919',
      type: 'proceedings-article',
      title: ['A conference paper'],
      'container-title': ['Proceedings of KDD'],
    });
    expect(item?.type).toBe('paper-conference');
  });

  it('Crossref：撤稿/更正线索进 extra', () => {
    const item = crossrefToCsl({
      DOI: '10.1000/retraction',
      type: 'journal-article',
      title: ['Retraction notice'],
      'update-to': [{ type: 'retraction', DOI: '10.1000/ORIGINAL' }],
    });
    expect(item?.extra?.updateTo).toEqual(['retraction:10.1000/original']);
  });

  it('OpenAlex：倒排摘要被还原', () => {
    const rebuilt = rebuildInvertedAbstract({
      Sleep: [0],
      spindles: [1],
      are: [2],
      important: [3],
    });
    expect(rebuilt).toBe('Sleep spindles are important');
  });

  it('OpenAlex：倒排索引有缺口时不假装完整', () => {
    // 位置 2 缺失。输出已知词，不补占位符
    const rebuilt = rebuildInvertedAbstract({ Sleep: [0], spindles: [1], matter: [3] });
    expect(rebuilt).toBe('Sleep spindles matter');
  });

  it('OpenAlex：撤稿标记与开放获取信息被保留', () => {
    const item = openAlexToCsl({
      id: 'https://openalex.org/W2741809807',
      doi: 'https://doi.org/10.7717/peerj.4375',
      title: 'A retracted work',
      publication_year: 2018,
      publication_date: '2018-02-13',
      type: 'article',
      is_retracted: true,
      authorships: [
        { author: { display_name: 'Heather Piwowar' } },
        { author: { display_name: 'WHO Collaborating Centre' } },
      ],
      primary_location: {
        source: { display_name: 'PeerJ', type: 'journal', issn: ['2167-8359'] },
        landing_page_url: 'https://peerj.com/articles/4375',
        pdf_url: 'https://peerj.com/articles/4375.pdf',
      },
      open_access: { is_oa: true, oa_status: 'gold' },
      biblio: { volume: '6', issue: null, first_page: 'e4375', last_page: 'e4375' },
      ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/29456894', pmcid: 'PMC5815332' },
      cited_by_count: 900,
    });

    expect(item?.extra?.retracted).toBe(true);
    expect(item?.extra?.oaStatus).toBe('gold');
    expect(item?.PMID).toBe('29456894');
    expect(item?.PMCID).toBe('PMC5815332');
    // 首页与末页相同时不输出 `e4375-e4375`
    expect(item?.page).toBe('e4375');
    // 机构作者整体当 literal，不被拆成姓与名
    expect(item?.author?.[1]?.literal).toBe('WHO Collaborating Centre');
    expect(item?.author?.[1]?.family).toBeUndefined();
    // 个人作者按最后一个词取姓
    expect(item?.author?.[0]).toEqual({ family: 'Piwowar', given: 'Heather' });
  });

  it('Semantic Scholar：Review 优先于 JournalArticle', () => {
    const item = semanticScholarToCsl({
      title: 'A systematic review',
      externalIds: { DOI: '10.1000/review', PubMed: '12345678', ArXiv: '2401.01234' },
      publicationTypes: ['JournalArticle', 'Review'],
      year: 2022,
      journal: { name: 'Reviews', volume: '3', pages: '1-20' },
      tldr: { text: '一句话总结' },
      citationCount: 42,
      influentialCitationCount: 7,
    });
    expect(item?.type).toBe('review');
    expect(item?.extra?.tldr).toBe('一句话总结');
    expect(item?.extra?.arxivId).toBe('2401.01234');
    expect(item?.PMID).toBe('12345678');
  });

  it('PubMed：`Smith JB` 形式的作者名被正确拆开并补点号', () => {
    const item = pubmedSummaryToCsl({
      uid: '29456894',
      title: 'Sleep and memory.',
      fulljournalname: 'Journal of Sleep Research',
      source: 'J Sleep Res',
      authors: [
        { name: 'Smith JB', authtype: 'Author' },
        { name: 'World Health Organization', authtype: 'CollectiveName' },
      ],
      pubdate: '2023 May 12',
      epubdate: '2023 Apr 3',
      volume: '32',
      issue: '2',
      pages: '100-110',
      lang: ['eng'],
      articleids: [
        { idtype: 'pubmed', value: '29456894' },
        { idtype: 'doi', value: '10.1111/jsr.13000' },
        { idtype: 'pmc', value: 'PMC5815332' },
      ],
      pubtype: ['Journal Article', 'Review'],
    });

    expect(item?.author?.[0]).toEqual({ family: 'Smith', given: 'J. B.' });
    expect(item?.author?.[1]).toEqual({ literal: 'World Health Organization' });
    // 标题末尾的句号被去掉（PubMed 一律带）
    expect(item?.title).toBe('Sleep and memory');
    expect(item?.DOI).toBe('10.1111/jsr.13000');
    expect(item?.PMCID).toBe('PMC5815332');
    // Review 优先于 Journal Article
    expect(item?.type).toBe('review');
    // epubdate 优先：电子首发更接近「什么时候能读到」
    expect(item?.issued?.['date-parts']?.[0]).toEqual([2023, 4, 3]);
  });

  it('PubMed：articleids 里没有 DOI 时从 elocationid 兜底', () => {
    const item = pubmedSummaryToCsl({
      uid: '111',
      title: 'X',
      elocationid: 'doi: 10.1111/abc.123',
      articleids: [{ idtype: 'pubmed', value: '111' }],
    });
    expect(item?.DOI).toBe('10.1111/abc.123');
  });

  it('Europe PMC：全文可得性标记被保留', () => {
    const item = europePmcToCsl({
      id: '29456894',
      source: 'MED',
      doi: '10.1111/jsr.13000',
      title: 'Sleep and memory.',
      pmid: '29456894',
      pmcid: 'PMC5815332',
      authorList: {
        author: [{ lastName: 'Smith', initials: 'JB' }, { collectiveName: 'The Consortium' }],
      },
      pubYear: 2023,
      firstPublicationDate: '2023-04-03',
      journalInfo: { volume: '32', issue: '2', journal: { title: 'Journal of Sleep Research' } },
      pageInfo: '100-110',
      isOpenAccess: 'Y',
      inPMC: 'Y',
      hasPDF: 'Y',
      hasSuppl: 'Y',
      fullTextIdList: { fullTextId: ['PMC5815332'] },
      abstractText: 'Some abstract.',
    });

    expect(item?.extra?.isOpenAccess).toBe(true);
    expect(item?.extra?.inPubmedCentral).toBe(true);
    expect(item?.extra?.hasPdf).toBe(true);
    expect(item?.extra?.fullTextIds).toEqual(['PMC5815332']);
    expect(item?.author?.[0]).toEqual({ family: 'Smith', given: 'J. B.' });
    expect(item?.author?.[1]).toEqual({ literal: 'The Consortium' });
  });

  it('DataCite：数据集 DOI 映射到 dataset', () => {
    const item = dataCiteToCsl({
      attributes: {
        doi: '10.5061/DRYAD.ABC123',
        titles: [{ title: 'Sleep EEG dataset' }],
        creators: [
          { familyName: 'Smith', givenName: 'John' },
          { name: 'Big Lab', nameType: 'Organizational' },
        ],
        publicationYear: 2022,
        publisher: 'Dryad',
        types: { resourceTypeGeneral: 'Dataset' },
        url: 'https://datadryad.org/stash/dataset/doi:10.5061/dryad.abc123',
        version: '2',
        rightsList: [{ rights: 'CC0 1.0' }],
      },
    });

    expect(item?.type).toBe('dataset');
    expect(item?.DOI).toBe('10.5061/dryad.abc123');
    expect(item?.publisher).toBe('Dryad');
    expect(item?.extra?.version).toBe('2');
    expect(item?.author?.[1]).toEqual({ literal: 'Big Lab' });
  });

  it('缺标题又缺 DOI 的响应返回 null 而不是一条空记录', () => {
    expect(crossrefToCsl({ type: 'journal-article' })).toBeNull();
    expect(openAlexToCsl({ publication_year: 2020 })).toBeNull();
    expect(semanticScholarToCsl({ year: 2020 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3. 去重判定
 * ------------------------------------------------------------------ */

describe('去重判定', () => {
  it('编辑距离对称且自反', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abc', 'abd')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('标题相似度：完全相同为 1', () => {
    const sim = titleSimilarity('sleep spindles and memory', 'sleep spindles and memory');
    expect(sim.char).toBe(1);
    expect(sim.containment).toBe(1);
    expect(sim.jaccard).toBe(1);
  });

  it('标题相似度：副标题缺失时包含率高而字符相似度低', () => {
    const short = normalizeTitle('Deep learning for sleep staging');
    const long = normalizeTitle('Deep learning for sleep staging: a multicenter validation study');
    const sim = titleSimilarity(short, long);
    expect(sim.containment).toBe(1);
    // 这正是单靠编辑距离会漏掉这类重复的原因
    expect(sim.char).toBeLessThan(0.7);
  });

  it('DOI 相同即判同一篇', () => {
    const a = fingerprint(csl({ DOI: '10.1000/x' }));
    const b = fingerprint(csl({ DOI: 'https://doi.org/10.1000/X', title: '完全不同的标题' }));
    const match = matchRefs(a, b);
    expect(match.verdict).toBe('same');
    expect(match.by).toBe('doi');
  });

  it('PMID 相同即判同一篇（老文献常常只有 PMID）', () => {
    const a = fingerprint(csl({ DOI: undefined, PMID: '123456' }));
    const b = fingerprint(csl({ DOI: undefined, PMID: '123456', title: '标题写法不同' }));
    expect(matchRefs(a, b).by).toBe('pmid');
  });

  it('两个不同 DOI 但标题几乎相同：报告 likely，绝不自动合并', () => {
    const preprint = fingerprint(
      csl({ DOI: '10.1101/2023.01.01.522000', issued: { 'date-parts': [[2023]] } }),
    );
    const published = fingerprint(
      csl({ DOI: '10.1111/jsr.13000', issued: { 'date-parts': [[2024]] } }),
    );
    const match = matchRefs(preprint, published);
    expect(match.verdict).toBe('likely');
    expect(match.reason).toContain('preprint');
  });

  it('标识缺失 + 标题几乎相同 + 年份相容 → same', () => {
    const a = fingerprint(csl({ DOI: undefined }));
    const b = fingerprint(
      csl({ DOI: undefined, title: 'Sleep spindles and memory consolidation' }),
    );
    expect(matchRefs(a, b).verdict).toBe('same');
  });

  it('副标题缺失路径：包含率 + 第一作者 + 年份都成立才判 same', () => {
    const withSub = fingerprint(
      csl({ DOI: undefined, title: 'Deep learning for sleep staging: a validation study' }),
    );
    const withoutSub = fingerprint(
      csl({ DOI: undefined, title: 'Deep learning for sleep staging' }),
    );
    expect(matchRefs(withSub, withoutSub).verdict).toBe('same');

    // 第一作者不同时不再判 same
    const otherAuthor = fingerprint(
      csl({
        DOI: undefined,
        title: 'Deep learning for sleep staging',
        author: [{ family: 'Jones', given: 'A' }],
      }),
    );
    expect(matchRefs(withSub, otherAuthor).verdict).not.toBe('same');
  });

  it('短标题不走包含率路径：两三个词的标题包含率必然高', () => {
    const a = fingerprint(csl({ DOI: undefined, title: 'Sleep study' }));
    const b = fingerprint(
      csl({
        DOI: undefined,
        title: 'Sleep study of a completely different cohort in another country',
      }),
    );
    expect(matchRefs(a, b).verdict).not.toBe('same');
  });

  it('不同主题的相似标题判 distinct', () => {
    const a = fingerprint(csl({ DOI: undefined, title: 'Sleep spindles in schizophrenia' }));
    const b = fingerprint(csl({ DOI: undefined, title: 'Sleep spindles in major depression' }));
    expect(matchRefs(a, b).verdict).toBe('distinct');
  });

  it('年份相差超过一年时不判 same（缺年份视为相容）', () => {
    const a = fingerprint(csl({ DOI: undefined, issued: { 'date-parts': [[2015]] } }));
    const b = fingerprint(csl({ DOI: undefined, issued: { 'date-parts': [[2023]] } }));
    expect(matchRefs(a, b).verdict).not.toBe('same');

    const noYear = fingerprint(csl({ DOI: undefined, issued: undefined }));
    expect(matchRefs(a, noYear).verdict).toBe('same');
  });

  it('判定对称', () => {
    const a = fingerprint(csl({ DOI: undefined, title: 'Deep learning for sleep staging: extra' }));
    const b = fingerprint(csl({ DOI: undefined, title: 'Deep learning for sleep staging' }));
    expect(matchRefs(a, b).verdict).toBe(matchRefs(b, a).verdict);
  });

  it('阈值表被导出，改阈值时测试跟着改', () => {
    expect(DEDUPE_THRESHOLDS.titleOnlySame).toBeGreaterThan(DEDUPE_THRESHOLDS.titleWithAuthorSame);
    expect(DEDUPE_THRESHOLDS.titleWithAuthorSame).toBeGreaterThan(DEDUPE_THRESHOLDS.likely);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 多源合并
 * ------------------------------------------------------------------ */

describe('多源合并', () => {
  it('完备度打分：缺作者与年份的条目分数明显更低', () => {
    const full = csl({ DOI: '10.1000/x', page: '1-10', volume: '3' });
    const bare: CslItem = { id: 'y', type: 'article-journal', title: 'X' };
    expect(completeness(full)).toBeGreaterThan(completeness(bare));
  });

  it('作者列表取更长的那个：上游截断作者是常见缺陷', () => {
    const short = csl({ author: [{ family: 'Smith' }] });
    const long = csl({
      author: [{ family: 'Smith' }, { family: 'Jones' }, { family: 'Lee' }],
      // 副记录其余字段更差，以确认「作者取长」不受主次影响
      'container-title': undefined,
    });
    const merged = mergeCsl(short, long);
    expect(merged.author).toHaveLength(3);
    // 主记录的期刊名没有被副记录的缺失覆盖掉
    expect(merged['container-title']).toBe('Journal of Sleep Research');
  });

  it('被合并掉那条独有的撤稿标记必须保留', () => {
    const crossref = csl({ DOI: '10.1000/x', page: '1-10' });
    const openalex = csl({ DOI: '10.1000/x', extra: { retracted: true, oaStatus: 'gold' } });
    const merged = mergeCsl(crossref, openalex);
    expect(merged.extra?.retracted).toBe(true);
    expect(merged.extra?.oaStatus).toBe('gold');
    expect(merged.page).toBe('1-10');
  });

  it('mergeAll 以完备度最高的一条为主，结果比任何单一来源都完整', () => {
    const crossref = csl({ DOI: '10.1000/x', page: '583-589', volume: '596', ISSN: ['0028-0836'] });
    const s2 = csl({ DOI: '10.1000/x', abstract: '摘要', extra: { tldr: '一句话' } });
    const openalex = csl({
      DOI: '10.1000/x',
      author: [{ family: 'Smith' }, { family: 'Jones' }],
      extra: { retracted: true },
    });

    const merged = mergeAll([crossref, s2, openalex]);
    expect(merged).not.toBeNull();
    expect(merged?.page).toBe('583-589');
    expect(merged?.abstract).toBe('摘要');
    expect(merged?.extra?.retracted).toBe(true);
    expect(merged?.extra?.tldr).toBe('一句话');
    expect(merged?.author).toHaveLength(2);
    expect(completeness(merged as CslItem)).toBeGreaterThanOrEqual(completeness(crossref));
  });

  it('mergeAll 对空输入与全废输入返回 null', () => {
    expect(mergeAll([])).toBeNull();
    expect(mergeAll([{ id: 'a', type: 'document' }])).toBeNull();
  });

  it('type 是兜底 document 时被非兜底的覆盖', () => {
    const vague = csl({ type: 'document' });
    const precise = csl({ type: 'paper-conference' });
    expect(mergeCsl(vague, precise).type).toBe('paper-conference');
    expect(mergeCsl(precise, vague).type).toBe('paper-conference');
  });

  it('聚类：三条同 DOI 合成一簇，likely 的记进 suspects 而不合并', () => {
    const clusters = clusterRefs([
      csl({ DOI: '10.1000/a', page: '1-10' }),
      csl({ DOI: '10.1000/a', abstract: '摘要' }),
      csl({ DOI: '10.1101/preprint', issued: { 'date-parts': [[2023]] } }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.members).toEqual([0, 1]);
    expect(clusters[0]?.item.abstract).toBe('摘要');
    expect(clusters[0]?.item.page).toBe('1-10');
    // preprint 独立成簇，并在第一簇的 suspects 里留痕
    expect(clusters[1]?.members).toEqual([2]);
    expect(clusters[0]?.suspects.some((s) => s.index === 2)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 仓储
 * ------------------------------------------------------------------ */

describe('文献仓储', () => {
  it('派生列与 CSL 一致', () => {
    const repo = new RefsRepo(project.db);
    const ref = repo.add({ csl: csl({ DOI: '10.1000/x', PMID: '123456' }), source: 'crossref' });

    expect(ref.doi).toBe('10.1000/x');
    expect(ref.year).toBe(2023);
    expect(ref.firstAuthor).toBe('smith');
    expect(ref.titleNorm).toBe('sleep spindles and memory consolidation');
    expect(ref.container).toBe('Journal of Sleep Research');
    expect(ref.pmid).toBe('123456');
    expect(ref.source).toBe('crossref');
  });

  it('标识自动进别名表', () => {
    const repo = new RefsRepo(project.db);
    const ref = repo.add({ csl: csl({ DOI: '10.1000/x', PMID: '123456', PMCID: 'PMC999' }) });
    const schemes = ref.aliases.map((a) => a.scheme).sort();
    expect(schemes).toEqual(['doi', 'pmcid', 'pmid']);
  });

  it('既无标题又无标识的条目被拒绝', () => {
    const repo = new RefsRepo(project.db);
    expect(() => repo.add({ csl: { id: 'x', type: 'document' } })).toThrow(
      /至少要有标题或一个标识/,
    );
  });

  it('重复 DOI 直接抛错并说明撞的是哪一条', () => {
    const repo = new RefsRepo(project.db);
    repo.add({ csl: csl({ DOI: '10.1000/x' }) });
    expect(() => repo.add({ csl: csl({ DOI: '10.1000/X', title: '别的标题' }) })).toThrow(
      /已存在于文献库/,
    );
  });

  it('按 DOI 查询走归一化，大小写与前缀都能命中', () => {
    const repo = new RefsRepo(project.db);
    const ref = repo.add({ csl: csl({ DOI: '10.1000/x' }) });
    expect(repo.getByDoi('https://doi.org/10.1000/X')?.id).toBe(ref.id);
    expect(repo.getByDoi('不是 doi')).toBeNull();
  });

  it('合并之后用旧 DOI 仍能查到保留下来的记录', () => {
    const repo = new RefsRepo(project.db);
    const keep = repo.add({ csl: csl({ DOI: '10.1000/published' }), source: 'crossref' });
    const drop = repo.add({
      csl: csl({ DOI: '10.1101/preprint', title: 'Sleep spindles and memory consolidation' }),
      source: 'openalex',
    });

    const merged = repo.merge({
      keepId: keep.id,
      dropId: drop.id,
      csl: csl({ DOI: '10.1000/published' }),
    });

    expect(merged).not.toBeNull();
    expect(repo.get(drop.id)).toBeNull();
    // 这条断言防的是一个绕圈的 bug：旧 DOI 查不到 → 重新解析 → 又新建一条
    expect(repo.getByDoi('10.1101/preprint')?.id).toBe(keep.id);
    expect(merged?.source).toBe('crossref+openalex');
  });

  it('合并继承被删那条的全文（保留条没有时）', () => {
    const repo = new RefsRepo(project.db);
    const keep = repo.add({ csl: csl({ DOI: '10.1000/a' }) });
    const drop = repo.add({ csl: csl({ DOI: '10.1000/b', title: '另一篇' }) });
    repo.setFulltext(drop.id, 'af_full', 'gold');

    repo.merge({ keepId: keep.id, dropId: drop.id, csl: csl({ DOI: '10.1000/a' }) });
    const after = repo.get(keep.id);
    expect(after?.fulltextArtifactId).toBe('af_full');
    expect(after?.oaStatus).toBe('gold');
  });

  it('CSL 损坏时退化成最小条目而不是让整条读不出来', () => {
    const repo = new RefsRepo(project.db);
    const ref = repo.add({ csl: csl({ DOI: '10.1000/x' }) });
    project.db.prepare('UPDATE refs SET csl_json = ? WHERE id = ?').run('{坏 JSON', ref.id);

    const read = repo.get(ref.id);
    expect(read).not.toBeNull();
    expect(read?.doi).toBe('10.1000/x');
    expect(read?.csl.note).toContain('已损坏');
  });

  it('候选收窄能命中标题前缀相同的记录', () => {
    const repo = new RefsRepo(project.db);
    repo.add({ csl: csl({ DOI: '10.1000/x', title: 'Deep learning for sleep staging: a study' }) });
    const fp = fingerprint(csl({ DOI: undefined, title: 'Deep learning for sleep staging' }));
    expect(repo.candidates(fp).length).toBeGreaterThan(0);
  });

  it('统计反映全文与 DOI 的覆盖情况', () => {
    const repo = new RefsRepo(project.db);
    const a = repo.add({ csl: csl({ DOI: '10.1000/a' }) });
    repo.add({ csl: csl({ DOI: undefined, title: '只有标题的条目' }) });
    repo.setFulltext(a.id, 'af_1');

    const stats = repo.stats();
    expect(stats.total).toBe(2);
    expect(stats.withDoi).toBe(1);
    expect(stats.withFulltext).toBe(1);
    expect(stats.withoutFulltext).toBe(1);
    expect(stats.yearRange.min).toBe(2023);
  });

  it('来源标签合并去重且保序', () => {
    expect(mergeSourceLabel('crossref', 'openalex')).toBe('crossref+openalex');
    expect(mergeSourceLabel('crossref+openalex', 'crossref')).toBe('crossref+openalex');
    expect(mergeSourceLabel(null, null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 6. 服务层
 * ------------------------------------------------------------------ */

describe('文献库服务', () => {
  function library(
    overrides: {
      authorizeHosts?: (h: readonly string[]) => Promise<readonly string[]>;
      fetchImpl?: FetchImpl;
    } = {},
  ): RefLibrary {
    return new RefLibrary({
      repo: new RefsRepo(project.db),
      http: {
        ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
        maxRetries: 0,
      },
      ...(overrides.authorizeHosts === undefined
        ? {}
        : { authorizeHosts: overrides.authorizeHosts }),
    });
  }

  it('命中重复时补全元数据而不是拒绝', () => {
    const lib = library();
    const first = lib.addResolved({ csl: csl({ DOI: '10.1000/x' }), source: 'pubmed' });
    expect(first.created).toBe(true);

    const second = lib.addResolved({
      csl: csl({ DOI: '10.1000/x', page: '583-589', volume: '596', abstract: '摘要' }),
      source: 'crossref',
    });

    expect(second.created).toBe(false);
    expect(second.enriched).toBe(true);
    expect(second.ref?.csl.page).toBe('583-589');
    expect(second.ref?.source).toBe('pubmed+crossref');
  });

  it('重复且没有新字段时不刷新 updated_at', () => {
    const lib = library();
    const first = lib.addResolved({ csl: csl({ DOI: '10.1000/x' }) });
    const second = lib.addResolved({ csl: csl({ DOI: '10.1000/x' }) });
    expect(second.enriched).toBe(false);
    expect(second.ref?.updatedAt).toBe(first.ref?.updatedAt);
  });

  it('likely 级别的相似记录被报告但不合并', () => {
    const lib = library();
    lib.addResolved({ csl: csl({ DOI: '10.1101/preprint', issued: { 'date-parts': [[2023]] } }) });
    const outcome = lib.addResolved({
      csl: csl({ DOI: '10.1111/jsr.13000', issued: { 'date-parts': [[2024]] } }),
    });

    expect(outcome.created).toBe(true);
    expect(outcome.suspects).toHaveLength(1);
    expect(outcome.suspects[0]?.reason).toContain('preprint');
    expect(lib.repo.count()).toBe(2);
  });

  it('按标题不能入库：必须先检索确认', async () => {
    const lib = library();
    const outcome = await lib.addByIdentifier('Sleep spindles and memory consolidation');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('不是标识而是标题');
    expect(lib.repo.count()).toBe(0);
  });

  it('库里已有该标识时跳过网络请求', async () => {
    let calls = 0;
    const lib = library({
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    lib.addResolved({ csl: csl({ DOI: '10.1000/x' }) });

    const outcome = await lib.addByIdentifier('10.1000/x');
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toBe(false);
    expect(calls).toBe(0);
  });

  it('批准门全部拒绝时如实报告，不静默返回空结果', async () => {
    const lib = library({ authorizeHosts: async () => [] });
    const outcome = await lib.addByIdentifier('10.1000/x');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('未获批准');
    // 每一家都要在 attempts 里出现，否则「为什么没结果」不可解释
    expect(outcome.attempts.length).toBeGreaterThanOrEqual(6);
    expect(outcome.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('批准门只放行部分主机时，未获批的上游在 attempts 里留痕', async () => {
    const lib = library({
      authorizeHosts: async () => ['api.crossref.org'],
      fetchImpl: stubFetch({
        'https://api.crossref.org/works/': {
          message: {
            DOI: '10.1000/x',
            type: 'journal-article',
            title: ['Only Crossref answered'],
            issued: { 'date-parts': [[2023]] },
            author: [{ family: 'Smith', given: 'J' }],
          },
        },
      }),
    });

    const outcome = await lib.addByIdentifier('10.1000/x');
    expect(outcome.ok).toBe(true);
    expect(outcome.ref?.csl.title).toBe('Only Crossref answered');
    const denied = outcome.attempts.filter((a) => a.reason?.includes('未获批准') === true);
    expect(denied.length).toBe(5);
  });

  it('批准门只问一次，并发调用共用同一次询问', async () => {
    let asked = 0;
    const lib = library({
      authorizeHosts: async (hosts) => {
        asked += 1;
        return hosts;
      },
      fetchImpl: stubFetch({}),
    });

    await Promise.all([lib.addByIdentifier('10.1000/a'), lib.addByIdentifier('10.1000/b')]);
    expect(asked).toBe(1);
  });

  it('全部上游都失败时汇总每一家的原因', async () => {
    const lib = library({ fetchImpl: stubFetch({}) });
    const outcome = await lib.addByIdentifier('10.1000/missing');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('404');
    expect(lib.repo.count()).toBe(0);
  });

  it('显式合并保留用户选择的那一条', () => {
    const lib = library();
    const preprint = lib.addResolved({
      csl: csl({ DOI: '10.1101/pre', issued: { 'date-parts': [[2023]] } }),
    });
    const published = lib.addResolved({
      csl: csl({ DOI: '10.1111/jsr', issued: { 'date-parts': [[2024]] }, page: '1-10' }),
    });

    // 刻意保留 preprint：正文里引的可能就是它
    const result = lib.merge(preprint.ref?.id as string, published.ref?.id as string);
    expect(result.ok).toBe(true);
    expect(result.ref?.doi).toBe('10.1101/pre');
    // 正式版的页码被并进来
    expect(result.ref?.csl.page).toBe('1-10');
    expect(lib.repo.count()).toBe(1);
  });

  it('全库扫描把 same 排在 likely 前面并报告是否截断', () => {
    const lib = library();
    lib.repo.add({ csl: csl({ DOI: '10.1101/pre', issued: { 'date-parts': [[2023]] } }) });
    lib.repo.add({ csl: csl({ DOI: '10.1111/jsr', issued: { 'date-parts': [[2024]] } }) });
    lib.repo.add({
      csl: csl({ DOI: undefined, title: 'Sleep spindles and memory consolidation' }),
    });

    const scan = lib.scanDuplicates();
    expect(scan.total).toBe(3);
    expect(scan.truncated).toBe(false);
    expect(scan.pairs.length).toBeGreaterThanOrEqual(2);
    expect(scan.pairs[0]?.verdict).toBe('same');
  });
});

/* ------------------------------------------------------------------ *
 * 7. HTTP 层
 * ------------------------------------------------------------------ */

describe('HTTP 层', () => {
  it('期望 JSON 却拿到 HTML 时报错而不是把网页当结果', async () => {
    const res = await httpJson('https://example.com/api', {
      fetchImpl: async () =>
        new Response('<!DOCTYPE html><html><body>登录</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      maxRetries: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('HTML');
  });

  it('404 不重试，429 重试', async () => {
    let calls = 0;
    const res404 = await httpJson('https://example.com/a', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('no', { status: 404 });
      },
      maxRetries: 2,
    });
    expect(res404.ok).toBe(false);
    expect(calls).toBe(1);

    calls = 0;
    const res429 = await httpJson('https://example.com/b', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      },
      maxRetries: 2,
    });
    expect(res429.ok).toBe(false);
    expect(calls).toBe(3);
  });

  it('超时被区分成「超时」而不是「网络失败」', async () => {
    const res = await httpJson('https://example.com/slow', {
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      timeoutMs: 20,
      maxRetries: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('未完成');
  });

  it('外部中断信号能穿透', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await httpJson('https://example.com/x', {
      fetchImpl: async () => new Response('{}'),
      signal: controller.signal,
      maxRetries: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('请求已被取消');
  });

  it('限速器按主机串行并保证最小间隔', async () => {
    const limiter = new HostRateLimiter({ 'slow.example': 40 });
    const order: string[] = [];
    const started = Date.now();

    await Promise.all([
      limiter.run('slow.example', async () => {
        order.push('a');
      }),
      limiter.run('slow.example', async () => {
        order.push('b');
      }),
    ]);

    expect(order).toEqual(['a', 'b']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('不同主机互不阻塞', async () => {
    const limiter = new HostRateLimiter({ 'a.example': 200, 'b.example': 0 });
    const started = Date.now();
    await Promise.all([
      limiter.run('a.example', async () => undefined),
      limiter.run('b.example', async () => undefined),
    ]);
    // 两个主机各自只跑一次，间隔在释放时等待，因此总耗时接近 0
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('resolveByDoi 对非法 DOI 不发请求', async () => {
    let calls = 0;
    const report = await resolveByDoi('不是 doi', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}');
      },
    });
    expect(report.ok).toBe(false);
    expect(calls).toBe(0);
    expect(report.reason).toContain('不是合法的 DOI');
  });

  it('resolveByDoi 并行取六家并合并，最终 DOI 是请求的那个', async () => {
    const report = await resolveByDoi('10.1000/x', {
      maxRetries: 0,
      fetchImpl: stubFetch({
        'https://api.crossref.org/works/': {
          message: {
            DOI: '10.1000/x',
            type: 'journal-article',
            title: ['Crossref title'],
            page: '1-10',
            issued: { 'date-parts': [[2023]] },
            author: [{ family: 'Smith', given: 'J' }],
          },
        },
        'https://api.openalex.org/works/doi:': {
          doi: 'https://doi.org/10.1000/x',
          title: 'OpenAlex title',
          publication_year: 2023,
          is_retracted: true,
          authorships: [
            { author: { display_name: 'John Smith' } },
            { author: { display_name: 'A Jones' } },
          ],
        },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.item?.DOI).toBe('10.1000/x');
    expect(report.item?.page).toBe('1-10');
    // 只有 OpenAlex 给的撤稿标记不能在合并中丢
    expect(report.item?.extra?.retracted).toBe(true);
    // 六家都要有一条 attempt，成功与失败都在
    expect(report.attempts).toHaveLength(6);
    expect(report.merged).toContain('crossref');
    expect(report.merged).toContain('openalex');
  });
});

/* ------------------------------------------------------------------ *
 * 8. BibTeX 导出
 * ------------------------------------------------------------------ */

describe('BibTeX 导出', () => {
  it('期刊论文输出 @article 并转成 -- 页码区间', () => {
    const bib = toBibtex(csl({ DOI: '10.1000/x', page: '583-589', volume: '596' }), {
      key: 'smith2023sleep',
    });
    expect(bib).toContain('@article{smith2023sleep,');
    expect(bib).toContain('pages   = {583--589}');
    expect(bib).toContain('journal = {Journal of Sleep Research}');
    expect(bib).toContain('doi     = {10.1000/x}');
  });

  it('会议论文用 booktitle 而不是 journal', () => {
    const bib = toBibtex(
      csl({ type: 'paper-conference', 'container-title': 'Proceedings of KDD' }),
      { key: 'k' },
    );
    expect(bib).toContain('@inproceedings{k,');
    expect(bib).toContain('booktitle');
    expect(bib).not.toContain('journal');
  });

  it('学位论文的机构进 school', () => {
    const bib = toBibtex(csl({ type: 'thesis', publisher: 'MIT' }), { key: 'k' });
    expect(bib).toContain('@phdthesis{k,');
    expect(bib).toContain('school');
  });

  it('首字母缩写词被花括号保住大小写，普通词不加', () => {
    expect(protectAcronyms('Sleep EEG and memory')).toBe('Sleep {EEG} and memory');
    expect(protectAcronyms('mRNA expression')).toBe('{mRNA} expression');
    expect(protectAcronyms('COVID-19 outcomes')).toBe('{COVID-19} outcomes');
    // 单个大写字母不保护，否则等于整体包双花括号
    expect(protectAcronyms('A study of sleep')).toBe('A study of sleep');
  });

  it('LaTeX 特殊字符被转义，反斜杠不被二次转义', () => {
    const bib = toBibtex(csl({ title: '50% of R&D costs $5 with _underscore_' }), { key: 'k' });
    expect(bib).toContain('50\\%');
    expect(bib).toContain('R\\&D');
    expect(bib).toContain('\\$5');
    expect(bib).toContain('\\_underscore\\_');
    expect(bib).not.toContain('\\\\%');
  });

  it('asciiOnly 把重音转成 LaTeX 写法', () => {
    const bib = toBibtex(csl({ author: [{ family: 'Müller', given: 'José' }] }), {
      key: 'k',
      asciiOnly: true,
    });
    expect(bib).toContain('M\\"{u}ller');
    expect(bib).toContain("Jos\\'{e}");
  });

  it('机构作者整体包花括号，否则最后一个词会被当姓', () => {
    const bib = toBibtex(csl({ author: [{ literal: 'World Health Organization' }] }), { key: 'k' });
    expect(bib).toContain('author  = {{World Health Organization}}');
    // 花括号不能被自己转义掉，否则保护失效
    expect(bib).not.toContain('\\{World');
  });

  it('撤稿标记进 note：.bib 常常是用户唯一会看的产物', () => {
    const bib = toBibtex(csl({ extra: { retracted: true } }), { key: 'k' });
    expect(bib).toContain('RETRACTED');
  });

  it('缺字段就不输出该行，不写空值', () => {
    const bib = toBibtex({ id: 'x', type: 'article-journal', title: 'Bare' }, { key: 'k' });
    expect(bib).not.toContain('journal');
    expect(bib).not.toContain('{}');
  });

  it('引用键清洗掉 DOI 里的斜杠与点号', () => {
    expect(sanitizeKey('10.1038/s41586-021-03819-2')).toBe('101038s41586-021-03819-2');
    expect(sanitizeKey('')).toBe('ref');
    expect(sanitizeKey('Müller2023')).toBe('Muller2023');
  });

  it('多条导出时键冲突加字母后缀而不是丢条目', () => {
    const file = toBibtexFile([
      { csl: csl({ DOI: '10.1000/a' }), key: 'smith2023sleep' },
      { csl: csl({ DOI: '10.1000/b', title: '另一篇' }), key: 'smith2023sleep' },
    ]);
    expect(file).toContain('@article{smith2023sleep,');
    expect(file).toContain('@article{smith2023sleepa,');
  });

  it('导出文件带说明头，声明编码取舍', () => {
    const file = toBibtexFile([{ csl: csl(), key: 'k' }]);
    expect(file).toContain('L-science');
    expect(file).toContain('UTF-8');
  });

  it('库里生成的 BibTeX 被缓存复用', () => {
    const lib = new RefLibrary({ repo: new RefsRepo(project.db) });
    const added = lib.addResolved({ csl: csl({ DOI: '10.1000/x' }) });
    const refId = added.ref?.id as string;

    const first = lib.bibtexFor(refId);
    expect(first).toContain('@article{smith2023sleep');
    expect(lib.repo.get(refId)?.bibtex).toBe(first);
    expect(lib.bibtexFor(refId)).toBe(first);
  });

  it('引用键跳过标题里的停用词', () => {
    const lib = new RefLibrary({ repo: new RefsRepo(project.db) });
    const added = lib.addResolved({
      csl: csl({ DOI: '10.1000/y', title: 'The effects of sleep on memory' }),
    });
    // `the` 与 `effects` 之间：`the` 太短且是停用词，取 `effects`
    expect(lib.bibtexFor(added.ref?.id as string)).toContain('@article{smith2023effects');
  });

  it('citeLine 在缺年份与缺作者时也不崩', () => {
    expect(citeLine({ id: 'x', type: 'document' })).toContain('（无作者）');
    expect(citeLine({ id: 'x', type: 'document' })).toContain('年份不明');
  });
});
