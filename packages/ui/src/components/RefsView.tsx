/**
 * 文献库。粘贴 DOI/PMID/链接即可入库，不必先开对话。
 */

import { useCallback, useEffect, useState } from 'react';

import { listRefs, resolveRefs, type RefListItem } from '../lib/api.js';
import { splitIdentifiers } from '../lib/claim-rank.js';

export function RefsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [refs, setRefs] = useState<RefListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void listRefs(projectId)
      .then((result) => {
        setRefs(result.refs);
        setTotal(result.stats.total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onResolve(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (projectId === null) return;
    const identifiers = splitIdentifiers(raw);
    if (identifiers.length === 0) {
      setError('先粘贴 DOI、PMID、PMCID、arXiv 或含 DOI 的链接。');
      return;
    }
    setBusy(true);
    try {
      const result = await resolveRefs(projectId, identifiers);
      const failed = result.outcomes.filter((o) => !o.ok).map((o) => o.reason ?? o.input);
      setRaw('');
      if (failed.length > 0) setError(failed.join('；'));
      else setError(null);
      reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (projectId === null) {
    return <p className="panel__hint">先选择或新建一个项目。</p>;
  }

  return (
    <section className="view" aria-labelledby="refs-heading">
      <h1 id="refs-heading">文献</h1>
      <p className="panel__hint">按 DOI 入库，不要凭记忆写标题。共 {total} 条。</p>
      <form className="refs-resolve" onSubmit={(event) => void onResolve(event)}>
        <label htmlFor="ref-identifiers">标识（DOI / PMID / 链接）</label>
        <textarea
          id="ref-identifiers"
          className="composer__input"
          rows={3}
          value={raw}
          disabled={busy}
          placeholder="10.1038/… 或 https://doi.org/…"
          onChange={(event) => {
            setRaw(event.target.value);
          }}
        />
        <button type="submit" className="btn" disabled={busy}>
          入库
        </button>
      </form>
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {refs === null ? (
        <p className="panel__hint">加载中…</p>
      ) : refs.length === 0 ? (
        <p className="panel__hint">还没有文献。把 DOI 贴到上面入库。</p>
      ) : (
        <ul className="ref-list">
          {refs.map((item) => (
            <li key={item.id} className="panel">
              <p className="panel__title">{item.title ?? item.cite}</p>
              <p className="panel__hint">
                {[item.firstAuthor, item.year, item.container].filter(Boolean).join(' · ')}
              </p>
              {item.doi !== null && <code>{item.doi}</code>}
              {item.retracted && <span className="artifact__warn">已撤稿</span>}
              {item.fulltextArtifactId !== null && <span className="panel__hint">已抓全文</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
