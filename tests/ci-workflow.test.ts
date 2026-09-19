/**
 * CI 契约：Windows + Node 24 跑类型检查与 vitest，不打安装包、不引入遥测。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CI = readFileSync(join('.github', 'workflows', 'ci.yml'), 'utf8');

describe('ci workflow', () => {
  it('runs on windows-latest with Node 24 and vitest, without sentry or pack:win', () => {
    expect(CI).toContain('windows-latest');
    expect(CI).toMatch(/node-version:\s*['"]?24/u);
    expect(CI).toContain('vitest');
    expect(CI.toLowerCase()).not.toContain('sentry');
    expect(CI).not.toContain('pack:win');
  });
});
