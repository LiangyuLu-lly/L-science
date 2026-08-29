/**
 * 可核查断言的识别（任务 13.4，需求 13.1）。
 *
 * 需求要求至少覆盖四类：数值结论、比较陈述、因果陈述、引文支撑陈述。
 *
 * 这里用**确定性规则**而不是让模型读一遍。三个理由：
 *
 * 1. 模型抽取会漏。它读一篇八千字的手稿并列出「全部可核查断言」时，实际给出的是
 *    它认为重要的十几条——而漏掉的那条恰恰可能是编造的数字。规则不会因为觉得
 *    某句话不重要就跳过它。
 * 2. 抽取结果要可复现。同一份手稿两次抽取给出不同的断言集合时，「上次核验过了」
 *    这个记录就失去意义。
 * 3. 它便宜到可以在每次保存手稿时都跑。模型抽取贵到只能手工触发，而手工触发的
 *    检查在赶投稿的时候一定会被跳过。
 *
 * 规则的代价是**会误抽**：方法学描述里的「采样率为 250 Hz」会被认成数值结论。
 * 这是刻意接受的取舍，处理办法是把自动抽取的断言标成 `origin: 'extracted'`
 * 并让它们默认不进 FAIL 级发现（见 `ledger.ts` 的说明）。反过来的设计——
 * 收紧规则以避免误抽——会漏掉真正编造的数字，而那是这套机制存在的唯一理由。
 */

/** 断言类型。一句话可以同时属于多类。 */
export type ClaimKind = 'numeric' | 'comparison' | 'causal' | 'citation' | 'other';

export const CLAIM_KIND_LABEL: Readonly<Record<ClaimKind, string>> = {
  numeric: '数值结论',
  comparison: '比较陈述',
  causal: '因果陈述',
  citation: '引文支撑陈述',
  other: '其它',
};

/** 抽出的一条候选断言。 */
export interface ExtractedClaim {
  text: string;
  /** 主类型。多类命中时按 `KIND_PRIORITY` 定。 */
  kind: ClaimKind;
  /** 全部命中的类型。 */
  kinds: readonly ClaimKind[];
  /** 定位串，形如 `Results ¶3 S2`（章节、段落序号、句序号）。 */
  locator: string;
  /** 所属章节标题。取不到时为 null。 */
  section: string | null;
  /** 句子里出现的数值表达式原文。核验时要明确摆出来。 */
  numbers: readonly string[];
  /** 句子里出现的引用标记原文（`[12]`、`(Smith et al., 2023)`、`@key`）。 */
  citations: readonly string[];
  /** 命中了哪些规则。用于解释「为什么这句被抽出来」。 */
  reasons: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 句子切分
 * ------------------------------------------------------------------ */

/**
 * 不能在其后断句的缩写与记号。
 *
 * 这份清单是句子切分正确性的全部：漏一个就会把一句话切成两半，而两半都不成句，
 * 于是抽出来的「断言」是一个残句——用户看到它会认为这套抽取不可信。
 *
 * `Fig`/`Eq`/`Ref` 这类在方法与结果里极常见；`et al` 与 `vs` 在讨论里到处都是；
 * 单个大写字母是姓名缩写（`J. Smith`）。
 */
const NO_BREAK_AFTER = new Set([
  'fig',
  'figs',
  'eq',
  'eqs',
  'ref',
  'refs',
  'no',
  'nos',
  'vol',
  'ch',
  'sec',
  'p',
  'pp',
  'al',
  'et',
  'vs',
  'cf',
  'ca',
  'approx',
  'e.g',
  'i.e',
  'etc',
  'dr',
  'prof',
  'mr',
  'mrs',
  'ms',
  'st',
  'inc',
  'ltd',
  'jr',
  'sr',
  'min',
  'max',
  'std',
  'sd',
  'se',
  'ci',
  'df',
  'ns',
]);

/**
 * 把一段文字切成句子。
 *
 * 中英混排要同时处理两套标点。中文的句末标点（。！？；）后面不跟空格，因此
 * 「遇到句末标点 + 空白才断句」这条英文规则对中文完全无效——会把整段中文当成一句。
 *
 * 小数点是最容易出错的地方：`p < 0.05` 里的点不能断句。判据是「点的两侧都是数字」。
 */
export function splitSentences(text: string): readonly string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  const flush = (end: number): void => {
    const piece = text.slice(start, end).trim();
    if (piece !== '') out.push(piece);
    start = end;
  };

  while (i < text.length) {
    const ch = text[i] as string;

    // 中文句末标点：其后不需要空白
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
      i += 1;
      // 后面紧跟右引号或右括号时一并收进本句
      while (i < text.length && '」』"\'）)】'.includes(text[i] as string)) i += 1;
      flush(i);
      continue;
    }

    if (ch === '.' || ch === '!' || ch === '?') {
      const prev = text[i - 1] ?? '';
      const next = text[i + 1] ?? '';

      // 小数点：两侧都是数字
      if (ch === '.' && /\d/u.test(prev) && /\d/u.test(next)) {
        i += 1;
        continue;
      }

      // 缩写：取点号前的连续字母
      if (ch === '.') {
        let j = i - 1;
        while (j >= 0 && /[A-Za-z.]/u.test(text[j] as string)) j -= 1;
        const word = text.slice(j + 1, i).toLowerCase();
        // 单个大写字母是姓名缩写
        const isInitial = word.length === 1 && /[a-z]/u.test(word);
        if (isInitial || NO_BREAK_AFTER.has(word) || NO_BREAK_AFTER.has(word.replace(/\.$/u, ''))) {
          i += 1;
          continue;
        }
      }

      // 后面必须是空白或字符串结尾，且下一个非空白字符不是小写字母
      let k = i + 1;
      while (k < text.length && '")\']»”’'.includes(text[k] as string)) k += 1;
      if (k < text.length && !/\s/u.test(text[k] as string)) {
        i += 1;
        continue;
      }
      let m = k;
      while (m < text.length && /\s/u.test(text[m] as string)) m += 1;
      if (m < text.length && /[a-z]/u.test(text[m] as string)) {
        // 小写开头说明上一个点不是句末（`Fig. 1 shows` 已被上面挡掉，
        // 这里兜住清单外的缩写）
        i += 1;
        continue;
      }

      flush(k);
      i = k;
      continue;
    }

    i += 1;
  }

  flush(text.length);
  return out;
}

/* ------------------------------------------------------------------ *
 * 规则
 * ------------------------------------------------------------------ */

/**
 * 数值表达式。
 *
 * 顺序有意义：先匹配带上下文的完整形式（`p = 0.03`、`95% CI [1.2, 3.4]`），
 * 再匹配裸数字。反过来的话 `95% CI` 会先被拆成 `95%` 与两个裸数字，
 * 于是核验提示里看到的是三个孤立数字而不是一个置信区间。
 */
const NUMBER_PATTERNS: readonly { re: RegExp; label: string }[] = [
  // 统计量：p 值、效应量、相关系数、检验统计量
  {
    re: /\b(?:p|P)\s*(?:-?\s*value)?\s*[<>=≤≥]{1,2}\s*0?\.\d+(?:\s*[eE]-?\d+)?/gu,
    label: 'p 值',
  },
  { re: /\b(?:p|P)\s*[<>=≤≥]{1,2}\s*\d+(?:\.\d+)?\s*[eE]-\d+/gu, label: 'p 值（科学记数）' },
  {
    re: /\b(?:95|99|90)\s*%\s*(?:CI|confidence interval|置信区间)[\s:：]*[[(]?\s*-?\d+(?:\.\d+)?\s*(?:,|to|–|-|—)\s*-?\d+(?:\.\d+)?\s*[\])]?/giu,
    label: '置信区间',
  },
  {
    re: /\b(?:r|R|R²|R2|d|β|beta|OR|HR|RR|AUC|ICC|κ|kappa|η²|eta2|f|t|F|χ²|chi2|z)\s*[=]\s*-?\d+(?:\.\d+)?/gu,
    label: '统计量',
  },
  { re: /\b(?:n|N)\s*=\s*\d+/gu, label: '样本量' },
  { re: /\b(?:df|自由度)\s*=\s*\d+(?:\s*,\s*\d+)?/giu, label: '自由度' },
  // 均值 ± 标准差
  { re: /-?\d+(?:\.\d+)?\s*(?:±|\+\/-)\s*\d+(?:\.\d+)?/gu, label: '均值±标准差' },
  // 百分比与倍数
  { re: /-?\d+(?:\.\d+)?\s*%/gu, label: '百分比' },
  { re: /\b\d+(?:\.\d+)?\s*(?:-|–)?\s*(?:fold|倍)\b/giu, label: '倍数' },
  // 带单位的量
  {
    re: /-?\d+(?:\.\d+)?\s*(?:Hz|kHz|MHz|ms|μs|us|ns|s|min|h|hr|days?|weeks?|months?|years?|mm|cm|m|km|μm|nm|kg|g|mg|μg|ng|L|mL|μL|mol|mmol|μmol|nmol|M|mM|μM|nM|pM|°C|K|V|mV|μV|Pa|kPa|dB|bp|kb|Mb|GB|MB|TB)\b/gu,
    label: '带单位的量',
  },
];

/**
 * 比较陈述。
 *
 * 中英各一组。`significantly` 单独算数——「显著」在论文里几乎总伴随一个统计断言，
 * 而它常常是唯一的线索（「治疗组显著改善」这句话里没有任何数字）。
 */
const COMPARISON_PATTERNS: readonly RegExp[] = [
  /\b(?:higher|lower|greater|smaller|larger|faster|slower|stronger|weaker|better|worse|longer|shorter|more|less|fewer)\b[^.。]{0,40}\b(?:than|compared\s+(?:to|with)|relative\s+to|versus|vs\.?)\b/iu,
  /\b(?:increased?|decreased?|reduced?|elevated|improved|declined?|rose|fell|dropped|enhanced|diminished)\b[^.。]{0,40}\b(?:by|from|to|compared\s+(?:to|with)|relative\s+to)\b/iu,
  /\b(?:significantly|substantially|markedly|considerably)\s+(?:higher|lower|greater|smaller|larger|faster|slower|increased?|decreased?|reduced?|improved|better|worse|different|correlated|associated)/iu,
  /\bno\s+(?:significant\s+)?difference\b/iu,
  /\b(?:outperform(?:ed|s)?|exceeds?|exceeded|surpass(?:ed|es)?)\b/iu,
  /*
   * 独立的比较标记。
   *
   * 前面几条都要求「比较词 + 比较对象」同现，那漏掉两类很常见的写法：
   * 「Density was higher in patients」（省略了 than）与「a 30% reduction
   * compared with controls」（比较词是名词而不是动词）。
   *
   * 单独的比较级形容词会误命中 `higher education` 之类，但那类句子里通常没有
   * 数值，也就不会成为需要核验的断言；而漏掉「显著更高」这种结论的代价大得多。
   */
  /\b(?:compared\s+(?:to|with)|relative\s+to|versus|vs\.?)\b/iu,
  /\b(?:higher|lower|greater|smaller|larger|faster|slower|stronger|weaker|better|worse|longer|shorter)\b/iu,
  // 中文
  /(?:显著|明显|大幅|略)(?:高于|低于|优于|差于|快于|慢于|长于|短于|增加|减少|降低|提升|改善)/u,
  /(?:高于|低于|优于|劣于|快于|慢于|多于|少于|强于|弱于)/u,
  /(?:相比|相较|与.{1,20}相比|较.{1,10}(?:增加|减少|提高|降低))/u,
  /无(?:显著)?差异/u,
];

/**
 * 因果陈述。
 *
 * 这一组要收得比比较陈述紧。「因为我们用了 250 Hz 采样」是方法说明而不是结论，
 * 而 `because` 会命中它。折中办法是要求因果词与一个**判断性动词或结果名词**
 * 同现，或者出现在明确表达机制的词组里。
 */
const CAUSAL_PATTERNS: readonly RegExp[] = [
  /\b(?:cause[sd]?|causing|causal(?:ly)?)\b/iu,
  /\b(?:lead[s]?\s+to|led\s+to|leading\s+to|result(?:s|ed)?\s+in|resulting\s+in|give[s]?\s+rise\s+to|gave\s+rise\s+to)\b/iu,
  /\b(?:drive[sn]?|driving|mediate[sd]?|mediating|moderate[sd]?\s+the|underlie[s]?|underlying\s+mechanism|account(?:s|ed)?\s+for|explain(?:s|ed)?\s+(?:the|why))\b/iu,
  /\b(?:attributable\s+to|due\s+to\s+the|owing\s+to\s+the|as\s+a\s+(?:direct\s+)?(?:result|consequence)\s+of)\b/iu,
  /\b(?:promote[sd]?|inhibit(?:s|ed)?|suppress(?:es|ed)?|induce[sd]?|trigger(?:s|ed)?|impair(?:s|ed)?|rescue[sd]?|abolish(?:es|ed)?)\b/iu,
  /\btherefore\b|\bthus\b|\bhence\b|\bconsequently\b/iu,
  // 中文
  /(?:导致|引起|造成|使得|促使|诱导|抑制|促进|加剧|缓解|改善了|驱动)/u,
  /(?:因此|所以|从而|由此|可见|说明|表明|提示)/u,
  /(?:归因于|归结于|得益于|源于)/u,
];

/**
 * 引用标记。
 *
 * 四种格式并存：数字方括号（`[12]`、`[3,5-7]`）、作者年份（`(Smith et al., 2023)`）、
 * pandoc 的 `@key`、LaTeX 的 `\cite{key}`。任何一种漏掉都会让那类手稿的引文
 * 支撑陈述完全抽不出来。
 */
const CITATION_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\[\s*\d+(?:\s*[,;–-]\s*\d+)*\s*\]/gu, label: '数字引用' },
  { re: /\\cite[tp]?\*?(?:\[[^\]]*\])*\{([^}]+)\}/gu, label: 'LaTeX 引用' },
  { re: /(?<![\w@])@[A-Za-z][\w:.#$%&+?<>~/-]*/gu, label: 'pandoc 引用键' },
  /*
   * 作者年份引用。
   *
   * 形式太多，逐一枚举必然漏：`(Smith, 2023)`、`(Smith et al., 2023)`、
   * `(Smith & Jones, 2020)`、`(Smith, 2020; Jones, 2021)`、`(Smith 2023a)`。
   * 因此判据放宽成「括号里以大写字母开头的词起、含一个四位年份」。
   *
   * 这个判据会误命中 `(CI 1998-2020)` 这类少见写法。可接受，因为要求首字符是
   * 大写字母已经挡掉了真正常见的干扰：`(p = 0.003, d = 0.62)` 与
   * `(95% CI [1.2, 2.7])` 都不以大写字母开头。
   */
  {
    re: /\(\s*[A-Z][A-Za-z'’.&-]{1,}[^)]{0,60}?(?:19|20)\d{2}[a-z]?[^)]{0,50}\)/gu,
    label: '作者年份引用',
  },
];

/**
 * 明确不是断言的句子。
 *
 * 这一组的作用是压掉最常见的误抽。都是**结构性**判据而不是内容判据：
 * 疑问句不是断言；纯标题不是断言；只有一个引用标记而无其它内容的句子
 * （参考文献列表的一行）不是断言。
 *
 * 不在这里排除方法学描述——那要靠内容判断，而内容判断做错的方向是漏掉
 * 真正的数值断言。误抽由 `origin` 机制处理。
 */
function isNotAClaim(sentence: string): string | null {
  const trimmed = sentence.trim();
  if (trimmed.length < 12) return '太短，不成句';
  if (/[?？]\s*$/u.test(trimmed)) return '疑问句';
  // Markdown 标题、列表项标记、表格行
  if (/^#{1,6}\s/u.test(trimmed)) return 'Markdown 标题';
  if (/^\|/u.test(trimmed)) return '表格行';
  if (/^(?:图|表|Figure|Table|Fig\.?)\s*\d+[.:：]/iu.test(trimmed)) return '图表题注';
  // 只有字母数字与标点、没有任何空格的长串（URL、DOI 行）
  if (/^https?:\/\//iu.test(trimmed)) return '链接';
  if (/^(?:doi|DOI)\s*[:：]/u.test(trimmed)) return 'DOI 行';
  const words = trimmed.split(/\s+/u).length;
  const hasCjk = /[\u4e00-\u9fff]/u.test(trimmed);
  if (!hasCjk && words < 4) return '词数太少';
  return null;
}

/** 多类命中时的主类型优先级。 */
const KIND_PRIORITY: readonly ClaimKind[] = [
  'numeric',
  'causal',
  'comparison',
  'citation',
  'other',
];

function matchAll(
  text: string,
  patterns: readonly { re: RegExp; label: string }[],
): {
  matches: readonly string[];
  labels: readonly string[];
} {
  const matches: string[] = [];
  const labels = new Set<string>();
  for (const { re, label } of patterns) {
    // 正则带 g 标志，跨调用共享 lastIndex 会漏匹配。每次重置
    re.lastIndex = 0;
    for (const found of text.matchAll(re)) {
      const value = found[0].trim();
      if (value === '' || matches.includes(value)) continue;
      matches.push(value);
      labels.add(label);
    }
  }
  return { matches, labels: [...labels] };
}

/**
 * 判定一句话属于哪些断言类型。
 *
 * 导出是为了让 UI 能对用户手写的断言给出同样的分类，而不是让用户自己选类型——
 * 让人选一个他不理解其后果的枚举值，得到的是全部落在第一个选项上。
 */
export function classifyClaim(sentence: string): {
  kinds: readonly ClaimKind[];
  numbers: readonly string[];
  citations: readonly string[];
  reasons: readonly string[];
} {
  const kinds: ClaimKind[] = [];
  const reasons: string[] = [];

  const numberHits = matchAll(sentence, NUMBER_PATTERNS);
  if (numberHits.matches.length > 0) {
    kinds.push('numeric');
    reasons.push(`含数值（${numberHits.labels.join('、')}）`);
  }

  const citationHits = matchAll(sentence, CITATION_PATTERNS);
  if (citationHits.matches.length > 0) {
    kinds.push('citation');
    reasons.push(`含引用标记（${citationHits.labels.join('、')}）`);
  }

  for (const pattern of COMPARISON_PATTERNS) {
    if (pattern.test(sentence)) {
      kinds.push('comparison');
      reasons.push('含比较表述');
      break;
    }
  }

  for (const pattern of CAUSAL_PATTERNS) {
    if (pattern.test(sentence)) {
      kinds.push('causal');
      reasons.push('含因果或推断表述');
      break;
    }
  }

  return {
    kinds,
    numbers: numberHits.matches,
    citations: citationHits.matches,
    reasons,
  };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export interface ExtractOptions {
  /**
   * 只抽这些章节。省略表示全文。
   *
   * 实践中通常只抽 Results 与 Discussion：Methods 里的数字是参数而不是结论，
   * 而 Introduction 里的数字大多来自别人的文献（那些属于引文支撑陈述，仍会被抽到）。
   * 但默认不做这个过滤——章节名千差万别，猜错会静默漏掉整章的断言。
   */
  sections?: readonly string[];
  /** 每篇最多抽多少条。超出时截断并如实报告。 */
  limit?: number;
  /** 跳过这些类型。 */
  excludeKinds?: readonly ClaimKind[];
}

export interface ExtractResult {
  claims: readonly ExtractedClaim[];
  /** 扫过的句子数。 */
  sentencesScanned: number;
  /** 被规则排除的句子及原因（前若干条），用于解释「为什么没抽到某句」。 */
  skipped: readonly { text: string; reason: string }[];
  truncated: boolean;
}

/**
 * 从 Markdown 手稿里抽出可核查断言。
 *
 * 输入是 Markdown 而不是纯文本：章节标题（`## Results`）是定位串的一部分，
 * 而代码块与表格里的内容必须跳过——一段 Python 代码里全是数字，逐句抽会产出
 * 几十条毫无意义的「断言」，而那足以让用户放弃使用这个功能。
 */
export function extractClaims(markdown: string, options: ExtractOptions = {}): ExtractResult {
  const limit = Math.max(1, Math.min(options.limit ?? 300, 2000));
  const exclude = new Set(options.excludeKinds ?? []);
  const sectionFilter =
    options.sections === undefined
      ? null
      : new Set(options.sections.map((s) => s.trim().toLowerCase()));

  const claims: ExtractedClaim[] = [];
  const skipped: { text: string; reason: string }[] = [];
  let sentencesScanned = 0;
  let truncated = false;

  let section: string | null = null;
  let paragraphIndex = 0;
  let inFence = false;
  let fenceMarker = '';

  const paragraphs: { section: string | null; index: number; text: string }[] = [];
  const buffer: string[] = [];

  const flushParagraph = (): void => {
    const text = buffer.join(' ').trim();
    buffer.length = 0;
    if (text === '') return;
    paragraphIndex += 1;
    paragraphs.push({ section, index: paragraphIndex, text });
  };

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();

    /*
     * 代码块。
     *
     * 用「记住开栏标记」而不是简单的布尔翻转：`~~~` 与 ` ``` ` 可以嵌套，
     * 而正文里出现的三个反引号（用于行内示例）会让布尔翻转从此错位，
     * 之后半篇手稿都被当成代码。
     */
    const fence = /^\s*(```+|~~~+)/u.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      if (!inFence) {
        flushParagraph();
        inFence = true;
        fenceMarker = marker[0] as string;
      } else if (marker[0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    // 章节标题
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      section = (heading[2] ?? '').replace(/[*_`#]/gu, '').trim();
      paragraphIndex = 0;
      continue;
    }

    // 表格行与 YAML front matter 分隔线
    if (/^\s*\|/u.test(line) || /^\s*-{3,}\s*$/u.test(line)) {
      flushParagraph();
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    buffer.push(line.trim());
  }
  flushParagraph();

  for (const paragraph of paragraphs) {
    if (sectionFilter !== null && !sectionFilter.has((paragraph.section ?? '').toLowerCase())) {
      continue;
    }

    const sentences = splitSentences(paragraph.text);
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      sentencesScanned += 1;

      const reject = isNotAClaim(sentence);
      if (reject !== null) {
        if (skipped.length < 20) skipped.push({ text: sentence.slice(0, 120), reason: reject });
        continue;
      }

      const classified = classifyClaim(sentence);
      const kinds = classified.kinds.filter((k) => !exclude.has(k));
      if (kinds.length === 0) continue;

      if (claims.length >= limit) {
        truncated = true;
        break;
      }

      const kind = KIND_PRIORITY.find((k) => kinds.includes(k)) ?? 'other';
      const locatorParts = [
        paragraph.section ?? '（无章节）',
        `¶${String(paragraph.index)}`,
        `S${String(sentenceIndex + 1)}`,
      ];

      claims.push({
        // 折叠空白：断言文本要能与手稿里的句子对上，而多余空白会让字符串比对失败
        text: sentence.replace(/\s+/gu, ' ').trim(),
        kind,
        kinds,
        locator: locatorParts.join(' '),
        section: paragraph.section,
        numbers: classified.numbers,
        citations: classified.citations,
        reasons: classified.reasons,
      });
    }
    if (truncated) break;
  }

  return { claims, sentencesScanned, skipped, truncated };
}

/** 摘要一行，用于工具输出。 */
export function describeExtraction(result: ExtractResult): string {
  const byKind = new Map<ClaimKind, number>();
  for (const claim of result.claims) {
    byKind.set(claim.kind, (byKind.get(claim.kind) ?? 0) + 1);
  }
  const parts = [...byKind.entries()].map(
    ([kind, count]) => `${CLAIM_KIND_LABEL[kind]} ${String(count)}`,
  );
  return (
    `扫过 ${String(result.sentencesScanned)} 句，抽出 ${String(result.claims.length)} 条断言` +
    (parts.length === 0 ? '' : `（${parts.join('，')}）`) +
    (result.truncated ? '。已达上限，后面的段落没有扫。' : '')
  );
}
