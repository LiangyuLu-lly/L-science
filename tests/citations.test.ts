/**
 * 引文核实测试（任务 13.5，需求 13.9）。
 *
 * 需求是一条禁止：「禁止模型凭记忆作答，必须经由检索工具取证」。测试的重点因此
 * 不是「能不能核实」，而是**能不能绕过核实**：
 *
 * 1. **解析**。解析错会让检索查错东西，而查不到会被报成「可能编造」——那是最坏的
 *    误报，它让用户去核对一条其实存在的文献。
 * 2. **纯引用标记必须被拒**。拿 `[12]` 去检索会返回一堆无关文献，其中最相似的会被
 *    判成命中，于是一条编造的引文被「核实」通过了。
 * 3. **五档判定**，尤其是 `not-found` 与 `unverifiable` 的区分：把网络故障说成
 *    学术不端是不可接受的。
 * 4. **`metadata-mismatch`**：DOI 是真的但字段不符（复制错行），只查「DOI 存不存在」
 *    的流程发现不了。
 * 5. **结构性封堵**：引文支撑陈述的 supports 结论没有检索记录时必须被拒；
 *    审查层还有一道兜底。
 *
 * 网络全部用注入的 fetch 桩。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  CITATION_SHAPE_LABEL,
  CITATION_VERDICT_LABEL,
  CitationVerifier,
  ClaimLedger,
  ClaimsRepo,
  RefLibrary,
  RefsRepo,
  buildQuery,
  checkCitationIntegrity,
  compareFields,
  describeCitation,
  journalNamesMatch,
  parseCitation,
  parseReferenceList,
  renderVerifyResults,
  type CitationCheckSnapshot,
  type CitationVerdict,
  type ClaimSnapshot,
  type FetchImpl,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let refsRepo: RefsRepo;
let claimsRepo: ClaimsRepo;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-cite-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '引文核实测试' });
  project = store.openProject(created.id);
  refsRepo = new RefsRepo(project.db);
  claimsRepo = new ClaimsRepo(project.db);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 一条真实的参考文献条目（Vancouver 格式）。 */
const VANCOUVER =
  'Jumper J, Evans R, Pritzel A. Highly accurate protein structure prediction with AlphaFold. ' +
  'Nature. 2021;596(7873):583-9. doi:10.1038/s41586-021-03819-2';

/** Crossref 对上面那条 DOI 的响应。 */
const CROSSREF_HIT = {
  message: {
    DOI: '10.1038/s41586-021-03819-2',
    type: 'journal-article',
    title: ['Highly accurate protein structure prediction with AlphaFold'],
    'container-title': ['Nature'],
    author: [
      { family: 'Jumper', given: 'John' },
      { family: 'Evans', given: 'Richard' },
    ],
    issued: { 'date-parts': [[2021, 7, 15]] },
    volume: '596',
    page: '583-589',
  },
};

function router(routes: readonly { match: string; body: unknown; status?: number }[]): {
  impl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: FetchImpl = async (url) => {
    calls.push(url);
    for (const route of routes) {
      if (!url.includes(route.match)) continue;
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"message":"not found"}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

function verifier(impl: FetchImpl): { verifier: CitationVerifier; ledger: ClaimLedger } {
  const library = new RefLibrary({
    repo: refsRepo,
    artifacts,
    http: { fetchImpl: impl, maxRetries: 0, mailto: 'test@example.org' },
  });
  const ledger = new ClaimLedger({
    repo: claimsRepo,
    artifactExists: (id) => artifacts.getVersion(id) !== null,
    refExists: (id) => refsRepo.get(id) !== null,
  });
  return {
    verifier: new CitationVerifier({ library, claims: claimsRepo }),
    ledger,
  };
}

/* ------------------------------------------------------------------ *
 * 1. 解析
 * ------------------------------------------------------------------ */

describe('引文解析', () => {
  it('Vancouver 条目：作者、标题、期刊、年份、DOI 都抽出来', () => {
    const parsed = parseCitation(VANCOUVER);
    expect(parsed.shape).toBe('doi');
    expect(parsed.doi).toBe('10.1038/s41586-021-03819-2');
    expect(parsed.firstAuthorSurname).toBe('Jumper');
    expect(parsed.authorSurnames).toEqual(['Jumper', 'Evans', 'Pritzel']);
    expect(parsed.year).toBe(2021);
    expect(parsed.title).toContain('Highly accurate protein structure prediction');
    expect(parsed.container).toBe('Nature');
    expect(parsed.searchable).toBe(true);
  });

  it('APA 条目也能解析', () => {
    const parsed = parseCitation(
      'Smith, J. B., & Jones, A. (2023). Sleep spindles and memory consolidation. ' +
        'Journal of Sleep Research, 32(2), 100-110.',
    );
    expect(parsed.firstAuthorSurname).toBe('Smith');
    expect(parsed.year).toBe(2023);
    expect(parsed.title).toContain('Sleep spindles');
    expect(parsed.container).toContain('Journal of Sleep Research');
  });

  it('裸 DOI', () => {
    const parsed = parseCitation('10.1038/nature12373');
    expect(parsed.shape).toBe('doi');
    expect(parsed.doi).toBe('10.1038/nature12373');
    expect(parsed.searchable).toBe(true);
  });

  it('PMID 只认带标签的：裸数字更可能是卷号或页码', () => {
    expect(parseCitation('PMID: 29456894').pmid).toBe('29456894');
    // 一个裸数字不该被当成 PMID 去查
    expect(parseCitation('29456894').pmid).toBeNull();
  });

  it('arXiv 编号', () => {
    const parsed = parseCitation('arXiv:2401.01234v2');
    expect(parsed.shape).toBe('arxiv');
    expect(parsed.arxivId).toBe('2401.01234');
  });

  it('作者年份引用', () => {
    const parsed = parseCitation('(Smith et al., 2023)');
    expect(parsed.shape).toBe('author-year');
    expect(parsed.firstAuthorSurname).toBe('Smith');
    expect(parsed.year).toBe(2023);
    expect(parsed.searchable).toBe(true);
  });

  it('纯引用标记被明确拒绝，不可检索', () => {
    // 拿标记去检索会返回一堆无关文献，其中最相似的会被判成命中——
    // 于是一条编造的引文被「核实」通过了
    for (const marker of ['[12]', '[3, 5-7]', '\\cite{smith2023sleep}', '@smith2023sleep']) {
      const parsed = parseCitation(marker);
      expect(parsed.shape, marker).toBe('marker-only');
      expect(parsed.searchable, marker).toBe(false);
      expect(parsed.reason, marker).toContain('书目信息');
    }
  });

  it('只有标题时可检索，太短的串不可检索', () => {
    const long = parseCitation('Sleep spindles and memory consolidation in humans');
    expect(long.shape).toBe('title-only');
    expect(long.searchable).toBe(true);

    const short = parseCitation('Nature 2023');
    expect(short.searchable).toBe(false);
    expect(short.reason).toContain('没有可检索的书目信息');
  });

  it('期刊名不会被误认成作者姓氏', () => {
    const parsed = parseCitation('Nature. 2021;596:583-9.');
    // 「Nature」在作者位置被排除，因此这条不该按参考文献条目解析
    expect(parsed.firstAuthorSurname).toBeNull();
  });

  it('年份上界留两年余量（in-press 文献常标下一年）', () => {
    const next = new Date().getUTCFullYear() + 1;
    const parsed = parseCitation(
      `Smith J. A forthcoming study of spindles. Nature. ${String(next)};1:1-2.`,
    );
    expect(parsed.year).toBe(next);
  });

  it('形态标签表齐全', () => {
    for (const shape of [
      'doi',
      'pmid',
      'pmcid',
      'arxiv',
      'reference-entry',
      'author-year',
      'title-only',
      'marker-only',
      'unparseable',
    ] as const) {
      expect(CITATION_SHAPE_LABEL[shape]).toBeTruthy();
    }
  });

  it('describeCitation 在字段稀疏时也给出可读的一行', () => {
    expect(describeCitation(parseCitation(VANCOUVER))).toContain('Jumper');
    expect(describeCitation(parseCitation('[12]'))).toBe('[12]');
  });
});

/* ------------------------------------------------------------------ *
 * 2. 参考文献列表
 * ------------------------------------------------------------------ */

describe('参考文献列表解析', () => {
  it('带序号的列表按序号切分，序号被摘掉', () => {
    const list = [
      '1. Jumper J, Evans R. Highly accurate protein structure prediction. Nature. 2021;596:583-9.',
      '2. Smith J, Jones A. Sleep spindles and memory. J Sleep Res. 2023;32:100-110.',
    ].join('\n');
    const parsed = parseReferenceList(list);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.firstAuthorSurname).toBe('Jumper');
    expect(parsed[1]?.firstAuthorSurname).toBe('Smith');
    // 序号摘掉之后年份才不会被 1 或 2 干扰
    expect(parsed[0]?.year).toBe(2021);
  });

  it('[1] 与 (1) 两种序号都认', () => {
    const list =
      '[1] Smith J. A study of sleep. Nature. 2020;1:1-2.\n(2) Jones A. Another. Cell. 2021;2:3-4.';
    expect(parseReferenceList(list)).toHaveLength(2);
  });

  it('跨行的条目被合成一条', () => {
    const list =
      '1. Jumper J, Evans R, Pritzel A. Highly accurate protein\n' +
      '   structure prediction with AlphaFold. Nature. 2021;596:583-9.\n' +
      '2. Smith J. Sleep spindles and memory consolidation. J Sleep Res. 2023;32:100.\n';
    const parsed = parseReferenceList(list);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.title).toContain('structure prediction with AlphaFold');
  });

  it('没有序号时按行切分', () => {
    const list =
      'Jumper J. Highly accurate protein structure prediction. Nature. 2021;596:583-9.\n\n' +
      'Smith J. Sleep spindles and memory consolidation. J Sleep Res. 2023;32:100-110.\n';
    expect(parseReferenceList(list)).toHaveLength(2);
  });

  it('太短的行被丢掉', () => {
    expect(parseReferenceList('1. x\n2. y\n')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 五档判定
 * ------------------------------------------------------------------ */

describe('核实判定', () => {
  it('DOI 命中且字段一致 → verified，并落下检索记录', async () => {
    const { impl, calls } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({ raw: VANCOUVER, modelId: 'test-model' });

    expect(result.verdict).toBe('verified');
    expect(result.matchedRefId).not.toBeNull();
    expect(result.queries).toEqual(['10.1038/s41586-021-03819-2']);
    expect(calls.length).toBeGreaterThan(0);

    // 需求 13.9 的核心：核实记录必须落库且带真实查询
    const checks = claimsRepo.citationChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toBe('verified');
    expect(checks[0]?.queries).toEqual(['10.1038/s41586-021-03819-2']);
    expect(checks[0]?.modelId).toBe('test-model');
  });

  it('DOI 命中但年份与作者不符 → metadata-mismatch（复制错行）', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    // DOI 是真的，但引文里写的是另一篇文献的作者与年份
    const result = await v.verify({
      raw:
        'Wang L, Chen X. A completely different paper about neural coding. ' +
        'Science. 2015;350:100-110. doi:10.1038/s41586-021-03819-2',
    });

    expect(result.verdict).toBe('metadata-mismatch');
    expect(result.mismatches.length).toBeGreaterThanOrEqual(2);
    expect(result.mismatches.join(' ')).toContain('年份不符');
    expect(result.mismatches.join(' ')).toContain('第一作者不符');
    // 只查「这个 DOI 存不存在」的流程发现不了这一类
    expect(result.detail).toContain('复制参考文献时错了一行');
  });

  it('DOI 在全部上游都查不到 → not-found（可能编造）', async () => {
    const { impl } = router([]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({ raw: '10.9999/definitely-fake-doi-12345' });

    expect(result.verdict).toBe('not-found');
    expect(result.detail).toContain('编造');
    expect(claimsRepo.fabricationSuspects()).toHaveLength(1);
  });

  it('域名未批准 → unverifiable 而不是 not-found', async () => {
    const library = new RefLibrary({
      repo: refsRepo,
      artifacts,
      http: { fetchImpl: router([]).impl, maxRetries: 0 },
      authorizeHosts: async () => [],
    });
    const v = new CitationVerifier({ library, claims: claimsRepo });

    const result = await v.verify({ raw: '10.1038/s41586-021-03819-2' });

    // 把网络/授权故障说成学术不端是不可接受的
    expect(result.verdict).toBe('unverifiable');
    expect(result.detail).toContain('查不了');
    expect(claimsRepo.fabricationSuspects()).toHaveLength(0);
  });

  it('不可检索的引文 → unverifiable，且一次请求都不发', async () => {
    const { impl, calls } = router([{ match: 'api.crossref.org', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({ raw: '[12]' });

    expect(result.verdict).toBe('unverifiable');
    expect(result.queries).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(result.detail).toContain('书目信息');
  });

  it('按标题检索命中 → verified 并入库', async () => {
    const { impl } = router([
      {
        match: 'api.crossref.org/works?',
        body: {
          message: {
            'total-results': 1,
            items: [CROSSREF_HIT.message],
          },
        },
      },
    ]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({
      raw: 'Highly accurate protein structure prediction with AlphaFold',
    });

    expect(result.verdict).toBe('verified');
    expect(result.matchedRefId).not.toBeNull();
    expect(result.similarity).toBeGreaterThan(0.9);
    // 命中后要入库，否则无法作为 ref 类证据绑定
    expect(refsRepo.count()).toBe(1);
  });

  it('标题检索命中但相似度不足 → not-found', async () => {
    const { impl } = router([
      {
        match: 'api.crossref.org/works?',
        body: {
          message: {
            'total-results': 1,
            items: [
              {
                DOI: '10.1000/unrelated',
                type: 'journal-article',
                title: ['Something completely unrelated about volcanoes'],
                issued: { 'date-parts': [[2020]] },
                author: [{ family: 'Other' }],
              },
            ],
          },
        },
      },
    ]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({
      raw: 'Highly accurate protein structure prediction with AlphaFold',
    });

    expect(result.verdict).toBe('not-found');
    expect(result.detail).toContain('不要');
    expect(refsRepo.count()).toBe(0);
  });

  it('两个同样像的候选 → ambiguous，不随便选一个', async () => {
    const near = {
      DOI: '10.1000/a',
      type: 'journal-article',
      title: ['Sleep spindles and memory consolidation in humans'],
      issued: { 'date-parts': [[2023]] },
      author: [{ family: 'Smith' }],
    };
    const alsoNear = {
      ...near,
      DOI: '10.1000/b',
      title: ['Sleep spindles and memory consolidation in humans'],
    };
    const { impl } = router([
      {
        match: 'api.crossref.org/works?',
        body: { message: { 'total-results': 2, items: [near, alsoNear] } },
      },
    ]);
    const { verifier: v } = verifier(impl);

    const result = await v.verify({
      raw: 'Smith J. Sleep spindles and memory consolidation in humans. J Sleep Res. 2023;32:100.',
    });

    // 随便选一个会把引文核实到另一篇文献上——一个看起来成功的错误结果
    expect(result.verdict).toBe('ambiguous');
    expect(result.detail).toContain('无法确定');
    expect(result.matchedRefId).toBeNull();
  });

  it('判定标签表齐全', () => {
    for (const verdict of [
      'verified',
      'metadata-mismatch',
      'not-found',
      'ambiguous',
      'unverifiable',
    ] as CitationVerdict[]) {
      expect(CITATION_VERDICT_LABEL[verdict]).toBeTruthy();
    }
  });

  it('每一次核实都落库，包括不可检索的那些', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    await v.verifyMany([VANCOUVER, '[12]', '10.9999/fake']);

    // 需求 12.6 的精神在这里同样适用：不得静默跳过
    expect(claimsRepo.citationChecks()).toHaveLength(3);
  });

  it('批量核实给出分档计数', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    const outcome = await v.verifyMany([VANCOUVER, '[12]']);
    expect(outcome.counts.verified).toBe(1);
    expect(outcome.counts.unverifiable).toBe(1);
  });

  it('中断信号让批量核实提前停下', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);
    const controller = new AbortController();
    controller.abort();

    const outcome = await v.verifyMany([VANCOUVER, VANCOUVER], { signal: controller.signal });
    expect(outcome.results).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 字段比对
 * ------------------------------------------------------------------ */

describe('字段比对', () => {
  function ref(overrides: Record<string, unknown> = {}) {
    return refsRepo.add({
      csl: {
        id: 'x',
        type: 'article-journal',
        title: 'Sleep spindles and memory consolidation',
        author: [{ family: 'Smith', given: 'John' }],
        issued: { 'date-parts': [[2023]] },
        'container-title': 'Journal of Sleep Research',
        DOI: '10.1000/x',
        ...overrides,
      },
      source: 'test',
    });
  }

  it('引文没写的字段不参与比对', () => {
    // 只有 DOI 的引文不该因为「上游有年份」就算不符
    const parsed = parseCitation('10.1000/x');
    expect(compareFields(parsed, ref())).toHaveLength(0);
  });

  it('期刊缩写与全称不算不符', () => {
    const parsed = parseCitation(
      'Smith J. Sleep spindles and memory consolidation. J Sleep Res. 2023;32:100.',
    );
    const mismatches = compareFields(parsed, ref());
    expect(mismatches.join(' ')).not.toContain('期刊名不符');
  });

  it('期刊名比对按 ISO 4 的前缀规则而不是字符串相似度', () => {
    // 缩写与全称的字符相似度只有 0.44，用相似度门槛这一档就失效了
    expect(journalNamesMatch('J Sleep Res', 'Journal of Sleep Research')).toBe(true);
    expect(journalNamesMatch('J Neurosci', 'Journal of Neuroscience')).toBe(true);
    expect(
      journalNamesMatch(
        'Proc Natl Acad Sci U S A',
        'Proceedings of the National Academy of Sciences of the United States of America',
      ),
    ).toBe(true);
    expect(journalNamesMatch('Nature', 'Nature')).toBe(true);

    // 真正不同的刊物必须判出来
    expect(journalNamesMatch('Nature', 'Journal of Sleep Research')).toBe(false);
    expect(journalNamesMatch('Science', 'Nature')).toBe(false);
    // 只差最后一个词的两份刊物不能混
    expect(journalNamesMatch('J Clin Invest', 'Journal of Clinical Immunology')).toBe(false);
  });

  it('一方缺期刊名时不判不符', () => {
    expect(journalNamesMatch('', 'Nature')).toBe(true);
  });

  it('年份差一年不算不符（电子首发与卷期跨年）', () => {
    const parsed = parseCitation(
      'Smith J. Sleep spindles and memory consolidation. J Sleep Res. 2024;32:100.',
    );
    expect(compareFields(parsed, ref()).join(' ')).not.toContain('年份不符');
  });

  it('年份差两年算不符', () => {
    const parsed = parseCitation(
      'Smith J. Sleep spindles and memory consolidation. J Sleep Res. 2019;32:100.',
    );
    expect(compareFields(parsed, ref()).join(' ')).toContain('年份不符');
  });

  it('标题副标题缺失不算不符', () => {
    const parsed = parseCitation(
      'Smith J. Sleep spindles and memory consolidation: a review. J Sleep Res. 2023;32:100.',
    );
    expect(compareFields(parsed, ref()).join(' ')).not.toContain('标题不符');
  });

  it('buildQuery 优先用标题，退回作者期刊年份', () => {
    expect(buildQuery(parseCitation(VANCOUVER))).toContain('Highly accurate');
    const authorYear = parseCitation('(Smith et al., 2023)');
    expect(buildQuery(authorYear)).toBe('Smith 2023');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 结构性封堵
 * ------------------------------------------------------------------ */

describe('禁止凭记忆作答的结构性封堵', () => {
  it('引文支撑陈述的 supports 结论在没有检索记录时被拒', () => {
    const { ledger } = verifier(router([]).impl);
    const claim = ledger.register({ text: 'Prior work found the same effect [12].' }).claim;
    const claimId = claim?.id as string;
    expect(claim?.kinds).toContain('citation');

    const refRecord = refsRepo.add({
      csl: { id: 'x', type: 'article-journal', title: 'Some paper', DOI: '10.1000/x' },
      source: 'crossref',
    });
    ledger.bind({ claimId, kind: 'ref', ref: refRecord.id });

    const result = ledger.verify({
      claimId,
      kind: 'ref',
      ref: refRecord.id,
      verdict: 'supports',
      modelId: 'some-model',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('13.9');
    expect(result.reason).toContain('verify_citations');
    expect(claimsRepo.get(claimId)?.status).toBe('open');
  });

  it('有检索记录之后 supports 才被接受', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v, ledger } = verifier(impl);

    const claim = ledger.register({
      text: 'Protein structure can now be predicted accurately (Jumper et al., 2021).',
    }).claim;
    const claimId = claim?.id as string;

    await v.verify({ raw: VANCOUVER, claimId });
    expect(claimsRepo.hasRetrievalBackedCheck(claimId)).toBe(true);

    const refId = refsRepo.getByDoi('10.1038/s41586-021-03819-2')?.id as string;
    ledger.bind({ claimId, kind: 'ref', ref: refId });
    const result = ledger.verify({
      claimId,
      kind: 'ref',
      ref: refId,
      verdict: 'supports',
      modelId: 'some-model',
    });

    expect(result.ok).toBe(true);
    expect(result.claim?.status).toBe('supported');
  });

  it('unverifiable 的记录不算「经过检索」', async () => {
    const { verifier: v, ledger } = verifier(router([]).impl);
    const claim = ledger.register({ text: 'Prior work agrees [12].' }).claim;
    const claimId = claim?.id as string;

    // `[12]` 不可检索，因此这次「核实」不产生检索记录
    await v.verify({ raw: '[12]', claimId });
    expect(claimsRepo.citationChecks({ claimId })).toHaveLength(1);
    expect(claimsRepo.hasRetrievalBackedCheck(claimId)).toBe(false);
  });

  it('contradicts 与 insufficient 不受封堵', () => {
    const { ledger } = verifier(router([]).impl);
    const claim = ledger.register({ text: 'Prior work found the same effect [12].' }).claim;
    const claimId = claim?.id as string;
    const refRecord = refsRepo.add({
      csl: { id: 'x', type: 'article-journal', title: 'Some paper', DOI: '10.1000/x' },
      source: 'crossref',
    });
    ledger.bind({ claimId, kind: 'ref', ref: refRecord.id });

    // 判断「这条引文不支持该断言」不需要先证明那篇文献存在
    const result = ledger.verify({
      claimId,
      kind: 'ref',
      ref: refRecord.id,
      verdict: 'contradicts',
      modelId: 'm1',
    });
    expect(result.ok).toBe(true);
    expect(result.claim?.status).toBe('refuted');
  });

  it('非引文类断言不受封堵', () => {
    const { ledger } = verifier(router([]).impl);
    const claim = ledger.register({ text: 'Density differed between groups (p = 0.003).' }).claim;
    const claimId = claim?.id as string;
    expect(claim?.kinds).not.toContain('citation');

    const versionId = artifacts.save({
      filename: 'r.csv',
      content: Buffer.from('a\n1\n'),
      code: 'x',
    }).version.id;
    ledger.bind({ claimId, kind: 'artifact-version', ref: versionId });
    const result = ledger.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: 'm1',
    });
    expect(result.ok).toBe(true);
  });

  it('损坏的 queries_json 被当成「没查过」而不是「查过」', async () => {
    const { impl } = router([{ match: 'api.crossref.org/works/', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);
    const claim = claimsRepo.add({ text: 'x [12]', kind: 'citation' });
    await v.verify({ raw: VANCOUVER, claimId: claim.id });
    expect(claimsRepo.hasRetrievalBackedCheck(claim.id)).toBe(true);

    project.db
      .prepare('UPDATE citation_checks SET queries_json = ? WHERE claim_id = ?')
      .run('{坏 JSON', claim.id);
    // 降级方向必须是「没查过」：反过来会让一条损坏的记录冒充有效核实
    expect(claimsRepo.hasRetrievalBackedCheck(claim.id)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 6. 审查层兜底
 * ------------------------------------------------------------------ */

describe('审查层的引文检查', () => {
  function check(overrides: Partial<CitationCheckSnapshot> = {}): CitationCheckSnapshot {
    return {
      id: 'cc_1',
      claimId: 'cl_1',
      raw: VANCOUVER,
      verdict: 'verified',
      queryCount: 1,
      detail: null,
      matchedRefId: 'rf_1',
      ...overrides,
    };
  }

  function claim(overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
    return {
      id: 'cl_1',
      text: 'Prior work found the same effect [12].',
      locator: 'Discussion ¶2 S1',
      status: 'supported',
      origin: 'user',
      numbers: [],
      isCitation: true,
      retrievalBacked: true,
      evidence: [{ kind: 'ref', ref: 'rf_1', verdict: 'supports', quote: null }],
      ...overrides,
    };
  }

  it('not-found 的核实记录开 FAIL', () => {
    const findings = checkCitationIntegrity({
      checks: [check({ verdict: 'not-found', matchedRefId: null })],
      claims: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.category).toBe('claim');
    expect(findings[0]?.title).toContain('可能是编造的');
  });

  it('metadata-mismatch 开 WARN（文献存在，只是引文写错）', () => {
    const findings = checkCitationIntegrity({
      checks: [check({ verdict: 'metadata-mismatch' })],
      claims: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
  });

  it('verified 与 unverifiable 不产生发现', () => {
    expect(
      checkCitationIntegrity({
        checks: [check({ verdict: 'verified' }), check({ id: 'cc_2', verdict: 'unverifiable' })],
        claims: [],
      }),
    ).toHaveLength(0);
  });

  it('同一条引文只看最近一次结论', () => {
    // 输入按时间倒序：最新的在前
    const findings = checkCitationIntegrity({
      checks: [
        check({ id: 'cc_new', verdict: 'verified' }),
        check({ id: 'cc_old', verdict: 'not-found' }),
      ],
      claims: [],
    });
    expect(findings).toHaveLength(0);
  });

  it('已支持的引文断言没有检索记录时开 FAIL（需求 13.9 兜底）', () => {
    const findings = checkCitationIntegrity({
      checks: [],
      claims: [claim({ retrievalBacked: false })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.detail).toContain('13.9');
    expect(findings[0]?.detail).toContain('verify_citations');
  });

  it('有检索记录时不开发现', () => {
    expect(checkCitationIntegrity({ checks: [], claims: [claim()] })).toHaveLength(0);
  });

  it('非引文类断言不查检索记录', () => {
    expect(
      checkCitationIntegrity({
        checks: [],
        claims: [claim({ isCitation: false, retrievalBacked: false })],
      }),
    ).toHaveLength(0);
  });

  it('未关闭的引文断言不查检索记录（它还没被标成已支持）', () => {
    expect(
      checkCitationIntegrity({
        checks: [],
        claims: [claim({ status: 'open', retrievalBacked: false })],
      }),
    ).toHaveLength(0);
  });

  it('没挂到断言上的核实记录也能作为发现的证据指向', () => {
    const findings = checkCitationIntegrity({
      checks: [check({ verdict: 'not-found', claimId: null })],
      claims: [],
    });
    expect(findings[0]?.evidence[0]?.id).toBe('cc_1');
  });
});

/* ------------------------------------------------------------------ *
 * 7. 渲染
 * ------------------------------------------------------------------ */

describe('结果渲染', () => {
  it('问题最严重的排在前面，已核实的折在最后', async () => {
    // 路由按具体 DOI 匹配：用 `works/` 前缀会让假 DOI 也拿到真记录，
    // 于是「查不到」这一档在测试里根本不会出现
    const { impl } = router([
      { match: 'works/10.1038%2Fs41586-021-03819-2', body: CROSSREF_HIT },
      { match: 'works/10.1038/s41586-021-03819-2', body: CROSSREF_HIT },
    ]);
    const { verifier: v } = verifier(impl);

    const outcome = await v.verifyMany([VANCOUVER, '10.9999/fake', '[12]']);
    const text = renderVerifyResults(outcome.results, outcome.counts);

    expect(outcome.counts.verified).toBe(1);
    expect(outcome.counts['not-found']).toBe(1);

    const fakeAt = text.indexOf('10.9999/fake');
    const verifiedSectionAt = text.indexOf('已核实的');
    expect(fakeAt).toBeGreaterThan(0);
    expect(verifiedSectionAt).toBeGreaterThan(fakeAt);
  });

  it('有查不到的引文时给出明确的下一步', async () => {
    const { impl } = router([]);
    const { verifier: v } = verifier(impl);
    const outcome = await v.verifyMany(['10.9999/fake']);
    const text = renderVerifyResults(outcome.results, outcome.counts);
    expect(text).toContain('不要为它们构造文献记录');
  });

  it('渲染里带上实际检索了什么——已核实的那一行也要有', async () => {
    const { impl } = router([{ match: 'works/10.1038', body: CROSSREF_HIT }]);
    const { verifier: v } = verifier(impl);

    // 一条已核实、一条查不到，两种都要能看出系统真的查了什么。
    // 需求 13.9 的可核查性在「已核实」那一档上最要紧：看不出查了什么的话，
    // 它与「模型说它核实过了」在读者眼里没有区别
    const outcome = await v.verifyMany([VANCOUVER, '10.9999/fake']);
    const text = renderVerifyResults(outcome.results, outcome.counts);

    expect(outcome.counts.verified).toBe(1);
    expect((text.match(/实际检索/gu) ?? []).length).toBe(2);
  });
});
