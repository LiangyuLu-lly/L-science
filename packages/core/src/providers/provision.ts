/**
 * 把已知供应商登记进应用库，并同步模型清单。
 *
 * 存在的理由与 `scripts/provision.mjs` 相同：凭据在 vault 里，路由读的是
 * `providers`/`models` 表，两者需要一次显式关联。基地址来自适配器常量，
 * 不接受调用方传入的 URL。
 */

import { DEEPSEEK_BASE_URL, OLLAMA_BASE_URL, type AdapterRegistry } from '@l-science/adapters';

import { providerRef, type CredentialVault } from '../credentials/vault.js';
import type { RegistryRepo, RegistrySync } from '../repo/registry.js';

export const KNOWN_PROVIDERS = [
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
] as const;

export type ProvisionSkipReason = 'missing_key' | 'health_failed' | 'not_requested';

export type ProvisionProviderResult =
  | {
      readonly id: string;
      readonly name: string;
      readonly status: 'registered';
      readonly latencyMs: number;
      readonly added: readonly string[];
      readonly updated: readonly string[];
      readonly disappeared: readonly string[];
      readonly modelIds: readonly string[];
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly status: 'skipped';
      readonly reason: ProvisionSkipReason;
      readonly detail?: string;
    };

export type ProvisionResult = {
  readonly providers: readonly ProvisionProviderResult[];
};

export type ProvisionDeps = {
  readonly vault: CredentialVault;
  readonly registry: RegistryRepo;
  readonly sync: RegistrySync;
  readonly adapters: AdapterRegistry;
};

export type ProvisionOptions = {
  readonly deepseekKey?: string;
  readonly detectOllama?: boolean;
};

function redact(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join('[redacted]');
}

function skipped(
  provider: (typeof KNOWN_PROVIDERS)[number],
  reason: ProvisionSkipReason,
  detail?: string,
): ProvisionProviderResult {
  return {
    id: provider.id,
    name: provider.name,
    status: 'skipped',
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

export async function provisionKnownProviders(
  deps: ProvisionDeps,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const detectOllama = options.detectOllama !== false;
  if (options.deepseekKey !== undefined) {
    deps.vault.set(providerRef('deepseek'), options.deepseekKey);
  }

  const providers: ProvisionProviderResult[] = [];

  for (const provider of KNOWN_PROVIDERS) {
    if (provider.id === 'ollama' && !detectOllama) {
      providers.push(skipped(provider, 'not_requested'));
      continue;
    }

    const ref = providerRef(provider.id);
    const hasKey = deps.vault.exists && deps.vault.has(ref);
    if (provider.needsKey && !hasKey) {
      providers.push(skipped(provider, 'missing_key'));
      continue;
    }

    const apiKey = hasKey ? (deps.vault.get(ref) ?? undefined) : undefined;
    const secret = apiKey ?? options.deepseekKey;
    const ctx = { baseUrl: provider.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };

    let health: { ok: boolean; latencyMs: number; detail?: string };
    try {
      health = await deps.adapters.get(provider.id).health(ctx);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      providers.push(skipped(provider, 'health_failed', redact(err.message, secret)));
      continue;
    }

    if (!health.ok) {
      const raw = health.detail ?? '健康检查未通过';
      providers.push(skipped(provider, 'health_failed', redact(raw, secret)));
      continue;
    }

    deps.registry.upsertProvider({
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      baseUrl: provider.baseUrl,
      credentialRef: provider.needsKey ? ref : null,
      policy: null,
      enabled: true,
    });

    const models = await deps.adapters.get(provider.id).listModels(ctx);
    const synced = deps.sync.sync(provider.id, models);
    providers.push({
      id: provider.id,
      name: provider.name,
      status: 'registered',
      latencyMs: health.latencyMs,
      added: synced.added,
      updated: synced.updated,
      disappeared: synced.disappeared,
      modelIds: models.map((m) => m.id),
    });
  }

  return { providers };
}
