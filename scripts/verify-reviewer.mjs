/**
 * Reviewer 端到端验证（任务 12.8，需求 11.1-11.8）。
 *
 * 单元测试用假适配器覆盖了逻辑分支，但证明不了两件只有真实模型才能暴露的事：
 *
 * 1. **它真的会按格式输出。** 「只输出一个 JSON 代码块」是提示词里的要求，
 *    而模型可以完全不理。若真实模型总是在 JSON 前后写一段解释，`extractJsonObject`
 *    的容忍度就必须够；若它根本不给 JSON，整个审查层等于不存在。
 * 2. **它真的能发现问题。** 这里刻意喂一段有明确统计错误的内容（p 值被当成效应量、
 *    12 次检验未校正），看审查者是否指出来。指不出来说明提示词或模型选择有问题，
 *    而那种失败在假适配器下永远发现不了。
 *
 * 会产生少量真实费用（几千 token）。异厂商约束会让审查走本机 Ollama 或 DeepSeek
 * 中的另一家，取决于哪家可用。
 *
 * 用法：node scripts/verify-reviewer.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultRegistry,
  DEEPSEEK_BASE_URL,
  OLLAMA_BASE_URL,
} from '../packages/adapters/dist/index.js';
import {
  AppStore,
  ArtifactStore,
  CredentialVault,
  FindingsRepo,
  RegistryRepo,
  RegistrySync,
  ReviewerService,
  buildRouterView,
  providerRef,
} from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}  ${detail}\n`);
};

const root = mkdtempSync(join(tmpdir(), 'lsci-reviewer-'));
const vault = new CredentialVault();
const deepseekKey = vault.exists && vault.available ? vault.get(providerRef('deepseek')) : null;

const store = AppStore.open(join(root, 'app'));

try {
  const created = store.createProject({ name: '审查端到端' });
  const project = store.openProject(created.id);
  const conversation = project.conversations.create({ title: '审查会话' });

  const registry = new RegistryRepo(store.db);
  const sync = new RegistrySync(store.db, registry);
  const adapters = createDefaultRegistry();

  /* ---------------- 1. 登记两家供应商 ---------------- */

  process.stdout.write('\n--- 1. 供应商 ---\n');

  let deepseekOk = false;
  if (deepseekKey !== null) {
    registry.upsertProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      adapter: 'deepseek',
      baseUrl: DEEPSEEK_BASE_URL,
      credentialRef: providerRef('deepseek'),
      policy: null,
      enabled: true,
    });
    const discovered = await adapters
      .get('deepseek')
      .listModels({ baseUrl: DEEPSEEK_BASE_URL, apiKey: deepseekKey });
    sync.sync('deepseek', discovered);
    deepseekOk = discovered.length > 0;
  }
  check(deepseekOk, 'DeepSeek 已登记', deepseekOk ? '' : '凭据库里没有 provider:deepseek');

  let ollamaOk = false;
  try {
    registry.upsertProvider({
      id: 'ollama',
      name: 'Ollama',
      adapter: 'ollama',
      baseUrl: OLLAMA_BASE_URL,
      credentialRef: null,
      policy: null,
      enabled: true,
    });
    const local = await adapters.get('ollama').listModels({ baseUrl: OLLAMA_BASE_URL });
    sync.sync('ollama', local);
    ollamaOk = local.length > 0;
  } catch {
    ollamaOk = false;
  }
  check(ollamaOk, 'Ollama 已登记', ollamaOk ? '' : '本机 Ollama 未运行或没有已拉取的模型');

  if (!deepseekOk && !ollamaOk) {
    process.stdout.write('\n没有任何可用供应商，无法验证模型层。\n');
    process.exit(1);
  }

  const twoVendors = deepseekOk && ollamaOk;
  check(
    twoVendors,
    '有两家供应商可做异厂商审查',
    twoVendors ? '' : '只有一家：本次会验证降级路径而不是异厂商路径',
  );

  /* ---------------- 2. 造被审查内容 ---------------- */

  process.stdout.write('\n--- 2. 造一段有明确统计错误的内容 ---\n');

  // 生成方标成 deepseek（有的话），审查因此必须走另一家
  const generatorProvider = deepseekOk ? 'deepseek' : 'ollama';
  const generatorModel = registry.listModels({
    providerId: generatorProvider,
    includeDisabled: false,
  })[0]?.id;

  const flawed = project.messages.append({
    conversationId: conversation.id,
    role: 'assistant',
    content: {
      kind: 'text',
      text: [
        '分析完成。我在 12 个脑区分别做了配对 t 检验，其中额叶的结果 p = 0.03。',
        '因此额叶的效应最强，干预对额叶有效。',
        '另外 11 个脑区 p 值都大于 0.05，说明干预对它们没有作用。',
        '样本量 n = 8，功效充足。',
      ].join('\n'),
    },
    modelId: generatorModel ?? 'unknown',
    providerId: generatorProvider,
  });
  check(true, '已写入待审查的助手消息', `id ${flawed.id}`);

  // 再造一个缺血缘的图，验证确定性层
  const artifacts = new ArtifactStore(project.db, project.paths.blobs);
  const figure = artifacts.save({
    filename: 'frontal_effect.png',
    content: Buffer.from('\x89PNG\r\n\x1a\n fake image bytes'),
  });
  check(
    figure.reproducibilityGap !== null,
    '图缺少生成血缘（确定性层应报 FAIL）',
    figure.reproducibilityGap ?? '',
  );

  /* ---------------- 3. 跑审查 ---------------- */

  process.stdout.write('\n--- 3. 审查 ---\n');

  const findings = new FindingsRepo(project.db);
  const raised = [];
  let failNotified = 0;

  const reviewer = new ReviewerService({
    findings,
    artifacts,
    messages: project.messages,
    adapters,
    adapterContext: (providerId) =>
      providerId === 'deepseek'
        ? { baseUrl: DEEPSEEK_BASE_URL, apiKey: deepseekKey ?? '' }
        : { baseUrl: OLLAMA_BASE_URL },
    routerView: () =>
      buildRouterView({
        repo: registry,
        hasCredential: (ref) => ref !== null && vault.available && vault.exists && vault.has(ref),
      }),
    onFinding: (f) => raised.push(f),
    onFail: () => {
      failNotified += 1;
    },
    onLog: (line) => process.stderr.write(`[reviewer] ${line}\n`),
    timeoutMs: 240_000,
  });

  const startedAt = Date.now();
  const outcome = await reviewer.schedule({
    conversationId: conversation.id,
    trigger: 'turn-end',
    versionIds: [figure.version.id],
  });
  const elapsed = Date.now() - startedAt;

  check(
    outcome.status === 'done' || outcome.status === 'degraded',
    '审查跑完',
    `status=${outcome.status}，${(elapsed / 1000).toFixed(1)}s`,
  );

  const run = findings.getRun(outcome.runId ?? '');
  check(run !== null, '审查记录已落库', run === null ? '' : `模型 ${run.modelId}`);

  if (twoVendors && run !== null) {
    const reviewerModel = registry.getModel(run.modelId);
    check(
      reviewerModel !== null && reviewerModel.providerId !== generatorProvider,
      '审查者与生成方不同厂商',
      `生成 ${generatorProvider} / 审查 ${reviewerModel?.providerId ?? '?'}`,
    );
  } else {
    check(
      outcome.degradedReason !== null,
      '只有一家供应商时明确告知降级',
      outcome.degradedReason ?? '（没有给出降级原因，这是问题）',
    );
  }

  /* ---------------- 4. 确定性层的结论 ---------------- */

  process.stdout.write('\n--- 4. 确定性层 ---\n');

  const all = findings.list({ conversationId: conversation.id, limit: 200 });
  const lineage = all.find((f) => f.category === 'reproducibility');
  check(
    lineage !== undefined && lineage.severity === 'fail',
    '图缺血缘被报为 FAIL',
    lineage === undefined ? '（没有报，这是问题）' : lineage.title,
  );
  check(
    lineage !== undefined && lineage.evidence.some((e) => e.id === figure.version.id),
    '发现指向了具体的制品版本',
    lineage?.evidence.map((e) => `${e.kind}:${e.id}`).join('、') ?? '',
  );
  check(failNotified > 0, 'FAIL 触发了打断通知', `${failNotified} 次`);

  /* ---------------- 5. 模型层的结论 ---------------- */

  process.stdout.write('\n--- 5. 模型层 ---\n');

  const modelFindings = all.filter((f) => f.category !== 'reproducibility');
  process.stdout.write(
    `审查摘要：\n${outcome.summary
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}\n\n`,
  );

  for (const f of modelFindings) {
    process.stdout.write(`  · [${f.severity}/${f.category}] ${f.title}\n`);
    process.stdout.write(`      ${(f.detail ?? '').split('\n')[0] ?? ''}\n`);
  }

  check(
    modelFindings.length > 0,
    '模型层给出了发现',
    modelFindings.length === 0
      ? '（一条都没有。可能是模型不按 JSON 输出，看上面的摘要）'
      : `${modelFindings.length} 条`,
  );

  // 喂进去的错误里最明确的一条：n=8 做 12 次检验还说功效充足
  const statsFound = modelFindings.some((f) => f.category === 'statistics');
  check(
    statsFound,
    '发现了统计类问题',
    statsFound ? '' : '（喂了三处明显的统计错误却没发现，说明提示词或模型选择有问题）',
  );

  check(
    modelFindings.every((f) => f.evidence.length > 0),
    '每条发现都有证据',
    '证据为空的发现在写入时就会被拒',
  );
  check(
    raised.length === all.length,
    'onFinding 通知了每一条',
    `通知 ${raised.length} / 落库 ${all.length}`,
  );

  /* ---------------- 6. 自报与复核 ---------------- */

  process.stdout.write('\n--- 6. 自报待复核与复核 ---\n');

  const target = all[0];
  if (target !== undefined) {
    const claimed = findings.claimFixed(
      target.id,
      '已在图的生成代码里补上 matplotlib 作图脚本，并登记了输入版本。',
    );
    check(claimed, 'agent 可以自报已修', target.title);
    check(
      findings.get(target.id)?.status === 'claimed-fixed',
      '自报只推进到待复核，不关闭',
      findings.get(target.id)?.status ?? '',
    );

    const second = await reviewer.schedule({
      conversationId: conversation.id,
      trigger: 'user-request',
    });
    check(
      second.status === 'done' || second.status === 'degraded',
      '第二轮审查跑完并做了复核',
      second.summary.split('\n')[0] ?? '',
    );

    const after = findings.get(target.id)?.status;
    check(
      after === 'claimed-fixed' || after === 'resolved' || after === 'open',
      '复核结论落在合法状态上',
      `status=${after ?? '?'}（未表态时保持 claimed-fixed 是正确行为）`,
    );
  }

  reviewer.close();
} catch (err) {
  failed += 1;
  process.stdout.write(
    `\n未预期的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
