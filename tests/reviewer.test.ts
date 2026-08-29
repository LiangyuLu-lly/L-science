/**
 * Reviewer Service 测试（任务 12.8，需求 11.1-11.8）。
 *
 * 重点在三条：
 *
 * 1. **异厂商约束与降级要如实。** 只有一家供应商时必须明确告知，不能静默用同厂商
 *    顶上然后让用户以为审查过了。
 * 2. **编造的发现必须被挡住。** 一个会编造证据的审查者比没有审查更糟：用户点进去
 *    发现打不开，之后就不再相信任何 finding。
 * 3. **确定性层不依赖模型。** 没有第二家供应商时它仍然完整可用，而这正是它存在的理由。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  FindingsRepo,
  ReviewerService,
  buildReviewContext,
  checkArtifactLineage,
  checkDanglingArtifactRefs,
  createCheckFindingsTool,
  createMarkFindingAddressedTool,
  createRequestReviewTool,
  extractJsonObject,
  parseReviewOutput,
  reviewerSystemPrompt,
  runDeterministicChecks,
  pickCrossVendor,
  type ArtifactVersion,
  type ProjectStore,
} from '@l-science/core';
import type { ModelDescriptor } from '@l-science/shared';

/* ------------------------------------------------------------------ *
 * 固定件
 * ------------------------------------------------------------------ */

let root: string;
let store: AppStore;
let project: ProjectStore;
let artifacts: ArtifactStore;
let findings: FindingsRepo;
let conversationId: string;
let projectId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-reviewer-'));
  store = AppStore.open(join(root, 'app'));
  const created = store.createProject({ name: '审查测试' });
  projectId = created.id;
  project = store.openProject(created.id);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
  findings = new FindingsRepo(project.db);
  conversationId = project.conversations.create({ title: '会话' }).id;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 保存一个制品版本，可控制血缘。 */
function saveArtifact(input: {
  filename: string;
  code?: string;
  language?: string;
  inputVersionIds?: readonly string[];
  content?: string;
}): { versionId: string; artifactId: string } {
  const file = join(root, input.filename);
  writeFileSync(file, input.content ?? 'x,y\n1,2\n', 'utf8');
  const result = artifacts.save({
    filename: input.filename,
    content: Buffer.from(input.content ?? 'x,y\n1,2\n'),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.inputVersionIds === undefined ? {} : { inputVersionIds: input.inputVersionIds }),
  });
  return { versionId: result.version.id, artifactId: result.artifact.id };
}

const model = (
  over: Partial<ModelDescriptor> & { id: string; providerId: string },
): ModelDescriptor => ({
  displayName: over.id,
  modalities: ['text'],
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
  performance: { medianLatencyMs: 600, tokensPerSec: 40 },
  policy: { trainingUse: 'none', retentionDays: 0, zdr: true, region: 'cn' },
  strengths: {
    reasoning: 70,
    coding: 70,
    math: 70,
    longContextRecall: 70,
    writingZh: 70,
    writingEn: 70,
    toolUse: 70,
    structuredOutput: 70,
    citationFidelity: 70,
    instructionFollowing: 70,
  },
  features: { streaming: true, toolUse: true, promptCache: false, vision: false, thinking: false },
  local: false,
  ...over,
});

/* ------------------------------------------------------------------ *
 * 确定性检查
 * ------------------------------------------------------------------ */

describe('确定性检查：制品血缘', () => {
  it('图像缺生成代码是 FAIL', () => {
    const { versionId } = saveArtifact({ filename: 'fig1.png', content: '\x89PNG fake' });
    const drafts = runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] });

    const lineage = drafts.find((d) => d.category === 'reproducibility');
    // 一张答不出「怎么画出来的」的图在论文里不可用
    expect(lineage?.severity).toBe('fail');
    expect(lineage?.evidence[0]?.id).toBe(versionId);
  });

  it('非图像缺生成代码只是 WARN', () => {
    const { versionId } = saveArtifact({ filename: 'raw.csv' });
    const drafts = runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] });
    // 数据文件可能就是用户放进来的原始记录，本来没有生成代码
    expect(drafts.find((d) => d.category === 'reproducibility')?.severity).toBe('warn');
  });

  it('血缘完整时不报', () => {
    const { versionId } = saveArtifact({
      filename: 'result.csv',
      language: 'python',
      code: 'import pandas as pd\ndf = pd.read_csv("in.csv")\ndf.to_csv("result.csv")',
    });
    expect(runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] })).toEqual(
      [],
    );
  });

  it('用了随机但没固定种子 → WARN', () => {
    const { versionId } = saveArtifact({
      filename: 'boot.csv',
      language: 'python',
      code:
        'import numpy as np, pandas as pd\n' +
        'df = pd.read_csv("in.csv")\n' +
        'idx = np.random.choice(len(df), 1000)\n' +
        'df.iloc[idx].to_csv("boot.csv")',
    });
    const drafts = runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] });
    const seed = drafts.find((d) => d.title.includes('种子'));
    expect(seed?.severity).toBe('warn');
    // 指引要能照着改
    expect(seed?.detail).toContain('default_rng(42)');
  });

  it('固定了种子就不报', () => {
    const { versionId } = saveArtifact({
      filename: 'boot.csv',
      language: 'python',
      code:
        'import numpy as np, pandas as pd\n' +
        'rng = np.random.default_rng(42)\n' +
        'df = pd.read_csv("in.csv")\n' +
        'df.sample(100, random_state=7).to_csv("boot.csv")',
    });
    const drafts = runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] });
    expect(drafts.filter((d) => d.title.includes('种子'))).toHaveLength(0);
  });

  it('R 的 set.seed 也认', () => {
    const { versionId } = saveArtifact({
      filename: 'perm.csv',
      language: 'r',
      code: 'set.seed(42)\nd <- read.csv("in.csv")\nwrite.csv(d[sample(nrow(d)), ], "perm.csv")',
    });
    expect(
      runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] }).filter((d) =>
        d.title.includes('种子'),
      ),
    ).toHaveLength(0);
  });

  it('random_state=None 不算固定了种子', () => {
    const { versionId } = saveArtifact({
      filename: 'split.csv',
      language: 'python',
      code:
        'import pandas as pd\nfrom sklearn.model_selection import train_test_split\n' +
        'df = pd.read_csv("in.csv")\n' +
        'a, b = train_test_split(df, random_state=None)',
    });
    // 显式的「不固定」与「忘了固定」在可复现性上是同一件事
    expect(
      runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] }).filter((d) =>
        d.title.includes('种子'),
      ),
    ).toHaveLength(1);
  });

  it('输入无从追溯 → integrity WARN', () => {
    const { versionId } = saveArtifact({
      filename: 'summary.csv',
      language: 'python',
      code: 'rows = [["mean", 3.42], ["sd", 1.07]]\nwith_open = None',
    });
    const drafts = runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] });
    const integrity = drafts.find((d) => d.category === 'integrity');
    expect(integrity?.title).toContain('输入无从追溯');
    expect(integrity?.detail).toContain('不能当作证据');
  });

  it('读了文件就不报输入无从追溯', () => {
    const { versionId } = saveArtifact({
      filename: 'summary.csv',
      language: 'python',
      code: 'import pandas as pd\ndf = pd.read_csv("in.csv")\ndf.describe().to_csv("summary.csv")',
    });
    expect(
      runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] }).filter(
        (d) => d.category === 'integrity',
      ),
    ).toHaveLength(0);
  });

  it('登记了输入版本也不报', () => {
    const first = saveArtifact({
      filename: 'in.csv',
      language: 'python',
      code: 'open("in.csv","w").write("x")',
    });
    const { versionId } = saveArtifact({
      filename: 'out.csv',
      language: 'python',
      code: 'rows = [[1, 2]]',
      inputVersionIds: [first.versionId],
    });
    expect(
      runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] }).filter(
        (d) => d.category === 'integrity',
      ),
    ).toHaveLength(0);
  });

  it('模拟数据不算输入无从追溯', () => {
    const { versionId } = saveArtifact({
      filename: 'sim.csv',
      language: 'python',
      code: 'import numpy as np\nrng = np.random.default_rng(1)\nx = rng.normal(size=100)',
    });
    // 明确的模拟是合法的产物，只是要说清楚它是模拟
    expect(
      runDeterministicChecks({ artifacts, messages: [], versionIds: [versionId] }).filter(
        (d) => d.category === 'integrity',
      ),
    ).toHaveLength(0);
  });

  it('checkArtifactLineage 在拿不到制品信息时用版本 id 兜底', () => {
    const drafts = checkArtifactLineage({
      versions: [
        {
          id: 'av_x',
          artifactId: 'a_x',
          versionNo: 1,
          blobSha256: 'x',
          createdByToolCallId: null,
          language: null,
          codeLineage: null,
          createdAt: Date.now(),
        } satisfies ArtifactVersion,
      ],
      describe: () => null,
    });
    expect(drafts[0]?.title).toContain('av_x');
  });
});

describe('确定性检查：悬空制品引用', () => {
  const fakeId = 'av_11111111-2222-3333-4444-555555555555';

  it('引用了不存在的版本 → FAIL', () => {
    const message = project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text: `结果见 {{artifact:${fakeId}}}` },
    });

    const drafts = checkDanglingArtifactRefs({
      messages: [message],
      exists: () => false,
    });
    expect(drafts[0]?.severity).toBe('fail');
    expect(drafts[0]?.category).toBe('evidence');
    expect(drafts[0]?.evidence[0]?.id).toBe(message.id);
  });

  it('真实存在的引用不报', () => {
    const { versionId } = saveArtifact({ filename: 'ok.csv' });
    const message = project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text: `见 {{artifact:${versionId}}}` },
    });
    expect(
      runDeterministicChecks({ artifacts, messages: [message], versionIds: [] }).filter(
        (d) => d.category === 'evidence',
      ),
    ).toHaveLength(0);
  });

  it('用户消息里的引用不检查：那是用户写的，不是模型编的', () => {
    const message = project.messages.append({
      conversationId,
      role: 'user',
      content: { kind: 'text', text: `看看 {{artifact:${fakeId}}}` },
    });
    expect(checkDanglingArtifactRefs({ messages: [message], exists: () => false })).toEqual([]);
  });

  it('同一条消息里多个坏 id 合成一条发现', () => {
    const second = 'av_99999999-8888-7777-6666-555555555555';
    const message = project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text: `${fakeId} 与 ${second}` },
    });
    const drafts = checkDanglingArtifactRefs({ messages: [message], exists: () => false });
    // 一条消息一条发现：两条会让同一个问题在列表里出现两次
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toContain('2 个');
  });
});

/* ------------------------------------------------------------------ *
 * 输出解析
 * ------------------------------------------------------------------ */

describe('extractJsonObject', () => {
  it('认围栏代码块', () => {
    expect(extractJsonObject('说明\n```json\n{"a":1}\n```\n结尾')).toBe('{"a":1}');
  });

  it('没有围栏时按括号配平取第一个对象', () => {
    expect(extractJsonObject('前言 {"a":{"b":2}} 后记')).toBe('{"a":{"b":2}}');
  });

  it('跳过字符串里的括号', () => {
    // detail 里引用一段代码时出现 } 完全正常，按字符计数会截在半截上
    const text = '{"detail":"if (x) { y }","a":1}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('跳过转义引号', () => {
    const text = '{"detail":"他说 \\"好\\" 然后 }","a":1}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('找不到对象时返回 null', () => {
    expect(extractJsonObject('完全没有 JSON')).toBeNull();
  });
});

describe('parseReviewOutput', () => {
  const options = {
    allowedMessageIds: new Set(['msg_1']),
    allowedVersionIds: new Set(['av_1']),
    recheckableIds: new Set(['fd_1']),
  };

  it('解析合法输出', () => {
    const parsed = parseReviewOutput(
      `\`\`\`json
{"findings":[{"severity":"fail","category":"statistics","title":"未校正多重比较",
"detail":"做了 12 次检验。","evidence":[{"kind":"message","id":"msg_1","note":"这里"}]}]}
\`\`\``,
      options,
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.severity).toBe('fail');
    expect(parsed.findings[0]?.evidence[0]?.kind).toBe('message');
    expect(parsed.rejected).toEqual([]);
  });

  it('大写的 severity 不被接受但也不崩', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"FAIL","category":"statistics","title":"x",' +
        '"evidence":[{"kind":"message","id":"msg_1"}]}]}',
      options,
    );
    // 小写化之后 'fail' 能命中，因此这条应当被接受
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.severity).toBe('fail');
  });

  it('编造的证据 id 让整条发现被丢弃', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"warn","category":"evidence","title":"x",' +
        '"evidence":[{"kind":"message","id":"msg_编的"}]}]}',
      options,
    );
    // 会编造证据的审查者比没有审查更糟
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejected.join()).toContain('不在允许清单');
  });

  it('部分证据有效时保留有效的那些', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"warn","category":"evidence","title":"x",' +
        '"evidence":[{"kind":"message","id":"msg_编的"},{"kind":"message","id":"msg_1"}]}]}',
      options,
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.evidence).toHaveLength(1);
  });

  it('kind 写错但 id 认得出来时按 id 判定', () => {
    // 模型常把 artifact-version 写成 artifact
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"warn","category":"reproducibility","title":"x",' +
        '"evidence":[{"kind":"artifact","id":"av_1"}]}]}',
      options,
    );
    expect(parsed.findings[0]?.evidence[0]?.kind).toBe('artifact-version');
  });

  /*
   * claim 类证据在 M3 里是被明确拒绝的（当时没有 Claim Ledger）。任务 13.4 落地之后
   * 它被放开，但仍然只接受**在本次审查范围内**的断言 id——这里的 options 没有给
   * allowedClaimIds，因此拒绝依旧，只是原因换成了「该项目还没登记断言」。
   */
  it('没有断言清单时 claim 类证据被拒，原因指向未登记而不是不支持', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"warn","category":"claim","title":"x",' +
        '"evidence":[{"kind":"claim","id":"cl_1"}]}]}',
      options,
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejected.join()).toContain('还没登记断言');
  });

  it('claim id 在范围内时被接受', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"fail","category":"claim","title":"数字与表格不一致",' +
        '"evidence":[{"kind":"claim","id":"cl_1"}]}]}',
      { ...options, allowedClaimIds: new Set(['cl_1']) },
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.category).toBe('claim');
    expect(parsed.findings[0]?.evidence[0]?.kind).toBe('claim');
  });

  it('没有证据的发现被丢弃', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"fail","category":"statistics","title":"统计方法需要复核"}]}',
      options,
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejected.join()).toContain('没有可核对的证据');
  });

  it('非法 category 被丢弃并记原因', () => {
    const parsed = parseReviewOutput(
      '{"findings":[{"severity":"warn","category":"typo","title":"x",' +
        '"evidence":[{"kind":"message","id":"msg_1"}]}]}',
      options,
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejected.join()).toContain('category 非法');
  });

  it('空 findings 是正常结果', () => {
    const parsed = parseReviewOutput('{"findings":[]}', options);
    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected).toEqual([]);
  });

  it('完全不是 JSON 时给出可读原因而不是抛错', () => {
    const parsed = parseReviewOutput('我看了一下，没什么问题。', options);
    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected[0]).toContain('找不到 JSON');
  });

  it('JSON 语法坏了也不抛错', () => {
    const parsed = parseReviewOutput('{"findings": [1,,2]}', options);
    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected[0]).toContain('无法解析');
  });

  it('输出被截断时指向输出预算而不是提示词', () => {
    // 审查者的 detail 可以很长，撞上 max_tokens 是真实的失败模式；
    // 报成「找不到 JSON」会让人去改提示词，而该改的是输出上限
    const parsed = parseReviewOutput('{"findings":[{"title":"很长的说明', options);
    expect(parsed.rejected[0]).toContain('截断');
  });

  it('复核判定只接受待复核列表里的 id', () => {
    const parsed = parseReviewOutput(
      '{"findings":[],"rechecks":[{"id":"fd_1","verdict":"resolve","note":"确认已改"},' +
        '{"id":"fd_别的","verdict":"reopen","note":"x"}]}',
      options,
    );
    expect(parsed.rechecks).toHaveLength(1);
    expect(parsed.rechecks[0]?.verdict).toBe('resolve');
    expect(parsed.rejected.join()).toContain('不在待复核列表');
  });

  it('非法 verdict 被丢弃', () => {
    const parsed = parseReviewOutput(
      '{"findings":[],"rechecks":[{"id":"fd_1","verdict":"maybe","note":"x"}]}',
      options,
    );
    expect(parsed.rechecks).toHaveLength(0);
    expect(parsed.rejected.join()).toContain('verdict 非法');
  });
});

/* ------------------------------------------------------------------ *
 * 上下文组装
 * ------------------------------------------------------------------ */

describe('buildReviewContext', () => {
  it('只列出真实存在的 id 作为可引用证据', () => {
    const message = project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text: '均值是 3.42' },
    });
    const { versionId } = saveArtifact({ filename: 'r.csv', code: 'x = 1', language: 'python' });

    const context = buildReviewContext({
      conversationId,
      messages: [message],
      artifacts,
      versionIds: [versionId],
      pendingRecheck: [],
      openFindings: [],
    });

    expect(context.allowedEvidence.messages.has(message.id)).toBe(true);
    expect(context.allowedEvidence.versions.has(versionId)).toBe(true);
    expect(context.text).toContain('可引用的证据 id');
    expect(context.text).toContain(message.id);
  });

  it('系统消息不进上下文', () => {
    const system = project.messages.append({
      conversationId,
      role: 'system',
      content: { kind: 'turn-summary', stopReason: 'max-turns', detail: '撞上限' },
    });
    const context = buildReviewContext({
      conversationId,
      messages: [system],
      artifacts,
      versionIds: [],
      pendingRecheck: [],
      openFindings: [],
    });
    expect(context.allowedEvidence.messages.size).toBe(0);
  });

  it('待复核的发现带上自报说明', () => {
    const finding = findings.add({
      conversationId,
      severity: 'warn',
      category: 'statistics',
      title: '未校正多重比较',
      evidence: [{ kind: 'message', id: 'msg_x' }],
    });
    findings.claimFixed(finding.id, '已改用 Benjamini-Hochberg');

    const context = buildReviewContext({
      conversationId,
      messages: [],
      artifacts,
      versionIds: [],
      pendingRecheck: findings.list({ conversationId, status: 'claimed-fixed' }),
      openFindings: [],
    });
    expect(context.text).toContain('待复核');
    expect(context.text).toContain('Benjamini-Hochberg');
  });

  it('已提出的 open 发现列出来避免重复', () => {
    findings.add({
      conversationId,
      severity: 'fail',
      category: 'evidence',
      title: '引用对不上',
      evidence: [{ kind: 'message', id: 'msg_x' }],
    });
    const context = buildReviewContext({
      conversationId,
      messages: [],
      artifacts,
      versionIds: [],
      pendingRecheck: [],
      openFindings: findings.list({ conversationId, status: 'open' }),
    });
    expect(context.text).toContain('不要重复提出');
    expect(context.text).toContain('引用对不上');
  });

  it('超长消息被截断而不是让请求超窗', () => {
    const message = project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text: 'x'.repeat(50_000) },
    });
    const context = buildReviewContext({
      conversationId,
      messages: [message],
      artifacts,
      versionIds: [],
      pendingRecheck: [],
      openFindings: [],
    });
    expect(context.text).toContain('截断');
    expect(context.text.length).toBeLessThan(50_000);
  });

  it('系统提示词写明严重度判据', () => {
    const prompt = reviewerSystemPrompt();
    // 不写的话模型会把所有发现都标 FAIL，于是每轮都被打断，用户会关掉审查
    expect(prompt).toContain('把不确定的问题标成 `warn`');
    expect(prompt).toContain('不要为了显得有用而凑');
  });
});

/* ------------------------------------------------------------------ *
 * 异厂商约束
 * ------------------------------------------------------------------ */

describe('异厂商约束（需求 11.2）', () => {
  it('有异厂商模型时选它', () => {
    const picked = pickCrossVendor(
      [model({ id: 'a', providerId: 'deepseek' }), model({ id: 'b', providerId: 'ollama' })],
      'deepseek',
    );
    expect(picked.model?.providerId).toBe('ollama');
    expect(picked.degradedReason).toBeNull();
  });

  it('只有一家时用它但明确告知降级', () => {
    const picked = pickCrossVendor([model({ id: 'a', providerId: 'deepseek' })], 'deepseek');
    expect(picked.model?.id).toBe('a');
    // 静默用同厂商顶上会让用户以为审查过了
    expect(picked.degradedReason).toContain('同厂商');
    expect(picked.degradedReason).toContain('不构成额外保证');
  });

  it('完全没有模型时说清楚', () => {
    const picked = pickCrossVendor([], 'deepseek');
    expect(picked.model).toBeNull();
    expect(picked.degradedReason).toContain('没有可用模型');
  });
});

/* ------------------------------------------------------------------ *
 * ReviewerService
 * ------------------------------------------------------------------ */

/** 造一个只回固定文本的适配器注册表。 */
function fakeAdapters(reply: string | (() => string)) {
  const calls: Array<{ providerId: string; system: string; user: string }> = [];
  return {
    calls,
    registry: {
      get: (providerId: string) => ({
        chat: (
          _ctx: unknown,
          req: { messages: ReadonlyArray<{ role: string; content: string }> },
        ) => {
          calls.push({
            providerId,
            system: req.messages.find((m) => m.role === 'system')?.content ?? '',
            user: req.messages.find((m) => m.role === 'user')?.content ?? '',
          });
          const text = typeof reply === 'string' ? reply : reply();
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: 'text', text };
              yield {
                kind: 'done',
                usage: { tokensIn: 10, tokensOut: 20, cost: 0.001, currency: 'USD' },
                stopReason: 'end_turn',
              };
            },
          };
        },
      }),
    },
  };
}

function makeService(input: {
  reply?: string | (() => string);
  models?: readonly ModelDescriptor[];
  onFail?: (i: { conversationId: string; findings: readonly unknown[] }) => void;
}) {
  const adapters = fakeAdapters(input.reply ?? '{"findings":[]}');
  const service = new ReviewerService({
    findings,
    artifacts,
    messages: project.messages,
    adapters: adapters.registry as never,
    adapterContext: (providerId) => ({ baseUrl: `http://127.0.0.1/${providerId}` }) as never,
    routerView: () => ({
      models: input.models ?? [
        model({ id: 'reviewer-model', providerId: 'ollama' }),
        model({ id: 'writer-model', providerId: 'deepseek' }),
      ],
      runtime: new Map(),
    }),
    ...(input.onFail === undefined ? {} : { onFail: input.onFail as never }),
  });
  return { service, adapters };
}

describe('ReviewerService', () => {
  /** 造一条带 providerId 的助手消息，作为「被审查内容的生成方」。 */
  const seedAssistant = (text: string) =>
    project.messages.append({
      conversationId,
      role: 'assistant',
      content: { kind: 'text', text },
      modelId: 'writer-model',
      providerId: 'deepseek',
    });

  it('空会话直接跳过', async () => {
    const { service } = makeService({});
    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(outcome.status).toBe('skipped');
    expect(outcome.runId).toBeNull();
  });

  it('审查者必须是异厂商模型', async () => {
    seedAssistant('均值是 3.42');
    const { service, adapters } = makeService({});
    await service.schedule({ conversationId, trigger: 'turn-end' });

    // 被审查内容来自 deepseek，审查必须走另一家
    expect(adapters.calls[0]?.providerId).toBe('ollama');
    expect(findings.runs(conversationId)[0]?.modelId).toBe('reviewer-model');
  });

  it('只有一家供应商时状态是 degraded 且原因写进 summary', async () => {
    seedAssistant('均值是 3.42');
    const { service } = makeService({
      models: [model({ id: 'writer-model', providerId: 'deepseek' })],
    });
    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });

    expect(outcome.status).toBe('degraded');
    expect(outcome.degradedReason).toContain('同厂商');
    expect(findings.runs(conversationId)[0]?.status).toBe('degraded');
  });

  it('没有任何模型时确定性层仍然跑', async () => {
    seedAssistant('图见附件');
    const { versionId } = saveArtifact({ filename: 'fig.png', content: 'PNG' });

    const { service } = makeService({ models: [] });
    const outcome = await service.schedule({
      conversationId,
      trigger: 'artifact-saved',
      versionIds: [versionId],
    });

    // 这正是确定性层存在的理由：降级不影响它
    expect(outcome.status).toBe('degraded');
    expect(outcome.findings.some((f) => f.category === 'reproducibility')).toBe(true);
    expect(findings.runs(conversationId)[0]?.modelId).toBe('none:deterministic-only');
  });

  it('模型给出的发现被写入并带上 reviewerRunId', async () => {
    const message = seedAssistant('p = 0.03，因此该干预有效');
    const { service } = makeService({
      reply: JSON.stringify({
        findings: [
          {
            severity: 'fail',
            category: 'statistics',
            title: 'p 值被当成效应量',
            detail: 'p=0.03 只说明不太可能由抽样波动解释。',
            evidence: [{ kind: 'message', id: message.id, note: 'p = 0.03' }],
          },
        ],
      }),
    });

    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(outcome.status).toBe('done');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.reviewerRunId).toBe(outcome.runId);
    expect(outcome.findings[0]?.severity).toBe('fail');
  });

  it('编造证据的发现不进库，并在 summary 里说明被丢弃', async () => {
    seedAssistant('结果很好');
    const { service } = makeService({
      reply: JSON.stringify({
        findings: [
          {
            severity: 'fail',
            category: 'evidence',
            title: '凭空的结论',
            evidence: [{ kind: 'message', id: 'msg_不存在' }],
          },
        ],
      }),
    });

    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(outcome.findings).toHaveLength(0);
    // 用户要能知道「模型给了但被挡下了」
    expect(outcome.summary).toContain('被丢弃');
  });

  it('FAIL 触发 onFail，WARN 不触发', async () => {
    const message = seedAssistant('结论一');
    const fails: string[] = [];
    const { service } = makeService({
      reply: JSON.stringify({
        findings: [
          {
            severity: 'warn',
            category: 'consistency',
            title: '术语不统一',
            evidence: [{ kind: 'message', id: message.id }],
          },
        ],
      }),
      onFail: ({ conversationId: cid }) => {
        fails.push(cid);
      },
    });

    await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(fails).toEqual([]);

    const second = makeService({
      reply: JSON.stringify({
        findings: [
          {
            severity: 'fail',
            category: 'statistics',
            title: '方法用错',
            evidence: [{ kind: 'message', id: message.id }],
          },
        ],
      }),
      onFail: ({ conversationId: cid }) => {
        fails.push(cid);
      },
    });
    await second.service.schedule({ conversationId, trigger: 'turn-end' });
    expect(fails).toEqual([conversationId]);
  });

  it('重复的确定性发现不会每轮再加一条', async () => {
    seedAssistant('图见附件');
    const { versionId } = saveArtifact({ filename: 'fig.png', content: 'PNG' });

    const { service } = makeService({});
    await service.schedule({ conversationId, trigger: 'artifact-saved', versionIds: [versionId] });
    const afterFirst = findings.list({ conversationId }).length;

    await service.schedule({ conversationId, trigger: 'artifact-saved', versionIds: [versionId] });
    expect(findings.list({ conversationId })).toHaveLength(afterFirst);
  });

  it('复核判定 resolve 会关闭发现', async () => {
    const message = seedAssistant('已改');
    const finding = findings.add({
      conversationId,
      severity: 'warn',
      category: 'statistics',
      title: '未校正多重比较',
      evidence: [{ kind: 'message', id: message.id }],
    });
    findings.claimFixed(finding.id, '已改用 FDR');

    const { service } = makeService({
      reply: JSON.stringify({
        findings: [],
        rechecks: [{ id: finding.id, verdict: 'resolve', note: '代码里确实加了 fdr_bh' }],
      }),
    });

    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(findings.get(finding.id)?.status).toBe('resolved');
    expect(outcome.summary).toContain('确认 1');
  });

  it('复核判定 reopen 会把发现打回 open', async () => {
    const message = seedAssistant('已改');
    const finding = findings.add({
      conversationId,
      severity: 'fail',
      category: 'statistics',
      title: '未校正多重比较',
      evidence: [{ kind: 'message', id: message.id }],
    });
    findings.claimFixed(finding.id, '已改');

    const { service } = makeService({
      reply: JSON.stringify({
        findings: [],
        rechecks: [{ id: finding.id, verdict: 'reopen', note: '只在一半检验上加了校正' }],
      }),
    });

    await service.schedule({ conversationId, trigger: 'turn-end' });
    const after = findings.get(finding.id);
    expect(after?.status).toBe('open');
    expect(after?.addressedNote).toContain('只在一半检验上');
  });

  it('审查者没表态的待复核项保持原状', async () => {
    const message = seedAssistant('已改');
    const finding = findings.add({
      conversationId,
      severity: 'warn',
      category: 'statistics',
      title: '未校正多重比较',
      evidence: [{ kind: 'message', id: message.id }],
    });
    findings.claimFixed(finding.id, '已改');

    const { service } = makeService({ reply: '{"findings":[],"rechecks":[]}' });
    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });

    // 默认 resolve 会让沉默变成放行；默认 reopen 会让真修好的反复回来
    expect(findings.get(finding.id)?.status).toBe('claimed-fixed');
    expect(outcome.summary).toContain('未表态');
  });

  it('模型调用失败时状态是 degraded，确定性发现仍然保留', async () => {
    seedAssistant('图见附件');
    const { versionId } = saveArtifact({ filename: 'fig.png', content: 'PNG' });

    const service = new ReviewerService({
      findings,
      artifacts,
      messages: project.messages,
      adapters: {
        get: () => ({
          chat: () => {
            throw new Error('供应商 500');
          },
        }),
      } as never,
      adapterContext: () => ({ baseUrl: 'http://x' }) as never,
      routerView: () => ({
        models: [
          model({ id: 'reviewer-model', providerId: 'ollama' }),
          model({ id: 'writer-model', providerId: 'deepseek' }),
        ],
        runtime: new Map(),
      }),
    });

    const outcome = await service.schedule({
      conversationId,
      trigger: 'artifact-saved',
      versionIds: [versionId],
    });

    // failed 会让 UI 显示「审查没跑」，而实际上跑了一半且那一半可信
    expect(outcome.status).toBe('degraded');
    expect(outcome.findings.length).toBeGreaterThan(0);
    expect(outcome.summary).toContain('供应商 500');
  });

  it('触发原因写进审查记录', async () => {
    seedAssistant('x');
    const { service } = makeService({});
    await service.schedule({ conversationId, trigger: 'user-request' });
    expect(findings.runs(conversationId)[0]?.trigger).toBe('user-request');
  });

  it('user-request 的提示词要求全类别过一遍', async () => {
    seedAssistant('x');
    const { service, adapters } = makeService({});
    await service.schedule({ conversationId, trigger: 'user-request' });
    expect(adapters.calls[0]?.user).toContain('全部类别');
  });

  it('并发触发被合并而不是排队跑两次', async () => {
    seedAssistant('x');
    let calls = 0;
    const { service } = makeService({
      reply: () => {
        calls += 1;
        return '{"findings":[]}';
      },
    });

    const first = service.schedule({ conversationId, trigger: 'turn-end' });
    const second = service.schedule({ conversationId, trigger: 'turn-end' });
    await Promise.all([first, second]);

    // 第二次的输入已经包含第一次的全部内容，跑两遍纯属重复花钱；
    // 但也不能一次都不补——合并后应当恰好补跑一次
    expect(calls).toBe(2);
    expect(findings.runs(conversationId).length).toBe(2);
  });

  it('close 之后不再接受新的审查', async () => {
    seedAssistant('x');
    const { service } = makeService({});
    service.close();
    const outcome = await service.schedule({ conversationId, trigger: 'turn-end' });
    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toContain('已关闭');
  });

  it('构造时把上次进程留下的 running 记录标掉', () => {
    findings.startRun({ conversationId, trigger: 'turn-end', modelId: 'm' });
    makeService({});
    expect(findings.runs(conversationId)[0]?.status).toBe('failed');
  });
});

/* ------------------------------------------------------------------ *
 * agent 侧工具
 * ------------------------------------------------------------------ */

describe('findings 工具', () => {
  const ctx = () => ({ projectId, conversationId, workspaceDir: root });
  const options = () => ({ repo: () => findings });

  const addFinding = (over: Partial<Parameters<FindingsRepo['add']>[0]> = {}) =>
    findings.add({
      conversationId,
      severity: 'fail',
      category: 'statistics',
      title: '未校正多重比较',
      detail: '做了 12 次检验。',
      evidence: [{ kind: 'message', id: 'msg_1' }],
      ...over,
    });

  it('check_findings 在没有发现时说明「没跑过 ≠ 没问题」', async () => {
    const tool = createCheckFindingsTool(options());
    const result = await tool.execute({}, ctx() as never);
    expect(result.ok).toBe(true);
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('还没有跑过审查');
    }
  });

  it('check_findings 有阻断项时明确要求不要宣称完成', async () => {
    addFinding();
    const tool = createCheckFindingsTool(options());
    const result = await tool.execute({}, ctx() as never);
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('不要宣称任务完成');
      expect(result.output.text).toContain('未校正多重比较');
      // id 要给出来，否则 mark_finding_addressed 没法调
      expect(result.output.text).toMatch(/id: fd_/);
    }
  });

  it('check_findings 可以排除已自报待复核的', async () => {
    const finding = addFinding();
    findings.claimFixed(finding.id, '已改');
    const tool = createCheckFindingsTool(options());

    const withThem = await tool.execute({}, ctx() as never);
    const without = await tool.execute({ includeClaimedFixed: false }, ctx() as never);

    if (withThem.output.kind === 'text') expect(withThem.output.text).toContain('未校正');
    if (without.output.kind === 'text') expect(without.output.text).toContain('没有未关闭的发现');
  });

  it('mark_finding_addressed 只推进到待复核', async () => {
    const finding = addFinding();
    const tool = createMarkFindingAddressedTool(options());
    const result = await tool.execute(
      { findingId: finding.id, note: '已改用 Benjamini-Hochberg 校正' },
      ctx() as never,
    );

    expect(result.ok).toBe(true);
    // 关闭权在审查者：自己给自己判分会让一次错误判断永久掩盖问题
    expect(findings.get(finding.id)?.status).toBe('claimed-fixed');
  });

  it('mark_finding_addressed 要求说明改了什么', () => {
    const tool = createMarkFindingAddressedTool(options());
    expect(() => tool.parseInput({ findingId: 'fd_1', note: '  ' })).toThrow(/无从核对/);
  });

  it('mark_finding_addressed 拒绝不存在的 id', async () => {
    const tool = createMarkFindingAddressedTool(options());
    const result = await tool.execute({ findingId: 'fd_不存在', note: '改了' }, ctx() as never);
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error') expect(result.output.ename).toBe('FindingNotFound');
  });

  it('mark_finding_addressed 拒绝跨会话', async () => {
    const other = project.conversations.create({ title: '另一个' }).id;
    const finding = findings.add({
      conversationId: other,
      severity: 'warn',
      category: 'evidence',
      title: '别的会话的发现',
      evidence: [{ kind: 'message', id: 'msg_1' }],
    });

    const tool = createMarkFindingAddressedTool(options());
    const result = await tool.execute({ findingId: finding.id, note: '改了' }, ctx() as never);
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error')
      expect(result.output.ename).toBe('FindingNotInConversation');
  });

  it('mark_finding_addressed 对已关闭的发现报状态冲突', async () => {
    const finding = addFinding();
    findings.dismiss(finding.id, '误报');
    const tool = createMarkFindingAddressedTool(options());
    const result = await tool.execute({ findingId: finding.id, note: '改了' }, ctx() as never);
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error') expect(result.output.ename).toBe('FindingNotOpen');
  });

  it('工具里没有 dismiss：判定误报是用户的权力', () => {
    // agent 说「这条是误报」时，它通常就是那个搞错了的一方
    const names = [
      createCheckFindingsTool(options()).name,
      createMarkFindingAddressedTool(options()).name,
      createRequestReviewTool(options()).name,
    ];
    expect(names).toEqual(['check_findings', 'mark_finding_addressed', 'request_review']);
    expect(names.some((n) => n.includes('dismiss'))).toBe(false);
  });

  it('request_review 在没有审查服务时如实说明', async () => {
    const tool = createRequestReviewTool(options());
    const result = await tool.execute(null, ctx() as never);
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error') expect(result.output.ename).toBe('ReviewerUnavailable');
  });

  it('request_review 排入审查', async () => {
    const scheduled: string[] = [];
    const tool = createRequestReviewTool({
      repo: () => findings,
      schedule: ({ trigger }) => scheduled.push(trigger),
    });
    const result = await tool.execute(null, ctx() as never);
    expect(result.ok).toBe(true);
    expect(scheduled).toEqual(['user-request']);
  });
});
