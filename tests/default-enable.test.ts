import { describe, expect, it } from 'vitest';

import { DEFAULT_DOI_SOURCES, newModelsEnabledByDefault } from '@l-science/core';

describe('newModelsEnabledByDefault', () => {
  it('enables the whole catalog for small providers', () => {
    const ids = ['openai/gpt-4o', 'openai/gpt-4o-mini'];
    expect([...newModelsEnabledByDefault('openai', ids)]).toEqual(ids);
  });

  it('caps OpenRouter to preferred models', () => {
    const ids = [
      'openrouter/openai/gpt-4o-mini',
      'openrouter/foo/obscure-a',
      'openrouter/foo/obscure-b',
    ];
    const enabled = newModelsEnabledByDefault('openrouter', ids);
    expect(enabled.has('openrouter/openai/gpt-4o-mini')).toBe(true);
    expect(enabled.has('openrouter/foo/obscure-a')).toBe(false);
    expect(enabled.size).toBeLessThanOrEqual(8);
  });

  it('falls back to the first eight when nothing matches', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `siliconflow/obscure-${String(i)}`);
    expect(newModelsEnabledByDefault('siliconflow', ids).size).toBe(8);
  });
});

describe('DEFAULT_DOI_SOURCES', () => {
  it('is Crossref only', () => {
    expect(DEFAULT_DOI_SOURCES).toEqual(['crossref']);
  });
});
