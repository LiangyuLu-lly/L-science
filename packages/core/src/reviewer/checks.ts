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
 * 汇总入口
 * ------------------------------------------------------------------ */

export interface DeterministicInput {
  artifacts: ArtifactStore;
  messages: readonly Message[];
  /** 只检查本次审查范围内新增的版本。省略表示检查全部血缘不完整的版本。 */
  versionIds?: readonly string[];
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
  ];
}
