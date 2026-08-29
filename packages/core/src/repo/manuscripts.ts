/**
 * 手稿与编译记录仓储（任务 13.6，需求 13.5-13.8）。
 *
 * 一条约束写在这一层：**正式版与双盲版的产物分列存放**。共用一列会让
 * 「上次编的是哪个版本」不可知，而那个区别在投稿时是决定性的——把正式版当成
 * 双盲版投出去，编辑部会直接判定盲审无效。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../db.js';
import type { JournalProfile } from '../manuscript/journals.js';

export type ManuscriptStatus = 'drafting' | 'compiled' | 'submitted' | 'archived';

export const MANUSCRIPT_STATUS_LABEL: Readonly<Record<ManuscriptStatus, string>> = {
  drafting: '起草中',
  compiled: '已编译',
  submitted: '已投稿',
  archived: '已归档',
};

export interface ManuscriptRecord {
  id: string;
  title: string | null;
  targetJournal: string | null;
  conversationId: string | null;
  /** 源稿制品。手稿本身是一个制品。 */
  sourceArtifactId: string | null;
  /** 源稿的具体版本。编译报告里的行号只对这一版有效。 */
  sourceVersionId: string | null;
  profileId: string | null;
  /** 自定义档案的完整内容。用内置档案时为 null。 */
  profile: JournalProfile | null;
  compiledArtifactId: string | null;
  compiledVersionId: string | null;
  blindedArtifactId: string | null;
  blindedVersionId: string | null;
  status: ManuscriptStatus;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface CompileRunRecord {
  id: string;
  manuscriptId: string;
  sourceVersionId: string | null;
  profileId: string;
  blinded: boolean;
  artifactId: string | null;
  versionId: string | null;
  bibArtifactId: string | null;
  bibVersionId: string | null;
  errors: number;
  warnings: number;
  selfCitationLeaks: number;
  report: string | null;
  /** 双盲版移除的字段清单。用户要能核对删对了没有。 */
  removed: readonly string[];
  counts: Readonly<Record<string, number>>;
  modelId: string | null;
  createdAt: number;
}

interface ManuscriptRow {
  id: string;
  title: string | null;
  target_journal: string | null;
  style_json: string | null;
  artifact_id: string | null;
  status: string | null;
  conversation_id: string | null;
  source_artifact_id: string | null;
  source_version_id: string | null;
  profile_id: string | null;
  profile_json: string | null;
  compiled_artifact_id: string | null;
  compiled_version_id: string | null;
  blinded_artifact_id: string | null;
  blinded_version_id: string | null;
  created_at: number | null;
  updated_at: number | null;
}

interface CompileRunRow {
  id: string;
  manuscript_id: string;
  source_version_id: string | null;
  profile_id: string;
  blinded: number;
  artifact_id: string | null;
  version_id: string | null;
  bib_artifact_id: string | null;
  bib_version_id: string | null;
  errors: number;
  warnings: number;
  self_citation_leaks: number;
  report: string | null;
  removed_json: string | null;
  counts_json: string | null;
  model_id: string | null;
  created_at: number;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 辅助字段损坏不该让整条记录读不出来
    return fallback;
  }
}

function toManuscript(row: ManuscriptRow): ManuscriptRecord {
  return {
    id: row.id,
    title: row.title,
    targetJournal: row.target_journal,
    conversationId: row.conversation_id,
    // M001 里叫 artifact_id，M009 加了更明确的 source_artifact_id。
    // 旧行只有前者，因此读取时兼容两者
    sourceArtifactId: row.source_artifact_id ?? row.artifact_id,
    sourceVersionId: row.source_version_id,
    profileId: row.profile_id,
    profile: parseJson<JournalProfile | null>(row.profile_json, null),
    compiledArtifactId: row.compiled_artifact_id,
    compiledVersionId: row.compiled_version_id,
    blindedArtifactId: row.blinded_artifact_id,
    blindedVersionId: row.blinded_version_id,
    status: (row.status ?? 'drafting') as ManuscriptStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCompileRun(row: CompileRunRow): CompileRunRecord {
  return {
    id: row.id,
    manuscriptId: row.manuscript_id,
    sourceVersionId: row.source_version_id,
    profileId: row.profile_id,
    blinded: row.blinded === 1,
    artifactId: row.artifact_id,
    versionId: row.version_id,
    bibArtifactId: row.bib_artifact_id,
    bibVersionId: row.bib_version_id,
    errors: row.errors,
    warnings: row.warnings,
    selfCitationLeaks: row.self_citation_leaks,
    report: row.report,
    removed: parseJson<readonly string[]>(row.removed_json, []),
    counts: parseJson<Readonly<Record<string, number>>>(row.counts_json, {}),
    modelId: row.model_id,
    createdAt: row.created_at,
  };
}

export class ManuscriptRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 手稿 ---------------- */

  create(input: {
    title?: string | null;
    targetJournal?: string | null;
    conversationId?: string | null;
    sourceArtifactId?: string | null;
    sourceVersionId?: string | null;
    profileId?: string | null;
    profile?: JournalProfile | null;
  }): ManuscriptRecord {
    const id = `ms_${randomUUID()}`;
    const now = Date.now();

    this.#db
      .prepare(
        `INSERT INTO manuscripts
           (id, title, target_journal, style_json, artifact_id, status, conversation_id,
            source_artifact_id, source_version_id, profile_id, profile_json,
            compiled_artifact_id, compiled_version_id, blinded_artifact_id, blinded_version_id,
            created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'drafting', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.title ?? null,
        input.targetJournal ?? null,
        input.sourceArtifactId ?? null,
        input.conversationId ?? null,
        input.sourceArtifactId ?? null,
        input.sourceVersionId ?? null,
        input.profileId ?? null,
        input.profile === undefined || input.profile === null
          ? null
          : JSON.stringify(input.profile),
        now,
        now,
      );

    const created = this.get(id);
    if (created === null) throw new Error('手稿创建后读取失败');
    return created;
  }

  get(id: string): ManuscriptRecord | null {
    const row = this.#db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(id) as
      ManuscriptRow | undefined;
    return row === undefined ? null : toManuscript(row);
  }

  /** 按源稿制品找手稿。同一份制品不该对应两条手稿记录。 */
  getBySourceArtifact(artifactId: string): ManuscriptRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM manuscripts
         WHERE source_artifact_id = ? OR artifact_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(artifactId, artifactId) as ManuscriptRow | undefined;
    return row === undefined ? null : toManuscript(row);
  }

  list(
    options: { conversationId?: string; status?: ManuscriptStatus; limit?: number } = {},
  ): readonly ManuscriptRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(options.limit ?? 100, 500)));

    return (
      this.#db
        .prepare(
          `SELECT * FROM manuscripts${where}
           ORDER BY COALESCE(updated_at, created_at, 0) DESC, rowid DESC LIMIT ?`,
        )
        .all(...params) as ManuscriptRow[]
    ).map(toManuscript);
  }

  update(
    id: string,
    patch: {
      title?: string | null;
      targetJournal?: string | null;
      sourceArtifactId?: string | null;
      sourceVersionId?: string | null;
      profileId?: string | null;
      profile?: JournalProfile | null;
      status?: ManuscriptStatus;
    },
  ): ManuscriptRecord | null {
    if (this.get(id) === null) return null;

    this.#db
      .prepare(
        `UPDATE manuscripts SET
           title = COALESCE(?, title),
           target_journal = COALESCE(?, target_journal),
           source_artifact_id = COALESCE(?, source_artifact_id),
           artifact_id = COALESCE(?, artifact_id),
           source_version_id = COALESCE(?, source_version_id),
           profile_id = COALESCE(?, profile_id),
           profile_json = COALESCE(?, profile_json),
           status = COALESCE(?, status),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.targetJournal ?? null,
        patch.sourceArtifactId ?? null,
        patch.sourceArtifactId ?? null,
        patch.sourceVersionId ?? null,
        patch.profileId ?? null,
        patch.profile === undefined || patch.profile === null
          ? null
          : JSON.stringify(patch.profile),
        patch.status ?? null,
        Date.now(),
        id,
      );

    return this.get(id);
  }

  /**
   * 记下编译产物。
   *
   * 正式版与双盲版分列写入：共用一列会让「上次编的是哪个版本」不可知，而把正式版
   * 当双盲版投出去会让盲审无效。
   */
  setCompiled(
    id: string,
    input: { blinded: boolean; artifactId: string; versionId: string },
  ): boolean {
    const columns = input.blinded
      ? 'blinded_artifact_id = ?, blinded_version_id = ?'
      : 'compiled_artifact_id = ?, compiled_version_id = ?';

    return (
      this.#db
        .prepare(
          `UPDATE manuscripts SET ${columns}, status = 'compiled', updated_at = ? WHERE id = ?`,
        )
        .run(input.artifactId, input.versionId, Date.now(), id).changes > 0
    );
  }

  delete(id: string): boolean {
    // compile_runs 与 claims 都有 ON DELETE CASCADE，跟着走
    return this.#db.prepare('DELETE FROM manuscripts WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------- 编译记录 ---------------- */

  addCompileRun(input: {
    manuscriptId: string;
    sourceVersionId?: string | null;
    profileId: string;
    blinded: boolean;
    artifactId?: string | null;
    versionId?: string | null;
    bibArtifactId?: string | null;
    bibVersionId?: string | null;
    errors: number;
    warnings: number;
    selfCitationLeaks: number;
    report?: string | null;
    removed?: readonly string[];
    counts?: Readonly<Record<string, number>>;
    modelId?: string | null;
  }): CompileRunRecord {
    const id = `cr_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO compile_runs
           (id, manuscript_id, source_version_id, profile_id, blinded, artifact_id, version_id,
            bib_artifact_id, bib_version_id, errors, warnings, self_citation_leaks,
            report, removed_json, counts_json, model_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.manuscriptId,
        input.sourceVersionId ?? null,
        input.profileId,
        input.blinded ? 1 : 0,
        input.artifactId ?? null,
        input.versionId ?? null,
        input.bibArtifactId ?? null,
        input.bibVersionId ?? null,
        input.errors,
        input.warnings,
        input.selfCitationLeaks,
        input.report ?? null,
        JSON.stringify(input.removed ?? []),
        JSON.stringify(input.counts ?? {}),
        input.modelId ?? null,
        Date.now(),
      );

    const created = this.getCompileRun(id);
    if (created === null) throw new Error('编译记录创建后读取失败');
    return created;
  }

  getCompileRun(id: string): CompileRunRecord | null {
    const row = this.#db.prepare('SELECT * FROM compile_runs WHERE id = ?').get(id) as
      CompileRunRow | undefined;
    return row === undefined ? null : toCompileRun(row);
  }

  compileRuns(manuscriptId: string, limit = 20): readonly CompileRunRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM compile_runs WHERE manuscript_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(manuscriptId, Math.max(1, Math.min(limit, 200))) as CompileRunRow[]
    ).map(toCompileRun);
  }

  /**
   * 问题数的变化趋势。
   *
   * 投稿前要判断「稿子在收敛还是在发散」。只看最近一次编译报告答不了这个问题——
   * 一次编译有 12 个问题，可能是从 40 个降下来的，也可能是从 3 个涨上去的，
   * 而两者该做的事完全不同。
   */
  trend(
    manuscriptId: string,
    limit = 10,
  ): readonly { at: number; errors: number; warnings: number; leaks: number }[] {
    return (
      this.#db
        .prepare(
          `SELECT created_at, errors, warnings, self_citation_leaks FROM compile_runs
           WHERE manuscript_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(manuscriptId, Math.max(1, Math.min(limit, 100))) as {
        created_at: number;
        errors: number;
        warnings: number;
        self_citation_leaks: number;
      }[]
    )
      .map((row) => ({
        at: row.created_at,
        errors: row.errors,
        warnings: row.warnings,
        leaks: row.self_citation_leaks,
      }))
      .reverse();
  }
}
