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

import { createDefaultRegistry } from '../packages/adapters/dist/index.js';
import {
  AppStore,
  CredentialVault,
  RegistryRepo,
  RegistrySync,
  providerRef,
  provisionKnownProviders,
} from '../packages/core/dist/index.js';

const store = AppStore.open();
const vault = new CredentialVault();
const registry = new RegistryRepo(store.db);
const sync = new RegistrySync(store.db, registry);
const adapters = createDefaultRegistry();

try {
  process.stdout.write(`应用库：${store.paths.root}\n\n`);

  const result = await provisionKnownProviders({ vault, registry, sync, adapters });

  for (const item of result.providers) {
    if (item.status === 'registered') {
      process.stdout.write(
        `已注册 ${item.name}（${item.latencyMs}ms）\n` +
          `  新增 ${item.added.length}，更新 ${item.updated.length}，下线 ${item.disappeared.length}\n` +
          `  模型：${item.modelIds.join(', ')}\n\n`,
      );
      continue;
    }

    if (item.reason === 'missing_key') {
      const ref = providerRef(item.id);
      process.stdout.write(
        `跳过 ${item.name}：凭据库里没有 ${ref}。\n` +
          `  录入方式：$env:L_SCIENCE_SECRET="..."; node scripts/credential.mjs set ${ref}\n\n`,
      );
      continue;
    }

    if (item.reason === 'health_failed') {
      process.stdout.write(`跳过 ${item.name}：${item.detail ?? '健康检查未通过'}\n\n`);
      continue;
    }

    process.stdout.write(`跳过 ${item.name}\n\n`);
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
