/**
 * Claim Ledger 测试（任务 13.4，需求 13.1-13.4）。
 *
 * 五块重点：
 *
 * 1. **句子切分**。缩写、小数点、中英混排任何一处出错都会把断言切成残句，
 *    而用户看到残句就会认定这套抽取不可信。
 * 2. **四类断言的识别**（需求 13.1）。数值结论、比较陈述、因果陈述、引文支撑陈述
 *    各自的正例与负例。
 * 3. **证据绑定的存在性校验**（需求 13.2）。指向一个编出来的制品版本 id 必须被拒。
 *    这是整套机制里最重要的一道检查：放行会让断言在计数上「有证据」而实际无从核对。
 * 4. **核验结论与模型标识**（需求 13.4）。状态由结论推导，一条矛盾压倒任意多条支持。
 * 5. **Reviewer 的 FAIL 判定**（需求 13.3）。确认过的无证据断言开 FAIL，
 *    自动抽取的只开 WARN——这个区分是让 FAIL 保持可信的唯一办法。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  CLAIM_KIND_LABEL,
  CLAIM_STATUS_LABEL,
  ClaimLedger,
  ClaimsRepo,
  EVIDENCE_KIND_LABEL,
  OPEN_CLAIM_STATUSES,
  VERDICT_LABEL,
  checkClaimSupport,
  classifyClaim,
  extractClaims,
  parseReviewOutput,
  splitSentences,
  type ClaimEvidenceKind,
  type ClaimSnapshot,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let repo: ClaimsRepo;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-claim-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '断言测试' });
  project = store.openProject(created.id);
  repo = new ClaimsRepo(project.db);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

/** 造一个真实存在的制品版本，用于合法的证据绑定。 */
function realVersion(name = 'result.csv'): string {
  return artifacts.save({ filename: name, content: Buffer.from('a,b\n1,2\n'), code: 'print(1)' })
    .version.id;
}

function ledger(overrides: Partial<Parameters<typeof makeLedger>[0]> = {}): ClaimLedger {
  return makeLedger(overrides);
}

function makeLedger(overrides: {
  artifactExists?: (id: string) => boolean;
  refExists?: (id: string) => boolean;
  refIdByDoi?: (doi: string) => string | null;
  computeExists?: (id: string) => boolean;
}): ClaimLedger {
  return new ClaimLedger({
    repo,
    artifactExists: overrides.artifactExists ?? ((id) => artifacts.getVersion(id) !== null),
    ...(overrides.refExists === undefined ? {} : { refExists: overrides.refExists }),
    ...(overrides.refIdByDoi === undefined ? {} : { refIdByDoi: overrides.refIdByDoi }),
    ...(overrides.computeExists === undefined ? {} : { computeExists: overrides.computeExists }),
  });
}

/* ------------------------------------------------------------------ *
 * 1. 句子切分
 * ------------------------------------------------------------------ */

describe('句子切分', () => {
  it('英文句号切分', () => {
    expect(splitSentences('First one. Second one. Third.')).toEqual([
      'First one.',
      'Second one.',
      'Third.',
    ]);
  });

  it('小数点不断句', () => {
    // `p < 0.05` 里的点断句会把统计结论切成两半
    expect(splitSentences('Spindle density differed (p < 0.05). Next.')).toEqual([
      'Spindle density differed (p < 0.05).',
      'Next.',
    ]);
  });

  it('常见缩写不断句', () => {
    for (const abbrev of [
      'As shown in Fig. 2 the effect is large.',
      'See Smith et al. for details.',
      'We used method A vs. method B here.',
      'Values are in ms. i.e. milliseconds throughout.',
      'Data from ref. 12 were reanalysed.',
    ]) {
      expect(splitSentences(abbrev).length, abbrev).toBe(1);
    }
  });

  it('姓名首字母缩写不断句', () => {
    expect(splitSentences('Analysis followed J. B. Smith and colleagues.')).toHaveLength(1);
  });

  it('中文句末标点后不需要空白也能断句', () => {
    expect(splitSentences('第一句话。第二句话！第三句话？')).toEqual([
      '第一句话。',
      '第二句话！',
      '第三句话？',
    ]);
  });

  it('中英混排', () => {
    const result = splitSentences('治疗组的死亡率降低了 30%。This was significant (p = 0.01).');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('30%');
  });

  it('句末标点后的右引号收进本句', () => {
    expect(splitSentences('He said "it works." Then left.')).toEqual([
      'He said "it works."',
      'Then left.',
    ]);
  });

  it('空输入与纯空白返回空数组', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 断言识别
 * ------------------------------------------------------------------ */

describe('断言识别', () => {
  it('数值结论：p 值、置信区间、统计量、样本量都识别', () => {
    for (const [sentence, expected] of [
      ['Density differed between groups (p = 0.003).', 'p = 0.003'],
      ['The effect was moderate (d = 0.62).', 'd = 0.62'],
      ['We enrolled n = 42 participants in total.', 'n = 42'],
      ['Mortality fell by 30% in the treatment arm.', '30%'],
      ['Sampling was performed at 250 Hz throughout.', '250 Hz'],
    ] as const) {
      const result = classifyClaim(sentence);
      expect(result.kinds, sentence).toContain('numeric');
      expect(
        result.numbers.some((n) => n.replace(/\s+/gu, ' ') === expected),
        sentence,
      ).toBe(true);
    }
  });

  it('置信区间被当成一个整体而不是三个孤立数字', () => {
    const result = classifyClaim('The odds ratio was 1.8 (95% CI [1.2, 2.7]).');
    expect(result.numbers.some((n) => n.includes('95') && n.includes('1.2'))).toBe(true);
  });

  it('均值±标准差识别', () => {
    expect(classifyClaim('Age was 24.1 ± 3.2 years.').numbers.some((n) => n.includes('±'))).toBe(
      true,
    );
  });

  it('比较陈述：中英各类表述', () => {
    for (const sentence of [
      'Spindle density was higher in patients than in controls.',
      'Accuracy increased by 12% compared with baseline.',
      'The model significantly outperformed the baseline.',
      'There was no significant difference between arms.',
      '治疗组的死亡率显著低于对照组。',
      '与基线相比，准确率有所提高。',
    ]) {
      expect(classifyClaim(sentence).kinds, sentence).toContain('comparison');
    }
  });

  it('因果陈述：中英各类表述', () => {
    for (const sentence of [
      'Sleep deprivation causes memory impairment.',
      'The intervention led to a reduction in symptoms.',
      'This effect is mediated by hippocampal activity.',
      'Therefore the mechanism must be dopaminergic.',
      '睡眠剥夺导致记忆受损。',
      '因此该机制与多巴胺通路有关。',
    ]) {
      expect(classifyClaim(sentence).kinds, sentence).toContain('causal');
    }
  });

  it('引文支撑陈述：四种引用格式都识别', () => {
    for (const [sentence, expected] of [
      ['Prior work found the same effect [12].', '[12]'],
      ['This was reported earlier (Smith et al., 2023).', '(Smith et al., 2023)'],
      ['Earlier analyses agree \\cite{smith2023sleep} with ours.', '\\cite{smith2023sleep}'],
      ['Consistent with @smith2023sleep the effect holds.', '@smith2023sleep'],
    ] as const) {
      const result = classifyClaim(sentence);
      expect(result.kinds, sentence).toContain('citation');
      expect(
        result.citations.some((c) => c.includes(expected.slice(0, 6))),
        sentence,
      ).toBe(true);
    }
  });

  it('一句话可以同时属于多类', () => {
    const result = classifyClaim(
      'Sleep deprivation caused a 30% reduction in spindle density compared with controls (p < 0.001) [12].',
    );
    expect(result.kinds).toContain('numeric');
    expect(result.kinds).toContain('causal');
    expect(result.kinds).toContain('comparison');
    expect(result.kinds).toContain('citation');
  });

  it('普通陈述不被认成断言', () => {
    for (const sentence of [
      'We describe the experimental setup below.',
      'All procedures were approved by the ethics board.',
      '本文的结构如下。',
    ]) {
      expect(classifyClaim(sentence).kinds, sentence).toHaveLength(0);
    }
  });

  it('类型标签表覆盖全部类型', () => {
    for (const kind of ['numeric', 'comparison', 'causal', 'citation', 'other'] as const) {
      expect(CLAIM_KIND_LABEL[kind]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 手稿抽取
 * ------------------------------------------------------------------ */

const MANUSCRIPT = `# A study of sleep spindles

## Methods

Recordings were made at 250 Hz using a 64-channel system.

\`\`\`python
p = 0.001
n = 9999
print(f"fake numbers {p} {n}")
\`\`\`

## Results

Spindle density was higher in patients than controls (p = 0.003, d = 0.62).
We enrolled n = 42 participants.

| Group | N |
| --- | --- |
| Control | 20 |

## Discussion

Sleep deprivation therefore causes reduced spindle density [12].
Is this effect causal?
`;

describe('手稿抽取', () => {
  it('跳过代码块里的数字', () => {
    const result = extractClaims(MANUSCRIPT);
    // 代码块里的 p = 0.001 与 n = 9999 都不该出现
    const texts = result.claims.map((c) => c.text).join(' ');
    expect(texts).not.toContain('9999');
    expect(texts).not.toContain('fake numbers');
  });

  it('跳过表格行与标题', () => {
    const result = extractClaims(MANUSCRIPT);
    const texts = result.claims.map((c) => c.text);
    expect(texts.some((t) => t.startsWith('|'))).toBe(false);
    expect(texts.some((t) => t.startsWith('#'))).toBe(false);
  });

  it('跳过疑问句', () => {
    const result = extractClaims(MANUSCRIPT);
    expect(result.claims.some((c) => c.text.includes('Is this effect causal'))).toBe(false);
    expect(result.skipped.some((s) => s.reason === '疑问句')).toBe(true);
  });

  it('定位串带章节、段落与句序', () => {
    const result = extractClaims(MANUSCRIPT);
    const found = result.claims.find((c) => c.text.includes('p = 0.003'));
    expect(found?.section).toBe('Results');
    expect(found?.locator).toMatch(/^Results ¶\d+ S\d+$/u);
  });

  it('方法学里的参数也被抽出来——这是刻意接受的误抽', () => {
    const result = extractClaims(MANUSCRIPT);
    // 收紧规则以避免这类误抽会漏掉真正编造的数字，那是这套机制存在的唯一理由。
    // 误抽由 origin='extracted' 机制处理（只报 WARN）
    expect(result.claims.some((c) => c.text.includes('250 Hz'))).toBe(true);
  });

  it('按章节过滤', () => {
    const result = extractClaims(MANUSCRIPT, { sections: ['Results'] });
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.every((c) => c.section === 'Results')).toBe(true);
  });

  it('上限生效并如实报告截断', () => {
    const result = extractClaims(MANUSCRIPT, { limit: 1 });
    expect(result.claims).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('排除某类断言', () => {
    const result = extractClaims(MANUSCRIPT, { excludeKinds: ['numeric'] });
    expect(result.claims.every((c) => c.kind !== 'numeric')).toBe(true);
  });

  it('行内三反引号不会让后半篇被当成代码', () => {
    const md = '## Results\n\nWe used `p` values here and found p = 0.01 in group A.\n';
    const result = extractClaims(md);
    expect(result.claims.some((c) => c.text.includes('p = 0.01'))).toBe(true);
  });

  it('空手稿不崩', () => {
    const result = extractClaims('');
    expect(result.claims).toHaveLength(0);
    expect(result.sentencesScanned).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 仓储与服务：登记
 * ------------------------------------------------------------------ */

describe('断言登记', () => {
  it('类型由文本自动判定，不由调用方给', () => {
    const result = ledger().register({ text: 'Density was higher in patients (p = 0.01).' });
    expect(result.ok).toBe(true);
    expect(result.claim?.kinds).toContain('numeric');
    expect(result.claim?.kinds).toContain('comparison');
    expect(result.claim?.numbers).toContain('p = 0.01');
  });

  it('同一条文本不重复登记', () => {
    const lib = ledger();
    const first = lib.register({ text: 'Density was higher (p = 0.01).' });
    const second = lib.register({ text: '  Density  was   higher (p = 0.01).  ' });
    expect(second.existing).toBe(true);
    expect(second.claim?.id).toBe(first.claim?.id);
    expect(repo.list({ status: 'all' })).toHaveLength(1);
  });

  it('空文本与超长文本被拒', () => {
    expect(ledger().register({ text: '   ' }).ok).toBe(false);
    expect(() => repo.add({ text: 'x'.repeat(4001), kind: 'other' })).toThrow(/4000/);
  });

  it('抽取批量登记，来源标成 extracted', () => {
    const result = ledger().extractAndRegister({ markdown: MANUSCRIPT });
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created.every((c) => c.origin === 'extracted')).toBe(true);
    expect(result.summary).toContain('未经确认');
  });

  it('重复抽取同一份手稿不产生重复断言', () => {
    const lib = ledger();
    const first = lib.extractAndRegister({ markdown: MANUSCRIPT });
    const second = lib.extractAndRegister({ markdown: MANUSCRIPT });
    expect(second.created).toHaveLength(0);
    expect(second.skippedExisting).toBe(first.created.length);
  });

  it('confirm 把 extracted 提升为 user', () => {
    const lib = ledger();
    const claim = lib.extractAndRegister({ markdown: MANUSCRIPT }).created[0];
    expect(claim?.origin).toBe('extracted');
    lib.confirm(claim?.id as string, '确实是本文结论');
    expect(repo.get(claim?.id as string)?.origin).toBe('user');
  });

  it('promoteOrigin 只单向：user 不会被降级回 extracted', () => {
    const claim = repo.add({ text: '用户写的断言（p = 0.01）。', kind: 'numeric', origin: 'user' });
    expect(repo.promoteOrigin(claim.id)).toBe(false);
    expect(repo.get(claim.id)?.origin).toBe('user');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 证据绑定
 * ------------------------------------------------------------------ */

describe('证据绑定', () => {
  it('指向真实存在的制品版本时成功', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const versionId = realVersion();
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'artifact-version',
      ref: versionId,
      locator: 'table 2, row 3',
    });
    expect(result.ok).toBe(true);
    expect(result.claim?.evidence).toHaveLength(1);
    expect(result.claim?.evidence[0]?.locator).toBe('table 2, row 3');
  });

  it('指向编出来的制品版本 id 被拒——这是最重要的一道检查', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'artifact-version',
      ref: 'av_00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不存在');
    // 放行会让这条断言在计数上「有证据」而实际无从核对
    expect(repo.get(claim?.id as string)?.evidence).toHaveLength(0);
  });

  it('格式不对的引用被拒并说明正确形状', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'artifact-version',
      ref: 'not-an-id',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('save_artifacts');
  });

  it('空引用被拒', () => {
    const claim = repo.add({ text: 'x（p = 0.01）', kind: 'numeric' });
    expect(() => repo.bindEvidence({ claimId: claim.id, kind: 'message', ref: '   ' })).toThrow(
      /比没有证据更糟/,
    );
  });

  it('quote 类必须给原文', () => {
    const claim = repo.add({ text: 'x（p = 0.01）', kind: 'numeric' });
    const versionId = realVersion();
    expect(() => repo.bindEvidence({ claimId: claim.id, kind: 'quote', ref: versionId })).toThrow(
      /必须给出原文片段/,
    );
  });

  it('不存在的文献条目被拒', () => {
    const lib = makeLedger({ refExists: () => false });
    const claim = lib.register({ text: 'Prior work agrees [12].' }).claim;
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'ref',
      ref: 'rf_00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('manage_references');
  });

  it('裸 DOI 被接受但给出升级建议', () => {
    const lib = makeLedger({ refIdByDoi: () => 'rf_abcdef01-0000-0000-0000-000000000000' });
    const claim = lib.register({ text: 'Prior work agrees [12].' }).claim;
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'doi',
      ref: '10.1038/nature12373',
    });
    expect(result.ok).toBe(true);
    expect(result.advice).toContain('rf_abcdef01');
  });

  it('库里没有该 DOI 时建议先入库再用 quote', () => {
    const lib = makeLedger({ refIdByDoi: () => null });
    const claim = lib.register({ text: 'Prior work agrees [12].' }).claim;
    const result = lib.bind({
      claimId: claim?.id as string,
      kind: 'doi',
      ref: '10.1038/nature12373',
    });
    expect(result.ok).toBe(true);
    expect(result.advice).toContain('弱证据');
  });

  it('重复绑定同一条证据是幂等的', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const versionId = realVersion();
    lib.bind({ claimId: claim?.id as string, kind: 'artifact-version', ref: versionId });
    lib.bind({
      claimId: claim?.id as string,
      kind: 'artifact-version',
      ref: versionId,
      locator: '补上位置',
    });
    const after = repo.get(claim?.id as string);
    expect(after?.evidence).toHaveLength(1);
    expect(after?.evidence[0]?.locator).toBe('补上位置');
  });

  it('绑定到不存在的断言被拒', () => {
    const result = ledger().bind({
      claimId: 'cl_nope',
      kind: 'artifact-version',
      ref: realVersion(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('断言不存在');
  });

  it('证据类型标签表覆盖全部类型', () => {
    for (const kind of [
      'artifact-version',
      'ref',
      'doi',
      'compute',
      'quote',
      'message',
    ] as ClaimEvidenceKind[]) {
      expect(EVIDENCE_KIND_LABEL[kind]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. 核验
 * ------------------------------------------------------------------ */

describe('核验', () => {
  function withEvidence(): { lib: ClaimLedger; claimId: string; versionId: string } {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const versionId = realVersion();
    lib.bind({ claimId: claim?.id as string, kind: 'artifact-version', ref: versionId });
    return { lib, claimId: claim?.id as string, versionId };
  }

  it('supports 让状态变成 supported，并记下模型标识', () => {
    const { lib, claimId, versionId } = withEvidence();
    const result = lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: 'deepseek:deepseek-chat',
    });
    expect(result.ok).toBe(true);
    expect(result.claim?.status).toBe('supported');
    const evidence = result.claim?.evidence[0];
    expect(evidence?.verdict).toBe('supports');
    expect(evidence?.verifiedByModelId).toBe('deepseek:deepseek-chat');
    expect(evidence?.verifiedAt).not.toBeNull();
  });

  it('一条矛盾压倒任意多条支持', () => {
    const { lib, claimId, versionId } = withEvidence();
    const second = realVersion('other.csv');
    lib.bind({ claimId, kind: 'artifact-version', ref: second });

    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: 'm1',
    });
    expect(repo.get(claimId)?.status).toBe('supported');

    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: second,
      verdict: 'contradicts',
      modelId: 'm2',
    });
    // 取多数会把这个信号抹掉
    expect(repo.get(claimId)?.status).toBe('refuted');
  });

  it('insufficient 让状态变成 insufficient', () => {
    const { lib, claimId, versionId } = withEvidence();
    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'insufficient',
      modelId: 'm1',
    });
    expect(repo.get(claimId)?.status).toBe('insufficient');
  });

  it('unrelated 不改变状态：无关的证据等于没有证据', () => {
    const { lib, claimId, versionId } = withEvidence();
    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'unrelated',
      modelId: 'm1',
    });
    expect(repo.get(claimId)?.status).toBe('open');
  });

  it('空的模型标识被拒（需求 13.4）', () => {
    const { lib, claimId, versionId } = withEvidence();
    const result = lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: '   ',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('模型标识');
  });

  it('对不存在的证据记结论时报错并指出该先绑定', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    const result = lib.verify({
      claimId: claim?.id as string,
      kind: 'artifact-version',
      ref: realVersion(),
      verdict: 'supports',
      modelId: 'm1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('先绑定证据');
  });

  it('解绑之后状态按剩余证据重算', () => {
    const { lib, claimId, versionId } = withEvidence();
    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: 'm1',
    });
    expect(repo.get(claimId)?.status).toBe('supported');
    lib.unbind(claimId, 'artifact-version', versionId);
    expect(repo.get(claimId)?.status).toBe('open');
  });

  it('手工关闭必须给理由', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Density was higher (p = 0.01).' }).claim;
    expect(lib.close(claim?.id as string, 'dismissed', '   ').ok).toBe(false);
    expect(lib.close(claim?.id as string, 'dismissed', '这是背景陈述').ok).toBe(true);
    expect(repo.get(claim?.id as string)?.status).toBe('dismissed');
  });

  it('已关闭的断言不被结论推导覆盖', () => {
    const { lib, claimId, versionId } = withEvidence();
    lib.close(claimId, 'retracted', '已从手稿删除');
    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'supports',
      modelId: 'm1',
    });
    // retracted 是关于「要不要核验」的决定，不该被「它对不对」的判断改掉
    expect(repo.get(claimId)?.status).toBe('retracted');
  });

  it('重新打开后按已有结论重算，核验历史保留', () => {
    const { lib, claimId, versionId } = withEvidence();
    lib.verify({
      claimId,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'contradicts',
      modelId: 'm1',
    });
    lib.close(claimId, 'dismissed', '暂时搁置');
    lib.reopen(claimId, '重新处理');
    const after = repo.get(claimId);
    expect(after?.status).toBe('refuted');
    expect(after?.evidence[0]?.verdict).toBe('contradicts');
    expect(after?.evidence[0]?.verifiedByModelId).toBe('m1');
  });

  it('结论标签表齐全', () => {
    for (const verdict of ['supports', 'contradicts', 'insufficient', 'unrelated'] as const) {
      expect(VERDICT_LABEL[verdict]).toBeTruthy();
    }
    for (const status of [
      'open',
      'supported',
      'insufficient',
      'refuted',
      'retracted',
      'dismissed',
    ] as const) {
      expect(CLAIM_STATUS_LABEL[status]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. 汇总
 * ------------------------------------------------------------------ */

describe('汇总', () => {
  it('未关闭状态集合含 refuted 与 insufficient', () => {
    // refuted 算未关闭是刻意的：手稿里有一句已知错误的陈述，事情没完
    expect(OPEN_CLAIM_STATUSES).toContain('open');
    expect(OPEN_CLAIM_STATUSES).toContain('insufficient');
    expect(OPEN_CLAIM_STATUSES).toContain('refuted');
    expect(OPEN_CLAIM_STATUSES).not.toContain('supported');
  });

  it('blocking 计入无证据与证据矛盾', () => {
    const lib = ledger();
    lib.register({ text: 'Claim without evidence at all (p = 0.01).', origin: 'user' });
    const withBad = lib.register({
      text: 'Claim with bad evidence (p = 0.02).',
      origin: 'user',
    }).claim;
    const versionId = realVersion();
    lib.bind({ claimId: withBad?.id as string, kind: 'artifact-version', ref: versionId });
    lib.verify({
      claimId: withBad?.id as string,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'contradicts',
      modelId: 'm1',
    });

    const summary = lib.summary();
    expect(summary.unsupported).toBe(1);
    expect(summary.refuted).toBe(1);
    expect(summary.blocking).toBe(2);
  });

  it('gateSummary 在有阻断项时明确说不该宣称完成', () => {
    const lib = ledger();
    lib.register({ text: 'Unsupported claim (p = 0.01).', origin: 'user' });
    expect(lib.gateSummary()).toContain('不应宣称手稿完成');
  });

  it('空库时 gateSummary 如实说没有断言', () => {
    expect(ledger().gateSummary()).toContain('还没有登记任何断言');
  });

  it('unsupported 按来源分成两组', () => {
    const lib = ledger();
    lib.register({ text: 'Confirmed claim (p = 0.01).', origin: 'user' });
    lib.register({ text: 'Extracted claim (p = 0.02).', origin: 'extracted' });
    const result = lib.unsupported();
    expect(result.confirmed).toHaveLength(1);
    expect(result.extracted).toHaveLength(1);
  });

  it('unsupportedOnly 过滤掉已有证据的', () => {
    const lib = ledger();
    const withEv = lib.register({ text: 'Has evidence (p = 0.01).' }).claim;
    lib.register({ text: 'No evidence (p = 0.02).' });
    lib.bind({ claimId: withEv?.id as string, kind: 'artifact-version', ref: realVersion() });

    expect(repo.list({ unsupportedOnly: true })).toHaveLength(1);
    expect(repo.list({ unsupportedOnly: true })[0]?.text).toContain('No evidence');
  });

  it('claimsCiting 找出引用某个制品的全部断言', () => {
    const lib = ledger();
    const versionId = realVersion();
    const a = lib.register({ text: 'First claim (p = 0.01).' }).claim;
    const b = lib.register({ text: 'Second claim (p = 0.02).' }).claim;
    lib.bind({ claimId: a?.id as string, kind: 'artifact-version', ref: versionId });
    lib.bind({ claimId: b?.id as string, kind: 'artifact-version', ref: versionId });

    expect(repo.claimsCiting('artifact-version', versionId)).toHaveLength(2);
  });

  it('删断言时证据级联删除', () => {
    const lib = ledger();
    const claim = lib.register({ text: 'Claim (p = 0.01).' }).claim;
    const claimId = claim?.id as string;
    lib.bind({ claimId, kind: 'artifact-version', ref: realVersion() });
    repo.delete(claimId);
    expect(repo.evidence(claimId)).toHaveLength(0);
  });

  it('列表把 refuted 排在最前', () => {
    const lib = ledger();
    lib.register({ text: 'Open claim (p = 0.01).' });
    const bad = lib.register({ text: 'Refuted claim (p = 0.02).' }).claim;
    const versionId = realVersion();
    lib.bind({ claimId: bad?.id as string, kind: 'artifact-version', ref: versionId });
    lib.verify({
      claimId: bad?.id as string,
      kind: 'artifact-version',
      ref: versionId,
      verdict: 'contradicts',
      modelId: 'm1',
    });
    expect(repo.list()[0]?.status).toBe('refuted');
  });
});

/* ------------------------------------------------------------------ *
 * 8. Reviewer 集成
 * ------------------------------------------------------------------ */

describe('Reviewer 的断言检查', () => {
  function snapshot(overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
    return {
      id: 'cl_1',
      text: 'Density was higher in patients (p = 0.003).',
      locator: 'Results ¶1 S1',
      status: 'open',
      origin: 'user',
      numbers: ['p = 0.003'],
      evidence: [],
      ...overrides,
    };
  }

  it('确认过的无证据断言开 FAIL（需求 13.3）', () => {
    const findings = checkClaimSupport({ claims: [snapshot()] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.category).toBe('claim');
    expect(findings[0]?.evidence[0]?.kind).toBe('claim');
    expect(findings[0]?.evidence[0]?.id).toBe('cl_1');
    // 数值要出现在 detail 里：它们是必须能指到出处的东西
    expect(findings[0]?.detail).toContain('p = 0.003');
  });

  it('自动抽取的无证据断言只开 WARN，且合并成一条', () => {
    const claims = Array.from({ length: 8 }, (_, i) =>
      snapshot({ id: `cl_${String(i)}`, origin: 'extracted' }),
    );
    const findings = checkClaimSupport({ claims });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.title).toContain('8 条');
    // 合并是刻意的：八条 FAIL 会让用户关掉审查
    expect(findings[0]?.detail).toContain('confirm');
  });

  it('证据矛盾逐条开 FAIL 而不合并', () => {
    const claims = [
      snapshot({
        id: 'cl_a',
        status: 'refuted',
        evidence: [{ kind: 'artifact-version', ref: 'av_1', verdict: 'contradicts', quote: null }],
      }),
      snapshot({
        id: 'cl_b',
        status: 'refuted',
        evidence: [{ kind: 'artifact-version', ref: 'av_2', verdict: 'contradicts', quote: null }],
      }),
    ];
    const findings = checkClaimSupport({ claims });
    // 合并之后 mark_addressed 只能整条标记，于是修一句就把两条都标成已处理
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'fail')).toBe(true);
    expect(findings[0]?.detail).toContain('一条矛盾压倒任意多条支持');
  });

  it('证据不足开 WARN', () => {
    const findings = checkClaimSupport({
      claims: [
        snapshot({
          status: 'insufficient',
          evidence: [{ kind: 'ref', ref: 'rf_1', verdict: 'insufficient', quote: null }],
        }),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.title).toContain('证据不足');
  });

  it('有证据且已支持的断言不产生发现', () => {
    const findings = checkClaimSupport({
      claims: [
        snapshot({
          status: 'open',
          evidence: [{ kind: 'artifact-version', ref: 'av_1', verdict: 'supports', quote: null }],
        }),
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it('空断言集合不产生发现', () => {
    expect(checkClaimSupport({ claims: [] })).toHaveLength(0);
  });

  it('解析器现在接受 claim 类证据', () => {
    const output = JSON.stringify({
      findings: [
        {
          severity: 'fail',
          category: 'claim',
          title: '数字与表格不一致',
          detail: '正文说 30%，表 2 里是 22%',
          evidence: [{ kind: 'claim', id: 'cl_1', note: '正文那一句' }],
        },
      ],
    });
    const parsed = parseReviewOutput(output, {
      allowedMessageIds: new Set(),
      allowedVersionIds: new Set(),
      allowedClaimIds: new Set(['cl_1']),
      recheckableIds: new Set(),
    });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.evidence[0]?.kind).toBe('claim');
  });

  it('不在范围内的 claim id 被拒，原因说清是范围问题', () => {
    const output = JSON.stringify({
      findings: [
        {
          severity: 'fail',
          category: 'claim',
          title: 'x',
          detail: 'y',
          evidence: [{ kind: 'claim', id: 'cl_other' }],
        },
      ],
    });
    const parsed = parseReviewOutput(output, {
      allowedMessageIds: new Set(),
      allowedVersionIds: new Set(),
      allowedClaimIds: new Set(['cl_1']),
      recheckableIds: new Set(),
    });
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejected.join(' ')).toContain('不在本次审查范围内');
  });

  it('没有断言清单时的原因与「不在范围内」不同', () => {
    const output = JSON.stringify({
      findings: [
        {
          severity: 'fail',
          category: 'claim',
          title: 'x',
          detail: 'y',
          evidence: [{ kind: 'claim', id: 'cl_1' }],
        },
      ],
    });
    const parsed = parseReviewOutput(output, {
      allowedMessageIds: new Set(),
      allowedVersionIds: new Set(),
      recheckableIds: new Set(),
    });
    expect(parsed.rejected.join(' ')).toContain('还没登记断言');
  });
});
