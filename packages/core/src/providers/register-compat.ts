/**
 * 登记 OpenAI 兼容端点。
 *
 * 基地址已在 IPC 边界解析过（https，或 http 回环）。这里负责写入凭据、
 * upsert 供应商行、同步模型。与 `provider.provision` 分开：那条路径不接受
 * 调用方传入的 URL。
 */

import { OPENAI_COMPAT_ID } from '@l-science/adapters';

import { providerRef } from '../credentials/vault.js';
import type { ProvisionDeps } from './provision.js';

export type RegisterCompatInput = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly name?: string;
};

export type RegisterCompatResult = {
  readonly providerId: typeof OPENAI_COMPAT_ID;
  readonly name: string;
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly disappeared: readonly string[];
  readonly modelIds: readonly string[];
};

export async function registerCompatProvider(
  deps: ProvisionDeps,
  input: RegisterCompatInput,
): Promise<RegisterCompatResult> {
  const ref = providerRef(OPENAI_COMPAT_ID);
  deps.vault.set(ref, input.apiKey);

  const name = input.name ?? 'OpenAI 兼容';
  deps.registry.upsertProvider({
    id: OPENAI_COMPAT_ID,
    name,
    adapter: OPENAI_COMPAT_ID,
    baseUrl: input.baseUrl,
    credentialRef: ref,
    policy: null,
    enabled: true,
  });

  const models = await deps.adapters.get(OPENAI_COMPAT_ID).listModels({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  const synced = deps.sync.sync(OPENAI_COMPAT_ID, models);
  return {
    providerId: OPENAI_COMPAT_ID,
    name,
    added: synced.added,
    updated: synced.updated,
    disappeared: synced.disappeared,
    modelIds: models.map((m) => m.id),
  };
}
