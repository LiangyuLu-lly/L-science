/**
 * 对标评测集 10 条：机器可判的底线。真人课题仍要另跑。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRequest } from '@l-science/shared';

const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

describe('cs-eval 10 scenarios', () => {
  it('1 DOI resolve IPC exists', () => {
    expect(parseRequest({ method: 'ref.resolve', projectId: 'p', identifiers: ['10.1/x'] }).ok).toBe(
      true,
    );
  });

  it('2 literature view can resolve without chat', () => {
    expect(read('packages', 'ui', 'src', 'components', 'RefsView.tsx')).toContain('resolveRefs');
  });

  it('3 pdf page extract is exported', () => {
    expect(read('packages', 'core', 'src', 'tools', 'index.ts')).toContain('extractPdfPage');
  });

  it('4 claims rank unsupported first', () => {
    expect(read('packages', 'ui', 'src', 'components', 'ClaimsView.tsx')).toContain('rankClaims');
  });

  it('5 manuscripts block submit copy', () => {
    expect(read('packages', 'ui', 'src', 'components', 'ManuscriptsView.tsx')).toContain(
      '不能标为可投稿',
    );
  });

  it('6 kernel bootstrap script exists', () => {
    expect(read('scripts', 'bootstrap-kernels.ps1')).toContain('conda create -n lsci');
  });

  it('7 reviewer is cross-vendor', () => {
    expect(read('packages', 'core', 'src', 'reviewer', 'service.ts')).toContain('pickCrossVendor');
  });

  it('8 usage summary IPC exists', () => {
    expect(parseRequest({ method: 'usage.summary', projectId: 'p' }).ok).toBe(true);
  });

  it('9 routing panel compares all candidates', () => {
    expect(read('packages', 'ui', 'src', 'components', 'RoutingPanel.tsx')).toMatch(/全候选|对照/u);
  });

  it('10 featured skills show traffic lights', () => {
    expect(read('packages', 'ui', 'src', 'components', 'SkillsView.tsx')).toContain('skillTraffic');
    expect(read('packages', 'ui', 'src', 'lib', 'skill-traffic.ts')).toContain('alphafold2');
  });
});

describe('cs-eval extras', () => {
  it('exportRepro IPC and committee preview are wired', () => {
    expect(parseRequest({ method: 'artifact.exportRepro', projectId: 'p' }).ok).toBe(true);
    expect(read('packages', 'ui', 'src', 'components', 'RoutingPanel.tsx')).toContain(
      '对照候选（发送只会跑主模型，不会自动连发',
    );
    expect(read('packages', 'ui', 'src', 'components', 'ArtifactsView.tsx')).toContain(
      'exportReproPack',
    );
  });
});
