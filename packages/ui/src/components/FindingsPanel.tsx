/**
 * 审查发现面板（任务 #10，需求 11）。
 *
 * 三条界面上必须成立的语义：
 *
 * 1. **`resolved` 与 `dismissed` 不能合并成一个「关闭」按钮。** 前者是「问题确实
 *    存在且已修」，后者是「审查者看错了」。合并之后，事后回看无从判断这个项目里
 *    到底修过多少问题、误报率有多高——而那两件事的处理方式完全不同。
 * 2. **`reopen` 只对已自报待复核的发现有效。** agent 用 `mark_finding_addressed`
 *    自报之后状态是 `claimed-fixed`，用户不同意就打回。对 `open` 的发现调用会拿到
 *    冲突错误，所以按钮要按状态显隐，而不是让用户点了才报错。
 * 3. **审查模型 id 要显示。** 异厂商约束（需求 11.2）是 Reviewer 价值的前提，而它
 *    是否真的生效只有这一列能核查。降级（只有一家供应商可用）时也要显出来。
 *
 * ## 为什么 summary 与列表的过滤条件不同步
 *
 * `summary` 永远统计未关闭的发现，不受列表当前过滤影响。这是刻意的：用户切到
 * 「已解决」页签时，顶部那个「还有 2 条阻断」不该变成 0——它回答的是「现在能不能
 * 宣称完成」，与他正在翻哪一页无关。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  decideFinding,
  listFindings,
  listReviewerRuns,
  runReviewer,
  FINDING_CATEGORY_LABEL,
  FINDING_STATUS_LABEL,
  REVIEWER_TRIGGER_LABEL,
  type Finding,
  type FindingStatus,
  type FindingSummary,
  type ReviewerRun,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

const FILTERS: ReadonlyArray<{ id: FindingStatus | 'unresolved'; label: string }> = [
  { id: 'unresolved', label: '未关闭' },
  { id: 'open', label: '待处理' },
  { id: 'claimed-fixed', label: '待复核' },
  { id: 'resolved', label: '已解决' },
  { id: 'dismissed', label: '误报' },
];

function FindingCard({
  finding,
  onDecide,
  busy,
}: {
  finding: Finding;
  onDecide: (decision: 'resolve' | 'dismiss' | 'reopen', note: string) => void;
  busy: boolean;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const actionable = finding.status === 'open' || finding.status === 'claimed-fixed';

  return (
    <li className={`fcard fcard--${finding.severity}`}>
      <button
        type="button"
        className="fcard__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {/* 严重度不只靠颜色：FAIL 会打断 agent，WARN 不会，这个区别要有文字 */}
        <span className={`fcard__sev fcard__sev--${finding.severity}`}>
          {finding.severity === 'fail' ? '阻断' : '提示'}
        </span>
        <span className="fcard__cat">{FINDING_CATEGORY_LABEL[finding.category]}</span>
        <span className="fcard__title">{finding.title}</span>
        <span className={`fcard__status fcard__status--${finding.status}`}>
          {FINDING_STATUS_LABEL[finding.status]}
        </span>
      </button>

      {open && (
        <div className="fcard__body">
          {finding.detail !== null && <p className="fcard__detail">{finding.detail}</p>}

          {/*
            证据必须列出来。审查者引不到真实对象的发现在写入时就被拒了（需求 11.8），
            因此这里的每一条都能指到具体对象——列出来才让「可核查」这件事成立
          */}
          <div className="fcard__evidence">
            <span className="fcard__evidence-label">证据</span>
            <ul>
              {finding.evidence.map((e, i) => (
                <li key={`${e.kind}-${e.id}-${String(i)}`}>
                  <span className="fcard__evkind">{e.kind}</span>
                  <code>{e.id}</code>
                  {e.note === undefined ? '' : ` ${e.note}`}
                </li>
              ))}
            </ul>
          </div>

          {finding.addressedNote !== null && (
            <p className="fcard__addressed">
              <strong>{finding.status === 'claimed-fixed' ? 'agent 自报已修' : '处置说明'}</strong>
              {finding.addressedAt === null ? '' : `（${timeText(finding.addressedAt)}）`}：
              {finding.addressedNote}
            </p>
          )}

          <p className="fcard__meta">提出于 {timeText(finding.createdAt)}</p>

          {actionable ? (
            <div className="fcard__actions">
              <label htmlFor={`fnote-${finding.id}`}>说明（可选）</label>
              <input
                id={`fnote-${finding.id}`}
                type="text"
                value={note}
                placeholder="改了什么，或为什么判为误报"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="fcard__buttons">
                {/*
                  两个按钮语义不同，不能合并：resolved 是「问题存在且已修」，
                  dismissed 是「审查者看错了」。事后统计误报率靠的正是这个区分
                */}
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy}
                  onClick={() => onDecide('resolve', note)}
                  title="问题确实存在，已经修好了"
                >
                  确认已修
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={busy}
                  onClick={() => onDecide('dismiss', note)}
                  title="审查者判断有误，这不是问题"
                >
                  判为误报
                </button>
                {/* reopen 只对 claimed-fixed 有效，按状态显隐而不是让用户点了才报错 */}
                {finding.status === 'claimed-fixed' && (
                  <button
                    type="button"
                    className="btn btn--deny btn--small"
                    disabled={busy}
                    onClick={() => onDecide('reopen', note)}
                    title="不同意 agent 的自报修复，打回继续挡着"
                  >
                    打回
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="fcard__closed">
              这条已经{finding.status === 'resolved' ? '解决' : '判为误报'}，不再阻挡结论。
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function RunList({ runs }: { runs: ReviewerRun[] }): React.JSX.Element {
  if (runs.length === 0) {
    return <p className="sidepanel__hint">还没有审查记录。</p>;
  }
  return (
    <table className="fruns">
      <caption>
        审查记录。**模型 id 是异厂商约束的可核查凭据**（需求 11.2）——它必须与生成内容的
        模型来自不同厂商，只有一家可用时会显示为降级。
      </caption>
      <thead>
        <tr>
          <th scope="col">时间</th>
          <th scope="col">触发</th>
          <th scope="col">模型</th>
          <th scope="col">结果</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className={`fruns__row fruns__row--${run.status}`}>
            <td>{run.startedAt === null ? '—' : timeText(run.startedAt)}</td>
            <td>{REVIEWER_TRIGGER_LABEL[run.trigger]}</td>
            <td>
              {/* 确定性层单独跑时没有模型，后端填的是显式占位值而不是空串 */}
              <code>
                {run.modelId === 'none:deterministic-only' ? '仅确定性检查' : run.modelId}
              </code>
            </td>
            <td>
              <span className={`frun__status frun__status--${run.status}`}>
                {run.status === 'running'
                  ? '进行中'
                  : run.status === 'done'
                    ? '完成'
                    : run.status === 'degraded'
                      ? '降级'
                      : '失败'}
              </span>
              {run.summary !== null && <div className="frun__summary">{run.summary}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface FindingsPanelProps {
  projectId: string | null;
  conversationId: string | null;
  refreshKey: number;
}

export function FindingsPanel({
  projectId,
  conversationId,
  refreshKey,
}: FindingsPanelProps): React.JSX.Element {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [summary, setSummary] = useState<FindingSummary | null>(null);
  const [runs, setRuns] = useState<ReviewerRun[]>([]);
  const [filter, setFilter] = useState<FindingStatus | 'unresolved'>('unresolved');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (projectId === null || conversationId === null) {
      setFindings([]);
      setSummary(null);
      return;
    }
    setError(null);
    try {
      const [list, runList] = await Promise.all([
        listFindings(projectId, conversationId, { status: filter }),
        listReviewerRuns(projectId, conversationId),
      ]);
      setFindings(list.findings);
      setSummary(list.summary);
      setRuns(runList.runs);
    } catch (err) {
      setError(errorText(err));
    }
  }, [projectId, conversationId, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const decide = async (
    findingId: string,
    decision: 'resolve' | 'dismiss' | 'reopen',
    note: string,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await decideFinding(projectId ?? '', findingId, decision, note);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const requestReview = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await runReviewer(projectId ?? '', conversationId ?? '');
      /*
       * 审查是后台任务，这里拿不到结果。必须说清「已排队」而不是让按钮转圈——
       * 后端刻意不 await 审查完成（它要跑一次模型调用，挂在请求上会撞 IPC 超时，
       * 而那时的表现是「点了转半天然后报错」，审查其实跑完了）。
       */
      setNotice(
        result.merged
          ? '已排队。当前正有一次审查在跑，这次会合并进去，跑完后补一轮。'
          : '审查已在后台开始。完成后结果会自动出现在这里。',
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (projectId === null || conversationId === null) {
    return <p className="sidepanel__hint">先选一个会话。</p>;
  }

  return (
    <div className="findpanel">
      {summary !== null && (
        <div className="findpanel__summary">
          {/*
            这个统计永远针对未关闭的发现，不随下面的过滤变化。它回答的是
            「现在能不能宣称完成」，与用户正在翻哪一页无关
          */}
          <span className={summary.blocking > 0 ? 'is-blocking' : ''}>阻断 {summary.blocking}</span>
          <span>提示 {summary.warnings}</span>
          <span>待复核 {summary.claimedFixed}</span>
          {summary.blocking > 0 && (
            <span className="findpanel__blocked">有阻断级发现时不应宣称任务完成</span>
          )}
        </div>
      )}

      <div className="findpanel__bar">
        <div className="findpanel__filters" role="group" aria-label="按状态过滤">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`findpanel__filter ${filter === f.id ? 'is-current' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          disabled={busy}
          onClick={() => void requestReview()}
        >
          现在审查一次
        </button>
      </div>

      {notice !== null && (
        <p className="findpanel__notice" aria-live="polite">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="sidepanel__error" role="alert">
          {error}
        </p>
      )}

      {findings.length === 0 ? (
        <p className="sidepanel__hint">
          {filter === 'unresolved'
            ? '没有未关闭的发现。审查在每个回合结束后自动跑一次。'
            : '这个筛选下没有发现。'}
        </p>
      ) : (
        <ul className="findpanel__list">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              busy={busy}
              onDecide={(decision, note) => void decide(finding.id, decision, note)}
            />
          ))}
        </ul>
      )}

      <div className="findpanel__runs">
        <button
          type="button"
          className="findpanel__runs-toggle"
          aria-expanded={showRuns}
          onClick={() => setShowRuns(!showRuns)}
        >
          审查记录（{runs.length}）
        </button>
        {showRuns && <RunList runs={runs} />}
      </div>
    </div>
  );
}
