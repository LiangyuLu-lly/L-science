/**
 * 确定性审查检查（任务 12.8，需求 11.4）。
 *
 * 这一层**不用模型**。它检查的是能从库里直接判定的事实：图有没有生成代码、
 * 代码用了随机有没有固定种子、消息里引用的制品版本是否真的存在。
 *
 * 为什么要单独分出来：
 *
 * 1. **它在只有一家供应商时仍然完整可用。** 异厂商约束（需求 11.2）在只有一家
 *    供应商时会降级，那时模型层的审查价值大幅下降；而这一层的结论不依赖任何
 *    模型判断，降级不影响它。
 * 2. **它不会编造。** 模型审查的最大风险是发现本身是幻觉——「你的图缺血缘」
 *    而其实有。这一层的每条发现都能指到具体的库行。
 * 3. **它便宜。** 每次 turn 结束都跑一遍不产生任何 token 成本。
 *
 * 反过来，它做不到的事也很明确：统计方法选得对不对、正文里的数字与表里对不对、
 * 引文是否支持该结论——这些必须由模型读内容才能判断。两层合起来才是完整的审查。
 */

import type { ArtifactStore, ArtifactVersion } from '../artifact/store.js';
import type { Message } from '../repo/conversations.js';
import type { FindingCategory, FindingEvidence, FindingSeverity } from '../repo/findings.js';

/** 一条待写入的发现。与 FindingsRepo.add 的入参对齐，但不含会话与运行 id。 */
export interface DraftFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  evidence: readonly FindingEvidence[];
}

/* ------------------------------------------------------------------ *
 * 随机性与种子
 * ------------------------------------------------------------------ */

/**
 * 用到随机数的迹象。
 *
 * 只列**结果依赖随机数**的调用。`uuid4()` 之类也是随机但不影响结论，
 * 把它算进来会让「没固定种子」这条警告出现在一堆无关的地方，然后被忽略。
 */
const RANDOM_USE = [
  // Python / numpy / sklearn
  /\bnp\.random\b/,
  /\bnumpy\.random\b/,
  /\brandom\.(?:random|randint|choice|shuffle|sample|uniform|normal|gauss)\b/,
  /\btrain_test_split\s*\(/,
  /\bKFold\s*\(/,
  /\bStratifiedKFold\s*\(/,
  /\bShuffleSplit\s*\(/,
  /\bcross_val(?:_score|idate|_predict)\s*\(/,
  /\bbootstrap\w*\s*\(/i,
  /\bpermutation_test\w*\s*\(/,
  /\.sample\s*\(/,
  /\bRandomForest\w*\s*\(/,
  /\bDBSCAN\s*\(|\bKMeans\s*\(/,
  /\btorch\.rand\w*\s*\(/,
  // R
  /\brunif\s*\(|\brnorm\s*\(|\brbinom\s*\(|\brpois\s*\(/,
  /\bsample\s*\(/,
  /\bboot\s*\(/,
] as const;

/**
 * 固定了种子的迹象。
 *
 * `random_state=` 只在赋了具体值时算数：`random_state=None` 是显式的「不固定」。
 */
const SEED_SET = [
  /\bnp\.random\.seed\s*\(\s*\d/,
  /\bnp\.random\.default_rng\s*\(\s*\d/,
  /\brandom\.seed\s*\(\s*\d/,
  /\brandom_state\s*=\s*\d/,
  /\bseed\s*=\s*\d/,
  /\btorch\.manual_seed\s*\(\s*\d/,
  /\bset\.seed\s*\(\s*\d/,
] as const;

/** 读取数据的迹象。用于判断产物的输入是否可追溯。 */
const DATA_READ = [
  /\bread_csv\s*\(|\bread_excel\s*\(|\bread_parquet\s*\(|\bread_table\s*\(|\bread_json\s*\(/,
  /\bnp\.load\s*\(|\bnp\.loadtxt\s*\(|\bnp\.genfromtxt\s*\(/,
  /\bopen\s*\(/,
  /\bloadmat\s*\(|\bh5py\.File\s*\(|\bnc\.Dataset\s*\(/,
  /\bmne\.io\.read\w*\s*\(|\bmne\.read\w*\s*\(/,
  /\bread\.csv\s*\(|\bread\.table\s*\(|\breadRDS\s*\(|\bload\s*\(/,
  /\bpd\.read\w*\s*\(/,
  // 平台自己的通道
  /\{\{artifact:/,
  /\bglob\s*\(|\bPath\s*\(.*\)\.(?:glob|rglob)\s*\(/,
] as const;

/** 生成模拟数据的迹象。无输入但有模拟是合法的，只是要说清楚。 */
const SYNTHETIC = [
  /\bnp\.random\b/,
  /\bmake_(?:classification|regression|blobs|moons)\s*\(/,
  /\brnorm\s*\(|\brunif\s*\(/,
  /\blinspace\s*\(|\barange\s*\(/,
] as const;

const matchesAny = (text: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((p) => p.test(text));

/* ------------------------------------------------------------------ *
 * 制品血缘
 * ------------------------------------------------------------------ */

/**
 * 制品可复现性检查（需求 6.6、11.4 的 reproducibility 类）。
 *
 * 图像缺生成代码是 FAIL：一张答不出「怎么来的」的图在论文里不可用，审稿人一问
 * 就完。其余类型是 WARN——数据文件可能是用户直接放进来的原始记录，那本来就
 * 没有生成代码。
 */
export function checkArtifactLineage(input: {
  versions: readonly ArtifactVersion[];
  /** 取版本所属制品的信息。用于判断类型与文件名。 */
  describe: (versionId: string) => { filename: string; kind: string | null } | null;
}): readonly DraftFinding[] {
  const findings: DraftFinding[] = [];

  for (const version of input.versions) {
    const info = input.describe(version.id);
    const label = info === null ? version.id : `${info.filename} v${String(version.versionNo)}`;
    const isImage = info?.kind === 'image';

    const lineage = version.codeLineage;
    if (lineage === null || !lineage.reproducible) {
      findings.push({
        severity: isImage ? 'fail' : 'warn',
        category: 'reproducibility',
        title: `${label} 没有可复现的生成血缘`,
        detail:
          (lineage?.gap ?? '缺少生成它的代码与输入版本记录。') +
          (isImage
            ? '\n图表必须能答出「这是怎么画出来的」——审稿人一定会问，' +
              '而现在这个问题答不出来。重新生成时把作图代码通过 save_artifacts 一起记上。'
            : '\n若它是用户提供的原始数据，可以忽略这条；若是分析产物，请重新保存并带上生成代码。'),
        evidence: [{ kind: 'artifact-version', id: version.id, note: `${label}：血缘缺失` }],
      });
      continue;
    }

    const code = lineage.code ?? '';

    // 用了随机但没固定种子：结论无法复现，而且每次重跑数字都不同
    if (matchesAny(code, RANDOM_USE) && !matchesAny(code, SEED_SET)) {
      findings.push({
        severity: 'warn',
        category: 'reproducibility',
        title: `${label} 的生成代码用了随机数但没有固定种子`,
        detail:
          '重跑会得到不同的数字，论文里的结果因此无法被复现——包括你自己下次重跑。\n' +
          'Python：`rng = np.random.default_rng(42)`，或给 sklearn 的 `random_state=42`。\n' +
          'R：`set.seed(42)`。',
        evidence: [
          {
            kind: 'artifact-version',
            id: version.id,
            note: code.slice(0, 400),
          },
        ],
      });
    }

    /*
     * 输入无从追溯。
     *
     * 条件收得很窄：既没有登记输入版本、代码里也看不到任何数据读取、还看不出
     * 是模拟数据。三者同时成立时这个产物的数字确实来源不明。放宽任何一条都会
     * 开始误报，而误报会让整套警告被忽略。
     */
    if (
      lineage.inputVersionIds.length === 0 &&
      !matchesAny(code, DATA_READ) &&
      !matchesAny(code, SYNTHETIC) &&
      code.trim() !== ''
    ) {
      findings.push({
        severity: 'warn',
        category: 'integrity',
        title: `${label} 的输入无从追溯`,
        detail:
          '生成代码里既没有登记输入制品版本，也看不到任何读取数据的调用。' +
          '如果里面的数字是直接写进代码的，那它不是分析结果而是一个断言，' +
          '不能当作证据使用。',
        evidence: [{ kind: 'artifact-version', id: version.id, note: code.slice(0, 400) }],
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * 引用完整性
 * ------------------------------------------------------------------ */

/** `{{artifact:av_...}}` 标记与裸版本 id 都要认。 */
const VERSION_REF = /av_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 消息里引用的制品版本是否真的存在（需求 11.4 的 evidence 类）。
 *
 * 这条检查抓的是一类具体的幻觉：模型写「结果见 {{artifact:av_...}}」而那个 id
 * 是它编的。用户点进去只会看到一个打不开的引用，而在那之前他已经相信了那句话。
 */
export function checkDanglingArtifactRefs(input: {
  messages: readonly Message[];
  exists: (versionId: string) => boolean;
}): readonly DraftFinding[] {
  const findings: DraftFinding[] = [];

  for (const message of input.messages) {
    if (message.role !== 'assistant') continue;

    const text = extractText(message.content);
    if (text === '') continue;

    const missing = new Set<string>();
    for (const match of text.matchAll(VERSION_REF)) {
      const id = match[0].toLowerCase();
      if (!input.exists(id)) missing.add(id);
    }
    if (missing.size === 0) continue;

    findings.push({
      severity: 'fail',
      category: 'evidence',
      title: `回复里引用了不存在的制品版本（${String(missing.size)} 个）`,
      detail:
        `这些 id 在制品库里查不到：${[...missing].join('、')}。\n` +
        '用户点进去只会看到一个打不开的引用，而在那之前他已经相信了那句话。' +
        '请用 save_artifacts 的真实返回值，不要凭记忆写 id。',
      evidence: [
        {
          kind: 'message',
          id: message.id,
          note: text.slice(0, 400),
        },
      ],
    });
  }

  return findings;
}

/** 从消息内容里取出文本。内容形状按 role 不同，这里只关心文本部分。 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content !== 'object' || content === null) return '';

  const obj = content as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['text', 'detail', 'label']) {
    const value = obj[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Claim Ledger
 * ------------------------------------------------------------------ */

/**
 * 无证据与证据矛盾的断言（任务 13.4，需求 13.3）。
 *
 * 需求要求「断言处于未关闭状态且无任何证据绑定时提出 FAIL 级发现」。这里比需求
 * 多做两件事，两件都是为了让 FAIL 保持可信：
 *
 * 1. **自动抽取的断言只报 WARN。** 规则抽取必然误抽（方法学里的「采样率 250 Hz」
 *    会被认成数值结论）。如果它们也开 FAIL，一次抽取就能产生几十条 FAIL，
 *    而 FAIL 的作用是打断主 agent——那时用户会做的事是关掉审查。确认过
 *    （`origin` 不是 `extracted`）的断言才进 FAIL。
 * 2. **证据矛盾单独报，且严重度高于无证据。** 无证据是「还没做完」，矛盾是
 *    「手稿里有一句已知错误的陈述」。合成一类之后用户分不出哪个更急。
 *
 * 每条发现都指向具体的 claim id（`FindingEvidence.kind === 'claim'`），因此
 * 用户点开能看到原句、定位与已有证据。
 */
export function checkClaimSupport(input: {
  /** 未关闭的断言。调用方按会话或手稿筛好。 */
  claims: readonly ClaimSnapshot[];
}): readonly DraftFinding[] {
  const findings: DraftFinding[] = [];

  const refuted = input.claims.filter((c) => c.status === 'refuted');
  const unsupportedConfirmed = input.claims.filter(
    (c) => c.evidence.length === 0 && c.origin !== 'extracted',
  );
  const unsupportedExtracted = input.claims.filter(
    (c) => c.evidence.length === 0 && c.origin === 'extracted',
  );
  const insufficient = input.claims.filter(
    (c) => c.status === 'insufficient' && c.evidence.length > 0,
  );

  /*
   * 矛盾的断言逐条报。
   *
   * 不合并成一条：每一条都要单独修改手稿的某一句话，合并之后用户要在一条发现的
   * detail 里数出五个位置，而 `mark_addressed` 只能整条标记——于是修了一句就把
   * 五条都标成已处理了。
   */
  for (const claim of refuted) {
    findings.push({
      severity: 'fail',
      category: 'claim',
      title: `断言与证据矛盾：${claim.locator ?? claim.id}`,
      detail:
        `「${claim.text.slice(0, 300)}」\n\n` +
        '已绑定的证据里有一条被判定为与这条断言矛盾。一条矛盾压倒任意多条支持——' +
        '要么某处算错了，要么这句话的表述过强。\n' +
        '这必须改手稿，不能靠再补一条支持性证据盖过去。' +
        `用 manage_claims 的 get 看是哪条证据矛盾（claimId=${claim.id}）。`,
      evidence: [{ kind: 'claim', id: claim.id, note: claim.text.slice(0, 400) }],
    });
  }

  for (const claim of unsupportedConfirmed) {
    findings.push({
      severity: 'fail',
      category: 'claim',
      title: `这条断言还没有证据：${claim.locator ?? claim.id}`,
      detail:
        `「${claim.text.slice(0, 300)}」\n\n` +
        '这是一条已确认需要核验的断言，但 Claim Ledger 里没有任何证据绑定到它。去补证据。\n' +
        (claim.numbers.length > 0
          ? `它声称的数值：${claim.numbers.join('、')}。这些数字必须能指到产生它们的分析输出。\n`
          : '') +
        `用 manage_claims 的 bind 绑定证据（claimId=${claim.id}）：` +
        '制品版本（分析输出）、文献条目、或可复现的计算单元。\n' +
        '如果这句话其实不需要核验（例如它是背景陈述而非本文结论），用 close 关掉并说明理由。',
      evidence: [{ kind: 'claim', id: claim.id, note: claim.text.slice(0, 400) }],
    });
  }

  for (const claim of insufficient) {
    findings.push({
      severity: 'warn',
      category: 'claim',
      title: `断言的证据不足：${claim.locator ?? claim.id}`,
      detail:
        `「${claim.text.slice(0, 300)}」\n\n` +
        '已绑定的证据被判定为相关但不足以支持这条断言。补更直接的证据，' +
        '或者把断言改弱到证据能支持的程度。',
      evidence: [{ kind: 'claim', id: claim.id, note: claim.text.slice(0, 400) }],
    });
  }

  /*
   * 自动抽取的无证据断言合并成一条 WARN。
   *
   * 与上面「矛盾要逐条报」相反：这些是候选而不是已确认的问题，用户要做的是
   * 「逐条过一遍分类」这个单一动作，而不是逐条修手稿。合并成一条让它在 findings
   * 列表里只占一行，不至于把真正的问题挤出视野。
   */
  if (unsupportedExtracted.length > 0) {
    const sample = unsupportedExtracted.slice(0, 5);
    findings.push({
      severity: 'warn',
      category: 'claim',
      title: `${String(unsupportedExtracted.length)} 条自动抽取的断言还没有证据`,
      detail:
        '这些是规则从手稿里抽出的候选断言，未经确认。规则必然会误抽——' +
        '方法学里的「采样率 250 Hz」会被认成数值结论。\n\n' +
        sample.map((c) => `· ${c.locator ?? c.id}：${c.text.slice(0, 120)}`).join('\n') +
        (unsupportedExtracted.length > sample.length
          ? `\n… 还有 ${String(unsupportedExtracted.length - sample.length)} 条`
          : '') +
        '\n\n逐条看过之后：真正需要证据的用 manage_claims 的 confirm 确认' +
        '（确认后无证据会升级成 FAIL），不需要核验的用 close 关掉。',
      // 证据指向第一条：finding 必须有具体指向（需求 11.8），而这条发现
      // 说的是「这一批需要分类」，取样本里的第一条作为入口
      evidence: sample.map((c) => ({
        kind: 'claim' as const,
        id: c.id,
        note: c.text.slice(0, 200),
      })),
    });
  }

  return findings;
}

/**
 * 断言快照。
 *
 * 用一个中性的结构而不是直接吃 `ClaimRecord`：审查模块在 M3 就定型了，让它 import
 * M4 的仓储类型会把「审查」与「手稿」两个模块绑在一起，而只有前者是每个部署都需要的。
 *
 * 证据带完整明细而不只是计数：确定性层只用得到计数，但模型层要看「绑的是什么、
 * 核验结论是什么、引的原文是什么」。两层用同一份快照，否则会出现确定性层报了
 * 一条无证据断言、而模型层那份快照里它已经绑上证据的自相矛盾。
 */
export interface ClaimSnapshot {
  id: string;
  text: string;
  locator: string | null;
  status: string;
  origin: string;
  numbers: readonly string[];
  /** 是否为引文支撑陈述。决定要不要检查检索取证（需求 13.9）。 */
  isCitation?: boolean;
  /** 有没有真的经过检索的引文核实记录（需求 13.9）。 */
  retrievalBacked?: boolean;
  evidence: readonly {
    kind: string;
    ref: string;
    verdict: string | null;
    quote: string | null;
  }[];
}

/* ------------------------------------------------------------------ *
 * 引文核实
 * ------------------------------------------------------------------ */

/** 一次引文核实记录的快照。只带确定性检查用得到的字段。 */
export interface CitationCheckSnapshot {
  id: string;
  claimId: string | null;
  raw: string;
  verdict: string;
  /** 实际发出的查询数。0 表示这次「核实」没有真的检索过。 */
  queryCount: number;
  detail: string | null;
  matchedRefId: string | null;
}

/**
 * 引文完整性（任务 13.5，需求 13.9）。
 *
 * 两类问题，两者都只能在这一层抓到：
 *
 * 1. **检索不到的引文**。`not-found` 的核实记录是「这条引文很可能是编造的」的
 *    直接凭据，判 FAIL。它不是「可能有问题」——检索层已经跑过四家上游了。
 *
 * 2. **引文支撑陈述被标成已支持，但没有经过检索取证**。这条检查是需求 13.9 在
 *    审查层的兜底：`ClaimLedger.verify` 已经在写入时挡了一道，但历史数据、
 *    直接操作仓储的路径、以及未来新增的写入口都可能绕过它。审查层再查一遍，
 *    保证「未经检索的引文核实」不会静悄悄留在库里。
 *
 * `metadata-mismatch` 判 WARN 而不是 FAIL：它意味着引文写错了（复制错行），
 * 是要改的，但引用的文献确实存在——与编造引文不是一个量级。
 */
export function checkCitationIntegrity(input: {
  checks: readonly CitationCheckSnapshot[];
  claims: readonly ClaimSnapshot[];
}): readonly DraftFinding[] {
  const findings: DraftFinding[] = [];

  /*
   * 同一条引文可能被核实过多次（改了 DOI 之后重核）。只看**最近一次**的结论。
   * 输入按时间倒序，因此首次见到某条原文时它就是最新的那次。
   */
  const latest = new Map<string, CitationCheckSnapshot>();
  for (const check of input.checks) {
    if (!latest.has(check.raw)) latest.set(check.raw, check);
  }

  for (const check of latest.values()) {
    if (check.verdict === 'not-found') {
      findings.push({
        severity: 'fail',
        category: 'claim',
        title: '引文检索不到，可能是编造的',
        detail:
          `引文原文：${check.raw.slice(0, 300)}\n\n` +
          '已经在 Crossref、OpenAlex、Semantic Scholar、Europe PMC 检索过，' +
          '全部上游都没有这条记录。\n' +
          (check.detail ?? '') +
          '\n\n请核对原文：要么给出正确的 DOI 重新核实，要么把这条引用从正文里去掉。' +
          '**不要**为它构造一条文献记录。',
        evidence:
          check.claimId === null
            ? // 没挂到断言上时用核实记录本身作为指向。finding 必须有具体证据
              // （需求 11.8），而这条核实记录就是最具体的指向
              [{ kind: 'claim' as const, id: check.id, note: check.raw.slice(0, 200) }]
            : [{ kind: 'claim' as const, id: check.claimId, note: check.raw.slice(0, 200) }],
      });
      continue;
    }

    if (check.verdict === 'metadata-mismatch') {
      findings.push({
        severity: 'warn',
        category: 'claim',
        title: '引文的字段与上游记录不符',
        detail:
          `引文原文：${check.raw.slice(0, 300)}\n\n` +
          (check.detail ?? '') +
          '\n\n最常见的成因是复制参考文献时错了一行。这篇文献确实存在，但引文里' +
          '写的作者、年份或标题指向另一篇。',
        evidence:
          check.claimId === null
            ? [{ kind: 'claim' as const, id: check.id, note: check.raw.slice(0, 200) }]
            : [{ kind: 'claim' as const, id: check.claimId, note: check.raw.slice(0, 200) }],
      });
    }
  }

  /*
   * 引文支撑陈述被标成已支持但没有检索记录。
   *
   * 这是需求 13.9 的兜底检查。写入时已经挡过一道，但审查层再查一遍才能覆盖
   * 历史数据与未来新增的写入口。
   */
  for (const claim of input.claims) {
    if (claim.isCitation !== true) continue;
    if (claim.status !== 'supported') continue;
    if (claim.retrievalBacked === true) continue;

    findings.push({
      severity: 'fail',
      category: 'claim',
      title: `引文支撑陈述被标成已支持，但没有经过检索取证：${claim.locator ?? claim.id}`,
      detail:
        `「${claim.text.slice(0, 300)}」\n\n` +
        '这条断言引用了文献来支撑结论，状态是「证据支持」，但 Claim Ledger 里没有' +
        '任何经过检索的引文核实记录。\n' +
        '需求 13.9 规定引文核实必须经由检索工具取证——一个没有检索记录的' +
        '「已核实」与凭记忆作答在库里长得一样，因此不能作为依据。\n' +
        `用 verify_citations 核实一次（claimId=${claim.id}）。`,
      evidence: [{ kind: 'claim', id: claim.id, note: claim.text.slice(0, 400) }],
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * 汇总入口
 * ------------------------------------------------------------------ */

export interface DeterministicInput {
  artifacts: ArtifactStore;
  messages: readonly Message[];
  /** 只检查本次审查范围内新增的版本。省略表示检查全部血缘不完整的版本。 */
  versionIds?: readonly string[];
  /**
   * 未关闭的断言（需求 13.3）。
   *
   * 省略表示这个部署没有接 Claim Ledger，跳过该组检查。传空数组表示「接了但一条
   * 断言都没有」——两者的区别在于后者说明手稿还没被登记过断言，那本身是个信息。
   */
  claims?: readonly ClaimSnapshot[];
  /**
   * 引文核实记录，按时间倒序（任务 13.5，需求 13.9）。
   *
   * 省略表示这个部署没有接引文核实。
   */
  citationChecks?: readonly CitationCheckSnapshot[];
}

/**
 * 跑全部确定性检查。
 *
 * 版本范围默认取 `irreproducible()`——它已经是「血缘不完整」的全集，比自己
 * 遍历全部版本再筛一遍便宜得多，而且判定口径与制品层一致（判定结果是落库的，
 * 不是每次重算的）。
 */
export function runDeterministicChecks(input: DeterministicInput): readonly DraftFinding[] {
  const versions =
    input.versionIds === undefined
      ? input.artifacts.irreproducible()
      : input.versionIds
          .map((id) => input.artifacts.getVersion(id))
          .filter((v): v is ArtifactVersion => v !== null);

  const describe = (versionId: string): { filename: string; kind: string | null } | null => {
    const version = input.artifacts.getVersion(versionId);
    if (version === null) return null;
    const artifact = input.artifacts.getArtifact(version.artifactId);
    return artifact === null ? null : { filename: artifact.filename, kind: artifact.kind };
  };

  return [
    ...checkArtifactLineage({ versions, describe }),
    ...checkDanglingArtifactRefs({
      messages: input.messages,
      exists: (versionId) => input.artifacts.getVersion(versionId) !== null,
    }),
    ...(input.claims === undefined ? [] : checkClaimSupport({ claims: input.claims })),
    ...(input.citationChecks === undefined
      ? []
      : checkCitationIntegrity({
          checks: input.citationChecks,
          claims: input.claims ?? [],
        })),
  ];
}
