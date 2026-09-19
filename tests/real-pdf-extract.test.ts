/**
 * 网上拉下来的真实 arXiv PDF。文件在 .omo/eval/papers/，不入库。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractPdfPage } from '@l-science/core';

const papers = join('.omo', 'eval', 'papers');

const CASES = [
  { file: 'umap.pdf', needle: /umap|manifold|dimension/iu },
  { file: 'circos.pdf', needle: /arxiv|abstract|introduction/iu },
  { file: 'scanorama.pdf', needle: /arxiv|abstract|prepared/iu },
] as const;

describe('real arXiv PDFs', () => {
  for (const c of CASES) {
    it(`page 1 of ${c.file} yields text`, async () => {
      const path = join(papers, c.file);
      if (!existsSync(path)) return;
      const result = await extractPdfPage(path, 1);
      expect(result.pageCount).toBeGreaterThan(0);
      expect(result.text.length, `empty extract from ${c.file}`).toBeGreaterThan(20);
      expect(result.text).toMatch(c.needle);
    });
  }
});
