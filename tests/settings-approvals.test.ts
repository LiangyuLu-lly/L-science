/**
 * 设置页审批历史：任务 14.5 要求能回答「谁在什么时候批准了删除哪个制品」，
 * 且拒绝记忆可撤销。源码契约，不是渲染快照。
 *
 * 缺 listApprovalHistory / forgetApprovalDenial / 「审批」标题，
 * 或退回 window.confirm，都等于把那句承诺又变成空话。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join('packages', 'ui', 'src', 'components', 'SettingsView.tsx'), 'utf8');

describe('SettingsView approvals section', () => {
  it('lists approval history, forgets denials without window.confirm, and has an 审批 heading', () => {
    expect(SRC).toContain('listApprovalHistory');
    expect(SRC).toContain('forgetApprovalDenial');
    expect(SRC).toMatch(/<h2[^>]*>[\s\S]*审批/);
    expect(SRC).not.toContain('window.confirm');
  });

  it('calls listApprovalHistory and forgetApprovalDenial from JSX and requires two-click forget confirm', () => {
    expect(SRC).toMatch(/listApprovalHistory\s*\(/);
    expect(SRC).toMatch(/forgetApprovalDenial\s*\(/);
    expect(SRC).toContain('pendingForgetId');
    expect(SRC).toMatch(/>\s*忘记这条拒绝\s*</);
    expect(SRC).toMatch(/>\s*确认忘记\s*</);
    expect(SRC).not.toContain('window.confirm');
    expect(SRC).not.toMatch(/\balert\s*\(/);
  });
});
