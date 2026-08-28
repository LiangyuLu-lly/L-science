/**
 * 应用外壳（任务 9.1-9.4）。
 *
 * 导航用 `<button>` 而不是 `<li>` 纯文本。原先的骨架里侧栏是不可聚焦的列表项，
 * `verify:ui` 报告可聚焦元素 0 个——意味着依赖键盘的用户完全无法切换视图。
 * 这是需求 20.5.2 的硬要求，不是可以留到以后的润色。
 */

import { useCallback, useEffect, useState } from 'react';

import { ApprovalCard } from './components/ApprovalCard.js';
import { ArtifactsView } from './components/ArtifactsView.js';
import { ChatView } from './components/ChatView.js';
import { IsolationBadge } from './components/IsolationBadge.js';
import { ToolsPanel } from './components/ToolsPanel.js';
import { TurnUsageBar, UsagePanel } from './components/UsagePanel.js';
import {
  answerQuestion,
  createConversation,
  decideApproval,
  listConversations,
  listProjects,
  type Conversation,
  type GrantScope,
  type Project,
} from './lib/api.js';
import { hasBackend } from './lib/backend.js';
import { useBackend } from './lib/useBackend.js';
import { useTurn } from './lib/useTurn.js';

type ViewId = 'chat' | 'artifacts' | 'usage' | 'tools' | 'settings';

const VIEWS: ReadonlyArray<{ id: ViewId; label: string; ready: boolean }> = [
  { id: 'chat', label: '会话', ready: true },
  { id: 'artifacts', label: 'Artifacts', ready: true },
  { id: 'usage', label: '用量与成本', ready: true },
  { id: 'tools', label: '工具与环境', ready: true },
  { id: 'settings', label: '设置', ready: false },
];

const STATE_LABEL: Record<string, string> = {
  connecting: '连接中',
  ready: '已连接',
  unavailable: '暂时不可用',
  'no-bridge': '未通过桌面外壳启动',
};

/** 提问卡片。与审批不同：它要的是一段信息，不是放行与否。 */
function QuestionCard({
  question,
  onAnswer,
}: {
  question: {
    id: string;
    kind: string;
    question: string;
    detail: string | null;
    choices: string[];
  };
  onAnswer: (answer: string) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (answer: string): Promise<void> => {
    setBusy(true);
    try {
      await onAnswer(answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="question" role="alertdialog" aria-label="助手的提问">
      <header className="question__head">
        <span className="question__kind">
          {question.kind === 'compute-config' ? '算力配置' : '提问'}
        </span>
      </header>
      <p className="question__text">{question.question}</p>
      {question.detail !== null && <pre className="question__detail">{question.detail}</pre>}

      {question.choices.length > 0 && (
        <div className="question__choices">
          {question.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="btn btn--small"
              onClick={() => void submit(choice)}
              disabled={busy}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      <form
        className="question__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value);
        }}
      >
        <label className="question__label" htmlFor={`q-${question.id}`}>
          {/* 有预设选项时也允许自由输入：预设常常漏掉用户真正想说的那个 */}
          {question.choices.length > 0 ? '或自己填写' : '你的回答'}
        </label>
        <input
          id={`q-${question.id}`}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn" disabled={busy}>
          回答
        </button>
      </form>
    </section>
  );
}

/** 输入区。Enter 发送，Shift+Enter 换行——写代码片段时需要多行。 */
function Composer({
  disabled,
  disabledReason,
  running,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  /**
   * 为什么不能输入。
   *
   * 必须给出真实原因。原先写死成「需要先连接控制平面」，但实际上后端连着、
   * 只是还没有会话——一条错的提示比没有提示更糟，用户会去排查一个不存在的问题。
   */
  disabledReason: string | null;
  running: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (text.trim() === '') return;
    onSend(text);
    setText('');
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="composer__label" htmlFor="composer-input">
        发送给助手
      </label>
      <textarea
        id="composer-input"
        className="composer__input"
        value={text}
        rows={3}
        placeholder={
          disabled
            ? (disabledReason ?? '当前不可输入')
            : '说说要做什么。Enter 发送，Shift+Enter 换行。'
        }
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__actions">
        {running ? (
          <button type="button" className="btn btn--deny" onClick={onInterrupt}>
            中断
          </button>
        ) : (
          <button type="submit" className="btn" disabled={disabled || text.trim() === ''}>
            发送
          </button>
        )}
      </div>
    </form>
  );
}

function BackendPanel(): React.JSX.Element {
  const { state, status, error, attempts, retryNow } = useBackend();

  return (
    <section className="panel" aria-labelledby="backend-heading">
      <h2 id="backend-heading" className="panel__title">
        控制平面
        <span className={`badge badge--${state}`} role="status">
          {STATE_LABEL[state] ?? state}
        </span>
      </h2>

      {status !== null && (
        <dl className="kv">
          <dt>数据目录</dt>
          <dd>
            <code>{status.dataDir}</code>
          </dd>
          <dt>SQLite</dt>
          <dd>
            {status.sqlite}（schema v{status.schema}）
          </dd>
          <dt>后端 Node</dt>
          <dd>
            {status.node}，pid {status.pid}
          </dd>
        </dl>
      )}

      {state === 'unavailable' && (
        <p className="panel__error">
          {error ?? '未知错误'}
          <button type="button" className="btn" onClick={retryNow}>
            立即重试
          </button>
          <span className="panel__hint">已尝试 {attempts} 次</span>
        </p>
      )}

      {state === 'no-bridge' && (
        <p className="panel__hint">当前在浏览器中直接打开了渲染层。控制平面只在桌面外壳内可用。</p>
      )}
    </section>
  );
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('chat');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const turn = useTurn(conversationId);
  // 连接状态放在头部而不是只在「工具与环境」页里。后端挂掉时对话会静默停止
  // 响应，如果状态藏在另一个标签页里，用户看到的只是「发了消息没反应」
  const backend = useBackend();

  /** 输入区不可用时的真实原因。写死一个理由会让用户去排查不存在的问题。 */
  const composerBlockedReason =
    backend.state === 'no-bridge'
      ? '当前在浏览器里直接打开了渲染层，控制平面只在桌面外壳内可用。'
      : backend.state === 'unavailable'
        ? `控制平面暂时不可用：${backend.error ?? '未知错误'}`
        : backend.state === 'connecting'
          ? '正在连接控制平面…'
          : projectId === null
            ? '还没有项目。请先创建一个项目。'
            : conversationId === null
              ? '正在准备会话…'
              : null;

  // 首次加载：取项目，自动选第一个。空白界面对新用户没有任何指引价值
  useEffect(() => {
    if (!hasBackend()) return;
    void listProjects().then((r) => {
      setProjects(r.projects);
      const first = r.projects[0];
      if (first !== undefined) setProjectId(first.id);
    });
  }, []);

  const reloadConversations = useCallback((pid: string) => {
    void listConversations(pid).then(async (r) => {
      // 没有会话时自动建一个。让新用户打开就能直接输入，而不是先去找「新建」
      // 按钮——空白界面加一个禁用的输入框，对第一次用的人毫无指引价值
      if (r.conversations.length === 0) {
        const { conversation } = await createConversation(pid);
        setConversations([conversation]);
        setConversationId(conversation.id);
        return;
      }
      setConversations(r.conversations);
      setConversationId(r.conversations[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (projectId !== null) reloadConversations(projectId);
  }, [projectId, reloadConversations]);

  const newConversation = async (): Promise<void> => {
    if (projectId === null) return;
    const { conversation } = await createConversation(projectId);
    setConversations((prev) => [conversation, ...prev]);
    setConversationId(conversation.id);
  };

  const onDecide = async (
    approvalId: string,
    decision: 'approve' | 'deny',
    options: { note?: string; scope?: GrantScope },
  ): Promise<void> => {
    await decideApproval(approvalId, decision, options);
    turn.dismissApproval(approvalId);
  };

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">L-science</span>
        <span className="app__tag">本地优先 AI 科研工作台</span>

        {projects.length > 0 && (
          <div className="app__project">
            <label className="app__project-label" htmlFor="project-select">
              项目
            </label>
            <select
              id="project-select"
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archivedAt === null ? '' : '（已归档）'}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* 连接状态常驻可见。文字标签与颜色并存，不只靠颜色 */}
        <span className={`badge badge--${backend.state}`} role="status">
          {STATE_LABEL[backend.state] ?? backend.state}
        </span>

        {/* 隔离强度持续可见，不藏在设置里（需求 2.5） */}
        <IsolationBadge />
      </header>

      <div className="app__body">
        {/*
          导航用 button 而不是 li 纯文本。原骨架的 li 不可聚焦，
          verify:ui 报告可聚焦元素 0 个——依赖键盘的用户无法切换视图
        */}
        <nav className="app__nav" aria-label="主导航">
          <ul>
            {VIEWS.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`nav__item ${view === v.id ? 'is-current' : ''} ${v.ready ? '' : 'is-pending'}`}
                  aria-current={view === v.id ? 'page' : undefined}
                  disabled={!v.ready}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                  {!v.ready && <span className="nav__pending">（待实现）</span>}
                </button>
              </li>
            ))}
          </ul>

          {view === 'chat' && (
            <div className="nav__conversations">
              <div className="nav__section-head">
                <h2>会话</h2>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void newConversation()}
                  disabled={projectId === null}
                >
                  新建
                </button>
              </div>
              <ul>
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`nav__conv ${conversationId === c.id ? 'is-current' : ''}`}
                      aria-current={conversationId === c.id ? 'true' : undefined}
                      onClick={() => setConversationId(c.id)}
                    >
                      <span className="nav__conv-title">{c.title ?? '未命名会话'}</span>
                      {c.status !== 'idle' && <span className="nav__conv-status">{c.status}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        <main className="app__main">
          {/* 审批与提问置顶：它们阻塞流程，埋在下面用户看不到 */}
          {turn.approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onDecide={(decision, options) => onDecide(approval.id, decision, options)}
            />
          ))}

          {turn.questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              onAnswer={async (answer) => {
                await answerQuestion(question.id, answer);
                turn.dismissQuestion(question.id);
              }}
            />
          ))}

          {view === 'chat' && (
            <>
              {turn.error !== null && (
                <p className="view__error" role="alert">
                  {turn.error}
                </p>
              )}
              <ChatView
                items={turn.items}
                toolCalls={turn.toolCalls}
                decisions={turn.decisions}
                running={turn.running}
              />
              {/* 本轮累计用量常驻在输入区上方（需求 18.4） */}
              <TurnUsageBar usage={turn.lastUsage} />
              <Composer
                disabled={composerBlockedReason !== null}
                disabledReason={composerBlockedReason}
                running={turn.running}
                onSend={(text) => void turn.send(text)}
                onInterrupt={() => void turn.interrupt()}
              />
            </>
          )}

          {view === 'artifacts' && <ArtifactsView projectId={projectId} />}

          {view === 'usage' && <UsagePanel projectId={projectId} conversationId={conversationId} />}

          {view === 'tools' && (
            <>
              <ToolsPanel projectId={projectId} />
              <BackendPanel />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
