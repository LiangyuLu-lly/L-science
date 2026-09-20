import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureMicromamba,
  micromambaExe,
  resetBootstrapState,
  startBootstrapKernels,
} from '@l-science/core';
import { parseRequest } from '@l-science/shared';

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
    expect(overlay).toContain('一键安装 Python / R 内核');
  });

  it('IPC accepts env.bootstrapKernels without extra fields', () => {
    expect(parseRequest({ method: 'env.bootstrapKernels' }).ok).toBe(true);
    expect(parseRequest({ method: 'env.bootstrapStatus' }).ok).toBe(true);
  });
});

describe('micromamba bootstrap helpers', () => {
  let root: string;
  const prev = process.env['L_SCIENCE_DATA_DIR'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-mamba-'));
    process.env['L_SCIENCE_DATA_DIR'] = root;
    resetBootstrapState();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['L_SCIENCE_DATA_DIR'];
    else process.env['L_SCIENCE_DATA_DIR'] = prev;
    rmSync(root, { recursive: true, force: true });
    resetBootstrapState();
  });

  it('downloads micromamba into the data dir', async () => {
    const fake = new Uint8Array(2048).fill(1);
    const result = await ensureMicromamba(async () => new Response(fake, { status: 200 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(micromambaExe());
  });

  it('startBootstrapKernels returns a status snapshot', () => {
    const report = startBootstrapKernels({
      fetchImpl: async () => new Response(new Uint8Array(2048).fill(1), { status: 200 }),
      run: async () => ({ ok: true, stderr: '' }),
    });
    expect(report.python === 'exists' || report.running).toBe(true);
  });
});
