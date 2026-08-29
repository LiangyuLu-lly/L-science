/**
 * 手稿 front matter 解析（任务 13.6，需求 13.5-13.8）。
 *
 * 为什么不复用 `skills/manifest.ts` 里的 `parseFrontMatter`：那个是平铺的
 * （`key: value` 与 `key: [a, b]`），对技能清单够用。手稿不够——需求 13.6 要
 * 「按结构化元数据移除作者、机构」，而作者与机构的对应关系本身就是嵌套的：
 *
 * ```yaml
 * authors:
 *   - name: Jane Smith
 *     affiliations: [1, 2]
 *     corresponding: true
 * affiliations:
 *   - Department of Neuroscience, University X
 * ```
 *
 * 用平铺约定（`author1_name:`）表达它是可以的，但那把「结构化元数据」变成了
 * 一个字符串命名约定——而约定写错时没有任何东西会报错，双盲处理会静默漏掉一位作者。
 *
 * 为什么仍然不引 YAML 解析器：与 `skills/archive.ts` 不引解压库同一个理由的弱化版。
 * 完整 YAML 有锚点、别名、合并键、多文档、隐式类型转换（`no` → false、
 * `1.0` → 数字、`2023-01-01` → 日期）——这些特性在手稿元数据里一个都用不上，
 * 而每一个都是一处「用户写的东西与系统读到的东西不一致」的可能。
 *
 * 因此这里实现的是一个**明确划定边界的子集**：
 *
 * - 标量（字符串、数字、布尔）
 * - 流式序列 `[a, b, c]`
 * - 块序列 `- item`，项可以是标量或映射
 * - 嵌套映射（按缩进）
 * - 块标量 `|`（保留换行）与 `>`（折叠换行）——摘要与致谢需要多行
 * - `#` 注释
 *
 * 不支持的一律**报错而不是猜**：锚点、别名、多文档分隔、复杂键。静默忽略一个
 * `<<: *defaults` 会让用户以为默认值生效了。
 */

/** 解析出的值。刻意不含 null 与日期——手稿元数据里用不到，而它们的隐式转换是陷阱。 */
export type YamlValue = string | number | boolean | readonly YamlValue[] | YamlMap;

export interface YamlMap {
  readonly [key: string]: YamlValue;
}

export class FrontMatterError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`front matter 第 ${String(line)} 行：${message}`);
    this.name = 'FrontMatterError';
    this.line = line;
  }
}

export interface ParsedFrontMatter {
  /** 解析出的元数据。没有 front matter 时是空对象。 */
  meta: YamlMap;
  /** 剥掉 front matter 之后的正文。 */
  body: string;
  /** 是否真的有 front matter 块。 */
  present: boolean;
  /** 正文在原文里的起始行号（1 基）。用于把定位串对回原文。 */
  bodyStartLine: number;
}

interface Line {
  /** 1 基行号，用于报错。 */
  number: number;
  indent: number;
  content: string;
}

/** 把原始文本切成有效行，跳过空行与注释行。 */
function tokenize(source: string): readonly Line[] {
  const out: Line[] = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    /*
     * Tab 缩进直接报错而不是当成空格。
     *
     * YAML 规范禁止用 tab 缩进，而各家解析器对它的处理不一致。允许它的后果是
     * 同一份手稿在不同工具里解析出不同的嵌套结构——而用户看不出区别。
     */
    if (/^\t/u.test(raw)) {
      throw new FrontMatterError('缩进不能用 Tab，请改用空格', index + 1);
    }

    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    out.push({ number: index + 1, indent, content: trimmed });
  }
  return out;
}

/** 拒绝明确不支持的语法。静默忽略它们会让用户以为写的东西生效了。 */
function rejectUnsupported(line: Line): void {
  if (line.content.startsWith('---') || line.content.startsWith('...')) {
    throw new FrontMatterError('front matter 里不能再出现文档分隔符', line.number);
  }
  /*
   * 合并键的判断要排在锚点之前。
   *
   * `<<: *defaults` 同时命中两条规则，而「不支持合并键」比「不支持别名」更贴近
   * 用户实际想做的事——他要的是继承一组默认值，而报「不支持别名」会让他去查
   * 别名是什么。
   */
  if (line.content.startsWith('<<:')) {
    throw new FrontMatterError('不支持合并键（<<）。请把字段写全', line.number);
  }
  if (/(?:^|:\s*)[&*]\w/u.test(line.content)) {
    throw new FrontMatterError(
      '不支持锚点与别名（& 与 *）。手稿元数据请写成展开的形式',
      line.number,
    );
  }
  if (line.content.startsWith('? ')) {
    throw new FrontMatterError('不支持复杂键（?）', line.number);
  }
}

/**
 * 解析标量。
 *
 * **不做隐式类型转换**，只认三种显式形态：带引号的一律是字符串；`true`/`false`
 * 是布尔；纯数字是数字。其余全部是字符串。
 *
 * 这一条很重要：YAML 的隐式转换会把 `no` 变成 false（挪威的国家代码），把
 * `1.10` 变成 1.1（版本号），把 `2023-01-01` 变成日期对象。在手稿元数据里，
 * 一个叫「No」的作者姓氏变成布尔值就是一次静默的数据损坏。
 */
function parseScalar(raw: string): YamlValue {
  const text = raw.trim();

  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const inner = text.slice(1, -1);
    // 只处理最常用的两个转义，其余原样保留
    return text.startsWith('"') ? inner.replace(/\\n/gu, '\n').replace(/\\"/gu, '"') : inner;
  }

  if (text === 'true') return true;
  if (text === 'false') return false;
  // 纯整数或纯小数。带前导零的（`007`）保持字符串——那通常是编号
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) return Number(text);

  return text;
}

/** 流式序列 `[a, b, "c, d"]`。逗号在引号内不算分隔符。 */
function parseFlowSequence(raw: string, lineNumber: number): readonly YamlValue[] {
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;

  for (const ch of inner) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);

  if (quote !== null) throw new FrontMatterError('引号没有闭合', lineNumber);
  if (depth !== 0) throw new FrontMatterError('方括号没有配对', lineNumber);

  return items
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map(parseScalar);
}

/** 上限：挡住畸形输入导致的深递归与巨型结构。 */
const LIMITS = {
  maxDepth: 12,
  maxKeys: 500,
  maxLines: 5000,
} as const;

/**
 * 递归解析一个缩进块。
 *
 * `lines[start]` 起、缩进大于 `parentIndent` 的连续行属于这个块。返回解析结果与
 * 下一个待处理的下标。
 */
function parseBlock(
  lines: readonly Line[],
  start: number,
  parentIndent: number,
  depth: number,
): { value: YamlValue; next: number } {
  if (depth > LIMITS.maxDepth) {
    throw new FrontMatterError(
      `嵌套超过 ${String(LIMITS.maxDepth)} 层，手稿元数据不该这么深`,
      lines[start]?.number ?? 0,
    );
  }

  const first = lines[start];
  if (first === undefined) return { value: {}, next: start };

  const indent = first.indent;

  /* ---------------- 块序列 ---------------- */

  if (first.content.startsWith('- ') || first.content === '-') {
    const items: YamlValue[] = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i] as Line;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new FrontMatterError('列表项缩进不一致', line.number);
      }
      if (!line.content.startsWith('- ') && line.content !== '-') {
        // 同缩进但不是列表项：块结束
        break;
      }
      rejectUnsupported(line);

      const rest = line.content === '-' ? '' : line.content.slice(2).trim();

      /*
       * `- key: value` 形式：列表项是一个映射，而它的第一个键与 `-` 同行。
       *
       * 这是作者列表最常见的写法，因此必须支持。做法是把这一行当成映射的第一个
       * 键值对，然后把后续更深缩进的行也并入同一个映射。
       */
      const inlineKey = rest === '' ? null : splitKeyValue(rest, line.number);
      if (inlineKey !== null) {
        const map: Record<string, YamlValue> = {};
        // `- name: Jane` 里 `name` 的有效缩进是 `-` 之后的位置
        const mapIndent = indent + 2;

        if (inlineKey.value === '') {
          // `- name:` 后面跟嵌套块
          const nested = parseBlock(lines, i + 1, mapIndent - 1, depth + 1);
          map[inlineKey.key] = nested.value;
          i = nested.next;
        } else {
          map[inlineKey.key] = parseInlineValue(inlineKey.value, line.number);
          i += 1;
        }

        // 收拢同属这个列表项的后续键
        while (i < lines.length) {
          const kid = lines[i] as Line;
          if (kid.indent < mapIndent) break;
          rejectUnsupported(kid);
          const kv = splitKeyValue(kid.content, kid.number);
          if (kv === null) {
            throw new FrontMatterError(
              `列表项里的这一行不是 key: value：${kid.content}`,
              kid.number,
            );
          }
          if (kv.value === '') {
            const nested = parseBlock(lines, i + 1, kid.indent, depth + 1);
            map[kv.key] = nested.value;
            i = nested.next;
          } else {
            map[kv.key] = parseInlineValue(kv.value, kid.number);
            i += 1;
          }
        }

        items.push(map);
        continue;
      }

      // 标量列表项
      items.push(rest === '' ? '' : parseInlineValue(rest, line.number));
      i += 1;
    }

    return { value: items, next: i };
  }

  /* ---------------- 映射 ---------------- */

  const map: Record<string, YamlValue> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent <= parentIndent) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new FrontMatterError('缩进不一致（同一层的键必须对齐）', line.number);
    }
    rejectUnsupported(line);

    const kv = splitKeyValue(line.content, line.number);
    if (kv === null) {
      throw new FrontMatterError(`这一行不是 key: value：${line.content}`, line.number);
    }

    if (Object.keys(map).length >= LIMITS.maxKeys) {
      throw new FrontMatterError(`键数量超过 ${String(LIMITS.maxKeys)}`, line.number);
    }
    if (kv.key in map) {
      // 重复键报错而不是后者覆盖前者：覆盖是静默的数据丢失
      throw new FrontMatterError(`键 ${kv.key} 重复出现`, line.number);
    }

    /* 块标量：`|` 保留换行，`>` 折叠换行。摘要与致谢需要它 */
    if (kv.value === '|' || kv.value === '|-' || kv.value === '>' || kv.value === '>-') {
      const fold = kv.value.startsWith('>');
      const collected: string[] = [];
      let j = i + 1;
      // 块标量的内容不能跳过空行（空行是段落分隔），因此这里要看原始行
      while (j < lines.length && (lines[j] as Line).indent > indent) {
        collected.push((lines[j] as Line).content);
        j += 1;
      }
      map[kv.key] = fold ? collected.join(' ') : collected.join('\n');
      i = j;
      continue;
    }

    if (kv.value === '') {
      const nested = parseBlock(lines, i + 1, indent, depth + 1);
      map[kv.key] = nested.value;
      i = nested.next;
      continue;
    }

    map[kv.key] = parseInlineValue(kv.value, line.number);
    i += 1;
  }

  return { value: map, next: i };
}

/** 拆 `key: value`。冒号在引号内不算分隔符。 */
function splitKeyValue(text: string, lineNumber: number): { key: string; value: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':') {
      // `http://x` 里的冒号：后面必须是空白或行尾才算键值分隔
      const next = text[i + 1];
      if (next !== undefined && next !== ' ' && next !== '\t') continue;
      const key = text
        .slice(0, i)
        .trim()
        .replace(/^["']|["']$/gu, '');
      if (key === '') throw new FrontMatterError('键名为空', lineNumber);
      return { key, value: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseInlineValue(raw: string, lineNumber: number): YamlValue {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) return parseFlowSequence(text, lineNumber);
  if (text.startsWith('{')) {
    throw new FrontMatterError('不支持流式映射 {}，请用缩进写法', lineNumber);
  }
  return parseScalar(text);
}

/**
 * 剥离并解析手稿的 front matter。
 *
 * 只认文件开头的 `---` 块。没有 front matter 时返回空元数据而不是报错——一份还在
 * 起草的手稿可能只有正文，而那时报错会让 `compile` 完全无法使用。
 */
export function parseManuscriptFrontMatter(source: string): ParsedFrontMatter {
  const text = source.replace(/^\uFEFF/u, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);

  if (match === null) {
    return { meta: {}, body: text, present: false, bodyStartLine: 1 };
  }

  const block = match[1] ?? '';
  const lines = tokenize(block);
  if (lines.length > LIMITS.maxLines) {
    throw new FrontMatterError(`front matter 超过 ${String(LIMITS.maxLines)} 行`, 0);
  }

  const parsed = lines.length === 0 ? { value: {} as YamlValue } : parseBlock(lines, 0, -1, 0);
  const meta =
    typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? (parsed.value as YamlMap)
      : {};

  // front matter 块占的行数 = 分隔线 2 行 + 块内行数
  const headerLines = match[0].split(/\r?\n/u).length;

  return {
    meta,
    body: text.slice(match[0].length),
    present: true,
    bodyStartLine: headerLines,
  };
}

/* ------------------------------------------------------------------ *
 * 取值助手
 * ------------------------------------------------------------------ */

export function asString(value: YamlValue | undefined): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

export function asNumber(value: YamlValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asBoolean(value: YamlValue | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === 'yes' || lower === '是';
  }
  return false;
}

/**
 * 取字符串数组。
 *
 * 单个标量也当成一元数组：`keywords: sleep` 与 `keywords: [sleep]` 在用户看来
 * 是同一件事，而报错会让他去查语法。
 */
export function asStringList(value: YamlValue | undefined): readonly string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((v) => asString(v)).filter((v): v is string => v !== null);
  }
  const single = asString(value);
  return single === null ? [] : [single];
}

/** 取映射数组。标量项会被跳过并不报错——调用方按缺字段处理更有用。 */
export function asMapList(value: YamlValue | undefined): readonly YamlMap[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is YamlMap => typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}
