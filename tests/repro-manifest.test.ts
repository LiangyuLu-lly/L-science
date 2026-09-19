import { describe, expect, it } from 'vitest';

import { formatReproManifest } from '../packages/ui/src/lib/repro-manifest.js';

describe('formatReproManifest', () => {
  it('names irreproducible artifacts so the pack cannot pretend they are fine', () => {
    const text = formatReproManifest({
      projectId: 'p1',
      exportedAt: 0,
      artifacts: [
        {
          id: 'a1',
          filename: 'fig1.png',
          reproducible: false,
          versionCount: 1,
          deletedAt: null,
        },
      ],
    });
    expect(text).toContain('fig1.png');
    expect(text).toContain('血缘不完整');
    expect(text).toContain('p1');
  });
});
