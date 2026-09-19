/**
 * 制品视图（任务 9.3，需求 6.2、6.4、6.6）。
 *
 * 列表上直接标出「没有可复现血缘」，而不是让用户逐个点进去才发现。一张缺血缘的图
 * 在投稿前才被发现是最糟的时机——那时代码环境可能已经变了，补不回来。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  exportReproPack,
  listArtifactVersions,
  listArtifacts,
  loadLineage,
  restoreArtifact,
  type ArtifactSummary,
  type ArtifactVersionInfo,
  type LineageNode,
} from '../lib/api.js';
import { formatReproManifest } from '../lib/repro-manifest.js';

const KIND_LABEL: Record<string, string> = {
  image: '图像',
  table: '表格',
  document: '文档',
  data: '数据',
  code: '代码',
  other: '其他',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 血缘链。按深度缩进——层级关系比一张力导向图更容易读，也不需要额外依赖。 */
function LineageList({
  nodes,
  emptyHint,
}: {
  nodes: readonly LineageNode[];
  emptyHint: string;
}): React.JSX.Element {
  if (nodes.length === 0) return <p className="lineage__empty">{emptyHint}</p>;

  return (
    <ul className="lineage">
      {nodes.map((node) => (
        <li
          key={node.versionId}
          className="lineage__node"
          style={{ marginInlineStart: `${String((node.depth - 1) * 16)}px` }}
        >
          <span className="lineage__depth" aria-label={`第 ${String(node.depth)} 层`}>
            {'└'.padStart(node.depth, ' ')}
          </span>
          <code className="lineage__file">{node.filename}</code>
          <span className="lineage__version">v{node.versionNo}</span>
          {node.relation !== null && <span className="lineage__relation">{node.relation}</span>}
        </li>
      ))}
    </ul>
  );
}

function VersionDetail({
  projectId,
  version,
}: {
  projectId: string;
  version: ArtifactVersionInfo;
}): React.JSX.Element {
  const [lineage, setLineage] = useState<{
    ancestors: LineageNode[];
    descendants: LineageNode[];
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    void loadLineage(projectId, version.id).then((result) => {
      if (!disposed) setLineage(result);
    });
    return () => {
      disposed = true;
    };
  }, [projectId, version.id]);

  const lin = version.codeLineage;

  return (
    <div className="version">
      <header className="version__head">
        <span className="version__no">v{version.versionNo}</span>
        <span className="version__time">{formatTime(version.createdAt)}</span>
        {lin !== null && (
          <span className={`version__repro version__repro--${lin.reproducible ? 'yes' : 'no'}`}>
            {lin.reproducible ? '血缘完整' : '血缘不完整'}
          </span>
        )}
      </header>

      {lin?.gap !== null && lin?.gap !== undefined && (
        <p className="version__gap" role="note">
          {lin.gap}
        </p>
      )}

      {lin?.code !== null && lin?.code !== undefined && lin.code !== '' && (
        <details className="version__code">
          <summary>生成代码{lin.language === null ? '' : `（${lin.language}）`}</summary>
          <pre>
            <code>{lin.code}</code>
          </pre>
        </details>
      )}

      <details className="version__lineage">
        <summary>血缘</summary>
        {lineage === null ? (
          <p>加载中…</p>
        ) : (
          <>
            <h5>输入（向上追溯）</h5>
            <LineageList nodes={lineage.ancestors} emptyHint="没有记录输入版本。" />
            <h5>派生产物（向下追溯）</h5>
            <LineageList nodes={lineage.descendants} emptyHint="还没有基于它派生的产物。" />
          </>
        )}
      </details>

      <p className="version__sha">
        内容哈希 <code>{version.blobSha256.slice(0, 16)}…</code>
      </p>
    </div>
  );
}

function ArtifactRow({
  projectId,
  artifact,
  onRestored,
}: {
  projectId: string;
  artifact: ArtifactSummary;
  onRestored: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<ArtifactVersionInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    // 懒加载版本：一个项目可能有几百个制品，一次全查会明显拖慢列表
    if (next && versions === null) {
      void listArtifactVersions(projectId, artifact.id).then((r) => setVersions(r.versions));
    }
  }, [expanded, versions, projectId, artifact.id]);

  const restore = async (): Promise<void> => {
    setBusy(true);
    try {
      await restoreArtifact(projectId, artifact.id);
      onRestored();
    } finally {
      setBusy(false);
    }
  };

  const deleted = artifact.deletedAt !== null;

  return (
    <li className={`artifact ${deleted ? 'artifact--deleted' : ''}`}>
      <div className="artifact__head">
        <button
          type="button"
          className="artifact__toggle"
          aria-expanded={expanded}
          onClick={toggle}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <code className="artifact__name">{artifact.filename}</code>
        </button>

        <span className="artifact__kind">{KIND_LABEL[artifact.kind ?? 'other']}</span>
        <span className="artifact__versions">{artifact.versionCount} 个版本</span>

        {/* 血缘缺口在列表层就要可见。投稿前才发现是最糟的时机 */}
        {!artifact.reproducible && !deleted && (
          <span className="artifact__warn" title="缺少可复现血缘">
            血缘不完整
          </span>
        )}

        {deleted && (
          <>
            <span className="artifact__deleted-tag">已删除</span>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void restore()}
              disabled={busy}
            >
              恢复
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div className="artifact__body">
          {versions === null ? (
            <p>加载中…</p>
          ) : (
            // 倒序：最新版本在上，用户多数时候关心它
            [...versions]
              .reverse()
              .map((v) => <VersionDetail key={v.id} projectId={projectId} version={v} />)
          )}
        </div>
      )}
    </li>
  );
}

export function ArtifactsView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void listArtifacts(projectId, includeDeleted)
      .then((r) => {
        setArtifacts(r.artifacts);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId, includeDeleted]);

  useEffect(reload, [reload]);

  if (projectId === null) {
    return <p className="view__empty">请先选择一个项目。</p>;
  }

  const irreproducible = (artifacts ?? []).filter((a) => !a.reproducible && a.deletedAt === null);

  return (
    <div className="view">
      <div className="view__toolbar">
        <label className="view__filter">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          显示已删除
        </label>
        <button type="button" className="btn btn--small" onClick={reload}>
          刷新
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={artifacts === null}
          onClick={() => {
            if (artifacts === null) return;
            const text = formatReproManifest({
              projectId,
              exportedAt: Date.now(),
              artifacts,
            });
            void navigator.clipboard.writeText(text);
          }}
        >
          复制可复现清单
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            void exportReproPack(projectId)
              .then((pack) => {
                setError(`已打包 ${String(pack.fileCount)} 个文件到 ${pack.path}`);
                const reveal = window.lscience?.revealPath;
                if (reveal !== undefined) void reveal(pack.path);
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          导出可复现 zip
        </button>
      </div>

      {error !== null && <p className="view__error">{error}</p>}

      {/* 汇总提示：逐条看容易漏，一个总数会让人真的去处理 */}
      {irreproducible.length > 0 && (
        <p className="view__notice" role="note">
          有 {irreproducible.length} 个制品缺少可复现血缘。Reviewer 会就此提出发现——
          这些产物无法回答「它是怎么算出来的」。
        </p>
      )}

      {artifacts === null ? (
        <p>加载中…</p>
      ) : artifacts.length === 0 ? (
        <p className="view__empty">还没有制品。用 save_artifacts 工具把工作区的文件提升为制品。</p>
      ) : (
        <ul className="artifacts">
          {artifacts.map((a) => (
            <ArtifactRow key={a.id} projectId={projectId} artifact={a} onRestored={reload} />
          ))}
        </ul>
      )}
    </div>
  );
}
