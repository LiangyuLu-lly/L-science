/**
 * 手稿编译服务（任务 13.6，需求 13.5-13.8）。
 *
 * 把「读源稿 → 解析 → 编译 → 落成制品 → 记编译历史」串起来。`compile.ts` 是纯函数，
 * 这一层负责与仓储和制品库打交道。
 *
 * 一条决策：**编译前先触发一次审查**（需求 11.3 明确把「手稿编译前」列为审查触发点）。
 * 编译是投稿前的最后一道工序，而无证据的断言与编造的引文在这一步之后就没有机会
 * 被发现了。不主动触发的话，用户会在「编译成功」的报告上直接投稿。
 */

import type { ArtifactStore } from '../artifact/store.js';
import type { RefRecord } from '../repo/refs.js';
import type { ManuscriptRecord, ManuscriptRepo } from '../repo/manuscripts.js';
import type { CompileResult } from './compile.js';
import { compileManuscript, compileSummary } from './compile.js';
import type { ManuscriptDocument } from './document.js';
import { parseManuscript } from './document.js';
import type { JournalProfile } from './journals.js';
import { findJournalProfile, parseJournalProfile } from './journals.js';

export interface CompileServiceDeps {
  repo: ManuscriptRepo;
  artifacts: ArtifactStore;
  /** 可用的文献条目。编译时用于渲染参考文献与自引检测。 */
  refs: () => readonly RefRecord[];
  /** 编译前触发审查（需求 11.3）。 */
  onBeforeCompile?: (info: { manuscriptId: string; conversationId: string | null }) => void;
  onLog?: (line: string) => void;
}

export interface CompileRequest {
  /** 源稿。三种给法之一。 */
  markdown?: string;
  sourceVersionId?: string;
  manuscriptId?: string;
  /** 目标期刊。省略时用手稿 front matter 里的 `journal`。 */
  targetJournal?: string | null;
  /** 自定义档案（JSON）。给了就用它，不再按期刊名匹配。 */
  customProfile?: unknown;
  /** 生成双盲送审版。 */
  blinded?: boolean;
  /** 同时生成正式版与双盲版。 */
  both?: boolean;
  conversationId?: string | null;
  modelId?: string | null;
  /** 输出文件名主干。 */
  stem?: string;
}

export interface CompileOutcome {
  ok: boolean;
  manuscript: ManuscriptRecord | null;
  /** 每个生成的版本。both 为真时有两项。 */
  outputs: readonly {
    blinded: boolean;
    artifactId: string;
    versionId: string;
    filename: string;
    bibArtifactId: string | null;
    bibVersionId: string | null;
    result: CompileResult;
  }[];
  reason: string | null;
}

export class ManuscriptCompiler {
  readonly repo: ManuscriptRepo;
  readonly #artifacts: ArtifactStore;
  readonly #refs: () => readonly RefRecord[];
  readonly #onBeforeCompile: CompileServiceDeps['onBeforeCompile'];
  readonly #log: (line: string) => void;

  constructor(deps: CompileServiceDeps) {
    this.repo = deps.repo;
    this.#artifacts = deps.artifacts;
    this.#refs = deps.refs;
    this.#onBeforeCompile = deps.onBeforeCompile;
    this.#log = deps.onLog ?? ((): void => undefined);
  }

  /** 只解析不编译。用于让用户先看元数据解析对不对。 */
  parse(input: { markdown?: string; sourceVersionId?: string }): {
    ok: boolean;
    doc: ManuscriptDocument | null;
    reason: string | null;
  } {
    const source = this.#readSource(input);
    if (source.text === null) return { ok: false, doc: null, reason: source.reason };
    try {
      return { ok: true, doc: parseManuscript(source.text), reason: null };
    } catch (err) {
      return {
        ok: false,
        doc: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async compile(request: CompileRequest): Promise<CompileOutcome> {
    const source = this.#readSource(request);
    if (source.text === null) {
      return { ok: false, manuscript: null, outputs: [], reason: source.reason };
    }

    let doc: ManuscriptDocument;
    try {
      doc = parseManuscript(source.text);
    } catch (err) {
      return {
        ok: false,
        manuscript: null,
        outputs: [],
        reason:
          `手稿元数据解析失败：${err instanceof Error ? err.message : String(err)}\n` +
          'front matter 只支持一个受限的 YAML 子集（标量、列表、嵌套映射、块标量），' +
          '不支持锚点、别名与流式映射。',
      };
    }

    /* ---------------- 档案 ---------------- */

    const target = request.targetJournal ?? doc.meta.targetJournal;
    let profile: JournalProfile;
    let matched: boolean;

    if (request.customProfile !== undefined && request.customProfile !== null) {
      profile = parseJournalProfile(request.customProfile, 'custom');
      matched = true;
    } else {
      const found = findJournalProfile(target);
      profile = found.profile;
      matched = found.matched;
    }

    /* ---------------- 手稿记录 ---------------- */

    let manuscript: ManuscriptRecord | null = null;
    if (request.manuscriptId !== undefined) {
      manuscript = this.repo.get(request.manuscriptId);
      if (manuscript === null) {
        return {
          ok: false,
          manuscript: null,
          outputs: [],
          reason: `手稿不存在：${request.manuscriptId}`,
        };
      }
    } else if (source.artifactId !== null) {
      manuscript = this.repo.getBySourceArtifact(source.artifactId);
    }

    if (manuscript === null) {
      manuscript = this.repo.create({
        title: doc.meta.title,
        targetJournal: target,
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        sourceArtifactId: source.artifactId,
        sourceVersionId: source.versionId,
        profileId: profile.id,
        ...(profile.id === 'custom' ? { profile } : {}),
      });
    } else {
      this.repo.update(manuscript.id, {
        title: doc.meta.title,
        targetJournal: target,
        sourceArtifactId: source.artifactId,
        sourceVersionId: source.versionId,
        profileId: profile.id,
        ...(profile.id === 'custom' ? { profile } : {}),
      });
      manuscript = this.repo.get(manuscript.id);
    }

    if (manuscript === null) {
      return { ok: false, manuscript: null, outputs: [], reason: '手稿记录写入后读取失败' };
    }

    /*
     * 编译前触发审查（需求 11.3）。
     *
     * 不 await：审查要跑模型调用，几十秒到几分钟。挂在编译上会让用户点一次编译
     * 等好几分钟。审查结果经 finding 事件到达，而编译报告里会提示去看它。
     */
    try {
      this.#onBeforeCompile?.({
        manuscriptId: manuscript.id,
        conversationId: request.conversationId ?? manuscript.conversationId,
      });
    } catch (err) {
      // 触发审查失败不该让编译失败：编译本身是纯粹的格式处理
      this.#log(`编译前审查触发失败：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ---------------- 编译 ---------------- */

    const refs = this.#refs();
    const stem = (request.stem ?? sanitizeStem(doc.meta.title ?? manuscript.id)).slice(0, 60);
    const variants: readonly boolean[] =
      request.both === true
        ? [false, true]
        : [
            request.blinded === true ||
              (request.blinded === undefined && profile.doubleBlindByDefault),
          ];

    const outputs: {
      blinded: boolean;
      artifactId: string;
      versionId: string;
      filename: string;
      bibArtifactId: string | null;
      bibVersionId: string | null;
      result: CompileResult;
    }[] = [];

    for (const blinded of variants) {
      const result = compileManuscript(doc, {
        profile,
        profileMatched: matched,
        blinded,
        refs,
        stem,
      });

      const filename = `${stem}${blinded ? '-blinded' : '-compiled'}.md`;
      const saved = this.#artifacts.save({
        filename,
        content: Buffer.from(result.content, 'utf8'),
        mime: 'text/markdown',
        ...(source.versionId === null ? {} : { inputVersionIds: [source.versionId] }),
      });

      let bibArtifactId: string | null = null;
      let bibVersionId: string | null = null;
      if (result.bibliography !== null && result.bibliographyFilename !== null) {
        const bib = this.#artifacts.save({
          filename: result.bibliographyFilename,
          content: Buffer.from(result.bibliography, 'utf8'),
          mime: result.bibliographyFilename.endsWith('.json')
            ? 'application/json'
            : 'application/x-bibtex',
        });
        bibArtifactId = bib.artifact.id;
        bibVersionId = bib.version.id;
      }

      this.repo.setCompiled(manuscript.id, {
        blinded,
        artifactId: saved.artifact.id,
        versionId: saved.version.id,
      });

      this.repo.addCompileRun({
        manuscriptId: manuscript.id,
        sourceVersionId: source.versionId,
        profileId: profile.id,
        blinded,
        artifactId: saved.artifact.id,
        versionId: saved.version.id,
        bibArtifactId,
        bibVersionId,
        errors: result.issues.filter((i) => i.severity === 'error').length,
        warnings: result.issues.filter((i) => i.severity === 'warn').length,
        selfCitationLeaks: result.selfCitationLeaks.length,
        report: result.report,
        removed: result.removedFields,
        counts: result.counts as unknown as Record<string, number>,
        ...(request.modelId === undefined || request.modelId === null
          ? {}
          : { modelId: request.modelId }),
      });

      outputs.push({
        blinded,
        artifactId: saved.artifact.id,
        versionId: saved.version.id,
        filename,
        bibArtifactId,
        bibVersionId,
        result,
      });

      this.#log(`编译 ${manuscript.id}：${compileSummary(result)}`);
    }

    return { ok: true, manuscript: this.repo.get(manuscript.id), outputs, reason: null };
  }

  /** 读源稿。三种给法：直接文本、制品版本、已有手稿记录的源稿版本。 */
  #readSource(input: { markdown?: string; sourceVersionId?: string; manuscriptId?: string }): {
    text: string | null;
    artifactId: string | null;
    versionId: string | null;
    reason: string | null;
  } {
    if (input.markdown !== undefined && input.markdown.trim() !== '') {
      return { text: input.markdown, artifactId: null, versionId: null, reason: null };
    }

    let versionId = input.sourceVersionId ?? null;
    if (versionId === null && input.manuscriptId !== undefined) {
      versionId = this.repo.get(input.manuscriptId)?.sourceVersionId ?? null;
    }

    if (versionId === null) {
      return {
        text: null,
        artifactId: null,
        versionId: null,
        reason:
          '需要源稿：给 markdown（正文原文）或 sourceVersionId（手稿制品的版本 id）。' +
          '已有手稿记录时也可以只给 manuscriptId，前提是它上次编译时记下了源稿版本。',
      };
    }

    const version = this.#artifacts.getVersion(versionId);
    if (version === null) {
      return {
        text: null,
        artifactId: null,
        versionId: null,
        reason: `制品版本不存在：${versionId}。用 save_artifacts 的返回值，不要凭记忆写 id。`,
      };
    }

    const bytes = this.#artifacts.readVersion(versionId);
    if (bytes === null) {
      return {
        text: null,
        artifactId: null,
        versionId: null,
        reason: `制品版本 ${versionId} 的内容读不出来（可能已被垃圾回收）。` + '重新保存一次源稿。',
      };
    }

    return {
      text: bytes.toString('utf8'),
      artifactId: version.artifactId,
      versionId,
      reason: null,
    };
  }
}

/** 文件名主干：去掉标点，保留可读性。 */
function sanitizeStem(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return cleaned === '' ? 'manuscript' : cleaned;
}
