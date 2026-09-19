import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('bootstrap-kernels', () => {
  it('script creates lsci and lsci-r without bundling conda into the installer', () => {
    const ps1 = readFileSync(join('scripts', 'bootstrap-kernels.ps1'), 'utf8');
    expect(ps1).toContain('conda create -n lsci');
    expect(ps1).toContain('lsci-r');
    expect(ps1).not.toMatch(/electron-builder|extraResources/u);
  });

  it('env doctor offers copy of the bootstrap commands', () => {
    const overlay = readFileSync(
      join('packages', 'ui', 'src', 'components', 'FirstRunOverlay.tsx'),
      'utf8',
    );
    expect(overlay).toContain('复制 lsci 命令');
    expect(overlay).toContain('bootstrap-kernels.ps1');
  });
});
