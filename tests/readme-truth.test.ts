/**
 * README 只写今天真做得到的事。过期许诺必须删掉，落地能力必须写上。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ZH = readFileSync(join('README.md'), 'utf8');
const EN = readFileSync(join('README.en.md'), 'utf8');

describe('README truth', () => {
  it('omits overstated promises from both files', () => {
    for (const text of [ZH, EN]) {
      expect(text).not.toContain('始终可以跟助手说话');
      expect(text).not.toContain('后台安装');
      expect(text).not.toContain('只问 Crossref');
      expect(text).not.toContain('可投稿成品');
      expect(text).not.toContain('默认同步');
      expect(text).not.toContain('数字版 PDF 按页抽字');
      expect(text).not.toMatch(/always talk to the assistant from the bottom/i);
      expect(text).not.toContain('installs in the background');
      expect(text).not.toContain('Crossref by default');
      expect(text).not.toContain('submission-ready');
      expect(text).not.toContain('Page-level text extract from digital PDFs');
    }
  });

  it('states landed capabilities', () => {
    expect(ZH).toContain('贴 DOI 或拖入 PDF');
    expect(ZH).toContain('摘自全文');
    expect(ZH).toContain('在制品里查看');
    expect(ZH).toContain('授权');
    expect(EN).toContain('paste a DOI or drop a PDF');
    expect(EN).toContain('extracted from the full text');
    expect(EN).toContain('View in Artifacts');
    expect(EN).toContain('Grants');
  });
});
