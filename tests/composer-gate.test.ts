/**
 * 无模型时禁用输入区，以及空会话文案不能再邀请输入。
 *
 * 首次运行遮罩可以跳过，但跳过之后如果还没有任何供应商，发送只会得到
 * 「注册表为空」。把输入区关掉并给出「去登记模型」，比让用户发一条注定失败的消息更诚实。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composerBlockedReason } from '../packages/ui/src/lib/composer-gate.js';

describe('composer gate', () => {
  it('composerBlockedReason includes no-model when providerCount is 0', () => {
    // Given: 遮罩已跳过，控制平面就绪，项目和会话都在，但一个供应商都没有
    const input = {
      backendState: 'ready' as const,
      backendError: null,
      projectId: 'proj-1',
      conversationId: 'conv-1',
      providerCount: 0,
    };

    // When
    const reason = composerBlockedReason(input);

    // Then
    expect(reason?.code).toBe('no-model');
  });

  it('ChatView empty copy omits 说点什么 when blocked', () => {
    // Given: ChatView 源码（空状态文案写在组件里，不经过运行时渲染）
    const src = readFileSync(join('packages', 'ui', 'src', 'components', 'ChatView.tsx'), 'utf8');

    // When / Then: 阻塞时走 blocked / blockedReason，不能再无条件邀请「说点什么」
    expect(src).toMatch(/\bblocked\b/);
    expect(src).toMatch(/\bblockedReason\b/);
    expect(src).not.toMatch(/className="chat__empty">还没有消息。在下方输入框里说点什么。/u);
  });
});
