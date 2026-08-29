/**
 * 会话侧栏（任务 #10）。
 *
 * 计划、审查发现、子 agent 三块都是**会话内**的上下文，因此挂在聊天区旁边而不是
 * 各占一个顶层导航项。理由具体：顶层导航已有八项，再加三个只与当前会话有关的项，
 * 会让「哪些是全局设置、哪些是这次对话的状态」变得说不清；而它们与聊天内容需要
 * 对照着看——一条阻断级发现指的是刚才那段分析。
 *
 * ## 徽章是发现问题的唯一途径
 *
 * 侧栏可以折叠，所以标签上的徽章必须承担提醒职责：
 *
 * - 有草稿计划等批准 → 计划页签显示待批准数。不提醒的话用户会以为 agent 卡住了，
 *   而它在等他点批准。
 * - 有阻断级发现 → 审查页签显示数量并标红。FAIL 会打断 agent，用户不知道就会
 *   反复问「为什么它停了」。
 * - 有子 agent 在跑 → 子 agent 页签显示数量。
 *
 * 徽章数据来自轻量查询，与面板内容分开取：折叠状态下也要能算出徽章，否则折叠
 * 就等于关掉提醒。
 */

import { useCallback, useEffect, useState } from 'react';

import { listChildConversations, listFindings, listPlans, isBroadcastEvent } from '../lib/api.js';
import { subscribeEvents } from '../lib/backend.js';

import { FindingsPanel } from './FindingsPanel.js';
import { PlanPanel } from './PlanPanel.js';
import { SubAgentsPanel } from './SubAgentsPanel.js';

type TabId = 'plan' | 'findings' | 'subagents';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'plan', label: '计划' },
  { id: 'findings', label: '审查' },
  { id: 'subagents', label: '子 agent' },
];

interface Badges {
  draftPlans: number;
  blockingFindings: number;
  claimedFixed: number;
  runningAgents: number;
}

const EMPTY_BADGES: Badges = {
  draftPlans: 0,
  blockingFindings: 0,
  claimedFixed: 0,
  runningAgents: 0,
};

export interface ConversationSidebarProps {
  projectId: string | null;
  conversationId: string | null;
  onOpenConversation: (conversationId: string) => void;
}

export function ConversationSidebar({
  projectId,
  conversationId,
  onOpenConversation,
}: ConversationSidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<TabId>('plan');
  const [badges, setBadges] = useState<Badges>(EMPTY_BADGES);
  /** 自增计数器，用于让子面板重新取数据。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const loadBadges = useCallback(async (): Promise<void> => {
    if (projectId === null || conversationId === null) {
      setBadges(EMPTY_BADGES);
      return;
    }
    try {
      const [plans, findings, children] = await Promise.all([
        listPlans(projectId, conversationId, 20),
        listFindings(projectId, conversationId, { status: 'unresolved', limit: 500 }),
        listChildConversations(projectId, conversationId),
      ]);
      setBadges({
        draftPlans: plans.plans.filter((p) => p.status === 'draft').length,
        blockingFindings: findings.summary.blocking,
        claimedFixed: findings.summary.claimedFixed,
        runningAgents: children.children.filter((c) => c.running).length,
      });
    } catch {
      // 徽章取不到不该打断聊天。面板打开时会自己报错，那里有上下文能说清原因
      setBadges(EMPTY_BADGES);
    }
  }, [projectId, conversationId]);

  useEffect(() => {
    void loadBadges();
  }, [loadBadges, refreshKey]);

  /*
   * 按广播事件刷新，而不是定时轮询。
   *
   * `plan.created` / `plan.decided` / `finding.raised` / `reviewer.finished` 正好覆盖了
   * 这三块内容会变化的全部时机——审查是后台跑的，它出结果时用户可能正在看别的东西，
   * 所以必须由事件推过来。
   *
   * 用 `isBroadcastEvent` 而不是 `isTurnEvent`：后者是宽松判定（只看有没有字符串
   * kind），会把每一个流式文本分片都当成刷新信号，于是一次回复触发几百次请求。
   */
  useEffect(() => {
    const off = subscribeEvents((event) => {
      if (!isBroadcastEvent(event.payload)) return;
      const kind = event.payload.kind;
      if (
        kind === 'plan.created' ||
        kind === 'plan.decided' ||
        kind === 'finding.raised' ||
        kind === 'reviewer.finished'
      ) {
        setRefreshKey((k) => k + 1);
      }
    });
    return off;
  }, []);

  // 换会话时重置：上一个会话的徽章留在界面上会指向错误的对象
  useEffect(() => {
    setBadges(EMPTY_BADGES);
    setRefreshKey((k) => k + 1);
  }, [conversationId]);

  const badgeFor = (id: TabId): { count: number; urgent: boolean } | null => {
    if (id === 'plan') {
      return badges.draftPlans > 0 ? { count: badges.draftPlans, urgent: true } : null;
    }
    if (id === 'findings') {
      if (badges.blockingFindings > 0) {
        return { count: badges.blockingFindings, urgent: true };
      }
      return badges.claimedFixed > 0 ? { count: badges.claimedFixed, urgent: false } : null;
    }
    return badges.runningAgents > 0 ? { count: badges.runningAgents, urgent: false } : null;
  };

  const totalUrgent = badges.draftPlans + badges.blockingFindings;

  if (collapsed) {
    return (
      <aside className="convside convside--collapsed" aria-label="会话侧栏">
        <button
          type="button"
          className="convside__expand"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          title="展开计划、审查与子 agent"
        >
          <span className="convside__expand-label">计划 · 审查</span>
          {/* 折叠状态下徽章是唯一的提醒途径，所以它必须还在 */}
          {totalUrgent > 0 && (
            <span className="convside__badge convside__badge--urgent">{totalUrgent}</span>
          )}
          {totalUrgent === 0 && badges.runningAgents > 0 && (
            <span className="convside__badge">{badges.runningAgents}</span>
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="convside" aria-label="会话侧栏">
      <div className="convside__head">
        <div className="convside__tabs" role="tablist" aria-label="会话上下文">
          {TABS.map((t) => {
            const badge = badgeFor(t.id);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`convside__tab ${tab === t.id ? 'is-current' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {badge !== null && (
                  <span
                    className={`convside__badge ${badge.urgent ? 'convside__badge--urgent' : ''}`}
                  >
                    {badge.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="convside__collapse"
          onClick={() => setCollapsed(true)}
          aria-expanded
          title="收起侧栏"
        >
          收起
        </button>
      </div>

      <div className="convside__body" role="tabpanel">
        {tab === 'plan' && (
          <PlanPanel
            projectId={projectId}
            conversationId={conversationId}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'findings' && (
          <FindingsPanel
            projectId={projectId}
            conversationId={conversationId}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'subagents' && (
          <SubAgentsPanel
            projectId={projectId}
            conversationId={conversationId}
            refreshKey={refreshKey}
            onOpenConversation={onOpenConversation}
          />
        )}
      </div>
    </aside>
  );
}
