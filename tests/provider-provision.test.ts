/**
 * 已知供应商登记（provider.provision）。
 *
 * 这条路径会写入凭据并决定路由能看见哪些供应商，错了的后果是「配了 key
 * 却永远选不到模型」或「密钥出现在回执里」。因此重点验：
 * 健康检查失败仍保留密钥、成功才登记、密钥永不出现在结果里。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterRegistry, type ProviderAdapter } from '@l-science/adapters';
import {
  AppStore,
  CredentialVault,
  KNOWN_PROVIDERS,
  RegistryRepo,
  RegistrySync,
  dpapiAvailable,
  providerRef,
  provisionKnownProviders,
} from '@l-science/core';
import type { ModelDescriptor } from '@l-science/shared';

const SECRET = 'sk-PROVISION-CANARY-7c1e90ab';

let root: string;
let store: AppStore;
let vault: CredentialVault;
let registry: RegistryRepo;
let sync: RegistrySync;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-prov-'));
  store = AppStore.open(root);
  vault = new CredentialVault(join(store.paths.credentials, 'vault.bin'));
  registry = new RegistryRepo(store.db);
  sync = new RegistrySync(store.db, registry);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function descriptor(id: string, providerId: string): ModelDescriptor {
  return {
    id,
    providerId,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    modalities: ['text'],
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
    pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' },
    performance: { medianLatencyMs: 700, tokensPerSec: 40 },
    policy: { trainingUse: 'unknown', retentionDays: null, zdr: false, region: 'cn' },
    local: providerId === 'ollama',
    features: { streaming: true, toolUse: true, promptCache: false, vision: false, thinking: false },
  };
}

function fakeAdapter(spec: {
  id: string;
  healthOk: boolean;
  healthDetail?: string;
  models?: readonly ModelDescriptor[];
}): ProviderAdapter {
  return {
    id: spec.id,
    displayName: spec.id,
    async health() {
      return {
        ok: spec.healthOk,
        latencyMs: 11,
        ...(spec.healthDetail === undefined ? {} : { detail: spec.healthDetail }),
      };
    },
    async listModels() {
      return spec.models ?? [descriptor(`${spec.id}-m1`, spec.id)];
    },
    async *chat() {
      return;
    },
  };
}

function adaptersOf(...items: ProviderAdapter[]): AdapterRegistry {
  const adapters = new AdapterRegistry();
  for (const item of items) adapters.register(item);
  return adapters;
}

describe('已知供应商清单', () => {
  it('只含 DeepSeek 与 Ollama，id 与 scripts/provision.mjs 一致', () => {
    expect(KNOWN_PROVIDERS.map((p) => p.id)).toEqual(['deepseek', 'ollama']);
  });
});

describe('provisionKnownProviders', () => {
  it('无密钥且 Ollama 不健康时两家都跳过，注册表为空', async () => {
    const adapters = adaptersOf(
      fakeAdapter({ id: 'deepseek', healthOk: true }),
      fakeAdapter({ id: 'ollama', healthOk: false, healthDetail: 'ollama down' }),
    );

    const result = await provisionKnownProviders({ vault, registry, sync, adapters });

    expect(registry.listProviders({ includeDisabled: true })).toEqual([]);
    expect(result.providers.map((p) => p.status)).toEqual(['skipped', 'skipped']);
    expect(result.providers.map((p) => p.id)).toEqual(['deepseek', 'ollama']);
  });

  it.skipIf(!dpapiAvailable())('DeepSeek 密钥 + 健康通过时写入 vault 并登记供应商与模型', async () => {
    const adapters = adaptersOf(
      fakeAdapter({
        id: 'deepseek',
        healthOk: true,
        models: [descriptor('deepseek-v4-flash', 'deepseek')],
      }),
      fakeAdapter({ id: 'ollama', healthOk: false }),
    );

    const result = await provisionKnownProviders(
      { vault, registry, sync, adapters },
      { deepseekKey: SECRET, detectOllama: false },
    );

    expect(vault.has(providerRef('deepseek'))).toBe(true);
    expect(vault.get(providerRef('deepseek'))).toBe(SECRET);

    const provider = registry.getProvider('deepseek');
    expect(provider).toMatchObject({
      id: 'deepseek',
      adapter: 'deepseek',
      credentialRef: providerRef('deepseek'),
      enabled: true,
    });
    expect(registry.listModels({ providerId: 'deepseek' }).map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
    ]);

    const deepseek = result.providers.find((p) => p.id === 'deepseek');
    expect(deepseek?.status).toBe('registered');
  });

  it.skipIf(!dpapiAvailable())('DeepSeek 密钥 + 健康失败时密钥仍保存，供应商不登记，结果说明失败且不含密钥', async () => {
    const adapters = adaptersOf(
      fakeAdapter({
        id: 'deepseek',
        healthOk: false,
        healthDetail: '401 unauthorized',
      }),
      fakeAdapter({ id: 'ollama', healthOk: false }),
    );

    const logs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return origErr(chunk, ...(rest as []));
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return origOut(chunk, ...(rest as []));
    }) as typeof process.stdout.write;

    let result;
    try {
      result = await provisionKnownProviders(
        { vault, registry, sync, adapters },
        { deepseekKey: SECRET, detectOllama: false },
      );
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }

    expect(vault.has(providerRef('deepseek'))).toBe(true);
    expect(vault.get(providerRef('deepseek'))).toBe(SECRET);
    expect(registry.getProvider('deepseek')).toBeNull();

    const deepseek = result.providers.find((p) => p.id === 'deepseek');
    expect(deepseek).toMatchObject({ id: 'deepseek', status: 'skipped', reason: 'health_failed' });
    if (deepseek?.status === 'skipped') {
      expect(deepseek.detail).toBe('401 unauthorized');
    }

    const dumped = `${JSON.stringify(result)}\n${logs.join('')}`;
    expect(dumped).not.toContain(SECRET);
  });

  it('Ollama 健康且不需要密钥时登记，vault 无对应条目', async () => {
    const adapters = adaptersOf(
      fakeAdapter({ id: 'deepseek', healthOk: true }),
      fakeAdapter({
        id: 'ollama',
        healthOk: true,
        models: [descriptor('llama3.2', 'ollama')],
      }),
    );

    const result = await provisionKnownProviders(
      { vault, registry, sync, adapters },
      { detectOllama: true },
    );

    const provider = registry.getProvider('ollama');
    expect(provider).toMatchObject({
      id: 'ollama',
      adapter: 'ollama',
      credentialRef: null,
      enabled: true,
    });
    expect(vault.has(providerRef('ollama'))).toBe(false);
    expect(registry.listModels({ providerId: 'ollama' }).map((m) => m.id)).toEqual(['llama3.2']);

    const ollama = result.providers.find((p) => p.id === 'ollama');
    expect(ollama?.status).toBe('registered');
  });
});
