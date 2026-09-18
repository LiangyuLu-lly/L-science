/**
 * 技能设置页（任务 12.16，需求 9.1、9.2、9.6、9.8）。
 *
 * 五件事在一个页面里：看清目录、开关、编辑、导入、看审计。合在一处是因为它们
 * 回答的是同一个问题——**为什么某个技能没起作用**。而那个问题有五个可能的答案：
 * 它被禁用了、它的依赖没装、它被一个同名的用户技能遮蔽了、它加载失败了、
 * 它的 triggers 写得搜不到。分散在几个页面里的话，用户得逐个去猜。
 *
 * 因此这里坚持：
 *
 * 1. **默认显示全部**，含被禁用的、文件已消失的、加载失败的。只显示可用项会让
 *    「我装的那个技能哪去了」无从回答。
 * 2. **区分「禁用」与「文件不在了」**。同步只禁用不删行，两者在列表里看着一样，
 *    但处理方式完全不同。
 * 3. **依赖缺失如实标注并给出安装命令**，不隐藏该技能——用户需要知道方法存在。
 * 4. **内置技能只能禁用不能删改**。改了会在下次启动被同步覆盖，那种「改动消失」
 *    没有任何报错。要改就另存为用户技能，界面直接给这个动作。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  deleteSkill,
  distillSkillFromConversation,
  importSkillArchive,
  importSkillDirectory,
  importSkillFromGithub,
  listCredentials,
  listSkills,
  loadSkillAudit,
  loadSkillSource,
  reloadSkills,
  setSkillEnabled,
  validateSkill,
  writeSkill,
  SKILL_REASON_LABEL,
  type SkillCatalogView,
  type SkillImportOutcome,
  type SkillListItem,
  type SkillValidateResult,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 技能清单的初始模板。给出的是一份能直接保存的骨架，不是空白。 */
function draftManifest(slug: string): string {
  return `${JSON.stringify(
    {
      slug,
      name: '给它起个名字',
      version: '1.0.0',
      domain: '自定义',
      description: '一句话说清它解决什么问题。这是检索的主要输入，写含糊会导致永远搜不到它。',
      triggers: ['什么时候该用它', '写成用户会说的话', '至少三条覆盖不同说法'],
      tools: [],
      requires: {},
    },
    null,
    2,
  )}\n`;
}

const DRAFT_INSTRUCTIONS = `# 技能名

## 适用范围

什么情况下按这份文档做，什么情况下不适用。

## 步骤

1. 第一步。说清为什么它在这个位置。
2. 第二步。

## 关键参数

- 参数名：取值范围与取舍依据。

## 容易出错的地方

- 具体的坑，以及它会导致什么样的错误结论。

## 验证清单

- 怎么判断这一步做对了。写判据，不要写「检查一下」。
`;

/* ------------------------------------------------------------------ *
 * 依赖与状态徽章
 * ------------------------------------------------------------------ */

function StatusBadges({ skill }: { skill: SkillListItem }): React.JSX.Element {
  return (
    <span className="skillrow__badges">
      <span className={`sbadge sbadge--${skill.scope}`}>
        {skill.scope === 'builtin' ? '内置' : '自建'}
      </span>
      {!skill.enabled && <span className="sbadge sbadge--off">已禁用</span>}
      {/*
        文件不在了与被禁用是两件事：同步只禁用不删行，所以库里有记录不代表
        磁盘上还有目录。混在一起显示会让「我删了目录」和「我关了它」看着一样
      */}
      {!skill.present && (
        <span className="sbadge sbadge--gone" title={`目录已不存在：${skill.path}`}>
          文件已丢失
        </span>
      )}
      {skill.requirementsSatisfied === false && (
        <span className="sbadge sbadge--warn">依赖未满足</span>
      )}
      {skill.warnings.length > 0 && (
        <span className="sbadge sbadge--warn" title={skill.warnings.join('\n')}>
          {skill.warnings.length} 条提示
        </span>
      )}
    </span>
  );
}

function MissingList({ skill }: { skill: SkillListItem }): React.JSX.Element | null {
  if (skill.missing.length === 0 && skill.probeFailures.length === 0) return null;
  return (
    <div className="skillrow__missing">
      {skill.missing.length > 0 && (
        <>
          <p>缺少下面这些依赖。技能仍然可以被检索到并注入，但要先装好再照着做：</p>
          <ul>
            {skill.missing.map((m) => (
              <li key={`${m.kind}:${m.name}`}>
                <span className="skillrow__missing-name">{m.name}</span>
                {/* 给可执行的命令而不是「请安装依赖」——后者用户还得自己查怎么装 */}
                <code>{m.remediation}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {skill.probeFailures.length > 0 && (
        <p className="skillrow__probefail">
          {/* 探测失败与确定缺失不同：前者是「不知道」，把它说成「缺」是在撒谎 */}有{' '}
          {skill.probeFailures.length} 项没探测成功，因此无法确认是否满足：
          {skill.probeFailures.map((p) => `${p.kind}（${p.reason}）`).join('；')}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 编辑器
 * ------------------------------------------------------------------ */

interface EditorState {
  /** 编辑已有技能时是它的 slug；新建时为 null。 */
  editing: string | null;
  manifest: string;
  instructions: string;
  /** 从内置技能另存为：保存时必须换 slug，否则是遮蔽而不是复制。 */
  forkedFrom: string | null;
}

function SkillEditor({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState;
  onClose: () => void;
  onSaved: (slug: string) => void;
}): React.JSX.Element {
  const [manifest, setManifest] = useState(state.manifest);
  const [instructions, setInstructions] = useState(state.instructions);
  const [validation, setValidation] = useState<SkillValidateResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * 边打边校验（防抖）。
   *
   * 保存时才校验的做法会让用户写完一整份文档才发现 slug 不合法。而校验是纯计算，
   * 没有理由让他等到那时候。
   */
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void validateSkill(manifest, instructions)
        .then((result) => {
          if (!cancelled) setValidation(result);
        })
        .catch(() => {
          // 校验请求本身失败不该打断编辑，保存时会再校验一次
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [manifest, instructions]);

  const conflict = validation?.conflictsWith ?? null;
  // 从内置技能另存为时，沿用原 slug 等于遮蔽掉它——那不是「另存」
  const shadowing = state.forkedFrom !== null && validation?.slug === state.forkedFrom;

  const save = async (overwrite: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await writeSkill({ manifest, instructions, overwrite });
      if (!result.ok) {
        setError(result.errors.join('\n'));
        return;
      }
      onSaved(result.slug ?? '');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="skilleditor" aria-label="编辑技能">
      <header className="skilleditor__head">
        <h3>
          {state.editing === null
            ? state.forkedFrom === null
              ? '新建技能'
              : `基于 ${state.forkedFrom} 另存为用户技能`
            : `编辑 ${state.editing}`}
        </h3>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          关闭
        </button>
      </header>

      {shadowing && (
        <p className="skilleditor__warn" role="alert">
          slug 还是 <code>{state.forkedFrom}</code>。保存后它会**遮蔽**同名的内置技能，
          原版此后不再被加载，而检索结果里看不出发生了这件事。想要一份独立的副本请换个 slug。
        </p>
      )}

      <div className="skilleditor__grid">
        <div className="skilleditor__pane">
          <label className="skilleditor__label" htmlFor="skill-manifest">
            skill.json
          </label>
          {/*
            传文本而不是表单：用户编辑的就是这份 JSON，做成表单会把「JSON 语法错误」
            这个最常见的问题挡在传输层之外，那时他得到的是一条 schema 消息而不是
            「第 7 行少了个逗号」
          */}
          <textarea
            id="skill-manifest"
            className="skilleditor__code"
            value={manifest}
            spellCheck={false}
            rows={18}
            onChange={(e) => setManifest(e.target.value)}
          />
        </div>

        <div className="skilleditor__pane">
          <label className="skilleditor__label" htmlFor="skill-md">
            SKILL.md（注入上下文的正文）
          </label>
          <textarea
            id="skill-md"
            className="skilleditor__code"
            value={instructions}
            spellCheck={false}
            rows={18}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>
      </div>

      <div className="skilleditor__status" aria-live="polite">
        {validation === null ? (
          <span className="skilleditor__checking">校验中…</span>
        ) : (
          <>
            {validation.errors.length > 0 && (
              <ul className="skilleditor__errors">
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {validation.warnings.length > 0 && (
              <ul className="skilleditor__warnings">
                {validation.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {validation.ok && validation.errors.length === 0 && (
              <span className="skilleditor__ok">
                校验通过{validation.slug === null ? '' : `：${validation.slug}`}
              </span>
            )}
          </>
        )}
      </div>

      {error !== null && (
        <pre className="skilleditor__error" role="alert">
          {error}
        </pre>
      )}

      <div className="skilleditor__actions">
        {conflict !== null && state.editing !== conflict.slug ? (
          <>
            <p className="skilleditor__conflict">
              已存在 {conflict.scope === 'builtin' ? '内置' : '用户'}技能{' '}
              <code>{conflict.slug}</code>（{conflict.name}）。
              {conflict.scope === 'builtin'
                ? '覆盖它会让内置版本此后不再加载。'
                : '覆盖会替换你现有的那一份。'}
            </p>
            <button
              type="button"
              className="btn btn--deny"
              disabled={saving || validation?.ok !== true}
              onClick={() => void save(true)}
            >
              覆盖保存
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={saving || validation?.ok !== true}
            onClick={() => void save(state.editing !== null)}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

function ImportPanel({
  onDone,
}: {
  onDone: (outcome: SkillImportOutcome) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [directory, setDirectory] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [credentials, setCredentials] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  /*
   * 三个导入入口各自的输入框都要有可编程访问的名称（需求 20.5.2）。
   *
   * 原先旁边那行文字是 `<span>`：视觉上是标签，程序上不是。屏幕阅读器把焦点移到这里
   * 只会读「编辑框」，而这一屏上有三个并列的输入框，读不出名字等于分不清哪个是哪个。
   */
  const archiveId = useId();
  const directoryId = useId();
  const specId = useId();

  useEffect(() => {
    void listCredentials()
      .then((r) => setCredentials(r.credentials.map((c) => c.ref)))
      .catch(() => setCredentials([]));
  }, []);

  const run = async (label: string, fn: () => Promise<SkillImportOutcome>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (file: File): Promise<void> => {
    // IPC 是 JSON 通道，二进制只能用 base64。上限在 schema 里
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    await run('archive', () => importSkillArchive(file.name, btoa(binary), overwrite));
  };

  return (
    <section className="skillimport" aria-label="导入技能">
      <h3>导入技能</h3>

      <label className="skillimport__overwrite">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
        />
        允许覆盖同名技能
        {/* 默认不覆盖：静默覆盖会让用户自己改过的版本无声消失 */}
        <span className="skillimport__hint">默认不覆盖，同名会被跳过并在结果里说明</span>
      </label>

      <div className="skillimport__row">
        <label className="skillimport__label" htmlFor={archiveId}>
          压缩包
        </label>
        <input
          id={archiveId}
          ref={fileRef}
          type="file"
          accept=".zip,.tar,.tar.gz,.tgz"
          disabled={busy !== null}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void onFile(file);
            // 清掉 value，否则选同一个文件第二次不会触发 change
            e.target.value = '';
          }}
        />
        <span className="skillimport__hint">
          支持 .zip、.tar、.tar.gz。一个包里可以有多个技能。
        </span>
      </div>

      <div className="skillimport__row">
        <label className="skillimport__label" htmlFor={directoryId}>
          本机目录
        </label>
        <input
          id={directoryId}
          type="text"
          value={directory}
          placeholder="D:\my-skills"
          disabled={busy !== null}
          onChange={(e) => setDirectory(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy !== null || directory.trim() === ''}
          onClick={() => void run('dir', () => importSkillDirectory(directory.trim(), overwrite))}
        >
          {busy === 'dir' ? '导入中…' : '导入'}
        </button>
      </div>

      <div className="skillimport__row">
        <label className="skillimport__label" htmlFor={specId}>
          GitHub
        </label>
        <input
          id={specId}
          type="text"
          value={spec}
          placeholder="owner/repo、owner/repo@分支，或直接粘贴仓库网址"
          disabled={busy !== null}
          onChange={(e) => setSpec(e.target.value)}
        />
        {/*
          私库令牌选的是凭据引用名而不是在这里输入令牌：请求载荷里不放密钥是
          平台的硬约定。令牌在「设置 → 凭据」里存一次即可。
        */}
        <select
          value={credentialRef}
          disabled={busy !== null}
          onChange={(e) => setCredentialRef(e.target.value)}
          aria-label="私库令牌（凭据引用名）"
        >
          <option value="">公开仓库（无需令牌）</option>
          {credentials.map((ref) => (
            <option key={ref} value={ref}>
              {ref}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy !== null || spec.trim() === ''}
          onClick={() =>
            void run('github', () =>
              importSkillFromGithub(
                spec.trim(),
                credentialRef === '' ? null : credentialRef,
                overwrite,
              ),
            )
          }
        >
          {busy === 'github' ? '拉取中…' : '导入'}
        </button>
      </div>

      <p className="skillimport__note">
        导入的技能会写进用户技能目录并覆盖同名内置技能的加载优先级。
        <strong>技能可以带脚本</strong>，导入前请确认来源可信——它的内容会作为方法学
        注入到以后的对话里。
      </p>

      {error !== null && (
        <p className="skillimport__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 蒸馏
 * ------------------------------------------------------------------ */

function DistillPanel({
  projectId,
  conversationId,
  onDraft,
}: {
  projectId: string | null;
  conversationId: string | null;
  onDraft: (draft: { manifest: string; instructions: string }) => void;
}): React.JSX.Element {
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  if (projectId === null || conversationId === null) {
    return (
      <section className="skilldistill" aria-label="从会话蒸馏技能">
        <h3>从当前会话蒸馏</h3>
        <p className="skilldistill__hint">先在「会话」里选一个会话，再回来蒸馏。</p>
      </section>
    );
  }

  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setWarnings([]);
    try {
      const result = await distillSkillFromConversation({
        projectId,
        conversationId,
        focus: focus.trim() === '' ? null : focus.trim(),
      });
      if (!result.ok) {
        setMessage(
          result.insufficient === true
            ? `模型认为这次会话里没有值得提炼的方法：${result.reason ?? ''}`
            : `蒸馏失败：${result.reason ?? '未知原因'}`,
        );
        return;
      }
      setWarnings([...(result.contentWarnings ?? []), ...(result.manifestWarnings ?? [])]);
      setMessage(
        `已生成草稿（模型 ${result.modelId ?? '未知'}，读了 ${String(result.context?.included ?? 0)} 条消息` +
          `${result.context?.truncated === true ? '，因预算被截断' : ''}）。请在编辑器里过一遍再保存。`,
      );
      onDraft({ manifest: result.manifest ?? '', instructions: result.instructions ?? '' });
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="skilldistill" aria-label="从会话蒸馏技能">
      <h3>从当前会话蒸馏</h3>
      <p className="skilldistill__hint">
        把这次会话里摸索出的做法提炼成技能。
        {/*
          这句必须说：蒸馏的输入是一次具体分析，它天然倾向于把一次性细节写成通用规则。
          不提醒的话用户会直接保存，而技能到别的项目里就失效
        */}
        <strong>结果是草稿，不会直接保存</strong>
        ——蒸馏最容易把这一次的路径与数值写成通用规则，必须由你过一遍。
      </p>
      <div className="skilldistill__row">
        <label htmlFor="distill-focus">重点（可留空）</label>
        <input
          id="distill-focus"
          type="text"
          value={focus}
          placeholder="例如：只提炼预处理那一段"
          disabled={busy}
          onChange={(e) => setFocus(e.target.value)}
        />
        <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
          {busy ? '蒸馏中…' : '开始蒸馏'}
        </button>
      </div>
      {message !== null && (
        <p className="skilldistill__message" aria-live="polite">
          {message}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="skilldistill__warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 审计
 * ------------------------------------------------------------------ */

function AuditPanel({
  projectId,
  conversationId,
}: {
  projectId: string | null;
  conversationId: string | null;
}): React.JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSkillAudit>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null || conversationId === null) return;
    void loadSkillAudit(projectId, conversationId)
      .then(setData)
      .catch((err: unknown) => setError(errorText(err)));
  }, [projectId, conversationId]);

  if (projectId === null || conversationId === null) {
    return (
      <section className="skillaudit" aria-label="技能加载审计">
        <h3>加载审计</h3>
        <p className="skillaudit__hint">选一个会话后可以看它加载过哪些技能、为什么加载。</p>
      </section>
    );
  }

  return (
    <section className="skillaudit" aria-label="技能加载审计">
      <h3>加载审计</h3>
      <p className="skillaudit__hint">
        半年后回看一份结论时，「当时按的是哪套方法」必须答得出来（需求 9.8）。
      </p>
      {error !== null && (
        <p className="skillaudit__error" role="alert">
          {error}
        </p>
      )}
      {data !== null && data.events.length === 0 && (
        <p className="skillaudit__empty">这个会话还没有加载过技能。</p>
      )}
      {data !== null && data.events.length > 0 && (
        <table className="skillaudit__table">
          <caption>本会话的技能加载记录</caption>
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">技能</th>
              <th scope="col">原因</th>
              <th scope="col">注入字符</th>
              <th scope="col">详情</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id}>
                <td>{timeText(e.at)}</td>
                <td>
                  <code>{e.slug}</code>
                </td>
                <td>{SKILL_REASON_LABEL[e.reason] ?? e.reason}</td>
                <td className="num">{e.injectedChars.toLocaleString('zh-CN')}</td>
                <td>{e.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data !== null && data.summary.length > 0 && (
        <details className="skillaudit__summary">
          <summary>按技能汇总（本项目）</summary>
          <ul>
            {data.summary.map((s) => (
              <li key={s.slug}>
                <code>{s.slug}</code> 被加载 {s.loads} 次，最近 {timeText(s.lastAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 主视图
 * ------------------------------------------------------------------ */

export interface SkillsViewProps {
  projectId: string | null;
  conversationId: string | null;
}

export function SkillsView({ projectId, conversationId }: SkillsViewProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [importResult, setImportResult] = useState<SkillImportOutcome | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setCatalog(await listSkills());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rescan = async (rebuildVectors: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await reloadSkills(rebuildVectors);
      setNotice(
        `重扫完成：生效 ${String(result.active)} 个，遮蔽 ${String(result.shadowed)}，加载失败 ${String(result.broken)}` +
          (rebuildVectors
            ? `；嵌入新建 ${String(result.vectors.built)}，命中缓存 ${String(result.vectors.cached)}` +
              (result.vectors.failed === null ? '' : `；向量层失败：${result.vectors.failed}`)
            : ''),
      );
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (slug: string, enabled: boolean): Promise<void> => {
    try {
      await setSkillEnabled(slug, enabled);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (slug: string): Promise<void> => {
    try {
      await deleteSkill(slug);
      setNotice(`已删除用户技能 ${slug}`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openEditor = async (slug: string | null, fork: boolean): Promise<void> => {
    if (slug === null) {
      setEditor({
        editing: null,
        manifest: draftManifest('my-skill'),
        instructions: DRAFT_INSTRUCTIONS,
        forkedFrom: null,
      });
      return;
    }
    try {
      const source = await loadSkillSource(slug);
      setEditor({
        editing: fork ? null : slug,
        manifest: source.manifest,
        instructions: source.skillMd,
        forkedFrom: fork ? slug : null,
      });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const groups = useMemo(() => {
    if (catalog === null) return [];
    const needle = filter.trim().toLowerCase();
    const matched = catalog.skills.filter(
      (s) =>
        needle === '' ||
        s.slug.includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle) ||
        (s.domain ?? '').toLowerCase().includes(needle),
    );
    const byDomain = new Map<string, SkillListItem[]>();
    for (const skill of matched) {
      const key = skill.domain ?? '未分类';
      const list = byDomain.get(key);
      if (list === undefined) byDomain.set(key, [skill]);
      else list.push(skill);
    }
    return [...byDomain.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [catalog, filter]);

  return (
    <section className="view skillsview" aria-label="技能">
      <header className="skillsview__head">
        <h2>技能</h2>
        <div className="skillsview__actions">
          <button type="button" className="btn" onClick={() => void openEditor(null, false)}>
            新建技能
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void rescan(false)}
          >
            重扫目录
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void rescan(true)}
            title="重扫并重建语义向量。向量要向本机推理服务发几十段文本，会慢一些。"
          >
            重扫并重建向量
          </button>
        </div>
      </header>

      {catalog !== null && (
        <p className="skillsview__meta">
          共 {catalog.skills.length} 个技能。
          {/* 向量层没就绪时要说出来：检索质量的差别用户感知得到，原因不该靠猜 */}
          {catalog.vectorsReady ? (
            <span className="skillsview__ok">语义检索已就绪</span>
          ) : (
            <span className="skillsview__degraded">
              语义向量未就绪，当前只用词法检索
              {catalog.embedFailure === null
                ? '（没有配置本机推理服务）'
                : `：${catalog.embedFailure}`}
            </span>
          )}
          <span className="skillsview__paths">
            内置目录 <code>{catalog.builtinDir}</code>；用户目录 <code>{catalog.userDir}</code>
          </span>
        </p>
      )}

      {notice !== null && (
        <p className="skillsview__notice" aria-live="polite">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="view__error" role="alert">
          {error}
        </p>
      )}

      {catalog !== null && catalog.broken.length > 0 && (
        <section className="skillsview__broken" aria-label="加载失败的技能">
          <h3>加载失败（{catalog.broken.length}）</h3>
          {/* 加载失败必须显式列出：它们不在列表里，用户会以为技能没装上 */}
          <ul>
            {catalog.broken.map((b) => (
              <li key={b.path}>
                <code>{b.dirName}</code>（{b.scope === 'builtin' ? '内置' : '自建'}）：{b.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {catalog !== null && catalog.unavailable.length > 0 && (
        <section className="skillsview__unavailable" aria-label="当前不可用的技能">
          <h3>当前不可用（{catalog.unavailable.length}）</h3>
          {/* 不能静默从目录拿掉：用户会以为技能没装上，而真正缺的是原生能力 */}
          <ul>
            {catalog.unavailable.map((u) => (
              <li key={u.path}>
                <code>{u.slug}</code>（{u.scope === 'builtin' ? '内置' : '自建'}）：{u.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {catalog !== null && catalog.shadowed.length > 0 && (
        <section className="skillsview__shadowed" aria-label="被遮蔽的内置技能">
          <h3>被自建技能遮蔽的内置技能（{catalog.shadowed.length}）</h3>
          <p>这些内置技能已不再被加载，因为你有同名的自建技能。</p>
          <ul>
            {catalog.shadowed.map((s) => (
              <li key={s.slug}>
                <code>{s.slug}</code>（{s.name}）
              </li>
            ))}
          </ul>
        </section>
      )}

      {editor !== null && (
        <SkillEditor
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={(slug) => {
            setEditor(null);
            setNotice(`已保存 ${slug}`);
            void refresh();
          }}
        />
      )}

      <div className="skillsview__filter">
        <label htmlFor="skill-filter">筛选</label>
        <input
          id="skill-filter"
          type="search"
          value={filter}
          placeholder="按名称、slug、说明或领域筛"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {groups.map(([domain, items]) => (
        <section key={domain} className="skillgroup" aria-label={`领域：${domain}`}>
          <h3 className="skillgroup__title">
            {domain} <span className="skillgroup__count">{items.length}</span>
          </h3>
          <ul className="skillgroup__list">
            {items.map((skill) => (
              <li key={skill.slug} className={`skillrow ${skill.enabled ? '' : 'is-off'}`}>
                <div className="skillrow__main">
                  <label className="skillrow__toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={(e) => void toggle(skill.slug, e.target.checked)}
                      aria-label={`启用技能 ${skill.name}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="skillrow__title"
                    aria-expanded={expanded === skill.slug}
                    onClick={() => setExpanded(expanded === skill.slug ? null : skill.slug)}
                  >
                    <span className="skillrow__name">{skill.name}</span>
                    <code className="skillrow__slug">{skill.slug}</code>
                    <StatusBadges skill={skill} />
                  </button>
                </div>
                <p className="skillrow__desc">{skill.description}</p>

                {expanded === skill.slug && (
                  <div className="skillrow__detail">
                    <dl>
                      <dt>触发场景</dt>
                      <dd>
                        <ul className="skillrow__triggers">
                          {skill.triggers.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      </dd>
                      {skill.tools.length > 0 && (
                        <>
                          <dt>需要工具</dt>
                          <dd>{skill.tools.join('、')}</dd>
                        </>
                      )}
                      {skill.references.length > 0 && (
                        <>
                          <dt>参考材料</dt>
                          <dd>{skill.references.join('、')}</dd>
                        </>
                      )}
                      {skill.scripts.length > 0 && (
                        <>
                          <dt>脚本</dt>
                          <dd>{skill.scripts.join('、')}</dd>
                        </>
                      )}
                      <dt>目录</dt>
                      <dd>
                        <code>{skill.path}</code>
                      </dd>
                    </dl>

                    <MissingList skill={skill} />

                    {skill.warnings.length > 0 && (
                      <ul className="skillrow__warnings">
                        {skill.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}

                    <div className="skillrow__actions">
                      {skill.scope === 'user' ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => void openEditor(skill.slug, false)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn btn--deny"
                            onClick={() => void remove(skill.slug)}
                          >
                            删除
                          </button>
                        </>
                      ) : (
                        <>
                          {/*
                            内置技能不提供「编辑」：改动会在下次启动被同步覆盖，
                            而那种消失没有任何报错。直接给「另存为」这个正确动作。
                          */}
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => void openEditor(skill.slug, true)}
                            title="内置技能不能原地改（改动会在下次启动被覆盖）。这里会复制一份成为你的自建技能。"
                          >
                            另存为自建技能
                          </button>
                          <span className="skillrow__note">
                            内置技能只能禁用，不能删除或原地修改
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ImportPanel
        onDone={(outcome) => {
          setImportResult(outcome);
          void refresh();
        }}
      />

      {importResult !== null && (
        <section className="skillimport__result" aria-label="导入结果" aria-live="polite">
          <h3>导入结果{importResult.source === null ? '' : `：${importResult.source}`}</h3>
          {importResult.errors.length > 0 && (
            <ul className="skillimport__errors">
              {importResult.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {/* 逐个技能报结果：一个包里有五个技能时「整体失败」让人无从判断是哪个坏了 */}
          {importResult.skills.map((s) => (
            <div key={s.location} className={`skillimport__item ${s.ok ? 'is-ok' : 'is-bad'}`}>
              <strong>{s.location}</strong>
              {s.ok ? (
                <span>
                  已{s.replaced ? '更新' : '导入'} <code>{s.slug}</code>
                  {s.shadowsBuiltin ? '（遮蔽了同名内置技能）' : ''}
                </span>
              ) : (
                <span>失败：{s.errors.join('；')}</span>
              )}
              {s.warnings.length > 0 && (
                <span className="skillimport__warn">{s.warnings.join('；')}</span>
              )}
            </div>
          ))}
          {importResult.skipped.length > 0 && (
            <details>
              <summary>跳过的条目（{importResult.skipped.length}）</summary>
              <ul>
                {importResult.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <DistillPanel
        projectId={projectId}
        conversationId={conversationId}
        onDraft={(draft) =>
          setEditor({
            editing: null,
            manifest: draft.manifest,
            instructions: draft.instructions,
            forkedFrom: null,
          })
        }
      />

      <AuditPanel projectId={projectId} conversationId={conversationId} />
    </section>
  );
}
