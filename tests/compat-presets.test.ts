import { describe, expect, it } from 'vitest';

import {
  COMPAT_PRESETS,
  apiModelName,
  compatProviderIdForUrl,
  findCompatPreset,
  namespacedModelId,
} from '@l-science/core';

describe('compat presets', () => {
  it('covers major OpenAI-compatible gateways', () => {
    const ids = COMPAT_PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'groq',
        'openrouter',
        'gemini',
        'moonshot',
        'qwen',
        'zhipu',
        'siliconflow',
      ]),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of COMPAT_PRESETS) {
      expect(preset.baseUrl.startsWith('https://')).toBe(true);
    }
  });

  it('looks up presets by id', () => {
    expect(findCompatPreset('moonshot')?.baseUrl).toContain('moonshot.cn');
    expect(findCompatPreset('nope')).toBeNull();
  });

  it('derives stable custom ids from hostname', () => {
    expect(compatProviderIdForUrl('https://vllm.local/v1')).toBe('compat-vllm-local');
  });
});

describe('apiModelName', () => {
  it('strips provider prefix for the wire name', () => {
    expect(apiModelName({ id: 'openai/gpt-4o', providerId: 'openai' })).toBe('gpt-4o');
    expect(apiModelName({ id: 'deepseek-chat', providerId: 'deepseek' })).toBe('deepseek-chat');
  });

  it('namespaces discovered model ids per provider', () => {
    expect(namespacedModelId('groq', 'llama-3.1-70b-versatile')).toBe(
      'groq/llama-3.1-70b-versatile',
    );
  });
});
