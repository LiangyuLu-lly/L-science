/**
 * Claim Ledger。未关闭与无证据的断言必须在列表层可见，且每条都能动手处理。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  closeClaim,
  confirmClaim,
  deleteClaim,
  getClaim,
  listClaims,
  reopenClaim,
  unbindClaim,
  verifyClaim,
  type ClaimDetail,
  type ClaimEvidenceView,
  type ClaimListItem,
  type ClaimListSummary,
} from '../lib/api.js';
import { rankClaims } from '../lib/claim-rank.js';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  open: '待核验',
  supported: '证据支持',
  insufficient: '证据不足',
  refuted: '证据矛盾',
  retracted: '已撤回',
  dismissed: '无需核验',
};

const ORIGIN_LABEL: Readonly<Record<string, string>> = {
  extracted: '自动抽取',
  model: '模型登记',
  user: '用户登记',
};

const OPEN_STATUSES: ReadonlySet<string> = new Set(['open', 'insufficient', 'refuted']);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['retracted', 'dismissed']);

type RowAction = 'confirm' | 'verify' | 'close' | 'reopen' | 'unbind' | 'delete';

function formatEvidence(item: ClaimEvidenceView): string {
  return `${item.kind}:${item.ref}`;
}

function evidenceLine(detail: ClaimDetail | undefined, unsupported: boolean): string {
  if (unsupported || detail === undefined || detail.evidence.length === 0) return '无证据';
  return detail.evidence.map(formatEvidence).join(' · ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ClaimsView({
  projectId,
  onGoToRefs,
}: {
  projectId: string | null;
  onGoToRefs?: () => void;
}): React.JSX.Element {
  const [claims, setClaims] = useState<ClaimListItem[] | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, ClaimDetail>>>({});
  const [summary, setSummary] = useState<ClaimListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (projectId === null) return;
    try {
      const result = await listClaims(projectId);
      const pairs = await Promise.all(
        result.claims.map(async (item) => {
          const { claim } = await getClaim(projectId, item.id);
          return [item.id, claim] as const;
        }),
      );
      setClaims(result.claims);
      setSummary(result.summary);
      setDetails(Object.fromEntries(pairs));
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runAction(claimId: string, kind: RowAction): Promise<void> {
    if (projectId === null) return;
    setBusyId(claimId);
    setPendingDeleteId(null);
    setError(null);
    try {
      switch (kind) {
        case 'confirm':
          await confirmClaim(projectId, claimId);
          break;
        case 'verify': {
          const detail = details[claimId] ?? (await getClaim(projectId, claimId)).claim;
          const first = detail.evidence[0];
          if (first === undefined) {
            throw new Error('没有可核验的证据。先绑定 DOI 或文献条目。');
          }
          await verifyClaim(projectId, claimId, {
            evidenceKind: first.kind,
            evidenceRef: first.ref,
            verdict: 'supports',
          });
          break;
        }
        case 'close':
          await closeClaim(projectId, claimId, { status: 'dismissed', note: '用户关闭' });
          break;
        case 'reopen':
          await reopenClaim(projectId, claimId);
          break;
        case 'unbind': {
          const detail = details[claimId] ?? (await getClaim(projectId, claimId)).claim;
          if (detail.evidence.length === 0) {
            throw new Error('这条断言没有绑定证据。');
          }
          for (const ev of detail.evidence) {
            await unbindClaim(projectId, claimId, {
              evidenceKind: ev.kind,
              evidenceRef: ev.ref,
            });
          }
          break;
        }
        case 'delete':
          await deleteClaim(projectId, claimId);
          setSelectedId((current) => (current === claimId ? null : current));
          break;
        default: {
          const _never: never = kind;
          throw new Error(_never);
        }
      }
      await reload();
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (projectId === null) {
    return <p className="panel__hint">先选择或新建一个项目。</p>;
  }

  const selected = selectedId === null ? undefined : details[selectedId];

  return (
    <section className="view" aria-labelledby="claims-heading">
      <h1 id="claims-heading">断言</h1>
      {summary !== null && (
        <p className="panel__hint">
          共 {summary.total} 条，未关闭 {summary.unresolved}，无证据 {summary.unsupported}，矛盾{' '}
          {summary.refuted}。先处理无证据条目。
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
        <div className="ledger">
          <div className="ledger__empty empty-action">
            <p className="panel__hint">
              还没有断言。每条必须绑 DOI 或页码，不要凭记忆写。
            </p>
            {onGoToRefs !== undefined && (
              <button type="button" className="btn" onClick={onGoToRefs}>
                去文献选一篇并抽断言
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="ledger">
          <ul className="ledger__list">
            {rankClaims(claims).map((item) => {
              const detail = details[item.id];
              const busy = busyId === item.id;
              const closed = CLOSED_STATUSES.has(item.status);
              const bound = !item.unsupported && detail !== undefined && detail.evidence.length > 0;
              const markers: string[] = [];
              if (item.unsupported) markers.push('无证据');
              if (OPEN_STATUSES.has(item.status)) markers.push('未关闭');
              return (
                <li
                  key={item.id}
                  className={`ledger__row${selectedId === item.id ? ' is-selected' : ''}`}
                >
                  <button
                    type="button"
                    className="ledger__select"
                    aria-pressed={selectedId === item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                    }}
                  >
                    <p className="ledger__text">{item.text}</p>
                    <p className="ledger__meta">
                      {STATUS_LABEL[item.status] ?? item.status}
                      {markers.length > 0 ? ` · ${markers.join(' · ')}` : ''}
                      {` · ${ORIGIN_LABEL[item.origin] ?? item.origin}`}
                    </p>
                    <p className="ledger__evidence">
                      {evidenceLine(detail, item.unsupported)}
                    </p>
                    {detail?.evidence.some((ev) => ev.note !== null && ev.note !== '') === true && (
                      <p className="panel__hint">
                        {detail.evidence.find((ev) => ev.note !== null && ev.note !== '')?.note}
                      </p>
                    )}
                  </button>
                  <div className="ledger__actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void runAction(item.id, 'confirm')}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void runAction(item.id, 'verify')}
                    >
                      核验
                    </button>
                    {closed ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runAction(item.id, 'reopen')}
                      >
                        重开
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runAction(item.id, 'close')}
                      >
                        关闭
                      </button>
                    )}
                    {bound && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runAction(item.id, 'unbind')}
                      >
                        解绑证据
                      </button>
                    )}
                    {pendingDeleteId === item.id ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runAction(item.id, 'delete')}
                      >
                        确认删除
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setPendingDeleteId(item.id);
                        }}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <aside className="ledger__pane" aria-label="证据">
            {selected === undefined ? (
              <p className="panel__hint">点一条断言，证据会开在这里。</p>
            ) : selected.evidence.length === 0 ? (
              <div className="ledger__empty empty-action">
                <p className="panel__hint">这条没有证据。先去文献绑 DOI 或页码。</p>
                {onGoToRefs !== undefined && (
                  <button type="button" className="btn" onClick={onGoToRefs}>
                    去文献选一篇并抽断言
                  </button>
                )}
              </div>
            ) : (
              <ul className="ledger__evidence-list">
                {selected.evidence.map((ev) => (
                  <li key={`${ev.kind}:${ev.ref}`} className="ledger__evidence-item">
                    <code>{formatEvidence(ev)}</code>
                    {ev.locator !== null && <span className="panel__hint">{ev.locator}</span>}
                    {ev.note !== null && ev.note !== '' && (
                      <p className="panel__hint">{ev.note}</p>
                    )}
                    {ev.quote !== null && <p className="ledger__quote">{ev.quote}</p>}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
