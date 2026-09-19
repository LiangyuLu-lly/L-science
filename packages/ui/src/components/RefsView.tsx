/**
 * 文献库。后端 ref.list 早已存在；没有这一页，研究者只能靠对话里的工具卡片。
 */

import { useCallback, useEffect, useState } from 'react';

import { listRefs, type RefListItem } from '../lib/api.js';

export function RefsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [refs, setRefs] = useState<RefListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

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

  if (projectId === null) {
    return <p className="panel__hint">先选择或新建一个项目。</p>;
  }

  return (
    <section className="view" aria-labelledby="refs-heading">
      <h1 id="refs-heading">文献</h1>
      <p className="panel__hint">按 DOI 入库，不要凭记忆写标题。共 {total} 条。</p>
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {refs === null ? (
        <p className="panel__hint">加载中…</p>
      ) : refs.length === 0 ? (
        <p className="panel__hint">还没有文献。在会话里让助手 resolve DOI，或把标识发给它。</p>
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
              {item.fulltextArtifactId !== null && (
                <span className="panel__hint">已抓全文</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
