/**
 * 登记 OpenAI 兼容端点。预设与自定义可同时存在，凭据按供应商 id 分开。
 */

import { OPENAI_COMPAT_ID } from '@l-science/adapters';
import type { ModelDescriptor } from '@l-science/shared';

import { providerRef } from '../credentials/vault.js';
import { namespacedModelId } from './api-model-name.js';
import { explainCompatFailure } from './compat-error.js';
import {
  compatProviderIdForUrl,
  findCompatPreset,
} from './compat-presets.js';
import type { ProvisionDeps } from './provision.js';

export type RegisterCompatInput = {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly name?: string;
  readonly presetId?: string;
};

export type RegisterCompatResult = {
  readonly providerId: string;
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
  const preset = input.presetId === undefined ? null : findCompatPreset(input.presetId);
  const baseUrl = preset?.baseUrl ?? input.baseUrl;
  if (baseUrl === undefined || baseUrl === '') {
    throw new Error('需要预设 id 或基地址');
  }

  const providerId = preset?.id ?? compatProviderIdForUrl(baseUrl);
  const name = input.name ?? preset?.name ?? 'OpenAI 兼容';
  const ref = providerRef(providerId);
  deps.vault.set(ref, input.apiKey);

  deps.registry.upsertProvider({
    id: providerId,
    name,
    adapter: OPENAI_COMPAT_ID,
    baseUrl,
    credentialRef: ref,
    policy: null,
    enabled: true,
  });

  let models: readonly ModelDescriptor[];
  try {
    models = await deps.adapters.get(OPENAI_COMPAT_ID).listModels({
      baseUrl,
      apiKey: input.apiKey,
    });
  } catch (err: unknown) {
    throw explainCompatFailure(err, baseUrl);
  }
  const namespaced = models.map((model) => ({
    ...model,
    id: namespacedModelId(providerId, model.id),
    providerId,
  }));
  const synced = deps.sync.sync(providerId, namespaced);
  return {
    providerId,
    name,
    added: synced.added,
    updated: synced.updated,
    disappeared: synced.disappeared,
    modelIds: namespaced.map((m) => m.id),
  };
}
