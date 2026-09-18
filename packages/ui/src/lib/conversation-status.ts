/**
 * 会话状态的中文标签。
 *
 * 英文枚举是 SQLite CHECK / IPC 的稳定值，不能改。界面必须走这张表，
 * 否则侧栏会把 awaiting_user_input 这种内部标识直接亮给用户。
 */

import type { ConversationStatus } from './api.js';

export const CONVERSATION_STATUS_LABEL = {
  idle: '空闲',
  planning: '规划中',
  executing: '执行中',
  reviewing: '审查中',
  awaiting_approval: '等待批准',
  awaiting_user_input: '等待你的回复',
  background_pending: '后台进行中',
} as const satisfies Record<ConversationStatus, string>;

export function conversationStatusLabel(status: ConversationStatus): string {
  return CONVERSATION_STATUS_LABEL[status];
}
