/**
 * 手稿编译（任务 13.6，需求 13.5-13.8）。
 *
 * 四件事：
 *
 * 1. **编译为目标期刊格式**（需求 13.5）：按档案的引用样式重排引用与参考文献、
 *    检查字数限制、检查图表编号规范。
 * 2. **双盲送审版**（需求 13.6）：按结构化元数据移除作者、机构、致谢、基金号。
 * 3. **自引身份泄露检测**（需求 13.7）：正文里的自我指代引用，且该引用的作者与
 *    本文作者有交集。
 * 4. **明示局限**（需求 13.8）：双盲处理基于结构化元数据，对正文里的隐式身份线索
 *    不作保证。这句话进编译报告与输出文件的头部，不是脚注。
 *
 * 两条贯穿的决策：
 *
 * - **检查而不自动改**。字数超了、章节顺序不符、图编号有缺口——全部报告，不动手改。
 *   自动删字会毁掉论证，自动重排章节会打乱交叉引用。唯一自动做的是引用重编号，
 *   因为那是纯机械的映射且不改变任何语义。
 *
 * - **双盲处理只删结构化字段，绝不改正文**。在正文里做正则替换（把作者姓氏换成
 *   「Author」）看起来更彻底，实际是灾难：它会命中同名的被引作者、会破坏
 *   「Smith-Waterman 算法」这类专有名词，而且改动无法被审阅。因此正文里的身份
 *   线索只**报告**，由作者自己决定怎么改——这也是需求 13.8 要明示的那件事。
 */

import type { RefRecord } from '../repo/refs.js';
import { familyKey, normalizeTitle } from '../refs/csl.js';
import type { ExportFormat } from '../refs/export.js';
import { assignKeys, exportRefs } from '../refs/export.js';
import type { CitationMarker, ManuscriptDocument } from './document.js';
import { authorNames, countWords, resolveAbstract } from './document.js';
import type { CitationStyleFamily, JournalProfile } from './journals.js';
import { describeProfile } from './journals.js';

/* ------------------------------------------------------------------ *
 * 结果类型
 * ------------------------------------------------------------------ */

export type CompileIssueSeverity = 'error' | 'warn' | 'info';

/** 一条编译问题。指向具体位置，否则用户无从下手。 */
export interface CompileIssue {
  severity: CompileIssueSeverity;
  /** 归类，用于分组显示。 */
  category: 'length' | 'numbering' | 'citation' | 'structure' | 'metadata' | 'blinding';
  message: string;
  /** 原文行号。与位置无关的问题为 null。 */
  line: number | null;
  /** 可执行的下一步。 */
  remedy: string | null;
}

/** 自引泄露的一条记录（需求 13.7）。 */
export interface SelfCitationLeak {
  /** 正文里的那句话。 */
  sentence: string;
  line: number;
  /** 触发判定的自我指代措辞。 */
  phrase: string;
  /** 引用键。 */
  keys: readonly string[];
  /** 与本文作者重合的姓氏。 */
  sharedAuthors: readonly string[];
  /** 被引文献的一行引用。解析不到时为 null。 */
  citedWork: string | null;
}

export interface CompileResult {
  /** 编译出的手稿正文。 */
  content: string;
  /** 参考文献文件内容（按档案的引用样式）。没有文献时为 null。 */
  bibliography: string | null;
  bibliographyFilename: string | null;
  /** 用的档案。 */
  profile: JournalProfile;
  profileMatched: boolean;
  /** 是否是双盲送审版。 */
  blinded: boolean;
  /** 双盲版里被移除的字段清单。必须给出——用户要能核对删对了没有。 */
  removedFields: readonly string[];
  /** 自引泄露（需求 13.7）。 */
  selfCitationLeaks: readonly SelfCitationLeak[];
  issues: readonly CompileIssue[];
  /** 字数统计。 */
  counts: ManuscriptDocument['counts'];
  /** 引用键 → 输出里的编号或键。 */
  citationMap: Readonly<Record<string, string>>;
  /** 面向用户的编译报告。 */
  report: string;
}

export interface CompileOptions {
  profile: JournalProfile;
  profileMatched?: boolean;
  /** 生成双盲送审版（需求 13.6）。 */
  blinded?: boolean;
  /** 可用的文献条目。用于渲染参考文献与自引检测。 */
  refs?: readonly RefRecord[];
  /** 参考文献的导出格式。省略时按档案的引用样式选。 */
  bibliographyFormat?: ExportFormat;
  /** 输出文件名主干。 */
  stem?: string;
}

/* ------------------------------------------------------------------ *
 * 自引检测
 * ------------------------------------------------------------------ */

/**
 * 自我指代的措辞。
 *
 * 这一组决定了需求 13.7 的召回率，因此列得比较宽。误报的代价小（用户看一眼就知道
 * 那句话不是自引），漏报的代价大（一次身份泄露可能导致双盲送审被判无效，而作者
 * 到收到拒稿信才知道）。
 *
 * 中英都要有：中文稿投英文期刊时正文可能仍是中文草稿，而作者会在最后翻译——
 * 那时自引措辞已经写进去了。
 */
const SELF_REFERENCE_PATTERNS: readonly { re: RegExp; label: string }[] = [
  {
    re: /\bour\s+(?:previous|prior|earlier|recent|own)\s+(?:work|study|studies|paper|papers|report|analysis|results?|findings?)/iu,
    label: 'our previous work',
  },
  {
    re: /\bwe\s+(?:previously|earlier|recently|have\s+previously)\s+(?:showed|shown|reported|demonstrated|found|described|published|developed|introduced)/iu,
    label: 'we previously showed',
  },
  { re: /\bin\s+our\s+(?:previous|prior|earlier|recent)\s+\w+/iu, label: 'in our previous …' },
  {
    re: /\bas\s+we\s+(?:previously|earlier|have)\s+(?:showed|shown|reported|described|demonstrated)/iu,
    label: 'as we previously showed',
  },
  { re: /\b(?:our|the\s+present\s+authors[’']?)\s+group\b/iu, label: 'our group' },
  { re: /\bwe\s+(?:extend|extended|build\s+on|built\s+on)\s+our\b/iu, label: 'we build on our …' },
  {
    re: /\b(?:this|the)\s+(?:is\s+a\s+)?(?:follow[- ]?up|continuation)\s+(?:of|to)\s+our\b/iu,
    label: 'follow-up of our …',
  },
  // 中文
  {
    re: /(?:我们|本课题组|本研究组|本实验室|笔者)(?:此前|之前|先前|早期|近期|曾)/u,
    label: '我们此前',
  },
  {
    re: /(?:我们|本课题组|本研究组)的?(?:前期|先前|此前|早期)(?:工作|研究|报道|结果|发现)/u,
    label: '我们的前期工作',
  },
  {
    re: /(?:如|正如)(?:我们|本课题组)(?:此前|之前|先前)?(?:所)?(?:报道|证明|发现|指出)/u,
    label: '如我们此前报道',
  },
  {
    re: /本(?:文|研究)是.{0,10}(?:我们|本课题组).{0,10}(?:工作|研究)的?(?:延续|后续)/u,
    label: '本研究是我们工作的延续',
  },
];

/**
 * 检测自引造成的身份泄露（需求 13.7）。
 *
 * 判定要**两个条件同时成立**：
 *
 * 1. 句子里有自我指代措辞（`our previous work`、`我们此前`）。
 * 2. 该句里引用的文献，其作者与本文作者有交集。
 *
 * 只看第一条会误报（「our previous work」后面引的可能确实是自己的工作，但作者
 * 列表完全不同——比如引的是合作者独立发表的）；只看第二条会大量误报（引自己的
 * 文献本身完全正常，双盲送审也允许，问题只在于用「我们此前」的措辞把它标出来）。
 *
 * 姓氏比对用 `familyKey` 归一化，因此 `Müller` 与 `Muller` 算同一人。
 */
export function detectSelfCitationLeaks(input: {
  doc: ManuscriptDocument;
  /** 引用键 → 文献条目。 */
  refByKey: ReadonlyMap<string, RefRecord>;
}): readonly SelfCitationLeak[] {
  const authors = authorNames(input.doc);
  if (authors.length === 0) return [];

  const authorKeys = new Set(
    authors
      .map((name) => surnameOf(name))
      .map((surname) => normalizeTitle(surname))
      .filter((key) => key !== ''),
  );
  if (authorKeys.size === 0) return [];

  const leaks: SelfCitationLeak[] = [];
  const seen = new Set<string>();

  for (const citation of input.doc.citations) {
    const phrase = SELF_REFERENCE_PATTERNS.find((p) => p.re.test(citation.sentence));
    if (phrase === undefined) continue;

    const shared = new Set<string>();
    let citedWork: string | null = null;

    for (const key of citation.keys) {
      const ref = input.refByKey.get(key);
      if (ref === undefined) continue;
      for (const author of ref.csl.author ?? []) {
        const key2 = familyKey(author);
        if (key2 !== '' && authorKeys.has(key2))
          shared.add(author.family ?? author.literal ?? key2);
      }
      if (shared.size > 0 && citedWork === null) {
        citedWork = `${ref.firstAuthor ?? '?'} ${String(ref.year ?? 0)} 《${(ref.csl.title ?? '').slice(0, 80)}》`;
      }
    }

    if (shared.size === 0) continue;

    // 同一句里多个引用标记时只报一次
    const dedupeKey = `${String(citation.line)}:${citation.sentence.slice(0, 60)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    leaks.push({
      sentence: citation.sentence.slice(0, 400),
      line: citation.line,
      phrase: phrase.label,
      keys: citation.keys,
      sharedAuthors: [...shared],
      citedWork,
    });
  }

  return leaks;
}

/**
 * 从姓名里取姓氏。
 *
 * 两种格式：`Smith, John`（姓在前）与 `John Smith`（名在前）。有逗号时取逗号前，
 * 否则取最后一个词。中文名（`张伟`）整体作为姓氏——按最后一个字取姓是错的。
 */
export function surnameOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  if (/[\u4e00-\u9fff]/u.test(trimmed)) return trimmed.replace(/\s+/gu, '');
  if (trimmed.includes(',')) return (trimmed.split(',')[0] ?? '').trim();
  const parts = trimmed.split(/\s+/u).filter((p) => p !== '');
  return parts[parts.length - 1] ?? '';
}

/* ------------------------------------------------------------------ *
 * 引用重编号
 * ------------------------------------------------------------------ */

/**
 * 按档案的引用样式给引用键分配输出形式。
 *
 * - `numeric-citation-order`：按正文首次出现顺序编号。这是唯一需要「读一遍正文」
 *   才能确定的样式，也是最容易手工弄错的——因此它是这个函数存在的主要理由。
 * - `numeric-alphabetical`：按第一作者姓氏字母序编号。
 * - `author-year`：不编号，输出 `(Smith et al., 2023)`。
 *
 * 返回的映射覆盖正文里出现过的**全部**键，包括在文献库里找不到的那些——后者会
 * 在 issues 里被报出来，但不能因此从映射里消失，否则正文里那个标记会变成空白。
 */
export function buildCitationMap(input: {
  citations: readonly CitationMarker[];
  refByKey: ReadonlyMap<string, RefRecord>;
  style: CitationStyleFamily;
}): { map: Map<string, string>; order: readonly string[] } {
  const firstAppearance: string[] = [];
  const seen = new Set<string>();
  for (const citation of input.citations) {
    for (const key of citation.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      firstAppearance.push(key);
    }
  }

  const map = new Map<string, string>();

  if (input.style === 'author-year') {
    for (const key of firstAppearance) {
      const ref = input.refByKey.get(key);
      map.set(key, ref === undefined ? `(${key})` : authorYearLabel(ref));
    }
    return { map, order: firstAppearance };
  }

  const order =
    input.style === 'numeric-alphabetical'
      ? [...firstAppearance].sort((a, b) => {
          const left = input.refByKey.get(a);
          const right = input.refByKey.get(b);
          const leftKey = `${left?.firstAuthor ?? '~'}${String(left?.year ?? 9999)}`;
          const rightKey = `${right?.firstAuthor ?? '~'}${String(right?.year ?? 9999)}`;
          return leftKey.localeCompare(rightKey);
        })
      : firstAppearance;

  for (const [index, key] of order.entries()) map.set(key, String(index + 1));
  return { map, order };
}

function authorYearLabel(ref: RefRecord): string {
  const authors = ref.csl.author ?? [];
  const year = ref.year === null ? 'n.d.' : String(ref.year);
  if (authors.length === 0) return `(Anon., ${year})`;
  const first = authors[0]?.family ?? authors[0]?.literal ?? '?';
  if (authors.length === 1) return `(${first}, ${year})`;
  if (authors.length === 2) {
    return `(${first} & ${authors[1]?.family ?? authors[1]?.literal ?? '?'}, ${year})`;
  }
  return `(${first} et al., ${year})`;
}

/**
 * 把正文里的引用标记替换成输出形式。
 *
 * 数字样式下 `[3,5-7]` 要重新展开再合并成新的连续区间——直接替换每个数字会得到
 * `[7,2-4]` 这种乱序，而期刊的排版软件不会替你排序。
 */
function rewriteCitations(
  body: string,
  map: ReadonlyMap<string, string>,
  style: CitationStyleFamily,
): string {
  const numeric = style !== 'author-year';

  let out = body;

  // `\cite{a,b}` 与 `@key`
  out = out.replace(/\\cite[tp]?\*?(?:\[[^\]]*\])*\{([^}]+)\}/gu, (whole, inner: string) => {
    const keys = inner
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');
    const rendered = keys.map((k) => map.get(k) ?? k);
    if (rendered.length === 0) return whole;
    return numeric ? `[${compactNumericRange(rendered)}]` : rendered.join('; ');
  });

  out = out.replace(/(?<![\w@])@([A-Za-z][\w:.#$%&+?<>~/-]*)/gu, (whole, key: string) => {
    const rendered = map.get(key);
    if (rendered === undefined) return whole;
    return numeric ? `[${rendered}]` : rendered;
  });

  // `[3,5-7]`：只在数字样式下重写；作者年份样式下把它换成作者年份
  out = out.replace(/\[([\d\s,;–-]+)\]/gu, (whole, inner: string) => {
    const keys = expandNumericKeys(inner);
    if (keys.length === 0) return whole;
    const rendered = keys.map((k) => map.get(k) ?? k);
    return numeric ? `[${compactNumericRange(rendered)}]` : rendered.join('; ');
  });

  return out;
}

function expandNumericKeys(inner: string): readonly string[] {
  const keys: string[] = [];
  for (const part of inner.split(/[,;]/u)) {
    const range = /^\s*(\d+)\s*[–-]\s*(\d+)\s*$/u.exec(part);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from < 200) {
        for (let n = from; n <= to; n += 1) keys.push(String(n));
      }
      continue;
    }
    const single = part.trim();
    if (/^\d+$/u.test(single)) keys.push(single);
  }
  return keys;
}

/** 把 `1,2,3,7` 合成 `1-3,7`。三个以上连续才合并——两个连续写成区间反而更长。 */
function compactNumericRange(values: readonly string[]): string {
  const numbers = values
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  if (numbers.length !== values.length) return values.join(',');

  const unique = [...new Set(numbers)];
  const parts: string[] = [];
  let start = 0;

  for (let i = 1; i <= unique.length; i += 1) {
    const isBreak = i === unique.length || (unique[i] as number) !== (unique[i - 1] as number) + 1;
    if (!isBreak) continue;
    const from = unique[start] as number;
    const to = unique[i - 1] as number;
    if (to - from >= 2) parts.push(`${String(from)}-${String(to)}`);
    else for (let n = from; n <= to; n += 1) parts.push(String(n));
    start = i;
  }

  return parts.join(',');
}

/* ------------------------------------------------------------------ *
 * 检查
 * ------------------------------------------------------------------ */

function checkLengths(
  doc: ManuscriptDocument,
  profile: JournalProfile,
  issues: CompileIssue[],
): void {
  const limits = profile.limits;
  const zh = (doc.meta.language ?? '').toLowerCase().startsWith('zh');
  const unit = zh ? '字' : '词';

  const check = (
    actual: number,
    limit: number | null,
    label: string,
    line: number | null,
  ): void => {
    if (limit === null || actual <= limit) return;
    const over = actual - limit;
    issues.push({
      severity: 'warn',
      category: 'length',
      message:
        `${label}有 ${String(actual)} ${unit}，按 ${profile.name} 档案的上限 ${String(limit)} ${unit}` +
        `超出 ${String(over)}（约 ${String(Math.round((over / limit) * 100))}%）`,
      line,
      remedy:
        `需要压缩约 ${String(over)} ${unit}。` +
        '注意：这个上限来自内置档案，可能与该刊当前的作者指南不同，改稿前先核对官方要求。',
    });
  };

  const abstract = resolveAbstract(doc);
  check(doc.counts.title, limits.titleWords, '标题', null);
  check(
    abstract.text === null ? 0 : countWords(abstract.text),
    limits.abstractWords,
    '摘要',
    abstract.source === 'section'
      ? (doc.sections.find((s) => /^(?:abstract|摘要)$/iu.test(s.title.trim()))?.line ?? null)
      : null,
  );
  check(doc.counts.body, limits.bodyWords, '正文', null);
  check(doc.counts.keywords, limits.keywords, '关键词', null);
  check(doc.counts.figures + doc.counts.tables, limits.displayItems, '图表总数', null);
  check(doc.counts.distinctCitations, limits.references, '参考文献', null);
}

/**
 * 图表编号规范检查（需求 13.5）。
 *
 * 四类问题，每类都能让编辑部退稿：编号有缺口、编号重复、图题标签与档案不符、
 * 图表在正文里从未被引用。最后一条最常见——作者删了一段正文却忘了删对应的图。
 */
function checkNumbering(
  doc: ManuscriptDocument,
  profile: JournalProfile,
  issues: CompileIssue[],
): void {
  for (const [kind, items] of [
    ['figure', doc.figures],
    ['table', doc.tables],
  ] as const) {
    if (items.length === 0) continue;

    const label = kind === 'figure' ? profile.numbering.figureLabel : profile.numbering.tableLabel;
    const numbers = items.map((item) => item.number).filter((n): n is number => n !== null);

    const counts = new Map<number, number>();
    for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [number, count] of counts) {
      if (count <= 1) continue;
      issues.push({
        severity: 'error',
        category: 'numbering',
        message: `${label} ${String(number)} 出现了 ${String(count)} 次`,
        line: items.find((i) => i.number === number)?.line ?? null,
        remedy: '重复编号会让正文里的交叉引用指向不确定的对象。重新编号。',
      });
    }

    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    for (let expected = 1; expected <= (sorted[sorted.length - 1] ?? 0); expected += 1) {
      if (sorted.includes(expected)) continue;
      issues.push({
        severity: 'error',
        category: 'numbering',
        message: `${label}编号缺 ${String(expected)}`,
        line: null,
        remedy: '编号必须从 1 开始连续。缺号通常是删了一个图表但没有重新编号。',
      });
    }

    /*
     * 编号顺序要与正文出现顺序一致。
     *
     * 「Figure 2 在 Figure 1 之前出现」在多数期刊是硬性问题：图表按正文首次引用
     * 顺序编号是排版惯例。
     */
    for (let i = 1; i < items.length; i += 1) {
      const previous = items[i - 1] as (typeof items)[number];
      const current = items[i] as (typeof items)[number];
      if (previous.number === null || current.number === null) continue;
      if (current.number > previous.number) continue;
      issues.push({
        severity: 'warn',
        category: 'numbering',
        message:
          `${label} ${String(current.number)} 出现在 ${label} ${String(previous.number)} 之后，` +
          '编号与正文出现顺序不一致',
        line: current.line,
        remedy: '图表按正文首次出现顺序编号。调整编号或调整位置。',
      });
    }

    /* 从未被正文引用的图表 */
    const refPattern =
      kind === 'figure'
        ? /\b(?:Fig(?:ure)?s?\.?|图)\s*([0-9０-９]+(?:\s*[-–,和与、]\s*[0-9０-９]+)*)/giu
        : /\b(?:Tables?|表)\s*([0-9０-９]+(?:\s*[-–,和与、]\s*[0-9０-９]+)*)/giu;

    /*
     * 图题行本身不算「正文引用了它」。
     *
     * `**Figure 1.** Analysis pipeline` 这一行含 `Figure 1`，不排除的话每个图都会
     * 被算成已被引用——于是「从未被引用」这条检查永远不会触发，而它抓的正是
     * 最常见的问题（删了一段正文却忘了删对应的图）。
     */
    const captionLines = new Set([...doc.figures, ...doc.tables].map((item) => item.line));

    const cited = new Set<number>();
    for (const section of doc.sections) {
      for (const [lineIndex, line] of section.lines.entries()) {
        // section.lines 不含标题行，因此第一行的行号是 section.line + 1
        if (captionLines.has(section.line + lineIndex + 1)) continue;
        refPattern.lastIndex = 0;
        for (const match of line.matchAll(refPattern)) {
          for (const token of (match[1] ?? '').split(/[-–,和与、]/u)) {
            const parsed = Number.parseInt(
              token.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)),
              10,
            );
            if (Number.isInteger(parsed)) cited.add(parsed);
          }
        }
      }
    }

    for (const item of items) {
      if (item.number === null) continue;
      if (cited.has(item.number)) continue;
      issues.push({
        severity: 'warn',
        category: 'numbering',
        message: `${label} ${String(item.number)} 在正文里从未被引用`,
        line: item.line,
        remedy: '每个图表都应当在正文里被提到。常见成因是删了一段正文但忘了删对应的图表。',
      });
    }
  }

  /* 图题为空 */
  for (const item of [...doc.figures, ...doc.tables]) {
    if (item.caption.trim() !== '') continue;
    issues.push({
      severity: 'warn',
      category: 'numbering',
      message: `${item.kind === 'figure' ? '图' : '表'} ${String(item.number ?? 0)} 没有图题`,
      line: item.line,
      remedy: '图表必须有说明文字，读者要能不看正文就理解它。',
    });
  }
}

function checkStructure(
  doc: ManuscriptDocument,
  profile: JournalProfile,
  issues: CompileIssue[],
): void {
  const titles = doc.sections.filter((s) => s.level <= 2).map((s) => s.title.trim());

  /*
   * 章节顺序只报告不重排。
   *
   * 判据是「档案里的章节在手稿里的相对顺序」而不是「完全一致」：手稿会有档案里
   * 没有的章节（Related Work、Limitations），要求完全一致会在每一份稿子上误报。
   */
  const present = profile.sectionOrder.filter((expected) =>
    titles.some((title) => sectionMatches(title, expected)),
  );
  const positions = present.map((expected) =>
    titles.findIndex((title) => sectionMatches(title, expected)),
  );
  for (let i = 1; i < positions.length; i += 1) {
    if ((positions[i] as number) > (positions[i - 1] as number)) continue;
    issues.push({
      severity: 'info',
      category: 'structure',
      message: `章节「${present[i] ?? ''}」出现在「${present[i - 1] ?? ''}」之前，与 ${profile.name} 的惯例顺序不同`,
      line: doc.sections.find((s) => sectionMatches(s.title, present[i] ?? ''))?.line ?? null,
      remedy: '这只是惯例提示。确认该刊是否要求固定顺序——不重排是刻意的，重排会打乱交叉引用。',
    });
  }

  for (const expected of profile.sectionOrder) {
    if (present.some((p) => p === expected)) continue;
    // 参考文献节缺失不报：它通常由编译生成
    if (/^(?:references?|bibliography|参考文献)$/iu.test(expected)) continue;
    issues.push({
      severity: 'info',
      category: 'structure',
      message: `没有找到「${expected}」章节（${profile.name} 的惯例结构里有它）`,
      line: null,
      remedy: '如果该刊要求这一节，补上；如果不要求，忽略这条。',
    });
  }

  if (profile.structuredAbstract) {
    const abstract = resolveAbstract(doc);
    const hasStructure =
      abstract.text !== null &&
      /\b(?:background|objective|methods?|results?|conclusions?)\b\s*[:：]/iu.test(abstract.text);
    if (!hasStructure) {
      issues.push({
        severity: 'warn',
        category: 'structure',
        message: `${profile.name} 要求结构化摘要，但当前摘要里没有小标题`,
        line: null,
        remedy: '按 Background / Methods / Results / Conclusions 分小节改写摘要。',
      });
    }
  }

  for (const statement of profile.requiredStatements) {
    const inMeta = Object.keys(doc.meta.statements).some(
      (key) => normalizeTitle(key) === normalizeTitle(statement),
    );
    const inBody = titles.some((title) => sectionMatches(title, statement));
    const inIdentifying =
      /funding|competing|conflict/iu.test(statement) &&
      (doc.meta.identifying.funding.length > 0 || doc.meta.identifying.conflictOfInterest !== null);
    if (inMeta || inBody || inIdentifying) continue;
    issues.push({
      severity: 'warn',
      category: 'metadata',
      message: `缺少「${statement}」声明（${profile.name} 要求）`,
      line: null,
      remedy: `在 front matter 里加一个对应字段，或在正文末尾加一节。`,
    });
  }
}

/** 章节标题匹配。宽松比较：去标点、小写、允许子串。 */
function sectionMatches(title: string, expected: string): boolean {
  const left = normalizeTitle(title);
  const right = normalizeTitle(expected);
  if (left === '' || right === '') return false;
  return left === right || left.includes(right) || right.includes(left);
}

function checkCitations(
  doc: ManuscriptDocument,
  refByKey: ReadonlyMap<string, RefRecord>,
  issues: CompileIssue[],
): void {
  const missing = new Map<string, number>();
  for (const citation of doc.citations) {
    for (const key of citation.keys) {
      if (refByKey.has(key)) continue;
      if (!missing.has(key)) missing.set(key, citation.line);
    }
  }

  for (const [key, line] of missing) {
    issues.push({
      severity: 'error',
      category: 'citation',
      message: `正文引用了 ${key}，但文献库里没有对应条目`,
      line,
      remedy:
        '用 manage_references 的 resolve 把它加进文献库，或者改正引用键。' +
        '编译出的参考文献列表里不会有这一条，而正文里的标记会留在那里指向空白。',
    });
  }

  /*
   * 撤稿文献。
   *
   * 放在编译这一步报是刻意的：这是投稿前最后一道关口，而引用一篇撤稿文献是
   * 审稿必退的问题。
   */
  const citedKeys = new Set(doc.citations.flatMap((c) => c.keys));
  for (const key of citedKeys) {
    const ref = refByKey.get(key);
    if (ref?.csl.extra?.retracted !== true) continue;
    issues.push({
      severity: 'error',
      category: 'citation',
      message: `引用的文献已被撤稿：${ref.firstAuthor ?? '?'} ${String(ref.year ?? 0)}《${(ref.csl.title ?? '').slice(0, 60)}》`,
      line: doc.citations.find((c) => c.keys.includes(key))?.line ?? null,
      remedy:
        '删掉这条引用，或在正文里明确说明为什么要引用一篇撤稿文献' + '（例如讨论该撤稿事件本身）。',
    });
  }

  /* 文献库里有但正文没引的条目：不算问题，但值得提示 */
  const unusedCount = [...refByKey.keys()].filter((key) => !citedKeys.has(key)).length;
  if (unusedCount > 0) {
    issues.push({
      severity: 'info',
      category: 'citation',
      message: `文献库里有 ${String(unusedCount)} 条文献在正文里没有被引用`,
      line: null,
      remedy: '编译出的参考文献列表只含被引用的条目。未引用的不会出现在里面。',
    });
  }
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 双盲版的免责说明（需求 13.8）。放在输出文件头部而不是脚注。 */
const BLINDING_DISCLAIMER = [
  '<!--',
  '双盲送审版说明（重要）',
  '',
  '本版本移除的是 **front matter 里的结构化字段**：作者、机构、致谢、基金与基金号、',
  '通讯邮箱、作者贡献声明。清单见编译报告。',
  '',
  '**对正文里的隐式身份线索不作任何保证。** 系统没有改动正文一个字——',
  '在正文里做替换会命中同名的被引作者、会破坏「Smith-Waterman」这类专有名词，',
  '而改动无法被审阅。因此以下这些必须由你自己检查：',
  '',
  '  · 自我指代的引用（「我们此前的工作 [12]」）——编译报告里已列出检出的部分',
  '  · 机构内部的数据集名、伦理批号、注册号、集群或服务器名',
  '  · 「本课题组开发的 XXX 工具」这类可唯一定位的表述',
  '  · 图片里的水印、文件路径、机构 logo',
  '  · 补充材料与代码仓库里的作者信息（本编译不处理它们）',
  '  · 致谢里提到的人名如果同时出现在正文的其它位置',
  '',
  '投稿前请自己完整读一遍正文。',
  '-->',
].join('\n');

function renderFrontMatter(
  doc: ManuscriptDocument,
  options: { blinded: boolean; profile: JournalProfile },
): { text: string; removed: readonly string[] } {
  const lines: string[] = ['---'];
  const removed: string[] = [];
  const meta = doc.meta;

  const put = (key: string, value: string | null): void => {
    if (value === null || value.trim() === '') return;
    lines.push(value.includes('\n') ? `${key}: |` : `${key}: ${quoteIfNeeded(value)}`);
    if (value.includes('\n')) {
      for (const line of value.split('\n')) lines.push(`  ${line}`);
    }
  };

  put('title', meta.title);
  put('shortTitle', meta.shortTitle);

  if (options.blinded) {
    /*
     * 身份字段整组移除（需求 13.6）。
     *
     * 逐项记入 removed 而不是只说「已移除作者信息」：用户要能核对删对了没有，
     * 而「已处理」这句话核对不了任何东西。
     */
    if (meta.identifying.authors.length > 0) {
      removed.push(
        `authors（${String(meta.identifying.authors.length)} 位：${meta.identifying.authors.map((a) => a.name).join('、')}）`,
      );
    }
    if (meta.identifying.affiliations.length > 0) {
      removed.push(`affiliations（${String(meta.identifying.affiliations.length)} 条）`);
    }
    if (meta.identifying.acknowledgements !== null) removed.push('acknowledgements');
    if (meta.identifying.funding.length > 0) {
      removed.push(`funding（${meta.identifying.funding.join('；')}）`);
    }
    if (meta.identifying.grantNumbers.length > 0) {
      removed.push(`grantNumbers（${meta.identifying.grantNumbers.join('、')}）`);
    }
    if (meta.identifying.correspondingEmail !== null) removed.push('correspondingEmail');
    if (meta.identifying.authorContributions !== null) removed.push('authorContributions');

    /*
     * 平等贡献标记保留。
     *
     * 它不泄露身份（「第一与第二作者同等贡献」不指向任何人），而删掉它会让
     * 录用后恢复盲审版时丢掉一个作者们很在意的信息。
     */
    const equal = meta.identifying.authors.filter((a) => a.equalContribution).length;
    if (equal > 0) {
      lines.push(`equalContributionCount: ${String(equal)}`);
    }
    lines.push('blinded: true');
  } else {
    if (meta.identifying.authors.length > 0) {
      lines.push('authors:');
      for (const author of meta.identifying.authors) {
        lines.push(`  - name: ${quoteIfNeeded(author.name)}`);
        if (author.affiliations.length > 0) {
          lines.push(`    affiliations: [${author.affiliations.join(', ')}]`);
        }
        if (author.email !== null) lines.push(`    email: ${author.email}`);
        if (author.orcid !== null) lines.push(`    orcid: ${author.orcid}`);
        if (author.corresponding) lines.push('    corresponding: true');
        if (author.equalContribution) lines.push('    equalContribution: true');
      }
    }
    if (meta.identifying.affiliations.length > 0) {
      lines.push('affiliations:');
      for (const affiliation of meta.identifying.affiliations) {
        lines.push(`  - ${quoteIfNeeded(affiliation)}`);
      }
    }
    put('acknowledgements', meta.identifying.acknowledgements);
    if (meta.identifying.funding.length > 0) {
      lines.push(`funding: [${meta.identifying.funding.map(quoteIfNeeded).join(', ')}]`);
    }
    if (meta.identifying.grantNumbers.length > 0) {
      lines.push(`grantNumbers: [${meta.identifying.grantNumbers.map(quoteIfNeeded).join(', ')}]`);
    }
    put('correspondingEmail', meta.identifying.correspondingEmail);
    put('authorContributions', meta.identifying.authorContributions);
  }

  put('abstract', meta.abstract);
  if (meta.keywords.length > 0) {
    lines.push(`keywords: [${meta.keywords.map(quoteIfNeeded).join(', ')}]`);
  }
  put('journal', meta.targetJournal);
  put('articleType', meta.articleType);
  put('language', meta.language);

  // 非身份声明保留（利益冲突在双盲下也保留：它不含人名时不泄露身份）
  for (const [label, text] of Object.entries(meta.statements)) {
    put(label.replace(/\s+/gu, ''), text);
  }
  if (!options.blinded) {
    put('conflictOfInterest', meta.identifying.conflictOfInterest);
  } else if (meta.identifying.conflictOfInterest !== null) {
    /*
     * 利益冲突声明在双盲版里移除。
     *
     * 它常含机构名与资助方（「作者 X 受聘于 Y 公司」），因此不能一概保留。
     * 这一条在双盲版里通常由投稿系统单独收集，不放正文。
     */
    removed.push('conflictOfInterest（常含机构与资助方名称）');
  }

  lines.push(`compiledFor: ${options.profile.id}`);
  lines.push('---');

  return { text: lines.join('\n'), removed };
}

function quoteIfNeeded(value: string): string {
  const text = value.trim();
  return /[:#[\]{}",]/u.test(text) ? `"${text.replace(/"/gu, '\\"')}"` : text;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 编译一份手稿。
 *
 * 纯函数：不碰仓储、不落盘。落成制品由调用方负责，这样编译可以直接单测，
 * 也可以在「预览编译结果」时跑一遍而不产生多余的制品版本。
 */
export function compileManuscript(doc: ManuscriptDocument, options: CompileOptions): CompileResult {
  const profile = options.profile;
  const blinded = options.blinded === true;
  const issues: CompileIssue[] = [];

  for (const warning of doc.warnings) {
    issues.push({
      severity: 'warn',
      category: 'metadata',
      message: warning.message,
      line: warning.line,
      remedy: null,
    });
  }

  /*
   * 建「引用键 → 文献条目」的映射。
   *
   * 正文里的键有两种形态：数字（`[12]`，指参考文献列表的第 12 条）与 BibTeX 键
   * （`\cite{smith2023sleep}`）。前者只有在已有一份确定顺序的文献列表时才有意义，
   * 因此这里按传入 refs 的顺序建立 1 基编号映射；后者按 `bibtexKeyFor` 算。
   */
  const refs = options.refs ?? [];
  const keyed = assignKeys(refs);
  const refByKey = new Map<string, RefRecord>();
  for (const [index, entry] of keyed.entries()) {
    refByKey.set(entry.key, entry.ref);
    refByKey.set(String(index + 1), entry.ref);
    if (entry.ref.doi !== null) refByKey.set(entry.ref.doi, entry.ref);
  }

  checkLengths(doc, profile, issues);
  checkNumbering(doc, profile, issues);
  checkStructure(doc, profile, issues);
  checkCitations(doc, refByKey, issues);

  const selfCitationLeaks = detectSelfCitationLeaks({ doc, refByKey });
  for (const leak of selfCitationLeaks) {
    issues.push({
      severity: blinded ? 'error' : 'warn',
      category: 'blinding',
      message:
        `自引可能泄露身份：「${leak.phrase}」+ 引用了与本文作者重合的文献` +
        `（${leak.sharedAuthors.join('、')}）`,
      line: leak.line,
      remedy:
        '改成中性表述：把「我们此前的工作 [12]」改成「此前有研究 [12]」或' +
        '「Smith 等 [12]」。' +
        (blinded
          ? '双盲送审下这是硬问题——编辑部会因为身份泄露判定盲审无效。'
          : '如果最终投双盲期刊，这一条要改。'),
    });
  }

  const { map: citationMap } = buildCitationMap({
    citations: doc.citations,
    refByKey,
    style: profile.citationStyle,
  });

  const rewrittenBody = rewriteCitations(doc.body, citationMap, profile.citationStyle);
  const front = renderFrontMatter(doc, { blinded, profile });

  const parts: string[] = [front.text];
  if (blinded) {
    parts.push('');
    parts.push(BLINDING_DISCLAIMER);
  }
  parts.push(rewrittenBody.replace(/^\n+/u, ''));

  /* 参考文献 */
  const citedKeys = new Set(doc.citations.flatMap((c) => c.keys));
  const citedRefs = keyed
    .filter((entry) => citedKeys.has(entry.key) || citedKeys.has(String(keyed.indexOf(entry) + 1)))
    .map((entry) => entry.ref);
  const bibFormat =
    options.bibliographyFormat ?? (profile.citationStyle === 'author-year' ? 'csl-json' : 'bibtex');

  const bibliography =
    citedRefs.length === 0
      ? null
      : exportRefs(citedRefs, {
          format: bibFormat,
          stem: `${options.stem ?? 'manuscript'}-references`,
          sort: profile.citationStyle === 'numeric-citation-order' ? 'key' : 'author-year',
        });

  return {
    content: `${parts.join('\n')}\n`,
    bibliography: bibliography?.content ?? null,
    bibliographyFilename: bibliography?.filename ?? null,
    profile,
    profileMatched: options.profileMatched ?? true,
    blinded,
    removedFields: front.removed,
    selfCitationLeaks,
    issues,
    counts: doc.counts,
    citationMap: Object.fromEntries(citationMap),
    report: renderReport({
      doc,
      profile,
      profileMatched: options.profileMatched ?? true,
      blinded,
      removed: front.removed,
      issues,
      leaks: selfCitationLeaks,
      citedCount: citedRefs.length,
    }),
  };
}

const SEVERITY_LABEL: Readonly<Record<CompileIssueSeverity, string>> = {
  error: '必须处理',
  warn: '建议处理',
  info: '提示',
};

const CATEGORY_LABEL: Readonly<Record<CompileIssue['category'], string>> = {
  length: '篇幅',
  numbering: '图表编号',
  citation: '引用',
  structure: '结构',
  metadata: '元数据',
  blinding: '双盲',
};

function renderReport(input: {
  doc: ManuscriptDocument;
  profile: JournalProfile;
  profileMatched: boolean;
  blinded: boolean;
  removed: readonly string[];
  issues: readonly CompileIssue[];
  leaks: readonly SelfCitationLeak[];
  citedCount: number;
}): string {
  const lines: string[] = [describeProfile(input.profile, input.profileMatched), ''];

  const zh = (input.doc.meta.language ?? '').toLowerCase().startsWith('zh');
  const unit = zh ? '字' : '词';
  lines.push(
    `字数：标题 ${String(input.doc.counts.title)}${unit}，` +
      `摘要 ${String(input.doc.counts.abstract)}${unit}，` +
      `正文 ${String(input.doc.counts.body)}${unit}（不含摘要、图题与参考文献）`,
  );
  lines.push(
    `图表：${String(input.doc.counts.figures)} 图、${String(input.doc.counts.tables)} 表；` +
      `引用：${String(input.doc.counts.distinctCitations)} 个不同键，参考文献列表 ${String(input.citedCount)} 条`,
  );

  if (input.blinded) {
    lines.push('');
    lines.push('## 双盲处理');
    lines.push('');
    if (input.removed.length === 0) {
      lines.push(
        '没有移除任何字段——front matter 里没有作者、机构、致谢或基金信息。' +
          '这通常意味着元数据还没写，而不是这份稿子本来就匿名。',
      );
    } else {
      lines.push('已移除的结构化字段：');
      for (const field of input.removed) lines.push(`  · ${field}`);
    }
    lines.push('');
    /*
     * 需求 13.8：必须明确告知局限。
     *
     * 这段话在报告与输出文件里各出现一次。重复是刻意的：只放在文件里的话，
     * 用户在界面上看编译报告时看不到；只放在报告里的话，把文件发给合作者时
     * 那句话就丢了。
     */
    lines.push(
      '**双盲处理只作用于 front matter 的结构化字段，正文一个字都没改。**',
      '对正文里的隐式身份线索（自我指代的引用、机构内部数据集名、伦理批号、',
      '注册号、集群名、图片水印、代码仓库里的作者信息）不作任何保证——',
      '这些必须由你自己读一遍正文来检查。输出文件的头部有完整清单。',
    );
  }

  if (input.leaks.length > 0) {
    lines.push('');
    lines.push(`## 自引身份泄露（${String(input.leaks.length)} 处）`);
    lines.push('');
    for (const leak of input.leaks) {
      lines.push(`第 ${String(leak.line)} 行　触发措辞「${leak.phrase}」`);
      lines.push(`  ${leak.sentence}`);
      lines.push(
        `  引用 ${leak.keys.join('、')}，与本文作者重合：${leak.sharedAuthors.join('、')}`,
      );
      if (leak.citedWork !== null) lines.push(`  被引文献：${leak.citedWork}`);
    }
  }

  const byCategory = new Map<CompileIssue['category'], CompileIssue[]>();
  for (const issue of input.issues) {
    if (issue.category === 'blinding') continue;
    const list = byCategory.get(issue.category) ?? [];
    list.push(issue);
    byCategory.set(issue.category, list);
  }

  const errors = input.issues.filter((i) => i.severity === 'error').length;
  const warns = input.issues.filter((i) => i.severity === 'warn').length;

  lines.push('');
  lines.push(
    errors === 0 && warns === 0
      ? '## 检查结果：没有需要处理的问题'
      : `## 检查结果：${String(errors)} 项必须处理，${String(warns)} 项建议处理`,
  );

  const order: readonly CompileIssue['category'][] = [
    'citation',
    'numbering',
    'length',
    'structure',
    'metadata',
  ];
  for (const category of order) {
    const list = byCategory.get(category);
    if (list === undefined || list.length === 0) continue;
    lines.push('');
    lines.push(`### ${CATEGORY_LABEL[category]}`);
    for (const issue of list.sort((a, b) => severityRank(a) - severityRank(b))) {
      lines.push(
        `- [${SEVERITY_LABEL[issue.severity]}]${issue.line === null ? '' : ` 第 ${String(issue.line)} 行`} ${issue.message}`,
      );
      if (issue.remedy !== null) lines.push(`    ${issue.remedy}`);
    }
  }

  return lines.join('\n');
}

function severityRank(issue: CompileIssue): number {
  return issue.severity === 'error' ? 0 : issue.severity === 'warn' ? 1 : 2;
}

/** 编译结果的一行摘要，用于工具输出与广播。 */
export function compileSummary(result: CompileResult): string {
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warns = result.issues.filter((i) => i.severity === 'warn').length;
  return (
    `${result.blinded ? '双盲送审版' : '正式版'}　档案 ${result.profile.id}　` +
    `${String(errors)} 项必须处理、${String(warns)} 项建议处理` +
    (result.selfCitationLeaks.length === 0
      ? ''
      : `　自引泄露 ${String(result.selfCitationLeaks.length)} 处`)
  );
}

/** 免责说明常量导出，供测试与 UI 复用同一份文案。 */
export { BLINDING_DISCLAIMER };
