/**
 * 路由决策面板（任务 11.11，需求 7.6、7.14）。
 *
 * 这个平台的核心差异化是「按任务选最合适的模型」。一个不可解释的自动选择等于
 * 让用户把判断权交出去却看不到依据——他既无法信任它，也无法纠正它。因此面板
 * 要同时回答四个问题：
 *
 * - 选了谁，为什么（理由 + 与次选的差距来自哪一项）
 * - 其他候选各自得了多少分，差在哪
 * - 谁被排除了，为什么，怎么补救
 * - 我不同意的话怎么改（覆盖权重、强制指定），改了会变成什么（试算）
 *
 * 试算刻意不带随机探索，否则同样的输入每次给不同结果，用户无从判断自己调的
 * 权重起了什么作用。
 */

import { useCallback, useEffect, useState } from 'react';

import { formatCost } from './UsagePanel.js';
import {
  loadRoutingHistory,
  previewRouting,
  sendFeedback,
  STRENGTH_LABEL,
  TASK_LABEL,
  type FeedbackSignal,
  type RoutingCandidate,
  type RoutingDecision,
  type RoutingOverride,
  type RoutingPreview,
  type StrengthKey,
  type TaskType,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

const STRENGTH_KEYS = Object.keys(STRENGTH_LABEL) as StrengthKey[];
const TASK_TYPES = Object.keys(TASK_LABEL) as TaskType[];

/** 纯信息项：它们不参与加总，只是把预估值摆出来给人看。 */
const INFORMATIONAL = new Set(['预估成本', '预估耗时毫秒']);

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    return [err.message, err.detail, err.remediation].filter((s) => s !== undefined).join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

/** 得分项的显示值。负项保留符号，信息项按各自单位格式化。 */
function formatBreakdownValue(key: string, value: number): string {
  if (key === '预估成本') return formatCost(value);
  if (key === '预估耗时毫秒') return `${String(Math.round(value))} ms`;
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

/**
 * 全候选得分对比表（需求 7.6）。
 *
 * 只显示第一名的得分构成是不够的：用户要判断的是「为什么不是第二名」，而这个
 * 问题只有把两列摆在一起才能回答。列按得分降序，行是全部出现过的得分项。
 */
function ScoreMatrix({
  decision,
  candidates,
}: {
  decision: RoutingDecision;
  candidates: readonly RoutingCandidate[];
}): React.JSX.Element {
  if (decision.scores.length === 0) return <p className="view__empty">没有进入打分阶段的候选。</p>;

  const byId = new Map(candidates.map((c) => [c.id, c]));

  // 行的顺序按第一名的键顺序，再补上只在其他候选里出现的项（例如「本地偏好」
  // 只在本地模型上出现）
  const rows: string[] = [];
  for (const score of decision.scores) {
    for (const key of Object.keys(score.breakdown)) {
      if (!rows.includes(key)) rows.push(key);
    }
  }
  const scored = rows.filter((k) => !INFORMATIONAL.has(k));
  const info = rows.filter((k) => INFORMATIONAL.has(k));

  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <caption>多模型对照：各候选的得分构成（按总分降序）</caption>
        <thead>
          <tr>
            <th scope="col">项</th>
            {decision.scores.map((s) => {
              const c = byId.get(s.modelId);
              return (
                <th
                  key={s.modelId}
                  scope="col"
                  className={s.modelId === decision.chosenModelId ? 'matrix__winner' : ''}
                >
                  <code>{s.modelId}</code>
                  {c !== undefined && (
                    <span className="matrix__meta">{c.local ? '本机' : c.providerId}</span>
                  )}
                  {s.modelId === decision.chosenModelId && (
                    <span className="matrix__chosen">选中</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <tr className="matrix__total">
            <th scope="row">总分</th>
            {decision.scores.map((s) => (
              <td key={s.modelId}>{s.total.toFixed(1)}</td>
            ))}
          </tr>
          {scored.map((key) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              {decision.scores.map((s) => {
                const value = s.breakdown[key];
                return (
                  <td key={s.modelId} className={value === undefined ? 'matrix__absent' : ''}>
                    {/* 缺项与 0 分是两件事：「本地偏好」在云端模型上是不适用，
                        不是拿了 0 分 */}
                    {value === undefined ? '—' : formatBreakdownValue(key, value)}
                  </td>
                );
              })}
            </tr>
          ))}
          {info.map((key) => (
            <tr key={key} className="matrix__info">
              <th scope="row">
                {key}
                <span className="matrix__info-tag">仅供参考</span>
              </th>
              {decision.scores.map((s) => {
                const value = s.breakdown[key];
                return (
                  <td key={s.modelId}>
                    {value === undefined ? '—' : formatBreakdownValue(key, value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 被排除的候选及原因（需求 7.4、7.6）。 */
function ExcludedList({ decision }: { decision: RoutingDecision }): React.JSX.Element | null {
  if (decision.excluded.length === 0) return null;

  // 按原因分组，最主要的原因排前面——这与后端报告的排序逻辑一致
  const groups = new Map<string, typeof decision.excluded>();
  for (const item of decision.excluded) {
    const key = item.reasonText ?? item.reason;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => b.length - a.length);

  return (
    <section className="excluded">
      <h4 className="excluded__title">被排除的候选（{decision.excluded.length} 个）</h4>
      <ul className="excluded__groups">
        {ordered.map(([label, items]) => (
          <li key={label} className="excluded__group">
            <p className="excluded__reason">
              {/*
                文案由路由层随决策给出。这里不维护原因码到文案的映射表：
                新增一种排除原因时会漏改，而漏改的表现是界面上冒出英文原因码
              */}
              {label}
              <span className="excluded__count">{items.length} 个</span>
            </p>
            <ul className="excluded__models">
              {items.map((item) => (
                <li key={item.modelId}>
                  <code>{item.modelId}</code>
                  {item.detail !== undefined && (
                    <span className="excluded__detail">{item.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 一次决策的完整展示。
 *
 * 导出给会话流里的决策卡片复用：同一次决策在两处显示不同的信息量会让用户以为
 * 是两件事。
 */
export function DecisionDetail({
  decision,
  candidates = [],
}: {
  decision: RoutingDecision;
  candidates?: readonly RoutingCandidate[];
}): React.JSX.Element {
  const winner = decision.scores[0];
  const estCost = winner?.breakdown['预估成本'];
  const estLatency = winner?.breakdown['预估耗时毫秒'];

  return (
    <div className="ddetail">
      <p className="ddetail__reason">{decision.reason}</p>

      {(estCost !== undefined || estLatency !== undefined) && (
        <p className="ddetail__estimate">
          {estCost !== undefined && (
            <span>
              预估成本 <strong>{formatCost(estCost)}</strong>
            </span>
          )}
          {estLatency !== undefined && (
            <span>
              预估耗时 <strong>{Math.round(estLatency)} ms</strong>
            </span>
          )}
          {/* 说清楚这是估算，避免被当成账单 */}
          <span className="ddetail__hint">按预计 token 数估算，实际计费见用量面板</span>
        </p>
      )}

      <ScoreMatrix decision={decision} candidates={candidates} />
      <ExcludedList decision={decision} />
    </div>
  );
}

/** 权重滑块组。滑到 0 是有意义的操作，因此覆盖是替换而非合并。 */
function WeightEditor({
  weights,
  overrides,
  onChange,
}: {
  /** 当前生效的权重（未覆盖时是任务预设）。 */
  weights: Partial<Record<StrengthKey, number>>;
  overrides: Partial<Record<StrengthKey, number>> | undefined;
  onChange: (next: Partial<Record<StrengthKey, number>> | undefined) => void;
}): React.JSX.Element {
  const active = overrides ?? weights;

  const setOne = (key: StrengthKey, value: number): void => {
    /*
     * 第一次拖动任何一个滑块时，把当前生效的整张权重表复制成覆盖的初值。
     *
     * 只放进被拖动的那一个维度是错的：覆盖语义是**替换**，那样做会让其余维度
     * 全部归零，用户拖一下「推理」就把写作、工具调用全关了——而他完全不会预期
     * 这个结果。从当前值复制过来，界面上看到的就是他实际会得到的。
     */
    const base: Partial<Record<StrengthKey, number>> = { ...active };
    base[key] = value;
    onChange(base);
  };

  return (
    <div className="weights">
      <div className="weights__head">
        <span className="weights__title">能力权重</span>
        {overrides === undefined ? (
          <span className="weights__state">当前用任务预设</span>
        ) : (
          <button type="button" className="btn btn--small" onClick={() => onChange(undefined)}>
            恢复任务预设
          </button>
        )}
      </div>

      <ul className="weights__list">
        {STRENGTH_KEYS.map((key) => {
          const value = active[key] ?? 0;
          return (
            <li key={key} className={`weights__row ${value === 0 ? 'weights__row--zero' : ''}`}>
              <label className="weights__label" htmlFor={`w-${key}`}>
                {STRENGTH_LABEL[key]}
              </label>
              <input
                id={`w-${key}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={value}
                onChange={(e) => setOne(key, Number(e.target.value))}
              />
              <output className="weights__value" htmlFor={`w-${key}`}>
                {value}
              </output>
            </li>
          );
        })}
      </ul>
      <p className="weights__hint">
        权重不需要加总为 100，打分时会按权重和归一。把某一项拖到 0 表示这个任务完全不看它。
      </p>
    </div>
  );
}

const FEEDBACK_BUTTONS: ReadonlyArray<{ signal: FeedbackSignal; label: string; hint: string }> = [
  { signal: 'accepted', label: '这次选得好', hint: '提高该模型在这类任务上的经验修正' },
  { signal: 'retried', label: '结果不行', hint: '降低该模型在这类任务上的经验修正' },
  {
    signal: 'user-override',
    label: '我会自己指定',
    hint: '记录一次用户覆盖，作为该模型不合适的信号',
  },
];

/** 历史决策条目。带反馈按钮——反馈信号必须挂在具体决策上才有训练价值。 */
function HistoryItem({
  decision,
  projectId,
}: {
  decision: RoutingDecision;
  projectId: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [sent, setSent] = useState<FeedbackSignal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (signal: FeedbackSignal): Promise<void> => {
    try {
      await sendFeedback(projectId, decision.id, signal);
      setSent(signal);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <li className="rhist__item">
      <button
        type="button"
        className="rhist__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="rhist__time">
          {new Date(decision.createdAt).toLocaleString('zh-CN', { hour12: false })}
        </span>
        <span className="rhist__task">
          {TASK_LABEL[decision.taskType as TaskType] ?? decision.taskType}
        </span>
        <code className="rhist__model">{decision.chosenModelId ?? '无可用模型'}</code>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="rhist__body">
          <DecisionDetail decision={decision} />

          <div className="rhist__feedback">
            <span className="rhist__feedback-label">这次选择合适吗？</span>
            {FEEDBACK_BUTTONS.map((b) => (
              <button
                key={b.signal}
                type="button"
                className={`btn btn--small ${sent === b.signal ? 'is-current' : ''}`}
                title={b.hint}
                disabled={sent !== null}
                onClick={() => void submit(b.signal)}
              >
                {b.label}
              </button>
            ))}
            {sent !== null && (
              <span className="rhist__feedback-done">
                已记录。下一次同类任务的打分会计入这个信号。
              </span>
            )}
            {error !== null && <span className="pcard__error">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

export interface RoutingPanelProps {
  projectId: string | null;
  conversationId: string | null;
  /** 下一次发送要带的路由覆盖。由 App 持有，因为发送发生在会话视图里。 */
  override: RoutingOverride;
  onOverrideChange: (next: RoutingOverride) => void;
}

export function RoutingPanel({
  projectId,
  conversationId,
  override,
  onOverrideChange,
}: RoutingPanelProps): React.JSX.Element {
  const [taskType, setTaskType] = useState<TaskType>('analysis.codegen');
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [history, setHistory] = useState<RoutingDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (next: Partial<RoutingOverride>): void => {
    const merged: RoutingOverride = { ...override, ...next };
    // 清掉被设为 undefined 的键，否则空值会随请求发出去
    for (const key of Object.keys(merged) as Array<keyof RoutingOverride>) {
      if (merged[key] === undefined) delete merged[key];
    }
    onOverrideChange(merged);
  };

  const runPreview = useCallback(() => {
    setBusy(true);
    void previewRouting({
      taskType,
      ...(projectId === null ? {} : { projectId }),
      ...(Object.keys(override).length === 0 ? {} : { routing: override }),
    })
      .then((r) => {
        setPreview(r);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }, [taskType, projectId, override]);

  // 覆盖或任务类型一变就重新试算：让用户看到改动的后果，而不是等他记得去点按钮
  useEffect(runPreview, [runPreview]);

  useEffect(() => {
    if (projectId === null || conversationId === null) {
      setHistory([]);
      return;
    }
    void loadRoutingHistory(projectId, conversationId)
      .then((r) => setHistory(r.decisions))
      .catch(() => setHistory([]));
  }, [projectId, conversationId]);

  const overrideCount = Object.keys(override).length;
  const candidateIds = preview?.candidates.map((c) => c.id) ?? [];

  return (
    <div className="view">
      <section className="panel" aria-labelledby="routing-try">
        <h2 id="routing-try" className="panel__title">
          试算
          {busy && (
            <span className="panel__busy" role="status">
              计算中…
            </span>
          )}
        </h2>
        <p className="panel__hint">
          这里的试算不会调用任何模型，只跑一遍选型逻辑。下面的覆盖设置会作用于
          <strong>下一条发出的消息</strong>，发完即失效——做成会话级开关意味着你必须记得改回来，
          忘了就会在后续几十次廉价调用上一直付高价。
        </p>

        <div className="rtry">
          <div className="rtry__field">
            <label htmlFor="rtry-task">任务类型</label>
            <select
              id="rtry-task"
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
            >
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_LABEL[t]}
                </option>
              ))}
            </select>
            <span className="rtry__hint">试算用。真实回合的任务类型由内容推断，可在下面覆盖。</span>
          </div>

          <div className="rtry__field">
            <label htmlFor="rtry-forced">强制指定模型</label>
            <select
              id="rtry-forced"
              value={override.forcedModelId ?? ''}
              onChange={(e) =>
                patch({ forcedModelId: e.target.value === '' ? undefined : e.target.value })
              }
            >
              <option value="">（由路由决定）</option>
              {candidateIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              {/* 指定了一个当前不在候选里的模型时也要显示出来，否则下拉框会静默跳回自动 */}
              {override.forcedModelId !== undefined &&
                !candidateIds.includes(override.forcedModelId) && (
                  <option value={override.forcedModelId}>
                    {override.forcedModelId}（当前不可选）
                  </option>
                )}
            </select>
            <span className="rtry__hint">
              指定后仍会走硬过滤：可以指定模型，不能指定一个物理上做不到的组合。
            </span>
          </div>

          <div className="rtry__field">
            <label htmlFor="rtry-tasktype-override">覆盖任务类型</label>
            <select
              id="rtry-tasktype-override"
              value={override.taskType ?? ''}
              onChange={(e) =>
                patch({
                  taskType: e.target.value === '' ? undefined : (e.target.value as TaskType),
                })
              }
            >
              <option value="">（按内容推断）</option>
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_LABEL[t]}
                </option>
              ))}
            </select>
            <span className="rtry__hint">
              推断走关键词匹配，覆盖率有限。明确说了是什么任务时，猜测就不该再参与。
            </span>
          </div>

          <fieldset className="rtry__flags">
            <legend>约束</legend>
            <label>
              <input
                type="checkbox"
                checked={override.preferLocal === true}
                onChange={(e) => patch({ preferLocal: e.target.checked ? true : undefined })}
              />
              优先本机模型（数据不出本机）
            </label>
            <label>
              <input
                type="checkbox"
                checked={override.requireTrainingOptOut === true}
                onChange={(e) =>
                  patch({ requireTrainingOptOut: e.target.checked ? true : undefined })
                }
              />
              只用承诺不做训练的模型
              <span className="rtry__hint">
                策略未知的模型也会被排除——「不知道」在这里算不满足。
              </span>
            </label>
          </fieldset>
        </div>

        <div className="rtry__actions">
          <button type="button" className="btn btn--small" onClick={runPreview} disabled={busy}>
            重新试算
          </button>
          {overrideCount > 0 && (
            <>
              <span className="rtry__badge">已设置 {overrideCount} 项覆盖</span>
              <button
                type="button"
                className="btn btn--small btn--deny"
                onClick={() => onOverrideChange({})}
              >
                全部清除
              </button>
            </>
          )}
        </div>
      </section>

      {error !== null && (
        <p className="view__error" role="alert">
          {error}
        </p>
      )}

      {preview !== null && (
        <>
          <section className="panel" aria-labelledby="routing-weights">
            <h2 id="routing-weights" className="panel__title">
              权重
            </h2>
            <WeightEditor
              weights={preview.weights}
              overrides={override.weightOverrides}
              onChange={(next) => patch({ weightOverrides: next })}
            />
          </section>

          <section
            className={`panel ${preview.decision.chosenModelId === null ? 'panel--warn' : ''}`}
            aria-labelledby="routing-result"
          >
            <h2 id="routing-result" className="panel__title">
              试算结果
            </h2>

            {preview.emptyReport !== null && (
              // 候选为空时给的是可执行报告，原文展示——摘要掉就没用了
              <pre className="routing__empty">{preview.emptyReport}</pre>
            )}

            <DecisionDetail decision={preview.decision} candidates={preview.candidates} />

            <p className="panel__hint">
              对照候选（发送只会跑主模型，不会自动连发；{preview.committee.vendorCount}{' '}
              家供应商）：{' '}
              {preview.committee.modelIds.join(' · ') || '无'}
            </p>
            {preview.committee.degradedReason !== null && (
              <p className="panel__error">{preview.committee.degradedReason}</p>
            )}
            <div className="subrow__actions">
              {preview.committee.modelIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="btn btn--small"
                  onClick={() => patch({ forcedModelId: id })}
                >
                  强制用 {id}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="panel" aria-labelledby="routing-history">
        <h2 id="routing-history" className="panel__title">
          本会话的决策历史
        </h2>
        {conversationId === null ? (
          <p className="view__empty">请先选择一个会话。</p>
        ) : history.length === 0 ? (
          <p className="view__empty">这个会话还没有产生路由决策。</p>
        ) : (
          <ul className="rhist">
            {history.map((d) => (
              <HistoryItem key={d.id} decision={d} projectId={projectId ?? ''} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
