/**
 * 供应商与模型注册表测试（任务 11.1b）。
 *
 * 重点在几条容易写错、且错了以后会静默丢用户设置的行为：
 * - 同步时保留用户的启用/禁用选择
 * - 线上消失的模型禁用而不删除（否则历史反馈作废）
 * - 供应商被禁用时其模型全部不可选
 * - 过期的健康结果不采信
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '@l-science/shared';
import {
  AppStore,
  HEALTH_TTL_MS,
  RegistryRepo,
  RegistrySync,
  buildRouterView,
  type ProviderRecord,
} from '@l-science/core';

let root: string;
let store: AppStore;
let db: AppStore['db'];
let repo: RegistryRepo;
let sync: RegistrySync;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-reg-'));
  store = AppStore.open(root);
  db = store.db;
  repo = new RegistryRepo(db);
  sync = new RegistrySync(db, repo);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'deepseek',
  name: 'DeepSeek',
  adapter: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  credentialRef: 'provider:deepseek',
  policy: null,
  enabled: true,
  ...overrides,
});

function descriptor(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    providerId: 'deepseek',
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
    local: false,
    features: { streaming: true, toolUse: true, promptCache: true, vision: false, thinking: false },
    ...overrides,
  };
}

describe('供应商', () => {
  it('写入后可读出', () => {
    repo.upsertProvider(provider());
    const found = repo.getProvider('deepseek');
    expect(found).toMatchObject({ id: 'deepseek', name: 'DeepSeek', enabled: true });
  });

  it('存的是凭据引用名而不是凭据本身', () => {
    repo.upsertProvider(provider({ credentialRef: 'provider:deepseek' }));
    // 密钥永不进数据库
    expect(repo.getProvider('deepseek')?.credentialRef).toBe('provider:deepseek');
  });

  it('重复写入是更新而不是报错', () => {
    repo.upsertProvider(provider());
    repo.upsertProvider(provider({ name: '改名了' }));
    expect(repo.getProvider('deepseek')?.name).toBe('改名了');
    expect(repo.listProviders()).toHaveLength(1);
  });

  it('默认只列启用的', () => {
    repo.upsertProvider(provider());
    repo.upsertProvider(provider({ id: 'off', enabled: false }));
    expect(repo.listProviders().map((p) => p.id)).toEqual(['deepseek']);
    expect(repo.listProviders({ includeDisabled: true })).toHaveLength(2);
  });

  it('删除供应商时级联删除其模型', () => {
    repo.upsertProvider(provider());
    sync.sync('deepseek', [descriptor('m1')]);
    expect(repo.listModels()).toHaveLength(1);

    repo.deleteProvider('deepseek');
    expect(repo.listModels()).toHaveLength(0);
  });

  it('policy 损坏时按缺失处理，不让整个列表读不出来', () => {
    repo.upsertProvider(provider());
    db.prepare("UPDATE providers SET policy_json = 'not json' WHERE id = ?").run('deepseek');
    expect(repo.getProvider('deepseek')?.policy).toBeNull();
  });
});

describe('模型同步', () => {
  beforeEach(() => {
    repo.upsertProvider(provider());
  });

  it('首次同步全部标为新增', () => {
    const result = sync.sync('deepseek', [descriptor('a'), descriptor('b')]);
    expect(result.added).toEqual(['a', 'b']);
    expect(result.updated).toEqual([]);
    expect(result.disappeared).toEqual([]);
  });

  it('再次同步同一批标为更新', () => {
    sync.sync('deepseek', [descriptor('a')]);
    const result = sync.sync('deepseek', [descriptor('a')]);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['a']);
  });

  it('保留用户的禁用选择', () => {
    // 不这样做的话，每次同步都会把用户关掉的模型重新打开
    sync.sync('deepseek', [descriptor('a')]);
    repo.setModelEnabled('a', false);
    sync.sync('deepseek', [descriptor('a')]);
    expect(repo.getModel('a')?.enabled).toBe(false);
  });

  it('线上消失的模型被禁用而不是删除', () => {
    // 删除会丢掉用户的启用选择与历史反馈统计所引用的行。供应商灰度或
    // 区域差异造成的抖动会让模型以「全新模型」身份回来，反馈全部作废
    sync.sync('deepseek', [descriptor('a'), descriptor('b')]);
    const result = sync.sync('deepseek', [descriptor('a')]);

    expect(result.disappeared).toEqual(['b']);
    expect(repo.getModel('b')).not.toBeNull();
    expect(repo.getModel('b')?.enabled).toBe(false);
  });

  it('已禁用的模型再次消失不重复上报', () => {
    sync.sync('deepseek', [descriptor('a'), descriptor('b')]);
    sync.sync('deepseek', [descriptor('a')]);
    const second = sync.sync('deepseek', [descriptor('a')]);
    expect(second.disappeared).toEqual([]);
  });

  it('模型恢复后可重新启用，历史行仍在', () => {
    sync.sync('deepseek', [descriptor('a')]);
    sync.sync('deepseek', []);
    expect(repo.getModel('a')?.enabled).toBe(false);

    repo.setModelEnabled('a', true);
    sync.sync('deepseek', [descriptor('a')]);
    expect(repo.getModel('a')?.enabled).toBe(true);
  });

  it('更新会刷新能力描述', () => {
    sync.sync('deepseek', [descriptor('a', { contextWindow: 8000 })]);
    sync.sync('deepseek', [descriptor('a', { contextWindow: 1_000_000 })]);
    expect(repo.getModel('a')?.descriptor.contextWindow).toBe(1_000_000);
  });

  it('只影响指定供应商的模型', () => {
    repo.upsertProvider(provider({ id: 'ollama', name: 'Ollama', credentialRef: null }));
    sync.sync('deepseek', [descriptor('ds-a')]);
    sync.sync('ollama', [descriptor('ol-a', { providerId: 'ollama' })]);

    // 同步 deepseek 时不该把 ollama 的模型判为消失
    const result = sync.sync('deepseek', [descriptor('ds-a')]);
    expect(result.disappeared).toEqual([]);
    expect(repo.getModel('ol-a')?.enabled).toBe(true);
  });

  it('描述损坏的模型被跳过，不用假数据参与打分', () => {
    sync.sync('deepseek', [descriptor('a'), descriptor('b')]);
    db.prepare("UPDATE models SET descriptor_json = 'broken' WHERE id = ?").run('a');
    const models = repo.listModels();
    expect(models.map((m) => m.id)).toEqual(['b']);
  });
});

describe('健康状态', () => {
  beforeEach(() => {
    repo.upsertProvider(provider());
    sync.sync('deepseek', [descriptor('a')]);
  });

  it('记录后可读出', () => {
    repo.recordHealth('a', { ok: true, latencyMs: 220, checkedAt: Date.now() });
    expect(repo.getModel('a')?.health).toMatchObject({ ok: true, latencyMs: 220 });
  });

  it('同步不会清掉已记录的健康状态', () => {
    repo.recordHealth('a', { ok: true, latencyMs: 220, checkedAt: Date.now() });
    sync.sync('deepseek', [descriptor('a')]);
    expect(repo.getModel('a')?.health?.ok).toBe(true);
  });
});

describe('路由视图', () => {
  beforeEach(() => {
    repo.upsertProvider(provider());
    sync.sync('deepseek', [descriptor('a'), descriptor('b')]);
  });

  const view = (hasCredential = true, now = Date.now()) =>
    buildRouterView({ repo, hasCredential: () => hasCredential, now });

  it('给出全部模型的描述数组', () => {
    expect(
      view()
        .models.map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('凭据缺失反映到运行时状态', () => {
    expect(view(true).runtime.get('a')?.hasCredential).toBe(true);
    expect(view(false).runtime.get('a')?.hasCredential).toBe(false);
  });

  it('模型被禁用反映为 userDisabled', () => {
    repo.setModelEnabled('a', false);
    expect(view().runtime.get('a')?.userDisabled).toBe(true);
    expect(view().runtime.get('b')?.userDisabled).toBe(false);
  });

  it('供应商被禁用时其全部模型不可选', () => {
    // 不这样处理的话，用户在设置里关掉一家供应商后它的模型仍会被选中
    repo.setProviderEnabled('deepseek', false);
    expect(view().runtime.get('a')?.userDisabled).toBe(true);
    expect(view().runtime.get('b')?.userDisabled).toBe(true);
  });

  it('新鲜的健康结果被采信', () => {
    const now = Date.now();
    repo.recordHealth('a', { ok: false, latencyMs: 0, checkedAt: now - 1000 });
    expect(view(true, now).runtime.get('a')?.healthy).toBe(false);
  });

  it('过期的健康结果不采信', () => {
    // 五分钟前不健康不代表现在不健康。拿旧结果做硬过滤会让恢复了的
    // 供应商长期被排除
    const now = Date.now();
    repo.recordHealth('a', { ok: false, latencyMs: 0, checkedAt: now - HEALTH_TTL_MS - 1 });
    expect(view(true, now).runtime.get('a')?.healthy).toBeUndefined();
  });

  it('从未检查过的模型健康状态为未知而非不健康', () => {
    expect(view().runtime.get('b')?.healthy).toBeUndefined();
  });

  it('视图包含被禁用的模型，让路由能报告它们为什么被排除', () => {
    // 直接过滤掉的话，用户看不到「这个模型被你自己关了」这条信息
    repo.setModelEnabled('a', false);
    expect(view().models.map((m) => m.id)).toContain('a');
  });
});
