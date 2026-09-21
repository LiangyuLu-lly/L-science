/**
 * 重开窗口后恢复未决审批（任务 14.5）。
 *
 * 源码契约，不是渲染快照。审批卡片今天只吃 `approval.request` 事件；
 * 刷新后卡片消失、后端仍在挂着。必须在控制平面就绪且已选会话时拉
 * `listPendingApprovals`，按 id 去重合并进同一份 `approvals` 状态。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = readFileSync(join('packages', 'ui', 'src', 'App.tsx'), 'utf8');
const TURN = readFileSync(join('packages', 'ui', 'src', 'lib', 'useTurn.ts'), 'utf8');

describe('pending approval restore', () => {
  it('useTurn calls listPendingApprovals', () => {
    // Given: 恢复路径写在回合 hook 里，与事件路径共用 approvals
    // When / Then
    expect(TURN).toContain('listPendingApprovals');
  });

  it('dedupes restored and event-path approvals by id', () => {
    // Given: 拉取与 approval.request 可能对同一 id 竞态
    // When / Then: 已在列表里的 id、已决议的 id 都不得再 push
    expect(TURN).toMatch(/approvals\.some\(\s*\(?a\)?\s*=>\s*a\.id ===/u);
    expect(TURN).toMatch(/dismissedApprovalIds/u);
    expect(TURN).toContain('approval.request');
  });

  it('App shows a non-fatal restore error and does not block first paint', () => {
    // Given: 恢复失败必须看得见，但不能挡住其余界面
    // When / Then
    expect(APP).toContain('restorePendingApprovals');
    expect(APP).toMatch(/backend\.state !== 'ready' \|\| conversationId === null/u);
    expect(APP).toMatch(/className="panel__error"/u);
    expect(APP).toMatch(/role="alert"/u);
    expect(APP).toContain('未能恢复未决审批列表，可能需要重新加载。');
    expect(APP).toMatch(/void turn\.restorePendingApprovals/u);
  });
});
