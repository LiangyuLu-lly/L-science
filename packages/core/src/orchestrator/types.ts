/**
 * 编排器的类型与状态机（任务 8.5.1）。
 *
 * 编排器是唯一有权发起模型调用与工具调用的组件。这个约束不是洁癖：模型调用要
 * 计费、要走路由、要记用量；工具调用要过审批、要落血缘。散落在各处发起就意味着
 * 这些横切关注点必然有地方被漏掉，而漏掉的症状是「有些调用没进用量统计」这类
 * 事后才发现、且无法回溯补齐的问题。
 */

import type { ConversationStatus } from '../repo/conversations.js';

/**
 * 状态迁移表。
 *
 * 显式列出而不是靠散落的赋值：状态机的价值全在「哪些迁移不允许」上，而那件事
 * 只有集中写出来才看得见。散落赋值的代码里，`status = 'idle'` 出现在十几处，
 * 没有任何一处能回答「executing 能不能直接跳到 idle」。
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ConversationStatus, readonly ConversationStatus[]>
> = {
  idle: ['planning', 'executing'],
  // planning 目前是过渡态，M1 没有独立的规划阶段，留着以免后续加计划时改状态机
  planning: ['executing', 'idle'],
  executing: [
    'awaiting_approval',
    'awaiting_user_input',
    'background_pending',
    'reviewing',
    'idle',
  ],
  // 三个挂起态都只能回到 executing 或直接结束（被中断时）
  awaiting_approval: ['executing', 'idle'],
  awaiting_user_input: ['executing', 'idle'],
  background_pending: ['executing', 'idle'],
  reviewing: ['idle', 'executing'],
};

export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  // 同态到同态视为允许：重复设置同一状态是幂等的，报错只会让调用方
  // 到处写「先判断当前是不是已经是目标态」
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: ConversationStatus, to: ConversationStatus) {
    super(
      `不允许的状态迁移：${from} → ${to}。允许的目标状态：${ALLOWED_TRANSITIONS[from].join('、')}。`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/** 会话正忙时拒绝新的回合。 */
export class ConversationBusyError extends Error {
  readonly status: ConversationStatus;

  constructor(conversationId: string, status: ConversationStatus) {
    super(
      `会话 ${conversationId} 当前状态为 ${status}，无法开始新回合。` +
        (status === 'awaiting_approval'
          ? '有待处理的审批，请先决议。'
          : status === 'awaiting_user_input'
            ? '有待回答的提问，请先作答。'
            : '请等它完成，或先中断。'),
    );
    this.name = 'ConversationBusyError';
    this.status = status;
  }
}

/**
 * 回合结束的原因。
 *
 * `max-turns` 与 `end-turn` 必须区分：前者说明任务**没做完**，只是撞了上限。
 * 合成一种会让用户以为 agent 认为自己完成了，而实际上它还在中途。
 */
export type TurnStopReason =
  'end-turn' | 'max-turns' | 'interrupted' | 'error' | 'content-filter' | 'no-model';

export interface TurnSummary {
  stopReason: TurnStopReason;
  /** 实际执行的模型调用轮数。 */
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  currency: string;
  /** 停止原因需要额外说明时的文本。 */
  detail: string | null;
}
