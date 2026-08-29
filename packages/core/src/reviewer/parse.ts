/**
 * 解析 Reviewer 模型的输出（任务 12.8，需求 11.8）。
 *
 * 这一层的核心不是解析，而是**把编造的发现挡掉**。
 *
 * 一个会编造证据的审查者比没有审查更糟：用户会去看那条不存在的引用，发现打不开，
 * 然后不再相信任何 finding——包括真的那些。因此这里对每条发现做三重校验：
 * 结构合法、证据 id 在给定清单里、证据非空。三者任一不过就丢掉整条，并把丢弃
 * 原因记下来（写进审查运行的 summary，用户能看到「本次有 N 条发现因证据无效被丢弃」）。
 *
 * 也刻意容忍格式噪声：本地小模型很难做到「只输出一个 JSON 块」，前后带一段解释
 * 是常态。为此从文本里提取第一个平衡的 JSON 对象，而不是要求整段就是 JSON。
 */

import type { FindingCategory, FindingEvidence, FindingSeverity } from '../repo/findings.js';
import type { DraftFinding } from './checks.js';

export type RecheckVerdict = 'resolve' | 'reopen';

export interface ParsedRecheck {
  findingId: string;
  verdict: RecheckVerdict;
  note: string;
}

export interface ParsedReview {
  findings: readonly DraftFinding[];
  rechecks: readonly ParsedRecheck[];
  /** 被丢弃的条目及原因。要能告诉用户「模型给了但被挡下了」。 */
  rejected: readonly string[];
}

export interface ParseOptions {
  allowedMessageIds: ReadonlySet<string>;
  allowedVersionIds: ReadonlySet<string>;
  /**
   * 允许作为证据的断言 id（任务 13.4）。
   *
   * 省略表示这个部署没有接 Claim Ledger。与传空集合的区别在错误文案上：
   * 前者说「该项目还没登记断言」，后者说「这条断言不在本次审查范围内」——
   * 两句话指向的下一步动作不同。
   */
  allowedClaimIds?: ReadonlySet<string>;
  /** 允许被复核的 finding id。不在其中的判定被丢弃。 */
  recheckableIds: ReadonlySet<string>;
}

const SEVERITIES: readonly FindingSeverity[] = ['warn', 'fail'];
const CATEGORIES: readonly FindingCategory[] = [
  'evidence',
  'statistics',
  'reproducibility',
  'consistency',
  'integrity',
  'claim',
];

/**
 * 从任意文本里抠出第一个 JSON 对象。
 *
 * 先找 ```json 围栏，没有围栏就找第一个 `{` 并按括号配平扫到对应的 `}`。
 * 配平时要跳过字符串字面量里的括号——`detail` 字段里出现 `}` 完全正常
 * （比如引用一段代码），按字符计数会截在半截上。
 */
export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const haystack = fenced?.[1] ?? text;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }

  return null;
}

function asString(value: unknown, max = 4_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 校验一条证据。
 *
 * 全部三类（制品版本、消息、断言）都按 id 是否在允许清单里判定，而不是相信模型写的
 * `kind`。放行一条指向不存在记录的证据会让 UI 点开是空的，而用户在那之前已经
 * 相信了这条发现。
 */
function checkEvidence(
  raw: unknown,
  options: ParseOptions,
): { ok: true; evidence: FindingEvidence } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '证据不是对象' };
  }
  const obj = raw as Record<string, unknown>;

  const id = asString(obj.id, 200);
  if (id === null) return { ok: false, reason: '证据缺少 id' };

  const kind = asString(obj.kind, 40);
  const note = asString(obj.note, 1_000);

  // kind 写错但 id 认得出来时按 id 判断：模型常把 artifact-version 写成 artifact
  const looksVersion = options.allowedVersionIds.has(id);
  const looksMessage = options.allowedMessageIds.has(id);
  const looksClaim = options.allowedClaimIds?.has(id) === true;

  if (looksVersion) {
    return {
      ok: true,
      evidence: { kind: 'artifact-version', id, ...(note === null ? {} : { note }) },
    };
  }
  if (looksMessage) {
    return { ok: true, evidence: { kind: 'message', id, ...(note === null ? {} : { note }) } };
  }
  if (looksClaim) {
    return { ok: true, evidence: { kind: 'claim', id, ...(note === null ? {} : { note }) } };
  }

  /*
   * claim 类且不在清单里时单独给一句更具体的原因。
   *
   * 通用的「不在允许清单里」在这里会误导：模型可能给了一个真实存在但不属于本次
   * 审查范围的 claim id（另一个会话的断言）。告诉它「这条断言不在本次审查范围内」
   * 才能让它改用范围内的证据，而不是重试同一个 id。
   */
  if (kind === 'claim') {
    return {
      ok: false,
      reason:
        options.allowedClaimIds === undefined
          ? `证据 ${id} 是 claim 类，但本次审查没有可用的断言清单（该项目还没登记断言）`
          : `断言 ${id} 不在本次审查范围内。只能引用本次审查上下文里列出的断言。`,
    };
  }
  return { ok: false, reason: `证据 id 不在允许清单里：${id}` };
}

/** 解析模型输出。永不抛错——审查失败不该反过来把主流程搞崩。 */
export function parseReviewOutput(text: string, options: ParseOptions): ParsedReview {
  const rejected: string[] = [];

  const json = extractJsonObject(text);
  if (json === null) {
    /*
     * 区分「没写 JSON」与「JSON 没闭合」。
     *
     * 后者的成因几乎总是输出被 max_tokens 截断——审查者的 detail 字段可以很长，
     * 而这个失败看起来和「模型不肯按格式输出」一模一样。混成一句话会让人去改
     * 提示词，而真正该改的是输出预算。
     */
    const unterminated = text.includes('{');
    return {
      findings: [],
      rechecks: [],
      rejected: [
        unterminated
          ? 'JSON 对象没有闭合，输出很可能被输出长度上限截断了，本次审查没有产出可用发现'
          : '模型输出里找不到 JSON 对象，本次审查没有产出可用发现',
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    return {
      findings: [],
      rechecks: [],
      rejected: [`模型输出的 JSON 无法解析：${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { findings: [], rechecks: [], rejected: ['模型输出的顶层不是对象'] };
  }

  const root = parsed as Record<string, unknown>;

  /* ---------------- findings ---------------- */

  const findings: DraftFinding[] = [];
  const rawFindings = Array.isArray(root.findings) ? root.findings : [];

  for (const [index, raw] of rawFindings.entries()) {
    const label = `第 ${String(index + 1)} 条发现`;

    if (typeof raw !== 'object' || raw === null) {
      rejected.push(`${label}不是对象`);
      continue;
    }
    const obj = raw as Record<string, unknown>;

    const title = asString(obj.title, 500);
    if (title === null) {
      rejected.push(`${label}缺少 title`);
      continue;
    }

    const severityRaw = (asString(obj.severity, 20) ?? '').toLowerCase();
    // 大写的 WARN / FAIL 也认：设计文档里用的是大写，模型可能照抄
    const severity = SEVERITIES.find((s) => s === severityRaw);
    if (severity === undefined) {
      rejected.push(`${label}（${title}）的 severity 非法：${severityRaw || '缺失'}`);
      continue;
    }

    const categoryRaw = (asString(obj.category, 40) ?? '').toLowerCase();
    const category = CATEGORIES.find((c) => c === categoryRaw);
    if (category === undefined) {
      rejected.push(`${label}（${title}）的 category 非法：${categoryRaw || '缺失'}`);
      continue;
    }

    const rawEvidence = Array.isArray(obj.evidence) ? obj.evidence : [];
    const evidence: FindingEvidence[] = [];
    const evidenceProblems: string[] = [];

    for (const item of rawEvidence) {
      const checked = checkEvidence(item, options);
      if (checked.ok) evidence.push(checked.evidence);
      else evidenceProblems.push(checked.reason);
    }

    if (evidence.length === 0) {
      // 整条丢掉。无指向的发现用户只能忽略，而一旦开始忽略整个机制就失效了
      rejected.push(
        `${label}（${title}）没有可核对的证据，已丢弃` +
          (evidenceProblems.length === 0 ? '' : `：${evidenceProblems.join('；')}`),
      );
      continue;
    }

    findings.push({
      severity,
      category,
      title,
      detail: asString(obj.detail, 4_000) ?? '（模型没有给出细节）',
      evidence,
    });
  }

  /* ---------------- rechecks ---------------- */

  const rechecks: ParsedRecheck[] = [];
  const rawRechecks = Array.isArray(root.rechecks) ? root.rechecks : [];

  for (const raw of rawRechecks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;

    const findingId = asString(obj.id, 200);
    if (findingId === null) continue;

    if (!options.recheckableIds.has(findingId)) {
      rejected.push(`复核判定指向的 finding 不在待复核列表里：${findingId}`);
      continue;
    }

    const verdictRaw = (asString(obj.verdict, 20) ?? '').toLowerCase();
    const verdict: RecheckVerdict | null =
      verdictRaw === 'resolve' ? 'resolve' : verdictRaw === 'reopen' ? 'reopen' : null;

    if (verdict === null) {
      rejected.push(`复核判定 ${findingId} 的 verdict 非法：${verdictRaw || '缺失'}`);
      continue;
    }

    rechecks.push({
      findingId,
      verdict,
      note: asString(obj.note, 2_000) ?? '（模型没有给出复核依据）',
    });
  }

  return { findings, rechecks, rejected };
}
