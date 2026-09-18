/**
 * Skill Manager（任务 12.1-12.3，需求 9.1-9.6、9.8）。
 *
 * 把加载、同步、索引、依赖检查、注入、审计串成一个门面。会话侧只需要
 * 「按这句话找技能」与「把这个技能注入进来」两件事。
 *
 * 一条贯穿的判断：**技能不常驻上下文**（需求 9.3）。三十几个技能的 SKILL.md
 * 合起来是十几万字符，常驻会把上下文预算吃掉大半，而任何一次对话真正需要的
 * 通常只有一两个。因此这里只在检索命中后注入，且注入哪些、为什么注入全部
 * 记进审计（需求 9.8）。
 */

import { createHash } from 'node:crypto';

import type { Db } from '../db.js';
import { SkillRepo, type SkillLoadReason } from '../repo/skills.js';
import { loadSkillCatalog, readSkillReference, type SkillCatalog } from './loader.js';
import type { LoadedSkill, SkillManifest } from './manifest.js';
import {
  checkManyRequirements,
  describeMissing,
  type RequirementProbes,
  type RequirementReport,
} from './requirements.js';
import { SkillSearchIndex, type Embedder, type SkillSearchHit } from './search.js';

export interface SkillManagerOptions {
  builtinDir: string;
  userDir: string;
  /** 应用库。用于同步 skills 表与缓存嵌入向量。 */
  db: Db;
  probes: RequirementProbes;
  pythonEnv?: string;
  rEnv?: string;
  capabilityRemediation?: Readonly<Record<string, string>>;
  /** 嵌入层。省略或不可用时只走词法检索。 */
  embedder?: Embedder | null;
  onLog?: (line: string) => void;
}

export interface SkillInjection {
  slug: string;
  name: string;
  /** 注入上下文的正文。已带上依赖缺失的说明。 */
  content: string;
  /** 依赖检查结论。 */
  requirements: RequirementReport;
  /** 可供二次加载的参考材料。 */
  references: readonly string[];
}

/** 检索结果里附带的可用性信息。检索不过滤掉依赖缺失的技能，但要如实标注。 */
export interface SkillSearchResult extends SkillSearchHit {
  scope: LoadedSkill['scope'];
  requirementsSatisfied: boolean;
  missingSummary: string | null;
  references: readonly string[];
}

export class SkillManager {
  readonly #opts: SkillManagerOptions;
  readonly #repo: SkillRepo;
  readonly #onLog: (line: string) => void;

  #catalog: SkillCatalog = { skills: new Map(), shadowed: [], broken: [], unavailable: [] };
  #index = new SkillSearchIndex([]);
  #requirements = new Map<string, RequirementReport>();
  /** 嵌入层是否已就绪。构建失败时保持 false 并只走词法层。 */
  #vectorsReady = false;
  #embedFailure: string | null = null;

  constructor(options: SkillManagerOptions) {
    this.#opts = options;
    this.#repo = new SkillRepo(options.db);
    this.#onLog = options.onLog ?? ((): void => {});
  }

  get catalog(): SkillCatalog {
    return this.#catalog;
  }

  get vectorsReady(): boolean {
    return this.#vectorsReady;
  }

  get embedFailure(): string | null {
    return this.#embedFailure;
  }

  /**
   * 重新扫描技能目录。
   *
   * 同步进库并重建索引。依赖检查一次批量做完（Python 与 R 各只起一次进程），
   * 结果缓存到下次扫描——用户中途装了包需要重扫才生效，这个限制换来的是
   * 检索命中时不必等一次环境探测。
   */
  reload(): SkillCatalog {
    this.#catalog = loadSkillCatalog({
      builtinDir: this.#opts.builtinDir,
      userDir: this.#opts.userDir,
    });

    const skills = [...this.#catalog.skills.values()];
    this.#repo.sync([...skills, ...this.#catalog.unavailable]);

    for (const skill of skills) {
      for (const warning of skill.warnings) {
        this.#onLog(`技能 ${skill.manifest.slug}：${warning}`);
      }
    }
    for (const broken of this.#catalog.broken) {
      this.#onLog(`技能加载失败 ${broken.dirName}：${broken.reason}`);
    }
    for (const skill of this.#catalog.unavailable) {
      this.#onLog(`技能不可用 ${skill.manifest.slug}：${skill.unavailableReason ?? ''}`);
    }

    // 只把用户启用的技能放进索引：禁用的技能被检索命中再告诉用户「它被你关了」
    // 毫无价值，而它会挤掉本该出现的候选
    const enabled = new Set(this.#repo.list().map((r) => r.slug));
    const active = skills.filter((s) => enabled.has(s.manifest.slug));

    this.#index = new SkillSearchIndex(active.map((s) => s.manifest));
    this.#requirements = new Map(
      checkManyRequirements({
        entries: active.map((s) => ({ slug: s.manifest.slug, requires: s.manifest.requires })),
        probes: this.#opts.probes,
        ...(this.#opts.pythonEnv === undefined ? {} : { pythonEnv: this.#opts.pythonEnv }),
        ...(this.#opts.rEnv === undefined ? {} : { rEnv: this.#opts.rEnv }),
        ...(this.#opts.capabilityRemediation === undefined
          ? {}
          : { capabilityRemediation: this.#opts.capabilityRemediation }),
      }),
    );

    this.#vectorsReady = false;
    return this.#catalog;
  }

  /**
   * 构建（或从缓存装载）嵌入向量。
   *
   * 失败不抛错：向量层是可选增强，它挂掉时检索必须继续可用。失败原因记在
   * `embedFailure` 上供设置页显示——静默降级会让用户以为向量层在工作。
   */
  async buildVectors(): Promise<{ built: number; cached: number; failed: string | null }> {
    const embedder = this.#opts.embedder;
    if (embedder === undefined || embedder === null) {
      this.#embedFailure = null;
      return { built: 0, cached: 0, failed: null };
    }

    const active = [...this.#catalog.skills.values()].filter((s) =>
      this.#requirements.has(s.manifest.slug),
    );

    const vectors = new Map<string, readonly number[]>();
    const toEmbed: Array<{ slug: string; text: string; hash: string }> = [];
    let cached = 0;

    for (const skill of active) {
      const text = SkillSearchIndex.embeddingText(skill.manifest);
      const hash = createHash('sha256').update(text, 'utf8').digest('hex');

      const row = this.#opts.db
        .prepare(
          'SELECT vector_json, text_sha256 FROM skill_embeddings WHERE slug = ? AND model = ?',
        )
        .get(skill.manifest.slug, embedder.id) as
        { vector_json: string; text_sha256: string } | undefined;

      // 文本没变才用缓存。变了还用等于「改了 triggers 但搜不到」
      if (row !== undefined && row.text_sha256 === hash) {
        try {
          vectors.set(skill.manifest.slug, JSON.parse(row.vector_json) as number[]);
          cached += 1;
          continue;
        } catch {
          // 缓存坏了就重算，不让它拖垮整次构建
        }
      }
      toEmbed.push({ slug: skill.manifest.slug, text, hash });
    }

    let built = 0;
    if (toEmbed.length > 0) {
      try {
        const result = await embedder.embed(toEmbed.map((e) => e.text));
        const insert = this.#opts.db.prepare(
          `INSERT INTO skill_embeddings (slug, model, text_sha256, dims, vector_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (slug, model) DO UPDATE SET
             text_sha256 = excluded.text_sha256,
             dims = excluded.dims,
             vector_json = excluded.vector_json,
             updated_at = excluded.updated_at`,
        );

        const write = this.#opts.db.transaction(() => {
          for (const [i, entry] of toEmbed.entries()) {
            const vector = result[i];
            if (vector === undefined) continue;
            vectors.set(entry.slug, vector);
            insert.run(
              entry.slug,
              embedder.id,
              entry.hash,
              vector.length,
              JSON.stringify(vector),
              Date.now(),
            );
            built += 1;
          }
        });
        write();
        this.#embedFailure = null;
      } catch (err) {
        this.#embedFailure = err instanceof Error ? err.message : String(err);
        this.#onLog(`技能嵌入构建失败，退回词法检索：${this.#embedFailure}`);
        // 已从缓存拿到的向量仍然装上：部分可用比完全不可用好
      }
    }

    if (vectors.size > 0) {
      this.#index.setVectors(vectors);
      this.#vectorsReady = true;
    }
    return { built, cached, failed: this.#embedFailure };
  }

  /** 检索技能（需求 9.4）。 */
  async search(query: string, limit = 5): Promise<readonly SkillSearchResult[]> {
    let queryVector: readonly number[] | undefined;

    const embedder = this.#opts.embedder;
    if (this.#vectorsReady && embedder !== undefined && embedder !== null) {
      try {
        const [vector] = await embedder.embed([query]);
        if (vector !== undefined) queryVector = vector;
      } catch (err) {
        // 查询侧嵌入失败就只用词法层，不让检索整个失败
        this.#onLog(
          `查询嵌入失败，本次只用词法检索：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const hits = this.#index.search(query, {
      limit,
      ...(queryVector === undefined ? {} : { queryVector }),
    });

    return hits.map((hit) => {
      const skill = this.#catalog.skills.get(hit.slug);
      const report = this.#requirements.get(hit.slug);
      const missing = report === undefined ? '' : describeMissing(report);
      return {
        ...hit,
        scope: skill?.scope ?? 'builtin',
        requirementsSatisfied: report?.satisfied ?? true,
        missingSummary: missing === '' ? null : missing,
        references: skill?.references ?? [],
      };
    });
  }

  get(slug: string): LoadedSkill | null {
    return this.#catalog.skills.get(slug) ?? null;
  }

  requirementsOf(slug: string): RequirementReport | null {
    return this.#requirements.get(slug) ?? null;
  }

  /**
   * 取一个技能的注入内容（需求 9.5）。
   *
   * 依赖缺失时**仍然注入**，但把缺失项与安装命令附在开头。不注入会让模型完全
   * 不知道有这个方法存在，于是自己手写一个方法学上不对的版本；而注入且明确
   * 告知缺什么，模型可以直接把安装命令交给用户。
   */
  inject(slug: string): SkillInjection | null {
    const skill = this.#catalog.skills.get(slug);
    if (skill === null || skill === undefined) return null;

    const report = this.#requirements.get(slug) ?? {
      satisfied: true,
      missing: [],
      probeFailures: [],
    };
    const missing = describeMissing(report);

    const header = [
      `# 技能：${skill.manifest.name}（${slug}）`,
      skill.manifest.domain === null ? '' : `领域：${skill.manifest.domain}`,
      missing === ''
        ? ''
        : `> **依赖未满足。** 先把下面的依赖装好再按本技能操作，不要绕过它自己实现：\n> ${missing.replace(/\n/g, '\n> ')}`,
      skill.references.length === 0
        ? ''
        : `参考材料（需要时用 load_skill_reference 加载）：${skill.references.join('、')}`,
    ]
      .filter((s) => s !== '')
      .join('\n');

    return {
      slug,
      name: skill.manifest.name,
      content: `${header}\n\n${skill.instructions}`,
      requirements: report,
      references: skill.references,
    };
  }

  /** 读一份参考材料（需求 9.5 的二次加载）。 */
  readReference(
    slug: string,
    name: string,
  ): { ok: true; content: string } | { ok: false; reason: string } {
    const skill = this.#catalog.skills.get(slug);
    if (skill === undefined) return { ok: false, reason: `技能不存在：${slug}` };
    return readSkillReference(skill, name);
  }

  /** 全部生效技能的清单，供 UI 与 host.skills 使用。 */
  list(): readonly SkillManifest[] {
    return [...this.#catalog.skills.values()].map((s) => s.manifest);
  }

  setEnabled(slug: string, enabled: boolean): boolean {
    const changed = this.#repo.setEnabled(slug, enabled);
    // 启用状态影响索引内容，改完必须重建——否则关掉的技能还会被检索到
    if (changed) this.reload();
    return changed;
  }

  /** 库里的记录（含被禁用的），供设置页显示。 */
  records(): ReturnType<SkillRepo['list']> {
    return this.#repo.list({ includeDisabled: true });
  }
}

export type { SkillLoadReason };
