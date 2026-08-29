/**
 * Artifact 版本与血缘（任务 7.2、7.3，需求 6.2、6.3、6.4、6.6）。
 *
 * 「更新即新版本」是这里的基本约定（需求 6.2）。覆盖旧版本会毁掉论文写作里
 * 最需要的东西：一张图改过三轮之后，作者需要知道投稿时用的是哪一版、它是哪段
 * 代码跑出来的。覆盖之后这些都没了，而且没有任何迹象表明曾经存在过。
 *
 * 血缘的向上追溯（需求 6.4）用递归 CTE 实现。在应用层写循环也能做，但那样
 * 每一层都是一次往返，而追溯深度在真实项目里能到十几层——原始数据、预处理、
 * 分段、特征、统计、出图，每一步都可能有多个输入。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Db } from '../db.js';
import { BlobStore, hashBuffer } from './blob-store.js';

/** 血缘关系的类型。 */
export type LineageRelation = 'derived-from' | 'input-to' | 'revision-of';

export interface ArtifactRecord {
  id: string;
  filename: string;
  mime: string | null;
  /** 分类，用于 UI 分组与「图像必须有可复现血缘」这类规则。 */
  kind: ArtifactKind | null;
  latestVersionId: string | null;
  createdAt: number;
  deletedAt: number | null;
}

/**
 * 制品分类。
 *
 * `image` 单独一类不是为了 UI 分组，而是因为需求 6.6 对它有额外要求：
 * 图像必须具备可复现血缘。一张没有生成代码的图在论文里是不可用的——审稿人
 * 问「这个图怎么来的」时答不出来。
 */
export type ArtifactKind = 'image' | 'table' | 'document' | 'data' | 'code' | 'other';

/** 代码血缘。记录「这个版本是怎么产生的」。 */
export interface CodeLineage {
  /** 生成它的代码。图像类缺失时会被标记待 Reviewer 处理。 */
  code: string | null;
  language: string | null;
  /** 输入的制品版本 id。 */
  inputVersionIds: readonly string[];
  /**
   * 血缘是否完整到足以复现。
   *
   * 由 `assessReproducibility` 判定并落库，而不是每次查询时重算：判定规则会
   * 随需求演进，而「当时判定为不可复现」这个事实需要保留——Reviewer 的发现
   * 是基于当时的判定发出的。
   */
  reproducible: boolean;
  /** 不可复现的原因。可复现时为 null。 */
  gap: string | null;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionNo: number;
  blobSha256: string;
  createdByToolCallId: string | null;
  language: string | null;
  codeLineage: CodeLineage | null;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  filename: string;
  mime: string | null;
  kind: string | null;
  latest_version_id: string | null;
  created_at: number;
  deleted_at: number | null;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  version_no: number;
  blob_sha256: string;
  created_by_tool_call_id: string | null;
  language: string | null;
  code_lineage_json: string | null;
  created_at: number;
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    kind: row.kind as ArtifactKind | null,
    latestVersionId: row.latest_version_id,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function toVersion(row: VersionRow): ArtifactVersion {
  let codeLineage: CodeLineage | null = null;
  if (row.code_lineage_json !== null) {
    try {
      codeLineage = JSON.parse(row.code_lineage_json) as CodeLineage;
    } catch {
      // 血缘损坏时按缺失处理而不是让版本读不出来。缺失会被
      // assessReproducibility 的既有判定覆盖，不会伪装成可复现
      codeLineage = null;
    }
  }

  return {
    id: row.id,
    artifactId: row.artifact_id,
    versionNo: row.version_no,
    blobSha256: row.blob_sha256,
    createdByToolCallId: row.created_by_tool_call_id,
    language: row.language,
    codeLineage,
    createdAt: row.created_at,
  };
}

/** 按文件名与 MIME 推断分类。 */
export function inferKind(filename: string, mime: string | null): ArtifactKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  if (mime?.startsWith('image/') === true) return 'image';
  if (['png', 'jpg', 'jpeg', 'svg', 'pdf_page', 'tiff', 'webp'].includes(ext)) return 'image';
  if (['csv', 'tsv', 'xlsx', 'parquet'].includes(ext)) return 'table';
  // bib/ris/nbib 是书目文件：它们是参考文献列表的可投稿形态，与手稿同类
  if (['md', 'txt', 'docx', 'tex', 'pdf', 'bib', 'ris', 'nbib'].includes(ext)) return 'document';
  if (['py', 'r', 'ipynb', 'sh', 'ps1', 'sql'].includes(ext)) return 'code';
  if (['npy', 'npz', 'h5', 'hdf5', 'mat', 'edf', 'fif', 'nii', 'pkl'].includes(ext)) return 'data';
  return 'other';
}

/**
 * 判定血缘是否足以复现（需求 6.6）。
 *
 * 图像类的标准更严：必须同时有生成代码与输入版本。只有代码没有输入意味着
 * 代码里的数据来源不明——可能是硬编码路径、可能是上一个 cell 的变量，
 * 两种情况下别人都跑不出同样的图。
 *
 * 非图像类只要求有代码：一张表格或一份文档即使输入不明，其内容本身仍然
 * 可核对；而一张图是不可核对的，看不出数字对不对。
 */
export function assessReproducibility(input: {
  kind: ArtifactKind;
  code: string | null;
  inputVersionIds: readonly string[];
}): { reproducible: boolean; gap: string | null } {
  const hasCode = input.code !== null && input.code.trim() !== '';

  if (!hasCode) {
    return {
      reproducible: false,
      gap:
        input.kind === 'image'
          ? '缺少生成这张图的代码。没有代码时无法核对图里的数字是怎么算出来的，' +
            '审稿人问起时答不上来。请在保存时提供生成它的代码。'
          : '缺少生成代码，无法复现。',
    };
  }

  if (input.kind === 'image' && input.inputVersionIds.length === 0) {
    return {
      reproducible: false,
      gap:
        '有生成代码但没有记录输入的数据版本。这意味着代码里的数据来源不明——' +
        '可能是硬编码路径，也可能是上一个 cell 留下的变量，两种情况下别人都跑不出同样的图。',
    };
  }

  return { reproducible: true, gap: null };
}

export interface SaveVersionInput {
  /** 已有制品的 id。省略则新建制品。 */
  artifactId?: string;
  filename: string;
  mime?: string | null;
  content: Buffer;
  createdByToolCallId?: string | null;
  language?: string | null;
  code?: string | null;
  /** 输入的制品版本 id，用于建立血缘。 */
  inputVersionIds?: readonly string[];
  /** 血缘关系类型。默认 derived-from。 */
  relation?: LineageRelation;
}

export interface SaveResult {
  artifact: ArtifactRecord;
  version: ArtifactVersion;
  /** 是否复用了已有 blob（去重命中）。 */
  deduped: boolean;
  /** 血缘不完整时的说明，供 Reviewer 使用。完整时为 null。 */
  reproducibilityGap: string | null;
}

export class ArtifactStore {
  readonly #db: Db;
  readonly blobs: BlobStore;

  constructor(db: Db, blobsRoot: string) {
    this.#db = db;
    this.blobs = new BlobStore(db, blobsRoot);
  }

  /**
   * 保存一个新版本（需求 6.2、6.3）。
   *
   * blob 落盘在事务之外，库操作在事务之内。见 blob-store 文件头对次序的说明。
   */
  save(input: SaveVersionInput): SaveResult {
    // 先查是否已存在，用于报告去重命中。put 本身是幂等的，但它不区分
    // 「新写入」与「命中已有」，而这个信息对验证去重效果有用
    const before = this.blobs.get(hashBuffer(input.content).sha256);
    const blob = this.blobs.put(input.content);
    const deduped = before !== null;

    const kind = inferKind(input.filename, input.mime ?? null);
    const inputVersionIds = input.inputVersionIds ?? [];
    const { reproducible, gap } = assessReproducibility({
      kind,
      code: input.code ?? null,
      inputVersionIds,
    });

    const codeLineage: CodeLineage = {
      code: input.code ?? null,
      language: input.language ?? null,
      inputVersionIds,
      reproducible,
      gap,
    };

    const now = Date.now();
    const versionId = `av_${randomUUID()}`;

    const run = this.#db.transaction(() => {
      let artifactId = input.artifactId;

      if (artifactId === undefined) {
        artifactId = `af_${randomUUID()}`;
        this.#db
          .prepare(
            `INSERT INTO artifacts (id, filename, mime, kind, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(artifactId, input.filename, input.mime ?? null, kind, now);
      } else {
        const existing = this.#db.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifactId);
        if (existing === undefined) throw new Error(`制品不存在：${artifactId}`);
      }

      // 版本号取当前最大加一。不用 COUNT：删过版本之后 COUNT 会产生重复号
      const maxRow = this.#db
        .prepare(
          'SELECT COALESCE(MAX(version_no), 0) AS n FROM artifact_versions WHERE artifact_id = ?',
        )
        .get(artifactId) as { n: number };
      const versionNo = maxRow.n + 1;

      // refcount 与版本行在同一事务里，两者不会脱节
      this.blobs.addRef(blob.sha256);

      this.#db
        .prepare(
          `INSERT INTO artifact_versions
             (id, artifact_id, version_no, blob_sha256, created_by_tool_call_id,
              language, code_lineage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          artifactId,
          versionNo,
          blob.sha256,
          input.createdByToolCallId ?? null,
          input.language ?? null,
          JSON.stringify(codeLineage),
          now,
        );

      this.#db
        .prepare('UPDATE artifacts SET latest_version_id = ? WHERE id = ?')
        .run(versionId, artifactId);

      // 血缘边。指向不存在的版本时静默跳过而不是抛错：模型可能引用了一个
      // 它以为存在的版本，让整次保存失败会连带丢掉已经算出来的结果
      const relation = input.relation ?? 'derived-from';
      const insertEdge = this.#db.prepare(
        `INSERT INTO artifact_lineage (child_version_id, parent_version_id, relation)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      const skipped: string[] = [];
      for (const parentId of inputVersionIds) {
        const parent = this.#db
          .prepare('SELECT id FROM artifact_versions WHERE id = ?')
          .get(parentId);
        if (parent === undefined) {
          skipped.push(parentId);
          continue;
        }
        insertEdge.run(versionId, parentId, relation);
      }

      return { artifactId, versionNo, skipped };
    });

    const { artifactId, skipped } = run() as {
      artifactId: string;
      versionNo: number;
      skipped: string[];
    };

    const artifact = this.getArtifact(artifactId);
    const version = this.getVersion(versionId);
    if (artifact === null || version === null) {
      throw new Error('保存后读取失败，数据可能已损坏');
    }

    // 跳过的血缘边要报告，否则用户会以为血缘是完整的
    const finalGap =
      skipped.length > 0
        ? `${gap ?? ''}${gap === null ? '' : ' '}以下输入版本不存在，血缘边未建立：${skipped.join('、')}`.trim()
        : gap;

    return { artifact, version, deduped, reproducibilityGap: finalGap };
  }

  /* ---------------- 查询 ---------------- */

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.#db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      ArtifactRow | undefined;
    return row === undefined ? null : toArtifact(row);
  }

  getVersion(id: string): ArtifactVersion | null {
    const row = this.#db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id) as
      VersionRow | undefined;
    return row === undefined ? null : toVersion(row);
  }

  listArtifacts(
    options: { includeDeleted?: boolean; kind?: ArtifactKind } = {},
  ): readonly ArtifactRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.includeDeleted !== true) clauses.push('deleted_at IS NULL');
    if (options.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM artifacts${where} ORDER BY created_at DESC`)
      .all(...params) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  /** 版本按序号升序，读起来就是这个制品的演进过程。 */
  listVersions(artifactId: string): readonly ArtifactVersion[] {
    const rows = this.#db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no')
      .all(artifactId) as VersionRow[];
    return rows.map(toVersion);
  }

  /** 某个版本的物理文件路径。用于 `{{artifact:...}}` 解析。 */
  versionPath(versionId: string): string | null {
    const version = this.getVersion(versionId);
    return version === null ? null : this.blobs.absolutePath(version.blobSha256);
  }

  readVersion(versionId: string): Buffer | null {
    const path = this.versionPath(versionId);
    if (path === null) return null;
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  /**
   * 读取内容并区分「读不到」的两种原因。
   *
   * 主动回收与意外丢失对用户的含义完全不同：前者是他自己删了制品之后的预期
   * 结果，后者是数据损坏。都返回 null 会让后者被当成前者忽略过去，而那正是
   * 最需要被发现的情况。
   */
  readVersionDetailed(
    versionId: string,
  ):
    | { state: 'ok'; content: Buffer }
    | { state: 'not-found' }
    | { state: 'evicted'; reason: string }
    | { state: 'missing'; reason: string } {
    const version = this.getVersion(versionId);
    if (version === null) return { state: 'not-found' };

    const path = this.blobs.absolutePath(version.blobSha256);
    try {
      return { state: 'ok', content: readFileSync(path) };
    } catch {
      if (this.blobs.isEvicted(version.blobSha256)) {
        return {
          state: 'evicted',
          reason:
            '该版本的内容已在垃圾回收中释放（制品被删除后不再被引用）。' +
            '血缘记录仍然完整，但文件本身需要重新生成。',
        };
      }
      return {
        state: 'missing',
        reason:
          `内容文件缺失但未被回收：${path}。这是数据损坏，不是正常的清理结果。` +
          '可能是文件被外部程序移动或删除了。',
      };
    }
  }

  /* ---------------- 血缘追溯 ---------------- */

  /**
   * 向上追溯到全部祖先版本（需求 6.4）。
   *
   * 用递归 CTE 而不是应用层循环：追溯深度在真实项目里能到十几层——原始数据、
   * 预处理、分段、特征、统计、出图，每步都可能有多个输入。逐层往返的代价会
   * 随深度线性增长，而这个查询在「这张图是怎么来的」面板上每次打开都要跑。
   *
   * `maxDepth` 防止血缘图里的环导致无限递归。环本不该存在（派生关系天然是
   * DAG），但一次错误的写入就能造出来，而无限递归会把整个后端卡死。
   */
  ancestors(versionId: string, maxDepth = 32): readonly LineageNode[] {
    return this.#traverse(versionId, maxDepth, 'up');
  }

  /** 向下追溯全部派生版本。用于「删掉它会影响什么」。 */
  descendants(versionId: string, maxDepth = 32): readonly LineageNode[] {
    return this.#traverse(versionId, maxDepth, 'down');
  }

  #traverse(versionId: string, maxDepth: number, direction: 'up' | 'down'): readonly LineageNode[] {
    const [from, to] =
      direction === 'up'
        ? ['child_version_id', 'parent_version_id']
        : ['parent_version_id', 'child_version_id'];

    const rows = this.#db
      .prepare(
        `WITH RECURSIVE walk(version_id, depth, relation) AS (
           SELECT ?, 0, NULL
           UNION
           SELECT l.${to}, w.depth + 1, l.relation
             FROM artifact_lineage l
             JOIN walk w ON l.${from} = w.version_id
            WHERE w.depth < ?
         )
         SELECT w.version_id AS version_id, w.depth AS depth, w.relation AS relation,
                v.artifact_id AS artifact_id, v.version_no AS version_no,
                a.filename AS filename
           FROM walk w
           JOIN artifact_versions v ON v.id = w.version_id
           JOIN artifacts a ON a.id = v.artifact_id
          WHERE w.depth > 0
          ORDER BY w.depth, a.filename`,
      )
      .all(versionId, maxDepth) as Array<{
      version_id: string;
      depth: number;
      relation: string | null;
      artifact_id: string;
      version_no: number;
      filename: string;
    }>;

    return rows.map((r) => ({
      versionId: r.version_id,
      artifactId: r.artifact_id,
      filename: r.filename,
      versionNo: r.version_no,
      depth: r.depth,
      relation: r.relation as LineageRelation | null,
    }));
  }

  /**
   * 血缘不完整的版本（需求 6.6）。
   *
   * Reviewer 用它产出发现。只列 latest 版本：历史版本的血缘缺陷已经无法补救，
   * 而且把它们全列出来会让发现列表被历史噪声淹没，真正需要处理的当前版本
   * 反而看不见。
   */
  irreproducible(): readonly ArtifactVersion[] {
    const rows = this.#db
      .prepare(
        `SELECT v.* FROM artifact_versions v
           JOIN artifacts a ON a.latest_version_id = v.id
          WHERE a.deleted_at IS NULL
          ORDER BY v.created_at DESC`,
      )
      .all() as VersionRow[];

    return rows.map(toVersion).filter((v) => v.codeLineage === null || !v.codeLineage.reproducible);
  }

  /* ---------------- 删除 ---------------- */

  /**
   * 描述删除的影响，用于审批卡片（需求 6.7、17.2）。
   *
   * `dependentCount` 是关键：删掉一个被别的版本引用的制品会让那些版本的血缘
   * 断掉，而血缘断掉的图在论文里就不可用了。用户需要在点同意之前知道这件事。
   */
  describeDeletion(artifactIds: readonly string[]): readonly DeleteCandidate[] {
    const candidates: DeleteCandidate[] = [];

    for (const artifactId of artifactIds) {
      const artifact = this.getArtifact(artifactId);
      if (artifact === null) continue;

      const versions = this.listVersions(artifactId);
      let totalBytes = 0;
      for (const version of versions) {
        totalBytes += this.blobs.get(version.blobSha256)?.sizeBytes ?? 0;
      }

      // 统计有多少个「不属于本次删除范围」的版本依赖它
      const versionIds = versions.map((v) => v.id);
      const placeholders = versionIds.map(() => '?').join(',');
      const dependents =
        versionIds.length === 0
          ? { n: 0 }
          : (this.#db
              .prepare(
                `SELECT COUNT(DISTINCT l.child_version_id) AS n
                   FROM artifact_lineage l
                   JOIN artifact_versions v ON v.id = l.child_version_id
                  WHERE l.parent_version_id IN (${placeholders})
                    AND v.artifact_id NOT IN (${artifactIds.map(() => '?').join(',')})`,
              )
              .get(...versionIds, ...artifactIds) as { n: number });

      candidates.push({
        artifactId,
        filename: artifact.filename,
        versionCount: versions.length,
        totalBytes,
        dependentCount: dependents.n,
      });
    }

    return candidates;
  }

  /**
   * 软删除并释放 blob 引用。
   *
   * 软删除而不是物理删除：血缘边指向版本行，物理删除会让引用它的版本失去
   * 追溯路径。blob 的 refcount 归零后由 GC 回收实际空间——空间是可以回收的，
   * 而血缘一旦断掉就补不回来了。
   */
  softDelete(artifactIds: readonly string[]): number {
    const run = this.#db.transaction(() => {
      let count = 0;
      for (const artifactId of artifactIds) {
        const info = this.#db
          .prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
          .run(Date.now(), artifactId);
        if (info.changes === 0) continue;

        // 释放每个版本占用的 blob 引用
        for (const version of this.listVersions(artifactId)) {
          this.blobs.release(version.blobSha256);
        }
        count += 1;
      }
      return count;
    });

    return run() as number;
  }

  /** 恢复软删除的制品。删除既然可逆，就要真的能恢复。 */
  restore(artifactId: string): boolean {
    const run = this.#db.transaction(() => {
      const info = this.#db
        .prepare('UPDATE artifacts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
        .run(artifactId);
      if (info.changes === 0) return false;

      for (const version of this.listVersions(artifactId)) {
        this.blobs.addRef(version.blobSha256);
      }
      return true;
    });

    return run() as boolean;
  }
}

/** 血缘追溯的一个节点。 */
export interface LineageNode {
  versionId: string;
  artifactId: string;
  filename: string;
  versionNo: number;
  /** 到查询起点的距离。0 是起点自身。 */
  depth: number;
  relation: LineageRelation | null;
}

export interface DeleteCandidate {
  artifactId: string;
  filename: string;
  versionCount: number;
  totalBytes: number;
  /** 引用它的其他版本数。非零说明删掉会破坏别人的血缘。 */
  dependentCount: number;
}
