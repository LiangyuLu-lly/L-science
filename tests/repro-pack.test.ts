import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeReproZip } from '@l-science/core';
import { parseRequest } from '@l-science/shared';

describe('writeReproZip', () => {
  it('zips blob copies and a manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsci-repro-'));
    const src = join(dir, 'fig.png');
    writeFileSync(src, 'png-bytes');
    const stageDir = join(dir, 'stage');
    const zipPath = join(dir, 'out.zip');
    const result = writeReproZip({
      projectId: 'p1',
      stageDir,
      zipPath,
      files: [{ name: 'fig.png', src, reproducible: false }],
    });
    expect(result.fileCount).toBe(1);
    expect(result.irreproducible).toBe(1);
    expect(readFileSync(join(stageDir, 'MANIFEST.md'), 'utf8')).toContain('血缘不完整');
    expect(readFileSync(zipPath).length).toBeGreaterThan(20);
  });
});

describe('artifact.exportRepro IPC', () => {
  it('accepts projectId', () => {
    expect(parseRequest({ method: 'artifact.exportRepro', projectId: 'p1' }).ok).toBe(true);
  });
});
