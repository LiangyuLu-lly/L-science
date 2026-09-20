/**
 * 文献库。粘贴 DOI/PMID/链接即可入库，不必先开对话。
 */

import { useCallback, useEffect, useState } from 'react';

import { listRefs, resolveRefs, type RefListItem } from '../lib/api.js';
import { splitIdentifiers } from '../lib/claim-rank.js';
import type { PaperFocus } from '../lib/paper-context.js';

export function RefsView({
  projectId,
  selectedId,
  onSelect,
  onExtractClaims,
}: {
  projectId: string | null;
  selectedId: string | null;
  onSelect: (ref: PaperFocus) => void;
  onExtractClaims: (ref: PaperFocus) => void;
}): React.JSX.Element {
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
      const failed = result.outcomes
        .filter((o) => !o.ok)
        .map((o) => {
          const attempts = (o.attempts ?? [])
            .map((a) => `${a.source}${a.ok ? ' 成功' : `：${a.reason ?? '失败'}`}`)
            .join('；');
          const head = o.reason ?? o.input;
          return attempts === '' ? head : `${head}（${attempts}）`;
        });
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

  const empty = refs !== null && refs.length === 0;

  return (
    <section className="view" aria-labelledby="refs-heading">
      <h1 id="refs-heading">文献</h1>
      <p className="panel__hint">
        {empty
          ? '库是空的。把 DOI 贴进下面这个框入库，默认只问 Crossref。'
          : `按 DOI 入库，不要凭记忆写标题。共 ${String(total)} 条。`}
      </p>
      <form className="refs-resolve" onSubmit={(event) => void onResolve(event)}>
        <label htmlFor="ref-identifiers">贴 DOI / PMID / 链接</label>
        <textarea
          id="ref-identifiers"
          className="composer__input"
          rows={empty ? 8 : 3}
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
      ) : refs.length === 0 ? null : (
        <ul className="ref-list">
          {refs.map((item) => (
            <li key={item.id} className={`panel ${selectedId === item.id ? 'is-current' : ''}`}>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  onSelect({
                    id: item.id,
                    doi: item.doi,
                    cite: item.cite,
                    title: item.title,
                  });
                }}
              >
                {item.title ?? item.cite}
              </button>
              <p className="panel__hint">
                {[item.firstAuthor, item.year, item.container].filter(Boolean).join(' · ')}
              </p>
              {item.doi !== null && <code>{item.doi}</code>}
              {item.retracted && <span className="artifact__warn">已撤稿</span>}
              {item.fulltextArtifactId !== null && <span className="panel__hint">已抓全文</span>}
              {selectedId === item.id && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onExtractClaims({
                      id: item.id,
                      doi: item.doi,
                      cite: item.cite,
                      title: item.title,
                    });
                  }}
                >
                  从本篇抽断言
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
