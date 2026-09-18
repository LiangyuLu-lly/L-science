/**
 * 子 agent 面板（任务 #10，需求 10.5-10.7）。
 *
 * 子会话默认不出现在侧栏的会话列表里——五个并行子任务混进去之后用户找不到主线对话。
 * 但它们必须能被看到：并行跑着的子 agent 是「现在到底在做什么」的一部分答案。
 *
 * ## 一处必须如实说明的限制
 *
 * 后端只保留**未结束**子 agent 的运行句柄（`SubAgentRunner.list()` 过滤掉了已完成的）。
 * 句柄清理之后，`done` 与 `failed` 的区别就丢了，`SubAgentResult.summary` 只留在子会话
 * 的消息里。因此已结束的子 agent 在这里只能显示「已结束」，不能显示成功还是失败。
 *
 * 这一点写在界面上而不是隐藏：显示成「已完成」是撒谎（它可能是失败的），显示成
 * 空白会让用户以为数据没加载出来。要看结果就点进去读它的最后一条消息，面板直接
 * 提供这个入口。
 *
 * ## 为什么靠轮询
 *
 * 没有子 agent 生命周期的广播事件（没有 `subagent.started/finished`）。要么加事件，
 * 要么轮询。这里选轮询并且**只在面板可见时轮询**——加一类事件要动 backend 与
 * SubAgentRunner 两处，而这个面板的刷新精度要求本来就不高（子任务以分钟计）。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  listChildConversations,
  SUBAGENT_STATUS_LABEL,
  type ChildConversation,
} from '../lib/api.js';
import { conversationStatusLabel } from '../lib/conversation-status.js';
import { BackendError } from '../lib/backend.js';

function errorText(err: unknown): string {
  if (err instanceof BackendError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function durationText(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${String(s)} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} 分 ${String(s % 60)} 秒`;
  return `${String(Math.floor(m / 60))} 小时 ${String(m % 60)} 分`;
}

export interface SubAgentsPanelProps {
  projectId: string | null;
  conversationId: string | null;
  refreshKey: number;
  /** 打开某个子会话查看它做了什么。 */
  onOpenConversation: (conversationId: string) => void;
}

/** 面板可见时的轮询间隔。子任务以分钟计，5 秒足够而且不吵。 */
const POLL_MS = 5000;

export function SubAgentsPanel({
  projectId,
  conversationId,
  refreshKey,
  onOpenConversation,
}: SubAgentsPanelProps): React.JSX.Element {
  const [children, setChildren] = useState<ChildConversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (projectId === null || conversationId === null) {
      setChildren([]);
      return;
    }
    try {
      const result = await listChildConversations(projectId, conversationId);
      setChildren(result.children);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId, conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  /*
   * 只在有活跃子 agent 时轮询。
   *
   * 全部结束之后继续轮询是纯粹的浪费——列表不会再变了。这也让「面板开着但没事发生」
   * 的常见情形下完全不发请求。
   */
  const hasRunning = children.some((c) => c.running);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  if (projectId === null || conversationId === null) {
    return <p className="sidepanel__hint">先选一个会话。</p>;
  }

  if (loaded && children.length === 0) {
    return (
      <p className="sidepanel__hint">
        这个会话没有派出子 agent。复杂任务里 agent 会用 <code>delegate</code> 把可并行的
        子任务分出去；简单任务不需要。
      </p>
    );
  }

  const running = children.filter((c) => c.running);

  return (
    <div className="subpanel">
      {error !== null && (
        <p className="sidepanel__error" role="alert">
          {error}
        </p>
      )}

      {running.length > 0 && (
        <p className="subpanel__running" role="status">
          {running.length} 个子 agent 正在跑
          {running.some((c) => c.blocking === false) && (
            <span className="subpanel__note">
              {/* 阻塞与非阻塞在中断语义上不同，这一点必须说出来 */}
              其中有非阻塞的：中断当前回合不会停掉它们
            </span>
          )}
        </p>
      )}

      <ul className="subpanel__list">
        {children.map((child) => (
          <li key={child.id} className={`subrow ${child.running ? 'is-running' : ''}`}>
            <div className="subrow__head">
              <span
                className={`subrow__status subrow__status--${child.running ? (child.agentStatus ?? 'running') : 'ended'}`}
              >
                {child.running
                  ? SUBAGENT_STATUS_LABEL[child.agentStatus ?? 'running']
                  : /*
                     * 已结束的只能说「已结束」。
                     *
                     * 后端只保留未结束子 agent 的句柄，清理之后 done 与 failed 的区别
                     * 就丢了。显示成「已完成」是撒谎——它可能是失败的。
                     */
                    '已结束'}
              </span>
              <span className="subrow__title">{child.title ?? child.agentId ?? child.id}</span>
              {child.blocking === true && (
                <span className="subrow__badge" title="用户中断当前回合时会一并取消它">
                  阻塞式
                </span>
              )}
              {child.blocking === false && (
                <span className="subrow__badge" title="中断当前回合不影响它">
                  非阻塞
                </span>
              )}
            </div>

            <p className="subrow__meta">
              {child.agentId === null ? '' : <code>{child.agentId}</code>} 起于{' '}
              {timeText(child.createdAt)} · 活跃 {durationText(child.createdAt, child.updatedAt)}
              {child.status !== 'idle' && ` · ${conversationStatusLabel(child.status)}`}
            </p>

            <div className="subrow__actions">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => onOpenConversation(child.id)}
              >
                查看它做了什么
              </button>
              {!child.running && (
                <span className="subrow__hint">
                  {/* 给出可操作的替代路径，而不是只说「拿不到」 */}
                  成功与否要看它的最后一条消息
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
