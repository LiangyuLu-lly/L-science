/**
 * `verify_citations` 工具（任务 13.5，需求 13.9）。
 *
 * 这个工具的形状本身就是需求 13.9 的实现方式，因此值得说清楚它**没有**什么：
 *
 * 它没有一个让模型写入核实结论的参数。模型能传进来的只有「要核实哪些引文」，
 * 检索、比对、判定全部在后端完成，结论直接落库。因此「凭记忆作答」在这条路径上
 * 不是被禁止，而是做不到——模型手里没有那个按钮。
 *
 * 与之配套的是 `manage_claims` 的 verify：对引文支撑陈述，它拒绝一个没有检索记录
 * 支撑的 `supports` 结论，并指回这个工具。两处合起来才封住这条要求；只有其中
 * 任一处的话，模型可以绕开工具直接给断言记一个「已支持」。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ClaimLedger } from './ledger.js';
import { parseReferenceList } from './citations.js';
import type { CitationVerifier } from './verify.js';
import { renderVerifyResults } from './verify.js';

export interface VerifyCitationsOptions {
  verifier: () => CitationVerifier;
  ledger: () => ClaimLedger;
  /** 读一份制品版本的文本内容。用于直接核实一个参考文献列表制品。 */
  readVersion?: (versionId: string) => string | null;
  onChecked?: (info: {
    conversationId: string;
    checked: number;
    notFound: number;
    mismatched: number;
  }) => void;
}

export interface VerifyCitationsInput {
  citations?: readonly string[];
  referenceList?: string;
  artifactVersionId?: string;
  claimId?: string;
  /** 只核实这条断言里出现的引文（从断言文本里抽引用标记与书目串）。 */
  fromClaim?: boolean;
}

const SCHEMA = {
  type: 'object',
  properties: {
    citations: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 100,
      description:
        '要核实的引文。每一项可以是完整的参考文献条目、DOI、PMID、arXiv 编号、' +
        '作者年份引用（如 `(Smith et al., 2023)`），或一个标题。\n' +
        '**不要**传纯引用标记（`[12]`、`\\cite{key}`）：它们不含书目信息，' +
        '必须先在参考文献列表里找到对应条目。',
    },
    referenceList: {
      type: 'string',
      description:
        '整份参考文献列表的原文。会逐条解析并核实。带序号（1. / [1] / (1)）的列表' +
        '按序号切分，不带序号的按行切分。',
    },
    artifactVersionId: {
      type: 'string',
      description:
        '直接核实某个制品里的参考文献列表（用 save_artifacts 返回的 av_… 版本 id）。' +
        '比把整份列表贴进参数里省上下文。',
    },
    claimId: {
      type: 'string',
      description:
        '把核实记录挂到这条断言上。引文支撑陈述要记 supports 结论之前，' +
        '必须先在这里核实过一次——那是需求 13.9 的硬约束。',
    },
    fromClaim: {
      type: 'boolean',
      description:
        '为真时从 claimId 指向的断言文本里抽出引文来核实。断言里只有 `[12]` 这类' +
        '纯标记时会明确告诉你无法核实，而不是拿标记去检索。',
    },
  },
  additionalProperties: false,
} as const;

function parseInput(raw: unknown): VerifyCitationsInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
  const obj = raw as Record<string, unknown>;

  const citations: string[] = [];
  if (Array.isArray(obj.citations)) {
    for (const entry of obj.citations) {
      if (typeof entry !== 'string') throw new Error('citations 的每一项必须是字符串');
      const trimmed = entry.trim();
      if (trimmed !== '') citations.push(trimmed.slice(0, 2000));
    }
  } else if (typeof obj.citations === 'string') {
    // 单条时模型常直接写字符串
    const trimmed = obj.citations.trim();
    if (trimmed !== '') citations.push(trimmed.slice(0, 2000));
  }
  if (citations.length > 100) throw new Error('一次最多核实 100 条引文');

  const text = (value: unknown, name: string, max: number): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.length > max) throw new Error(`${name} 超过 ${String(max)} 字符上限`);
    return trimmed;
  };

  return {
    ...(citations.length === 0 ? {} : { citations }),
    ...(text(obj.referenceList, 'referenceList', 200_000) === undefined
      ? {}
      : { referenceList: text(obj.referenceList, 'referenceList', 200_000) as string }),
    ...(text(obj.artifactVersionId, 'artifactVersionId', 200) === undefined
      ? {}
      : { artifactVersionId: text(obj.artifactVersionId, 'artifactVersionId', 200) as string }),
    ...(text(obj.claimId, 'claimId', 200) === undefined
      ? {}
      : { claimId: text(obj.claimId, 'claimId', 200) as string }),
    ...(obj.fromClaim === undefined ? {} : { fromClaim: obj.fromClaim === true }),
  };
}

/**
 * 从断言文本里抽出可核实的引文。
 *
 * 断言里的引用几乎总是标记形态（`[12]`、`(Smith et al., 2023)`）。前者不可核实
 * 并会被如实告知；后者可以。这个函数不猜——抽不到就返回空数组，让调用方说清原因。
 */
function citationsFromClaimText(text: string): readonly string[] {
  const out: string[] = [];

  for (const match of text.matchAll(
    /\(\s*[A-Z][A-Za-z'’.&-]{1,}[^)]{0,60}?(?:19|20)\d{2}[a-z]?[^)]{0,50}\)/gu,
  )) {
    out.push(match[0]);
  }
  // 内嵌的 DOI 也可以直接核实
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>,;)]+/gu)) {
    out.push(match[0]);
  }
  for (const match of text.matchAll(/\bPMID\s*[:：]?\s*\d{5,9}\b/giu)) {
    out.push(match[0]);
  }

  return [...new Set(out)];
}

export function createVerifyCitationsTool(
  options: VerifyCitationsOptions,
): ToolDefinition<VerifyCitationsInput> {
  return {
    name: 'verify_citations',
    description:
      '核实引文是否真实存在，并比对引文里写的作者、年份、标题与上游记录是否一致。\n' +
      '**检索由系统执行，不是由你回答。** 每一条都会真的去 Crossref、OpenAlex、' +
      'Semantic Scholar、Europe PMC 查一遍，结论与检索记录一起落库。\n' +
      '结论分五档：已核实 / 标识命中但字段不符（复制错行）/ 检索不到（可能是编造的引文）/ ' +
      '多个候选无法确定 / 未能核实（查不了，不等于不存在）。\n' +
      '引文支撑陈述要在 Claim Ledger 里记 supports 结论之前，必须先经这个工具核实——' +
      '没有检索记录的「支持」会被拒绝。',
    inputSchema: SCHEMA as unknown as Record<string, unknown>,
    parseInput,
    execute: async (input, ctx): Promise<ToolResult> => {
      const verifier = options.verifier();
      const ledger = options.ledger();

      /* ---------------- 收集要核实的引文 ---------------- */

      const targets: string[] = [...(input.citations ?? [])];
      const notes: string[] = [];

      if (input.artifactVersionId !== undefined) {
        const read = options.readVersion;
        if (read === undefined) {
          return {
            ok: false,
            output: errorOutput(
              'CannotReadArtifact',
              '这个实例不能直接读制品，请把参考文献列表放在 referenceList 参数里。',
            ),
          };
        }
        const content = read(input.artifactVersionId);
        if (content === null) {
          return {
            ok: false,
            output: errorOutput(
              'ArtifactNotFound',
              `读不到制品版本 ${input.artifactVersionId}。用 save_artifacts 的返回值，不要凭记忆写 id。`,
            ),
          };
        }
        const parsed = parseReferenceList(content);
        targets.push(...parsed.map((p) => p.raw));
        notes.push(`从制品里解析出 ${String(parsed.length)} 条参考文献。`);
      }

      if (input.referenceList !== undefined) {
        const parsed = parseReferenceList(input.referenceList);
        targets.push(...parsed.map((p) => p.raw));
        notes.push(`从参考文献列表里解析出 ${String(parsed.length)} 条。`);
      }

      if (input.fromClaim === true) {
        if (input.claimId === undefined) {
          return {
            ok: false,
            output: errorOutput('MissingClaimId', 'fromClaim 需要同时给 claimId。'),
          };
        }
        const claim = ledger.repo.get(input.claimId);
        if (claim === null) {
          return {
            ok: false,
            output: errorOutput('ClaimNotFound', `断言不存在：${input.claimId}`),
          };
        }
        const found = citationsFromClaimText(claim.text);
        if (found.length === 0) {
          /*
           * 断言里只有 `[12]` 这类纯标记时明确说不可核实。
           *
           * 拿标记去检索会返回一堆无关文献，而其中最相似的那条会被判成命中——
           * 于是一条编造的引文被「核实」通过了。这是这套机制最坏的失败形式，
           * 因此宁可什么都不做。
           */
          return {
            ok: false,
            output: textOutput(
              `断言 ${input.claimId} 里没有可核实的书目信息。\n` +
                `原文：${claim.text.slice(0, 300)}\n\n` +
                '它引用的可能是 `[12]` 这类纯数字标记，那不含任何书目信息。' +
                '先在参考文献列表里找到 12 号对应的条目，再把那个条目传进 citations 核实。\n' +
                '**不要**把标记本身当标题去检索——那会返回一堆无关文献，' +
                '而其中最相似的一条会被误判成命中。',
            ),
          };
        }
        targets.push(...found);
        notes.push(`从断言文本里抽出 ${String(found.length)} 条引用。`);
      }

      const unique = [...new Set(targets.map((t) => t.replace(/\s+/gu, ' ').trim()))].filter(
        (t) => t !== '',
      );

      if (unique.length === 0) {
        return {
          ok: false,
          output: errorOutput(
            'NothingToVerify',
            '没有要核实的引文。传 citations（数组）、referenceList（整份列表原文）、' +
              'artifactVersionId（列表所在制品），或 claimId + fromClaim。',
          ),
        };
      }
      if (unique.length > 100) {
        return {
          ok: false,
          output: errorOutput(
            'TooMany',
            `一次最多核实 100 条，收到 ${String(unique.length)} 条。分批进行。`,
          ),
        };
      }

      /* ---------------- 核实 ---------------- */

      const outcome = await verifier.verifyMany(unique, {
        ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
        // 发起者标识由编排层给，模型改不了（需求 13.4 同理）
        modelId: ctx.modelId ?? 'unknown-model',
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });

      const lines = [...notes];
      if (lines.length > 0) lines.push('');
      lines.push(renderVerifyResults(outcome.results, outcome.counts));

      if (input.claimId !== undefined) {
        const backed = ledger.repo.hasRetrievalBackedCheck(input.claimId);
        lines.push('');
        lines.push(
          backed
            ? `核实记录已挂到断言 ${input.claimId} 上。现在可以用 manage_claims 的 verify ` +
                '记录这条证据的结论了。'
            : `注意：这次核实没有产生可用于断言 ${input.claimId} 的检索记录` +
                '（全部结果都是「未能核实」）。在这种状态下 manage_claims 的 verify 仍会' +
                '拒绝一个 supports 结论——这是刻意的，未经检索的核实不算核实。',
        );
      }

      options.onChecked?.({
        conversationId: ctx.conversationId,
        checked: outcome.results.length,
        notFound: outcome.counts['not-found'],
        mismatched: outcome.counts['metadata-mismatch'],
      });

      /*
       * `ok` 反映的是「核实这件事有没有做成」，而不是「引文有没有问题」。
       *
       * 查出一条编造的引文是一次**成功**的核实。把它报成 ok:false 会让模型倾向于
       * 重试同一次调用，而重试不会改变结果——那条引文仍然不存在。
       *
       * 只有一种情况算失败：一条都没能真的查（全部 unverifiable），因为那时
       * 用户什么也没得到。
       */
      const allUnverifiable = outcome.counts.unverifiable === outcome.results.length;
      return { ok: !allUnverifiable, output: textOutput(lines.join('\n')) };
    },
  };
}
