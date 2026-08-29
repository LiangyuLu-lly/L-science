/**
 * 结构化手稿的文档模型（任务 13.6，需求 13.5-13.8）。
 *
 * 手稿的形态是「Markdown + front matter」。这一层把它解析成可编译的结构：
 * 元数据（作者、机构、致谢、基金号——需求 13.6 要按结构移除它们）、章节树、
 * 图表清单、正文里的引用标记、以及各部分的字数。
 *
 * 一条贯穿的设计：**解析结果里的每一项都带原文行号**。编译报告里说「摘要超了
 * 40 词」是没用的，用户要知道是哪一段；说「图 3 在正文里没被引用」也要能跳到
 * 图题那一行。没有行号的报告只能让用户自己全文搜索。
 */

import { splitSentences } from './extract.js';
import type { YamlMap, YamlValue } from './frontmatter.js';
import {
  asBoolean,
  asMapList,
  asNumber,
  asString,
  asStringList,
  parseManuscriptFrontMatter,
} from './frontmatter.js';

/* ------------------------------------------------------------------ *
 * 元数据
 * ------------------------------------------------------------------ */

export interface ManuscriptAuthor {
  name: string;
  /** 机构下标（1 基，指向 `affiliations`）或机构名原文。 */
  affiliations: readonly string[];
  email: string | null;
  orcid: string | null;
  corresponding: boolean;
  /** 平等贡献标记。双盲版要保留它（它不泄露身份）。 */
  equalContribution: boolean;
}

/**
 * 手稿元数据。
 *
 * 字段的划分方式直接对应需求 13.6：`identifying` 里的东西在双盲版里被移除，
 * 其余保留。把它们分在两个字段里而不是靠一张移除清单，是为了让「哪些算身份信息」
 * 这个判断出现在类型上——新增一个元数据字段时，作者必须决定它属于哪一边。
 */
export interface ManuscriptMeta {
  title: string | null;
  shortTitle: string | null;
  abstract: string | null;
  keywords: readonly string[];
  targetJournal: string | null;
  /** 手稿类型（Article / Letter / Review），影响档案选择。 */
  articleType: string | null;
  /** 参考文献来源：`.bib` 文件路径或 `library`（用项目文献库）。 */
  bibliography: string | null;
  /** 语言，`en` 或 `zh`。影响字数统计方式。 */
  language: string | null;

  /**
   * 身份信息。双盲版里整组移除（需求 13.6）。
   *
   * 单独成组是刻意的：新增字段时必须决定它进不进这一组，而那正是双盲处理正确性
   * 的全部所在。散落在顶层的话，加一个 `submittedBy` 字段会静默地泄露身份。
   */
  identifying: {
    authors: readonly ManuscriptAuthor[];
    affiliations: readonly string[];
    acknowledgements: string | null;
    funding: readonly string[];
    /** 基金号。与 funding 分开：有些期刊要求单独列。 */
    grantNumbers: readonly string[];
    correspondingEmail: string | null;
    /** 作者贡献声明（CRediT）。含人名，因此属于身份信息。 */
    authorContributions: string | null;
    /** 数据可得性声明里可能含机构仓储地址，因此也算。 */
    conflictOfInterest: string | null;
  };

  /** 不属于身份信息的声明段落。双盲版保留。 */
  statements: Readonly<Record<string, string>>;

  /** 未识别的字段。原样保留，编译时透传。 */
  extra: Readonly<Record<string, YamlValue>>;
}

/* ------------------------------------------------------------------ *
 * 正文结构
 * ------------------------------------------------------------------ */

export interface ManuscriptSection {
  /** 标题原文（去掉 `#`）。 */
  title: string;
  /** 标题层级，1 是最高。 */
  level: number;
  /** 正文行（不含标题行）。 */
  lines: readonly string[];
  /** 标题在原文里的行号（1 基）。 */
  line: number;
  /** 该节的字数。中文按字符、英文按词，见 `countWords`。 */
  words: number;
}

export interface DisplayItem {
  kind: 'figure' | 'table';
  /** 声明的编号。`Figure 3` 里的 3。取不到时为 null。 */
  number: number | null;
  /** 图题/表题正文。 */
  caption: string;
  /** 出现在原文的行号。 */
  line: number;
  /** 所属章节标题。 */
  section: string | null;
  /** 图片路径或制品占位符（`{{artifact:av_...}}`）。表格为 null。 */
  source: string | null;
}

export interface CitationMarker {
  raw: string;
  /** 数字引用里的编号，或 `\cite{}`/`@key` 里的键。 */
  keys: readonly string[];
  line: number;
  section: string | null;
  /** 该标记所在句子的原文。自引检测要用它判断是否自我指代。 */
  sentence: string;
}

export interface ManuscriptDocument {
  meta: ManuscriptMeta;
  sections: readonly ManuscriptSection[];
  figures: readonly DisplayItem[];
  tables: readonly DisplayItem[];
  citations: readonly CitationMarker[];
  /** 正文（剥掉 front matter）。 */
  body: string;
  /** 各部分字数。 */
  counts: {
    title: number;
    abstract: number;
    /** 正文字数，不含摘要、图题、参考文献。 */
    body: number;
    keywords: number;
    figures: number;
    tables: number;
    /** 正文里出现的不同引用键数量。 */
    distinctCitations: number;
  };
  /** front matter 是否存在。缺失时编译只能做有限的检查。 */
  hasFrontMatter: boolean;
  /** 解析过程中的问题。不阻止编译，但要报告。 */
  warnings: readonly { line: number; message: string }[];
}

/* ------------------------------------------------------------------ *
 * 字数统计
 * ------------------------------------------------------------------ */

/**
 * 统计字数。
 *
 * 中英混排必须分别计：英文按空白分词，中文按字符。把中文按空白分词会得出
 * 「一段八百字的中文摘要只有 3 个词」——然后所有字数检查都失效。
 *
 * 返回值是「英文词数 + 中文字符数」的和。这个口径与期刊的做法一致（中文期刊按字
 * 数、英文期刊按词数），而混排稿件在两种口径下都不会被严重低估。
 *
 * 刻意排除的东西：Markdown 语法记号、引用标记、图题（图题另计）、URL。
 * 期刊统计正文字数时不含这些。
 */
export function countWords(text: string): number {
  const cleaned = text
    // 代码块整段去掉
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    // 链接保留可见文字
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    // 引用标记不算字数
    .replace(/\[[\d\s,;–-]+\]/gu, ' ')
    .replace(/\\cite[tp]?\*?(?:\[[^\]]*\])*\{[^}]*\}/gu, ' ')
    .replace(/(?<![\w@])@[A-Za-z][\w:.#$%&+?<>~/-]*/gu, ' ')
    // 强调与标题记号
    .replace(/[*_#>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (cleaned === '') return 0;

  const cjk = (cleaned.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  // 去掉中日韩字符之后再按空白分词，避免中文段落被算成一个「词」
  const latin = cleaned
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  return cjk + latin;
}

/* ------------------------------------------------------------------ *
 * 元数据解析
 * ------------------------------------------------------------------ */

/** 认作身份信息的 front matter 键。见 `ManuscriptMeta.identifying` 的说明。 */
const IDENTIFYING_KEYS = new Set([
  'authors',
  'author',
  'affiliations',
  'affiliation',
  'acknowledgements',
  'acknowledgments',
  'acknowledgement',
  '致谢',
  'funding',
  'funders',
  '基金',
  '资助',
  'grant',
  'grants',
  'grantnumbers',
  'grant_numbers',
  '基金号',
  'corresponding',
  'correspondingemail',
  'corresponding_email',
  'authorcontributions',
  'author_contributions',
  'credit',
  '作者贡献',
  'conflictofinterest',
  'conflict_of_interest',
  'competinginterests',
  'competing_interests',
  '利益冲突',
]);

/** 已被结构化字段吃掉的键。剩下的进 `extra`。 */
const KNOWN_KEYS = new Set([
  ...IDENTIFYING_KEYS,
  'title',
  'shorttitle',
  'short_title',
  'runningtitle',
  'running_title',
  'abstract',
  '摘要',
  'keywords',
  'keyword',
  '关键词',
  'journal',
  'targetjournal',
  'target_journal',
  '期刊',
  'articletype',
  'article_type',
  'type',
  'bibliography',
  'bib',
  'references',
  'lang',
  'language',
  '语言',
]);

/** 不属于身份信息的声明键。双盲版保留。 */
const STATEMENT_KEYS: Readonly<Record<string, string>> = {
  dataavailability: 'Data availability',
  data_availability: 'Data availability',
  codeavailability: 'Code availability',
  code_availability: 'Code availability',
  ethics: 'Ethics approval',
  ethicsapproval: 'Ethics approval',
  ethics_approval: 'Ethics approval',
  consent: 'Patient consent',
  patientconsent: 'Patient consent',
  registration: 'Trial registration',
  trialregistration: 'Trial registration',
  preregistration: 'Preregistration',
  broaderimpact: 'Broader impact',
  reproducibility: 'Reproducibility statement',
};

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/gu, '');
}

/**
 * 解析作者。
 *
 * 三种写法都要认，因为它们在真实手稿里都出现：
 * - `authors: [Jane Smith, Bob Jones]`（最简，没有机构对应）
 * - 块序列的标量项
 * - 块序列的映射项（带 name/affiliations/email/corresponding）
 *
 * 只支持最后一种的话，一份只写了名字的手稿会解析出零个作者——而双盲版会因此
 * 「没有作者可移除」，看起来处理成功了。
 */
function parseAuthors(
  value: YamlValue | undefined,
  warn: (message: string) => void,
): readonly ManuscriptAuthor[] {
  if (value === undefined) return [];

  const maps = asMapList(value);
  if (maps.length > 0) {
    return maps
      .map((entry): ManuscriptAuthor | null => {
        const name = asString(entry.name) ?? asString(entry.Name) ?? asString(entry['姓名']);
        if (name === null) {
          warn('作者条目缺少 name 字段，已跳过');
          return null;
        }
        const affiliations = asStringList(entry.affiliations ?? entry.affiliation ?? entry['机构']);
        return {
          name,
          affiliations,
          email: asString(entry.email),
          orcid: asString(entry.orcid) ?? asString(entry.ORCID),
          corresponding: asBoolean(entry.corresponding),
          equalContribution:
            asBoolean(entry.equalContribution) ||
            asBoolean(entry.equal) ||
            asBoolean(entry['equal_contribution']),
        };
      })
      .filter((a): a is ManuscriptAuthor => a !== null);
  }

  // 标量列表或单个标量
  return asStringList(value).map((name) => ({
    name,
    affiliations: [],
    email: null,
    orcid: null,
    corresponding: false,
    equalContribution: false,
  }));
}

function parseMeta(meta: YamlMap, warn: (message: string) => void): ManuscriptMeta {
  const byNormalized = new Map<string, YamlValue>();
  const originalKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(meta)) {
    const normalized = normalizeKey(key);
    byNormalized.set(normalized, value);
    originalKeys.set(normalized, key);
  }
  const pick = (...keys: readonly string[]): YamlValue | undefined => {
    for (const key of keys) {
      const found = byNormalized.get(normalizeKey(key));
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const authors = parseAuthors(pick('authors', 'author'), warn);
  const affiliations = asStringList(pick('affiliations', 'affiliation'));

  const statements: Record<string, string> = {};
  const extra: Record<string, YamlValue> = {};

  for (const [normalized, value] of byNormalized) {
    const statementLabel = STATEMENT_KEYS[normalized];
    if (statementLabel !== undefined) {
      const text = asString(value);
      if (text !== null) statements[statementLabel] = text;
      continue;
    }
    if (KNOWN_KEYS.has(normalized)) continue;
    extra[originalKeys.get(normalized) ?? normalized] = value;
  }

  const correspondingFromAuthors = authors.find((a) => a.corresponding)?.email ?? null;

  return {
    title: asString(pick('title')),
    shortTitle: asString(pick('shortTitle', 'runningTitle')),
    abstract: asString(pick('abstract', '摘要')),
    keywords: asStringList(pick('keywords', 'keyword', '关键词')),
    targetJournal: asString(pick('journal', 'targetJournal', '期刊')),
    articleType: asString(pick('articleType', 'type')),
    bibliography: asString(pick('bibliography', 'bib')),
    language: asString(pick('lang', 'language', '语言')),
    identifying: {
      authors,
      affiliations,
      acknowledgements: asString(
        pick('acknowledgements', 'acknowledgments', 'acknowledgement', '致谢'),
      ),
      funding: asStringList(pick('funding', 'funders', '基金', '资助')),
      grantNumbers: asStringList(pick('grantNumbers', 'grants', 'grant', '基金号')),
      correspondingEmail:
        asString(pick('correspondingEmail', 'corresponding')) ?? correspondingFromAuthors,
      authorContributions: asString(pick('authorContributions', 'credit', '作者贡献')),
      conflictOfInterest: asString(pick('conflictOfInterest', 'competingInterests', '利益冲突')),
    },
    statements,
    extra,
  };
}

/* ------------------------------------------------------------------ *
 * 正文解析
 * ------------------------------------------------------------------ */

/** 图题行：`**Figure 1.** caption` / `Figure 1: caption` / `图 1　说明`。 */
const CAPTION_LINE =
  /^\s*(?:\*\*|__)?\s*(Figure|Fig\.?|Table|图|表)\s*([0-9０-９]+)?\s*(?:\*\*|__)?\s*[.:：、．]?\s*(.*)$/u;

/** 图片行：`![alt](path)`。 */
const IMAGE_LINE = /!\[[^\]]*\]\(([^)]+)\)/u;

/** 把全角数字转成半角。中文稿里的「图１」要能解析。 */
function toHalfWidthNumber(text: string): number | null {
  const normalized = text.replace(/[０-９]/gu, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/** 抽取一行里的引用标记。 */
function extractCitationMarkers(line: string): readonly { raw: string; keys: readonly string[] }[] {
  const out: { raw: string; keys: readonly string[] }[] = [];

  for (const match of line.matchAll(/\[([\d\s,;–-]+)\]/gu)) {
    const inner = match[1] ?? '';
    const keys: string[] = [];
    // `[3,5-7]` 要展开成 3,5,6,7：编号连续性检查需要每一个
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
    if (keys.length > 0) out.push({ raw: match[0], keys });
  }

  for (const match of line.matchAll(/\\cite[tp]?\*?(?:\[[^\]]*\])*\{([^}]+)\}/gu)) {
    const keys = (match[1] ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');
    if (keys.length > 0) out.push({ raw: match[0], keys });
  }

  for (const match of line.matchAll(/(?<![\w@])@([A-Za-z][\w:.#$%&+?<>~/-]*)/gu)) {
    out.push({ raw: match[0], keys: [match[1] ?? ''] });
  }

  return out;
}

/**
 * 解析一份结构化手稿。
 *
 * 代码块整段跳过：一段 Python 代码里的 `[0]` 会被当成引用标记，`# Results` 会被
 * 当成章节标题。不跳过的话一份带代码的手稿会解析出一堆假章节。
 */
export function parseManuscript(source: string): ManuscriptDocument {
  const warnings: { line: number; message: string }[] = [];
  const front = parseManuscriptFrontMatter(source);
  const meta = parseMeta(front.meta, (message) => {
    warnings.push({ line: 1, message });
  });

  const lines = front.body.split(/\r?\n/u);
  const offset = front.bodyStartLine;

  const sections: ManuscriptSection[] = [];
  const figures: DisplayItem[] = [];
  const tables: DisplayItem[] = [];
  const citations: CitationMarker[] = [];

  let current: { title: string; level: number; line: number; lines: string[] } | null = null;
  let inFence = false;
  let fenceMarker = '';
  let pendingImage: string | null = null;
  /** 图题行里的字数不算正文，单独累计 */
  let captionWords = 0;

  /*
   * 引用标记按**段落**而不是按行收集。
   *
   * 一句话经常跨行（软换行）：`Our previous work showed\nthat spindle density predicts
   * recall [2].` 里，`[2]` 在第二行而自我指代措辞在第一行。按行取上下文会让自引检测
   * （需求 13.7）漏掉所有跨行的句子——而那是排版良好的手稿里最常见的形态。
   *
   * 因此先攒一个段落，段落结束时切句并把每个引用标记归到它所在的句子上。
   */
  let paragraph: { lines: { text: string; line: number }[]; section: string | null } = {
    lines: [],
    section: null,
  };

  const flushParagraph = (): void => {
    if (paragraph.lines.length === 0) return;
    const joined = paragraph.lines.map((l) => l.text).join(' ');
    const sentences = splitSentences(joined);

    for (const { text, line } of paragraph.lines) {
      for (const marker of extractCitationMarkers(text)) {
        /*
         * 找出这个标记所在的句子。
         *
         * 按「句子里含这个标记原文」定位。同一段里出现两个相同标记时会取第一句——
         * 那是可接受的：自我指代措辞只要出现在其中任一句里，这一段就值得人看一眼。
         */
        const sentence = sentences.find((s) => s.includes(marker.raw)) ?? joined;
        citations.push({
          raw: marker.raw,
          keys: marker.keys,
          line,
          section: paragraph.section,
          sentence: sentence.trim().slice(0, 1000),
        });
      }
    }
    paragraph = { lines: [], section: paragraph.section };
  };

  const flushSection = (): void => {
    flushParagraph();
    if (current === null) return;
    const text = current.lines.join('\n');
    sections.push({
      title: current.title,
      level: current.level,
      lines: current.lines,
      line: current.line,
      words: countWords(text),
    });
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    const lineNumber = index + offset;
    const line = raw.trimEnd();

    const fence = /^\s*(```+|~~~+)/u.exec(line);
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      current?.lines.push(line);
      continue;
    }
    if (inFence) {
      current?.lines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushSection();
      current = {
        title: (heading[2] ?? '').replace(/[*_`]/gu, '').trim(),
        level: (heading[1] ?? '#').length,
        line: lineNumber,
        lines: [],
      };
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (image !== null) {
      // 记住图片路径：多数格式下图题在图片的下一行
      pendingImage = image[1] ?? null;
    }

    const caption = CAPTION_LINE.exec(line);
    if (caption !== null && (caption[2] !== undefined || caption[3] !== undefined)) {
      const label = (caption[1] ?? '').toLowerCase();
      const isFigure = label.startsWith('fig') || label === '图';
      const number = caption[2] === undefined ? null : toHalfWidthNumber(caption[2]);
      const text = (caption[3] ?? '').trim();

      /*
       * 只有「标签 + 编号」才算图题。
       *
       * 少了编号这一条，正文里的「Table shows that...」会被当成表题。而误认一个
       * 图题的后果是编号连续性检查报出一个不存在的编号缺口。
       */
      if (number !== null) {
        // 图题也是段落边界：它不该与前后正文合成一句
        flushParagraph();
        const item: DisplayItem = {
          kind: isFigure ? 'figure' : 'table',
          number,
          // 收尾的 `**` / `__` 要去掉：`**Figure 1.**` 的图题是空的，
          // 留着 `**` 会让「图题为空」检查放过它
          caption: text.replace(/(?:\*\*|__)\s*$/u, '').trim(),
          line: lineNumber,
          section: current?.title ?? null,
          source: isFigure ? pendingImage : null,
        };
        if (isFigure) figures.push(item);
        else tables.push(item);
        captionWords += countWords(line);
        pendingImage = null;
        current?.lines.push(line);
        continue;
      }
    }

    if (line.trim() === '') {
      flushParagraph();
    } else if (!line.startsWith('!')) {
      paragraph.section = current?.title ?? null;
      paragraph.lines.push({ text: line.trim(), line: lineNumber });
    }

    current?.lines.push(line);
  }
  flushSection();

  /*
   * 正文字数：全部章节字数之和，减去图题，再减去参考文献节。
   *
   * 参考文献不算正文字数——期刊都是这么统计的，而一份七十条参考文献的手稿里
   * 参考文献能占掉三千词。不减掉的话字数检查会在每一份长稿上误报。
   */
  const referenceSectionTitles = /^(?:references?|bibliography|参考文献|引用文献)$/iu;
  const bodyWords = sections
    .filter((section) => !referenceSectionTitles.test(section.title.trim()))
    .filter((section) => !/^(?:abstract|摘要)$/iu.test(section.title.trim()))
    .reduce((sum, section) => sum + section.words, 0);

  const distinct = new Set(citations.flatMap((c) => c.keys));

  if (!front.present) {
    warnings.push({
      line: 1,
      message:
        '这份手稿没有 front matter。编译只能做正文层面的检查——' +
        '字数限制、双盲处理与自引检测都需要结构化的作者与机构信息。' +
        '在文件开头加一段 `---` 包起来的元数据。',
    });
  }

  return {
    meta,
    sections,
    figures,
    tables,
    citations,
    body: front.body,
    counts: {
      title: countWords(meta.title ?? ''),
      abstract: countWords(meta.abstract ?? ''),
      body: Math.max(0, bodyWords - captionWords),
      keywords: meta.keywords.length,
      figures: figures.length,
      tables: tables.length,
      distinctCitations: distinct.size,
    },
    hasFrontMatter: front.present,
    warnings,
  };
}

/** 找出摘要：front matter 里的优先，其次是标题为 Abstract 的章节。 */
export function resolveAbstract(doc: ManuscriptDocument): {
  text: string | null;
  source: 'front-matter' | 'section' | null;
} {
  if (doc.meta.abstract !== null) return { text: doc.meta.abstract, source: 'front-matter' };
  const section = doc.sections.find((s) => /^(?:abstract|摘要)$/iu.test(s.title.trim()));
  if (section === undefined) return { text: null, source: null };
  return { text: section.lines.join('\n').trim(), source: 'section' };
}

/** 全部作者姓名。自引检测与双盲处理都要它。 */
export function authorNames(doc: ManuscriptDocument): readonly string[] {
  return doc.meta.identifying.authors.map((a) => a.name);
}

/** 数值字段的取值助手 re-export，供编译层读自定义档案。 */
export { asNumber };
