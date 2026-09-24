/**
 * 手稿：可贴 Markdown、编译、看报告。未关闭断言存在时不得暗示可以投稿。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  compileManuscript,
  getManuscript,
  listClaims,
  listManuscriptProfiles,
  listManuscripts,
  type ClaimListSummary,
  type JournalProfileView,
  type ManuscriptCompileOutput,
  type ManuscriptCompileRun,
  type ManuscriptListItem,
} from '../lib/api.js';

const STATUS_LABEL: Record<string, string> = {
  drafting: '起草中',
  compiled: '已编译',
  submitted: '已投稿',
  archived: '已归档',
};

const BLANK_DRAFT = `---
title: 未命名手稿
journal:
---

# 引言

`;

export function ManuscriptsView({
  projectId,
  conversationId,
  onOpenArtifacts,
}: {
  projectId: string | null;
  conversationId: string | null;
  onOpenArtifacts?: () => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<ManuscriptListItem[] | null>(null);
  const [summary, setSummary] = useState<ClaimListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState(BLANK_DRAFT);
  const [outputs, setOutputs] = useState<readonly ManuscriptCompileOutput[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<readonly JournalProfileView[]>([]);
  const [disclaimer, setDisclaimer] = useState<string | null>(null);
  const [targetJournal, setTargetJournal] = useState('');
  const [runs, setRuns] = useState<readonly ManuscriptCompileRun[]>([]);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void Promise.all([listManuscripts(projectId), listClaims(projectId)])
      .then(([manuscripts, claims]) => {
        setRows(manuscripts.manuscripts);
        setSummary(claims.summary);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    void listManuscriptProfiles()
      .then((result) => {
        setProfiles(result.profiles);
        setDisclaimer(result.disclaimer);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (projectId === null) {
    return <p className="panel__hint">先选择或新建一个项目。</p>;
  }

  const pid = projectId;
  const blocked = summary !== null && summary.unresolved > 0;

  async function openManuscript(id: string): Promise<void> {
    setOpenId(id);
    setOutputs(null);
    try {
      const detail = await getManuscript(pid, id);
      setMarkdown(detail.sourceMarkdown ?? BLANK_DRAFT);
      setRuns(detail.runs);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCompile(): Promise<void> {
    if (markdown.trim() === '') {
      setError('先写一段正文。');
      return;
    }
    setBusy(true);
    try {
      const result = await compileManuscript(pid, {
        markdown,
        ...(openId === null ? {} : { manuscriptId: openId }),
        ...(conversationId === null ? {} : { conversationId }),
        ...(targetJournal === '' ? {} : { targetJournal }),
        both: true,
      });
      setOpenId(result.manuscript.id);
      setOutputs(result.outputs);
      const detail = await getManuscript(pid, result.manuscript.id);
      setRuns(detail.runs);
      setError(null);
      reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view" aria-labelledby="manuscripts-heading">
      <h1 id="manuscripts-heading">手稿</h1>
      <p className="panel__hint">
        在下面写正文。开头三道横线里可以写标题和期刊名。编译后会给出正式稿、隐去姓名的稿，以及一份检查说明。
      </p>
      {conversationId === null && (
        <p className="panel__hint" role="status">
          还没有对话，编译前不会做检查
        </p>
      )}
      {blocked && summary !== null && (
        <p className="panel__error" role="status">
          还有 {summary.unresolved} 条断言没处理完，不能标为可投稿。
        </p>
      )}
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      <label htmlFor="manuscript-source">正文</label>
      <textarea
        id="manuscript-source"
        className="composer__input manuscript-editor"
        rows={16}
        value={markdown}
        disabled={busy}
        onChange={(event) => {
          setMarkdown(event.target.value);
        }}
      />
      {disclaimer !== null && <p className="panel__hint">{disclaimer}</p>}
      <div className="view__toolbar">
        <label htmlFor="manuscript-journal">期刊档案</label>
        <select
          id="manuscript-journal"
          value={targetJournal}
          disabled={busy}
          onChange={(event) => {
            setTargetJournal(event.target.value);
          }}
        >
          <option value="">按正文开头写的期刊名</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.name}>
              {profile.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={busy} onClick={() => void onCompile()}>
          {busy ? '编译中…' : '编译'}
        </button>
        {onOpenArtifacts !== undefined && (
          <button type="button" className="btn btn--small" onClick={onOpenArtifacts}>
            在制品里查看
          </button>
        )}
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => {
            setOpenId(null);
            setMarkdown(BLANK_DRAFT);
            setOutputs(null);
            setRuns([]);
            setError(null);
          }}
        >
          新建空白
        </button>
      </div>
      {outputs !== null &&
        outputs.map((output) => (
          <pre key={output.filename} className="panel__hint">
            {output.blinded ? '隐去姓名' : '正式稿'} · {output.filename}
            {'\n'}
            {output.report}
          </pre>
        ))}
      {runs.length > 0 && (
        <ul className="panel">
          {runs.map((run) => (
            <li key={run.id} className="panel__hint">
              {new Date(run.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
              {` · 错误 ${String(run.errors)} · 警告 ${String(run.warnings)} · ${run.blinded ? '隐去姓名' : '正式稿'}`}
            </li>
          ))}
        </ul>
      )}
      {rows === null ? (
        <p className="panel__hint">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="panel__hint">还没有保存过的手稿。编译一次就会列在下面。</p>
      ) : (
        <ul className="manuscript-list">
          {rows.map((item) => (
            <li key={item.id} className={`panel ${openId === item.id ? 'is-current' : ''}`}>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => void openManuscript(item.id)}
              >
                {item.title ?? '未命名手稿'}
              </button>
              <p className="panel__hint">
                {STATUS_LABEL[item.status] ?? item.status}
                {item.targetJournal !== null ? ` · ${item.targetJournal}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
