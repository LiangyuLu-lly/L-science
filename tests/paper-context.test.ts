import { describe, expect, it } from 'vitest';

import {
  EXTRACT_CLAIMS_PROMPT,
  formatPaperPrefix,
  literatureMarkdown,
  withPaperContext,
} from '../packages/ui/src/lib/paper-context.js';

describe('paper context', () => {
  const ref = {
    id: 'r1',
    doi: '10.1038/s41586-021-03819-2',
    cite: 'Jumper et al. 2021',
    title: 'Highly accurate protein structure prediction with AlphaFold',
  };

  it('prefix includes DOI and forbids invented page numbers', () => {
    const prefix = formatPaperPrefix(ref);
    expect(prefix).toContain('【当前文献】');
    expect(prefix).toContain('10.1038/s41586-021-03819-2');
    expect(prefix).toContain('不要编造页码');
    expect(prefix).toContain('manage_claims');
  });

  it('withPaperContext is identity when no focus', () => {
    expect(withPaperContext('hello', null)).toBe('hello');
  });

  it('extract prompt asks to bind doi', () => {
    expect(EXTRACT_CLAIMS_PROMPT).toContain('evidenceKind=doi');
  });

  it('literatureMarkdown includes title and DOI for claim.extract', () => {
    expect(literatureMarkdown(ref)).toContain('10.1038/s41586-021-03819-2');
    expect(literatureMarkdown(ref)).toContain('# Highly accurate protein structure prediction with AlphaFold');
  });
});
