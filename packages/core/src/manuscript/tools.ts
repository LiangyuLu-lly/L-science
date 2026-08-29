/**
 * `manage_claims` 工具（任务 13.4，需求 13.1-13.4）。
 *
 * 工具描述里写死了一条纪律：**不要凭记忆写证据 id**。这是 Claim Ledger 最容易
 * 被绕过的地方——模型可以给出一个格式完美但不存在的制品版本 id，那条断言于是
 * 在计数上「有证据」而实际无从核对，FAIL 检查放过它。绑定时会校验存在性并报错，
 * 但把这条纪律写在描述里能让模型少走一次错路。
 */

import { errorOutput, textOutput } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ClaimEvidenceKind, ClaimVerdict } from '../repo/claims.js';
import { CLAIM_STATUS_LABEL, EVIDENCE_KIND_LABEL, VERDICT_LABEL } from '../repo/claims.js';
import type { ClaimKind } from './extract.js';
import { CLAIM_KIND_LABEL } from './extract.js';
import type { ClaimLedger } from './ledger.js';

export interface ClaimToolOptions {
  ledger: () => ClaimLedger;
  /** 读一份制品版本的文本内容。用于 extract 直接吃手稿制品。 */
  readVersion?: (versionId: string) => string | null;
  onChanged?: (info: {
    action: string;
    claimIds: readonly string[];
    conversationId: string;
  }) => void;
}

export type ClaimAction =
  | 'extract'
  | 'register'
  | 'list'
  | 'get'
  | 'bind'
  | 'unbind'
  | 'verify'
  | 'confirm'
  | 'close'
  | 'reopen'
  | 'summary';

export interface ClaimToolInput {
  action: ClaimAction;
  text?: string;
  markdown?: string;
  artifactVersionId?: string;
  claimId?: string;
  manuscriptId?: string;
  evidenceKind?: ClaimEvidenceKind;
  evidenceRef?: string;
  locator?: string;
  quote?: string;
  note?: string;
  verdict?: ClaimVerdict;
  status?: 'retracted' | 'dismissed';
  kind?: ClaimKind;
  unsupportedOnly?: boolean;
  limit?: number;
}

const EVIDENCE_KINDS: readonly ClaimEvidenceKind[] = [
  'artifact-version',
  'ref',
  'doi',
  'compute',
  'quote',
  'message',
];

const VERDICTS: readonly ClaimVerdict[] = ['supports', 'contradicts', 'insufficient', 'unrelated'];

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'extract',
        'register',
        'list',
        'get',
        'bind',
        'unbind',
        'verify',
        'confirm',
        'close',
        'reopen',
        'summary',
      ],
      description:
        'extract：从手稿里批量抽取可核查断言（数值结论、比较陈述、因果陈述、引文支撑陈述）。' +
        'register：登记单条断言。list / get：查看。' +
        'bind：给断言绑证据。verify：记录某条证据的核验结论。' +
        'confirm：确认一条自动抽取的断言（确认后无证据会开 FAIL 级发现）。' +
        'close：撤回或判为无需核验。reopen：重新打开。summary：看整体状态。\n' +
        '典型顺序：extract → 逐条 confirm 或 close → bind 证据 → verify 结论。',
    },
    text: { type: 'string', description: 'action=register 时的断言原文（一句可核查的陈述）。' },
    markdown: {
      type: 'string',
      description: 'action=extract 时的手稿正文（Markdown）。与 artifactVersionId 二选一。',
    },
    artifactVersionId: {
      type: 'string',
      description: 'action=extract 时直接读某个制品版本作为手稿。比把整篇手稿贴进参数里省上下文。',
    },
    claimId: { type: 'string', description: '断言 id（形如 cl_…）。' },
    manuscriptId: { type: 'string', description: '所属手稿 id。省略时断言不挂到任何手稿上。' },
    evidenceKind: {
      type: 'string',
      enum: EVIDENCE_KINDS,
      description:
        'artifact-version：分析输出的制品版本（ref 用 save_artifacts 返回的 av_… id）。' +
        'ref：文献库条目（rf_… id）。doi：裸 DOI（弱证据，建议先入库改用 ref）。' +
        'compute：可复现的计算单元（工具调用 id 或带代码的制品版本）。' +
        'quote：文献或制品里的一段原文（ref 指向来源，原文放 quote 字段）。' +
        'message：会话消息（最弱，只用于追溯）。',
    },
    evidenceRef: {
      type: 'string',
      description:
        '证据指向的 id 或 DOI。**必须是真实存在的**——绑定时会校验，' +
        '凭记忆写的 id 会被拒绝。制品版本 id 用 save_artifacts 的返回值，' +
        '文献 id 用 manage_references 的返回值。',
    },
    locator: {
      type: 'string',
      description: '在证据内部的位置：页码、表格单元、行号区间。缺了它核验结论无法被复核。',
    },
    quote: { type: 'string', description: 'evidenceKind=quote 时支持该断言的原文片段。' },
    note: { type: 'string', description: '说明。close / reopen 时必填。' },
    verdict: {
      type: 'string',
      enum: VERDICTS,
      description:
        'supports：证据支持该断言。contradicts：证据与断言矛盾（**一条矛盾压倒任意多条支持**）。' +
        'insufficient：相关但不足以支持。unrelated：与该断言无关。',
    },
    status: {
      type: 'string',
      enum: ['retracted', 'dismissed'],
      description:
        'action=close 时：retracted 表示这句话已从手稿里删掉；dismissed 表示它不需要核验' +
        '（例如它其实是背景陈述而不是本文结论）。',
    },
    kind: {
      type: 'string',
      enum: ['numeric', 'comparison', 'causal', 'citation', 'other'],
      description:
        '断言类型。通常不用给——自动判定比人选准。只在自动判定为 other 而你确知类型时才覆盖。',
    },
    unsupportedOnly: {
      type: 'boolean',
      description: 'action=list 时只列没有任何证据的断言。',
    },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限。' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

function parseInput(raw: unknown): ClaimToolInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
  const obj = raw as Record<string, unknown>;

  const actions: readonly ClaimAction[] = [
    'extract',
    'register',
    'list',
    'get',
    'bind',
    'unbind',
    'verify',
    'confirm',
    'close',
    'reopen',
    'summary',
  ];
  const action = obj.action;
  if (typeof action !== 'string' || !(actions as readonly string[]).includes(action)) {
    throw new Error(`action 必须是 ${actions.join('/')} 之一，收到 ${String(action)}`);
  }

  const text = (value: unknown, name: string, max = 20_000): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.length > max) throw new Error(`${name} 超过 ${String(max)} 字符上限`);
    return trimmed;
  };

  const evidenceKind = obj.evidenceKind;
  if (
    evidenceKind !== undefined &&
    (typeof evidenceKind !== 'string' ||
      !(EVIDENCE_KINDS as readonly string[]).includes(evidenceKind))
  ) {
    throw new Error(`evidenceKind 必须是 ${EVIDENCE_KINDS.join('/')} 之一`);
  }

  const verdict = obj.verdict;
  if (
    verdict !== undefined &&
    (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict))
  ) {
    throw new Error(`verdict 必须是 ${VERDICTS.join('/')} 之一`);
  }

  const status = obj.status;
  if (status !== undefined && status !== 'retracted' && status !== 'dismissed') {
    throw new Error('status 必须是 retracted 或 dismissed');
  }

  const kind = obj.kind;
  const kinds: readonly string[] = ['numeric', 'comparison', 'causal', 'citation', 'other'];
  if (kind !== undefined && (typeof kind !== 'string' || !kinds.includes(kind))) {
    throw new Error(`kind 必须是 ${kinds.join('/')} 之一`);
  }

  let limit: number | undefined;
  if (obj.limit !== undefined && obj.limit !== null) {
    const parsed =
      typeof obj.limit === 'number' ? obj.limit : Number.parseInt(String(obj.limit), 10);
    if (!Number.isInteger(parsed)) throw new Error('limit 必须是整数');
    limit = Math.max(1, Math.min(parsed, 200));
  }

  return {
    action: action as ClaimAction,
    ...(text(obj.text, 'text', 4000) === undefined
      ? {}
      : { text: text(obj.text, 'text', 4000) as string }),
    ...(text(obj.markdown, 'markdown', 400_000) === undefined
      ? {}
      : { markdown: text(obj.markdown, 'markdown', 400_000) as string }),
    ...(text(obj.artifactVersionId, 'artifactVersionId', 200) === undefined
      ? {}
      : { artifactVersionId: text(obj.artifactVersionId, 'artifactVersionId', 200) as string }),
    ...(text(obj.claimId, 'claimId', 200) === undefined
      ? {}
      : { claimId: text(obj.claimId, 'claimId', 200) as string }),
    ...(text(obj.manuscriptId, 'manuscriptId', 200) === undefined
      ? {}
      : { manuscriptId: text(obj.manuscriptId, 'manuscriptId', 200) as string }),
    ...(evidenceKind === undefined ? {} : { evidenceKind: evidenceKind as ClaimEvidenceKind }),
    ...(text(obj.evidenceRef, 'evidenceRef', 500) === undefined
      ? {}
      : { evidenceRef: text(obj.evidenceRef, 'evidenceRef', 500) as string }),
    ...(text(obj.locator, 'locator', 500) === undefined
      ? {}
      : { locator: text(obj.locator, 'locator', 500) as string }),
    ...(text(obj.quote, 'quote', 4000) === undefined
      ? {}
      : { quote: text(obj.quote, 'quote', 4000) as string }),
    ...(text(obj.note, 'note', 2000) === undefined
      ? {}
      : { note: text(obj.note, 'note', 2000) as string }),
    ...(verdict === undefined ? {} : { verdict: verdict as ClaimVerdict }),
    ...(status === undefined ? {} : { status: status as 'retracted' | 'dismissed' }),
    ...(kind === undefined ? {} : { kind: kind as ClaimKind }),
    ...(obj.unsupportedOnly === undefined ? {} : { unsupportedOnly: obj.unsupportedOnly === true }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function createManageClaimsTool(options: ClaimToolOptions): ToolDefinition<ClaimToolInput> {
  return {
    name: 'manage_claims',
    description:
      'Claim Ledger：登记手稿里的可核查断言，给每条断言绑定证据，记录核验结论。\n' +
      '断言分四类：数值结论、比较陈述、因果陈述、引文支撑陈述。' +
      '证据类型：制品版本（分析输出）、文献条目、DOI、可复现计算单元、原文引述。\n' +
      '**未关闭且无证据的断言会被审查开成 FAIL 级发现**，因此宣称手稿完成之前先看 summary。\n' +
      '证据的 id 必须是真实存在的——绑定时会校验，凭记忆写的会被拒绝。',
    inputSchema: SCHEMA as unknown as Record<string, unknown>,
    parseInput,
    execute: async (input, ctx): Promise<ToolResult> => {
      const ledger = options.ledger();

      switch (input.action) {
        case 'extract': {
          let markdown = input.markdown;
          if (markdown === undefined && input.artifactVersionId !== undefined) {
            const read = options.readVersion;
            if (read === undefined) {
              return {
                ok: false,
                output: errorOutput(
                  'CannotReadArtifact',
                  '这个实例不能直接读制品，请把手稿正文放在 markdown 参数里。',
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
            markdown = content;
          }

          if (markdown === undefined) {
            return {
              ok: false,
              output: errorOutput(
                'MissingManuscript',
                'action=extract 需要 markdown 或 artifactVersionId。',
              ),
            };
          }

          const result = ledger.extractAndRegister({
            markdown,
            conversationId: ctx.conversationId,
            ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
            ...(input.limit === undefined ? {} : { options: { limit: input.limit } }),
          });

          const lines = [result.summary];
          if (result.created.length > 0) {
            lines.push(
              '',
              '新登记的断言：',
              ledger.render(result.created, { showEvidence: false }),
            );
          }
          if (result.extraction.skipped.length > 0) {
            // 说明哪些句子被规则排除了：不说的话「为什么这句没抽到」无从判断
            lines.push(
              '',
              `另有 ${String(result.extraction.skipped.length)} 句被规则排除，例如：`,
              ...result.extraction.skipped
                .slice(0, 3)
                .map((s) => `  · ${s.reason}：${s.text.slice(0, 60)}`),
            );
          }

          options.onChanged?.({
            action: 'extract',
            claimIds: result.created.map((c) => c.id),
            conversationId: ctx.conversationId,
          });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'register': {
          if (input.text === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingText', 'action=register 需要 text（断言原文）。'),
            };
          }
          const result = ledger.register({
            text: input.text,
            conversationId: ctx.conversationId,
            origin: 'model',
            ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
            ...(input.locator === undefined ? {} : { locator: input.locator }),
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
          });

          if (!result.ok || result.claim === null) {
            return {
              ok: false,
              output: errorOutput('RegisterFailed', result.reason ?? '登记失败'),
            };
          }

          const claim = result.claim;
          const lines = [
            result.existing ? (result.reason ?? '已存在') : `已登记：${claim.id}`,
            `类型：${claim.kinds.map((k) => CLAIM_KIND_LABEL[k]).join('、')}`,
          ];
          if (claim.numbers.length > 0) {
            lines.push(`识别到的数值：${claim.numbers.join('、')}`);
          }
          lines.push('', '现在给它绑证据（action=bind）。无证据的断言会被审查开成 FAIL 级发现。');

          options.onChanged?.({
            action: 'register',
            claimIds: [claim.id],
            conversationId: ctx.conversationId,
          });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'list': {
          const claims = ledger.repo.list({
            conversationId: ctx.conversationId,
            ...(input.manuscriptId === undefined ? {} : { manuscriptId: input.manuscriptId }),
            ...(input.unsupportedOnly === undefined
              ? {}
              : { unsupportedOnly: input.unsupportedOnly }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            limit: input.limit ?? 30,
          });

          if (claims.length === 0) {
            return {
              ok: true,
              output: textOutput(
                ' 没有符合条件的断言。用 action=extract 从手稿里抽取，或用 register 登记单条。'.trim(),
              ),
            };
          }

          return {
            ok: true,
            output: textOutput(
              [
                ledger.gateSummary({ conversationId: ctx.conversationId }),
                '',
                ledger.render(claims, { limit: input.limit ?? 30 }),
              ].join('\n'),
            ),
          };
        }

        case 'get': {
          if (input.claimId === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingClaimId', 'action=get 需要 claimId。'),
            };
          }
          const claim = ledger.repo.get(input.claimId);
          if (claim === null) {
            return {
              ok: false,
              output: errorOutput('ClaimNotFound', `断言不存在：${input.claimId}`),
            };
          }

          const lines = [
            claim.text,
            '',
            `id：${claim.id}`,
            `类型：${claim.kinds.map((k) => CLAIM_KIND_LABEL[k]).join('、')}`,
            `状态：${CLAIM_STATUS_LABEL[claim.status]}`,
            `来源：${claim.origin === 'extracted' ? '自动抽取（未确认）' : claim.origin === 'user' ? '已确认' : '模型登记'}`,
            `定位：${claim.locator ?? '（无）'}`,
          ];
          if (claim.numbers.length > 0) lines.push(`数值：${claim.numbers.join('、')}`);
          if (claim.note !== null) lines.push(`说明：${claim.note}`);

          lines.push('', `证据（${String(claim.evidence.length)} 条）：`);
          if (claim.evidence.length === 0) {
            lines.push('  无。这条断言在审查里会被标为无证据。');
          } else {
            for (const evidence of claim.evidence) {
              lines.push(
                `  · ${EVIDENCE_KIND_LABEL[evidence.kind]} ${evidence.ref}` +
                  `${evidence.locator === null ? '' : ` @${evidence.locator}`}`,
              );
              lines.push(
                `    核验：${evidence.verdict === null ? '未核验' : `${VERDICT_LABEL[evidence.verdict]}（${evidence.verifiedByModelId ?? '未记录模型'}）`}`,
              );
              if (evidence.quote !== null) lines.push(`    原文：${evidence.quote.slice(0, 300)}`);
              if (evidence.note !== null) lines.push(`    说明：${evidence.note.slice(0, 300)}`);
            }
          }

          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'bind': {
          if (
            input.claimId === undefined ||
            input.evidenceKind === undefined ||
            input.evidenceRef === undefined
          ) {
            return {
              ok: false,
              output: errorOutput(
                'MissingArgs',
                'action=bind 需要 claimId、evidenceKind 与 evidenceRef。',
              ),
            };
          }

          const result = ledger.bind({
            claimId: input.claimId,
            kind: input.evidenceKind,
            ref: input.evidenceRef,
            ...(input.locator === undefined ? {} : { locator: input.locator }),
            ...(input.quote === undefined ? {} : { quote: input.quote }),
            ...(input.note === undefined ? {} : { note: input.note }),
          });

          if (!result.ok) {
            return { ok: false, output: errorOutput('BindFailed', result.reason ?? '绑定失败') };
          }

          const lines = [
            `已绑定：${EVIDENCE_KIND_LABEL[input.evidenceKind]} ${input.evidenceRef}`,
            '',
            '绑定不等于核验。用 action=verify 记录这条证据到底支持还是矛盾——' +
              '只有核验过的证据才会改变断言状态。',
          ];
          if (result.advice !== null) lines.push('', `建议：${result.advice}`);

          options.onChanged?.({
            action: 'bind',
            claimIds: [input.claimId],
            conversationId: ctx.conversationId,
          });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'unbind': {
          if (
            input.claimId === undefined ||
            input.evidenceKind === undefined ||
            input.evidenceRef === undefined
          ) {
            return {
              ok: false,
              output: errorOutput(
                'MissingArgs',
                'action=unbind 需要 claimId、evidenceKind 与 evidenceRef。',
              ),
            };
          }
          const result = ledger.unbind(input.claimId, input.evidenceKind, input.evidenceRef);
          if (!result.ok) {
            return { ok: false, output: errorOutput('UnbindFailed', result.reason ?? '解绑失败') };
          }
          options.onChanged?.({
            action: 'unbind',
            claimIds: [input.claimId],
            conversationId: ctx.conversationId,
          });
          return { ok: true, output: textOutput('已解绑，断言状态已按剩余证据重算。') };
        }

        case 'verify': {
          if (
            input.claimId === undefined ||
            input.evidenceKind === undefined ||
            input.evidenceRef === undefined ||
            input.verdict === undefined
          ) {
            return {
              ok: false,
              output: errorOutput(
                'MissingArgs',
                'action=verify 需要 claimId、evidenceKind、evidenceRef 与 verdict。',
              ),
            };
          }

          /*
           * 模型标识从执行上下文取，不让调用方填。
           *
           * 让模型自报「是谁核验的」等于让它可以写任何字符串，而这一列的用途正是
           * 事后判断结论的可信度（需求 13.4）。上下文里的模型 id 是编排层写的，
           * 模型改不了。
           */
          const modelId = ctx.modelId ?? 'unknown-model';
          const result = ledger.verify({
            claimId: input.claimId,
            kind: input.evidenceKind,
            ref: input.evidenceRef,
            verdict: input.verdict,
            modelId,
            ...(input.note === undefined ? {} : { note: input.note }),
          });

          if (!result.ok || result.claim === null) {
            return { ok: false, output: errorOutput('VerifyFailed', result.reason ?? '核验失败') };
          }

          const claim = result.claim;
          const lines = [
            `已记录核验结论：${VERDICT_LABEL[input.verdict]}（执行模型 ${modelId}）`,
            `断言状态现在是：${CLAIM_STATUS_LABEL[claim.status]}`,
          ];
          if (claim.status === 'refuted') {
            lines.push(
              '',
              '**证据与断言矛盾。** 一条矛盾压倒任意多条支持——要么某处算错了，' +
                '要么这句话的表述过强。手稿必须改，不能靠再补一条支持性证据盖过去。',
            );
          }
          if (claim.status === 'insufficient') {
            lines.push('', '证据不足以支持这条断言。补更直接的证据，或把断言改弱。');
          }

          options.onChanged?.({
            action: 'verify',
            claimIds: [claim.id],
            conversationId: ctx.conversationId,
          });
          return { ok: true, output: textOutput(lines.join('\n')) };
        }

        case 'confirm': {
          if (input.claimId === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingClaimId', 'action=confirm 需要 claimId。'),
            };
          }
          const result = ledger.confirm(input.claimId, input.note);
          if (!result.ok || result.claim === null) {
            return { ok: false, output: errorOutput('ConfirmFailed', result.reason ?? '确认失败') };
          }
          options.onChanged?.({
            action: 'confirm',
            claimIds: [input.claimId],
            conversationId: ctx.conversationId,
          });
          return {
            ok: true,
            output: textOutput(
              `已确认 ${input.claimId}。它现在与用户手写的断言同等对待：无证据时会开 FAIL 级发现。`,
            ),
          };
        }

        case 'close': {
          if (input.claimId === undefined || input.status === undefined) {
            return {
              ok: false,
              output: errorOutput(
                'MissingArgs',
                'action=close 需要 claimId 与 status（retracted 或 dismissed）。',
              ),
            };
          }
          const result = ledger.close(input.claimId, input.status, input.note ?? '');
          if (!result.ok) {
            return { ok: false, output: errorOutput('CloseFailed', result.reason ?? '关闭失败') };
          }
          options.onChanged?.({
            action: 'close',
            claimIds: [input.claimId],
            conversationId: ctx.conversationId,
          });
          return {
            ok: true,
            output: textOutput(
              `已关闭 ${input.claimId}（${input.status === 'retracted' ? '已从手稿撤回' : '判为无需核验'}）。`,
            ),
          };
        }

        case 'reopen': {
          if (input.claimId === undefined) {
            return {
              ok: false,
              output: errorOutput('MissingClaimId', 'action=reopen 需要 claimId。'),
            };
          }
          const result = ledger.reopen(input.claimId, input.note ?? '');
          if (!result.ok || result.claim === null) {
            return { ok: false, output: errorOutput('ReopenFailed', result.reason ?? '重开失败') };
          }
          options.onChanged?.({
            action: 'reopen',
            claimIds: [input.claimId],
            conversationId: ctx.conversationId,
          });
          return {
            ok: true,
            output: textOutput(
              `已重新打开 ${input.claimId}，状态 ${CLAIM_STATUS_LABEL[result.claim.status]}。` +
                '已有的核验结论保留——它们是历史。',
            ),
          };
        }

        case 'summary': {
          const scope = { conversationId: ctx.conversationId };
          const stats = ledger.summary(scope);
          const unsupported = ledger.unsupported(scope);
          const refuted = ledger.refuted(scope);

          const lines = [ledger.gateSummary(scope)];

          if (refuted.length > 0) {
            lines.push('', `**证据矛盾（${String(refuted.length)} 条，必须改手稿）：**`);
            lines.push(ledger.render(refuted, { limit: 10 }));
          }
          if (unsupported.confirmed.length > 0) {
            lines.push(
              '',
              `**已确认但无证据（${String(unsupported.confirmed.length)} 条，会开 FAIL）：**`,
            );
            lines.push(ledger.render(unsupported.confirmed, { limit: 15, showEvidence: false }));
          }
          if (unsupported.extracted.length > 0) {
            lines.push(
              '',
              `自动抽取且无证据（${String(unsupported.extracted.length)} 条，只报 WARN）：`,
              '逐条看过之后 confirm 需要证据的、dismiss 不需要核验的。',
            );
            lines.push(ledger.render(unsupported.extracted, { limit: 10, showEvidence: false }));
          }
          if (Object.keys(stats.byKind).length > 0) {
            lines.push(
              '',
              `按类型：${Object.entries(stats.byKind)
                .map(([kind, n]) => `${CLAIM_KIND_LABEL[kind as ClaimKind] ?? kind} ${String(n)}`)
                .join('，')}`,
            );
          }

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
