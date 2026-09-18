/**
 * 会话视图（任务 9.1，需求 1.3、20.3.1）。
 *
 * 思考过程默认折叠：它对判断结论有用，但混在正文里会把答案埋掉。折叠而不是
 * 隐藏——需要审视推理过程时它必须能被找到，这正是「结论可追溯」的一部分。
 */

import { useEffect, useRef, useState } from 'react';

import type { ChatItem, ToolCallView } from '../lib/useTurn.js';
import { TASK_LABEL, type RoutingDecision, type TaskType, type Usage } from '../lib/api.js';
import { DecisionDetail } from './RoutingPanel.js';
import { ToolCard } from './ToolCard.js';

const ROLE_LABEL: Record<ChatItem['role'], string> = {
  user: '你',
  assistant: '助手',
  system: '系统',
};

const STOP_REASON_LABEL: Record<string, string> = {
  'end-turn': '正常结束',
  'max-turns': '达到回合上限',
  interrupted: '已中断',
  error: '出错',
  'content-filter': '内容安全拒答',
  'no-model': '没有可用模型',
};

function formatCost(usage: Usage): string {
  return `${String(usage.tokensIn)} in / ${String(usage.tokensOut)} out · $${usage.cost.toFixed(6)}`;
}

/** 系统消息：回合摘要与后台通知。 */
function SystemItem({ item }: { item: ChatItem }): React.JSX.Element {
  const system = item.system;

  if (system?.kind === 'turn-summary') {
    const stopReason = String(system.stopReason ?? '');
    const detail = system.detail === null ? null : String(system.detail ?? '');
    // 「达到回合上限」必须显眼：它意味着任务没做完，而用户很容易以为做完了
    const severe = stopReason === 'max-turns' || stopReason === 'error';

    return (
      <div className={`msg msg--system ${severe ? 'msg--warn' : ''}`} role="note">
        <span className="msg__system-kind">{STOP_REASON_LABEL[stopReason] ?? stopReason}</span>
        <span className="msg__system-meta">
          {String(system.turns ?? 0)} 轮模型调用，{String(system.toolCalls ?? 0)} 次工具调用
        </span>
        {detail !== null && detail !== '' && <p className="msg__system-detail">{detail}</p>}
      </div>
    );
  }

  if (system?.kind === 'background-notice') {
    return (
      <div className="msg msg--system" role="note">
        <span className="msg__system-kind">后台任务完成</span>
        <span className="msg__system-meta">
          {String(system.label ?? '')} · {String(system.durationMs ?? 0)} ms
        </span>
        <pre className="msg__system-detail">{String(system.text ?? '')}</pre>
      </div>
    );
  }

  /*
   * 审查阻断（需求 11.5）。
   *
   * 用 role="alert" 而不是 note：它意味着当前结论不成立，而且可能刚刚打断了一个
   * 正在跑的回合。落到默认分支的话它长得和一条普通系统提示一样，用户会划过去。
   */
  if (system?.kind === 'reviewer-block') {
    return (
      <div className="msg msg--system msg--warn" role="alert">
        <span className="msg__system-kind">独立审查：阻断级发现</span>
        <pre className="msg__system-detail">{String(system.text ?? '')}</pre>
      </div>
    );
  }

  return (
    <div className="msg msg--system" role="note">
      {item.text}
    </div>
  );
}

function MessageItem({ item }: { item: ChatItem }): React.JSX.Element {
  if (item.role === 'system') return <SystemItem item={item} />;

  return (
    <article className={`msg msg--${item.role}`}>
      <header className="msg__head">
        <span className="msg__role">{ROLE_LABEL[item.role]}</span>
        {item.modelId !== null && <span className="msg__model">{item.modelId}</span>}
        {item.usage !== null && <span className="msg__usage">{formatCost(item.usage)}</span>}
      </header>

      {item.thinking !== '' && (
        <details className="msg__thinking">
          {/* 折叠而不是隐藏：审视推理过程是「结论可追溯」的一部分 */}
          <summary>思考过程（{item.thinking.length} 字）</summary>
          <pre>{item.thinking}</pre>
        </details>
      )}

      <div className="msg__body">
        {item.text}
        {/* 流入中显示光标，让「正在输出」与「输出为空」区分开 */}
        {item.streaming && <span className="msg__cursor" aria-hidden="true" />}
      </div>
    </article>
  );
}

/**
 * 路由决策卡片（需求 7.6）。
 *
 * 详情部分复用路由面板里的 `DecisionDetail`：同一次决策在会话流与决策面板里
 * 显示不同的信息量，会让用户以为那是两件不同的事，也会让「为什么不是第二名」
 * 这个问题在会话流里答不上来。
 */
function DecisionCard({ decision }: { decision: RoutingDecision }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="decision">
      <button
        type="button"
        className="decision__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="decision__task">
          {TASK_LABEL[decision.taskType as TaskType] ?? decision.taskType}
        </span>
        <span className="decision__model">{decision.chosenModelId ?? '无可用模型'}</span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="decision__detail">
          <DecisionDetail decision={decision} />
        </div>
      )}
    </div>
  );
}

export interface ChatViewProps {
  items: readonly ChatItem[];
  toolCalls: readonly ToolCallView[];
  decisions: readonly RoutingDecision[];
  running: boolean;
  blocked: boolean;
  blockedReason: string | null;
  onRegisterModels?: () => void;
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  /*
   * 只在用户已经贴着底部时才自动滚动。
   *
   * 无条件滚动会在用户往上翻看历史时把他拽回底部——长回复流入期间这个体验尤其
   * 糟糕，每来一个分片就被拽一次，完全无法阅读。
   */
  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ block: 'end' });
  }, [props.items, props.toolCalls, pinned]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < 80);
  };

  return (
    <div className="chat" ref={scroller} onScroll={onScroll}>
      {props.items.length === 0 && props.toolCalls.length === 0 && (
        <>
          <p className="chat__empty">
            {props.blocked
              ? (props.blockedReason ?? '还没有消息。')
              : '还没有消息。在下方输入框里说点什么。'}
          </p>
          {props.blocked && props.onRegisterModels !== undefined && (
            <button type="button" className="btn btn--small" onClick={props.onRegisterModels}>
              去登记模型
            </button>
          )}
        </>
      )}

      {props.decisions.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} />
      ))}

      {props.items.map((item) => (
        <MessageItem key={item.key} item={item} />
      ))}

      {props.toolCalls.map((call) => (
        <ToolCard key={call.callId} call={call} />
      ))}

      {props.running && (
        <p className="chat__running" role="status">
          正在处理…
        </p>
      )}

      {!pinned && (
        <button
          type="button"
          className="chat__jump"
          onClick={() => {
            setPinned(true);
            bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
          }}
        >
          回到最新
        </button>
      )}

      <div ref={bottom} />
    </div>
  );
}
