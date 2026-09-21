/**
 * 手稿：可贴 Markdown、编译、看报告。未关闭断言存在时不得暗示可以投稿。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  compileManuscript,
  getManuscript,
  listClaims,
  listManuscripts,
  type ClaimListSummary,
  type ManuscriptCompileOutput,
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

export function ManuscriptsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [rows, setRows] = useState<ManuscriptListItem[] | null>(null);
  const [summary, setSummary] = useState<ClaimListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState(BLANK_DRAFT);
  const [outputs, setOutputs] = useState<readonly ManuscriptCompileOutput[] | null>(null);
  const [busy, setBusy] = useState(false);

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
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCompile(): Promise<void> {
    if (markdown.trim() === '') {
      setError('先写或贴 Markdown。');
      return;
    }
    setBusy(true);
    try {
      const result = await compileManuscript(pid, {
        markdown,
        ...(openId === null ? {} : { manuscriptId: openId }),
        both: true,
      });
      setOpenId(result.manuscript.id);
      setOutputs(result.outputs);
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
        贴 Markdown（YAML front matter 里写 title / journal）。点编译会出正式版和双盲版报告。
      </p>
      {blocked && summary !== null && (
        <p className="panel__error" role="status">
          有 {summary.unresolved} 条未关闭断言，不能标为可投稿。
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
      <div className="view__toolbar">
        <button type="button" className="btn" disabled={busy} onClick={() => void onCompile()}>
          {busy ? '编译中…' : '编译'}
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => {
            setOpenId(null);
            setMarkdown(BLANK_DRAFT);
            setOutputs(null);
            setError(null);
          }}
        >
          新建空白
        </button>
      </div>
      {outputs !== null &&
        outputs.map((output) => (
          <pre key={output.filename} className="panel__hint">
            {output.blinded ? '双盲' : '正式'} · {output.filename}
            {'\n'}
            {output.report}
          </pre>
        ))}
      {rows === null ? (
        <p className="panel__hint">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="panel__hint">还没有登记过的手稿。编译一次就会出现在下面。</p>
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
