/**
 * 文献库。贴 DOI 或拖入 PDF 入库；可抓全文、附本地 PDF、删除。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  attachFulltext,
  deleteRef,
  exportRefs,
  fetchRefFulltext as fetchFulltext,
  listRefAssets,
  listRefDuplicates,
  listRefs,
  mergeRefs,
  resolveRefs,
  type RefAssetView,
  type RefDuplicatePair,
  type RefExportFormat,
  type RefFetchAttemptView,
  type RefListItem,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';
import { splitIdentifiers } from '../lib/claim-rank.js';
import type { PaperFocus } from '../lib/paper-context.js';

const FORM_LABEL = '贴 DOI 或拖入 PDF';
const EMPTY_HINT =
  '还没有文献。贴一条 DOI，或把 PDF 拖进来。会向 Crossref、OpenAlex、Semantic Scholar、PubMed、Europe PMC、DataCite 查询。';
const NO_TARGET = '先把 DOI 收进库里，再把 PDF 拖到那一条上';
/** IPC 帧 8MB；base64 膨胀约 4/3，再留信封余量。 */
const MAX_PDF_BYTES = Math.floor((8 * 1024 * 1024 * 3) / 4) - 4096;
const FILE_NAME_MAX = 255;

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('无法把文件读成 base64'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => {
      reject(new Error('读取文件失败'));
    };
    reader.readAsDataURL(file);
  });
}

function toFocus(item: RefListItem): PaperFocus {
  return {
    id: item.id,
    doi: item.doi,
    cite: item.cite,
    title: item.title,
    abstract: item.abstract,
  };
}

function firstFile(list: FileList | null): File | undefined {
  return list?.[0];
}

type AssetBundle = {
  readonly assets: readonly RefAssetView[];
  readonly attempts: readonly RefFetchAttemptView[];
};

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
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [lastResolvedId, setLastResolvedId] = useState<string | null>(null);
  const [assetsOpen, setAssetsOpen] = useState<string | null>(null);
  const [assetBundle, setAssetBundle] = useState<AssetBundle | null>(null);
  const [dupPairs, setDupPairs] = useState<readonly RefDuplicatePair[] | null>(null);
  const [dupMeta, setDupMeta] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<RefExportFormat>('bibtex');
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [toolBusy, setToolBusy] = useState(false);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void listRefs(projectId)
      .then((result) => {
        setRefs(result.refs);
        setTotal(result.stats.total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(errorText(err));
      });
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  function setRowError(id: string, message: string): void {
    setRowErrors((prev) => ({ ...prev, [id]: message }));
  }

  function clearRowError(id: string): void {
    setRowErrors((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

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
      const picked =
        result.outcomes.find((o) => o.ok && o.created && o.refId !== null) ??
        result.outcomes.find((o) => o.ok && o.refId !== null);
      if (picked !== undefined && picked.refId !== null) {
        setLastResolvedId(picked.refId);
        onSelect({
          id: picked.refId,
          doi: null,
          cite: picked.cite ?? picked.input,
          title: picked.cite,
          abstract: null,
        });
      }
      reload();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFetch(refId: string): Promise<void> {
    if (projectId === null) return;
    setRowBusy(refId);
    try {
      const result = await fetchFulltext(projectId, refId);
      if (!result.ok) {
        setRowError(refId, result.summary);
        return;
      }
      clearRowError(refId);
      reload();
    } catch (err: unknown) {
      setRowError(refId, errorText(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function onDelete(refId: string): Promise<void> {
    if (projectId === null) return;
    setRowBusy(refId);
    try {
      await deleteRef(projectId, refId);
      setPendingDeleteId(null);
      clearRowError(refId);
      reload();
    } catch (err: unknown) {
      setRowError(refId, errorText(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function onShowAssets(refId: string): Promise<void> {
    if (projectId === null) return;
    if (assetsOpen === refId) {
      setAssetsOpen(null);
      return;
    }
    setRowBusy(refId);
    try {
      const result = await listRefAssets(projectId, refId);
      setAssetBundle({ assets: result.assets, attempts: result.attempts });
      setAssetsOpen(refId);
      clearRowError(refId);
    } catch (err: unknown) {
      setRowError(refId, errorText(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function attachPdf(refId: string | null, file: File | undefined): Promise<void> {
    if (projectId === null) return;
    if (refId === null) {
      setError(NO_TARGET);
      return;
    }
    if (file === undefined) return;
    if (!isPdfFile(file)) {
      setRowError(refId, '只接受 PDF。文件名须以 .pdf 结尾，或 MIME 为 application/pdf。');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setRowError(
        refId,
        `文件太大（${String(file.size)} 字节）。IPC 帧上限 8MB，base64 编码后会更大，请换一份更小的 PDF。`,
      );
      return;
    }
    if (file.name.length > FILE_NAME_MAX) {
      setRowError(refId, `文件名超过 ${String(FILE_NAME_MAX)} 字符（schema 上限）。`);
      return;
    }
    setRowBusy(refId);
    try {
      const contentBase64 = await fileToBase64(file);
      await attachFulltext(projectId, refId, { fileName: file.name, contentBase64 });
      clearRowError(refId);
      reload();
    } catch (err: unknown) {
      setRowError(refId, errorText(err));
    } finally {
      setRowBusy(null);
    }
  }

  function allowDrop(event: React.DragEvent): void {
    event.preventDefault();
  }

  async function onScanDupes(): Promise<void> {
    if (projectId === null) return;
    setToolBusy(true);
    try {
      const result = await listRefDuplicates(projectId);
      setDupPairs(result.pairs);
      const extra = result.truncated ? '（结果已截断）' : '';
      setDupMeta(`扫描 ${String(result.scanned)} / ${String(result.total)} 条${extra}`);
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setToolBusy(false);
    }
  }

  async function onMerge(keepId: string, dropId: string): Promise<void> {
    if (projectId === null) return;
    setToolBusy(true);
    try {
      await mergeRefs(projectId, keepId, dropId);
      setError(null);
      const result = await listRefDuplicates(projectId);
      setDupPairs(result.pairs);
      reload();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setToolBusy(false);
    }
  }

  async function onExport(): Promise<void> {
    if (projectId === null) return;
    setToolBusy(true);
    try {
      const result = await exportRefs(projectId, { format: exportFormat });
      const artifact =
        result.artifactId === null ? '未落成制品' : `制品 ${result.artifactId}`;
      const missing =
        result.missingIds.length === 0 ? '' : `；缺 ${String(result.missingIds.length)} 个指定 id`;
      const warnings = result.warningText.trim() === '' ? '' : `。${result.warningText}`;
      setExportNote(
        `已导出 ${String(result.entryCount)} 条为 ${result.filename}（${artifact}${missing}）。返回值含 content，界面不展开。${warnings}`,
      );
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setToolBusy(false);
    }
  }

  if (projectId === null) {
    return <p className="panel__hint">先选择或新建一个项目。</p>;
  }

  const empty = refs !== null && refs.length === 0;
  const attachTarget = selectedId ?? lastResolvedId;

  return (
    <section className="view" aria-labelledby="refs-heading">
      <h1 id="refs-heading">文献</h1>
      <p className="panel__hint">
        {empty ? EMPTY_HINT : `贴 DOI 或拖入 PDF。共 ${String(total)} 条。`}
      </p>
      <div className="view__toolbar">
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || toolBusy}
          onClick={() => void onScanDupes()}
        >
          查重
        </button>
        <label htmlFor="ref-export-format">导出格式</label>
        <select
          id="ref-export-format"
          value={exportFormat}
          disabled={busy || toolBusy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'bibtex' || value === 'csl-json' || value === 'ris') {
              setExportFormat(value);
            }
          }}
        >
          <option value="bibtex">BibTeX</option>
          <option value="csl-json">CSL-JSON</option>
          <option value="ris">RIS</option>
        </select>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || toolBusy}
          onClick={() => void onExport()}
        >
          导出
        </button>
      </div>
      {exportNote !== null && <p className="panel__hint">{exportNote}</p>}
      {dupMeta !== null && <p className="panel__hint">{dupMeta}</p>}
      {dupPairs !== null && dupPairs.length === 0 && (
        <p className="panel__hint">没有重复条目。</p>
      )}
      {dupPairs !== null && dupPairs.length > 0 && (
        <ul className="ref-list">
          {dupPairs.map((pair) => (
            <li key={`${pair.keepId}-${pair.dropId}`} className="ref-card">
              <span className="ref-card__title">
                {pair.verdict === 'same' ? '同一篇' : '可能重复'} · {pair.keepCite}
              </span>
              <span className="ref-card__meta">{pair.dropCite}</span>
              <p className="panel__hint">{pair.reason}</p>
              <button
                type="button"
                className="btn btn--small"
                disabled={toolBusy}
                onClick={() => void onMerge(pair.keepId, pair.dropId)}
              >
                合并到这一条
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="refs-resolve"
        onSubmit={(event) => void onResolve(event)}
        onDragOver={allowDrop}
        onDrop={(event) => {
          event.preventDefault();
          void attachPdf(attachTarget, firstFile(event.dataTransfer.files));
        }}
      >
        <label htmlFor="ref-identifiers">{FORM_LABEL}</label>
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
      ) : empty ? (
        <div
          className="ref-card empty-action"
          onDragOver={allowDrop}
          onDrop={(event) => {
            event.preventDefault();
            void attachPdf(attachTarget, firstFile(event.dataTransfer.files));
          }}
        >
          <p className="panel__hint">{NO_TARGET}</p>
          <input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="附 PDF"
            onChange={(event) => {
              const file = firstFile(event.target.files);
              event.target.value = '';
              void attachPdf(attachTarget, file);
            }}
          />
        </div>
      ) : (
        <ul className="ref-list">
          {refs.map((item) => (
            <li
              key={item.id}
              className={`ref-card ${selectedId === item.id ? 'is-current' : ''}`}
              onDragOver={allowDrop}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void attachPdf(item.id, firstFile(event.dataTransfer.files));
              }}
            >
              <button
                type="button"
                className="ref-card__select"
                aria-pressed={selectedId === item.id}
                onClick={() => {
                  onSelect(toFocus(item));
                }}
              >
                <span className="ref-card__title">{item.title ?? item.cite}</span>
                <span className="ref-card__meta">
                  {[item.firstAuthor, item.year, item.container].filter(Boolean).join(' · ')}
                </span>
                {item.doi !== null && <code className="ref-card__doi">{item.doi}</code>}
              </button>
              <div className="ref-card__flags">
                {item.retracted && <span className="artifact__warn">已撤稿</span>}
                {item.fulltextArtifactId !== null && (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={rowBusy === item.id}
                    onClick={() => void onShowAssets(item.id)}
                  >
                    已抓全文
                  </button>
                )}
              </div>
              <button
                type="button"
                className="btn btn--small"
                disabled={rowBusy === item.id}
                onClick={() => void onFetch(item.id)}
              >
                {rowBusy === item.id ? '处理中…' : '抓全文'}
              </button>
              {pendingDeleteId === item.id ? (
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={rowBusy === item.id}
                  onClick={() => void onDelete(item.id)}
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={rowBusy === item.id}
                  onClick={() => {
                    setPendingDeleteId(item.id);
                  }}
                >
                  删除
                </button>
              )}
              <input
                type="file"
                accept="application/pdf,.pdf"
                aria-label="附 PDF"
                disabled={rowBusy === item.id}
                onChange={(event) => {
                  const file = firstFile(event.target.files);
                  event.target.value = '';
                  void attachPdf(item.id, file);
                }}
              />
              {rowErrors[item.id] !== undefined && (
                <p className="panel__error" role="alert">
                  {rowErrors[item.id]}
                </p>
              )}
              {assetsOpen === item.id && assetBundle !== null && (
                <div>
                  {assetBundle.assets.length === 0 ? (
                    <p className="panel__hint">还没有全文资源。</p>
                  ) : (
                    assetBundle.assets.map((asset) => (
                      <p key={asset.id} className="panel__hint">
                        {asset.kind}
                        {asset.label === null ? '' : ` · ${asset.label}`}
                        {asset.originPath === null ? '' : ` · ${asset.originPath}`}
                      </p>
                    ))
                  )}
                  {assetBundle.attempts.map((attempt) => (
                    <p key={attempt.id} className="panel__hint">
                      {attempt.source}：{attempt.outcome}
                      {attempt.detail === null ? '' : ` —— ${attempt.detail}`}
                    </p>
                  ))}
                </div>
              )}
              {selectedId === item.id && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onExtractClaims(toFocus(item));
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
