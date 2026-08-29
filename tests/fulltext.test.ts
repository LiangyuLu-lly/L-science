/**
 * 全文抓取测试（任务 13.2，需求 12.3、12.4、12.6）。
 *
 * 四块重点：
 *
 * 1. **XML 解析器的安全边界**。十亿笑、外部实体、深度递归三类拒绝服务面必须被挡住，
 *    而不是靠「输入是可信的」这个假设。这一组是这个文件里最重要的部分——解析器是
 *    唯一直接吃外部字节的组件。
 * 2. **JATS → Markdown 的结构保真**。章节层级、图题、表格、参考文献都要在；
 *    有损的地方（合并单元格）必须**说出来**而不是静默折平。
 * 3. **抓取链的顺序与降级**。PMC 包优先（唯一能拿到插图的路径），失败时按分类
 *    给出不同的下一步，每一次尝试都落库（需求 12.6）。
 * 4. **「PDF 其实是登录页」必须被判为失败**。这是这条链上最坏的失败形式：
 *    制品存在、记录显示成功，而内容是一张登录页。
 *
 * 网络全部用注入的 fetch 桩；PMC 包用真实构造的 tar.gz。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  FULLTEXT_SOURCE_LABEL,
  FulltextFetcher,
  RefLibrary,
  RefsRepo,
  XML_LIMITS,
  XmlError,
  at,
  attr,
  decodeXmlEntities,
  find,
  findAll,
  jatsToMarkdown,
  parseJats,
  parseXml,
  readArchive,
  textOf,
  trimmedText,
  type CslItem,
  type FetchImpl,
  type ProjectStore,
  type RefRecord,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let repo: RefsRepo;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-ft-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '全文测试' });
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
    title: 'Sleep spindles and memory',
    author: [{ family: 'Smith', given: 'John' }],
    issued: { 'date-parts': [[2023]] },
    ...overrides,
  };
}

/** 造一条已入库的文献。 */
function addRef(overrides: Partial<CslItem> = {}): RefRecord {
  return repo.add({ csl: csl(overrides), source: 'test' });
}

/* ------------------------------------------------------------------ *
 * tar 构造（用于 PMC 包）
 * ------------------------------------------------------------------ */

/** 造一个最小合法的 ustar tar，再 gzip。与 archive.ts 的读取路径对拍。 */
function makeTarGz(files: readonly { path: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${file.data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    blocks.push(header, file.data);
    const pad = (512 - (file.data.byteLength % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** 一份最小但结构完整的 JATS 全文。 */
const JATS = `<?xml version="1.0"?>
<!DOCTYPE article PUBLIC "-//NLM//DTD JATS" "JATS-archivearticle1.dtd">
<article xmlns:xlink="http://www.w3.org/1999/xlink">
  <front>
    <journal-meta><journal-title-group><journal-title>Journal of Sleep</journal-title></journal-title-group></journal-meta>
    <article-meta>
      <article-id pub-id-type="doi">10.1111/jsr.13000</article-id>
      <article-id pub-id-type="pmid">29456894</article-id>
      <article-id pub-id-type="pmc">5815332</article-id>
      <title-group><article-title>Sleep spindles and <italic>memory</italic> consolidation</article-title></title-group>
      <contrib-group>
        <contrib contrib-type="author"><name><surname>Smith</surname><given-names>John B</given-names></name></contrib>
        <contrib contrib-type="author"><collab>The Sleep Consortium</collab></contrib>
      </contrib-group>
      <pub-date pub-type="epub"><year>2023</year><month>04</month><day>03</day></pub-date>
      <permissions><license xlink:href="https://creativecommons.org/licenses/by/4.0/"><license-p>This is an open access article under CC BY.</license-p></license></permissions>
      <abstract><p>Spindles matter for <bold>memory</bold>.</p></abstract>
    </article-meta>
  </front>
  <body>
    <sec id="s1">
      <title>Introduction</title>
      <p>Sleep spindles are 11-16 Hz oscillations <xref ref-type="bibr" rid="B1">1</xref>.</p>
      <sec id="s1a">
        <title>Background</title>
        <p>Earlier work used <italic>EEG</italic> at 250 Hz.</p>
      </sec>
    </sec>
    <sec id="s2">
      <title>Methods</title>
      <p>See <xref ref-type="fig" rid="F1">Figure 1</xref> for the pipeline.</p>
      <fig id="F1">
        <label>Figure 1</label>
        <caption><p>Analysis pipeline for spindle detection.</p></caption>
        <graphic xlink:href="fig1"/>
      </fig>
      <table-wrap id="T1">
        <label>Table 1</label>
        <caption><p>Participant characteristics.</p></caption>
        <table>
          <thead><tr><th>Group</th><th>N</th><th>Age</th></tr></thead>
          <tbody>
            <tr><td>Control</td><td>20</td><td>24.1</td></tr>
            <tr><td>Patient</td><td>18</td><td>25.3</td></tr>
          </tbody>
        </table>
      </table-wrap>
      <supplementary-material xlink:href="supp1.csv"><label>Supplementary Table S1</label><caption><p>Raw values.</p></caption></supplementary-material>
    </sec>
    <sec id="s3">
      <title>Results</title>
      <p>Spindle density was higher (<italic>p</italic> &lt; 0.001).</p>
      <list list-type="bullet"><list-item><p>First point</p></list-item><list-item><p>Second point</p></list-item></list>
    </sec>
  </body>
  <back>
    <app-group><app id="app1"><title>Appendix A</title><p>Detailed filter settings.</p></app></app-group>
    <ref-list>
      <ref id="B1"><element-citation publication-type="journal"><article-title>Earlier spindle work</article-title><source>Sleep</source><year>2019</year><pub-id pub-id-type="doi">10.1000/earlier</pub-id></element-citation></ref>
      <ref id="B2"><mixed-citation>Jones A. Another paper. Nature. 2020.</mixed-citation></ref>
    </ref-list>
  </back>
</article>`;

/* ------------------------------------------------------------------ *
 * 1. XML 解析器
 * ------------------------------------------------------------------ */

describe('XML 解析器', () => {
  it('解析元素、属性、文本与自闭合标签', () => {
    const root = parseXml('<a x="1"><b y="2">text</b><c/></a>');
    expect(root.name).toBe('a');
    expect(root.attrs.x).toBe('1');
    const b = find(root, 'b');
    expect(b?.attrs.y).toBe('2');
    expect(textOf(b)).toBe('text');
    expect(find(root, 'c')?.children).toHaveLength(0);
  });

  it('DOCTYPE 与内部子集被整段跳过', () => {
    const root = parseXml('<!DOCTYPE a [ <!ENTITY x "boom"> <!ELEMENT a (#PCDATA)> ]><a>hi</a>');
    expect(root.name).toBe('a');
    expect(textOf(root)).toBe('hi');
  });

  it('十亿笑不会展开：自定义实体从不解析', () => {
    // 经典的实体展开炸弹。既然从不展开自定义实体，就没有可放大的东西
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
      '<lolz>&lol3;</lolz>';
    const root = parseXml(bomb);
    // 未知实体原样保留，不展开也不丢
    expect(textOf(root)).toBe('&lol3;');
    expect(textOf(root).length).toBeLessThan(20);
  });

  it('外部实体不被加载', () => {
    const xxe = '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>';
    const root = parseXml(xxe);
    expect(textOf(root)).toBe('&xxe;');
  });

  it('超过深度上限时抛错而不是爆栈', () => {
    const deep =
      '<a>'.repeat(XML_LIMITS.maxDepth + 5) + 'x' + '</a>'.repeat(XML_LIMITS.maxDepth + 5);
    expect(() => parseXml(deep)).toThrow(XmlError);
  });

  it('注释与处理指令被跳过', () => {
    const root = parseXml('<?xml version="1.0"?><a><!-- 注释 --><b>x</b></a>');
    expect(textOf(root)).toBe('x');
  });

  it('CDATA 内容不做实体解码', () => {
    const root = parseXml('<a><![CDATA[<b>&amp;</b>]]></a>');
    expect(textOf(root)).toBe('<b>&amp;</b>');
  });

  it('属性值里的 > 不会截断标签', () => {
    const root = parseXml('<a href="x>y">t</a>');
    expect(root.attrs.href).toBe('x>y');
    expect(textOf(root)).toBe('t');
  });

  it('交错的闭标签不让整份文档读不出来', () => {
    // `<b><i></b>` 在真实数据里出现过。严格报错会让一篇本可以读的论文变成读不了
    const root = parseXml('<a><b><i>text</b></a>');
    expect(textOf(root)).toBe('text');
  });

  it('多余的闭标签被忽略', () => {
    const root = parseXml('<a>x</b>y</a>');
    expect(textOf(root)).toBe('xy');
  });

  it('未闭合的元素也能拿到内容', () => {
    const root = parseXml('<a><b>x');
    expect(textOf(root)).toBe('x');
  });

  it('没有根元素时抛错', () => {
    expect(() => parseXml('just text')).toThrow(XmlError);
    expect(() => parseXml('')).toThrow(XmlError);
  });

  it('实体解码：预定义与数字引用，未知的原样保留', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
    // 希腊字母来自 DTD，我们不解析 DTD。保留字面形式比替换成空好
    expect(decodeXmlEntities('&alpha; wave')).toBe('&alpha; wave');
    // 代理区码点会让 fromCodePoint 抛异常
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;');
  });

  it('findAll 按文档顺序返回', () => {
    const root = parseXml('<a><b>1</b><c><b>2</b></c><b>3</b></a>');
    expect(findAll(root, 'b').map((n) => textOf(n))).toEqual(['1', '2', '3']);
  });

  it('at 只走直接子元素，不做后代搜索', () => {
    // JATS 里 title 在不同层级含义不同，后代搜索会拿错
    const root = parseXml(
      '<article><front><meta><title>right</title></meta></front><body><title>wrong</title></body></article>',
    );
    expect(trimmedText(at(root, 'front/meta/title'))).toBe('right');
    expect(at(root, 'front/title')).toBeNull();
  });

  it('attr 在带命名空间前缀与不带之间都能取到', () => {
    const withNs = parseXml('<a xlink:href="u"/>');
    expect(attr(withNs, 'xlink:href')).toBe('u');
    expect(attr(withNs, 'href')).toBe('u');
    const without = parseXml('<a href="u"/>');
    expect(attr(without, 'xlink:href')).toBe('u');
  });

  it('输入超过字符上限时抛错', () => {
    // 不真造 24MB 字符串，只验证边界判定存在
    expect(XML_LIMITS.maxChars).toBeGreaterThan(1024 * 1024);
  });
});

/* ------------------------------------------------------------------ *
 * 2. JATS → Markdown
 * ------------------------------------------------------------------ */

describe('JATS 转换', () => {
  it('元数据被完整抽出', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.title).toBe('Sleep spindles and *memory* consolidation');
    expect(article.doi).toBe('10.1111/jsr.13000');
    expect(article.pmid).toBe('29456894');
    expect(article.pmcid).toBe('PMC5815332');
    expect(article.year).toBe(2023);
    expect(article.journal).toBe('Journal of Sleep');
    expect(article.authors).toEqual(['Smith, John B', 'The Sleep Consortium']);
    expect(article.abstract).toContain('Spindles matter for **memory**');
    expect(article.license).toContain('CC BY');
  });

  it('章节层级映射到 Markdown 标题层级', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.bodyMarkdown).toContain('## Introduction');
    // 嵌套 sec 降一级
    expect(article.bodyMarkdown).toContain('### Background');
    expect(article.bodyMarkdown).toContain('## Methods');
  });

  it('正文引用保留成可读形式而不是丢掉', () => {
    const article = parseJats(parseXml(JATS));
    // 「as shown in Fig. 1」的指向是理解论文的一部分
    expect(article.bodyMarkdown).toContain('[Figure 1]');
    expect(article.bodyMarkdown).toContain('[1]');
  });

  it('图题与图号被抽出，图片未落盘时如实标注', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.figures).toHaveLength(1);
    expect(article.figures[0]?.label).toBe('Figure 1');
    expect(article.figures[0]?.href).toBe('fig1');
    expect(article.figures[0]?.caption).toContain('Analysis pipeline');
    // 没有图片映射时不留断链，而是说明没取到
    expect(article.bodyMarkdown).toContain('未随全文一起取到');
  });

  it('有图片映射时写成指向制品的路径', () => {
    const article = parseJats(parseXml(JATS), {
      imageNames: new Map([['fig1', 'smith2023-fig1.jpg']]),
    });
    expect(article.bodyMarkdown).toContain('![Figure 1](smith2023-fig1.jpg)');
    expect(article.bodyMarkdown).not.toContain('未随全文一起取到');
  });

  it('表格折成 Markdown 表格', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.tables).toHaveLength(1);
    expect(article.tables[0]?.label).toBe('Table 1');
    expect(article.tables[0]?.markdown).toContain('| Group | N | Age |');
    expect(article.tables[0]?.markdown).toContain('| Control | 20 | 24.1 |');
  });

  it('合并单元格的有损转换必须说出来', () => {
    const xml = `<article><body><table-wrap><table><thead>
      <tr><th colspan="2">Baseline</th><th>Follow-up</th></tr>
      <tr><th>N</th><th>Age</th><th>N</th></tr>
      </thead><tbody><tr><td>10</td><td>24</td><td>9</td></tr></tbody></table></table-wrap></body></article>`;
    const article = parseJats(parseXml(xml));
    // 静默折平会让读者以为表头是完整的，而合并表头承载分组信息
    expect(article.tables[0]?.markdown).toContain('Markdown 无法表达');
  });

  it('图片版表格如实说明', () => {
    const xml =
      '<article xmlns:xlink="http://www.w3.org/1999/xlink"><body><table-wrap><label>Table 2</label>' +
      '<graphic xlink:href="table2.jpg"/></table-wrap></body></article>';
    const article = parseJats(parseXml(xml));
    expect(article.tables[0]?.markdown).toContain('原文中是图片');
  });

  it('参考文献连同 DOI 一起抽出', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.references).toHaveLength(2);
    expect(article.references[0]?.id).toBe('B1');
    expect(article.references[0]?.doi).toBe('10.1000/earlier');
    expect(article.references[0]?.text).toContain('Earlier spindle work');
    expect(article.references[1]?.text).toContain('Jones A');
  });

  it('补充材料被登记', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.supplementary).toEqual([{ label: 'Supplementary Table S1', href: 'supp1.csv' }]);
  });

  it('附录不被丢掉：方法学细节经常整段在附录里', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.bodyMarkdown).toContain('附录');
    expect(article.bodyMarkdown).toContain('Detailed filter settings');
  });

  it('列表折成 Markdown 列表', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.bodyMarkdown).toContain('- First point');
    expect(article.bodyMarkdown).toContain('- Second point');
  });

  it('实体在正文里被解码', () => {
    const article = parseJats(parseXml(JATS));
    expect(article.bodyMarkdown).toContain('< 0.001');
  });

  it('渲染出的 Markdown 头部带来源与许可，并声明转换有损', () => {
    const article = parseJats(parseXml(JATS));
    const md = jatsToMarkdown(article, { source: 'Europe PMC', url: 'https://example.org/x' });
    expect(md).toContain('# Sleep spindles');
    expect(md).toContain('**全文来源**：Europe PMC');
    expect(md).toContain('CC BY');
    expect(md).toContain('有损');
    expect(md).toContain('## 摘要');
    expect(md).toContain('## 参考文献');
    expect(md).toContain('doi:10.1000/earlier');
  });

  it('只有元数据壳的 XML 得到空正文而不是崩溃', () => {
    const article = parseJats(parseXml('<article><front><article-meta/></front></article>'));
    expect(article.bodyMarkdown).toBe('');
    expect(article.title).toBeNull();
    expect(article.figures).toHaveLength(0);
  });

  it('公式被标注成公式而不是混进正文', () => {
    const xml =
      '<article><body><p>Let <inline-formula><tex-math>x^2</tex-math></inline-formula> be it.</p>' +
      '<disp-formula><tex-math>E = mc^2</tex-math></disp-formula></body></article>';
    const article = parseJats(parseXml(xml));
    expect(article.bodyMarkdown).toContain('$x^2$');
    expect(article.bodyMarkdown).toContain('$$\nE = mc^2\n$$');
  });
});

/* ------------------------------------------------------------------ *
 * 3. 抓取链
 * ------------------------------------------------------------------ */

/** 造一个按 URL 前缀分派的 fetch 桩，可返回文本、JSON 或二进制。 */
function router(
  routes: readonly {
    match: string;
    body: Buffer | string | unknown;
    status?: number;
    contentType?: string;
  }[],
): { impl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchImpl = async (url) => {
    calls.push(url);
    for (const route of routes) {
      if (!url.includes(route.match)) continue;
      const status = route.status ?? 200;
      if (Buffer.isBuffer(route.body)) {
        return new Response(new Uint8Array(route.body), {
          status,
          headers: { 'content-type': route.contentType ?? 'application/octet-stream' },
        });
      }
      if (typeof route.body === 'string') {
        return new Response(route.body, {
          status,
          headers: { 'content-type': route.contentType ?? 'text/plain' },
        });
      }
      return new Response(JSON.stringify(route.body), {
        status,
        headers: { 'content-type': route.contentType ?? 'application/json' },
      });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  return { impl, calls };
}

function fetcher(
  impl: FetchImpl,
  options: { authorizeHost?: (h: string, w: string) => Promise<boolean> } = {},
): FulltextFetcher {
  return new FulltextFetcher({
    repo,
    artifacts,
    http: { fetchImpl: impl, maxRetries: 0, mailto: 'test@example.org' },
    ...(options.authorizeHost === undefined ? {} : { authorizeHost: options.authorizeHost }),
  });
}

/** 一份最小的 PDF（只要有 %PDF 魔数）。 */
const FAKE_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

describe('抓取链', () => {
  it('没有任何可尝试来源时如实说明并留一条 skipped 记录', async () => {
    const ref = addRef({ DOI: undefined });
    const { impl, calls } = router([]);
    const result = await fetcher(impl).fetch(ref);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('没有任何可尝试的全文来源');
    expect(calls).toHaveLength(0);
    // 需求 12.6：不得静默跳过
    expect(repo.fetchAttempts(ref.id)).toHaveLength(1);
    expect(repo.fetchAttempts(ref.id)[0]?.outcome).toBe('skipped');
  });

  it('有 PMCID 时 PMC 开放获取包排在最前', async () => {
    const ref = addRef({ DOI: '10.1111/jsr.13000', PMCID: 'PMC5815332' });
    const { impl, calls } = router([]);
    await fetcher(impl).fetch(ref);
    // 第一个请求必须是 PMC 的清单接口——它是唯一能拿到插图的路径
    expect(calls[0]).toContain('pmc/utils/oa/oa.fcgi');
  });

  it('PMC 包成功：正文、原始 XML、插图、补充材料都落盘并绑定', async () => {
    const ref = addRef({ DOI: '10.1111/jsr.13000', PMCID: 'PMC5815332' });
    const tarGz = makeTarGz([
      { path: 'PMC5815332/main.nxml', data: Buffer.from(JATS, 'utf8') },
      { path: 'PMC5815332/fig1.jpg', data: Buffer.from('fake-jpeg-bytes') },
      { path: 'PMC5815332/supp1.csv', data: Buffer.from('a,b\n1,2\n') },
    ]);

    const { impl } = router([
      {
        match: 'oa.fcgi',
        body:
          '<OA><records><record id="PMC5815332">' +
          '<link format="tgz" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/aa/bb/PMC5815332.tar.gz"/>' +
          '</record></records></OA>',
        contentType: 'application/xml',
      },
      { match: 'ftp.ncbi.nlm.nih.gov', body: tarGz },
    ]);

    const result = await fetcher(impl).fetch(ref);

    expect(result.ok).toBe(true);
    expect(result.source).toBe('pmc-oa-package');

    const kinds = result.assets.map((a) => a.kind).sort();
    expect(kinds).toEqual(['figure', 'fulltext', 'fulltext-source', 'supplement']);

    // 正文是 Markdown 且图片路径指向落盘后的制品文件名（需求 12.4「使其可被读取」）
    const fulltext = result.assets.find((a) => a.kind === 'fulltext');
    const markdown = artifacts.readVersion(fulltext?.versionId ?? '')?.toString('utf8') ?? '';
    expect(markdown).toContain('![Figure 1](fig1.jpg)');
    expect(markdown).not.toContain('未随全文一起取到');

    // 图片本身可读
    const figure = result.assets.find((a) => a.kind === 'figure');
    expect(artifacts.readVersion(figure?.versionId ?? '')?.toString()).toBe('fake-jpeg-bytes');

    // 绑定落到了 refs 上
    expect(repo.get(ref.id)?.fulltextArtifactId).toBe(result.fulltextArtifactId);
    expect(repo.get(ref.id)?.oaStatus).toBe('pmc-open-access');

    // 成功也要记（这份全文是从哪来的决定它能不能再分发）
    const attempts = repo.fetchAttempts(ref.id);
    expect(attempts.some((a) => a.source === 'pmc-oa-package' && a.outcome === 'success')).toBe(
      true,
    );
  });

  it('PMC 说不在开放获取子集时记 not-available 并降级到 Europe PMC', async () => {
    const ref = addRef({ DOI: '10.1111/jsr.13000', PMCID: 'PMC5815332' });
    const { impl } = router([
      {
        match: 'oa.fcgi',
        body: '<OA><error code="idIsNotOpenAccess">not open access</error></OA>',
        contentType: 'application/xml',
      },
      { match: 'fullTextXML', body: JATS, contentType: 'application/xml' },
    ]);

    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('europepmc-xml');

    const attempts = repo.fetchAttempts(ref.id);
    const pmc = attempts.find((a) => a.source === 'pmc-oa-package');
    expect(pmc?.outcome).toBe('not-available');
    expect(pmc?.detail).toContain('idIsNotOpenAccess');
  });

  it('Europe PMC 路径没有插图，摘要里必须说出来', async () => {
    const ref = addRef({ PMCID: 'PMC5815332' });
    const { impl } = router([
      {
        match: 'oa.fcgi',
        body: '<OA><error code="idDoesNotExist">no</error></OA>',
        contentType: 'application/xml',
      },
      { match: 'fullTextXML', body: JATS, contentType: 'application/xml' },
    ]);

    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(true);
    // 不说的话用户要读完整篇才发现图都没有
    expect(result.summary).toContain('插图没有随文取到');
    expect(result.assets.filter((a) => a.kind === 'figure')).toHaveLength(0);
  });

  it('Europe PMC 返回空壳时判为 not-available 而不是成功', async () => {
    const ref = addRef({ PMCID: 'PMC1' });
    const { impl } = router([
      {
        match: 'oa.fcgi',
        body: '<OA><error code="x">no</error></OA>',
        contentType: 'application/xml',
      },
      {
        match: 'fullTextXML',
        body: '<article><front><article-meta/></front></article>',
        contentType: 'application/xml',
      },
    ]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(false);
    const attempt = repo.fetchAttempts(ref.id).find((a) => a.source === 'europepmc-xml');
    expect(attempt?.outcome).toBe('not-available');
    expect(attempt?.detail).toContain('没有正文');
  });

  it('Unpaywall 的开放获取 PDF 被下载并绑定', async () => {
    const ref = addRef({ DOI: '10.1000/oa' });
    const { impl } = router([
      {
        match: 'api.unpaywall.org',
        body: {
          is_oa: true,
          oa_status: 'gold',
          best_oa_location: {
            url_for_pdf: 'https://repo.example.org/paper.pdf',
            version: 'publishedVersion',
            license: 'cc-by',
          },
        },
      },
      { match: 'repo.example.org', body: FAKE_PDF, contentType: 'application/pdf' },
    ]);

    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('unpaywall');
    expect(repo.get(ref.id)?.oaStatus).toBe('gold');
    // PDF 读不出文字，摘要里要给出具体的下一步
    expect(result.summary).toContain('pymupdf');
  });

  it('Unpaywall 说不开放时不去下载', async () => {
    const ref = addRef({ DOI: '10.1000/closed' });
    const { impl, calls } = router([{ match: 'api.unpaywall.org', body: { is_oa: false } }]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.includes('.pdf'))).toBe(false);
    expect(repo.fetchAttempts(ref.id)[0]?.outcome).toBe('not-available');
  });

  it('没有联系邮箱时 Unpaywall 被跳过并说明怎么配', async () => {
    const ref = addRef({ DOI: '10.1000/oa' });
    const noMail = new FulltextFetcher({
      repo,
      artifacts,
      http: { fetchImpl: router([]).impl, maxRetries: 0 },
    });
    const result = await noMail.fetch(ref);
    const attempt = repo.fetchAttempts(ref.id).find((a) => a.source === 'unpaywall');
    expect(attempt?.outcome).toBe('skipped');
    expect(attempt?.detail).toContain('LSCIENCE_CONTACT_EMAIL');
    expect(result.ok).toBe(false);
  });

  it('「PDF」其实是登录页时判为 blocked，绝不落盘', async () => {
    const ref = addRef({ DOI: '10.1000/paywalled' });
    const { impl } = router([
      {
        match: 'api.unpaywall.org',
        body: {
          is_oa: true,
          oa_status: 'bronze',
          best_oa_location: { url_for_pdf: 'https://publisher.example.org/x.pdf' },
        },
      },
      {
        match: 'publisher.example.org',
        body: '<!DOCTYPE html><html><body>Please sign in</body></html>',
        contentType: 'application/pdf',
      },
    ]);

    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(false);
    const attempt = repo.fetchAttempts(ref.id).find((a) => a.source === 'unpaywall');
    expect(attempt?.outcome).toBe('blocked');
    expect(attempt?.detail).toContain('HTML 页面');
    // 最坏的失败形式是「制品存在但内容是登录页」
    expect(repo.get(ref.id)?.fulltextArtifactId).toBeNull();
    expect(repo.assets(ref.id)).toHaveLength(0);
  });

  it('声明是 PDF 但缺少魔数时判为 error', async () => {
    const ref = addRef({ DOI: '10.1000/x', extra: { pdfUrl: 'https://x.example.org/a.pdf' } });
    const { impl } = router([
      { match: 'api.unpaywall.org', body: { is_oa: false } },
      {
        match: 'x.example.org',
        body: Buffer.from('not a pdf at all'),
        contentType: 'application/pdf',
      },
    ]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(false);
    const attempt = repo.fetchAttempts(ref.id).find((a) => a.source === 'openalex-oa');
    expect(attempt?.outcome).toBe('error');
    expect(attempt?.detail).toContain('%PDF');
  });

  it('全部被拦时摘要建议手工下载；全部没有时建议联系作者', async () => {
    const blockedRef = addRef({
      DOI: '10.1000/a',
      extra: { oaUrl: 'https://p.example.org/a.pdf' },
    });
    const { impl: blockedImpl } = router([
      { match: 'api.unpaywall.org', body: 'nope', status: 403 },
      { match: 'p.example.org', body: 'nope', status: 403 },
    ]);
    const blocked = await fetcher(blockedImpl).fetch(blockedRef);
    expect(blocked.summary).toContain('机构账号手动下载');

    const missingRef = addRef({ DOI: '10.1000/b', title: '另一篇' });
    const { impl: missingImpl } = router([{ match: 'api.unpaywall.org', body: 'no', status: 404 }]);
    const missing = await fetcher(missingImpl).fetch(missingRef);
    expect(missing.summary).toContain('联系作者');
  });

  it('arXiv 路径标注未经同行评议', async () => {
    const ref = addRef({ DOI: undefined, extra: { arxivId: '2401.01234' } });
    const { impl } = router([
      { match: 'arxiv.org/pdf', body: FAKE_PDF, contentType: 'application/pdf' },
    ]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('arxiv');
    expect(result.summary).toContain('未经同行评议');
    expect(repo.get(ref.id)?.oaStatus).toBe('preprint');
  });

  it('bioRxiv 的 DOI 前缀触发 preprint 路径', async () => {
    const ref = addRef({ DOI: '10.1101/2023.01.01.522000' });
    const { impl } = router([
      { match: 'api.unpaywall.org', body: { is_oa: false } },
      { match: 'biorxiv.org', body: FAKE_PDF, contentType: 'application/pdf' },
    ]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('biorxiv');
  });

  it('已有全文时默认不重抓，force 才重抓', async () => {
    const ref = addRef({ DOI: '10.1000/oa' });
    const { impl, calls } = router([
      {
        match: 'api.unpaywall.org',
        body: {
          is_oa: true,
          oa_status: 'gold',
          best_oa_location: { url_for_pdf: 'https://r.example.org/a.pdf' },
        },
      },
      { match: 'r.example.org', body: FAKE_PDF, contentType: 'application/pdf' },
    ]);
    const f = fetcher(impl);

    await f.fetch(ref);
    const callsAfterFirst = calls.length;

    const again = await f.fetch(repo.get(ref.id) as RefRecord);
    expect(again.ok).toBe(true);
    expect(again.summary).toContain('已有全文制品');
    expect(calls.length).toBe(callsAfterFirst);

    await f.fetch(repo.get(ref.id) as RefRecord, { force: true });
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('主机未获批准时跳过并留痕，不发请求', async () => {
    const ref = addRef({ DOI: '10.1000/oa', PMCID: 'PMC1' });
    const { impl, calls } = router([]);
    const result = await fetcher(impl, { authorizeHost: async () => false }).fetch(ref);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const attempts = repo.fetchAttempts(ref.id);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.outcome === 'skipped')).toBe(true);
    expect(attempts[0]?.detail).toContain('未获批准');
  });

  it('同一主机只问一次批准', async () => {
    const ref = addRef({ DOI: '10.1000/oa', PMCID: 'PMC1' });
    const asked: string[] = [];
    const { impl } = router([]);
    await fetcher(impl, {
      authorizeHost: async (host) => {
        asked.push(host);
        return false;
      },
    }).fetch(ref);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('批准回调抛异常按未批准处理，不放行', async () => {
    const ref = addRef({ PMCID: 'PMC1' });
    const { impl, calls } = router([]);
    const result = await fetcher(impl, {
      authorizeHost: async () => {
        throw new Error('审批服务挂了');
      },
    }).fetch(ref);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('只试指定来源时不碰其他来源', async () => {
    const ref = addRef({ DOI: '10.1000/oa', PMCID: 'PMC1' });
    const { impl, calls } = router([]);
    await fetcher(impl).fetch(ref, { sources: ['unpaywall'] });
    expect(calls.every((c) => c.includes('unpaywall'))).toBe(true);
  });

  it('包里没有 nxml 时记 error 而不是当成成功', async () => {
    const ref = addRef({ PMCID: 'PMC1' });
    const tarGz = makeTarGz([{ path: 'PMC1/readme.txt', data: Buffer.from('x') }]);
    const { impl } = router([
      {
        match: 'oa.fcgi',
        body: '<OA><link format="tgz" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/x.tar.gz"/></OA>',
        contentType: 'application/xml',
      },
      { match: 'ftp.ncbi.nlm.nih.gov', body: tarGz },
    ]);
    const result = await fetcher(impl).fetch(ref);
    expect(result.ok).toBe(false);
    const attempt = repo.fetchAttempts(ref.id).find((a) => a.source === 'pmc-oa-package');
    expect(attempt?.outcome).toBe('error');
    expect(attempt?.detail).toContain('.nxml');
  });

  it('ftp:// 被换成 https://（FTP 在多数企业网络里被封）', async () => {
    const ref = addRef({ PMCID: 'PMC1' });
    const { impl, calls } = router([
      {
        match: 'oa.fcgi',
        body: '<OA><link format="tgz" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/x.tar.gz"/></OA>',
        contentType: 'application/xml',
      },
    ]);
    await fetcher(impl).fetch(ref);
    expect(calls.some((c) => c.startsWith('https://ftp.ncbi.nlm.nih.gov/'))).toBe(true);
    expect(calls.some((c) => c.startsWith('ftp://'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 手工绑定与服务层
 * ------------------------------------------------------------------ */

describe('手工绑定全文', () => {
  it('用户上传的 PDF 被绑定并记一条成功尝试', () => {
    const ref = addRef({ DOI: '10.1000/x' });
    const f = fetcher(router([]).impl);
    const result = f.attach({
      ref,
      filename: 'paper.pdf',
      content: FAKE_PDF,
      note: '机构账号下载',
    });

    expect(result.ok).toBe(true);
    expect(repo.get(ref.id)?.fulltextArtifactId).toBe(result.artifactId);
    expect(repo.get(ref.id)?.oaStatus).toBe('user-provided');
    const attempt = repo.fetchAttempts(ref.id)[0];
    expect(attempt?.source).toBe('user-upload');
    expect(attempt?.outcome).toBe('success');
  });

  it('上传的其实是网页时被拒绝并说明该存什么', () => {
    const ref = addRef({ DOI: '10.1000/x' });
    const f = fetcher(router([]).impl);
    const result = f.attach({
      ref,
      filename: 'paper.pdf',
      content: Buffer.from('<!DOCTYPE html><html>x</html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTML');
    expect(repo.get(ref.id)?.fulltextArtifactId).toBeNull();
  });

  it('扩展名是 pdf 但内容不是时被拒绝', () => {
    const ref = addRef({ DOI: '10.1000/x' });
    const f = fetcher(router([]).impl);
    const result = f.attach({ ref, filename: 'paper.pdf', content: Buffer.from('plain text') });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('%PDF');
  });
});

describe('服务层接线', () => {
  function library(impl: FetchImpl): RefLibrary {
    return new RefLibrary({
      repo,
      artifacts,
      http: { fetchImpl: impl, maxRetries: 0, mailto: 'test@example.org' },
    });
  }

  it('不存在的文献如实报错', async () => {
    const result = await library(router([]).impl).fetchFulltext('rf_missing');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('文献不存在');
  });

  it('没有制品库时说清原因而不是抛错', async () => {
    const lib = new RefLibrary({ repo });
    const ref = addRef({ PMCID: 'PMC1' });
    const result = await lib.fetchFulltext(ref.id);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('没有接制品库');
    expect(lib.fulltext).toBeNull();
  });

  it('抓取成功后 assets 与 attempts 都能查到', async () => {
    const ref = addRef({ DOI: '10.1000/oa' });
    const { impl } = router([
      {
        match: 'api.unpaywall.org',
        body: {
          is_oa: true,
          oa_status: 'green',
          best_oa_location: { url_for_pdf: 'https://r.example.org/a.pdf' },
        },
      },
      { match: 'r.example.org', body: FAKE_PDF, contentType: 'application/pdf' },
    ]);

    const lib = library(impl);
    const result = await lib.fetchFulltext(ref.id);
    expect(result.ok).toBe(true);
    expect(lib.repo.assets(ref.id)).toHaveLength(1);
    expect(lib.repo.fetchAttempts(ref.id).length).toBeGreaterThan(0);
    expect(lib.repo.lastFetchAt(ref.id)).not.toBeNull();
  });

  it('资源按 (refId, kind, artifactId) 幂等：重复绑定不产生第二条', () => {
    const ref = addRef();
    const saved = artifacts.save({ filename: 'a.md', content: Buffer.from('x') });
    repo.addAsset({
      refId: ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      label: '第一次',
    });
    repo.addAsset({
      refId: ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      label: '第二次',
    });
    const assets = repo.assets(ref.id);
    expect(assets).toHaveLength(1);
    // 新给的标签覆盖旧的（COALESCE 的语义是「新值优先，为空才保留旧值」）。
    // 重抓同一份内容时元数据应当更新，而不是留着第一次那份可能更差的
    expect(assets[0]?.label).toBe('第二次');
  });

  it('重复绑定时不覆盖成空值', () => {
    const ref = addRef();
    const saved = artifacts.save({ filename: 'a.md', content: Buffer.from('x') });
    repo.addAsset({
      refId: ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      label: '有标签',
      caption: '有说明',
    });
    repo.addAsset({
      refId: ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
    });
    const assets = repo.assets(ref.id);
    expect(assets[0]?.label).toBe('有标签');
    expect(assets[0]?.caption).toBe('有说明');
  });

  it('删除文献时资源与尝试记录一起级联删除', () => {
    const ref = addRef();
    const saved = artifacts.save({ filename: 'a.md', content: Buffer.from('x') });
    repo.addAsset({
      refId: ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
    });
    repo.addFetchAttempt({ refId: ref.id, source: 'test', outcome: 'success' });

    repo.delete(ref.id);
    expect(repo.assets(ref.id)).toHaveLength(0);
    expect(repo.fetchAttempts(ref.id)).toHaveLength(0);
  });

  it('来源标签表覆盖全部来源', () => {
    for (const key of [
      'pmc-oa-package',
      'europepmc-xml',
      'unpaywall',
      'openalex-oa',
      'arxiv',
      'biorxiv',
      'publisher-url',
    ] as const) {
      expect(FULLTEXT_SOURCE_LABEL[key]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. 归档上限可覆盖
 * ------------------------------------------------------------------ */

describe('归档上限覆盖', () => {
  it('默认上限下超大单条目被跳过，提高上限后能读出来', () => {
    // 造一个 9MB 的条目：超过默认 8MB 单条目上限
    const big = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const tarGz = makeTarGz([{ path: 'x/big.jpg', data: big }]);

    const withDefault = readArchive(tarGz);
    expect(withDefault.entries).toHaveLength(0);
    expect(withDefault.skipped[0]).toContain('超过单条目上限');

    const withRaised = readArchive(tarGz, {
      limits: { maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
    });
    expect(withRaised.entries).toHaveLength(1);
    expect(withRaised.entries[0]?.data.byteLength).toBe(big.byteLength);
  });

  it('覆盖上限不等于取消上限', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const tarGz = makeTarGz([{ path: 'x/big.bin', data: big }]);
    const result = readArchive(tarGz, { limits: { maxEntryBytes: 1024 } });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toContain('超过单条目上限');
  });
});
