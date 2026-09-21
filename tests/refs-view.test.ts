/**
 * 文献页：抓全文、附本地 PDF、删除；文案不再假称只问 Crossref。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const VIEW = readFileSync(join('packages', 'ui', 'src', 'components', 'RefsView.tsx'), 'utf8');

describe('refs view fulltext and delete', () => {
  it('wires fetch, delete, and local PDF attach', () => {
    expect(VIEW).toContain('fetchFulltext');
    expect(VIEW).toContain('deleteRef');
    expect(VIEW).toContain('attachFulltext');
    expect(VIEW).toContain('contentBase64');
  });

  it('uses a single paste-or-drop CTA and does not claim Crossref-only', () => {
    expect(VIEW).toContain('贴 DOI 或拖入 PDF');
    expect(VIEW).not.toContain('默认只问 Crossref');
    expect(VIEW).toMatch(/onDrop|type="file"/);
  });
});

describe('refs view duplicates and export', () => {
  it('wires duplicate scan, merge, and export', () => {
    expect(VIEW).toContain('listRefDuplicates');
    expect(VIEW).toContain('mergeRefs');
    expect(VIEW).toContain('exportRefs');
  });
});
