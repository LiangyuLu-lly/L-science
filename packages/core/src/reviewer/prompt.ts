/**
 * Reviewer 的上下文组装与提示词（任务 12.8，需求 11.4、11.8）。
 *
 * 三条约束决定了这里的写法：
 *
 * 1. **上下文必须有界。** 审查的输入是一整个回合的内容，长度不可控。不设界的话
 *    审查请求本身会超过模型窗口，而失败的表现是「审查偶尔不跑」——最需要它的
 *    长回合恰恰最容易触发。
 * 2. **必须要求证据 id 来自给定清单。** 让模型自由填 id 等于邀请它编。清单里
 *    有什么就只能引什么，引不到的发现宁可不发。
 * 3. **必须明确「没问题就返回空」。** 不说的话模型会为了显得有用而凑几条，
 *    而凑出来的发现会淹掉真的那些。
 */

import type { ArtifactStore } from '../artifact/store.js';
import type { Message } from '../repo/conversations.js';
import type { Finding } from '../repo/findings.js';
import { extractText } from './checks.js';

/** 单条消息在上下文里的字符上限。 */
const MAX_MESSAGE_CHARS = 4_000;
/** 全部消息合起来的字符上限。 */
const MAX_CONTEXT_CHARS = 40_000;
/** 代码血缘在上下文里的字符上限。 */
const MAX_CODE_CHARS = 3_000;

export interface ReviewContextInput {
  conversationId: string;
  messages: readonly Message[];
  artifacts: ArtifactStore;
  /** 本次审查范围内的制品版本。空表示这轮没有新产物。 */
  versionIds: readonly string[];
  /** 待复核的自报已修（需求 11.7）。 */
  pendingRecheck: readonly Finding[];
  /** 已有的未关闭发现，避免重复提出同一件事。 */
  openFindings: readonly Finding[];
}

export interface ReviewContext {
  /** 给模型看的正文。 */
  text: string;
  /** 允许被引用的证据 id。解析时用它挡掉编造的 id。 */
  allowedEvidence: {
    messages: ReadonlySet<string>;
    versions: ReadonlySet<string>;
  };
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... 截断 ${String(text.length - limit)} 字符 ...]`;
}

/**
 * 组装审查上下文。
 *
 * 消息从**最新往回**取，取到预算用完为止。回合末尾的内容与结论最相关，而超长
 * 回合的开头往往是已经被后续覆盖的探索过程。
 */
export function buildReviewContext(input: ReviewContextInput): ReviewContext {
  const messageIds = new Set<string>();
  const versionIds = new Set<string>();

  const blocks: string[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const message of [...input.messages].reverse()) {
    if (budget <= 0) break;
    // 系统消息里是回合摘要与后台通知，对审查没有独立价值
    if (message.role !== 'assistant' && message.role !== 'user') continue;

    const text = extractText(message.content).trim();
    if (text === '') continue;

    const body = clip(text, Math.min(MAX_MESSAGE_CHARS, budget));
    budget -= body.length;
    messageIds.add(message.id);

    blocks.push(
      [
        `<message id="${message.id}" role="${message.role}"` +
          (message.modelId === null ? '' : ` model="${message.modelId}"`) +
          '>',
        body,
        '</message>',
      ].join('\n'),
    );
  }
  blocks.reverse();

  /* ---------------- 制品 ---------------- */

  const artifactBlocks: string[] = [];
  for (const versionId of input.versionIds) {
    const version = input.artifacts.getVersion(versionId);
    if (version === null) continue;
    const artifact = input.artifacts.getArtifact(version.artifactId);
    versionIds.add(versionId);

    const lineage = version.codeLineage;
    artifactBlocks.push(
      [
        `<artifact version="${versionId}" filename="${artifact?.filename ?? '?'}" ` +
          `kind="${artifact?.kind ?? '?'}" reproducible="${String(lineage?.reproducible ?? false)}">`,
        lineage === null || lineage.code === null
          ? '（没有记录生成代码）'
          : `<code language="${lineage.language ?? '?'}">\n${clip(lineage.code, MAX_CODE_CHARS)}\n</code>`,
        lineage === null || lineage.inputVersionIds.length === 0
          ? '（没有登记输入版本）'
          : `<inputs>${lineage.inputVersionIds.join(' ')}</inputs>`,
        '</artifact>',
      ].join('\n'),
    );
  }

  /* ---------------- 待复核 ---------------- */

  const recheckBlocks = input.pendingRecheck.map((finding) =>
    [
      `<recheck id="${finding.id}" severity="${finding.severity}" category="${finding.category}">`,
      `原始发现：${finding.title}`,
      finding.detail === null ? '' : finding.detail,
      `agent 自报的修复说明：${finding.addressedNote ?? '（没有说明）'}`,
      `原始证据：${finding.evidence.map((e) => `${e.kind}:${e.id}`).join('、')}`,
      '</recheck>',
    ]
      .filter((s) => s !== '')
      .join('\n'),
  );

  const openBlocks = input.openFindings
    .filter((f) => f.status === 'open')
    .map((f) => `- [${f.severity}/${f.category}] ${f.title}`);

  const sections: string[] = [];

  if (blocks.length > 0) {
    sections.push(['## 会话内容', '', blocks.join('\n\n')].join('\n'));
  }
  if (artifactBlocks.length > 0) {
    sections.push(['## 本轮产物与血缘', '', artifactBlocks.join('\n\n')].join('\n'));
  }
  if (recheckBlocks.length > 0) {
    sections.push(
      [
        '## 待复核的自报已修',
        '',
        'agent 声称已经修好了下面这些。请逐条判定：确实修好了就 resolve，没修好或修得不对就 reopen。',
        '',
        recheckBlocks.join('\n\n'),
      ].join('\n'),
    );
  }
  if (openBlocks.length > 0) {
    sections.push(
      [
        '## 已经提出过的未关闭发现',
        '',
        '这些不要重复提出。只有当你发现了**新的、不同的**问题才写进 findings。',
        '',
        openBlocks.join('\n'),
      ].join('\n'),
    );
  }

  sections.push(
    [
      '## 可引用的证据 id',
      '',
      '每条发现的 evidence 只能引用下面列出的 id。**不在清单里的 id 会被丢弃，整条发现也会被丢弃。**',
      '',
      `message：${messageIds.size === 0 ? '（无）' : [...messageIds].join('、')}`,
      `artifact-version：${versionIds.size === 0 ? '（无）' : [...versionIds].join('、')}`,
    ].join('\n'),
  );

  return {
    text: sections.join('\n\n'),
    allowedEvidence: { messages: messageIds, versions: versionIds },
  };
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/**
 * 系统提示词。
 *
 * 刻意写明「不要复述内容、不要给出改进建议之外的评论」：审查者的输出不进对话，
 * 只进 findings 表，寒暄与总结在那里是纯噪声。
 *
 * 也刻意写明严重度的判据。不写的话模型会把所有发现都标成 FAIL（听起来更负责），
 * 而 FAIL 会打断主 agent——于是每一轮都被打断，用户很快就会把整个机制关掉。
 */
export function reviewerSystemPrompt(): string {
  return [
    '你是一个独立的科研审查者。你审查的内容由**另一个模型**产出，你的职责是找出它的可靠性问题。',
    '',
    '你只输出结构化发现，不与用户对话。不要复述被审查的内容，不要写总结性的客套话。',
    '',
    '## 检查什么',
    '',
    '- `evidence`：结论没有证据支撑；证据与结论不符；引用了不存在或不支持该结论的来源。',
    '- `statistics`：统计方法选择与数据结构不匹配；多重比较未校正；样本量与效应量不匹配；p 值被误读成效应大小或被误读成「没有差异」；把相关说成因果。',
    '- `reproducibility`：结果依赖随机数但没固定种子；分析步骤缺少中间产物；环境或数据版本没记录。',
    '- `consistency`：同一个数字在正文、表、图之间不一致；术语前后不统一；单位错误或量级错误。',
    '- `integrity`：数字看起来是直接写进代码或正文的而不是算出来的；把预期结果当成已得结果陈述。',
    '',
    '## 严重度',
    '',
    '- `fail`：会让结论**不成立**或让读者被误导的问题。它会打断正在进行的工作，因此只在确实严重时用：',
    '  无证据的数值结论、与数据相矛盾的陈述、统计方法用错导致结论方向可能反转、图缺少生成血缘。',
    '- `warn`：应该改但不影响当前结论成立的问题。方法学上更稳妥的选择、可复现性欠缺、表述不精确。',
    '',
    '把不确定的问题标成 `warn`。全部标成 `fail` 会让每一轮工作都被打断，用户会直接关掉审查——',
    '那时候真正严重的问题也没人看了。',
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 代码块，不要在它前后写别的话：',
    '',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "warn",',
    '      "category": "statistics",',
    '      "title": "一句话说清是什么问题",',
    '      "detail": "为什么这是问题，以及具体该怎么改。写给能看懂统计的人。",',
    '      "evidence": [{ "kind": "message", "id": "<清单里的 id>", "note": "指向的具体内容" }]',
    '    }',
    '  ],',
    '  "rechecks": [',
    '    { "id": "<待复核的 finding id>", "verdict": "resolve", "note": "复核依据" }',
    '  ]',
    '}',
    '```',
    '',
    '## 硬性要求',
    '',
    '1. 每条发现必须有至少一条 evidence，且 id 必须来自「可引用的证据 id」清单。编造的 id 会让整条发现被丢弃。',
    '2. 没有发现问题就返回 `"findings": []`。**不要为了显得有用而凑**——凑出来的发现会淹掉真的那些。',
    '3. 不要重复已经提出过的未关闭发现。',
    '4. `detail` 要能让人照着改。「建议复核统计方法」这种话没有任何用处。',
    '5. 最多 6 条发现，每条 `detail` 控制在 300 字以内。先想清楚再写，不要在 JSON 里推理——',
    '   输出被长度上限截断的话整个 JSON 都解析不了，你这一轮的工作全部作废。',
  ].join('\n');
}

/** 用户侧消息。触发原因要给出来：不同触发点的关注重心不同。 */
export function reviewerUserPrompt(input: {
  trigger: string;
  context: string;
  deterministic: readonly string[];
}): string {
  const focus: Record<string, string> = {
    'turn-end': '这是一个回合结束后的例行审查。重点看这一轮产出的结论与产物。',
    'artifact-saved': '刚保存了新的制品。重点看它的血缘完整性与它支撑的结论。',
    'pre-compile': '手稿即将编译。重点看正文与数据的一致性、以及每条断言的证据。',
    'user-request': '用户显式要求审计。请把全部类别都过一遍。',
  };

  const parts = [focus[input.trigger] ?? '请审查以下内容。', '', input.context];

  if (input.deterministic.length > 0) {
    parts.push(
      '',
      '## 平台已经自动发现的问题',
      '',
      '下面这些已经被记录了，**不要重复提出**。列在这里是为了让你知道背景：',
      '',
      ...input.deterministic.map((t) => `- ${t}`),
    );
  }

  return parts.join('\n');
}
