/**
 * CSL-JSON 数据模型与归一化（任务 13.1，需求 12.1、12.5）。
 *
 * 全库统一用 CSL-JSON 作为文献元数据的内部表示，四家上游各自的 JSON 都先翻译成
 * 它再入库。理由是导出端（需求 12.5 要 BibTeX 与 CSL-JSON）与去重端都只需要认识
 * 一种形状；如果原样存上游响应，那么「取第一作者姓氏」这件事要为 Crossref、
 * OpenAlex、Semantic Scholar、PubMed 各写一遍，而且每次加一家上游就要再写一遍。
 *
 * 这里刻意只实现 CSL 的一个**子集**：论文写作真正会用到的字段。完整 CSL 规范有
 * 上百个字段（法律案例的审理法院、录音的音轨长度），实现它们不会让引用格式更正确，
 * 只会让类型难读。未识别的字段通过 `extra` 原样保留，不会在往返中丢失。
 */

/**
 * CSL 条目类型。
 *
 * 取值来自 CSL 规范，因为它们会直接进导出的 CSL-JSON，样式处理器（Zotero、
 * pandoc-citeproc、Word 的 CSL 引擎）按这些字面量分支。写成自定义值会让导出的
 * 文件在这些工具里退化成默认格式。
 */
export type CslType =
  | 'article'
  | 'article-journal'
  | 'article-magazine'
  | 'article-newspaper'
  | 'book'
  | 'chapter'
  | 'dataset'
  | 'document'
  | 'entry-encyclopedia'
  | 'paper-conference'
  | 'patent'
  | 'report'
  | 'review'
  | 'software'
  | 'standard'
  | 'thesis'
  | 'webpage';

/**
 * 姓名。
 *
 * `literal` 与 `family`/`given` 是互斥的两种用法：机构作者（「WHO Collaborating
 * Centre」）没有姓与名，硬拆成 family='WHO' given='Collaborating Centre' 会让
 * 引用输出变成「Centre, W. C.」。CSL 规范用 literal 表达这种情形。
 */
export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  suffix?: string;
  'non-dropping-particle'?: string;
  'dropping-particle'?: string;
}

/**
 * 日期。
 *
 * `date-parts` 是 CSL 的规定形状：`[[年, 月, 日]]`，允许只给年或年月。外层数组
 * 是为了表达区间（`[[2020,1],[2020,3]]`），文献元数据里几乎用不到但保留结构。
 *
 * 上游经常只给年份，这时 `[[2023]]` 是合法且必须的表达——补一个 `[[2023,1,1]]`
 * 会让引用里出现一个上游从未声明过的月份，某些期刊样式会把它打印出来。
 */
export interface CslDate {
  'date-parts'?: readonly (readonly number[])[];
  raw?: string;
  literal?: string;
}

export interface CslItem {
  id: string;
  type: CslType;
  title?: string;
  'container-title'?: string;
  'container-title-short'?: string;
  'collection-title'?: string;
  author?: readonly CslName[];
  editor?: readonly CslName[];
  issued?: CslDate;
  accessed?: CslDate;
  volume?: string;
  issue?: string;
  page?: string;
  'page-first'?: string;
  'number-of-pages'?: string;
  publisher?: string;
  'publisher-place'?: string;
  edition?: string;
  DOI?: string;
  URL?: string;
  PMID?: string;
  PMCID?: string;
  ISSN?: readonly string[];
  ISBN?: readonly string[];
  abstract?: string;
  language?: string;
  note?: string;
  keyword?: string;
  /** 未被上述字段覆盖的内容。原样保留，导出时一并写出。 */
  extra?: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ *
 * 标识归一化
 * ------------------------------------------------------------------ */

/**
 * 归一化 DOI。
 *
 * 用户与上游给 DOI 的形式至少有六种：裸 DOI、`doi:` 前缀、`https://doi.org/`、
 * `http://dx.doi.org/`、大写、带尾随标点（从 PDF 里复制时常带上句号）。不归一化
 * 的后果是同一篇文献因为写法不同被当成四条不同记录入库，而这正是需求 12.2 要防的。
 *
 * DOI 的大小写不敏感（ISO 26324），因此统一小写。这一步不能对整个字符串做
 * `encodeURIComponent` 之类的处理——DOI 后缀里合法地包含 `/`、`(`、`<`。
 *
 * 返回 null 表示不是一个可用的 DOI，调用方应当把它当作「没有 DOI」而不是
 * 把原字符串存进去：存进去之后它会以精确匹配的身份参与去重，把两篇不同的
 * 文献判成同一篇。
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;

  // 去掉常见前缀。顺序无关，因为每种前缀只会出现一次
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^https?:\/\/doi\.library\.[^/]+\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  s = s.trim();

  /*
   * 首尾标点：从 PDF 或正文里复制 DOI 时几乎总会带上包裹符号或句末的点。
   *
   * 两端都要处理。只去尾部会让 `(10.1038/x)` 变成 `(10.1038/x`，它不匹配下面的
   * 形状校验于是整条被判为非 DOI——用户看到的是「这不是合法 DOI」，而他复制的
   * 明明是对的。
   */
  s = s.replace(/^[([{<"'\s]+/u, '');
  s = s.replace(/[.,;:)\]}>"'\s]+$/u, '');

  // DOI 必须是 `10.<注册者>/<后缀>`。注册者至少四位数字（ISO 26324 现状），
  // 后缀非空。放宽到「以 10. 开头」会让 `10.foo` 这种明显的坏值通过
  if (!/^10\.\d{4,9}\/\S+$/u.test(s)) return null;

  return s.toLowerCase();
}

/** 归一化 PMID：纯数字，去掉 `PMID:` 前缀与空白。 */
export function normalizePmid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw)
    .trim()
    .replace(/^pmid:?\s*/i, '');
  return /^\d{1,9}$/u.test(s) ? s : null;
}

/**
 * 归一化 PMCID，统一带 `PMC` 前缀。
 *
 * 两种写法都在流通：Europe PMC 的接口要 `PMC1234567`，NCBI 的某些参数只要数字。
 * 库里统一存带前缀的形式，需要裸数字的地方在调用点 slice——反过来（存裸数字）
 * 会让 `PMC` 与 `pmc` 都成为可能的输入形式，而它们看起来都像合法值。
 */
export function normalizePmcid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim().replace(/\s+/gu, '');
  const m = /^(?:pmc)?(\d{1,9})$/iu.exec(s);
  return m === null ? null : `PMC${m[1] ?? ''}`;
}

/**
 * 归一化 arXiv 标识。
 *
 * 两代格式并存：2007 年 4 月之前是 `math.GT/0309136`（含分类），之后是
 * `2401.01234`。版本号 `v2` 要**去掉**：同一篇 preprint 的 v1 与 v3 是同一条
 * 文献，保留版本号会让它们被当成两篇。版本差异不是引用层面的区别。
 */
export function normalizeArxivId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;

  s = s.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '');
  s = s.replace(/^arxiv:\s*/i, '');
  s = s.replace(/\.pdf$/i, '');
  s = s.replace(/v\d+$/iu, '');

  if (/^\d{4}\.\d{4,5}$/u.test(s)) return s;
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/u.test(s)) return s;
  return null;
}

/* ------------------------------------------------------------------ *
 * 标题归一化
 * ------------------------------------------------------------------ */

/**
 * 标题归一化，用于模糊去重（需求 12.2）。
 *
 * 处理顺序有讲究：先去 HTML 标签再解实体，否则 `&lt;i&gt;` 会先变成 `<i>`
 * 然后被当成标签删掉——那是上游本来想显示的字面尖括号。
 *
 * 保留字母数字与空格，其余全部折成空格。这样处理之后：
 * - Crossref 的 `Sleep spindles: a review` 与 PubMed 的 `Sleep spindles - a review`
 *   归一化为同一串
 * - LaTeX 残留（`$\alpha$`、`{DNA}`）与 MathML 标签不再影响比对
 *
 * 刻意**不做**词干化与停用词删除。「Effects of X on Y」与「Effect of X in Y」
 * 归一化后仍有差别，靠编辑距离吸收；而删停用词会让「Sleep and memory」与
 * 「Sleep or memory」变成同一串——这两个标题的含义不同。
 */
export function normalizeTitle(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      .replace(/<[^>]*>/gu, ' ')
      .replace(/&(?:amp|lt|gt|quot|apos|#39);/gu, ' ')
      .replace(/&[a-z]+;/giu, ' ')
      .normalize('NFKD')
      // 组合用重音符号：normalize 之后 é 变成 e + U+0301，去掉后者得到 e
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
      .trim()
      .replace(/\s+/gu, ' ')
  );
}

/* ------------------------------------------------------------------ *
 * 字段读取
 * ------------------------------------------------------------------ */

/** 取出发表年份。上游只给年时也能拿到。 */
export function cslYear(item: CslItem): number | null {
  const parts = item.issued?.['date-parts'];
  if (Array.isArray(parts) && parts.length > 0) {
    const first = parts[0];
    if (Array.isArray(first) && first.length > 0) {
      const year = first[0];
      if (typeof year === 'number' && Number.isInteger(year) && year > 1000 && year < 3000) {
        return year;
      }
    }
  }

  // date-parts 缺失时退回 raw/literal，从里面抓一个四位年份
  for (const text of [item.issued?.raw, item.issued?.literal]) {
    if (typeof text !== 'string') continue;
    const m = /\b(1[0-9]{3}|2[0-9]{3})\b/u.exec(text);
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/**
 * 姓名的显示形式。
 *
 * 优先 family：去重与「自引检测」（需求 13.7）比的都是姓氏，把 given 混进来
 * 会因为「J.」与「John」的差别把同一个人判成两个人。
 */
export function nameLabel(name: CslName): string {
  if (typeof name.literal === 'string' && name.literal.trim() !== '') return name.literal.trim();
  const family = (name.family ?? '').trim();
  const given = (name.given ?? '').trim();
  if (family !== '' && given !== '') return `${family}, ${given}`;
  if (family !== '') return family;
  return given;
}

/** 用于比对的姓氏键：小写、去重音、去标点。机构作者退回整个 literal。 */
export function familyKey(name: CslName): string {
  const base =
    typeof name.family === 'string' && name.family.trim() !== ''
      ? name.family
      : (name.literal ?? '');
  return normalizeTitle(base);
}

/** 第一作者的姓氏键。无作者时为空串。 */
export function firstAuthorKey(item: CslItem): string {
  const authors = item.author ?? [];
  return authors.length === 0 ? '' : familyKey(authors[0] as CslName);
}

/** 期刊/会议名。取不到时退回 collection-title（丛书）。 */
export function containerLabel(item: CslItem): string | null {
  for (const key of ['container-title', 'collection-title'] as const) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * 作者列表的短标签，用于列表展示与日志。
 *
 * 三人以上折成「第一作者 et al.」：文献列表里把二十个作者名全打出来会把标题挤出屏幕，
 * 而用户在列表上是靠标题认文献的。
 */
export function authorSummary(item: CslItem): string {
  const authors = item.author ?? [];
  if (authors.length === 0) return '（无作者）';
  const first = nameLabel(authors[0] as CslName);
  if (authors.length === 1) return first;
  if (authors.length === 2) return `${first} 与 ${nameLabel(authors[1] as CslName)}`;
  return `${first} 等 ${String(authors.length)} 人`;
}

/** 一行摘要：作者（年）标题. 期刊. 用于日志与工具输出。 */
export function citeLine(item: CslItem): string {
  const year = cslYear(item);
  const container = containerLabel(item);
  const parts = [
    authorSummary(item),
    year === null ? '（年份不明）' : `（${String(year)}）`,
    item.title ?? '（无标题）',
  ];
  let line = `${parts[0] ?? ''}${parts[1] ?? ''} ${parts[2] ?? ''}`;
  if (container !== null) line += `. ${container}`;
  if (typeof item.DOI === 'string') line += `. doi:${item.DOI}`;
  return line;
}

/* ------------------------------------------------------------------ *
 * 构造与清洗
 * ------------------------------------------------------------------ */

/** 从任意值里取一个非空字符串，取不到返回 undefined（便于条件展开）。 */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 从任意值里取整数年份。 */
export function intOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

/** 把年月日折成 CSL 的 date-parts，只给年时只写年。 */
export function dateParts(
  year: number | undefined,
  month?: number | undefined,
  day?: number | undefined,
): CslDate | undefined {
  if (year === undefined) return undefined;
  const parts: number[] = [year];
  if (month !== undefined && month >= 1 && month <= 12) {
    parts.push(month);
    if (day !== undefined && day >= 1 && day <= 31) parts.push(day);
  }
  return { 'date-parts': [parts] };
}

/**
 * 摘要清洗。
 *
 * 三家上游的摘要各有各的脏法：Crossref 给 JATS 片段（`<jats:p>`），OpenAlex 给
 * 倒排索引（见 `sources.ts` 里的重建），Semantic Scholar 给纯文本但可能极长。
 * 统一去标签、折空白并限长。
 *
 * 限长到 4000 字符：摘要会随文献一起进模型上下文，二十条文献各带一段两千字的
 * 摘要就是四万字符，而那时症状是模型忽略掉后面的文献。
 */
export function cleanAbstract(raw: unknown): string | undefined {
  const text = str(raw);
  if (text === undefined) return undefined;
  const cleaned = text
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(amp|lt|gt|quot|apos);/gu, (_m, name: string) => {
      const map: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      return map[name] ?? ' ';
    })
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') return undefined;
  return cleaned.length > 4000 ? `${cleaned.slice(0, 4000)} […]` : cleaned;
}

/**
 * 去掉值为 undefined 的键。
 *
 * 工程开了 `exactOptionalPropertyTypes`，`{ volume: maybeUndefined }` 不能赋给
 * `volume?: string`。逐字段写 `...(x === undefined ? {} : { volume: x })` 是可行的，
 * 但一个上游映射有二十个字段，那二十行条件展开会把「哪个上游字段对应哪个 CSL 字段」
 * 这个真正需要读的信息埋掉。
 *
 * 返回 `Partial<T>` 而不是把 undefined 从类型里 Exclude 掉：后者会声称
 * 「title 一定存在」，而运行时那个键其实不在对象里。
 */
export function compact<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * 校验并补全一个 CslItem。
 *
 * `id` 与 `type` 是导出时必需的：CSL 处理器拿到缺 type 的条目会整条跳过，
 * 而那表现为「参考文献列表里少了一条」——用户很难发现少的是哪一条。
 */
export function ensureCsl(
  partial: Partial<CslItem> & { id?: string },
  fallbackId: string,
): CslItem {
  const type = partial.type ?? 'article-journal';
  return {
    ...partial,
    id: partial.id ?? fallbackId,
    type,
  };
}
