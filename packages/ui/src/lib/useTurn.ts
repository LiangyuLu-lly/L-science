/**
 * 回合状态 hook（任务 9.1、9.3）。
 *
 * 把后端推来的增量事件归并成可渲染的结构。核心难点是**事件是增量的而 UI 需要
 * 稳定的列表**：`text.delta` 一次来几个字符，直接 setState 会让 React 每来一个
 * 字符重渲染整个消息列表，长回复时明显卡顿。
 *
 * 处理办法是把增量累积在 ref 里，用 requestAnimationFrame 节流刷新——一帧内
 * 到达的多个分片合并成一次渲染。这样打字机效果保留，重渲染次数降到帧率上限。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeEvents } from './backend.js';
import {
  interruptConversation,
  isTurnEvent,
  loadHistory,
  sendMessage,
  type ApprovalRequest,
  type RoutingDecision,
  type StoredMessage,
  type ToolOutput,
  type TurnEvent,
  type Usage,
  type UserQuestion,
} from './api.js';

/** 渲染用的一条消息。与落库的 StoredMessage 不同：它包含正在流入的增量。 */
export interface ChatItem {
  key: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking: string;
  /** 是否仍在流入。UI 据此显示光标或「正在输入」。 */
  streaming: boolean;
  modelId: string | null;
  usage: Usage | null;
  /** 系统消息的结构化内容（回合摘要、后台通知）。 */
  system: { kind: string; [key: string]: unknown } | null;
}

export interface ToolCallView {
  callId: string;
  tool: string;
  input: unknown;
  output: ToolOutput | null;
  startedAt: number;
  endedAt: number | null;
}

export interface TurnState {
  items: ChatItem[];
  toolCalls: ToolCallView[];
  decisions: RoutingDecision[];
  approvals: ApprovalRequest[];
  questions: UserQuestion[];
  /** 回合是否在进行中。 */
  running: boolean;
  lastUsage: Usage | null;
  error: string | null;
}

const EMPTY: TurnState = {
  items: [],
  toolCalls: [],
  decisions: [],
  approvals: [],
  questions: [],
  running: false,
  lastUsage: null,
  error: null,
};

/** 从落库消息还原渲染结构。 */
function fromStored(message: StoredMessage): ChatItem | null {
  const content = message.content as { kind?: string; text?: string; thinking?: string } | null;

  if (message.role === 'tool') return null; // 工具结果单独渲染成卡片

  if (message.role === 'system') {
    return {
      key: message.id,
      role: 'system',
      text: typeof content?.text === 'string' ? content.text : '',
      thinking: '',
      streaming: false,
      modelId: null,
      usage: message.usage,
      system: (content as { kind: string } | null) ?? null,
    };
  }

  return {
    key: message.id,
    role: message.role,
    text: typeof content?.text === 'string' ? content.text : '',
    thinking: typeof content?.thinking === 'string' ? content.thinking : '',
    streaming: false,
    modelId: message.modelId,
    usage: message.usage,
    system: null,
  };
}

export interface UseTurn extends TurnState {
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  /** 从事件列表里移除已处理的审批/提问。决议本身由调用方发起。 */
  dismissApproval: (approvalId: string) => void;
  dismissQuestion: (questionId: string) => void;
  reload: () => Promise<void>;
}

export function useTurn(conversationId: string | null): UseTurn {
  const [state, setState] = useState<TurnState>(EMPTY);

  /**
   * 待刷新的状态。
   *
   * 增量事件先累积在这里，合并成一次 setState。直接对每个 text.delta setState
   * 会让长回复时每来几个字符就重渲染整个列表，明显卡顿。
   *
   * 初值刻意用展开而不是直接引用 EMPTY：EMPTY 是模块级对象，直接引用会让
   * 后续的 `items.push` 改到那个共享数组上，第二个会话挂载时就带着上一个会话
   * 的残留内容。
   */
  const pending = useRef<TurnState>({
    ...EMPTY,
    items: [],
    toolCalls: [],
    decisions: [],
    approvals: [],
    questions: [],
  });
  const frame = useRef<number | null>(null);
  const fallback = useRef<number | null>(null);
  const disposed = useRef(false);

  const clearScheduled = useCallback(() => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (fallback.current !== null) {
      window.clearTimeout(fallback.current);
      fallback.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    clearScheduled();
    if (disposed.current) return;
    // 浅拷贝顶层与数组，让 React 能识别变化；数组元素本身不变的部分复用引用
    setState({
      ...pending.current,
      items: [...pending.current.items],
      toolCalls: [...pending.current.toolCalls],
      decisions: [...pending.current.decisions],
      approvals: [...pending.current.approvals],
      questions: [...pending.current.questions],
    });
  }, [clearScheduled]);

  /**
   * 安排一次刷新。
   *
   * **同时挂 rAF 与定时器兜底，谁先到谁刷新。** 单靠 rAF 有一个实测确认的致命
   * 问题：窗口被遮挡或最小化时 `document.visibilityState` 变成 hidden，
   * rAF **完全不回调**（不是变慢，是停止）。此时事件会一直堆在 pending 里，
   * 界面彻底冻结——用户切到别的窗口再回来，才发现刚才什么都没渲染，
   * 期间连「正在处理」的指示都不会出现。
   *
   * 定时器在后台会被 Chromium 节流到约 1 秒一次，但它**会**回调。用户没在看的
   * 时候慢一点无所谓，看不到任何进展才是问题。
   */
  const schedule = useCallback(() => {
    if (disposed.current) return;
    if (frame.current !== null || fallback.current !== null) return;

    frame.current = window.requestAnimationFrame(flush);
    fallback.current = window.setTimeout(flush, 100);
  }, [flush]);

  /** 全新的空状态。每次都新建，避免共享 EMPTY 的数组被就地修改。 */
  const freshState = useCallback(
    (items: ChatItem[] = []): TurnState => ({
      items,
      toolCalls: [],
      decisions: [],
      approvals: [],
      questions: [],
      running: false,
      lastUsage: null,
      error: null,
    }),
    [],
  );

  const reload = useCallback(async () => {
    if (conversationId === null) {
      pending.current = freshState();
      schedule();
      return;
    }

    try {
      const { page } = await loadHistory(conversationId);
      // 后端按 seq 倒序返回，渲染要正序
      const ordered = [...page.messages].sort((a, b) => a.seq - b.seq);
      pending.current = freshState(
        ordered.map(fromStored).filter((i): i is ChatItem => i !== null),
      );
      schedule();
    } catch (err) {
      pending.current.error = err instanceof Error ? err.message : String(err);
      schedule();
    }
  }, [conversationId, schedule, freshState]);

  /** 处理一个回合事件。全部改动落在 pending 上，由 rAF 合并刷新。 */
  const apply = useCallback(
    (event: TurnEvent) => {
      const next = pending.current;

      switch (event.kind) {
        case 'text.delta':
        case 'thinking.delta': {
          const last = next.items.at(-1);
          const field = event.kind === 'text.delta' ? 'text' : 'thinking';

          if (last !== undefined && last.role === 'assistant' && last.streaming) {
            // 原地累积而不是新建对象：一次长回复会来几百个分片，
            // 每片都新建对象会给 GC 造成不必要的压力
            last[field] += event.text;
          } else {
            next.items.push({
              key: `streaming-${String(next.items.length)}-${String(Date.now())}`,
              role: 'assistant',
              text: field === 'text' ? event.text : '',
              thinking: field === 'thinking' ? event.text : '',
              streaming: true,
              modelId: null,
              usage: null,
              system: null,
            });
          }
          break;
        }

        case 'tool.start': {
          next.toolCalls.push({
            callId: event.callId,
            tool: event.tool,
            input: event.input,
            output: null,
            startedAt: Date.now(),
            endedAt: null,
          });
          break;
        }

        case 'tool.output': {
          const call = next.toolCalls.find((c) => c.callId === event.callId);
          if (call !== undefined) {
            call.output = event.output;
            call.endedAt = Date.now();
          } else {
            // 后台任务的通知没有对应的 tool.start（它是上一个回合发起的）。
            // 补一条卡片而不是丢弃——用户需要看到结果
            next.toolCalls.push({
              callId: event.callId,
              tool: '后台任务',
              input: null,
              output: event.output,
              startedAt: Date.now(),
              endedAt: Date.now(),
            });
          }
          break;
        }

        case 'routing.decision': {
          next.decisions.push(event.decision);
          break;
        }

        case 'approval.request': {
          next.approvals.push(event.approval);
          break;
        }

        case 'question.request': {
          next.questions.push(event.question);
          break;
        }

        case 'turn.end': {
          next.lastUsage = event.usage;
          next.running = false;
          // 流式条目定型：不再显示光标
          for (const item of next.items) item.streaming = false;
          break;
        }
      }

      schedule();
    },
    [schedule],
  );

  useEffect(() => {
    disposed.current = false;
    void reload();

    const off = subscribeEvents((event) => {
      if (!isTurnEvent(event.payload)) return;
      apply(event.payload);
    });

    return () => {
      disposed.current = true;
      clearScheduled();
      off();
    };
  }, [conversationId, reload, apply, clearScheduled]);

  const send = useCallback(
    async (text: string) => {
      if (conversationId === null || text.trim() === '') return;

      // 用户消息立即出现在界面上，不等后端确认。它已经在后端同步落库了
      // （startTurn 的副作用是同步的），因此这里不是乐观更新而是反映事实
      pending.current.items.push({
        key: `user-${String(Date.now())}`,
        role: 'user',
        text,
        thinking: '',
        streaming: false,
        modelId: null,
        usage: null,
        system: null,
      });
      pending.current.running = true;
      pending.current.error = null;
      schedule();

      try {
        await sendMessage(conversationId, text);
      } catch (err) {
        pending.current.running = false;
        pending.current.error = err instanceof Error ? err.message : String(err);
        schedule();
      }
    },
    [conversationId, schedule],
  );

  const interrupt = useCallback(async () => {
    if (conversationId === null) return;
    try {
      await interruptConversation(conversationId);
    } catch {
      // 中断失败通常意味着回合已经结束，不必打扰用户
    }
  }, [conversationId]);

  const dismissApproval = useCallback(
    (approvalId: string) => {
      pending.current.approvals = pending.current.approvals.filter((a) => a.id !== approvalId);
      schedule();
    },
    [schedule],
  );

  const dismissQuestion = useCallback(
    (questionId: string) => {
      pending.current.questions = pending.current.questions.filter((q) => q.id !== questionId);
      schedule();
    },
    [schedule],
  );

  return { ...state, send, interrupt, dismissApproval, dismissQuestion, reload };
}
