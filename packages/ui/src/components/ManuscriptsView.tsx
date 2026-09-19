/**
 * 手稿列表。编译错误的行号在后端；这里先让人找得到手稿本身。
 */

import { useCallback, useEffect, useState } from 'react';

import { listManuscripts, type ManuscriptListItem } from '../lib/api.js';

const STATUS_LABEL: Record<string, string> = {
  drafting: '起草中',
  compiled: '已编译',
  submitted: '已投稿',
  archived: '已归档',
};

export function ManuscriptsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [rows, setRows] = useState<ManuscriptListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void listManuscripts(projectId)
      .then((result) => {
        setRows(result.manuscripts);
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

  return (
    <section className="view" aria-labelledby="manuscripts-heading">
      <h1 id="manuscripts-heading">手稿</h1>
      <p className="panel__hint">正式版与双盲版分列存放。编译前请先核对期刊档案是否过期。</p>
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
              <p className="panel__title">{item.title ?? '未命名手稿'}</p>
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
