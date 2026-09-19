/**
 * Claim Ledger。未关闭与无证据的断言必须在列表层可见，不能等投稿前才发现。
 */

import { useCallback, useEffect, useState } from 'react';

import { listClaims, type ClaimListItem, type ClaimListSummary } from '../lib/api.js';

const STATUS_LABEL: Record<string, string> = {
  open: '待核验',
  supported: '证据支持',
  insufficient: '证据不足',
  refuted: '证据矛盾',
  retracted: '已撤回',
  dismissed: '无需核验',
};

export function ClaimsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [claims, setClaims] = useState<ClaimListItem[] | null>(null);
  const [summary, setSummary] = useState<ClaimListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void listClaims(projectId)
      .then((result) => {
        setClaims(result.claims);
        setSummary(result.summary);
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
    <section className="view" aria-labelledby="claims-heading">
      <h1 id="claims-heading">断言</h1>
      {summary !== null && (
        <p className="panel__hint">
          共 {summary.total} 条，未关闭 {summary.unresolved}，无证据 {summary.unsupported}，矛盾{' '}
          {summary.refuted}。
        </p>
      )}
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {claims === null ? (
        <p className="panel__hint">加载中…</p>
      ) : claims.length === 0 ? (
        <p className="panel__hint">还没有断言。编译或抽取手稿后会出现在这里，每条必须绑证据。</p>
      ) : (
        <ul className="claim-list">
          {claims.map((item) => (
            <li key={item.id} className="panel">
              <p>{item.text}</p>
              <p className="panel__hint">
                {STATUS_LABEL[item.status] ?? item.status}
                {item.unsupported ? ' · 无证据' : ` · 已核验 ${String(item.verifiedCount)}`}
                {item.section !== null ? ` · ${item.section}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
