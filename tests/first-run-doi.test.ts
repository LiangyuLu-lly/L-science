/**
 * 场景：零供应商点了「本次跳过」之后，文献仍能贴 DOI。
 *
 * 遮罩不再挡文献/断言；输入框才是唯一说不行的地方（no-model）。
 * 文献入库路径不看模型数。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composerBlockedReason } from '../packages/ui/src/lib/composer-gate.js';
import { shouldShowFirstRun } from '../packages/ui/src/lib/first-run.js';

describe('无密钥也能先贴 DOI', () => {
  it('跳过后遮罩不再挡文献和断言', () => {
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true, view: 'refs' })).toBe(
      false,
    );
    expect(shouldShowFirstRun({ providerCount: 0, skippedThisSession: true, view: 'claims' })).toBe(
      false,
    );
  });

  it('输入框在无模型时仍拒绝发送，有模型时放行', () => {
    const blocked = composerBlockedReason({
      backendState: 'ready',
      backendError: null,
      projectId: 'p1',
      conversationId: 'c1',
      enabledModelCount: 0,
    });
    expect(blocked?.code).toBe('no-model');
    expect(blocked?.message ?? '').not.toBe('');

    const open = composerBlockedReason({
      backendState: 'ready',
      backendError: null,
      projectId: 'p1',
      conversationId: 'c1',
      enabledModelCount: 1,
    });
    expect(open).toBeNull();
  });

  it('文献入库不看模型数，resolveRefs 路径仍在', () => {
    const refs = readFileSync(join('packages', 'ui', 'src', 'components', 'RefsView.tsx'), 'utf8');
    expect(refs).not.toMatch(/\benabledModelCount\b/);
    expect(refs).not.toMatch(/\bcomposerBlockedReason\b/);
    expect(refs).not.toMatch(/\bproviderCount\b/);
    expect(refs).toContain('resolveRefs');
  });

  it('App 把 no-model 的去登记动作接到输入框', () => {
    const app = readFileSync(join('packages', 'ui', 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('onRegisterModels');
    expect(app).toContain('composerBlockedReason(');
  });
});
