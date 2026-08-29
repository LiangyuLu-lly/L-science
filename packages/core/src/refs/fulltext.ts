/**
 * 全文抓取（任务 13.2，需求 12.3、12.4、12.6）。
 *
 * 需求要求「按开放获取优先的顺序尝试」。这里的顺序不是随口排的，是按**能拿到什么**
 * 排的，而不是按「哪个更容易成功」：
 *
 * 1. **PMC 开放获取包**（tar.gz）。唯一能一次拿到「结构化正文 + 全部随文插图 +
 *    补充材料」的来源，也是需求 12.4 的唯一可靠途径。放第一位即便它命中率不是最高。
 * 2. **Europe PMC 全文 XML**。结构化正文但没有插图。PMC 包不可用（作者没授权
 *    再分发整包）时的次优。
 * 3. **Unpaywall 指向的开放获取 PDF**。覆盖面最广的开放获取索引，返回的是出版商或
 *    仓储的合法 OA 副本。
 * 4. **OpenAlex 元数据里已有的 OA 链接**。13.1 解析时顺手带回来的，不需要多一次请求。
 * 5. **arXiv PDF**。preprint 的正文，标注未经同行评议。
 * 6. **bioRxiv / medRxiv PDF**。生物医学 preprint。
 *
 * 三条贯穿全链的规则：
 *
 * - **每一次尝试都落库**（`ref_fetch_attempts`），成功与失败都记。需求 12.6 的
 *   「不得静默跳过」只能这样满足。
 * - **失败原因分类**（`not-available` / `blocked` / `error`）。「这篇没有开放获取版本」
 *   与「有但我们被付费墙拦住」对用户的下一步完全不同。
 * - **拿到 HTML 时判定为失败**。出版商的 PDF 链接常常重定向到一个「请登录」页面，
 *   而它返回 200。把那个 HTML 当全文存下来是最坏的结果：制品存在、看起来成功，
 *   而内容是一张登录页。
 */

import type { ArtifactStore } from '../artifact/store.js';
import { ARCHIVE_LIMITS, ArchiveError, readArchive } from '../skills/archive.js';
import type { ArchiveEntry } from '../skills/archive.js';
import type { FetchOutcome, RefAsset, RefRecord, RefsRepo } from '../repo/refs.js';
import { normalizeArxivId, normalizeDoi, normalizePmcid } from './csl.js';
import type { HttpOptions, HttpResult } from './http.js';
import { arr, httpBytes, httpJson, httpText, pick } from './http.js';
import { describeAssets, jatsToMarkdown, parseJats } from './jats.js';
import type { JatsArticle } from './jats.js';
import {
  XmlError,
  attr as xmlAttr,
  findAll as xmlFindAll,
  parseXml,
  trimmedText as xmlTrimmedText,
} from './xml.js';

/** 抓取来源标识。与 `ref_fetch_attempts.source` 的取值一致。 */
export type FulltextSource =
  | 'pmc-oa-package'
  | 'europepmc-xml'
  | 'unpaywall'
  | 'openalex-oa'
  | 'arxiv'
  | 'biorxiv'
  | 'publisher-url';

export const FULLTEXT_SOURCE_LABEL: Readonly<Record<FulltextSource, string>> = {
  'pmc-oa-package': 'PubMed Central 开放获取包',
  'europepmc-xml': 'Europe PMC 全文 XML',
  unpaywall: 'Unpaywall 开放获取副本',
  'openalex-oa': 'OpenAlex 开放获取链接',
  arxiv: 'arXiv',
  biorxiv: 'bioRxiv / medRxiv',
  'publisher-url': '出版商页面',
};

/**
 * 每个来源要访问的主机。域名批准门用它。
 *
 * `publisher-url` 与 `unpaywall`/`openalex-oa` 的实际下载主机是**运行时才知道**的
 * （Unpaywall 会返回任意出版商或仓储的地址）。因此这一层的批准门必须能对单个
 * 运行时主机提问，不能只靠这张静态表——见 `FulltextDeps.authorizeHost`。
 */
export const FULLTEXT_HOSTS: Readonly<Record<FulltextSource, readonly string[]>> = {
  'pmc-oa-package': ['www.ncbi.nlm.nih.gov', 'ftp.ncbi.nlm.nih.gov'],
  'europepmc-xml': ['www.ebi.ac.uk'],
  unpaywall: ['api.unpaywall.org'],
  'openalex-oa': [],
  arxiv: ['arxiv.org', 'export.arxiv.org'],
  biorxiv: ['www.biorxiv.org', 'www.medrxiv.org', 'connect.biorxiv.org'],
  'publisher-url': [],
};

/** PMC 开放获取包的上限。比技能包宽得多——见下方说明。 */
const PMC_ARCHIVE_LIMITS = {
  /*
   * 一篇带十几张高分辨率插图的论文，OA 包常在 30-80MB；单张未压缩 TIFF 就能
   * 超过默认的 8MB 单条目上限。用默认上限的结果是插图被逐个跳过，而需求 12.4
   * 要的正是那些插图。
   *
   * 上限仍然存在，只是数值按用途声明：128MB 包、32MB 单文件、256MB 总量。
   * 超过这些的包会被拒绝并如实记录原因，而不是自动放宽。
   */
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: ARCHIVE_LIMITS.maxEntries,
} as const;

/** 单个 PDF / 图片的字节上限。 */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** 认得出的图片扩展名。PMC 包里出现的就这几种。 */
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'webp', 'svg', 'bmp']);

/** 认得出的补充材料扩展名。可执行文件不在其中——不把它们拉进工作区。 */
const SUPPLEMENT_EXT = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'csv',
  'tsv',
  'txt',
  'zip',
  'json',
  'xml',
  'mp4',
  'avi',
  'mov',
  'r',
  'py',
  'ipynb',
  'fasta',
  'fa',
  'nwk',
]);

export interface FulltextAttemptRecord {
  source: FulltextSource;
  url: string | null;
  outcome: FetchOutcome;
  detail: string | null;
  status: number | null;
  bytes: number | null;
}

export interface FulltextResult {
  ok: boolean;
  /** 成功的来源。失败时为 null。 */
  source: FulltextSource | null;
  /** 正文制品。JATS 路径下是转换出的 Markdown，PDF 路径下是 PDF 本身。 */
  fulltextArtifactId: string | null;
  fulltextVersionId: string | null;
  /** 全部落盘的随文资源。 */
  assets: readonly RefAsset[];
  /** 逐次尝试。需求 12.6 的凭据。 */
  attempts: readonly FulltextAttemptRecord[];
  /** 面向用户的一句话结论。 */
  summary: string;
  /** JATS 路径下解析出的结构信息，供工具输出与 Claim Ledger 用。 */
  article: JatsArticle | null;
}

export interface FulltextDeps {
  repo: RefsRepo;
  artifacts: ArtifactStore;
  http?: HttpOptions;
  /**
   * 单个主机的访问批准。
   *
   * 与元数据那一层的批准门分开，因为这一层的主机是运行时才知道的：Unpaywall 会
   * 返回任意出版商或机构仓储的地址。把它们预先列进白名单是不可能的。
   *
   * 未提供时全部放行（测试与不启用审批通道的部署）。
   */
  authorizeHost?: (host: string, why: string) => Promise<boolean>;
  onLog?: (line: string) => void;
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 文件名清洗：制品文件名会进文件系统，不能含路径分隔符与控制字符。 */
function safeFilename(raw: string, fallback: string): string {
  const base = (raw.split('/').pop() ?? raw).replace(/[\u0000-\u001f<>:"\\|?*]/gu, '_').trim();
  return base === '' || base === '.' || base === '..' ? fallback : base.slice(0, 120);
}

/**
 * 判断一份字节是不是 PDF。
 *
 * 看魔数而不是 Content-Type：出版商返回 `application/pdf` 而正文是 HTML 登录页的
 * 情况非常常见，反过来（返回 octet-stream 而正文是真 PDF）也有。魔数不会撒谎。
 */
function looksLikePdf(bytes: Buffer): boolean {
  // `%PDF-`，允许前面有少量垃圾字节（部分服务器会加 BOM 或空行）
  const head = bytes.subarray(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

/** 判断一份字节是不是 HTML。用于把「PDF 链接其实是登录页」抓出来。 */
function looksLikeHtmlBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml-stylesheet')
  );
}

/** 把 HTTP 失败翻成结果分类。 */
function classify(res: HttpResult): FetchOutcome {
  if (res.status === 401 || res.status === 402 || res.status === 403) return 'blocked';
  if (res.status === 404 || res.status === 410) return 'not-available';
  return 'error';
}

/* ------------------------------------------------------------------ *
 * 抓取器
 * ------------------------------------------------------------------ */

/**
 * 抓取执行器。
 *
 * 做成类而不是一串函数，是因为一次抓取要在多个来源之间共享三样东西：已批准主机的
 * 缓存、尝试记录的累积、以及「已经成功了就停」的状态。用函数串起来的话这三样都要
 * 逐层传递，而漏传一层的表现是「明明成功了还在继续试下一个来源」。
 */
export class FulltextFetcher {
  readonly #repo: RefsRepo;
  readonly #artifacts: ArtifactStore;
  readonly #http: HttpOptions;
  readonly #authorizeHost: ((host: string, why: string) => Promise<boolean>) | null;
  readonly #log: (line: string) => void;
  readonly #hostDecisions = new Map<string, boolean>();

  constructor(deps: FulltextDeps) {
    this.#repo = deps.repo;
    this.#artifacts = deps.artifacts;
    this.#http = deps.http ?? {};
    this.#authorizeHost = deps.authorizeHost ?? null;
    this.#log = deps.onLog ?? ((): void => undefined);
  }

  async #allowed(url: string, why: string): Promise<boolean> {
    if (this.#authorizeHost === null) return true;
    const host = hostOf(url);
    if (host === null) return false;
    const cached = this.#hostDecisions.get(host);
    if (cached !== undefined) return cached;
    let decision = false;
    try {
      decision = await this.#authorizeHost(host, why);
    } catch (err) {
      // 批准流程本身出错按未批准处理。放行会让一次失败的审批等于自动同意
      this.#log(`主机批准失败 ${host}：${err instanceof Error ? err.message : String(err)}`);
      decision = false;
    }
    this.#hostDecisions.set(host, decision);
    return decision;
  }

  /**
   * 抓一条文献的全文。
   *
   * `sources` 省略时按默认顺序全试；给出时只试指定的（用户手工指定「只从 PMC 拿」）。
   * `force` 为真时即使已有全文也重抓（换更好的来源）。
   */
  async fetch(
    ref: RefRecord,
    options: { sources?: readonly FulltextSource[]; force?: boolean } = {},
  ): Promise<FulltextResult> {
    const attempts: FulltextAttemptRecord[] = [];

    const record = (attempt: FulltextAttemptRecord): void => {
      attempts.push(attempt);
      this.#repo.addFetchAttempt({
        refId: ref.id,
        source: attempt.source,
        url: attempt.url,
        outcome: attempt.outcome,
        detail: attempt.detail,
        status: attempt.status,
        bytes: attempt.bytes,
      });
    };

    if (ref.fulltextArtifactId !== null && options.force !== true) {
      return {
        ok: true,
        source: null,
        fulltextArtifactId: ref.fulltextArtifactId,
        fulltextVersionId: null,
        assets: this.#repo.assets(ref.id),
        attempts: [],
        summary: '该文献已有全文制品，未重新抓取。要换来源重抓请指定 force。',
        article: null,
      };
    }

    const order = options.sources ?? this.#plan(ref);
    if (order.length === 0) {
      const summary =
        '这条文献没有任何可尝试的全文来源：既没有 PMCID/DOI/arXiv 编号，' +
        '元数据里也没有开放获取链接。先用 manage_references 的 resolve 补全元数据再试。';
      record({
        source: 'publisher-url',
        url: null,
        outcome: 'skipped',
        detail: summary,
        status: null,
        bytes: null,
      });
      return {
        ok: false,
        source: null,
        fulltextArtifactId: null,
        fulltextVersionId: null,
        assets: [],
        attempts,
        summary,
        article: null,
      };
    }

    for (const source of order) {
      const result = await this.#tryOne(ref, source, record);
      if (result !== null) {
        this.#repo.setFulltext(ref.id, result.fulltextArtifactId, result.oaStatus);
        this.#log(
          `${ref.id} 全文抓取成功，来源 ${FULLTEXT_SOURCE_LABEL[source]}，` +
            `${String(result.assets.length)} 个资源`,
        );
        return {
          ok: true,
          source,
          fulltextArtifactId: result.fulltextArtifactId,
          fulltextVersionId: result.fulltextVersionId,
          assets: result.assets,
          attempts,
          summary: result.summary,
          article: result.article,
        };
      }
    }

    /*
     * 全部失败。摘要里逐条列出试过什么、为什么失败（需求 12.6）。
     *
     * 并且按分类给不同的下一步建议：全是 blocked 说明有全文但拿不到（可以用机构
     * 账号手动下载再上传），全是 not-available 说明确实没有开放获取版本。
     */
    /*
     * 建议按失败的**性质**给，而不是按数量。
     *
     * `skipped` 要排除在判断之外：它表示「这条文献缺这个来源需要的标识」或
     * 「域名没批准」，都不是关于全文本身是否存在的信息。把它算进分母会让
     * 「只有一条 not-available 加一条 skipped」落进「原因混杂」分支，而那句话
     * 对用户毫无用处——实际情况是明确的：没有开放获取版本。
     */
    const attempted = attempts.filter((a) => a.outcome !== 'skipped');
    const blocked = attempted.filter((a) => a.outcome === 'blocked').length;
    const notAvailable = attempted.filter((a) => a.outcome === 'not-available').length;

    const advice =
      blocked > 0
        ? '有来源返回了「无权访问」，说明全文存在但需要订阅或机构网络。' +
          '可以用机构账号手动下载后作为制品上传，再用 attachFulltext 绑定。'
        : attempted.length === 0
          ? '没有任何来源真正被试到：要么这条文献缺少对应的标识（PMCID / DOI / arXiv 编号），' +
            '要么相关域名未获批准访问。先补全元数据或在设置里放行域名。'
          : notAvailable === attempted.length
            ? '所有真正试到的来源都说没有这条记录的开放获取版本。可以试着联系作者索取，' +
              '或确认这篇文献是否真的存在（元数据可能来自一条错误的引用）。'
            : '失败原因混杂，具体见上面每一条。网络类失败稍后可重试。';

    const summary = [
      `全文抓取失败，试过 ${String(attempts.length)} 个来源：`,
      ...attempts.map(
        (a) =>
          `· ${FULLTEXT_SOURCE_LABEL[a.source]}：${a.outcome}${a.detail === null ? '' : ` —— ${a.detail}`}`,
      ),
      '',
      advice,
    ].join('\n');

    return {
      ok: false,
      source: null,
      fulltextArtifactId: null,
      fulltextVersionId: null,
      assets: [],
      attempts,
      summary,
      article: null,
    };
  }

  /**
   * 按这条文献实际拥有的标识排出可尝试的来源。
   *
   * 没有 PMCID 就不试 PMC——那只会浪费一次请求并在记录里留下一条毫无信息量的
   * 「没有 PMCID」。同理没有 arXiv 编号不试 arXiv。
   */
  #plan(ref: RefRecord): readonly FulltextSource[] {
    const out: FulltextSource[] = [];
    const pmcid = ref.pmcid ?? normalizePmcid(ref.csl.PMCID);

    if (pmcid !== null) {
      out.push('pmc-oa-package', 'europepmc-xml');
    } else if (ref.pmid !== null || ref.doi !== null) {
      // 没有 PMCID 但可能在 Europe PMC 里能查到（元数据可能来自别的上游）
      out.push('europepmc-xml');
    }

    if (ref.doi !== null) out.push('unpaywall');
    if (typeof ref.csl.extra?.oaUrl === 'string' || typeof ref.csl.extra?.pdfUrl === 'string') {
      out.push('openalex-oa');
    }
    if ((ref.arxivId ?? normalizeArxivId(asString(ref.csl.extra?.arxivId))) !== null) {
      out.push('arxiv');
    }
    if (ref.doi !== null && /^10\.1101\//u.test(ref.doi)) out.push('biorxiv');

    return [...new Set(out)];
  }

  /** 试一个来源。成功返回落盘结果，失败返回 null（原因已通过 record 落库）。 */
  async #tryOne(
    ref: RefRecord,
    source: FulltextSource,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    switch (source) {
      case 'pmc-oa-package':
        return this.#fromPmcPackage(ref, record);
      case 'europepmc-xml':
        return this.#fromEuropePmcXml(ref, record);
      case 'unpaywall':
        return this.#fromUnpaywall(ref, record);
      case 'openalex-oa':
        return this.#fromKnownOaUrl(ref, record);
      case 'arxiv':
        return this.#fromArxiv(ref, record);
      case 'biorxiv':
        return this.#fromBiorxiv(ref, record);
      default:
        return null;
    }
  }

  /* ---------------- PMC 开放获取包 ---------------- */

  /**
   * 从 PMC 的开放获取包取全文与全部插图（需求 12.4）。
   *
   * 两步：`oa.fcgi` 给出包的地址，然后下载解包。地址是 `ftp://` 形式，要换成
   * `https://ftp.ncbi.nlm.nih.gov/...`——FTP 在多数企业网络里被封，而同一份文件
   * NCBI 用 HTTPS 也提供。这个替换是必需的，不是优化。
   */
  async #fromPmcPackage(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    const pmcid = ref.pmcid ?? normalizePmcid(ref.csl.PMCID);
    if (pmcid === null) {
      record({
        source: 'pmc-oa-package',
        url: null,
        outcome: 'skipped',
        detail: '这条文献没有 PMCID',
        status: null,
        bytes: null,
      });
      return null;
    }

    const listUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${pmcid}`;
    if (!(await this.#allowed(listUrl, `取 ${pmcid} 的开放获取包清单`))) {
      record({
        source: 'pmc-oa-package',
        url: listUrl,
        outcome: 'skipped',
        detail: '访问 www.ncbi.nlm.nih.gov 未获批准',
        status: null,
        bytes: null,
      });
      return null;
    }

    const listRes = await httpText(listUrl, this.#http);
    if (!listRes.ok || listRes.text === null) {
      record({
        source: 'pmc-oa-package',
        url: listUrl,
        outcome: classify(listRes),
        detail: listRes.reason,
        status: listRes.status,
        bytes: null,
      });
      return null;
    }

    /*
     * oa.fcgi 对「不在开放获取子集里」的文献返回 200 加一个 `<error code="idIsNotOpenAccess">`。
     * 不特判它就会掉进「找不到 link 元素」的通用分支，而通用分支说不出原因。
     */
    let packageUrl: string | null = null;
    let errorText: string | null = null;
    try {
      const root = parseXml(listRes.text);
      const errors = xmlFindAll(root, 'error');
      if (errors.length > 0) {
        const first = errors[0] ?? null;
        errorText = `${xmlAttr(first, 'code') ?? 'error'}：${xmlTrimmedText(first)}`;
      }
      for (const link of xmlFindAll(root, 'link')) {
        const format = xmlAttr(link, 'format');
        const href = xmlAttr(link, 'href');
        if (href === null) continue;
        // tgz 里有正文与插图；pdf 只有正文。优先 tgz
        if (format === 'tgz') {
          packageUrl = href;
          break;
        }
      }
    } catch (err) {
      record({
        source: 'pmc-oa-package',
        url: listUrl,
        outcome: 'error',
        detail: `解析开放获取清单失败：${err instanceof Error ? err.message : String(err)}`,
        status: listRes.status,
        bytes: null,
      });
      return null;
    }

    if (packageUrl === null) {
      record({
        source: 'pmc-oa-package',
        url: listUrl,
        outcome: 'not-available',
        detail:
          errorText ??
          `${pmcid} 不在 PMC 开放获取子集里（作者未授权整包再分发）。全文可能仍可通过 Europe PMC 的 XML 接口读到，但不含插图。`,
        status: listRes.status,
        bytes: null,
      });
      return null;
    }

    // ftp:// → https://。FTP 在多数企业网络里被封
    const httpsUrl = packageUrl.replace(
      /^ftp:\/\/ftp\.ncbi\.nlm\.nih\.gov\//iu,
      'https://ftp.ncbi.nlm.nih.gov/',
    );
    if (!(await this.#allowed(httpsUrl, `下载 ${pmcid} 的开放获取包`))) {
      record({
        source: 'pmc-oa-package',
        url: httpsUrl,
        outcome: 'skipped',
        detail: '访问 ftp.ncbi.nlm.nih.gov 未获批准',
        status: null,
        bytes: null,
      });
      return null;
    }

    const pkg = await httpBytes(httpsUrl, {
      ...this.#http,
      timeoutMs: this.#http.timeoutMs ?? 90_000,
    });
    if (!pkg.ok || pkg.bytes === null) {
      record({
        source: 'pmc-oa-package',
        url: httpsUrl,
        outcome: classify(pkg),
        detail: pkg.reason,
        status: pkg.status,
        bytes: null,
      });
      return null;
    }

    let entries: readonly ArchiveEntry[];
    let skipped: readonly string[];
    try {
      const archive = readArchive(pkg.bytes, { limits: PMC_ARCHIVE_LIMITS });
      entries = archive.entries;
      skipped = archive.skipped;
    } catch (err) {
      record({
        source: 'pmc-oa-package',
        url: httpsUrl,
        outcome: 'error',
        detail: `解包失败：${err instanceof ArchiveError ? err.message : err instanceof Error ? err.message : String(err)}`,
        status: pkg.status,
        bytes: pkg.bytes.byteLength,
      });
      return null;
    }

    const nxml = entries.find((e) => e.path.toLowerCase().endsWith('.nxml'));
    if (nxml === undefined) {
      record({
        source: 'pmc-oa-package',
        url: httpsUrl,
        outcome: 'error',
        detail: `包里没有 .nxml 全文文件（有 ${String(entries.length)} 个条目）`,
        status: pkg.status,
        bytes: pkg.bytes.byteLength,
      });
      return null;
    }

    let saved: SaveOutcome;
    try {
      saved = this.#savePackage({
        ref,
        source: 'pmc-oa-package',
        url: httpsUrl,
        nxml: nxml.data,
        entries,
        skipped,
      });
    } catch (err) {
      record({
        source: 'pmc-oa-package',
        url: httpsUrl,
        outcome: 'error',
        detail: `落盘失败：${err instanceof Error ? err.message : String(err)}`,
        status: pkg.status,
        bytes: pkg.bytes.byteLength,
      });
      return null;
    }

    record({
      source: 'pmc-oa-package',
      url: httpsUrl,
      outcome: 'success',
      detail: saved.summary,
      status: pkg.status,
      bytes: pkg.bytes.byteLength,
    });
    return saved;
  }

  /**
   * 把 PMC 包落成一组制品。
   *
   * 顺序有讲究：**先存图片**，拿到制品文件名，再渲染 Markdown。反过来的话
   * Markdown 里的图片路径只能写包内原名（`figure1`，没有扩展名），那是断链。
   */
  #savePackage(input: {
    ref: RefRecord;
    source: FulltextSource;
    url: string;
    nxml: Buffer;
    entries: readonly ArchiveEntry[];
    skipped: readonly string[];
  }): SaveOutcome {
    const root = parseXml(input.nxml.toString('utf8'));
    // 第一遍解析只为拿到图片清单（href → 需要哪些文件）
    const probe = parseJats(root);

    const assets: RefAsset[] = [];
    const imageNames = new Map<string, string>();

    /*
     * JATS 的 `xlink:href` 常常**不带扩展名**（`figure1`），而包里的文件是
     * `figure1.jpg`。因此要按「去掉扩展名后相等」来配对，不能直接查表。
     */
    const byStem = new Map<string, ArchiveEntry>();
    for (const entry of input.entries) {
      const base = entry.path.split('/').pop() ?? entry.path;
      const dot = base.lastIndexOf('.');
      const stem = (dot === -1 ? base : base.slice(0, dot)).toLowerCase();
      if (!byStem.has(stem)) byStem.set(stem, entry);
    }

    const findEntry = (href: string): ArchiveEntry | null => {
      const base = (href.split('/').pop() ?? href).toLowerCase();
      const direct = input.entries.find(
        (e) => e.path.toLowerCase().endsWith(`/${base}`) || e.path.toLowerCase() === base,
      );
      if (direct !== undefined) return direct;
      const dot = base.lastIndexOf('.');
      const stem = dot === -1 ? base : base.slice(0, dot);
      return byStem.get(stem) ?? null;
    };

    let figureCount = 0;
    for (const figure of probe.figures) {
      if (figure.href === null) continue;
      const entry = findEntry(figure.href);
      if (entry === null) continue;
      if (!IMAGE_EXT.has(extOf(entry.path))) continue;

      const filename = safeFilename(entry.path, `${figure.href}.img`);
      const result = this.#artifacts.save({
        filename,
        content: entry.data,
        mime: mimeOf(filename),
      });
      figureCount += 1;
      assets.push(
        this.#repo.addAsset({
          refId: input.ref.id,
          kind: 'figure',
          artifactId: result.artifact.id,
          versionId: result.version.id,
          label: figure.label,
          caption: figure.caption === '' ? null : figure.caption,
          sourceUrl: input.url,
          originPath: figure.href,
        }),
      );
      imageNames.set(figure.href, filename);
    }

    // 补充材料
    let supplementCount = 0;
    for (const supplement of probe.supplementary) {
      const entry = findEntry(supplement.href);
      if (entry === null) continue;
      if (!SUPPLEMENT_EXT.has(extOf(entry.path))) continue;
      const filename = safeFilename(entry.path, supplement.href);
      const result = this.#artifacts.save({
        filename,
        content: entry.data,
        mime: mimeOf(filename),
      });
      supplementCount += 1;
      assets.push(
        this.#repo.addAsset({
          refId: input.ref.id,
          kind: 'supplement',
          artifactId: result.artifact.id,
          versionId: result.version.id,
          label: supplement.label,
          sourceUrl: input.url,
          originPath: supplement.href,
        }),
      );
    }

    // 第二遍：带着图片文件名映射渲染 Markdown
    const article = parseJats(root, { imageNames });
    const markdown = jatsToMarkdown(article, {
      source: FULLTEXT_SOURCE_LABEL[input.source],
      url: input.url,
    });

    const stem = fulltextStem(input.ref);
    const primary = this.#artifacts.save({
      filename: `${stem}.md`,
      content: Buffer.from(markdown, 'utf8'),
      mime: 'text/markdown',
    });

    // 原始 XML 一并留下：Markdown 转换是有损的
    const rawXml = this.#artifacts.save({
      filename: `${stem}.nxml`,
      content: input.nxml,
      mime: 'application/xml',
    });
    assets.push(
      this.#repo.addAsset({
        refId: input.ref.id,
        kind: 'fulltext-source',
        artifactId: rawXml.artifact.id,
        versionId: rawXml.version.id,
        label: '原始 JATS XML',
        sourceUrl: input.url,
      }),
    );
    assets.push(
      this.#repo.addAsset({
        refId: input.ref.id,
        kind: 'fulltext',
        artifactId: primary.artifact.id,
        versionId: primary.version.id,
        label: '正文（Markdown）',
        sourceUrl: input.url,
      }),
    );

    const notes: string[] = [
      `${FULLTEXT_SOURCE_LABEL[input.source]}：正文 ${String(markdown.length)} 字符`,
      describeAssets(article),
      `落盘 ${String(figureCount)} 张插图、${String(supplementCount)} 份补充材料`,
    ];
    // 包里有但没落盘的东西要如实说明，否则用户以为插图齐了
    const missingFigures = article.figures.filter(
      (f) => f.href !== null && !imageNames.has(f.href),
    ).length;
    if (missingFigures > 0) {
      notes.push(`${String(missingFigures)} 张图在包里找不到对应文件，正文里已标注`);
    }
    if (input.skipped.length > 0) {
      notes.push(
        `解包时跳过 ${String(input.skipped.length)} 项：${input.skipped.slice(0, 3).join('；')}`,
      );
    }
    if (article.license !== null) notes.push(`许可：${article.license}`);

    return {
      fulltextArtifactId: primary.artifact.id,
      fulltextVersionId: primary.version.id,
      assets,
      summary: notes.join('\n'),
      article,
      oaStatus: 'pmc-open-access',
    };
  }

  /* ---------------- Europe PMC 全文 XML ---------------- */

  async #fromEuropePmcXml(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    /*
     * Europe PMC 的全文地址要 `<source>/<id>`。多数情况下 source 是 `PMC` + PMCID
     * 的数字部分；只有 PMID 时它也接受 `MED/<pmid>`，但那条路径对没进 PMC 的文献
     * 会 404——那是预期的，记成 not-available。
     */
    const pmcid = ref.pmcid ?? normalizePmcid(ref.csl.PMCID);
    const target =
      pmcid !== null
        ? { source: 'PMC', id: pmcid }
        : ref.pmid !== null
          ? { source: 'MED', id: ref.pmid }
          : null;

    if (target === null) {
      record({
        source: 'europepmc-xml',
        url: null,
        outcome: 'skipped',
        detail: '这条文献既没有 PMCID 也没有 PMID',
        status: null,
        bytes: null,
      });
      return null;
    }

    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${target.source}/${target.id}/fullTextXML`;
    if (!(await this.#allowed(url, '取 Europe PMC 全文 XML'))) {
      record({
        source: 'europepmc-xml',
        url,
        outcome: 'skipped',
        detail: '访问 www.ebi.ac.uk 未获批准',
        status: null,
        bytes: null,
      });
      return null;
    }

    const res = await httpText(url, this.#http);
    if (!res.ok || res.text === null) {
      record({
        source: 'europepmc-xml',
        url,
        outcome: classify(res),
        detail:
          res.status === 404 ? 'Europe PMC 没有这篇的全文（多数订阅期刊论文如此）' : res.reason,
        status: res.status,
        bytes: null,
      });
      return null;
    }

    let article: JatsArticle;
    let root;
    try {
      root = parseXml(res.text);
      article = parseJats(root);
    } catch (err) {
      record({
        source: 'europepmc-xml',
        url,
        outcome: 'error',
        detail: `解析全文 XML 失败：${err instanceof XmlError ? err.message : err instanceof Error ? err.message : String(err)}`,
        status: res.status,
        bytes: res.text.length,
      });
      return null;
    }

    if (article.bodyMarkdown.trim() === '' && article.abstract === null) {
      record({
        source: 'europepmc-xml',
        url,
        outcome: 'not-available',
        detail: '返回的 XML 里没有正文（可能只有元数据壳）',
        status: res.status,
        bytes: res.text.length,
      });
      return null;
    }

    const markdown = jatsToMarkdown(article, {
      source: FULLTEXT_SOURCE_LABEL['europepmc-xml'],
      url,
    });
    const stem = fulltextStem(ref);
    const primary = this.#artifacts.save({
      filename: `${stem}.md`,
      content: Buffer.from(markdown, 'utf8'),
      mime: 'text/markdown',
    });
    const rawXml = this.#artifacts.save({
      filename: `${stem}.jats.xml`,
      content: Buffer.from(res.text, 'utf8'),
      mime: 'application/xml',
    });

    const assets = [
      this.#repo.addAsset({
        refId: ref.id,
        kind: 'fulltext',
        artifactId: primary.artifact.id,
        versionId: primary.version.id,
        label: '正文（Markdown）',
        sourceUrl: url,
      }),
      this.#repo.addAsset({
        refId: ref.id,
        kind: 'fulltext-source',
        artifactId: rawXml.artifact.id,
        versionId: rawXml.version.id,
        label: '原始 JATS XML',
        sourceUrl: url,
      }),
    ];

    /*
     * 这条路径**没有插图**。必须说出来。
     *
     * 用户看到「全文抓取成功」之后会去引图，而正文 Markdown 里每张图的位置都标着
     * 「图片文件未随全文一起取到」。不在摘要里提一句的话，他要读完整篇才发现。
     */
    const summary = [
      `${FULLTEXT_SOURCE_LABEL['europepmc-xml']}：正文 ${String(markdown.length)} 字符`,
      describeAssets(article),
      article.figures.length > 0
        ? `注意：这条路径只给正文 XML，${String(article.figures.length)} 张插图没有随文取到（图题在正文里）。` +
          '需要插图的话确认该文是否在 PMC 开放获取子集里。'
        : '该文没有插图。',
      ...(article.license === null ? [] : [`许可：${article.license}`]),
    ].join('\n');

    const saved: SaveOutcome = {
      fulltextArtifactId: primary.artifact.id,
      fulltextVersionId: primary.version.id,
      assets,
      summary,
      article,
      oaStatus: 'europepmc-open',
    };

    record({
      source: 'europepmc-xml',
      url,
      outcome: 'success',
      detail: summary,
      status: res.status,
      bytes: res.text.length,
    });
    return saved;
  }

  /* ---------------- Unpaywall ---------------- */

  async #fromUnpaywall(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    const doi = ref.doi ?? normalizeDoi(ref.csl.DOI);
    if (doi === null) {
      record({
        source: 'unpaywall',
        url: null,
        outcome: 'skipped',
        detail: '这条文献没有 DOI',
        status: null,
        bytes: null,
      });
      return null;
    }

    /*
     * Unpaywall 要求 `email` 参数，没有它一律 422。
     *
     * 没配置联系邮箱时**不编一个**：假邮箱会让这个 UA 被整体拉黑，代价是所有用户
     * 都用不了这条路径。如实跳过并说明怎么配。
     */
    const mailto = this.#http.mailto ?? null;
    if (mailto === null || mailto.trim() === '') {
      record({
        source: 'unpaywall',
        url: null,
        outcome: 'skipped',
        detail:
          'Unpaywall 要求提供联系邮箱。设置环境变量 LSCIENCE_CONTACT_EMAIL 后可用。' +
          '不填假地址是刻意的——假地址会让整个客户端被上游拉黑。',
        status: null,
        bytes: null,
      });
      return null;
    }

    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mailto.trim())}`;
    if (!(await this.#allowed(url, '查询 Unpaywall 开放获取副本'))) {
      record({
        source: 'unpaywall',
        url,
        outcome: 'skipped',
        detail: '访问 api.unpaywall.org 未获批准',
        status: null,
        bytes: null,
      });
      return null;
    }

    const res = await httpJson(url, this.#http);
    if (!res.ok) {
      record({
        source: 'unpaywall',
        url,
        outcome: classify(res),
        detail: res.reason,
        status: res.status,
        bytes: null,
      });
      return null;
    }

    if (pick(res.json, 'is_oa') !== true) {
      record({
        source: 'unpaywall',
        url,
        outcome: 'not-available',
        detail: 'Unpaywall 说这篇没有开放获取版本',
        status: res.status,
        bytes: null,
      });
      return null;
    }

    // best_oa_location 优先，其次遍历全部 oa_locations。前者是 Unpaywall 的推荐，
    // 但它偶尔指向一个已失效的仓储副本，而列表里另有可用的
    const candidates: { url: string; version: string | null; license: string | null }[] = [];
    const pushLocation = (location: unknown): void => {
      const pdf = asString(pick(location, 'url_for_pdf'));
      const landing = asString(pick(location, 'url'));
      const target = pdf ?? landing;
      if (target === undefined) return;
      candidates.push({
        url: target,
        version: asString(pick(location, 'version')) ?? null,
        license: asString(pick(location, 'license')) ?? null,
      });
    };
    pushLocation(pick(res.json, 'best_oa_location'));
    for (const location of arr(pick(res.json, 'oa_locations'))) pushLocation(location);

    const oaStatus = asString(pick(res.json, 'oa_status')) ?? 'open';
    const deduped = candidates.filter(
      (c, index) => candidates.findIndex((o) => o.url === c.url) === index,
    );

    if (deduped.length === 0) {
      record({
        source: 'unpaywall',
        url,
        outcome: 'not-available',
        detail: 'Unpaywall 标记为开放获取但没给出可下载地址',
        status: res.status,
        bytes: null,
      });
      return null;
    }

    for (const candidate of deduped.slice(0, 4)) {
      const saved = await this.#downloadDocument({
        ref,
        source: 'unpaywall',
        url: candidate.url,
        oaStatus,
        note:
          `Unpaywall${candidate.version === null ? '' : `（${candidate.version}）`}` +
          `${candidate.license === null ? '' : `，许可 ${candidate.license}`}`,
        record,
      });
      if (saved !== null) return saved;
    }
    return null;
  }

  /* ---------------- 元数据里已有的 OA 链接 ---------------- */

  async #fromKnownOaUrl(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    const urls = [asString(ref.csl.extra?.oaUrl), asString(ref.csl.extra?.pdfUrl)].filter(
      (u): u is string => u !== undefined,
    );
    const unique = [...new Set(urls)];

    if (unique.length === 0) {
      record({
        source: 'openalex-oa',
        url: null,
        outcome: 'skipped',
        detail: '元数据里没有开放获取链接',
        status: null,
        bytes: null,
      });
      return null;
    }

    for (const url of unique) {
      const saved = await this.#downloadDocument({
        ref,
        source: 'openalex-oa',
        url,
        oaStatus: asString(ref.csl.extra?.oaStatus) ?? 'open',
        note: 'OpenAlex 元数据里的开放获取链接',
        record,
      });
      if (saved !== null) return saved;
    }
    return null;
  }

  /* ---------------- arXiv ---------------- */

  async #fromArxiv(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    const arxivId = ref.arxivId ?? normalizeArxivId(asString(ref.csl.extra?.arxivId));
    if (arxivId === null) {
      record({
        source: 'arxiv',
        url: null,
        outcome: 'skipped',
        detail: '这条文献没有 arXiv 编号',
        status: null,
        bytes: null,
      });
      return null;
    }
    return this.#downloadDocument({
      ref,
      source: 'arxiv',
      url: `https://arxiv.org/pdf/${arxivId}`,
      oaStatus: 'preprint',
      // 这句会进制品的说明与工具输出：preprint 未经同行评议，引用时必须标注
      note: 'arXiv preprint —— 未经同行评议，引用时须标注',
      record,
    });
  }

  /* ---------------- bioRxiv / medRxiv ---------------- */

  async #fromBiorxiv(
    ref: RefRecord,
    record: (a: FulltextAttemptRecord) => void,
  ): Promise<SaveOutcome | null> {
    const doi = ref.doi;
    if (doi === null || !/^10\.1101\//u.test(doi)) {
      record({
        source: 'biorxiv',
        url: null,
        outcome: 'skipped',
        detail: '不是 bioRxiv / medRxiv 的 DOI（前缀应为 10.1101）',
        status: null,
        bytes: null,
      });
      return null;
    }

    /*
     * 两个站点用同一个 DOI 前缀，从 DOI 上分不出是哪个。都试一遍比先查一次接口
     * 再下载更省一个往返，而错的那个会 404——那是一条有信息量的记录。
     */
    for (const host of ['www.biorxiv.org', 'www.medrxiv.org']) {
      const saved = await this.#downloadDocument({
        ref,
        source: 'biorxiv',
        url: `https://${host}/content/${doi}v1.full.pdf`,
        oaStatus: 'preprint',
        note: `${host} preprint —— 未经同行评议，引用时须标注`,
        record,
      });
      if (saved !== null) return saved;
    }
    return null;
  }

  /* ---------------- 通用文档下载 ---------------- */

  /**
   * 下载一份 PDF（或其它文档）并落成制品。
   *
   * 这里挡住这条链上最坏的失败形式：出版商的 PDF 链接重定向到一个「请登录」页面
   * 并返回 200。把那份 HTML 存成全文之后，制品存在、抓取记录显示成功，而内容是
   * 一张登录页——用户要打开它才发现，而模型根本发现不了。因此按魔数判定，
   * 拿到 HTML 一律记成 `blocked`。
   */
  async #downloadDocument(input: {
    ref: RefRecord;
    source: FulltextSource;
    url: string;
    oaStatus: string;
    note: string;
    record: (a: FulltextAttemptRecord) => void;
  }): Promise<SaveOutcome | null> {
    if (!(await this.#allowed(input.url, `下载全文：${input.url}`))) {
      input.record({
        source: input.source,
        url: input.url,
        outcome: 'skipped',
        detail: `访问 ${hostOf(input.url) ?? input.url} 未获批准`,
        status: null,
        bytes: null,
      });
      return null;
    }

    const res = await httpBytes(input.url, {
      ...this.#http,
      timeoutMs: this.#http.timeoutMs ?? 60_000,
    });
    if (!res.ok || res.bytes === null) {
      input.record({
        source: input.source,
        url: input.url,
        outcome: classify(res),
        detail: res.reason,
        status: res.status,
        bytes: null,
      });
      return null;
    }

    if (res.bytes.byteLength > MAX_PDF_BYTES) {
      input.record({
        source: input.source,
        url: input.url,
        outcome: 'error',
        detail: `文件 ${String(Math.round(res.bytes.byteLength / 1024 / 1024))}MB 超过 ${String(MAX_PDF_BYTES / 1024 / 1024)}MB 上限`,
        status: res.status,
        bytes: res.bytes.byteLength,
      });
      return null;
    }

    if (looksLikeHtmlBytes(res.bytes)) {
      input.record({
        source: input.source,
        url: input.url,
        outcome: 'blocked',
        detail:
          `返回的是 HTML 页面而不是文档${res.finalUrl === null || res.finalUrl === input.url ? '' : `（重定向到 ${res.finalUrl}）`}。` +
          '常见原因是付费墙、需要机构网络，或者需要接受 cookie。',
        status: res.status,
        bytes: res.bytes.byteLength,
      });
      return null;
    }

    const isPdf = looksLikePdf(res.bytes);
    if (!isPdf && (res.contentType ?? '').includes('pdf')) {
      // 声明是 PDF 但魔数不对：内容被中间设备改过，或者是个错误页
      input.record({
        source: input.source,
        url: input.url,
        outcome: 'error',
        detail: '响应声明是 PDF 但内容不是（缺少 %PDF 标记）',
        status: res.status,
        bytes: res.bytes.byteLength,
      });
      return null;
    }

    if (!isPdf) {
      const head = res.bytes.subarray(0, 200).toString('utf8').trim();
      input.record({
        source: input.source,
        url: input.url,
        outcome: 'error',
        detail: `拿到的不是 PDF（开头是「${head.slice(0, 60)}」）`,
        status: res.status,
        bytes: res.bytes.byteLength,
      });
      return null;
    }

    const stem = fulltextStem(input.ref);
    const saved = this.#artifacts.save({
      filename: `${stem}.pdf`,
      content: res.bytes,
      mime: 'application/pdf',
    });

    const asset = this.#repo.addAsset({
      refId: input.ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      label: 'PDF 全文',
      caption: input.note,
      sourceUrl: input.url,
    });

    /*
     * PDF 是二进制，`read_file` 读不出文字。
     *
     * 摘要里给出下一步的具体做法，否则模型会反复尝试读它然后失败。这条建议指向
     * Python 内核而不是某个内置能力，因为提取 PDF 文字确实要在执行平面做。
     */
    const summary = [
      `${FULLTEXT_SOURCE_LABEL[input.source]}：PDF ${String(Math.round(res.bytes.byteLength / 1024))}KB`,
      input.note,
      '这是二进制 PDF，直接读取不到文字。要读正文请在 python 内核里用 pymupdf：' +
        `\`import fitz; doc = fitz.open("{{artifact:${saved.version.id}}}"); print(doc[0].get_text())\`` +
        '（`pdf-explore` 技能里有完整做法）。',
    ].join('\n');

    input.record({
      source: input.source,
      url: input.url,
      outcome: 'success',
      detail: summary,
      status: res.status,
      bytes: res.bytes.byteLength,
    });

    return {
      fulltextArtifactId: saved.artifact.id,
      fulltextVersionId: saved.version.id,
      assets: [asset],
      summary,
      article: null,
      oaStatus: input.oaStatus,
    };
  }

  /**
   * 把用户手工下载的文件绑定为全文。
   *
   * 付费墙后的论文用机构账号下载之后要有地方进来，否则「抓不到就没办法」会让
   * 整个文献流水线在订阅期刊上失效——而那是绝大多数期刊。
   */
  attach(input: { ref: RefRecord; filename: string; content: Buffer; note?: string }): {
    ok: boolean;
    artifactId: string | null;
    versionId: string | null;
    reason: string | null;
  } {
    const ext = extOf(input.filename);

    /*
     * HTML 判定放在 PDF 魔数判定**之前**。
     *
     * 两个检查都会拒掉「文件名是 .pdf 而内容是登录页」这种最常见的情形，但给出的
     * 原因不同：「缺少 %PDF 标记」说的是症状，「这是一个网页」说的是原因并能给出
     * 该怎么做。用户拿到前一句会去检查文件是不是损坏了，而实际问题是他保存错了东西。
     */
    if (looksLikeHtmlBytes(input.content)) {
      return {
        ok: false,
        artifactId: null,
        versionId: null,
        reason:
          '这是一个 HTML 页面而不是文档。用浏览器「另存为」出版商页面得到的常常是这个，' +
          '要的是页面上那个 PDF 链接的目标。',
      };
    }
    if (ext === 'pdf' && !looksLikePdf(input.content)) {
      return {
        ok: false,
        artifactId: null,
        versionId: null,
        reason: '文件名是 .pdf 但内容不是 PDF（缺少 %PDF 标记）。文件可能在传输中被截断了。',
      };
    }

    const saved = this.#artifacts.save({
      filename: safeFilename(
        input.filename,
        `${fulltextStem(input.ref)}.${ext === '' ? 'bin' : ext}`,
      ),
      content: input.content,
      mime: mimeOf(input.filename),
    });

    this.#repo.addAsset({
      refId: input.ref.id,
      kind: 'fulltext',
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      label: '用户提供的全文',
      caption: input.note ?? null,
    });
    this.#repo.setFulltext(input.ref.id, saved.artifact.id, 'user-provided');
    this.#repo.addFetchAttempt({
      refId: input.ref.id,
      source: 'user-upload',
      outcome: 'success',
      detail: `用户提供：${input.filename}（${String(Math.round(input.content.byteLength / 1024))}KB）`,
      bytes: input.content.byteLength,
    });

    return { ok: true, artifactId: saved.artifact.id, versionId: saved.version.id, reason: null };
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

interface SaveOutcome {
  fulltextArtifactId: string;
  fulltextVersionId: string;
  assets: readonly RefAsset[];
  summary: string;
  article: JatsArticle | null;
  oaStatus: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 制品文件名的主干。
 *
 * 用「姓氏 + 年份」而不是记录 id：制品列表里 `smith2023.pdf` 认得出是哪一篇，
 * 而 `rf_8f3a...pdf` 认不出。冲突不要紧——制品按内容寻址，同名不同内容是两个版本，
 * 而同名同内容本来就该去重。
 */
function fulltextStem(ref: RefRecord): string {
  const author = (ref.firstAuthor ?? '').replace(/[^a-z0-9]/gu, '').slice(0, 24);
  const year = ref.year === null ? '' : String(ref.year);
  const base = `${author}${year}`;
  return base === '' ? ref.id.replace(/^rf_/u, 'ref-').slice(0, 24) : base;
}

/** 按扩展名给 MIME。制品的 kind 推断与 UI 预览都要它。 */
function mimeOf(filename: string): string | null {
  const map: Readonly<Record<string, string>> = {
    pdf: 'application/pdf',
    md: 'text/markdown',
    xml: 'application/xml',
    nxml: 'application/xml',
    json: 'application/json',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return map[extOf(filename)] ?? null;
}
