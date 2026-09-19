/**
 * 对标底线锁。规格同构不算数；这些断言失败 = 对外不得说「不弱于 Claude Science」。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => join(...parts);

describe('cs-parity floor', () => {
  it('paper path is first-class navigation', () => {
    const app = readFileSync(root('packages', 'ui', 'src', 'App.tsx'), 'utf8');
    expect(app).toContain("label: '文献'");
    expect(app).toContain("label: '断言'");
    expect(app).toContain("label: '手稿'");
  });

  it('literature page can resolve identifiers without opening chat', () => {
    const refs = readFileSync(root('packages', 'ui', 'src', 'components', 'RefsView.tsx'), 'utf8');
    const api = readFileSync(root('packages', 'ui', 'src', 'lib', 'api.ts'), 'utf8');
    expect(api).toContain("method: 'ref.resolve'");
    expect(refs).toContain('resolveRefs');
    expect(refs).toContain('htmlFor');
  });

  it('reviewer picks a cross-vendor model and does not silently same-family', () => {
    const service = readFileSync(
      root('packages', 'core', 'src', 'reviewer', 'service.ts'),
      'utf8',
    );
    expect(service).toContain('pickCrossVendor');
    expect(service).toMatch(/明确告知降级|异厂商/u);
  });

  it('kernel gap still shows conda create -n lsci instead of pretending python works', () => {
    const overlay = readFileSync(
      root('packages', 'ui', 'src', 'components', 'FirstRunOverlay.tsx'),
      'utf8',
    );
    const tools = readFileSync(root('packages', 'ui', 'src', 'lib', 'unavailable-tools.ts'), 'utf8');
    expect(`${overlay}\n${tools}`).toContain('conda create -n lsci');
  });

  it('pdf-explore is not on the catalog denylist', () => {
    const loader = readFileSync(root('packages', 'core', 'src', 'skills', 'loader.ts'), 'utf8');
    expect(loader).not.toMatch(/CATALOG_UNAVAILABLE[\s\S]*pdf-explore/u);
  });
});
