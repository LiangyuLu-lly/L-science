/**
 * 会话视图（任务 9.1，需求 1.3、20.3.1）。
 *
 * 思考过程默认折叠：它对判断结论有用，但混在正文里会把答案埋掉。折叠而不是
 * 隐藏——需要审视推理过程时它必须能被找到，这正是「结论可追溯」的一部分。
 */

import { useEffect, useRef, useState } from 'react';

import type { ChatItem, ToolCallView } from '../lib/useTurn.js';
import type { RoutingDecision, Usage } from '../lib/api.js';
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

/** 路由决策的可解释展示（需求 7.6、任务 11.11 的最小版）。 */
function DecisionCard({ decision }: { decision: RoutingDecision }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const winner = decision.scores[0];

  return (
    <div className="decision">
      <button
        type="button"
        className="decision__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="decision__task">{decision.taskType}</span>
        <span className="decision__model">{decision.chosenModelId ?? '无可用模型'}</span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="decision__detail">
          <p className="decision__reason">{decision.reason}</p>

          {winner !== undefined && (
            <table className="decision__scores">
              <caption>得分构成</caption>
              <thead>
                <tr>
                  <th scope="col">项</th>
                  <th scope="col">值</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(winner.breakdown).map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {decision.excluded.length > 0 && (
            <section className="decision__excluded">
              <h4>被排除的模型</h4>
              <ul>
                {decision.excluded.map((e) => (
                  <li key={e.modelId}>
                    <code>{e.modelId}</code>：{e.reason}
                    {e.detail !== undefined && (
                      <span className="decision__excluded-detail">{e.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
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
        <p className="chat__empty">还没有消息。在下方输入框里说点什么。</p>
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
