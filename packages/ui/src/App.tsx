/**
 * 应用外壳（任务 9.1-9.4）。
 *
 * 导航用 `<button>` 而不是 `<li>` 纯文本。原先的骨架里侧栏是不可聚焦的列表项，
 * `verify:ui` 报告可聚焦元素 0 个——意味着依赖键盘的用户完全无法切换视图。
 * 这是需求 20.5.2 的硬要求，不是可以留到以后的润色。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApprovalCard } from './components/ApprovalCard.js';
import { ArtifactsView } from './components/ArtifactsView.js';
import { ChatView } from './components/ChatView.js';
import { ClaimsView } from './components/ClaimsView.js';
import { ConnectorsView } from './components/ConnectorsView.js';
import { ManuscriptsView } from './components/ManuscriptsView.js';
import { RefsView } from './components/RefsView.js';
import { ConversationSidebar } from './components/ConversationSidebar.js';
import { FirstRunOverlay } from './components/FirstRunOverlay.js';
import { ProjectHeader } from './components/ProjectHeader.js';
import { RoutingPanel } from './components/RoutingPanel.js';
import { SettingsView } from './components/SettingsView.js';
import { SelectedSkills, SkillPicker } from './components/SkillPicker.js';
import { SkillsView } from './components/SkillsView.js';
import { TaskTypeChips } from './components/TaskTypeChips.js';
import { ToolsPanel } from './components/ToolsPanel.js';
import { TurnUsageBar, UsagePanel } from './components/UsagePanel.js';
import {
  answerQuestion,
  createConversation,
  createProject,
  decideApproval,
  listConversations,
  listProjects,
  listProviders,
  TASK_LABEL,
  type Conversation,
  type GrantScope,
  type Project,
  type RoutingOverride,
  type TaskType,
} from './lib/api.js';
import { hasBackend } from './lib/backend.js';
import { composerBlockedReason } from './lib/composer-gate.js';
import { conversationStatusLabel } from './lib/conversation-status.js';
import { shouldShowFirstRun } from './lib/first-run.js';
import { useBackend } from './lib/useBackend.js';
import { useTurn } from './lib/useTurn.js';

type ViewId =
  | 'chat'
  | 'refs'
  | 'claims'
  | 'manuscripts'
  | 'artifacts'
  | 'routing'
  | 'usage'
  | 'tools'
  | 'skills'
  | 'connectors'
  | 'settings';

const VIEWS: ReadonlyArray<{ id: ViewId; label: string; ready: boolean }> = [
  { id: 'chat', label: '会话', ready: true },
  { id: 'refs', label: '文献', ready: true },
  { id: 'claims', label: '断言', ready: true },
  { id: 'manuscripts', label: '手稿', ready: true },
  { id: 'artifacts', label: '制品', ready: true },
  { id: 'routing', label: '模型路由', ready: true },
  { id: 'usage', label: '用量与成本', ready: true },
  { id: 'tools', label: '工具与环境', ready: true },
  { id: 'skills', label: '技能', ready: true },
  { id: 'connectors', label: '连接器', ready: true },
  { id: 'settings', label: '设置', ready: true },
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

/**
 * 从输入内容与光标位置判断当前是否在打 `/` 命令。
 *
 * 返回 `/` 之后到光标之间的文本，不在命令里时返回 null。
 *
 * `/` 只在**行首或空白之后**触发。句子中间的斜杠是路径（`D:/data`）、日期
 * （`2026/07/31`）与单位（`mg/kg`），把它们都当命令会让输入框在正常打字时
 * 不停弹窗，而那是这类功能最常见的失败方式。
 */
function detectSlashQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const slash = before.lastIndexOf('/');
  if (slash === -1) return null;

  const prev = slash === 0 ? '' : before[slash - 1];
  if (prev !== '' && prev !== undefined && !/\s/.test(prev)) return null;

  const query = before.slice(slash + 1);
  // 命令词里不允许空白与换行：打完技能名继续写句子时选择器应当自动关闭
  if (/[\s\n]/.test(query)) return null;
  return query;
}

/** 输入区。Enter 发送，Shift+Enter 换行——写代码片段时需要多行。 */
function Composer({
  disabled,
  disabledReason,
  running,
  onSend,
  onInterrupt,
  onRegisterModels,
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
  onSend: (text: string, skills: readonly string[]) => void;
  onInterrupt: () => void;
  onRegisterModels?: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillNames, setSkillNames] = useState<Map<string, string>>(new Map());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const slashQuery = pickerOpen ? detectSlashQuery(text, caret) : null;

  const submit = (): void => {
    if (text.trim() === '') return;
    onSend(text, skills);
    setText('');
    setCaret(0);
    // 技能选择是一次性的，与路由覆盖同一个取舍：留着会让下一条消息意外带上它们
    setSkills([]);
    setPickerOpen(false);
  };

  /** 选中一个技能：记进标签条，并把输入里的 `/xxx` 片段删掉。 */
  const pickSkill = (hit: { slug: string; name: string }): void => {
    setSkills((prev) => (prev.includes(hit.slug) || prev.length >= 5 ? prev : [...prev, hit.slug]));
    setSkillNames((prev) => new Map(prev).set(hit.slug, hit.name));

    const before = text.slice(0, caret);
    const slash = before.lastIndexOf('/');
    if (slash !== -1) {
      const next = before.slice(0, slash) + text.slice(caret);
      setText(next);
      setCaret(slash);
      // 焦点必须还回输入框：不还的话用户插入技能之后要用鼠标再点一次才能继续打字
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(slash, slash);
      });
    }
    setPickerOpen(false);
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

      <SelectedSkills
        slugs={skills}
        names={skillNames}
        onRemove={(slug) => setSkills((prev) => prev.filter((s) => s !== slug))}
      />

      <div className="composer__field">
        {slashQuery !== null && (
          <SkillPicker
            query={slashQuery}
            selected={skills}
            onPick={pickSkill}
            onClose={() => {
              setPickerOpen(false);
              inputRef.current?.focus();
            }}
          />
        )}
        <textarea
          id="composer-input"
          ref={inputRef}
          className="composer__input"
          value={text}
          rows={3}
          placeholder={
            disabled
              ? (disabledReason ?? '当前不可输入')
              : '说说要做什么。Enter 发送，Shift+Enter 换行，/ 插入技能。'
          }
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            // 只有刚打出 `/` 才开选择器；已经开着时由 detectSlashQuery 决定是否继续
            const q = detectSlashQuery(e.target.value, e.target.selectionStart);
            if (q !== null && (pickerOpen || q === '')) setPickerOpen(true);
            else if (q === null) setPickerOpen(false);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            // 选择器开着时把 Enter 与方向键让给它（它在 window 的 capture 阶段处理）
            if (
              slashQuery !== null &&
              ['Enter', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)
            ) {
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="composer__actions">
        {running ? (
          <button type="button" className="btn btn--deny" onClick={onInterrupt}>
            中断
          </button>
        ) : (
          <>
            {onRegisterModels !== undefined && (
              <button type="button" className="btn" onClick={onRegisterModels}>
                去登记模型
              </button>
            )}
            <button type="submit" className="btn" disabled={disabled || text.trim() === ''}>
              发送
            </button>
          </>
        )}
      </div>
    </form>
  );
}

/**
 * 生效中的路由覆盖提示条。
 *
 * 覆盖是在另一个视图里设的，切回会话后如果界面上毫无痕迹，用户就会以为路由
 * 还是自动的，然后对「怎么选了这个模型」感到莫名——尤其是强制指定模型这种
 * 会改变成本的设置。
 */
function OverrideBar({
  override,
  onClear,
  onOpenSettings,
}: {
  override: RoutingOverride;
  onClear: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element | null {
  const parts: string[] = [];
  if (override.forcedModelId !== undefined) parts.push(`强制用 ${override.forcedModelId}`);
  if (override.taskType !== undefined) {
    parts.push(`任务按「${TASK_LABEL[override.taskType as TaskType] ?? override.taskType}」`);
  }
  if (override.weightOverrides !== undefined) parts.push('自定义权重');
  if (override.preferLocal === true) parts.push('优先本机');
  if (override.requireTrainingOptOut === true) parts.push('仅不做训练的模型');
  if (override.costBudget !== undefined) parts.push(`成本上限 ${String(override.costBudget)}`);
  if (override.latencyBudgetMs !== undefined) {
    parts.push(`延迟上限 ${String(override.latencyBudgetMs)}ms`);
  }

  if (parts.length === 0) return null;

  return (
    <p className="obar" role="status">
      <span className="obar__label">下一条消息的路由覆盖</span>
      <span className="obar__items">{parts.join('　·　')}</span>
      <button type="button" className="btn btn--small" onClick={onOpenSettings}>
        调整
      </button>
      <button type="button" className="btn btn--small btn--deny" onClick={onClear}>
        取消覆盖
      </button>
    </p>
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
  /**
   * 下一条消息的路由覆盖（需求 7.14）。
   *
   * 放在 App 而不是路由面板里：设置发生在路由面板，发送发生在会话视图，两处
   * 必须看到同一份状态。发送后清空——按回合而不是按会话，否则用户改一次就得
   * 记得改回来，忘了会在后续几十次廉价调用上一直付高价。
   */
  const [routingOverride, setRoutingOverride] = useState<RoutingOverride>({});
  const [providerCount, setProviderCount] = useState<number | null>(null);
  const [skippedThisSession, setSkippedThisSession] = useState(false);
  const [overlayForced, setOverlayForced] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const turn = useTurn(conversationId);
  // 连接状态放在头部而不是只在「工具与环境」页里。后端挂掉时对话会静默停止
  // 响应，如果状态藏在另一个标签页里，用户看到的只是「发了消息没反应」
  const backend = useBackend();

  const refreshProviderCount = useCallback(() => {
    void listProviders().then((result) => {
      setProviderCount(result.providers.length);
    });
  }, []);

  useEffect(() => {
    if (backend.state !== 'ready') return;
    refreshProviderCount();
  }, [backend.state, refreshProviderCount]);

  const showFirstRun =
    overlayForced ||
    (providerCount !== null &&
      shouldShowFirstRun({ providerCount, skippedThisSession, view }));

  /** 输入区不可用时的真实原因。写死一个理由会让用户去排查不存在的问题。 */
  const composerBlock = composerBlockedReason({
    backendState: backend.state,
    backendError: backend.error,
    projectId,
    conversationId,
    providerCount,
  });
  const openRegisterModels = (): void => {
    setSkippedThisSession(false);
    setOverlayForced(true);
  };

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

  const newProject = async (): Promise<void> => {
    const { project } = await createProject('未命名项目');
    setProjects((prev) => [project, ...prev]);
    setProjectId(project.id);
  };

  const onDecide = async (
    approvalId: string,
    decision: 'approve' | 'deny',
    options: { note?: string; scope?: GrantScope; expiresInMs?: number | null },
  ): Promise<void> => {
    await decideApproval(approvalId, decision, options);
    turn.dismissApproval(approvalId);
  };

  return (
    <>
    <div className="app">
      {/*
        跳到主内容（需求 20.5.2）。
        
        会话列表会长到几十项，而它在 Tab 顺序上排在主内容之前。没有这个入口时，用键盘的
        用户每次想回到正文都要按几十次 Tab——那不是「不方便」，是让键盘操作在实际使用中
        不成立。用按钮而不是 `href="#main"`：后者会改 URL 的 hash，在 file:// 加载的
        渲染层里没有意义，且会在 Electron 里留下一段谁都不需要的历史记录。
      */}
      <button type="button" className="skip-to-main" onClick={() => mainRef.current?.focus()}>
        跳到主内容
      </button>

      <ProjectHeader
        projects={projects}
        projectId={projectId}
        onSelectProject={setProjectId}
        onCreateProject={() => void newProject()}
        connectionState={backend.state}
        connectionLabel={STATE_LABEL[backend.state] ?? backend.state}
      />

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
                      {c.status !== 'idle' && (
                        <span className="nav__conv-status">{conversationStatusLabel(c.status)}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        {/* tabIndex={-1} 让它可以成为编程焦点目标，但不进 Tab 顺序 */}
        <main className="app__main" ref={mainRef} tabIndex={-1}>
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
            <div className="chat__layout">
              <div className="chat__stream">
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
                  blocked={composerBlock !== null}
                  blockedReason={composerBlock?.message ?? null}
                  {...(composerBlock?.code === 'no-model'
                    ? { onRegisterModels: openRegisterModels }
                    : {})}
                  onGoRefs={() => {
                    setView('refs');
                  }}
                  onGoClaims={() => {
                    setView('claims');
                  }}
                />
                {/*
                有覆盖在生效时必须在输入区旁边说出来。藏在路由面板里的话，
                用户设完切回会话，会以为路由还是自动的——然后对结果感到莫名
              */}
                <TaskTypeChips
                  selected={routingOverride.taskType}
                  onSelect={(taskType) => setRoutingOverride({ ...routingOverride, taskType })}
                />
                <OverrideBar
                  override={routingOverride}
                  onClear={() => setRoutingOverride({})}
                  onOpenSettings={() => setView('routing')}
                />
                {/* 本轮累计用量常驻在输入区上方（需求 18.4） */}
                <TurnUsageBar usage={turn.lastUsage} />
                <Composer
                  disabled={composerBlock !== null}
                  disabledReason={composerBlock?.message ?? null}
                  running={turn.running}
                  onSend={(text, skills) => {
                    void turn.send(text, routingOverride, skills);
                    // 覆盖是一次性的，发出去就清掉
                    if (Object.keys(routingOverride).length > 0) setRoutingOverride({});
                  }}
                  onInterrupt={() => void turn.interrupt()}
                  {...(composerBlock?.code === 'no-model'
                    ? { onRegisterModels: openRegisterModels }
                    : {})}
                />
              </div>

              {/*
                计划、审查、子 agent 挂在聊天区旁边而不是各占一个顶层导航项：
                它们是会话内的上下文，需要与聊天内容对照着看——一条阻断级发现指的是
                刚才那段分析。侧栏可折叠，折叠后靠徽章提醒。
              */}
              <ConversationSidebar
                projectId={projectId}
                conversationId={conversationId}
                onOpenConversation={(id) => setConversationId(id)}
              />
            </div>
          )}

          {view === 'refs' && <RefsView projectId={projectId} />}
          {view === 'claims' && <ClaimsView projectId={projectId} />}
          {view === 'manuscripts' && <ManuscriptsView projectId={projectId} />}

          {view === 'artifacts' && <ArtifactsView projectId={projectId} />}

          {view === 'skills' && (
            <SkillsView projectId={projectId} conversationId={conversationId} />
          )}

          {view === 'connectors' && <ConnectorsView projectId={projectId} />}

          {view === 'routing' && (
            <RoutingPanel
              projectId={projectId}
              conversationId={conversationId}
              override={routingOverride}
              onOverrideChange={setRoutingOverride}
            />
          )}

          {view === 'usage' && <UsagePanel projectId={projectId} conversationId={conversationId} />}

          {view === 'tools' && (
            <>
              <ToolsPanel projectId={projectId} />
              <BackendPanel />
            </>
          )}

          {view === 'settings' && (
            <SettingsView onRegisterModels={openRegisterModels} />
          )}
        </main>
      </div>
    </div>
    {showFirstRun && (
      <FirstRunOverlay
        onSkip={() => {
          setSkippedThisSession(true);
          setOverlayForced(false);
          setView('settings');
          refreshProviderCount();
        }}
        onDone={() => {
          setOverlayForced(false);
          refreshProviderCount();
        }}
      />
    )}
    </>
  );
}
