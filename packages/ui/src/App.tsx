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
  listModels,
  listProjects,
  listProviders,
  bindClaim,
  extractClaims,
  readRefFulltextText,
  TASK_LABEL,
  type Conversation,
  type GrantScope,
  type Project,
  type RoutingOverride,
  type TaskType,
} from './lib/api.js';
import { composerBlockedReason } from './lib/composer-gate.js';
import { conversationStatusLabel } from './lib/conversation-status.js';
import { shouldShowFirstRun } from './lib/first-run.js';
import {
  composerPlaceholder,
  literatureMarkdown,
  withPaperContext,
  type PaperFocus,
} from './lib/paper-context.js';
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

const PRIMARY_NAV: ReadonlyArray<{ id: ViewId; label: string }> = [
  { id: 'refs', label: '文献' },
  { id: 'claims', label: '断言' },
  { id: 'manuscripts', label: '手稿' },
];

const ASSISTANT_NAV = { label: '助手' } as const;

const STUDIO_NAV: ReadonlyArray<{ id: ViewId; label: string }> = [
  { id: 'artifacts', label: '制品' },
  { id: 'skills', label: '技能' },
  { id: 'connectors', label: '数据源' },
  { id: 'routing', label: '模型' },
  { id: 'usage', label: '花费' },
  { id: 'tools', label: '运行环境' },
  { id: 'settings', label: '设置' },
];

const STATE_LABEL: Record<string, string> = {
  connecting: '连接中',
  ready: '已连接',
  unavailable: '暂时不可用',
  'no-bridge': '不是从桌面程序打开的',
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
  placeholder,
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
  placeholder: string;
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
        写给助手
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
          placeholder={disabled ? (disabledReason ?? '当前不可输入') : placeholder}
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
                去填写密钥
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
        后台
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
        <p className="panel__hint">现在是在浏览器里打开的。后台只在桌面程序里可用。</p>
      )}
    </section>
  );
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('refs');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [focusRef, setFocusRef] = useState<PaperFocus | null>(null);
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
  const [enabledModelCount, setEnabledModelCount] = useState<number | null>(null);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);
  const [skippedThisSession, setSkippedThisSession] = useState(false);
  const [overlayForced, setOverlayForced] = useState(false);
  /** 工作室分组默认收起（见导航注释）。 */
  const [studioOpen, setStudioOpen] = useState(false);
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

  const refreshEnabledModelCount = useCallback(() => {
    void listModels().then((result) => {
      setEnabledModelCount(result.models.filter((model) => model.enabled === true).length);
    });
  }, []);

  useEffect(() => {
    if (backend.state !== 'ready') return;
    refreshProviderCount();
    refreshEnabledModelCount();
  }, [backend.state, refreshProviderCount, refreshEnabledModelCount]);

  const showFirstRun =
    overlayForced ||
    (providerCount !== null &&
       shouldShowFirstRun({ providerCount, skippedThisSession, view }));

  const studioActive = STUDIO_NAV.some((v) => v.id === view);
  const showStudio = studioOpen || studioActive;

  /** 输入区不可用时的真实原因。写死一个理由会让用户去排查不存在的问题。 */
  const composerBlock = composerBlockedReason({
    backendState: backend.state,
    backendError: backend.error,
    projectId,
    conversationId,
    enabledModelCount,
  });
  const openRegisterModels = (): void => {
    setSkippedThisSession(false);
    setOverlayForced(true);
  };

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const listed = await listProjects();
      if (listed.projects.length === 0) {
        const { project } = await createProject('未命名项目');
        setProjects([project]);
        setProjectId(project.id);
        setProjectLoadError(null);
        return;
      }
      setProjects(listed.projects);
      const first = listed.projects[0];
      if (first !== undefined) setProjectId(first.id);
      setProjectLoadError(null);
    } catch (err: unknown) {
      setProjectLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (backend.state !== 'ready') return;
    void loadProjects();
  }, [backend.state, loadProjects]);

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

  useEffect(() => {
    if (backend.state !== 'ready' || conversationId === null) return;
    void turn.restorePendingApprovals(projectId === null ? undefined : projectId);
  }, [backend.state, conversationId, projectId, turn.restorePendingApprovals]);

  const newConversation = async (): Promise<void> => {
    if (projectId === null) return;
    const { conversation } = await createConversation(projectId);
    setConversations((prev) => [conversation, ...prev]);
    setConversationId(conversation.id);
  };

  const newProject = async (): Promise<void> => {
    try {
      const { project } = await createProject('未命名项目');
      setProjects((prev) => [project, ...prev]);
      setProjectId(project.id);
      setProjectLoadError(null);
    } catch (err: unknown) {
      setProjectLoadError(err instanceof Error ? err.message : String(err));
    }
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
          <p className="nav__group">论文</p>
          <ul>
            {PRIMARY_NAV.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`nav__item ${!assistantOpen && view === v.id ? 'is-current' : ''}`}
                  aria-current={!assistantOpen && view === v.id ? 'page' : undefined}
                  onClick={() => {
                    setAssistantOpen(false);
                    setView(v.id);
                  }}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`nav__item ${assistantOpen ? 'is-current' : ''}`}
            aria-pressed={assistantOpen}
            onClick={() => setAssistantOpen((open) => !open)}
          >
            {ASSISTANT_NAV.label}
          </button>
          {/*
            工作室默认收起：论文三站 + 助手是日常路径，七项设置类入口先不占版面。
            点进来之后（view 落在工作室某一页）自动展开，否则侧栏会一项都不亮。
          */}
          <button
            type="button"
            className="nav__group nav__group--toggle"
            aria-expanded={showStudio}
            onClick={() => setStudioOpen((open) => !open)}
          >
            工作室
            <span aria-hidden="true">{showStudio ? '▾' : '▸'}</span>
          </button>
          {showStudio && (
          <ul>
            {STUDIO_NAV.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`nav__item ${!assistantOpen && view === v.id ? 'is-current' : ''}`}
                  aria-current={!assistantOpen && view === v.id ? 'page' : undefined}
                  onClick={() => {
                    setAssistantOpen(false);
                    setView(v.id);
                  }}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
          )}

          {assistantOpen && (
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
          {turn.approvalRestoreError !== null && (
            <p className="panel__error" role="alert">
              未能恢复未决审批列表，可能需要重新加载。
            </p>
          )}
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

          {assistantOpen ? (
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
                    setAssistantOpen(false);
                    setView('refs');
                  }}
                  onGoClaims={() => {
                    setAssistantOpen(false);
                    setView('claims');
                  }}
                />
                <ConversationSidebar
                  projectId={projectId}
                  conversationId={conversationId}
                  onOpenConversation={(id) => setConversationId(id)}
                />
              </div>
            </div>
          ) : view === 'refs' ? (
            <RefsView
              projectId={projectId}
              selectedId={focusRef?.id ?? null}
              onSelect={setFocusRef}
              onExtractClaims={(ref) => {
                setFocusRef(ref);
                if (projectId === null) return;
                void (async () => {
                  setExtractError(null);
                  setExtractStatus(null);
                  try {
                    let markdown = literatureMarkdown(ref);
                    let sourceNote = '摘自题录与摘要（无全文）';
                    try {
                      const body = await readRefFulltextText(projectId, ref.id);
                      if (body.kind === 'pdf' && body.text.trim() === '') {
                        sourceNote = '摘自题录与摘要（扫描件无文本层）';
                      } else if (body.text.trim() !== '') {
                        markdown = body.text;
                        sourceNote = '摘自全文';
                      }
                    } catch (err: unknown) {
                      if (!(err instanceof Error)) throw err;
                    }
                    const extracted = await extractClaims(projectId, {
                      markdown,
                      ...(conversationId === null ? {} : { conversationId }),
                    });
                    for (const claim of extracted.created) {
                      await bindClaim(projectId, claim.id, {
                        evidenceKind: 'ref',
                        evidenceRef: ref.id,
                        note: sourceNote,
                      });
                      if (ref.doi !== null) {
                        await bindClaim(projectId, claim.id, {
                          evidenceKind: 'doi',
                          evidenceRef: ref.doi,
                          note: sourceNote,
                        });
                      }
                    }
                    if (extracted.created.length === 0) {
                      setExtractStatus('没有发现新的断言');
                    }
                    setView('claims');
                  } catch (err: unknown) {
                    setExtractError(err instanceof Error ? err.message : String(err));
                  }
                })();
              }}
            />
          ) : view === 'claims' ? (
            <ClaimsView projectId={projectId} onGoToRefs={() => { setAssistantOpen(false); setView('refs'); }} />
          ) : view === 'manuscripts' ? (
            <ManuscriptsView projectId={projectId} conversationId={conversationId} onOpenArtifacts={() => { setAssistantOpen(false); setView('artifacts'); }} />
          ) : view === 'artifacts' ? (
            <ArtifactsView projectId={projectId} />
          ) : view === 'skills' ? (
            <SkillsView projectId={projectId} conversationId={conversationId} />
          ) : view === 'connectors' ? (
            <ConnectorsView projectId={projectId} />
          ) : view === 'routing' ? (
            <RoutingPanel
              projectId={projectId}
              conversationId={conversationId}
              override={routingOverride}
              onOverrideChange={setRoutingOverride}
            />
          ) : view === 'usage' ? (
            <UsagePanel projectId={projectId} conversationId={conversationId} />
          ) : view === 'tools' ? (
            <>
              <ToolsPanel projectId={projectId} />
              <BackendPanel />
            </>
          ) : view === 'settings' ? (
            <SettingsView onRegisterModels={openRegisterModels} />
          ) : null}
        </main>
      </div>
      {(assistantOpen || view === 'refs' || view === 'claims' || view === 'manuscripts') && (
        <div className="app__dock">
          {projectLoadError !== null && (
            <p className="view__error" role="alert">
              {projectLoadError}
              <button type="button" className="btn btn--small" onClick={() => void loadProjects()}>
                重试
              </button>
            </p>
          )}
          {extractError !== null && (
            <p className="view__error" role="alert">
              {extractError}
            </p>
          )}
          {extractStatus !== null && (
            <p className="panel__hint" role="status">
              {extractStatus}
            </p>
          )}
          {focusRef !== null && (
            <div className="dock-paper">
              <p className="dock-paper__cite">当前文献：{focusRef.cite}</p>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setFocusRef(null)}
              >
                取消选中
              </button>
            </div>
          )}
          <TaskTypeChips
            selected={routingOverride.taskType}
            onSelect={(taskType) => setRoutingOverride({ ...routingOverride, taskType })}
            projectId={projectId}
            focusRef={focusRef}
          />
          <OverrideBar
            override={routingOverride}
            onClear={() => setRoutingOverride({})}
            onOpenSettings={() => setView('routing')}
          />
          <TurnUsageBar usage={turn.lastUsage} />
          <Composer
            disabled={composerBlock !== null}
            disabledReason={composerBlock?.message ?? null}
            running={turn.running}
            placeholder={composerPlaceholder(focusRef)}
            onSend={(text, skills) => {
              void turn.send(withPaperContext(text, focusRef), routingOverride, skills);
              if (Object.keys(routingOverride).length > 0) setRoutingOverride({});
              setAssistantOpen(true);
            }}
            onInterrupt={() => void turn.interrupt()}
            {...(composerBlock?.code === 'no-model'
              ? { onRegisterModels: openRegisterModels }
              : {})}
          />
        </div>
      )}
    </div>
    {showFirstRun && (
      <FirstRunOverlay
        onSkip={() => {
          setSkippedThisSession(true);
          setOverlayForced(false);
          setView('settings');
          refreshProviderCount();
          refreshEnabledModelCount();
        }}
        onDone={() => {
          setOverlayForced(false);
          refreshProviderCount();
          refreshEnabledModelCount();
        }}
      />
    )}
    </>
  );
}
