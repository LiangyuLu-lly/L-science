#!/usr/bin/env node
/**
 * 把凭据库里已有的供应商注册进应用库，并同步模型清单。
 *
 * 存在的理由：凭据存在 vault 里（仓库外、DPAPI 加密），但路由要从应用库的
 * `providers`/`models` 表读候选。两者需要一次显式的关联动作——自动扫描 vault
 * 并注册所有能连上的供应商是危险的，那等于程序替用户决定「把数据发给谁」。
 *
 * 用法：node scripts/provision.mjs
 * 幂等：重复运行只会刷新模型清单。
 */

import {
  createDefaultRegistry,
  DEEPSEEK_BASE_URL,
  OLLAMA_BASE_URL,
} from '../packages/adapters/dist/index.js';
import {
  AppStore,
  CredentialVault,
  RegistryRepo,
  RegistrySync,
  providerRef,
} from '../packages/core/dist/index.js';

const KNOWN = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    adapter: 'ollama',
    baseUrl: OLLAMA_BASE_URL,
    needsKey: false,
  },
];

const store = AppStore.open();
const vault = new CredentialVault();
const registry = new RegistryRepo(store.db);
const sync = new RegistrySync(store.db, registry);
const adapters = createDefaultRegistry();

try {
  process.stdout.write(`应用库：${store.paths.root}\n\n`);

  for (const provider of KNOWN) {
    const ref = providerRef(provider.id);
    const hasKey = vault.exists && vault.has(ref);

    if (provider.needsKey && !hasKey) {
      process.stdout.write(
        `跳过 ${provider.name}：凭据库里没有 ${ref}。\n` +
          `  录入方式：$env:L_SCIENCE_SECRET="..."; node scripts/credential.mjs set ${ref}\n\n`,
      );
      continue;
    }

    const apiKey = hasKey ? (vault.get(ref) ?? undefined) : undefined;
    const ctx = { baseUrl: provider.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };

    // 先探活再注册：注册一个连不上的供应商会让路由每次都要把它过滤掉，
    // 而用户看到的是「有这家供应商但从来不被选中」
    const health = await adapters.get(provider.id).health(ctx);
    if (!health.ok) {
      process.stdout.write(`跳过 ${provider.name}：${health.detail ?? '健康检查未通过'}\n\n`);
      continue;
    }

    registry.upsertProvider({
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      baseUrl: provider.baseUrl,
      credentialRef: provider.needsKey ? ref : null,
      policy: null,
      enabled: true,
    });

    const models = await adapters.get(provider.id).listModels(ctx);
    const result = sync.sync(provider.id, models);

    process.stdout.write(
      `已注册 ${provider.name}（${health.latencyMs}ms）\n` +
        `  新增 ${result.added.length}，更新 ${result.updated.length}，下线 ${result.disappeared.length}\n` +
        `  模型：${models.map((m) => m.id).join(', ')}\n\n`,
    );
  }

  const all = registry.listProviders();
  const modelCount = registry.listModels().length;
  process.stdout.write(
    `当前共 ${all.length} 家供应商、${modelCount} 个可用模型。\n` +
      (all.length < 2
        ? '注意：只有一家供应商时，跨厂商 committee 与 Reviewer 异厂商复核会降级。\n'
        : ''),
  );
} finally {
  store.close();
}
