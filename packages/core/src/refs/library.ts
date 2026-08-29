/**
 * 文献库服务（任务 13.1，需求 12.1、12.2）。
 *
 * 把「解析 → 去重判定 → 入库」串成一件事。分成三层的理由是各层的失败方式完全不同：
 * `sources.ts` 的失败是网络与上游，`dedupe.ts` 的失败是判断，仓储的失败是约束冲突。
 * 混在一起之后「这条文献为什么没进库」会有十几种可能，而错误信息只能说其中一种。
 *
 * 这一层的核心决策：**命中重复时补全而不是拒绝**。
 *
 * 用户第二次添加同一个 DOI 通常不是误操作，而是他在别处拿到了更完整的信息，或者
 * 上一次解析时某家上游正好挂了。直接返回「已存在」会让库里那条残缺记录永远残缺，
 * 而用户没有任何办法修它（除了删掉重加，那会丢掉已有的证据绑定）。因此这里合并
 * 新解析到的字段并报告 `enriched`。
 */

import type { ArtifactStore } from '../artifact/store.js';
import type { RefRecord, RefsRepo } from '../repo/refs.js';
import { mergeSourceLabel } from '../repo/refs.js';
import { bibtexKeyFor, toBibtex } from './bibtex.js';
import type { ExportFormat, ExportOptions, ExportResult } from './export.js';
import { assignKeys, exportRefs } from './export.js';
import type { FulltextResult, FulltextSource } from './fulltext.js';
import { FulltextFetcher } from './fulltext.js';
import type { CslItem } from './csl.js';
import { citeLine } from './csl.js';
import type { MatchResult } from './dedupe.js';
import { completeness, fingerprint, matchRefs, mergeCsl } from './dedupe.js';
import type { RefSourceId } from './http.js';
import type { ResolveOptions } from './resolver.js';
import {
  DEFAULT_DOI_SOURCES,
  DEFAULT_SEARCH_SOURCES,
  resolveIdentifier,
  searchRefs,
  sniffIdentifier,
} from './resolver.js';
import type { SourceCandidate, SourceResult, SourceSearchResult } from './sources.js';

/** 一次「可疑重复」的报告。 */
export interface DuplicateSuspect {
  refId: string;
  cite: string;
  reason: string;
  similarity: number;
}

export interface AddOutcome {
  ok: boolean;
  ref: RefRecord | null;
  /** 是新建还是命中已有。 */
  created: boolean;
  /** 命中已有且这次解析补上了新字段。 */
  enriched: boolean;
  /** 命中的已有记录（created 为 false 时非空）。 */
  duplicateOf: RefRecord | null;
  /** 判定依据。 */
  match: MatchResult | null;
  /** 判为 likely 但未合并的记录。用户需要知道它们存在。 */
  suspects: readonly DuplicateSuspect[];
  /** 元数据解析的逐源结果。失败时用户要看到试过谁。 */
  attempts: readonly SourceResult[];
  reason: string | null;
}

/**
 * 每家上游会访问的主机。
 *
 * 显式列出来而不是从 URL 里现推：域名批准门要在**发请求之前**知道会连哪些主机，
 * 才能把六家合成一张审批卡片。边发边问会在一次 DOI 解析里弹出三张卡片，用户根本
 * 不知道自己在批准什么。
 *
 * 这几个主机与连接器目录里的域名有重叠（`api.openalex.org`、
 * `eutils.ncbi.nlm.nih.gov`、`www.ebi.ac.uk` 已由 OpenAlex / PubMed / ChEMBL 连接器
 * 带进白名单）。重叠是好事：开着那些连接器的用户不会再被问一次。
 */
export const REF_SOURCE_HOSTS: Readonly<Record<RefSourceId, readonly string[]>> = {
  crossref: ['api.crossref.org'],
  openalex: ['api.openalex.org'],
  semanticscholar: ['api.semanticscholar.org'],
  pubmed: ['eutils.ncbi.nlm.nih.gov'],
  europepmc: ['www.ebi.ac.uk'],
  datacite: ['api.datacite.org'],
  arxiv: ['export.arxiv.org'],
  unpaywall: ['api.unpaywall.org'],
  openaire: ['api.openaire.eu'],
};

export interface RefLibraryDeps {
  repo: RefsRepo;
  /** 解析上游的公共选项（mailto、API key、超时、fetch 注入）。 */
  http?: ResolveOptions;
  /** 制品库。抓全文与导出 .bib / .json 时用（需求 12.3、12.5）。 */
  artifacts?: ArtifactStore;
  /**
   * 全文抓取的单主机批准。
   *
   * 与元数据的 `authorizeHosts` 分开，因为这一层的主机是运行时才知道的：Unpaywall
   * 会返回任意出版商或机构仓储的地址，预先列白名单不可能。
   */
  authorizeFulltextHost?: (host: string, why: string) => Promise<boolean>;
  /**
   * 域名批准门。
   *
   * 后端进程的 fetch **不经出口代理**，因此出口代理的域名白名单管不到这里。
   * 没有这个回调时全部放行——测试与不启用审批通道的部署走这条路；生产由
   * `backend.ts` 接到 `GrantRepo` 与审批服务上。
   *
   * 返回获批主机的子集。未获批的上游会被排除并在结果里如实报告，而不是
   * 静默跳过——否则「为什么只有两家有结果」无从解释。
   */
  authorizeHosts?: (hosts: readonly string[]) => Promise<readonly string[]>;
  onLog?: (line: string) => void;
}

export class RefLibrary {
  readonly repo: RefsRepo;
  readonly #http: ResolveOptions;
  readonly #artifacts: ArtifactStore | null;
  readonly #log: (line: string) => void;
  readonly #authorizeHosts: ((hosts: readonly string[]) => Promise<readonly string[]>) | null;
  readonly #authorizeFulltextHost: ((host: string, why: string) => Promise<boolean>) | null;
  /** 已获批主机。一次会话内只问一次。 */
  #allowedHosts: Set<string> | null = null;
  /** 正在进行的批准请求。并发调用共用同一次询问，不会弹出两张卡片。 */
  #authorizing: Promise<Set<string>> | null = null;
  /** 全文抓取器。惰性建：没有制品库时它建不起来。 */
  #fetcher: FulltextFetcher | null = null;

  constructor(deps: RefLibraryDeps) {
    this.repo = deps.repo;
    this.#http = deps.http ?? {};
    this.#artifacts = deps.artifacts ?? null;
    this.#log = deps.onLog ?? ((): void => undefined);
    this.#authorizeHosts = deps.authorizeHosts ?? null;
    this.#authorizeFulltextHost = deps.authorizeFulltextHost ?? null;
  }

  get artifacts(): ArtifactStore | null {
    return this.#artifacts;
  }

  /**
   * 全文抓取器。
   *
   * 没有制品库时返回 null 而不是抛错：抓全文本质上是「把外部内容存成制品」，
   * 没有制品库这件事就无从谈起。调用方按 null 给出可读的原因。
   */
  get fulltext(): FulltextFetcher | null {
    if (this.#artifacts === null) return null;
    if (this.#fetcher === null) {
      this.#fetcher = new FulltextFetcher({
        repo: this.repo,
        artifacts: this.#artifacts,
        http: this.#http,
        ...(this.#authorizeFulltextHost === null
          ? {}
          : { authorizeHost: this.#authorizeFulltextHost }),
        onLog: this.#log,
      });
    }
    return this.#fetcher;
  }

  /**
   * 抓一条文献的全文（需求 12.3、12.4、12.6）。
   *
   * 逐次尝试的记录由 `FulltextFetcher` 落进 `ref_fetch_attempts`，因此即便这次
   * 调用的返回值被丢掉，「试过什么」也不会丢。
   */
  async fetchFulltext(
    refId: string,
    options: { sources?: readonly FulltextSource[]; force?: boolean } = {},
  ): Promise<FulltextResult> {
    const ref = this.repo.get(refId);
    if (ref === null) {
      return {
        ok: false,
        source: null,
        fulltextArtifactId: null,
        fulltextVersionId: null,
        assets: [],
        attempts: [],
        summary: `文献不存在：${refId}`,
        article: null,
      };
    }

    const fetcher = this.fulltext;
    if (fetcher === null) {
      return {
        ok: false,
        source: null,
        fulltextArtifactId: null,
        fulltextVersionId: null,
        assets: [],
        attempts: [],
        summary: '这个文献库实例没有接制品库，无法存放抓到的全文。',
        article: null,
      };
    }

    return fetcher.fetch(ref, options);
  }

  /** 绑定用户手工下载的全文。付费墙后的论文只能这样进来。 */
  attachFulltext(input: { refId: string; filename: string; content: Buffer; note?: string }): {
    ok: boolean;
    artifactId: string | null;
    versionId: string | null;
    reason: string | null;
  } {
    const ref = this.repo.get(input.refId);
    if (ref === null) {
      return { ok: false, artifactId: null, versionId: null, reason: `文献不存在：${input.refId}` };
    }
    const fetcher = this.fulltext;
    if (fetcher === null) {
      return {
        ok: false,
        artifactId: null,
        versionId: null,
        reason: '这个文献库实例没有接制品库。',
      };
    }
    return fetcher.attach({
      ref,
      filename: input.filename,
      content: input.content,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
  }

  /**
   * 解析出哪些上游可用。
   *
   * 无批准门时全部可用。有批准门时问一次（并发共用同一次），然后按主机过滤。
   */
  async #allowedSources(
    wanted: readonly RefSourceId[],
  ): Promise<{ allowed: readonly RefSourceId[]; denied: readonly RefSourceId[] }> {
    if (this.#authorizeHosts === null) return { allowed: wanted, denied: [] };

    if (this.#allowedHosts === null) {
      if (this.#authorizing === null) {
        const hosts = [...new Set(Object.values(REF_SOURCE_HOSTS).flat())];
        const gate = this.#authorizeHosts;
        this.#authorizing = gate(hosts)
          .then((granted) => new Set(granted))
          .catch((err: unknown) => {
            // 批准流程本身出错时按「未获批」处理并留痕。放行会让一次失败的
            // 审批等于自动同意
            this.#log(`域名批准失败：${err instanceof Error ? err.message : String(err)}`);
            return new Set<string>();
          });
      }
      this.#allowedHosts = await this.#authorizing;
      this.#authorizing = null;
    }

    const allowedHosts = this.#allowedHosts;
    const allowed: RefSourceId[] = [];
    const denied: RefSourceId[] = [];
    for (const source of wanted) {
      const hosts = REF_SOURCE_HOSTS[source] ?? [];
      if (hosts.length > 0 && hosts.every((h) => allowedHosts.has(h))) allowed.push(source);
      else denied.push(source);
    }
    return { allowed, denied };
  }

  /** 未获批上游的占位结果。让「为什么这家没有结果」在输出里可见。 */
  #deniedAttempts(denied: readonly RefSourceId[]): readonly SourceResult[] {
    return denied.map((source) => ({
      source,
      ok: false,
      item: null,
      reason: `${SOURCE_LABEL[source] ?? source} 的域名（${(REF_SOURCE_HOSTS[source] ?? []).join('、')}）未获批准访问`,
      url: '',
      status: null,
    }));
  }

  /** 清掉批准缓存。用户在设置里改了域名授权之后调用。 */
  resetAuthorization(): void {
    this.#allowedHosts = null;
  }

  /**
   * 在库里找与给定 CSL 重复的记录。
   *
   * 返回 `same` 的第一条与全部 `likely`。`same` 只可能有一条：如果库里有两条都
   * 与新条目 `same`，那说明库里那两条本身就是重复的，这时选哪一条都对——而
   * 报告 suspects 会让用户看到它们。
   */
  findDuplicate(csl: CslItem): {
    same: { ref: RefRecord; match: MatchResult } | null;
    suspects: readonly DuplicateSuspect[];
  } {
    const fp = fingerprint(csl);
    const candidates = this.repo.candidates(fp);

    let same: { ref: RefRecord; match: MatchResult } | null = null;
    const suspects: DuplicateSuspect[] = [];

    for (const candidate of candidates) {
      const match = matchRefs(fp, fingerprint(candidate.csl));
      if (match.verdict === 'same') {
        // 已有命中时保留「更强」的那条依据：标识相等比标题相似更可信
        if (same === null || (same.match.by === 'title' && match.by !== 'title')) {
          same = { ref: candidate, match };
        }
        continue;
      }
      if (match.verdict === 'likely') {
        suspects.push({
          refId: candidate.id,
          cite: citeLine(candidate.csl),
          reason: match.reason,
          similarity: match.similarity.char,
        });
      }
    }

    // 相似度高的排前面：用户只会看前几条
    suspects.sort((a, b) => b.similarity - a.similarity);
    return { same, suspects };
  }

  /**
   * 把一条已解析好的 CSL 加进库，带去重。
   *
   * `source` 是元数据来源标签，用于事后判断「这条要不要重新解析」。
   */
  addResolved(input: {
    csl: CslItem;
    source?: string | null;
    attempts?: readonly SourceResult[];
  }): AddOutcome {
    const attempts = input.attempts ?? [];
    const { same, suspects } = this.findDuplicate(input.csl);

    if (same !== null) {
      /*
       * 命中重复：合并字段。
       *
       * 以完备度高的一方为主而不是固定以库里那条为主：用户重新解析常常正是因为
       * 库里那条缺字段。合并之后完备度没有提升就不写库——一次无变化的 UPDATE 会
       * 刷新 updated_at，让「这条最近改过」这个信号失真。
       */
      const existingScore = completeness(same.ref.csl);
      const incomingScore = completeness(input.csl);
      const merged =
        incomingScore > existingScore
          ? mergeCsl(input.csl, same.ref.csl)
          : mergeCsl(same.ref.csl, input.csl);

      const mergedScore = completeness(merged);
      if (mergedScore > existingScore) {
        const updated = this.repo.updateCsl(
          same.ref.id,
          // id 保持库里那条的 CSL id：它可能已被 BibTeX 引用键或正文引用
          { ...merged, id: same.ref.csl.id },
          mergeSourceLabel(same.ref.source, input.source ?? null),
        );
        return {
          ok: true,
          ref: updated,
          created: false,
          enriched: true,
          duplicateOf: same.ref,
          match: same.match,
          suspects,
          attempts,
          reason:
            `已存在同一篇文献（${same.match.reason}），本次解析补全了元数据` +
            `（完备度 ${String(existingScore)} → ${String(mergedScore)}）。`,
        };
      }

      return {
        ok: true,
        ref: same.ref,
        created: false,
        enriched: false,
        duplicateOf: same.ref,
        match: same.match,
        suspects,
        attempts,
        reason: `已存在同一篇文献（${same.match.reason}），本次解析没有新字段。`,
      };
    }

    try {
      const created = this.repo.add({
        csl: input.csl,
        source: input.source ?? null,
        ...(oaStatusOf(input.csl) === null ? {} : { oaStatus: oaStatusOf(input.csl) }),
      });
      return {
        ok: true,
        ref: created,
        created: true,
        enriched: false,
        duplicateOf: null,
        match: null,
        suspects,
        attempts,
        reason: null,
      };
    } catch (err) {
      return {
        ok: false,
        ref: null,
        created: false,
        enriched: false,
        duplicateOf: null,
        match: null,
        suspects,
        attempts,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 按标识（DOI/PMID/PMCID/arXiv）解析并入库。
   *
   * 入库前**先查库**：库里已有时省掉六次网络请求。这不只是省流量——批量导入
   * 一份两百条的参考文献列表时，其中大半通常已经在库里，跳过它们把一次几分钟
   * 的操作变成几秒。
   *
   * `refresh` 为真时强制重新解析，用于修补当初解析质量差的记录。
   */
  async addByIdentifier(
    raw: string,
    options: { source?: string | null; refresh?: boolean; http?: ResolveOptions } = {},
  ): Promise<AddOutcome> {
    const sniffed = sniffIdentifier(raw);

    if (sniffed.kind === 'title') {
      return {
        ok: false,
        ref: null,
        created: false,
        enriched: false,
        duplicateOf: null,
        match: null,
        suspects: [],
        attempts: [],
        reason:
          `「${raw}」不是标识而是标题。请先用检索确认是哪一篇（会返回候选与它们的 DOI），` +
          '再按 DOI 添加。直接按标题入库会把一个没核对过的猜测写进文献库。',
      };
    }

    if (options.refresh !== true) {
      const existing = this.#lookupByIdentifier(sniffed.kind, sniffed.value);
      if (existing !== null) {
        return {
          ok: true,
          ref: existing,
          created: false,
          enriched: false,
          duplicateOf: existing,
          match: {
            verdict: 'same',
            by: sniffed.kind === 'arxiv' ? 'arxiv' : sniffed.kind,
            similarity: { char: 1, containment: 1, jaccard: 1 },
            reason: `${sniffed.kind.toUpperCase()} 已在库中：${sniffed.value}`,
          },
          suspects: [],
          attempts: [],
          reason: `${sniffed.kind.toUpperCase()} ${sniffed.value} 已在文献库中，未重新解析。要强制刷新请指定 refresh。`,
        };
      }
    }

    const http = { ...this.#http, ...(options.http ?? {}) };
    const wanted = http.sources ?? DEFAULT_DOI_SOURCES;
    const { allowed, denied } = await this.#allowedSources(wanted);

    if (allowed.length === 0) {
      return {
        ok: false,
        ref: null,
        created: false,
        enriched: false,
        duplicateOf: null,
        match: null,
        suspects: [],
        attempts: this.#deniedAttempts(denied),
        reason:
          '全部元数据上游的域名都未获批准访问，无法解析。\n' +
          '在设置的授权列表里放行这些域名，或启用 OpenAlex / PubMed 连接器' +
          '（启用连接器会自动放行它的域名）。',
      };
    }

    const report = await resolveIdentifier(raw, { ...http, sources: allowed });
    const attempts = [...report.attempts, ...this.#deniedAttempts(denied)];

    if (!report.ok || report.item === null) {
      return {
        ok: false,
        ref: null,
        created: false,
        enriched: false,
        duplicateOf: null,
        match: null,
        suspects: [],
        attempts,
        reason: report.reason,
      };
    }

    this.#log(`解析 ${sniffed.value} 成功，来源 ${report.merged.join('+')}`);
    return this.addResolved({
      csl: report.item,
      source: options.source ?? report.merged.join('+'),
      attempts,
    });
  }

  #lookupByIdentifier(kind: string, value: string): RefRecord | null {
    switch (kind) {
      case 'doi':
        return this.repo.getByDoi(value);
      case 'pmid':
        return this.repo.getByPmid(value) ?? this.repo.getByAlias('pmid', value);
      case 'pmcid':
        return this.repo.getByAlias('pmcid', value);
      case 'arxiv':
        return this.repo.getByAlias('arxiv', value);
      default:
        return null;
    }
  }

  /**
   * 批量按标识添加。
   *
   * 串行而不是并行：并行会让六家上游同时收到 N 倍请求，限速器会把它们排成队列，
   * 结果与串行一样慢但更容易触发限流。真正的加速来自「先查库跳过已有」。
   */
  async addMany(
    identifiers: readonly string[],
    options: { source?: string | null; refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<{
    outcomes: readonly (AddOutcome & { input: string })[];
    created: number;
    duplicates: number;
    failed: number;
  }> {
    const outcomes: (AddOutcome & { input: string })[] = [];
    let created = 0;
    let duplicates = 0;
    let failed = 0;

    for (const raw of identifiers) {
      if (options.signal?.aborted === true) {
        outcomes.push({
          input: raw,
          ok: false,
          ref: null,
          created: false,
          enriched: false,
          duplicateOf: null,
          match: null,
          suspects: [],
          attempts: [],
          reason: '已被取消',
        });
        failed += 1;
        continue;
      }

      const outcome = await this.addByIdentifier(raw, {
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
        ...(options.signal === undefined ? {} : { http: { signal: options.signal } }),
      });
      outcomes.push({ ...outcome, input: raw });
      if (!outcome.ok) failed += 1;
      else if (outcome.created) created += 1;
      else duplicates += 1;
    }

    return { outcomes, created, duplicates, failed };
  }

  /**
   * 按书目信息检索上游，并标注每个候选在库里的状态。
   *
   * 标注是必要的：检索结果里已经在库的那些，用户会以为自己没加过而重复添加，
   * 然后疑惑为什么条目数没变。
   */
  async search(
    query: { text: string; author?: string; year?: number; rows?: number },
    options: { http?: ResolveOptions } = {},
  ): Promise<{
    ok: boolean;
    candidates: readonly (SourceCandidate & { inLibraryRefId: string | null; cite: string })[];
    attempts: readonly SourceSearchResult[];
    reason: string | null;
  }> {
    const http = { ...this.#http, ...(options.http ?? {}) };
    const wanted = http.sources ?? DEFAULT_SEARCH_SOURCES;
    const { allowed, denied } = await this.#allowedSources(wanted);

    if (allowed.length === 0) {
      return {
        ok: false,
        candidates: [],
        attempts: denied.map((source) => ({
          source,
          ok: false,
          candidates: [],
          reason: `${SOURCE_LABEL[source] ?? source} 的域名未获批准访问`,
          url: '',
          total: null,
        })),
        reason:
          '全部检索上游的域名都未获批准访问。在设置的授权列表里放行，' +
          '或启用 OpenAlex / PubMed 连接器。',
      };
    }

    const report = await searchRefs(query, { ...http, sources: allowed });

    const annotated = report.candidates.map((c) => {
      const found = this.findDuplicate(c.item);
      return {
        ...c,
        inLibraryRefId: found.same?.ref.id ?? null,
        cite: citeLine(c.item),
      };
    });

    return {
      ok: report.ok,
      candidates: annotated,
      attempts: [
        ...report.attempts,
        ...denied.map((source) => ({
          source,
          ok: false,
          candidates: [] as readonly SourceCandidate[],
          reason: `${SOURCE_LABEL[source] ?? source} 的域名未获批准访问`,
          url: '',
          total: null,
        })),
      ],
      reason: report.reason,
    };
  }

  /**
   * 显式合并两条记录。
   *
   * 用于 `likely` 判定后用户拍板的情形（preprint 与正式版）。合并方向由调用方给：
   * 保留哪一个是用户的决定，系统不猜——他可能刻意要留 preprint 那条，因为正文里
   * 引的就是它。
   */
  merge(
    keepId: string,
    dropId: string,
  ): { ok: boolean; ref: RefRecord | null; reason: string | null } {
    const keep = this.repo.get(keepId);
    const drop = this.repo.get(dropId);
    if (keep === null) return { ok: false, ref: null, reason: `文献不存在：${keepId}` };
    if (drop === null) return { ok: false, ref: null, reason: `文献不存在：${dropId}` };
    if (keepId === dropId) return { ok: false, ref: null, reason: '不能把一条记录与自己合并' };

    const merged = mergeCsl({ ...keep.csl }, drop.csl);
    const result = this.repo.merge({
      keepId,
      dropId,
      csl: { ...merged, id: keep.csl.id },
    });
    if (result === null) return { ok: false, ref: null, reason: '合并失败' };
    return { ok: true, ref: result, reason: null };
  }

  /**
   * 全库重复扫描。
   *
   * 两两比对（O(n²)）而不是用仓储的候选收窄：收窄是为了「新增一条时快速判定」，
   * 而全库扫描的目的正是找出收窄会漏掉的那些。指纹先算一遍缓存起来，
   * `titleSimilarity` 有长度差的提前退出，因此在千条量级上是秒级。
   *
   * 上限 `maxScan` 之外的部分不扫并如实报告 `truncated`。悄悄只扫前一千条会让
   * 用户以为「库里没有重复」。
   */
  scanDuplicates(options: { limit?: number; maxScan?: number } = {}): {
    pairs: readonly {
      keepId: string;
      dropId: string;
      keepCite: string;
      dropCite: string;
      verdict: 'same' | 'likely';
      reason: string;
      similarity: number;
    }[];
    scanned: number;
    total: number;
    truncated: boolean;
  } {
    const maxScan = Math.max(1, Math.min(options.maxScan ?? 2000, 5000));
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const total = this.repo.count();
    const refs = this.repo.list({ limit: maxScan });
    const fps = refs.map((r) => fingerprint(r.csl));

    const pairs: {
      keepId: string;
      dropId: string;
      keepCite: string;
      dropCite: string;
      verdict: 'same' | 'likely';
      reason: string;
      similarity: number;
    }[] = [];

    for (let i = 0; i < refs.length && pairs.length < limit; i += 1) {
      for (let j = i + 1; j < refs.length && pairs.length < limit; j += 1) {
        const match = matchRefs(fps[i] as never, fps[j] as never);
        if (match.verdict === 'distinct') continue;

        // 完备度高的做 keep：默认建议保留信息更全的那条。用户仍可反向合并
        const a = refs[i] as RefRecord;
        const b = refs[j] as RefRecord;
        const [keep, drop] = completeness(a.csl) >= completeness(b.csl) ? [a, b] : [b, a];
        pairs.push({
          keepId: keep.id,
          dropId: drop.id,
          keepCite: citeLine(keep.csl),
          dropCite: citeLine(drop.csl),
          verdict: match.verdict,
          reason: match.reason,
          similarity: match.similarity.char,
        });
      }
    }

    // same 排在 likely 前面：前者可以批量处理，后者需要逐条看
    pairs.sort((x, y) => {
      if (x.verdict !== y.verdict) return x.verdict === 'same' ? -1 : 1;
      return y.similarity - x.similarity;
    });

    return { pairs, scanned: refs.length, total, truncated: total > refs.length };
  }

  /**
   * 导出引用（需求 12.5）。
   *
   * `refIds` 给出时只导这些（按给的顺序无关，导出内部会重排）；省略时按筛选条件
   * 取全库。落成制品，因此导出结果可以被手稿编译引用、可以被版本追溯，也会跟着
   * 项目一起归档——而「用户点了导出然后文件去哪了」是一次性下载最容易出的问题。
   */
  exportRefs(options: {
    format: ExportFormat;
    refIds?: readonly string[];
    filter?: { query?: string; year?: number; type?: string; hasFulltext?: boolean };
    stem?: string;
    asciiOnly?: boolean;
    includeAbstract?: boolean;
    sort?: ExportOptions['sort'];
  }): {
    ok: boolean;
    result: ExportResult | null;
    artifactId: string | null;
    versionId: string | null;
    /** 请求了但库里没有的 id。静默忽略会让导出结果少几条而用户不知道。 */
    missingIds: readonly string[];
    reason: string | null;
  } {
    const missingIds: string[] = [];
    let refs: readonly RefRecord[];

    if (options.refIds !== undefined) {
      const found: RefRecord[] = [];
      for (const id of options.refIds) {
        const ref = this.repo.get(id);
        if (ref === null) missingIds.push(id);
        else found.push(ref);
      }
      refs = found;
    } else {
      refs = this.repo.list({
        ...(options.filter?.query === undefined ? {} : { query: options.filter.query }),
        ...(options.filter?.year === undefined ? {} : { year: options.filter.year }),
        ...(options.filter?.type === undefined ? {} : { type: options.filter.type }),
        ...(options.filter?.hasFulltext === undefined
          ? {}
          : { hasFulltext: options.filter.hasFulltext }),
        limit: 1000,
      });
    }

    if (refs.length === 0) {
      return {
        ok: false,
        result: null,
        artifactId: null,
        versionId: null,
        missingIds,
        reason:
          missingIds.length > 0
            ? `请求的 ${String(missingIds.length)} 个 id 在库里都不存在：${missingIds.join('、')}`
            : '没有可导出的文献。先用 resolve 添加文献，或放宽筛选条件。',
      };
    }

    const result = exportRefs(refs, {
      format: options.format,
      ...(options.stem === undefined ? {} : { stem: options.stem }),
      ...(options.asciiOnly === undefined ? {} : { asciiOnly: options.asciiOnly }),
      ...(options.includeAbstract === undefined
        ? {}
        : { includeAbstract: options.includeAbstract }),
      ...(options.sort === undefined ? {} : { sort: options.sort }),
    });

    if (this.#artifacts === null) {
      // 没有制品库时仍然把内容返回：调用方可以自己处理（测试、纯计算路径）
      return {
        ok: true,
        result,
        artifactId: null,
        versionId: null,
        missingIds,
        reason: '没有接制品库，导出内容只在返回值里，未落盘。',
      };
    }

    const saved = this.#artifacts.save({
      filename: result.filename,
      content: Buffer.from(result.content, 'utf8'),
      mime: result.mime,
    });

    /*
     * 顺手把 BibTeX 缓存回每条记录。
     *
     * 导出时已经为每条算过一遍，扔掉再让详情页各算一次是白费；更重要的是缓存下来
     * 之后，详情页显示的引用键与刚导出的那份文件一致——不一致会让用户在手稿里
     * 复制到一个 .bib 里不存在的键。
     */
    if (options.format === 'bibtex') {
      const keyed = assignKeys(
        [...refs].sort((a, b) => bibtexKeyFor(a).localeCompare(bibtexKeyFor(b))),
      );
      for (const { ref, key } of keyed) {
        try {
          this.repo.setBibtex(ref.id, toBibtex(ref.csl, { key }));
        } catch {
          // 缓存失败不该让一次成功的导出变成失败
        }
      }
    }

    return {
      ok: true,
      result,
      artifactId: saved.artifact.id,
      versionId: saved.version.id,
      missingIds,
      reason: null,
    };
  }

  /** 生成并缓存 BibTeX。已有缓存且未强制刷新时直接返回。 */
  bibtexFor(refId: string, options: { refresh?: boolean } = {}): string | null {
    const ref = this.repo.get(refId);
    if (ref === null) return null;
    if (ref.bibtex !== null && options.refresh !== true) return ref.bibtex;
    const bibtex = toBibtex(ref.csl, { key: bibtexKeyFor(ref) });
    this.repo.setBibtex(refId, bibtex);
    return bibtex;
  }
}

/** 从 CSL 的 extra 里取开放获取状态。 */
function oaStatusOf(csl: CslItem): string | null {
  const status = csl.extra?.oaStatus;
  if (typeof status === 'string' && status !== '') return status;
  if (csl.extra?.isOpenAccess === true) return 'open';
  return null;
}

/** 上游标识的中文名，用于工具输出与界面。 */
export const SOURCE_LABEL: Readonly<Record<RefSourceId, string>> = {
  crossref: 'Crossref',
  openalex: 'OpenAlex',
  semanticscholar: 'Semantic Scholar',
  pubmed: 'PubMed',
  europepmc: 'Europe PMC',
  datacite: 'DataCite',
  arxiv: 'arXiv',
  unpaywall: 'Unpaywall',
  openaire: 'OpenAIRE',
};
