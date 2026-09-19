import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOI_SOURCES,
  explainCompatFailure,
  newModelsEnabledByDefault,
} from '@l-science/core';

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

describe('explainCompatFailure', () => {
  it('maps 401 to a key error', () => {
    const err = explainCompatFailure(new Error('401 Unauthorized'), 'https://api.openai.com/v1');
    expect(err.message).toContain('密钥被拒绝');
  });

  it('maps 404 to a base URL hint', () => {
    const err = explainCompatFailure(new Error('404 Not Found'), 'https://example.com');
    expect(err.message).toContain('/v1');
  });
});
