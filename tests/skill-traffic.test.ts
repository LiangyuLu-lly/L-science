import { describe, expect, it } from 'vitest';

import {
  FEATURED_SKILL_SLUGS,
  skillTraffic,
} from '../packages/ui/src/lib/skill-traffic.js';

describe('skillTraffic', () => {
  const base = {
    enabled: true,
    present: true,
    requirementsSatisfied: true as boolean | null,
    missing: [] as readonly { name: string }[],
    probeFailures: [] as readonly { kind: string }[],
  };

  it('is green when featured skill is present, enabled, and satisfied', () => {
    expect(skillTraffic(base)).toBe('green');
  });

  it('is red when colabfold is missing even if the skill is in the catalog', () => {
    expect(skillTraffic({ ...base, requirementsSatisfied: false, missing: [{ name: 'colabfold_batch' }] })).toBe(
      'red',
    );
  });

  it('is yellow when probe did not finish', () => {
    expect(skillTraffic({ ...base, requirementsSatisfied: null, probeFailures: [{ kind: 'python' }] })).toBe(
      'yellow',
    );
  });

  it('lists the 14 CS featured slugs', () => {
    expect(FEATURED_SKILL_SLUGS).toContain('alphafold2');
    expect(FEATURED_SKILL_SLUGS).toHaveLength(14);
  });
});
