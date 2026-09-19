/**
 * 手稿列表。点开可见最近一次编译报告。未关闭断言存在时不得暗示可以投稿。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getManuscript,
  listClaims,
  listManuscripts,
  type ClaimListSummary,
  type ManuscriptCompileRun,
  type ManuscriptListItem,
} from '../lib/api.js';

const STATUS_LABEL: Record<string, string> = {
  drafting: '起草中',
  compiled: '已编译',
  submitted: '已投稿',
  archived: '已归档',
};

export function ManuscriptsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [rows, setRows] = useState<ManuscriptListItem[] | null>(null);
  const [summary, setSummary] = useState<ClaimListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly ManuscriptCompileRun[] | null>(null);

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
    setRuns(null);
    try {
      const detail = await getManuscript(pid, id);
      setRuns(detail.runs);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const latest = runs?.[0] ?? null;

  return (
    <section className="view" aria-labelledby="manuscripts-heading">
      <h1 id="manuscripts-heading">手稿</h1>
      <p className="panel__hint">正式版与双盲版分列存放。点一条可看最近编译错误。</p>
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
      {rows === null ? (
        <p className="panel__hint">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="panel__hint">还没有手稿。在会话里起草后会登记到这里。</p>
      ) : (
        <ul className="manuscript-list">
          {rows.map((item) => (
            <li key={item.id} className="panel">
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
              {openId === item.id && latest !== null && (
                <pre className="panel__hint">
                  {latest.blinded ? '双盲' : '正式'} · 错误 {String(latest.errors)} · 警告{' '}
                  {String(latest.warnings)}
                  {latest.report === null || latest.report === ''
                    ? '\n没有编译报告。'
                    : `\n${latest.report}`}
                </pre>
              )}
              {openId === item.id && runs !== null && runs.length === 0 && (
                <p className="panel__hint">还没有编译记录。</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
