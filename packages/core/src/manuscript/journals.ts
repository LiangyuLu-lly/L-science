/**
 * 期刊格式档案（任务 13.6，需求 13.5）。
 *
 * 需求要求编译时「处理引用样式、字数限制与图表编号规范」。这三件事在不同期刊上
 * 的规则不同，因此必须是**数据**而不是代码——每加一个投稿目标就改一次编译器
 * 的做法在第三个期刊上就会崩。
 *
 * 内置档案覆盖的是最常见的几类，而不是穷举。穷举做不到（有几万种期刊），而且
 * 假装穷举更糟：用户会以为「列表里没有我的期刊」意味着不支持，于是放弃使用；
 * 而实际上 `generic` 档案加上一份用户自定义档案就能覆盖任何期刊。
 *
 * **档案里的数值全部是「按该期刊官方作者指南」的近似值。** 期刊会改规则，而这份
 * 内置数据不会自动更新。因此编译报告里对字数限制的表述是「按 <档案名> 档案，
 * 上限 X 字」而不是「超过该期刊的限制」——后者是一个我们无法保证的断言。
 */

/** 引用样式族。决定正文里的引用标记形态与参考文献列表的排序。 */
export type CitationStyleFamily =
  /** 数字上标或方括号，参考文献按正文首次出现顺序排。Nature、Science、Vancouver。 */
  | 'numeric-citation-order'
  /** 数字方括号，参考文献按字母顺序排。IEEE 的一些刊物、部分计算机会议。 */
  | 'numeric-alphabetical'
  /** 作者年份，参考文献按字母顺序排。APA、Elsevier 的多数刊物、多数心理学期刊。 */
  | 'author-year';

export const CITATION_STYLE_LABEL: Readonly<Record<CitationStyleFamily, string>> = {
  'numeric-citation-order': '数字引用（按正文出现顺序排列参考文献）',
  'numeric-alphabetical': '数字引用（参考文献按字母顺序排列）',
  'author-year': '作者年份引用（参考文献按字母顺序排列）',
};

/** 图表编号规范。 */
export interface NumberingRule {
  /** 图的标签词，如 `Figure`、`Fig.`、`图`。 */
  figureLabel: string;
  tableLabel: string;
  /** 正文里引用图时用的形式。用于检查一致性。 */
  figureRefLabel: string;
  tableRefLabel: string;
  /** 标签与编号之间的分隔，如 `Figure 1.` 里的 `.`。 */
  captionSeparator: string;
  /**
   * 图题的位置。
   *
   * 影响编译输出里图题放在图片上方还是下方。多数期刊要求图题在图下、表题在表上——
   * 这是排版惯例而不是可选项，弄反了编辑部会退回。
   */
  figureCaptionBelow: boolean;
  tableCaptionAbove: boolean;
}

/** 字数与篇幅限制。null 表示该期刊对这一项没有限制（或档案没有记录）。 */
export interface LengthLimits {
  /** 摘要字数上限。 */
  abstractWords: number | null;
  /** 正文字数上限（通常不含摘要、参考文献、图题）。 */
  bodyWords: number | null;
  /** 参考文献条数上限。 */
  references: number | null;
  /** 图表总数上限。 */
  displayItems: number | null;
  /** 标题字数上限。 */
  titleWords: number | null;
  /** 关键词个数上限。 */
  keywords: number | null;
}

export interface JournalProfile {
  id: string;
  name: string;
  /** 该档案适用的刊物或格式族，用于按目标期刊名匹配。 */
  aliases: readonly string[];
  citationStyle: CitationStyleFamily;
  numbering: NumberingRule;
  limits: LengthLimits;
  /**
   * 期望的章节顺序。
   *
   * 用于报告「章节顺序与该期刊惯例不符」，**不自动重排**——重排一篇手稿的章节
   * 会打乱交叉引用与作者的行文逻辑，而那不是编译器该做的决定。
   */
  sectionOrder: readonly string[];
  /** 是否要求结构化摘要（分 Background/Methods/Results/Conclusions 小节）。 */
  structuredAbstract: boolean;
  /** 是否默认双盲送审。 */
  doubleBlindByDefault: boolean;
  /** 额外要求的声明段落。缺失时报告。 */
  requiredStatements: readonly string[];
  /** 档案来源说明。让用户知道这些数值有多可靠。 */
  note: string;
}

const NUMERIC_EN: NumberingRule = {
  figureLabel: 'Figure',
  tableLabel: 'Table',
  figureRefLabel: 'Fig.',
  tableRefLabel: 'Table',
  captionSeparator: '.',
  figureCaptionBelow: true,
  tableCaptionAbove: true,
};

const NUMERIC_ZH: NumberingRule = {
  figureLabel: '图',
  tableLabel: '表',
  figureRefLabel: '图',
  tableRefLabel: '表',
  captionSeparator: '　',
  figureCaptionBelow: true,
  tableCaptionAbove: true,
};

const IMRAD: readonly string[] = [
  'Abstract',
  'Introduction',
  'Methods',
  'Results',
  'Discussion',
  'Conclusion',
  'References',
];

const NO_LIMITS: LengthLimits = {
  abstractWords: null,
  bodyWords: null,
  references: null,
  displayItems: null,
  titleWords: null,
  keywords: null,
};

/**
 * 内置期刊档案。
 *
 * 每条都标了 note 说明数值来源与可靠性。这不是免责声明——它是让用户判断
 * 「要不要按这个数字改稿」的必要信息。一个记错的字数上限会让作者白删两千字。
 */
export const BUILTIN_JOURNAL_PROFILES: readonly JournalProfile[] = [
  {
    id: 'generic',
    name: '通用（无特定期刊限制）',
    aliases: ['generic', 'default', '通用'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: NO_LIMITS,
    sectionOrder: IMRAD,
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: [],
    note: '不施加任何字数或条数限制，只做结构与引用一致性检查。不确定投哪本时用它。',
  },
  {
    id: 'nature',
    name: 'Nature（Article）',
    aliases: ['nature', 'nature article'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 150,
      bodyWords: 3000,
      references: 50,
      displayItems: 6,
      titleWords: 15,
      keywords: null,
    },
    sectionOrder: ['Abstract', 'Main', 'Methods', 'References'],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: ['Data availability', 'Code availability', 'Competing interests'],
    note:
      'Nature 的 Article 格式（约 3000 词正文、150 词无小标题摘要、6 个图表）。' +
      '实际投稿前请核对当期的 author guidelines——这些数值会调整，而本档案不会自动更新。',
  },
  {
    id: 'nature-communications',
    name: 'Nature Communications',
    aliases: ['nature communications', 'nat commun', 'ncomms'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 150,
      bodyWords: 5000,
      references: 70,
      displayItems: 10,
      titleWords: 15,
      keywords: null,
    },
    sectionOrder: ['Abstract', 'Introduction', 'Results', 'Discussion', 'Methods', 'References'],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: ['Data availability', 'Code availability', 'Competing interests'],
    note: 'Nature Communications 的常规研究论文格式。投稿前核对官方指南。',
  },
  {
    id: 'science',
    name: 'Science（Research Article）',
    aliases: ['science', 'science research article'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 125,
      bodyWords: 4500,
      references: 40,
      displayItems: 6,
      titleWords: 12,
      keywords: null,
    },
    sectionOrder: ['Abstract', 'Main', 'Materials and Methods', 'References'],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: ['Data and materials availability'],
    note: 'Science 的 Research Article 格式。它的参考文献与注释合并编号，这一点本档案不建模。',
  },
  {
    id: 'plos-one',
    name: 'PLOS ONE',
    aliases: ['plos one', 'plosone', 'plos'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 300,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: 25,
      keywords: null,
    },
    sectionOrder: [
      'Abstract',
      'Introduction',
      'Materials and Methods',
      'Results',
      'Discussion',
      'Conclusion',
      'References',
    ],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: ['Data availability', 'Funding', 'Competing interests'],
    note: 'PLOS ONE 不限正文长度，但摘要 300 词、标题 25 词有硬限制。',
  },
  {
    id: 'ieee',
    name: 'IEEE（Transactions / 会议）',
    aliases: ['ieee', 'ieee transactions', 'ieee access'],
    citationStyle: 'numeric-citation-order',
    numbering: { ...NUMERIC_EN, figureRefLabel: 'Fig.' },
    limits: {
      abstractWords: 250,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: null,
      keywords: 5,
    },
    sectionOrder: [
      'Abstract',
      'Introduction',
      'Related Work',
      'Method',
      'Experiments',
      'Results',
      'Conclusion',
      'References',
    ],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: [],
    note: 'IEEE 格式族。正文长度按页数而不是字数限制，因此本档案不设 bodyWords。',
  },
  {
    id: 'apa',
    name: 'APA 第七版（心理学类期刊）',
    aliases: ['apa', 'apa7', 'psychological', 'journal of experimental psychology'],
    citationStyle: 'author-year',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 250,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: 12,
      keywords: 5,
    },
    sectionOrder: ['Abstract', 'Introduction', 'Method', 'Results', 'Discussion', 'References'],
    structuredAbstract: false,
    doubleBlindByDefault: true,
    requiredStatements: ['Open practices', 'Conflicts of interest'],
    note: 'APA 第七版格式。作者年份引用，参考文献按字母排序。多数采用它的期刊双盲送审。',
  },
  {
    id: 'bmj',
    name: 'BMJ / 医学类（结构化摘要）',
    aliases: ['bmj', 'lancet', 'jama', 'annals of internal medicine'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 300,
      bodyWords: 4000,
      references: 40,
      displayItems: 5,
      titleWords: 20,
      keywords: null,
    },
    sectionOrder: [
      'Abstract',
      'Introduction',
      'Methods',
      'Results',
      'Discussion',
      'Conclusion',
      'References',
    ],
    structuredAbstract: true,
    doubleBlindByDefault: false,
    requiredStatements: [
      'Ethics approval',
      'Data sharing',
      'Funding',
      'Competing interests',
      'Patient consent',
    ],
    note:
      '临床医学类期刊的共同要求：结构化摘要、伦理与知情同意声明、试验注册号。' +
      '各刊细节差别大，这是一份共性档案而不是任何一本刊的准确规则。',
  },
  {
    id: 'elsevier',
    name: 'Elsevier 通用（作者年份）',
    aliases: ['elsevier', 'neuroimage', 'sleep medicine', 'journal of neuroscience methods'],
    citationStyle: 'author-year',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 250,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: null,
      keywords: 6,
    },
    sectionOrder: IMRAD,
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: ['Declaration of competing interest', 'Data availability'],
    note: 'Elsevier 多数刊物的默认（作者年份引用）。具体刊物可能改用数字引用。',
  },
  {
    id: 'neurips',
    name: 'NeurIPS / ICML（双盲会议）',
    aliases: ['neurips', 'nips', 'icml', 'iclr', 'cvpr', 'acl'],
    citationStyle: 'author-year',
    numbering: NUMERIC_EN,
    limits: {
      abstractWords: 250,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: null,
      keywords: null,
    },
    sectionOrder: [
      'Abstract',
      'Introduction',
      'Related Work',
      'Method',
      'Experiments',
      'Conclusion',
      'References',
    ],
    structuredAbstract: false,
    doubleBlindByDefault: true,
    requiredStatements: ['Broader impact', 'Reproducibility statement'],
    note:
      '机器学习会议的双盲格式。正文长度按页数限制（通常 8-9 页），本档案不设字数上限。' +
      '**双盲是硬要求**：这类会议的编辑部会因为身份泄露直接拒稿。',
  },
  {
    id: 'chinese-journal',
    name: '中文期刊（通用）',
    aliases: ['中文', 'chinese', '中华', '学报'],
    citationStyle: 'numeric-citation-order',
    numbering: NUMERIC_ZH,
    limits: {
      abstractWords: 300,
      bodyWords: null,
      references: null,
      displayItems: null,
      titleWords: 20,
      keywords: 8,
    },
    sectionOrder: ['摘要', '引言', '材料与方法', '结果', '讨论', '结论', '参考文献'],
    structuredAbstract: false,
    doubleBlindByDefault: false,
    requiredStatements: [],
    note:
      '中文期刊的共性档案：图表标签用「图」「表」，摘要按字数（而非词数）计。' +
      '中文的「字数」按字符统计，与英文按词统计不是一回事，编译报告里会分别标明。',
  },
];

/**
 * 按目标期刊名找档案。
 *
 * 匹配是宽松的（小写、去标点、子串），因为用户会写「Nature Neuroscience」而档案
 * 里只有「nature」。找不到时返回 `generic` 而不是报错——报错会让编译在一个
 * 纯属可选的字段上失败。
 *
 * 返回值带 `matched` 说明是否真的命中：编译报告里必须说清用的是哪个档案，
 * 否则用户会以为字数限制是他那本刊的。
 */
export function findJournalProfile(
  target: string | null,
  extra: readonly JournalProfile[] = [],
): { profile: JournalProfile; matched: boolean } {
  const all = [...extra, ...BUILTIN_JOURNAL_PROFILES];
  const generic =
    all.find((p) => p.id === 'generic') ?? (BUILTIN_JOURNAL_PROFILES[0] as JournalProfile);

  if (target === null || target.trim() === '') return { profile: generic, matched: false };

  const needle = target
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim();
  if (needle === '') return { profile: generic, matched: false };

  // 先试完全相等，再试别名子串。反过来会让 `nature` 抢走 `nature communications`
  for (const profile of all) {
    if (profile.id === needle) return { profile, matched: true };
    if (profile.aliases.some((alias) => alias.toLowerCase() === needle)) {
      return { profile, matched: true };
    }
  }

  // 别名最长优先：`nature communications` 比 `nature` 更具体
  const candidates = all
    .flatMap((profile) => profile.aliases.map((alias) => ({ profile, alias: alias.toLowerCase() })))
    .filter(({ alias }) => needle.includes(alias) || alias.includes(needle))
    .sort((a, b) => b.alias.length - a.alias.length);

  const best = candidates[0];
  return best === undefined
    ? { profile: generic, matched: false }
    : { profile: best.profile, matched: true };
}

/**
 * 从用户提供的 JSON 解析一份自定义档案。
 *
 * 缺字段用 `generic` 的值补，而不是报错：用户想覆盖的通常只是字数上限，
 * 让他把整份档案写全会让这个功能没人用。
 */
export function parseJournalProfile(raw: unknown, id: string): JournalProfile {
  const generic = BUILTIN_JOURNAL_PROFILES.find((p) => p.id === 'generic') as JournalProfile;
  if (typeof raw !== 'object' || raw === null) return { ...generic, id, name: id };

  const obj = raw as Record<string, unknown>;
  const num = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const strList = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

  const style = obj.citationStyle;
  const citationStyle: CitationStyleFamily =
    style === 'author-year' ||
    style === 'numeric-alphabetical' ||
    style === 'numeric-citation-order'
      ? style
      : generic.citationStyle;

  const limitsRaw = (obj.limits ?? {}) as Record<string, unknown>;

  return {
    id,
    name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim() : id,
    aliases: strList(obj.aliases),
    citationStyle,
    numbering: {
      ...generic.numbering,
      ...(typeof obj.numbering === 'object' && obj.numbering !== null
        ? (obj.numbering as Partial<NumberingRule>)
        : {}),
    },
    limits: {
      abstractWords: num(limitsRaw.abstractWords),
      bodyWords: num(limitsRaw.bodyWords),
      references: num(limitsRaw.references),
      displayItems: num(limitsRaw.displayItems),
      titleWords: num(limitsRaw.titleWords),
      keywords: num(limitsRaw.keywords),
    },
    sectionOrder:
      strList(obj.sectionOrder).length > 0 ? strList(obj.sectionOrder) : generic.sectionOrder,
    structuredAbstract: obj.structuredAbstract === true,
    doubleBlindByDefault: obj.doubleBlindByDefault === true,
    requiredStatements: strList(obj.requiredStatements),
    note:
      typeof obj.note === 'string' && obj.note.trim() !== ''
        ? obj.note.trim()
        : '用户自定义档案。字数限制等数值由用户提供，本平台不核对它们与期刊官方指南是否一致。',
  };
}

/** 档案摘要，用于工具输出与界面。 */
export function describeProfile(profile: JournalProfile, matched: boolean): string {
  const lines = [
    `格式档案：${profile.name}（${profile.id}）${matched ? '' : '　— 未匹配到目标期刊，用的是通用档案'}`,
    `引用样式：${CITATION_STYLE_LABEL[profile.citationStyle]}`,
    `图表标签：${profile.numbering.figureLabel} / ${profile.numbering.tableLabel}`,
  ];

  const limits: string[] = [];
  if (profile.limits.titleWords !== null) limits.push(`标题 ${String(profile.limits.titleWords)}`);
  if (profile.limits.abstractWords !== null) {
    limits.push(`摘要 ${String(profile.limits.abstractWords)}`);
  }
  if (profile.limits.bodyWords !== null) limits.push(`正文 ${String(profile.limits.bodyWords)}`);
  if (profile.limits.references !== null) {
    limits.push(`参考文献 ${String(profile.limits.references)} 条`);
  }
  if (profile.limits.displayItems !== null) {
    limits.push(`图表 ${String(profile.limits.displayItems)} 个`);
  }
  if (profile.limits.keywords !== null) {
    limits.push(`关键词 ${String(profile.limits.keywords)} 个`);
  }
  lines.push(limits.length === 0 ? '篇幅限制：无' : `篇幅限制：${limits.join('，')}`);

  if (profile.doubleBlindByDefault) lines.push('该目标默认双盲送审。');
  if (profile.structuredAbstract) lines.push('该目标要求结构化摘要。');
  lines.push(`档案说明：${profile.note}`);

  return lines.join('\n');
}
