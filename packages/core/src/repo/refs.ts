/**
 * 文献库仓储（任务 13.1，需求 12.1、12.2、12.3、12.6）。
 *
 * `refs.csl_json` 是唯一的事实来源，其余列（`title_norm`、`year`、`first_author`
 * 等）全部由它派生。派生列在写入时算一次并落库，读取时**不重算**——去重要在 SQL
 * 里筛候选集，而那要求这些值是可索引的列而不是 JSON 里的字段。
 *
 * 派生列与 CSL 不一致是这套设计唯一的失败模式，因此所有写入路径都必须经由
 * `#derive`，没有单独更新 `csl_json` 的方法。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';
import type { CslItem } from '../refs/csl.js';
import {
  citeLine,
  containerLabel,
  cslYear,
  firstAuthorKey,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  normalizeTitle,
} from '../refs/csl.js';
import type { RefFingerprint } from '../refs/dedupe.js';

/** 别名的命名空间。`doi` 出现在这里是为了记住被合并掉那条的 DOI。 */
export type RefAliasScheme =
  'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'openalex' | 's2' | 'europepmc' | 'mag' | 'isbn' | 'url';

export interface RefAlias {
  scheme: RefAliasScheme;
  value: string;
}

export interface RefRecord {
  id: string;
  doi: string | null;
  /** CSL type，冗余出来只为按类型筛选（导出时按类型分组）。 */
  type: string | null;
  csl: CslItem;
  bibtex: string | null;
  /** 全文制品。抓取成功后绑定（需求 12.3）。 */
  fulltextArtifactId: string | null;
  /** 开放获取状态。取值随上游，常见 gold/green/hybrid/bronze/closed。 */
  oaStatus: string | null;
  titleNorm: string | null;
  /** 元数据来源，多源合并时用 `+` 连接（如 `crossref+openalex`）。 */
  source: string | null;
  year: number | null;
  container: string | null;
  firstAuthor: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  addedAt: number;
  updatedAt: number | null;
  aliases: readonly RefAlias[];
}

interface RefRow {
  id: string;
  doi: string | null;
  type: string | null;
  csl_json: string;
  bibtex: string | null;
  fulltext_artifact_id: string | null;
  oa_status: string | null;
  added_at: number;
  title_norm: string | null;
  source: string | null;
  year: number | null;
  container: string | null;
  first_author: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxiv_id: string | null;
  updated_at: number | null;
}

/**
 * 一次抓取尝试的结果分类。
 *
 * `not-available` 与 `blocked` 刻意分开：前者是「这篇文献确实没有开放获取版本」，
 * 后者是「有，但我们被拦住了」（付费墙、需要机构 IP、被 Cloudflare 拦）。两者对
 * 用户的下一步完全不同——前者要去找别的来源或联系作者，后者可以换网络环境或用
 * 机构账号手动下载再上传。混成一个 `failed` 会让这个判断没法做。
 */
export type FetchOutcome = 'success' | 'not-available' | 'blocked' | 'error' | 'skipped';

export interface RefFetchAttempt {
  id: number;
  refId: string;
  source: string;
  url: string | null;
  outcome: FetchOutcome;
  detail: string | null;
  status: number | null;
  bytes: number | null;
  at: number;
}

/** 随文资源的类型。 */
export type RefAssetKind = 'fulltext' | 'fulltext-source' | 'figure' | 'table' | 'supplement';

export interface RefAsset {
  id: string;
  refId: string;
  kind: RefAssetKind;
  artifactId: string;
  versionId: string;
  label: string | null;
  caption: string | null;
  sourceUrl: string | null;
  /** 归档包内的原文件名。正文 Markdown 里的图片路径靠它对上制品。 */
  originPath: string | null;
  createdAt: number;
}

interface FetchAttemptRow {
  id: number;
  ref_id: string;
  source: string;
  url: string | null;
  outcome: string;
  detail: string | null;
  status: number | null;
  bytes: number | null;
  at: number;
}

interface AssetRow {
  id: string;
  ref_id: string;
  kind: string;
  artifact_id: string;
  version_id: string;
  label: string | null;
  caption: string | null;
  source_url: string | null;
  origin_path: string | null;
  created_at: number;
}

function toFetchAttempt(row: FetchAttemptRow): RefFetchAttempt {
  return {
    id: row.id,
    refId: row.ref_id,
    source: row.source,
    url: row.url,
    outcome: row.outcome as FetchOutcome,
    detail: row.detail,
    status: row.status,
    bytes: row.bytes,
    at: row.at,
  };
}

function toAsset(row: AssetRow): RefAsset {
  return {
    id: row.id,
    refId: row.ref_id,
    kind: row.kind as RefAssetKind,
    artifactId: row.artifact_id,
    versionId: row.version_id,
    label: row.label,
    caption: row.caption,
    sourceUrl: row.source_url,
    originPath: row.origin_path,
    createdAt: row.created_at,
  };
}

/** 派生列。写入路径唯一的计算入口。 */
interface Derived {
  doi: string | null;
  type: string;
  titleNorm: string | null;
  year: number | null;
  container: string | null;
  firstAuthor: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
}

function derive(csl: CslItem): Derived {
  const titleNorm = normalizeTitle(csl.title);
  const container = containerLabel(csl);
  const firstAuthor = firstAuthorKey(csl);
  return {
    doi: normalizeDoi(csl.DOI),
    type: csl.type,
    titleNorm: titleNorm === '' ? null : titleNorm,
    year: cslYear(csl),
    container: container === null ? null : container,
    firstAuthor: firstAuthor === '' ? null : firstAuthor,
    pmid: normalizePmid(csl.PMID),
    pmcid: normalizePmcid(csl.PMCID),
    arxivId: normalizeArxivId(
      typeof csl.extra?.arxivId === 'string' ? csl.extra.arxivId : undefined,
    ),
  };
}

export class RefsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRef(row: RefRow): RefRecord {
    let csl: CslItem;
    try {
      csl = JSON.parse(row.csl_json) as CslItem;
    } catch {
      /*
       * CSL 损坏时不让整条记录读不出来，退化成一个只有标识的最小条目。
       *
       * 与「跳过这一行」的区别：跳过之后，一条被 claim 证据引用的文献会凭空
       * 消失，而证据那一侧看起来完好——用户点开看到空白，无从判断是数据丢了
       * 还是本来就没有。留下最小条目至少让 DOI 还在。
       */
      csl = {
        id: row.doi ?? row.id,
        type: 'document',
        ...(row.doi === null ? {} : { DOI: row.doi }),
        note: 'CSL 元数据已损坏，需要重新解析',
      };
    }

    return {
      id: row.id,
      doi: row.doi,
      type: row.type,
      csl,
      bibtex: row.bibtex,
      fulltextArtifactId: row.fulltext_artifact_id,
      oaStatus: row.oa_status,
      titleNorm: row.title_norm,
      source: row.source,
      year: row.year,
      container: row.container,
      firstAuthor: row.first_author,
      pmid: row.pmid,
      pmcid: row.pmcid,
      arxivId: row.arxiv_id,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
      aliases: this.aliases(row.id),
    };
  }

  /* ---------------- 写入 ---------------- */

  /**
   * 新增一条文献。
   *
   * **不做去重**：去重需要先算相似度再决定，那是 `RefLibrary` 的职责。仓储在
   * DOI 撞车时直接抛错并说清撞的是哪一条——静默返回已有记录会让调用方以为
   * 自己刚写入的元数据生效了。
   */
  add(input: {
    csl: CslItem;
    source?: string | null;
    bibtex?: string | null;
    oaStatus?: string | null;
  }): RefRecord {
    const d = derive(input.csl);

    if (d.titleNorm === null && d.doi === null && d.pmid === null) {
      throw new Error(
        '文献条目至少要有标题或一个标识（DOI/PMID）。' +
          '两者都没有的条目无法去重也无法导出引用，只会成为库里的噪声。',
      );
    }

    if (d.doi !== null) {
      const existing = this.getByDoi(d.doi);
      if (existing !== null) {
        throw new Error(`DOI ${d.doi} 已存在于文献库：${citeLine(existing.csl)}`);
      }
    }

    const id = `rf_${randomUUID()}`;
    const now = Date.now();

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `INSERT INTO refs
             (id, doi, type, csl_json, bibtex, fulltext_artifact_id, oa_status, added_at,
              title_norm, source, year, container, first_author, pmid, pmcid, arxiv_id, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          d.doi,
          d.type,
          JSON.stringify(input.csl),
          input.bibtex ?? null,
          input.oaStatus ?? null,
          now,
          d.titleNorm,
          input.source ?? null,
          d.year,
          d.container,
          d.firstAuthor,
          d.pmid,
          d.pmcid,
          d.arxivId,
          now,
        );

      // 标识同时进别名表：合并之后仍能按旧标识查到
      for (const [scheme, value] of [
        ['doi', d.doi],
        ['pmid', d.pmid],
        ['pmcid', d.pmcid],
        ['arxiv', d.arxivId],
      ] as const) {
        if (value !== null) this.#insertAlias(id, scheme, value);
      }
      const openAlexId = input.csl.extra?.openAlexId;
      if (typeof openAlexId === 'string' && openAlexId !== '') {
        this.#insertAlias(id, 'openalex', openAlexId);
      }
      const s2 = input.csl.extra?.s2CorpusId;
      if (typeof s2 === 'string' && s2 !== '') this.#insertAlias(id, 's2', s2);
    });
    run();

    const created = this.get(id);
    if (created === null) throw new Error('文献条目创建后读取失败');
    return created;
  }

  /**
   * 用新的 CSL 覆盖一条记录。
   *
   * 派生列一起更新。DOI 从无到有时会补写别名——重新解析一条只有标题的旧记录
   * 之后，它应当能按新拿到的 DOI 被查到。
   */
  updateCsl(id: string, csl: CslItem, source?: string | null): RefRecord | null {
    if (this.get(id) === null) return null;
    const d = derive(csl);

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE refs SET doi = ?, type = ?, csl_json = ?, title_norm = ?, year = ?,
             container = ?, first_author = ?, pmid = ?, pmcid = ?, arxiv_id = ?,
             source = COALESCE(?, source), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          d.doi,
          d.type,
          JSON.stringify(csl),
          d.titleNorm,
          d.year,
          d.container,
          d.firstAuthor,
          d.pmid,
          d.pmcid,
          d.arxivId,
          source ?? null,
          Date.now(),
          id,
        );

      for (const [scheme, value] of [
        ['doi', d.doi],
        ['pmid', d.pmid],
        ['pmcid', d.pmcid],
        ['arxiv', d.arxivId],
      ] as const) {
        if (value !== null) this.#insertAlias(id, scheme, value);
      }
    });
    run();

    return this.get(id);
  }

  /** 绑定 BibTeX 缓存。导出时按需生成一次即可复用。 */
  setBibtex(id: string, bibtex: string): boolean {
    return (
      this.#db
        .prepare('UPDATE refs SET bibtex = ?, updated_at = ? WHERE id = ?')
        .run(bibtex, Date.now(), id).changes > 0
    );
  }

  /** 绑定全文制品（需求 12.3）。 */
  setFulltext(id: string, artifactId: string | null, oaStatus?: string | null): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE refs SET fulltext_artifact_id = ?, oa_status = COALESCE(?, oa_status),
             updated_at = ? WHERE id = ?`,
        )
        .run(artifactId, oaStatus ?? null, Date.now(), id).changes > 0
    );
  }

  setOaStatus(id: string, oaStatus: string | null): boolean {
    return (
      this.#db
        .prepare('UPDATE refs SET oa_status = ?, updated_at = ? WHERE id = ?')
        .run(oaStatus, Date.now(), id).changes > 0
    );
  }

  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM refs WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 合并两条重复记录。
   *
   * 被合并掉那条的**全部标识都进保留条的别名表**。少了这一步会出现一个绕圈的
   * bug：用旧 DOI 再解析一次 → 库里查不到 → 新建一条 → 又是重复。
   *
   * 调用方负责先算好合并后的 CSL（`mergeCsl`）：仓储不做元数据的取舍决策，
   * 那需要知道两条各自的来源与完备度。
   */
  merge(input: {
    keepId: string;
    dropId: string;
    csl: CslItem;
    source?: string | null;
  }): RefRecord | null {
    if (input.keepId === input.dropId) throw new Error('不能把一条记录与自己合并');
    const keep = this.get(input.keepId);
    const drop = this.get(input.dropId);
    if (keep === null || drop === null) return null;

    const run = this.#db.transaction((): void => {
      // 先搬别名再删：删除会级联清掉 ref_aliases，顺序反了别名就没了。
      // 主键是 (scheme, value)，同一标识已属于保留条时 OR IGNORE 跳过
      for (const alias of drop.aliases) {
        this.#db
          .prepare('UPDATE OR IGNORE ref_aliases SET ref_id = ? WHERE scheme = ? AND value = ?')
          .run(input.keepId, alias.scheme, alias.value);
      }

      // 全文只在保留条没有时继承。两条都有全文时保留条的那份更可信
      // （它是主记录），而丢掉另一份只是丢一个副本，制品本身还在
      if (keep.fulltextArtifactId === null && drop.fulltextArtifactId !== null) {
        this.#db
          .prepare(
            'UPDATE refs SET fulltext_artifact_id = ?, oa_status = COALESCE(oa_status, ?) WHERE id = ?',
          )
          .run(drop.fulltextArtifactId, drop.oaStatus, input.keepId);
      }

      this.#db.prepare('DELETE FROM refs WHERE id = ?').run(input.dropId);
    });
    run();

    return this.updateCsl(
      input.keepId,
      input.csl,
      input.source ?? mergeSourceLabel(keep.source, drop.source),
    );
  }

  /* ---------------- 别名 ---------------- */

  #insertAlias(refId: string, scheme: RefAliasScheme, value: string): void {
    // 主键冲突（该标识已指向另一条记录）时忽略：那说明存在一次未处理的重复，
    // 但插入别名不是发现它的地方，抛错只会让一次正常的写入失败
    this.#db
      .prepare('INSERT OR IGNORE INTO ref_aliases (ref_id, scheme, value) VALUES (?, ?, ?)')
      .run(refId, scheme, value);
  }

  addAlias(refId: string, scheme: RefAliasScheme, value: string): void {
    this.#insertAlias(refId, scheme, value);
  }

  aliases(refId: string): readonly RefAlias[] {
    return (
      this.#db
        .prepare('SELECT scheme, value FROM ref_aliases WHERE ref_id = ? ORDER BY scheme, value')
        .all(refId) as { scheme: string; value: string }[]
    ).map((r) => ({ scheme: r.scheme as RefAliasScheme, value: r.value }));
  }

  /* ---------------- 查询 ---------------- */

  get(id: string): RefRecord | null {
    const row = this.#db.prepare('SELECT * FROM refs WHERE id = ?').get(id) as RefRow | undefined;
    return row === undefined ? null : this.#toRef(row);
  }

  getByDoi(doi: string): RefRecord | null {
    const normalized = normalizeDoi(doi);
    if (normalized === null) return null;
    const row = this.#db.prepare('SELECT * FROM refs WHERE doi = ?').get(normalized) as
      RefRow | undefined;
    if (row !== undefined) return this.#toRef(row);
    // 主列没命中时查别名：被合并掉的 DOI 只在别名表里
    return this.getByAlias('doi', normalized);
  }

  getByAlias(scheme: RefAliasScheme, value: string): RefRecord | null {
    const row = this.#db
      .prepare(
        `SELECT refs.* FROM refs JOIN ref_aliases ON ref_aliases.ref_id = refs.id
         WHERE ref_aliases.scheme = ? AND ref_aliases.value = ?`,
      )
      .get(scheme, value) as RefRow | undefined;
    return row === undefined ? null : this.#toRef(row);
  }

  getByPmid(pmid: string): RefRecord | null {
    const normalized = normalizePmid(pmid);
    if (normalized === null) return null;
    const row = this.#db.prepare('SELECT * FROM refs WHERE pmid = ?').get(normalized) as
      RefRow | undefined;
    return row === undefined ? null : this.#toRef(row);
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM refs').get() as { n: number }).n;
  }

  list(
    options: {
      /** 在标题、期刊、作者键上做子串匹配。 */
      query?: string;
      year?: number;
      type?: string;
      hasFulltext?: boolean;
      hasDoi?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): readonly RefRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.query !== undefined && options.query.trim() !== '') {
      const needle = `%${normalizeTitle(options.query)}%`;
      clauses.push('(title_norm LIKE ? OR first_author LIKE ? OR LOWER(container) LIKE ?)');
      params.push(needle, needle, `%${options.query.trim().toLowerCase()}%`);
    }
    if (options.year !== undefined) {
      clauses.push('year = ?');
      params.push(options.year);
    }
    if (options.type !== undefined) {
      clauses.push('type = ?');
      params.push(options.type);
    }
    if (options.hasFulltext !== undefined) {
      clauses.push(
        options.hasFulltext ? 'fulltext_artifact_id IS NOT NULL' : 'fulltext_artifact_id IS NULL',
      );
    }
    if (options.hasDoi !== undefined) {
      clauses.push(options.hasDoi ? 'doi IS NOT NULL' : 'doi IS NULL');
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(options.limit ?? 100, 1000)));
    params.push(Math.max(0, options.offset ?? 0));

    return (
      this.#db
        .prepare(
          `SELECT * FROM refs${where}
           ORDER BY year DESC NULLS LAST, first_author, added_at DESC, rowid DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params) as RefRow[]
    ).map((r) => this.#toRef(r));
  }

  /**
   * 取出可能与给定指纹重复的候选。
   *
   * 不做全表两两比对：一次导入几百条文献时那是几万次编辑距离。这里用索引把候选
   * 收窄到四类，然后由 `matchRefs` 在候选集上做真正的判定。
   *
   * 1. 标识命中（DOI/PMID/PMCID/arXiv，含别名表）—— 精确匹配路径。
   * 2. 归一化标题完全相同。
   * 3. 第一作者相同且年份相差不超过一年 —— 覆盖标题有拼写差异的情形。
   * 4. 归一化标题的前 24 个字符相同 —— 覆盖副标题缺失的情形（长短标题共享前缀）。
   *
   * 库很小时（不超过 `FULL_SCAN_LIMIT` 条）直接全取。三千行短记录的全表扫描是
   * 毫秒级，而这样能覆盖上述四类都漏掉的边角情形（比如标题被上游改写过、
   * 第一作者名字拼法不同）。这个取舍是刻意的：小库的正确性比省下的几毫秒值钱。
   */
  candidates(fp: RefFingerprint, options: { limit?: number } = {}): readonly RefRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));

    if (this.count() <= FULL_SCAN_LIMIT) {
      return (this.#db.prepare('SELECT * FROM refs LIMIT ?').all(FULL_SCAN_LIMIT) as RefRow[]).map(
        (r) => this.#toRef(r),
      );
    }

    const found = new Map<string, RefRow>();

    const byIdentifier = this.#db.prepare(
      `SELECT refs.* FROM refs JOIN ref_aliases ON ref_aliases.ref_id = refs.id
       WHERE ref_aliases.scheme = ? AND ref_aliases.value = ?`,
    );
    for (const [scheme, value] of [
      ['doi', fp.doi],
      ['pmid', fp.pmid],
      ['pmcid', fp.pmcid],
      ['arxiv', fp.arxivId],
    ] as const) {
      if (value === null) continue;
      for (const row of byIdentifier.all(scheme, value) as RefRow[]) found.set(row.id, row);
    }

    if (fp.titleNorm !== '') {
      for (const row of this.#db
        .prepare('SELECT * FROM refs WHERE title_norm = ? LIMIT ?')
        .all(fp.titleNorm, limit) as RefRow[]) {
        found.set(row.id, row);
      }

      const prefix = fp.titleNorm.slice(0, 24);
      if (prefix.length >= 12) {
        for (const row of this.#db
          .prepare('SELECT * FROM refs WHERE title_norm LIKE ? LIMIT ?')
          // LIKE 的通配符只在末尾，前缀里的 % 与 _ 要转义，否则一个含下划线的
          // 标题会匹配到任意字符
          .all(`${prefix.replace(/[%_\\]/gu, '\\$&')}%`, limit) as RefRow[]) {
          found.set(row.id, row);
        }
      }
    }

    if (fp.firstAuthor !== '') {
      const rows =
        fp.year === null
          ? (this.#db
              .prepare('SELECT * FROM refs WHERE first_author = ? LIMIT ?')
              .all(fp.firstAuthor, limit) as RefRow[])
          : (this.#db
              .prepare(
                'SELECT * FROM refs WHERE first_author = ? AND (year IS NULL OR ABS(year - ?) <= 1) LIMIT ?',
              )
              .all(fp.firstAuthor, fp.year, limit) as RefRow[]);
      for (const row of rows) found.set(row.id, row);
    }

    return [...found.values()].map((r) => this.#toRef(r));
  }

  /* ---------------- 全文抓取尝试（需求 12.6）---------------- */

  /**
   * 记一次抓取尝试。
   *
   * 成功与失败都记。只记失败会让「这份全文是从哪来的」不可查，而抓取来源决定了
   * 这份内容能不能再分发（PMC 开放获取 vs 出版商页面）。
   */
  addFetchAttempt(input: {
    refId: string;
    source: string;
    url?: string | null;
    outcome: FetchOutcome;
    detail?: string | null;
    status?: number | null;
    bytes?: number | null;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO ref_fetch_attempts (ref_id, source, url, outcome, detail, status, bytes, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.refId,
        input.source,
        input.url ?? null,
        input.outcome,
        input.detail ?? null,
        input.status ?? null,
        input.bytes ?? null,
        Date.now(),
      );
  }

  fetchAttempts(refId: string, limit = 50): readonly RefFetchAttempt[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM ref_fetch_attempts WHERE ref_id = ?
           ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(refId, Math.max(1, Math.min(limit, 200))) as FetchAttemptRow[]
    ).map(toFetchAttempt);
  }

  /** 最近一次尝试的时间。用于「不要在一分钟内反复重试」这类节流判断。 */
  lastFetchAt(refId: string): number | null {
    const row = this.#db
      .prepare('SELECT MAX(at) AS at FROM ref_fetch_attempts WHERE ref_id = ?')
      .get(refId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  /* ---------------- 随文资源（需求 12.3、12.4）---------------- */

  addAsset(input: {
    refId: string;
    kind: RefAssetKind;
    artifactId: string;
    versionId: string;
    label?: string | null;
    caption?: string | null;
    sourceUrl?: string | null;
    originPath?: string | null;
  }): RefAsset {
    const id = `ra_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO ref_assets
           (id, ref_id, kind, artifact_id, version_id, label, caption, source_url, origin_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ref_id, kind, artifact_id) DO UPDATE SET
           version_id = excluded.version_id,
           label      = COALESCE(excluded.label, ref_assets.label),
           caption    = COALESCE(excluded.caption, ref_assets.caption),
           source_url = COALESCE(excluded.source_url, ref_assets.source_url),
           origin_path = COALESCE(excluded.origin_path, ref_assets.origin_path)`,
      )
      .run(
        id,
        input.refId,
        input.kind,
        input.artifactId,
        input.versionId,
        input.label ?? null,
        input.caption ?? null,
        input.sourceUrl ?? null,
        input.originPath ?? null,
        Date.now(),
      );

    // 冲突时插入的 id 没用上，按唯一键回读
    const row = this.#db
      .prepare('SELECT * FROM ref_assets WHERE ref_id = ? AND kind = ? AND artifact_id = ?')
      .get(input.refId, input.kind, input.artifactId) as AssetRow | undefined;
    if (row === undefined) throw new Error('随文资源写入后读取失败');
    return toAsset(row);
  }

  assets(refId: string, kind?: RefAssetKind): readonly RefAsset[] {
    const rows =
      kind === undefined
        ? (this.#db
            .prepare('SELECT * FROM ref_assets WHERE ref_id = ? ORDER BY kind, created_at')
            .all(refId) as AssetRow[])
        : (this.#db
            .prepare('SELECT * FROM ref_assets WHERE ref_id = ? AND kind = ? ORDER BY created_at')
            .all(refId, kind) as AssetRow[]);
    return rows.map(toAsset);
  }

  deleteAssets(refId: string): number {
    return this.#db.prepare('DELETE FROM ref_assets WHERE ref_id = ?').run(refId).changes;
  }

  /** 库概览。UI 的文献页与工具输出都要它。 */
  stats(): {
    total: number;
    withDoi: number;
    withFulltext: number;
    withoutFulltext: number;
    byType: Readonly<Record<string, number>>;
    yearRange: { min: number | null; max: number | null };
  } {
    const total = this.count();
    const scalar = (sql: string): number =>
      (this.#db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

    const byType: Record<string, number> = {};
    for (const row of this.#db
      .prepare("SELECT COALESCE(type, 'unknown') AS t, COUNT(*) AS n FROM refs GROUP BY t")
      .all() as { t: string; n: number }[]) {
      byType[row.t] = row.n;
    }

    const range = this.#db
      .prepare('SELECT MIN(year) AS min, MAX(year) AS max FROM refs WHERE year IS NOT NULL')
      .get() as { min: number | null; max: number | null } | undefined;

    return {
      total,
      withDoi: scalar('SELECT COUNT(*) AS n FROM refs WHERE doi IS NOT NULL'),
      withFulltext: scalar('SELECT COUNT(*) AS n FROM refs WHERE fulltext_artifact_id IS NOT NULL'),
      withoutFulltext: scalar('SELECT COUNT(*) AS n FROM refs WHERE fulltext_artifact_id IS NULL'),
      byType,
      yearRange: { min: range?.min ?? null, max: range?.max ?? null },
    };
  }
}

/** 小于这个规模时候选集直接全取。见 `candidates` 的说明。 */
export const FULL_SCAN_LIMIT = 3000;

/** 合并来源标签，去重且保持顺序。`crossref+openalex` 这种形式。 */
export function mergeSourceLabel(a: string | null, b: string | null): string | null {
  const parts = [...(a ?? '').split('+'), ...(b ?? '').split('+')]
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const unique = [...new Set(parts)];
  return unique.length === 0 ? null : unique.join('+');
}
