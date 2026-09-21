/**
 * 首次运行遮罩门闩。
 *
 * 无模型时会话应当挡住——除非用户已经明确跳过。跳过后文献/断言/手稿必须可用，
 * 否则一个还没买密钥的人连 DOI 都贴不进来。常驻提醒由输入框的 no-model 分支承担。
 */

import { describe, expect, it } from 'vitest';

import { CONDA_ENV_NOTICE, shouldShowFirstRun } from '../packages/ui/src/lib/first-run.js';

describe('shouldShowFirstRun', () => {
  it('shows overlay when no providers are registered and session was not skipped', () => {
    const input = { providerCount: 0, skippedThisSession: false, view: 'refs' };
    expect(shouldShowFirstRun(input)).toBe(true);
  });

  it('respects session skip: 文献 must work without a key', () => {
    // 没有密钥的人也可能要先贴 DOI 建库。模态遮罩反复弹回来会把他拦在门外
    const input = { providerCount: 0, skippedThisSession: true, view: 'refs' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('respects session skip on every paper-path view', () => {
    for (const view of ['refs', 'claims', 'manuscripts', 'assistant']) {
      expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true, view })).toBe(false);
    }
  });

  it('hides overlay on settings even without skip', () => {
    const input = { providerCount: 0, skippedThisSession: false, view: 'settings' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('hides overlay when at least one provider is already registered', () => {
    const input = { providerCount: 1, skippedThisSession: false, view: 'refs' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('hides overlay when providers exist even if skip is also set', () => {
    const input = { providerCount: 2, skippedThisSession: true, view: 'refs' };
    expect(shouldShowFirstRun(input)).toBe(false);
  });

  it('a skip alone can never bring the overlay back', () => {
    // 重新打开入口必须是显式动作（输入框「去登记模型」会清掉 skip 标记），
    // 而不是遮罩自己回来。这里钉住「skip 只减不增」的性质。
    const views = ['refs', 'claims', 'manuscripts', 'assistant', 'artifacts', 'skills'];
    for (const view of views) {
      expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true, view })).toBe(false);
    }
  });

  it('keeps CONDA_ENV_NOTICE exact and the no-skip contract', () => {
    expect(CONDA_ENV_NOTICE).toBe(
      '安装包不包含 conda 环境 lsci / lsci-r。可在本页一键下载 micromamba 并创建。',
    );
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: false, view: 'refs' })).toBe(
      true,
    );
  });
});
