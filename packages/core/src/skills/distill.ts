/**
 * 从历史会话蒸馏技能（任务 12.15，需求 9.6）。
 *
 * 用户做完一件事之后，那次会话里往往已经包含了一套可复用的做法：先查什么、
 * 用哪个参数、哪一步容易错。蒸馏就是把它抽出来变成技能。
 *
 * ## 蒸馏产物必须经用户确认才落盘
 *
 * 这条是刻意的，不是保守。蒸馏的输入是**一次具体的分析**，因此它天然倾向于把
 * 一次性的东西写成通用规则：某台机器上的路径、某次运行的具体数值、「上面那个文件」
 * 之类的会话指代。这些错误的表现形式是「照着技能做但结果对不上」，比报错难查得多。
 *
 * 所以蒸馏返回**草稿**，`auditSkillContent` 的警告一并返回，由用户看过再决定。
 * 直接落盘会让技能目录里慢慢堆满只在当时那台机器上成立的「方法」。
 *
 * ## 为什么不复用 Reviewer 的 parse
 *
 * 形状不同：审查输出是一批发现，蒸馏输出是一份文档 + 一份清单，而且正文是
 * Markdown（里面会有代码块与引号，JSON 转义容易被模型写坏）。因此这里的解析
 * 单独写，并且**允许正文放在 JSON 之外的围栏块里**——那是模型最容易写对的形式。
 */

import type { AdapterContext, AdapterRegistry, ChatMessage } from '@l-science/adapters';
import type { ModelDescriptor } from '@l-science/shared';

import { streamModel } from '../orchestrator/agent-runtime.js';
import type { Message, MessageRepo, ToolCallRepo } from '../repo/conversations.js';
import { classifyFailure, type UsageRepo } from '../repo/usage.js';
import { extractJsonObject } from '../reviewer/parse.js';
import { buildTaskProfile, route } from '../router/index.js';
import type { ExperienceAdjustment, ModelRuntimeState } from '../router/index.js';

import { auditSkillContent, validateSkillFiles, type SkillFileMap } from './authoring.js';
import { isValidSlug } from './manifest.js';

/* ------------------------------------------------------------------ *
 * 上下文
 * ------------------------------------------------------------------ */

/** 从消息内容里取出可读文本。与 reviewer/checks.ts 的做法一致。 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

export interface DistillContextInput {
  messages: readonly Message[];
  /** 会话里执行过的工具名与次数。技能的 `tools` 字段应当据此填，而不是靠模型猜。 */
  toolUsage?: ReadonlyMap<string, number>;
  /** 字符预算。 */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 60_000;
const MAX_PER_MESSAGE = 6_000;

export interface DistillContext {
  text: string;
  /** 实际纳入的消息条数。少于总数时说明被预算截断了。 */
  included: number;
  truncated: boolean;
}

/**
 * 把会话整理成蒸馏输入。
 *
 * 从**最早**往后取而不是从最新往回取——这一点与审查相反。审查关心「刚才做了什么」，
 * 蒸馏关心「整件事是怎么做成的」，而做法的顺序在开头：问题怎么拆、先查什么。
 * 从最新往回取会拿到一堆收尾讨论而丢掉方法的主干。
 */
export function buildDistillContext(input: DistillContextInput): DistillContext {
  const budget = input.maxChars ?? DEFAULT_MAX_CHARS;
  const parts: string[] = [];
  let used = 0;
  let included = 0;

  for (const message of input.messages) {
    const raw = messageText(message.content).trim();
    if (raw === '') continue;
    const body =
      raw.length > MAX_PER_MESSAGE ? `${raw.slice(0, MAX_PER_MESSAGE)}\n[... 已截断 ...]` : raw;
    const block = `## ${message.role}（seq ${String(message.seq)}）\n${body}`;
    if (used + block.length > budget)
      return { text: parts.join('\n\n'), included, truncated: true };
    parts.push(block);
    used += block.length;
    included += 1;
  }

  if (input.toolUsage !== undefined && input.toolUsage.size > 0) {
    const summary = [...input.toolUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}×${String(count)}`)
      .join('、');
    parts.push(`## 本次会话实际调用过的工具\n${summary}`);
  }

  return { text: parts.join('\n\n'), included, truncated: false };
}

/**
 * 统计这批消息里工具的调用次数。
 *
 * 技能的 `tools` 字段必须照实填。让模型凭印象写的结果是它编出听起来合理但不存在的
 * 工具名（`run_python`、`read_file`），而那样的技能一加载，计划校验就会报「未知工具」
 * ——报错发生在使用时，错误的来源在创建时。
 *
 * 工具调用挂在消息上而不是会话上，所以按消息逐个取。
 */
export function collectToolUsage(
  toolCalls: ToolCallRepo,
  messages: readonly Message[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const message of messages) {
    for (const call of toolCalls.listByMessage(message.id)) {
      out.set(call.toolName, (out.get(call.toolName) ?? 0) + 1);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

export function distillSystemPrompt(): string {
  return [
    '你在把一次已完成的科研分析提炼成一份**可复用的技能文档**。',
    '',
    '技能是给以后的自己或同事看的方法学：换一份数据、换一个项目，照着它做仍然成立。',
    '因此最重要的判断是**哪些内容是方法、哪些只是这一次的情况**。',
    '',
    '必须剔除的东西（写进去会让技能在别处失效）：',
    '- 具体机器上的绝对路径。要参数化，或者写成相对工作区的位置。',
    '- 这一次的具体数值结果（样本量、p 值、准确率）。除非是作为「典型量级」的例子，',
    '  并且明确标成例子。',
    '- 制品版本号（av_ 开头的那些）。它们只在那个项目里存在。',
    '- 会话指代（「刚才」「上面那个」「我们前面说的」）。读技能的人看不到上文。',
    '',
    '必须保留并写清楚的东西：',
    '- 步骤顺序，以及每一步为什么在这个位置。',
    '- 关键参数的取值范围与取舍依据。',
    '- **这次真的踩到或差点踩到的坑**。这是蒸馏最有价值的部分——',
    '  它是别的地方查不到的经验，而通用教程里不会写。',
    '- 怎么验证这一步做对了（判据，不是「检查一下」）。',
    '',
    '输出格式：先给一个 JSON 对象，再给一个 markdown 围栏块作为正文。',
    '',
    '```',
    '{',
    '  "slug": "小写字母数字连字符，不超过 64 字符",',
    '  "name": "人可读的名字",',
    '  "domain": "领域分类，比如 信号与数据 / 统计与建模 / 文献",',
    '  "description": "一句话说清它解决什么问题。这是检索的主要输入。",',
    '  "triggers": ["什么时候该用它，至少三条，写成用户会说的话"],',
    '  "tools": ["需要哪些平台工具，从给出的实际调用清单里选"],',
    '  "requires": { "python": ["包名"], "commands": ["命令名"] }',
    '}',
    '```',
    '',
    '然后：',
    '',
    '````',
    '```markdown',
    '（技能正文，用标题分节。写清适用范围、步骤、参数、坑、验证清单。）',
    '```',
    '````',
    '',
    '正文放在围栏块里而不是 JSON 字段里，是因为正文含代码块与引号，塞进 JSON 字符串',
    '几乎必然转义出错。',
    '',
    '如果这次会话里没有值得提炼的方法（比如只是闲聊、或者中途失败没做完），',
    '就只输出 `{"insufficient": "原因"}`，不要硬凑一份技能。凑出来的技能会被检索命中，',
    '然后把一份错的方法交给下一个人。',
  ].join('\n');
}

export function distillUserPrompt(input: {
  context: string;
  existingSlugs: readonly string[];
  availableTools: readonly string[];
  /** 用户对要提炼什么的指定。留空则由模型自己判断。 */
  focus?: string | null;
}): string {
  const parts = [
    input.focus === undefined || input.focus === null || input.focus.trim() === ''
      ? '请从下面这段会话里提炼一份技能。'
      : `请从下面这段会话里提炼一份技能，重点放在：${input.focus.trim()}`,
    '',
    `可用的平台工具（tools 字段只能从这里选）：${input.availableTools.join('、')}`,
    '',
    input.existingSlugs.length === 0
      ? ''
      : `已存在的技能 slug（**不要与它们重名**，除非你就是要写一个改进版）：\n${input.existingSlugs.join('、')}`,
    '',
    '--- 会话开始 ---',
    input.context,
    '--- 会话结束 ---',
  ];
  return parts.filter((p) => p !== '').join('\n');
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export interface DistilledDraft {
  files: SkillFileMap;
  slug: string;
  /** 内容审查的结果。用户确认前要看到它。 */
  contentWarnings: readonly string[];
  /** 清单校验的警告。 */
  manifestWarnings: readonly string[];
}

export type DistillParseResult =
  | { ok: true; draft: DistilledDraft }
  | { ok: false; insufficient: true; reason: string }
  | { ok: false; insufficient: false; errors: readonly string[] };

/**
 * 逐行扫出所有围栏块。
 *
 * **不用正则成对匹配**。`/```...```/g` 在「JSON 块 + 正文块」这种输出上会把
 * 第一个块的结束围栏与第二个块的开始围栏配成一对，于是取到的是两个块之间的空白。
 * 这不是理论问题：提示词里 JSON 就是用围栏给的示例，模型照抄的概率很高。
 *
 * 逐行扫描还顺带处理了两件事：技能正文里常有嵌套代码块（```python），
 * 以及模型有时用四个反引号包住整体。
 */
function scanFencedBlocks(text: string): readonly FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split(/\r?\n/);

  let fence: string | null = null;
  let info = '';
  let body: string[] = [];

  for (const line of lines) {
    const open = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);

    if (fence === null) {
      if (open !== null) {
        fence = open[1] ?? '```';
        info = (open[2] ?? '').toLowerCase();
        body = [];
      }
      continue;
    }

    // 收尾围栏必须不短于开启围栏，这样 ```python 嵌在 ```` 里不会提前收尾
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (
      close !== null &&
      (close[1] ?? '').length >= fence.length &&
      (close[1] ?? '')[0] === fence[0]
    ) {
      blocks.push({ info, body: body.join('\n') });
      fence = null;
      continue;
    }
    body.push(line);
  }

  // 未闭合的最后一个块也收进来：输出被截断时正文仍然可用
  if (fence !== null && body.length > 0) blocks.push({ info, body: body.join('\n') });

  return blocks;
}

interface FencedBlock {
  /** 围栏的信息串（```json 里的 `json`）。 */
  info: string;
  body: string;
}

/**
 * 取出正文围栏块。
 *
 * 优先明确标了 `markdown` 的块；否则取最后一个不像 JSON 的块——正文按约定写在
 * JSON 之后，而提示词里的 JSON 示例本身也是围栏块。
 */
function extractMarkdownBlock(text: string): string | null {
  const blocks = scanFencedBlocks(text);
  if (blocks.length === 0) return null;

  const looksJson = (body: string): boolean => {
    const trimmed = body.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  };

  const marked = [...blocks].reverse().find((b) => b.info === 'markdown' || b.info === 'md');
  if (marked !== undefined && marked.body.trim() !== '') return marked.body.trim();

  for (const block of [...blocks].reverse()) {
    const body = block.body.trim();
    if (body === '' || block.info === 'json' || looksJson(body)) continue;
    return body;
  }
  return null;
}

/**
 * 解析模型输出成技能草稿。
 *
 * 永不抛错：解析失败要变成一条能读的错误消息，而不是让一次蒸馏以 internal 结束。
 */
export function parseDistilledSkill(
  text: string,
  options: { availableTools?: readonly string[] } = {},
): DistillParseResult {
  const jsonText = extractJsonObject(text);
  if (jsonText === null) {
    return {
      ok: false,
      insufficient: false,
      errors: ['模型输出里找不到 JSON 对象。它可能只写了正文，或者输出被截断了。'],
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      insufficient: false,
      errors: [
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` +
          (jsonText.trimEnd().endsWith('}') ? '' : '（看起来是被截断了）'),
      ],
    };
  }

  if (typeof raw.insufficient === 'string' && raw.insufficient.trim() !== '') {
    return { ok: false, insufficient: true, reason: raw.insufficient.trim() };
  }

  const errors: string[] = [];

  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!isValidSlug(slug)) {
    errors.push(`slug ${JSON.stringify(raw.slug)} 不合法（只允许小写字母、数字与连字符）`);
  }

  const instructions = extractMarkdownBlock(text);
  if (instructions === null) {
    errors.push('找不到正文围栏块。正文要放在 ```markdown 围栏里，不要塞进 JSON 字段。');
  }

  /*
   * 工具清单要过滤到实际存在的工具。
   *
   * 模型很容易写出一个听起来合理但不存在的工具名（`run_python`、`read_file`），
   * 而那样的技能一加载，`plan` 校验就会报「未知工具」——报错发生在使用时，
   * 而错误的来源在创建时。在这里就把不存在的挑掉并说明。
   */
  const rawTools = Array.isArray(raw.tools)
    ? raw.tools.filter((t): t is string => typeof t === 'string')
    : [];
  const available = options.availableTools;
  const tools = available === undefined ? rawTools : rawTools.filter((t) => available.includes(t));
  const droppedTools =
    available === undefined ? [] : rawTools.filter((t) => !available.includes(t));

  if (errors.length > 0 || instructions === null) {
    return { ok: false, insufficient: false, errors };
  }

  const manifest: Record<string, unknown> = {
    slug,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : slug,
    version: '1.0.0',
    ...(typeof raw.domain === 'string' && raw.domain.trim() !== ''
      ? { domain: raw.domain.trim() }
      : {}),
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    triggers: Array.isArray(raw.triggers)
      ? raw.triggers.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [],
    tools,
    ...(typeof raw.requires === 'object' && raw.requires !== null && !Array.isArray(raw.requires)
      ? { requires: raw.requires }
      : {}),
  };

  const files: SkillFileMap = {
    'skill.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'SKILL.md': `${instructions}\n`,
  };

  const validated = validateSkillFiles(files);
  if (!validated.ok) {
    return { ok: false, insufficient: false, errors: validated.errors };
  }

  const manifestWarnings = [...validated.warnings];
  if (droppedTools.length > 0) {
    manifestWarnings.push(
      `模型写了不存在的工具名并已剔除：${droppedTools.join('、')}。` +
        '留着它们会让计划校验在使用时报「未知工具」',
    );
  }

  return {
    ok: true,
    draft: {
      files,
      slug,
      contentWarnings: auditSkillContent(instructions),
      manifestWarnings,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

export interface DistillDeps {
  messages: MessageRepo;
  toolCalls: ToolCallRepo;
  adapters: AdapterRegistry;
  adapterContext: (providerId: string) => AdapterContext | null;
  routerView: () => {
    models: readonly ModelDescriptor[];
    runtime: ReadonlyMap<string, ModelRuntimeState>;
  };
  experience?: () => ReadonlyMap<string, ExperienceAdjustment>;
  usage?: UsageRepo;
  /** 现有 slug，用于提示模型别重名。 */
  existingSlugs: () => readonly string[];
  /** 注册表里实际存在的工具名。 */
  availableTools: () => readonly string[];
  timeoutMs?: number;
  messageLimit?: number;
}

export interface DistillRequest {
  conversationId: string;
  focus?: string | null;
  /** 强制用某个模型。留空走路由。 */
  modelId?: string | null;
}

export type DistillResult =
  | {
      ok: true;
      draft: DistilledDraft;
      modelId: string;
      /** 纳入的消息条数与是否被预算截断。 */
      context: { included: number; truncated: boolean };
    }
  | { ok: false; reason: string; insufficient?: boolean };

const DEFAULT_DISTILL_TIMEOUT_MS = 180_000;
const DEFAULT_DISTILL_MESSAGE_LIMIT = 120;

/**
 * 跑一次蒸馏。
 *
 * 返回草稿而不落盘——落盘要用户确认过再走 `writeUserSkill`。
 */
export async function distillSkill(
  deps: DistillDeps,
  request: DistillRequest,
): Promise<DistillResult> {
  const messages = deps.messages.page(request.conversationId, {
    limit: deps.messageLimit ?? DEFAULT_DISTILL_MESSAGE_LIMIT,
  }).messages;

  if (messages.length < 2) {
    return {
      ok: false,
      reason: '这个会话里内容太少，没有可提炼的做法。',
      insufficient: true,
    };
  }

  const context = buildDistillContext({
    messages,
    toolUsage: collectToolUsage(deps.toolCalls, messages),
  });

  const view = deps.routerView();
  const routed = route({
    models: view.models,
    profile: buildTaskProfile('skill.distill', {
      estimatedInputTokens: Math.ceil(context.text.length / 3),
      expectedOutputTokens: 4_096,
      needToolUse: false,
    }),
    runtime: view.runtime,
    ...(deps.experience === undefined ? {} : { experience: deps.experience() }),
    ...(request.modelId === undefined || request.modelId === null
      ? {}
      : { forcedModelId: request.modelId }),
  });

  const model = routed.ranked[0];
  if (model === undefined) {
    return { ok: false, reason: '没有可用的模型。先在设置里登记一个供应商。' };
  }
  const ctx = deps.adapterContext(model.providerId);
  if (ctx === null) return { ok: false, reason: `供应商 ${model.providerId} 未配置` };

  const availableTools = deps.availableTools();
  const history: readonly ChatMessage[] = [
    { role: 'system', content: distillSystemPrompt() },
    {
      role: 'user',
      content: distillUserPrompt({
        context: context.text,
        existingSlugs: deps.existingSlugs(),
        availableTools,
        ...(request.focus === undefined ? {} : { focus: request.focus }),
      }),
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_DISTILL_TIMEOUT_MS);
  timer.unref?.();

  const startedAt = Date.now();
  try {
    const collected = await streamModel({
      adapter: deps.adapters.get(model.providerId),
      ctx: { ...ctx, pricing: model.pricing },
      model,
      history,
      toolSchemas: [],
      signal: controller.signal,
      // 与审查同一个理由：思维模型会把默认预算全花在思考上，正文一个字不剩
      maxOutputTokens: model.features.thinking ? 24_576 : 8_192,
    });

    deps.usage?.record({
      conversationId: request.conversationId,
      providerId: model.providerId,
      modelId: model.id,
      tokensIn: collected.usage.tokensIn,
      tokensOut: collected.usage.tokensOut,
      cost: collected.usage.cost,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
    });

    // 正文可能落在思考段落里（部分模型会把结构化输出写在那儿）
    const parsed = parseDistilledSkill(collected.text, { availableTools });
    const final =
      parsed.ok || collected.thinking === ''
        ? parsed
        : (() => {
            const retry = parseDistilledSkill(`${collected.thinking}\n${collected.text}`, {
              availableTools,
            });
            return retry.ok ? retry : parsed;
          })();

    if (!final.ok) {
      return final.insufficient
        ? { ok: false, reason: final.reason, insufficient: true }
        : { ok: false, reason: final.errors.join('；') };
    }

    return {
      ok: true,
      draft: final.draft,
      modelId: model.id,
      context: { included: context.included, truncated: context.truncated },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: unknown }).status;
    deps.usage?.record({
      conversationId: request.conversationId,
      providerId: model.providerId,
      modelId: model.id,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      latencyMs: Date.now() - startedAt,
      status: classifyFailure({
        message,
        ...(typeof status === 'number' ? { status } : {}),
      }),
    });
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `蒸馏超时（${String(deps.timeoutMs ?? DEFAULT_DISTILL_TIMEOUT_MS)} ms）`
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}
