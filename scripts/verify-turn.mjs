#!/usr/bin/env node
/**
 * 端到端回合验证：真实模型 + 真实工具 + 真实数据库。
 *
 * 这是第一次把路由、适配器、工具面、编排器、持久化串起来跑。单元测试用假适配器
 * 覆盖了逻辑分支，但证明不了整条链在真实模型行为下能走通——真实模型会产出
 * 单元测试里没预料到的参数形状、会拒绝调用工具、会在不该结束时结束。
 *
 * 会产生少量真实费用（几百 token）。
 *
 * 用法：node scripts/verify-turn.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  Orchestrator,
  RegistryRepo,
  RegistrySync,
  ToolRegistry,
  buildRouterView,
  createEditFileTool,
  createReadFileTool,
  createSaveArtifactsTool,
  providerRef,
} from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)}  ${detail}\n`);
};

const root = mkdtempSync(join(tmpdir(), 'lsci-turn-'));
const vault = new CredentialVault();
const deepseekKey = vault.exists ? vault.get(providerRef('deepseek')) : null;

if (deepseekKey === null) {
  process.stdout.write('SKIP  凭据库无 provider:deepseek，无法做端到端验证\n');
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

const store = AppStore.open(root);

try {
  const created = store.createProject({ name: '端到端回合' });
  const project = store.openProject(created.id);
  const conversation = project.conversations.create({ title: '冒烟会话' });

  // 注册供应商与模型
  const registry = new RegistryRepo(store.db);
  const sync = new RegistrySync(store.db, registry);
  const adapters = createDefaultRegistry();

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
  const syncResult = sync.sync('deepseek', discovered);
  check(syncResult.added.length >= 2, '模型注册表同步', `新增 ${syncResult.added.length} 个`);

  // 工具面：给一个真能改文件系统的工具组合
  const workspace = join(project.paths.workspace, conversation.id);
  const artifacts = new ArtifactStore(project.db, project.paths.blobs);
  const tools = new ToolRegistry({ probe: () => true });
  const resolveWithin = (raw, ctx) => join(ctx.workspaceDir, raw);

  tools.register(createReadFileTool({ resolvePath: resolveWithin }));
  tools.register(createEditFileTool({ resolvePath: resolveWithin }));
  tools.register(createSaveArtifactsTool({ store: artifacts, resolvePath: resolveWithin }));

  check(
    tools
      .list()
      .map((t) => t.name)
      .join(',') === 'edit_file,read_file,save_artifacts',
    '工具注册',
    tools
      .list()
      .map((t) => t.name)
      .join(', '),
  );

  const orchestrator = new Orchestrator({
    conversations: project.conversations,
    messages: project.messages,
    toolCalls: project.toolCalls,
    tools,
    adapters,
    routerView: () =>
      buildRouterView({
        repo: registry,
        hasCredential: (ref) => ref !== null && vault.has(ref),
      }),
    adapterContext: (providerId) =>
      providerId === 'deepseek'
        ? { baseUrl: DEEPSEEK_BASE_URL, apiKey: deepseekKey }
        : { baseUrl: OLLAMA_BASE_URL },
    workspaceDir: () => {
      mkdirSync(workspace, { recursive: true });
      return workspace;
    },
    systemPrompt: () =>
      '你是科研助手。用户要你操作文件时，直接调用提供的工具，不要只描述步骤。' +
      '完成后用一句话说明做了什么。',
    maxTurns: 6,
  });

  /* ---------------- 回合 1：让模型真的调用工具写文件 ---------------- */

  process.stdout.write('\n--- 回合 1：写文件 ---\n');

  const events1 = [];
  const started = Date.now();
  for await (const event of orchestrator.startTurn(
    conversation.id,
    '用 edit_file 工具在工作目录创建一个文件 notes.md，mode 用 write，内容写成一行：实验记录',
  )) {
    events1.push(event);
  }

  const decision = events1.find((e) => e.kind === 'routing.decision');
  check(
    decision !== undefined && decision.decision.chosenModelId !== null,
    '路由选出模型',
    decision?.decision.chosenModelId ?? '无',
  );
  check(
    (decision?.decision.reason ?? '').length > 0,
    '决策带可解释理由',
    (decision?.decision.reason ?? '').slice(0, 70),
  );

  const toolStarts = events1.filter((e) => e.kind === 'tool.start');
  check(toolStarts.length > 0, '模型真的调用了工具', toolStarts.map((e) => e.tool).join(', '));

  const toolOutputs = events1.filter((e) => e.kind === 'tool.output');
  check(
    toolOutputs.some((e) => e.output.kind === 'text'),
    '工具执行有输出',
    toolOutputs.map((e) => e.output.kind).join(', '),
  );

  let fileContent = null;
  try {
    fileContent = readFileSync(join(workspace, 'notes.md'), 'utf8');
  } catch {
    /* 下面报告 */
  }
  check(fileContent !== null, '文件真的被写到磁盘', fileContent?.trim().slice(0, 40) ?? '不存在');

  const end1 = events1.at(-1);
  check(end1?.kind === 'turn.end', '回合正常结束', `事件数 ${events1.length}`);
  check(
    (end1?.usage.tokensIn ?? 0) > 0 && (end1?.usage.cost ?? 0) > 0,
    '用量与成本被汇总',
    `in=${end1?.usage.tokensIn} out=${end1?.usage.tokensOut} $${end1?.usage.cost.toFixed(6)}`,
  );
  check(
    project.conversations.get(conversation.id)?.status === 'idle',
    '状态回到 idle',
    project.conversations.get(conversation.id)?.status ?? '?',
  );

  /* ---------------- 持久化 ---------------- */

  process.stdout.write('\n--- 持久化 ---\n');

  const page = project.messages.page(conversation.id, { limit: 50 });
  const roles = page.messages.map((m) => m.role);
  check(roles.includes('user') && roles.includes('assistant'), '消息落库', roles.join(', '));

  const assistantMsg = page.messages.find((m) => m.role === 'assistant');
  check(
    assistantMsg?.modelId !== null && assistantMsg?.providerId === 'deepseek',
    '助手消息记录了模型',
    `${assistantMsg?.providerId}/${assistantMsg?.modelId}`,
  );

  const userMsg = page.messages.find((m) => m.role === 'user');
  const calls = project.toolCalls.listByMessage(userMsg?.id ?? '');
  check(calls.length > 0, '工具调用落库', calls.map((c) => `${c.toolName}:${c.status}`).join(', '));

  /* ---------------- 回合 2：读回自己写的文件 ---------------- */

  process.stdout.write('\n--- 回合 2：读回 ---\n');

  const events2 = [];
  for await (const event of orchestrator.startTurn(
    conversation.id,
    '用 read_file 读一下 notes.md，告诉我里面写了什么',
  )) {
    events2.push(event);
  }

  const readCall = events2.find((e) => e.kind === 'tool.start' && e.tool === 'read_file');
  check(readCall !== undefined, '模型选对了工具', readCall?.tool ?? '未调用 read_file');

  const finalText = events2
    .filter((e) => e.kind === 'text.delta')
    .map((e) => e.text)
    .join('');
  check(
    finalText.includes('实验记录'),
    '工具结果回灌给模型',
    finalText.replace(/\s+/g, ' ').slice(0, 60),
  );

  /* ---------------- 回合 3：并发被拒 ---------------- */

  process.stdout.write('\n--- 并发与中断 ---\n');

  const events3 = orchestrator.startTurn(conversation.id, '再说一句');
  let busyRejected = false;
  try {
    orchestrator.startTurn(conversation.id, '插队');
  } catch (err) {
    busyRejected = err.name === 'ConversationBusyError';
  }
  check(busyRejected, '并发回合被拒', busyRejected ? '' : '第二次 startTurn 未被拒绝');

  const interrupted = await orchestrator.interrupt(conversation.id);
  check(interrupted, '中断生效', '');

  const events3Collected = [];
  for await (const event of events3) events3Collected.push(event);
  check(
    project.conversations.get(conversation.id)?.status === 'idle',
    '中断后回到 idle',
    project.conversations.get(conversation.id)?.status ?? '?',
  );

  const summaryMsg = project.messages
    .page(conversation.id, { limit: 50 })
    .messages.find((m) => m.content?.kind === 'turn-summary');
  check(
    summaryMsg !== undefined,
    '非正常结束留下摘要',
    summaryMsg?.content?.stopReason ?? '无摘要',
  );

  /* ---------------- 总量 ---------------- */

  process.stdout.write('\n--- 累计 ---\n');
  const allMessages = project.messages.page(conversation.id, { limit: 100 }).messages;
  const totalCost = allMessages.reduce((sum, m) => sum + (m.usage?.cost ?? 0), 0);
  process.stdout.write(
    `消息 ${allMessages.length} 条，本次验证累计花费 $${totalCost.toFixed(6)}\n`,
  );
} catch (err) {
  check(
    false,
    '端到端流程异常',
    err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
  );
} finally {
  store.close();
  // Windows 不允许删占用中的 SQLite，稍等再删
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    process.stdout.write(`（临时目录未能删除，可手动清理：${root}）\n`);
  }
}

process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
