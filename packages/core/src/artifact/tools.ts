/**
 * `save_artifacts` 与 `delete_artifacts` 工具（任务 7.3、7.5，需求 6.3、6.6、6.7）。
 *
 * 保存的入口刻意要求提供生成代码：图像类没有可复现血缘时会被标记，由 Reviewer
 * 提出发现（需求 6.6）。这个要求不是形式主义——一张没有生成代码的图在论文里
 * 是不可用的，审稿人问「这个图怎么来的」时答不上来，而发现这件事的时机
 * 应该是保存时，不是投稿前。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { ApprovalService } from '../approval/service.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.js';
import type { ArtifactStore } from './store.js';

export interface SaveArtifactsInput {
  /** 要提升为制品的文件，相对会话工作目录。 */
  paths: readonly string[];
  /** 生成这些文件的代码。图像类缺失时会被标记为不可复现。 */
  code?: string;
  language?: string;
  /** 输入的制品版本 id，建立血缘。 */
  inputVersionIds?: readonly string[];
  /** 覆盖已有制品时指定其 id，产生新版本而不是新制品。 */
  artifactId?: string;
}

/** 单个文件的保存上限。超大文件应留在工作区，用代码按需读取。 */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export interface SaveArtifactsToolOptions {
  store: ArtifactStore;
  /** 解析工作区内的路径并做边界检查。 */
  resolvePath: (raw: string, ctx: ToolContext) => string;
  /** 当前工具调用 id，用于记录血缘。 */
  currentToolCallId?: () => string | null;
  /**
   * 保存成功后的回调（需求 11.3 的「Artifact 保存」触发点）。
   *
   * 一次调用可以保存多个文件，因此在**全部处理完之后**回调一次并带上所有版本 id，
   * 而不是每个文件回调一次：Reviewer 的触发按次合并，逐个回调只会让它把同一批
   * 产物分成几次审查，而每次的输入都不完整。
   *
   * 回调抛错不影响保存结果——文件已经进库了，让工具因为一个通知失败而报错
   * 会促使模型重试，于是同一份内容被保存两次。
   */
  onSaved?: (input: {
    ctx: ToolContext;
    versionIds: readonly string[];
    /** 血缘不完整的说明，已在输出里给过模型。 */
    gaps: readonly string[];
  }) => void;
}

export function createSaveArtifactsTool(
  options: SaveArtifactsToolOptions,
): ToolDefinition<SaveArtifactsInput> {
  return {
    name: 'save_artifacts',
    description:
      '把工作区里的文件提升为制品，纳入版本管理与血缘追溯。' +
      '**保存图表时必须提供 code**：没有生成代码的图无法复现，审稿人问起时答不上来，' +
      'Reviewer 会为此提出发现。同一个逻辑产物的更新请带上 artifactId，' +
      '这样它成为新版本而不是一个新制品。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要保存的文件路径，相对会话工作目录',
        },
        code: {
          type: 'string',
          description:
            '生成这些文件的代码。图表必填。应当是能独立跑出同样结果的完整片段，' +
            '不是「见上文」这类指代。',
        },
        language: { type: 'string', description: '代码语言，如 python 或 r' },
        inputVersionIds: {
          type: 'array',
          items: { type: 'string' },
          description: '这些文件依赖的输入制品版本 id，用于建立血缘',
        },
        artifactId: {
          type: 'string',
          description: '更新已有制品时提供其 id，产生新版本。省略则新建制品。',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },

    parseInput(raw): SaveArtifactsInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (!Array.isArray(obj.paths) || obj.paths.length === 0) {
        throw new Error('paths 必须是非空数组');
      }
      for (const p of obj.paths) {
        if (typeof p !== 'string' || p === '') throw new Error('paths 的每一项必须是非空字符串');
      }
      if (obj.artifactId !== undefined && (obj.paths as unknown[]).length > 1) {
        // 一个制品只能有一份内容。多个文件配一个 artifactId 意味着模型
        // 想把它们合成一个版本，那是它对版本语义的误解
        throw new Error(
          '指定 artifactId 时只能保存一个文件——一个制品的一个版本对应一份内容。' +
            '多个文件请分次保存，各自会成为独立的制品。',
        );
      }
      if (obj.inputVersionIds !== undefined && !Array.isArray(obj.inputVersionIds)) {
        throw new Error('inputVersionIds 必须是数组');
      }

      return {
        paths: obj.paths as string[],
        ...(typeof obj.code === 'string' ? { code: obj.code } : {}),
        ...(typeof obj.language === 'string' ? { language: obj.language } : {}),
        ...(Array.isArray(obj.inputVersionIds)
          ? { inputVersionIds: obj.inputVersionIds as string[] }
          : {}),
        ...(typeof obj.artifactId === 'string' ? { artifactId: obj.artifactId } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const lines: string[] = [];
      const gaps: string[] = [];
      const savedVersionIds: string[] = [];
      let saved = 0;

      for (const rawPath of input.paths) {
        let resolved: string;
        try {
          resolved = options.resolvePath(rawPath, ctx);
        } catch (err) {
          lines.push(`${rawPath}：路径被拒 —— ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        if (!existsSync(resolved)) {
          lines.push(`${rawPath}：文件不存在。确认代码真的把它写出来了。`);
          continue;
        }

        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          lines.push(`${rawPath}：是目录。请逐个指定文件，或先打包再保存压缩包。`);
          continue;
        }
        if (stat.size > MAX_ARTIFACT_BYTES) {
          lines.push(
            `${rawPath}：${String(Math.round(stat.size / 1024 / 1024))} MB 超过单文件上限 ` +
              `${String(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB。大文件请留在工作区，用代码按需读取。`,
          );
          continue;
        }

        try {
          const result = options.store.save({
            filename: basename(resolved),
            content: readFileSync(resolved),
            ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.language === undefined ? {} : { language: input.language }),
            ...(input.inputVersionIds === undefined
              ? {}
              : { inputVersionIds: input.inputVersionIds }),
            createdByToolCallId: options.currentToolCallId?.() ?? null,
          });

          saved += 1;
          savedVersionIds.push(result.version.id);
          lines.push(
            `${result.artifact.filename}：已保存为 v${String(result.version.versionNo)}，` +
              `版本 id ${result.version.id}${result.deduped ? '（内容与已有 blob 相同，未重复占用空间）' : ''}`,
          );

          if (result.reproducibilityGap !== null) {
            gaps.push(`${result.artifact.filename}：${result.reproducibilityGap}`);
          }
        } catch (err) {
          lines.push(`${rawPath}：保存失败 —— ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const parts = [lines.join('\n')];
      if (gaps.length > 0) {
        // 血缘缺口不是错误，但必须被看到：Reviewer 会据此提出发现
        parts.push('', '血缘不完整（Reviewer 会就此提出发现）：', ...gaps.map((g) => `  · ${g}`));
      }

      if (savedVersionIds.length > 0 && options.onSaved !== undefined) {
        try {
          options.onSaved({ ctx, versionIds: savedVersionIds, gaps });
        } catch {
          // 文件已经进库了。让工具因为一个通知失败而报错会促使模型重试，
          // 于是同一份内容被保存两次
        }
      }

      return {
        ok: saved > 0,
        output: { kind: 'text', text: parts.join('\n') },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * delete_artifacts（任务 7.5，需求 6.7）
 * ------------------------------------------------------------------ */

export interface DeleteArtifactsInput {
  artifactIds: readonly string[];
  reason?: string;
}

export interface DeleteArtifactsToolOptions {
  store: ArtifactStore;
  approvals: ApprovalService;
}

/** 人类可读的字节数。审批卡片上「1.2 GB」比「1288490188」有意义得多。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function createDeleteArtifactsTool(
  options: DeleteArtifactsToolOptions,
): ToolDefinition<DeleteArtifactsInput> {
  return {
    name: 'delete_artifacts',
    description:
      '删除制品。会阻塞在用户审批上，列出待删条目与影响范围。' +
      '用户拒绝后不会重试同一请求——请改问用户想怎么处理，不要换个说法再试一次。',
    inputSchema: {
      type: 'object',
      properties: {
        artifactIds: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的制品 id',
        },
        reason: { type: 'string', description: '为什么要删。会展示给用户。' },
      },
      required: ['artifactIds'],
      additionalProperties: false,
    },
    needsApproval: true,

    parseInput(raw): DeleteArtifactsInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (!Array.isArray(obj.artifactIds) || obj.artifactIds.length === 0) {
        throw new Error('artifactIds 必须是非空数组');
      }
      for (const id of obj.artifactIds) {
        if (typeof id !== 'string' || id === '') {
          throw new Error('artifactIds 的每一项必须是非空字符串');
        }
      }

      return {
        artifactIds: obj.artifactIds as string[],
        ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const candidates = options.store.describeDeletion(input.artifactIds);

      if (candidates.length === 0) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'ArtifactNotFound',
            evalue: `指定的制品都不存在：${input.artifactIds.join('、')}`,
            traceback: [],
          },
        };
      }

      const totalBytes = candidates.reduce((sum, c) => sum + c.totalBytes, 0);
      const totalVersions = candidates.reduce((sum, c) => sum + c.versionCount, 0);
      const withDependents = candidates.filter((c) => c.dependentCount > 0);

      // 待删条目逐条列出，而不是只说「3 个制品」。用户需要看到文件名才能
      // 判断这是不是他想删的东西
      const itemList = candidates
        .map(
          (c) =>
            `  · ${c.filename}（${String(c.versionCount)} 个版本，${humanBytes(c.totalBytes)}）` +
            (c.dependentCount > 0 ? ` —— 有 ${String(c.dependentCount)} 个其他版本依赖它` : ''),
        )
        .join('\n');

      const impactParts = [
        `将删除 ${String(candidates.length)} 个制品、共 ${String(totalVersions)} 个版本，释放 ${humanBytes(totalBytes)}。`,
      ];
      if (withDependents.length > 0) {
        // 这是删除最要紧的后果：血缘断掉的图在论文里就不可用了
        impactParts.push(
          `其中 ${String(withDependents.length)} 个制品被其他版本引用，删除后那些版本的血缘会断掉，` +
            '受影响的产物将无法追溯到它的输入。',
        );
      }

      const result = await options.approvals.request({
        kind: 'artifact-delete',
        title: `删除 ${String(candidates.length)} 个制品？`,
        detail: [input.reason === undefined ? '' : `原因：${input.reason}`, '待删条目：', itemList]
          .filter((s) => s !== '')
          .join('\n'),
        impact: impactParts.join('\n'),
        // 软删除，因此可逆。但如实说明可逆的限度
        reversible: true,
        undoHint:
          '删除是软删除，可以在制品列表里恢复。但被删期间引用它的新版本无法建立血缘边，' +
          '恢复后也补不回来。',
        payload: { artifactIds: [...input.artifactIds].sort() },
        conversationId: ctx.conversationId,
      });

      if (result.state !== 'approved') {
        const reason =
          result.state === 'denied'
            ? result.fromPriorDenial
              ? '此前已拒绝过删除同一批制品，不再重复询问。请改问用户想怎么处理这些文件。'
              : `用户拒绝了删除。${result.note ?? ''}`.trim()
            : result.state === 'timeout'
              ? '删除审批超时，没有删除任何东西。'
              : `审批被取消：${result.reason}`;

        return {
          ok: false,
          output: { kind: 'text', text: `${reason}\n没有删除任何制品。` },
        };
      }

      const deleted = options.store.softDelete(input.artifactIds);
      return {
        ok: true,
        output: {
          kind: 'text',
          text:
            `已删除 ${String(deleted)} 个制品。空间会在下次垃圾回收时释放。` +
            '需要时可以在制品列表里恢复。',
        },
      };
    },
  };
}
