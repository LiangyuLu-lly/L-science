/**
 * 断言账本：每条必须能确认、核验、关闭、解绑，不能只是只读列表。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const VIEW = readFileSync(join('packages', 'ui', 'src', 'components', 'ClaimsView.tsx'), 'utf8');

describe('claims ledger view', () => {
  it('wires every claim action to its IPC method', () => {
    expect(VIEW).toContain('confirmClaim');
    expect(VIEW).toContain('verifyClaim');
    expect(VIEW).toContain('closeClaim');
    expect(VIEW).toContain('reopenClaim');
    expect(VIEW).toContain('unbindClaim');
    expect(VIEW).toContain('deleteClaim');
    expect(VIEW).toContain('onGoToRefs');
  });

  it('is not a bare read-only list', () => {
    expect(VIEW).toContain('rankClaims');
    expect(VIEW).toContain('role="alert"');
    expect(VIEW).toContain('err.message');
    expect(VIEW).toContain('去文献选一篇并抽断言');
    expect(VIEW).toContain('<button');
    expect(VIEW).toContain('确认删除');
    expect(VIEW).not.toContain('window.confirm');
    expect(VIEW).not.toContain('window.alert');
    expect(VIEW).toMatch(/className="ledger/);
  });
});
