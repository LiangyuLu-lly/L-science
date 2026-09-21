/**
 * 设置页授权列表：审批卡写「可在设置里撤销」，这里必须真有列表与撤销。
 *
 * 源码契约，不是渲染快照。缺 listGrants / revokeGrant / 「授权」标题，
 * 或退回 window.confirm，都等于把那句承诺又变成空话。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join('packages', 'ui', 'src', 'components', 'SettingsView.tsx'), 'utf8');

describe('SettingsView grants section', () => {
  it('lists grants, revokes without window.confirm, and has an 授权 heading', () => {
    expect(SRC).toContain('listGrants');
    expect(SRC).toContain('revokeGrant');
    expect(SRC).toMatch(/<h2[^>]*>[\s\S]*授权/);
    expect(SRC).not.toContain('window.confirm');
  });

  it('calls listGrants and revokeGrant from JSX and requires two-click revoke confirm', () => {
    expect(SRC).toMatch(/listGrants\s*\(/);
    expect(SRC).toMatch(/revokeGrant\s*\(/);
    expect(SRC).toContain('pendingRevokeId');
    expect(SRC).toMatch(/>\s*撤销\s*</);
    expect(SRC).toMatch(/>\s*确认撤销\s*</);
    expect(SRC).not.toContain('window.confirm');
    expect(SRC).not.toMatch(/\balert\s*\(/);
  });
});
