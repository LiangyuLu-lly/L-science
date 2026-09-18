/**
 * 首次运行遮罩门闩。
 *
 * 只在「还没有任何供应商、且本会话没有点过稍后设置」时挡住。有供应商或
 * 已经跳过就不能再挡——否则配好模型的人每次打开都被拦，跳过的人没法进应用。
 */

import { describe, expect, it } from 'vitest';

import { CONDA_ENV_NOTICE, shouldShowFirstRun } from '../packages/ui/src/lib/first-run.js';

describe('shouldShowFirstRun', () => {
  it('shows overlay when no providers are registered and session was not skipped', () => {
    // Given: 全新安装，本会话还没点「稍后设置」
    const input = { providerCount: 0, skippedThisSession: false };

    // When
    const show = shouldShowFirstRun(input);

    // Then
    expect(show).toBe(true);
  });

  it('hides overlay when the user skipped setup this session', () => {
    // Given: 仍无供应商，但本会话已经跳过
    const input = { providerCount: 0, skippedThisSession: true };

    // When
    const show = shouldShowFirstRun(input);

    // Then
    expect(show).toBe(false);
  });

  it('hides overlay when at least one provider is already registered', () => {
    // Given: 注册表里已有供应商
    const input = { providerCount: 1, skippedThisSession: false };

    // When
    const show = shouldShowFirstRun(input);

    // Then
    expect(show).toBe(false);
  });

  it('hides overlay when providers exist even if skip is also set', () => {
    // Given: 两个条件都不满足「该显示」
    const input = { providerCount: 2, skippedThisSession: true };

    // When
    const show = shouldShowFirstRun(input);

    // Then
    expect(show).toBe(false);
  });

  it('keeps CONDA_ENV_NOTICE exact and session-skip semantics', () => {
    // Given / Then: 安装包不含环境这句必须原文；跳过只影响本会话门闩
    expect(CONDA_ENV_NOTICE).toBe('安装包不包含 conda 环境 lsci / lsci-r，需自行创建');
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true })).toBe(false);
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: false })).toBe(true);
  });
});
