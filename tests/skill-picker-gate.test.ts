/**
 * 技能选择器：红灯技能可见但不可插入。
 *
 * 目录里有条目不等于能跑。红灯行要留在列表里（用户得知道方法存在），
 * 但必须是真正的 disabled 控件，不能进作曲器。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { skillTraffic } from '../packages/ui/src/lib/skill-traffic.js';

const PICKER = readFileSync(join('packages', 'ui', 'src', 'components', 'SkillPicker.tsx'), 'utf8');

describe('skill picker gate', () => {
  it('consults skillTraffic to decide pickability', () => {
    expect(skillTraffic({
      enabled: true,
      present: true,
      requirementsSatisfied: false,
      missing: [{ name: 'protein_mpnn_run.py' }],
      probeFailures: [],
    })).toBe('red');
    expect(skillTraffic({
      enabled: true,
      present: true,
      requirementsSatisfied: true,
      missing: [],
      probeFailures: [],
    })).toBe('green');
    expect(skillTraffic({
      enabled: true,
      present: true,
      requirementsSatisfied: null,
      missing: [],
      probeFailures: [{ kind: 'python' }],
    })).toBe('yellow');

    expect(PICKER).toMatch(/skillTraffic\s*\(/u);
    expect(PICKER).toMatch(/from ['"]\.\.\/lib\/skill-traffic\.js['"]/u);
    expect(PICKER).toMatch(/!== ['"]red['"]/u);
  });

  it('red row renders a disabled control with the missing-dependency reason', () => {
    expect(PICKER).toMatch(/\bdisabled=\{[^}]*=== ['"]red['"]/u);
    expect(PICKER).toContain('⚠ 缺少依赖，本机不能跑');
    expect(PICKER).toContain('missingSummary');
    expect(PICKER).toMatch(/onClick=\{\(\) =>[\s\S]*=== ['"]red['"][\s\S]*onPick\(hit\)/u);
  });
});
