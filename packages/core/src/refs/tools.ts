/**
 * `manage_references` 工具（任务 13.1，需求 12.1、12.2）。
 *
 * 一个工具带 `action` 判别，而不是六个独立工具。理由是文献操作之间有强顺序依赖
 * （检索 → 确认是哪一篇 → 按 DOI 入库 → 导出），把它们做成六个工具之后模型要在
 * 六份描述里推断这个顺序；写在一个工具的 action 枚举里，顺序可以直接写在描述上。
 *
 * 最重要的一条约束体现在 `resolve` 与 `search` 的分工：**按标题不能直接入库**。
 * 模型经常「记得」一条引文的标题与年份，如果允许它按标题入库，那个记忆里的条目
 * 就会以一条真实文献的身份进入参考文献列表。因此标题只能走 `search`，拿到候选与
 * 它们真实的 DOI 之后再 `resolve`。这条约束在需求 13.9 里对引文核实是强制的，
 * 这里把它前移到了入库环节。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { citeLine } from './csl.js';
import type { ExportFormat } from './export.js';
import { EXPORT_FORMAT_LABEL, renderExportWarnings } from './export.js';
import type { RefLibrary } from './library.js';
import { SOURCE_LABEL } from './library.js';
import type { RefSourceId } from './http.js';

export interface RefToolOptions {
  library: () => RefLibrary;
  /** 文献库发生变化时通知 UI。 */
  onChanged?: (info: { action: string; refIds: readonly string[] }) => void;
}

export type RefAction =
  'resolve' | 'search' | 'list' | 'get' | 'remove' | 'merge' | 'fulltext' | 'assets' | 'export';

export interface RefToolInput {
  action: RefAction;
  identifiers?: readonly string[];
  query?: string;
  author?: string;
  year?: number;
  refId?: string;
  refIds?: readonly string[];
  keepId?: string;
  dropId?: string;
  limit?: number;
  refresh?: boolean;
  force?: boolean;
  format?: ExportFormat;
  stem?: string;
  asciiOnly?: boolean;
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['resolve', 'search', 'list', 'get', 'remove', 'merge', 'fulltext', 'assets', 'export'],
      description:
        'resolve：按 DOI/PMID/PMCID/arXiv 标识解析元数据并入库（支持一次多个）。' +
        'search：按标题或书目信息检索上游，返回候选但**不入库**。' +
        'list：列出文献库里已有的条目。get：看某一条的完整元数据。' +
        'remove：删除一条。merge：把两条重复记录合并。' +
        'fulltext：按开放获取优先的顺序抓全文（PMC 开放获取包能一并拿到插图）。' +
        'assets：列出某条文献已抓到的全文、插图与补充材料，含制品版本 id。' +
        'export：导出 BibTeX / CSL-JSON / RIS 并存为制品，返回可直接用的引用键。\n' +
        '只知道标题时必须先 search 确认是哪一篇，再用它的 DOI 走 resolve。' +
        '不要凭记忆构造 DOI——错的 DOI 会解析出另一篇文献，而结果看起来是成功的。',
    },
    identifiers: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 50,
      description:
        'action=resolve 时的标识列表。可以是 DOI（10.1038/xxx）、PMID（纯数字）、' +
        'PMCID（PMC1234567）、arXiv 编号（2401.01234），也可以是含 DOI 的完整链接。',
    },
    query: {
      type: 'string',
      description:
        'action=search 时的检索词，通常是标题；也可以是「标题 + 作者 + 期刊」的混合串。' +
        'action=list 时是在库内标题/作者/期刊上做的子串筛选。',
    },
    author: { type: 'string', description: 'action=search 时可选的作者姓氏，用于收窄结果。' },
    year: { type: 'integer', description: '发表年份，用于收窄检索或筛选库内条目。' },
    refId: {
      type: 'string',
      description: 'action=get / remove / fulltext / assets 时的文献 id（形如 rf_…）。',
    },
    keepId: { type: 'string', description: 'action=merge 时保留的文献 id。' },
    dropId: { type: 'string', description: 'action=merge 时并入并删除的文献 id。' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数上限。' },
    refresh: {
      type: 'boolean',
      description: 'action=resolve 时即使库里已有也重新解析一遍。用于修补当初元数据不全的记录。',
    },
    force: {
      type: 'boolean',
      description: 'action=fulltext 时即使已有全文也重抓。用于换一个能拿到插图的来源。',
    },
    refIds: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 500,
      description: 'action=export 时只导出这些文献。省略则导出全库（可配合 query/year 筛选）。',
    },
    format: {
      type: 'string',
      enum: ['bibtex', 'csl-json', 'ris'],
      description:
        'action=export 的格式。bibtex 给 LaTeX；csl-json 给 pandoc 与 Word 的 CSL 引擎；' +
        'ris 给 EndNote 与多数期刊投稿系统。三种格式的引用键一致，可以混用。',
    },
    stem: {
      type: 'string',
      description: 'action=export 的输出文件名（不含扩展名）。默认 references。',
    },
    asciiOnly: {
      type: 'boolean',
      description:
        'action=export 且 format=bibtex 时把重音字符转成 LaTeX 写法。传统 bibtex ' +
        '工具链需要；用 biblatex + biber 则不需要。',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

function parseInput(raw: unknown): RefToolInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
  const obj = raw as Record<string, unknown>;

  const action = obj.action;
  if (
    action !== 'resolve' &&
    action !== 'search' &&
    action !== 'list' &&
    action !== 'get' &&
    action !== 'remove' &&
    action !== 'merge' &&
    action !== 'fulltext' &&
    action !== 'assets' &&
    action !== 'export'
  ) {
    throw new Error(
      'action 必须是 resolve/search/list/get/remove/merge/fulltext/assets/export 之一，' +
        `收到 ${String(action)}`,
    );
  }

  const format = obj.format;
  if (format !== undefined && format !== 'bibtex' && format !== 'csl-json' && format !== 'ris') {
    throw new Error(`format 必须是 bibtex/csl-json/ris 之一，收到 ${String(format)}`);
  }

  const refIds: string[] = [];
  if (Array.isArray(obj.refIds)) {
    for (const entry of obj.refIds) {
      if (typeof entry !== 'string') throw new Error('refIds 的每一项必须是字符串');
      const trimmed = entry.trim();
      if (trimmed !== '') refIds.push(trimmed);
    }
  }
  if (refIds.length > 500) throw new Error('一次最多导出 500 条');

  const identifiers: string[] = [];
  if (Array.isArray(obj.identifiers)) {
    for (const entry of obj.identifiers) {
      if (typeof entry !== 'string') throw new Error('identifiers 的每一项必须是字符串');
      const trimmed = entry.trim();
      if (trimmed !== '') identifiers.push(trimmed);
    }
  } else if (typeof obj.identifiers === 'string') {
    // 模型经常把单个标识直接写成字符串。接受它比报错更有用
    const trimmed = obj.identifiers.trim();
    if (trimmed !== '') identifiers.push(trimmed);
  }
  if (identifiers.length > 50) throw new Error('一次最多解析 50 个标识');

  const num = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) return parsed;
    }
    throw new Error(`${name} 必须是整数`);
  };

  const text = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    action,
    ...(identifiers.length === 0 ? {} : { identifiers }),
    ...(text(obj.query, 'query') === undefined
      ? {}
      : { query: text(obj.query, 'query') as string }),
    ...(text(obj.author, 'author') === undefined
      ? {}
      : { author: text(obj.author, 'author') as string }),
    ...(num(obj.year, 'year') === undefined ? {} : { year: num(obj.year, 'year') as number }),
    ...(text(obj.refId, 'refId') === undefined
      ? {}
      : { refId: text(obj.refId, 'refId') as string }),
    ...(text(obj.keepId, 'keepId') === undefined
      ? {}
      : { keepId: text(obj.keepId, 'keepId') as string }),
    ...(text(obj.dropId, 'dropId') === undefined
      ? {}
      : { dropId: text(obj.dropId, 'dropId') as string }),
    ...(num(obj.limit, 'limit') === undefined ? {} : { limit: num(obj.limit, 'limit') as number }),
    ...(obj.refresh === undefined ? {} : { refresh: obj.refresh === true }),
    ...(obj.force === undefined ? {} : { force: obj.force === true }),
    ...(refIds.length === 0 ? {} : { refIds }),
    ...(format === undefined ? {} : { format }),
    ...(text(obj.stem, 'stem') === undefined ? {} : { stem: text(obj.stem, 'stem') as string }),
    ...(obj.asciiOnly === undefined ? {} : { asciiOnly: obj.asciiOnly === true }),
  };
}

/** 逐源尝试的渲染。失败的也要列出来（需求 12.6 的精神同样适用于元数据解析）。 */
function renderAttempts(
  attempts: readonly { source: RefSourceId; ok: boolean; reason: string | null }[],
): string[] {
  if (attempts.length === 0) return [];
  const lines = ['', '各上游结果：'];
  for (const attempt of attempts) {
    lines.push(
      `- ${SOURCE_LABEL[attempt.source] ?? attempt.source}：${attempt.ok ? '成功' : (attempt.reason ?? '失败')}`,
    );
  }
  return lines;
}

export function createManageReferencesTool(options: RefToolOptions): ToolDefinition<RefToolInput> {
  return {
    name: 'manage_references',
    description:
      '文献库：解析 DOI/PMID/arXiv 元数据、检索上游、去重入库、查看与合并。\n' +
      '导出 BibTeX / CSL-JSON / RIS（三种格式的引用键一致）。\n' +
      '元数据同时取自 Crossref、OpenAlex、Semantic Scholar、PubMed、Europe PMC 与 DataCite ' +
      '并合并，因此比任何单一来源完整。入库时按 DOI 精确匹配与标题模糊匹配去重；' +
      '两个不同 DOI 但标题几乎相同的条目（preprint 与正式版）会被报告为可疑重复但**不自动合并**。\n' +
      '只有标题时必须先 search 再按候选的 DOI resolve。凭记忆写 DOI 会解析出另一篇文献。',
    inputSchema: SCHEMA as unknown as Record<string, unknown>,
    parseInput,
    execute: async (input, ctx): Promise<ToolResult> => {
      const library = options.library();

      switch (input.action) {
        case 'resolve': {
          const identifiers = input.identifiers ?? [];
          if (identifiers.length === 0) {
            return {
              ok: false,
              output: errorOutput(
                'MissingIdentifiers',
                'action=resolve 需要 identifiers。只知道标题的话先用 action=search。',
              ),
            };
          }

          const result = await library.addMany(identifiers, {
            source: null,
            ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          });

          const lines: string[] = [
            `解析 ${String(identifiers.length)} 个标识：新增 ${String(result.created)}、` +
              `已有 ${String(result.duplicates)}、失败 ${String(result.failed)}`,
            '',
          ];

          for (const outcome of result.outcomes) {
            if (!outcome.ok || outcome.ref === null) {
              lines.push(`✗ ${outcome.input}`);
              lines.push(`  ${outcome.reason ?? '未知原因'}`);
              // 失败时把逐源结果也给出来：模型据此判断是「这条不存在」还是
              // 「网络不通」，两者的下一步完全不同
              for (const line of renderAttempts(outcome.attempts)) lines.push(`  ${line.trim()}`);
              continue;
            }

            const mark = outcome.created ? '＋' : outcome.enriched ? '↑' : '＝';
            lines.push(`${mark} ${outcome.ref.id}　${citeLine(outcome.ref.csl)}`);
            if (outcome.reason !== null && !outcome.created) lines.push(`  ${outcome.reason}`);
            if (outcome.ref.csl.extra?.retracted === true) {
              lines.push('  ⚠ 该文献已被撤稿（OpenAlex 标记）。引用它需要明确说明理由。');
            }
            for (const suspect of outcome.suspects.slice(0, 3)) {
              lines.push(`  ？可能与 ${suspect.refId} 重复：${suspect.reason}`);
            }
          }

          const changedIds = result.outcomes
            .map((o) => o.ref?.id)
            .filter((id): id is string => id !== undefined);
          if (changedIds.length > 0) options.onChanged?.({ action: 'resolve', refIds: changedIds });

          return {
            ok: result.created + result.duplicates > 0,
            output: textOutput(lines.join('\n')),
          };
        }

        case 'search': {
          if (input.query === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingQuery', 'action=search 需要 query（标题或书目信息）。'),
            };
          }

          const result = await library.search(
            {
              text: input.query,
              ...(input.author === undefined ? {} : { author: input.author }),
              ...(input.year === undefined ? {} : { year: input.year }),
              rows: Math.min(input.limit ?? 5, 20),
            },
            { http: ctx.signal === undefined ? {} : { signal: ctx.signal } },
          );

          if (!result.ok) {
            return {
              ok: false,
              output: errorOutput('SearchFailed', result.reason ?? '检索失败'),
            };
          }

          if (result.candidates.length === 0) {
            return {
              ok: true,
              output: textOutput(
                `在 ${String(result.attempts.filter((a) => a.ok).length)} 家上游都没有找到「${input.query}」。\n` +
                  '这可能意味着：标题记错了、这篇文献不存在、或者它不在这些数据库的收录范围内' +
                  '（例如中文期刊、专著章节）。\n' +
                  '**不要**据此构造一条文献记录——找不到就是找不到。' +
                  [...renderAttempts(result.attempts)].join('\n'),
              ),
            };
          }

          const lines = [`找到 ${String(result.candidates.length)} 个候选（未入库）：`, ''];
          for (const [index, candidate] of result.candidates.entries()) {
            const doi = candidate.item.DOI ?? '（无 DOI）';
            lines.push(`${String(index + 1)}. ${candidate.cite}`);
            lines.push(
              `   来源 ${SOURCE_LABEL[candidate.source] ?? candidate.source}　DOI ${doi}` +
                (candidate.inLibraryRefId === null
                  ? ''
                  : `　**已在库中**（${candidate.inLibraryRefId}）`),
            );
            if (candidate.item.extra?.retracted === true) {
              lines.push('   ⚠ 已撤稿');
            }
          }
          lines.push('');
          lines.push(
            '确认是哪一篇之后，用 action=resolve 加上它的 DOI 入库。' +
              '不要直接把上面的信息当成已入库的文献引用。',
          );

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'list': {
          const refs = library.repo.list({
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.year === undefined ? {} : { year: input.year }),
            limit: Math.min(input.limit ?? 25, 50),
          });
          const stats = library.repo.stats();

          if (refs.length === 0) {
            return {
              ok: true,
              output: textOutput(
                stats.total === 0
                  ? '文献库还是空的。粘贴 DOI（10.xxxx/…）或论文标题即可入库。'
                  : `库里有 ${String(stats.total)} 条文献，但没有符合当前筛选条件的。`,
              ),
            };
          }

          const lines = [
            `文献库共 ${String(stats.total)} 条（${String(stats.withFulltext)} 条已有全文），` +
              `以下 ${String(refs.length)} 条：`,
            '',
          ];
          for (const ref of refs) {
            lines.push(
              `- ${ref.id}　${citeLine(ref.csl)}` +
                (ref.fulltextArtifactId === null ? '' : '　[有全文]'),
            );
          }
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'get': {
          if (input.refId === undefined) {
            return { ok: false, output: errorOutput('MissingRefId', 'action=get 需要 refId。') };
          }
          const ref = library.repo.get(input.refId);
          if (ref === null) {
            return {
              ok: false,
              output: errorOutput('RefNotFound', `文献不存在：${input.refId}`),
            };
          }

          const lines = [
            citeLine(ref.csl),
            '',
            `id：${ref.id}`,
            `类型：${ref.type ?? '未知'}`,
            `元数据来源：${ref.source ?? '未记录'}`,
            `开放获取：${ref.oaStatus ?? '未知'}`,
            `全文制品：${ref.fulltextArtifactId ?? '未抓取'}`,
          ];
          if (ref.aliases.length > 0) {
            lines.push(`标识：${ref.aliases.map((a) => `${a.scheme}=${a.value}`).join('　')}`);
          }
          if (ref.csl.extra?.retracted === true) {
            lines.push('⚠ 已撤稿。');
          }
          if (typeof ref.csl.abstract === 'string') {
            lines.push('', '摘要：', ref.csl.abstract);
          }
          if (typeof ref.csl.extra?.tldr === 'string') {
            lines.push(
              '',
              `一句话总结（Semantic Scholar 模型生成，非作者原文）：${ref.csl.extra.tldr}`,
            );
          }

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'remove': {
          if (input.refId === undefined) {
            return { ok: false, output: errorOutput('MissingRefId', 'action=remove 需要 refId。') };
          }
          const ref = library.repo.get(input.refId);
          if (ref === null) {
            return { ok: false, output: errorOutput('RefNotFound', `文献不存在：${input.refId}`) };
          }
          const removed = library.repo.delete(input.refId);
          if (removed) options.onChanged?.({ action: 'remove', refIds: [input.refId] });
          return {
            ok: removed,
            output: textOutput(
              removed ? `已删除：${citeLine(ref.csl)}` : `删除失败：${input.refId}`,
            ),
          };
        }

        case 'merge': {
          if (input.keepId === undefined || input.dropId === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingIds', 'action=merge 需要 keepId 与 dropId。'),
            };
          }
          const result = library.merge(input.keepId, input.dropId);
          if (!result.ok || result.ref === null) {
            return {
              ok: false,
              output: errorOutput('MergeFailed', result.reason ?? '合并失败'),
            };
          }
          options.onChanged?.({ action: 'merge', refIds: [input.keepId] });
          return {
            ok: true,
            output: textOutput(
              `已合并。保留：${citeLine(result.ref.csl)}\n` +
                `被并入那条的标识已记入别名，用旧 DOI 仍能查到这条记录。`,
            ),
          };
        }

        case 'fulltext': {
          if (input.refId === undefined) {
            return {
              ok: false,
              output: errorOutput(
                'MissingRefId',
                'action=fulltext 需要 refId。先用 action=list 或 resolve 拿到它。',
              ),
            };
          }

          const result = await library.fetchFulltext(input.refId, {
            ...(input.force === undefined ? {} : { force: input.force }),
          });

          if (!result.ok) {
            /*
             * 抓不到全文是**正常结果**而不是工具故障，因此用 text 而不是 error 返回：
             * 摘要里已经逐条说明试过哪些来源、各自为什么失败（需求 12.6），
             * 模型据此决定下一步（换来源、请用户手工下载、还是退回只用摘要）。
             * 报成 error 会让模型倾向于重试同一个调用，而重试不会改变结果。
             */
            return { ok: false, output: textOutput(result.summary) };
          }

          const lines = [
            `全文已抓到并绑定到 ${input.refId}。`,
            '',
            result.summary,
            '',
            `正文制品：${result.fulltextArtifactId ?? '?'}`,
          ];
          if (result.fulltextVersionId !== null) {
            lines.push(
              `执行期路径占位符：{{artifact:${result.fulltextVersionId}}}（在内核里会解析成真实文件路径）`,
            );
          }

          const figures = result.assets.filter((a) => a.kind === 'figure');
          if (figures.length > 0) {
            lines.push('', `随文插图 ${String(figures.length)} 张：`);
            for (const figure of figures.slice(0, 20)) {
              lines.push(
                `- ${figure.label ?? figure.originPath ?? figure.id}　${(figure.caption ?? '').slice(0, 80)}` +
                  `　{{artifact:${figure.versionId}}}`,
              );
            }
          }
          const supplements = result.assets.filter((a) => a.kind === 'supplement');
          if (supplements.length > 0) {
            lines.push('', `补充材料 ${String(supplements.length)} 份：`);
            for (const item of supplements.slice(0, 10)) {
              lines.push(
                `- ${item.label ?? item.originPath ?? item.id}　{{artifact:${item.versionId}}}`,
              );
            }
          }

          options.onChanged?.({ action: 'fulltext', refIds: [input.refId] });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'assets': {
          if (input.refId === undefined) {
            return { ok: false, output: errorOutput('MissingRefId', 'action=assets 需要 refId。') };
          }
          const ref = library.repo.get(input.refId);
          if (ref === null) {
            return { ok: false, output: errorOutput('RefNotFound', `文献不存在：${input.refId}`) };
          }

          const assets = library.repo.assets(input.refId);
          const attempts = library.repo.fetchAttempts(input.refId, 20);

          const lines = [citeLine(ref.csl), ''];

          if (assets.length === 0) {
            lines.push('还没有抓到任何全文或随文资源。');
          } else {
            for (const asset of assets) {
              lines.push(
                `- [${asset.kind}] ${asset.label ?? asset.originPath ?? '(无标签)'}　` +
                  `{{artifact:${asset.versionId}}}` +
                  (asset.caption === null ? '' : `　${asset.caption.slice(0, 80)}`),
              );
            }
          }

          /*
           * 抓取尝试历史一并给出（需求 12.6）。
           *
           * 即便这次没抓，模型也要能看到「上次试过什么」，否则它会重复一遍已知
           * 会失败的来源，然后得出同样的结论。
           */
          if (attempts.length > 0) {
            lines.push('', '抓取历史（最近在前）：');
            for (const attempt of attempts) {
              lines.push(
                `- ${attempt.source}　${attempt.outcome}` +
                  (attempt.detail === null ? '' : `　${attempt.detail.split('\n')[0] ?? ''}`),
              );
            }
          }

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'export': {
          if (input.format === undefined) {
            return {
              ok: false,
              output: errorOutput(
                'MissingFormat',
                'action=export 需要 format：bibtex（LaTeX）、csl-json（pandoc/Word）或 ris（EndNote/投稿系统）。',
              ),
            };
          }

          const outcome = library.exportRefs({
            format: input.format,
            ...(input.refIds === undefined ? {} : { refIds: input.refIds }),
            ...(input.refIds !== undefined
              ? {}
              : {
                  filter: {
                    ...(input.query === undefined ? {} : { query: input.query }),
                    ...(input.year === undefined ? {} : { year: input.year }),
                  },
                }),
            ...(input.stem === undefined ? {} : { stem: input.stem }),
            ...(input.asciiOnly === undefined ? {} : { asciiOnly: input.asciiOnly }),
          });

          if (!outcome.ok || outcome.result === null) {
            return {
              ok: false,
              output: errorOutput('ExportFailed', outcome.reason ?? '导出失败'),
            };
          }

          const lines = [
            `已导出 ${String(outcome.result.entryCount)} 条为 ${EXPORT_FORMAT_LABEL[input.format]}。`,
            `文件：${outcome.result.filename}`,
          ];
          if (outcome.artifactId !== null) {
            lines.push(`制品：${outcome.artifactId}`);
            lines.push(`执行期路径占位符：{{artifact:${outcome.versionId ?? ''}}}`);
          } else if (outcome.reason !== null) {
            lines.push(outcome.reason);
          }
          if (outcome.missingIds.length > 0) {
            // 请求了但不存在的 id 必须报出来：静默少几条会让手稿里的引用编译不过
            lines.push(
              '',
              `以下 ${String(outcome.missingIds.length)} 个 id 在库里不存在，未包含在导出里：` +
                outcome.missingIds.join('、'),
            );
          }

          lines.push('', '引用键（正文里就用这些）：');
          lines.push(outcome.result.keys.slice(0, 60).join('、'));
          if (outcome.result.keys.length > 60) {
            lines.push(`… 共 ${String(outcome.result.keys.length)} 个`);
          }

          const warningText = renderExportWarnings(outcome.result.warnings);
          if (warningText !== '') {
            lines.push('', warningText);
            lines.push(
              '',
              '这些问题不影响文件生成，但会让引用输出出错或不合规。' +
                '用 action=resolve 加 refresh 重新解析元数据通常能补上缺失字段。',
            );
          }

          options.onChanged?.({ action: 'export', refIds: [] });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        default:
          return {
            ok: false,
            output: errorOutput('UnknownAction', `未知 action：${String(input.action)}`),
          };
      }
    },
  };
}
