/**
 * 首次运行遮罩门闩。
 *
 * 无模型时会话必须继续挡住。跳过只放行设置页，避免空聊天看起来能用。
 */

import { describe, expect, it } from 'vitest';

import { CONDA_ENV_NOTICE, shouldShowFirstRun } from '../packages/ui/src/lib/first-run.js';

describe('shouldShowFirstRun', () => {
  it('shows overlay when no providers are registered and session was not skipped', () => {
    const input = { providerCount: 0, skippedThisSession: false, view: 'chat' };
    expect(shouldShowFirstRun(input)).toBe(true);
  });

  it('keeps overlay on chat even after skip', () => {
    const input = { providerCount: 0, skippedThisSession: true, view: 'chat' };
    expect(shouldShowFirstRun(input)).toBe(true);
  });

  it('hides overlay on settings after skip', () => {
    const input = { providerCount: 0, skippedThisSession: true, view: 'settings' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('hides overlay when at least one provider is already registered', () => {
    const input = { providerCount: 1, skippedThisSession: false, view: 'chat' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('hides overlay when providers exist even if skip is also set', () => {
    const input = { providerCount: 2, skippedThisSession: true, view: 'chat' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('keeps CONDA_ENV_NOTICE exact and session-skip semantics', () => {
    expect(CONDA_ENV_NOTICE).toBe(
      '安装包不包含 conda 环境 lsci / lsci-r。可在本页一键下载 micromamba 并创建。',
    );
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true, view: 'settings' })).toBe(
      false,
    );
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: false, view: 'chat' })).toBe(
      true,
    );
  });
});
