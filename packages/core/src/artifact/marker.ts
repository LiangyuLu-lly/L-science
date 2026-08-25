/**
 * `{{artifact:VERSION_ID}}` 标记解析（任务 7.4，需求 6.5）。
 *
 * 执行前把标记替换成物理路径。看起来是个简单的字符串替换，但有一条不能让的
 * 限制：**标记必须是源码里的字面量**。
 *
 * 为什么这条限制值得存在：假设允许 `f"{{{{artifact:{var}}}}}"` 这类拼接，那么
 * 标记的实际内容在运行时才确定，而解析发生在执行前。结果是解析器看到的是
 * 一个模板而不是一个 id，只能选择跳过它——于是那行代码带着未解析的字面
 * 文本进入内核，Python 拿到一个不存在的路径 `{{artifact:abc}}`，报
 * FileNotFoundError。这个错误信息完全不指向真正的原因，模型会开始猜路径、
 * 试相对路径、试 os.path.join，而每一次都失败。
 *
 * 所以要在解析阶段就明确拒绝并说明该怎么改。宁可报一个准确的错，
 * 也不要放一个注定失败且症状误导的调用过去。
 */

/**
 * 标记的形态。
 *
 * id 部分**刻意允许包含大括号与美元符**，尽管合法 id 里不会有它们。原因是
 * 这个正则的职责不只是「找出合法标记」，还要「找出写错的标记以便拒绝」。
 * 最初写成 `[^{}]*` 排除大括号，结果 f-string 形式 `f"{{artifact:{vid}}}"`
 * 根本匹配不到——于是它绕过了全部校验，带着未解析的字面文本进内核，
 * Python 报一个指向错误方向的 FileNotFoundError。
 *
 * 非贪婪加不跨行：跨行会让一个漏写右括号的标记吞掉后面几十行代码。
 */
const MARKER_PATTERN = /\{\{artifact:([^\r\n]*?)\}\}/g;

/** 合法的版本 id：`av_` 加 UUID，或裸 UUID（兼容用户手工粘贴）。 */
const VERSION_ID_PATTERN =
  /^(?:av_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MarkerOccurrence {
  /** 标记原文，含双大括号。 */
  raw: string;
  /** 大括号内 `artifact:` 之后的部分，未做校验。 */
  rawId: string;
  /** 在源码中的起始偏移。 */
  index: number;
}

export interface ResolveMarkersResult {
  /** 替换后的代码。有拒绝项时保持原样不做部分替换。 */
  code: string;
  /** 成功解析的标记数。 */
  resolved: number;
  /** 解析失败的项及原因。非空时 `code` 未被修改。 */
  rejected: ReadonlyArray<{ raw: string; reason: string }>;
  /** 被引用到的版本 id，用于自动建立血缘。 */
  referencedVersionIds: readonly string[];
}

/** 找出全部标记出现处。 */
export function findMarkers(code: string): readonly MarkerOccurrence[] {
  const found: MarkerOccurrence[] = [];
  for (const match of code.matchAll(MARKER_PATTERN)) {
    found.push({ raw: match[0], rawId: match[1] ?? '', index: match.index });
  }
  return found;
}

/**
 * 检测是否有变量拼接的痕迹。
 *
 * 判断依据是 id 位置出现了不该出现的字符。这不能覆盖所有拼接写法——
 * `"{{artifact:" + var + "}}"` 在拼接前根本不存在完整标记，因此这里看不到它。
 * 那种情况由「未解析的标记进了内核」这个后果兜底，而检测能覆盖的是最常见的
 * f-string 与模板字符串形式。
 */
function diagnoseId(rawId: string): string | null {
  if (rawId === '') return '标记里没有版本 id。';

  if (VERSION_ID_PATTERN.test(rawId)) return null;

  // f-string / 模板字符串 / 格式化占位符
  if (/[{}$%]/.test(rawId) || rawId.includes('+')) {
    return (
      `版本 id 位置出现了变量拼接（${rawId}）。标记必须是源码里的字面量，` +
      '因为解析发生在代码执行之前，此时变量还没有值。' +
      '请把具体的版本 id 直接写进标记里，例如 {{artifact:av_...}}；' +
      '需要动态选择文件时，先用工具查出版本 id，再把它写成字面量。'
    );
  }

  if (/\s/.test(rawId)) return `版本 id 里不应有空白字符（${rawId}）。`;

  return (
    `“${rawId}” 不是合法的版本 id。期望 UUID 形式，例如 ` +
    'av_1f2e3d4c-5b6a-7980-1234-567890abcdef。可以先列出制品来查到正确的 id。'
  );
}

export interface ResolveMarkersOptions {
  /** 把版本 id 解析为物理路径。返回 null 表示该版本不存在。 */
  resolve: (versionId: string) => string | null;
  /**
   * 路径的目标语言。影响转义方式。
   *
   * Windows 路径里的反斜杠在 Python 字符串里是转义字符：把 `D:\proj\a.png`
   * 直接插进 `open("...")` 会得到 `\p` 与 `\a`（后者是响铃字符），报的错是
   * 「找不到文件 D:proja.png」——这个提示完全不指向真正的原因。
   */
  language?: 'python' | 'r' | 'shell' | 'raw';
}

/**
 * 按目标语言转义路径。
 *
 * Python 用正斜杠而不是转义反斜杠：Windows API 接受正斜杠，而正斜杠不需要
 * 转义，因此不会出现「转义了但漏了一处」这类问题。R 同理。
 */
export function escapePath(path: string, language: ResolveMarkersOptions['language']): string {
  switch (language) {
    case 'python':
    case 'r':
      // Windows API 接受正斜杠，且正斜杠在字符串字面量里无需转义
      return path.replace(/\\/g, '/');
    case 'shell':
      // PowerShell 与 bash 都接受被引号包裹的路径。这里不加引号——
      // 加引号会与调用方自己写的引号叠成 ""path""
      return path.replace(/`/g, '``');
    default:
      return path;
  }
}

/**
 * 解析代码中的全部标记。
 *
 * 有任何一项失败时**不做部分替换**，原样返回代码并报告全部问题。部分替换会
 * 让代码进入一个半解析状态：一部分路径是真的，另一部分是字面标记文本，
 * 执行后的错误只暴露其中一个问题，用户得来回修好几轮。
 */
export function resolveMarkers(code: string, options: ResolveMarkersOptions): ResolveMarkersResult {
  const occurrences = findMarkers(code);
  if (occurrences.length === 0) {
    return { code, resolved: 0, rejected: [], referencedVersionIds: [] };
  }

  const rejected: Array<{ raw: string; reason: string }> = [];
  const replacements = new Map<string, string>();
  const referenced = new Set<string>();

  for (const occurrence of occurrences) {
    const diagnosis = diagnoseId(occurrence.rawId);
    if (diagnosis !== null) {
      rejected.push({ raw: occurrence.raw, reason: diagnosis });
      continue;
    }

    // 归一化：兼容用户粘贴的裸 UUID
    const versionId = occurrence.rawId.startsWith('av_')
      ? occurrence.rawId
      : `av_${occurrence.rawId}`;

    const path = options.resolve(versionId);
    if (path === null) {
      rejected.push({
        raw: occurrence.raw,
        reason:
          `找不到版本 ${versionId}。它可能已被删除，或 id 抄错了。` +
          '可以先列出制品确认当前可用的版本 id。',
      });
      continue;
    }

    replacements.set(occurrence.raw, escapePath(path, options.language));
    referenced.add(versionId);
  }

  if (rejected.length > 0) {
    // 保持代码原样，让调用方拿到一个完整的问题清单
    return { code, resolved: 0, rejected, referencedVersionIds: [] };
  }

  let resolvedCode = code;
  for (const [raw, path] of replacements) {
    resolvedCode = resolvedCode.split(raw).join(path);
  }

  return {
    code: resolvedCode,
    resolved: occurrences.length,
    rejected: [],
    referencedVersionIds: [...referenced],
  };
}

/** 把拒绝项整理成给模型看的错误消息。 */
export function formatRejections(rejected: ResolveMarkersResult['rejected']): string {
  return [
    `代码里有 ${String(rejected.length)} 个 artifact 标记无法解析，因此没有执行任何代码：`,
    ...rejected.map((r) => `  · ${r.raw}\n    ${r.reason}`),
  ].join('\n');
}
