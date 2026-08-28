/**
 * 用量与成本面板（任务 11.10、11.11，需求 18.2、18.4）。
 *
 * 成本用足够多的小数位显示。四舍五入到分会让绝大多数单次调用显示成 $0.00，
 * 于是用户永远看不出钱花在哪——而这个平台的一个卖点正是「便宜的任务用便宜的
 * 模型」，看不到差异就无从判断路由是否真的在省钱。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  loadUsageBreakdown,
  loadUsageSummary,
  type FailureBreakdown,
  type ModelUsageSummary,
  type UsageRow,
  type UsageSummary,
} from '../lib/api.js';

const STATUS_LABEL: Record<string, string> = {
  ok: '成功',
  'rate-limited': '被限流',
  'server-error': '服务端错误',
  timeout: '超时',
  aborted: '已中断',
  'auth-failed': '凭据无效',
  'content-filtered': '内容安全拒答',
  'bad-request': '请求不合法',
  'network-error': '网络错误',
  'unknown-error': '未分类错误',
};

/** 运维动作提示。只报分类不给动作，用户看到「被限流 12 次」也不知道该做什么。 */
const STATUS_ACTION: Record<string, string> = {
  'rate-limited': '接入其他供应商分摊请求，或降低并发。',
  'auth-failed': '检查该供应商的凭据是否已失效或额度耗尽。',
  'server-error': '供应商侧的问题，通常会自行恢复。频繁出现可考虑降低其权重。',
  timeout: '可能是网络或该模型本身较慢。可为长任务提高超时上限。',
  'network-error': '检查网络与代理设置。本地模型需确认 Ollama 在运行。',
  'content-filtered': '这是安全边界，不会重试也不该绕过。若属误判，请调整表述。',
  'bad-request': '请求参数有问题，属于程序缺陷，请反馈。',
};

/**
 * 成本格式化。
 *
 * 小额用 6 位小数，大额收敛到 2 位。固定用 2 位会让 $0.000033 显示成 $0.00，
 * 固定用 6 位会让 $12.345678 读起来费劲。
 */
export function formatCost(cost: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (cost === 0) return `${symbol}0`;
  if (cost < 0.01) return `${symbol}${cost.toFixed(6)}`;
  if (cost < 1) return `${symbol}${cost.toFixed(4)}`;
  return `${symbol}${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 当前回合的累计用量条（需求 18.4）。放在输入区上方，一直可见。 */
export function TurnUsageBar({
  usage,
}: {
  usage: { tokensIn: number; tokensOut: number; cost: number; currency: string } | null;
}): React.JSX.Element | null {
  if (usage === null) return null;

  return (
    <p className="turn-usage" role="status">
      <span className="turn-usage__label">本轮</span>
      <span>
        输入 {formatTokens(usage.tokensIn)} · 输出 {formatTokens(usage.tokensOut)}
      </span>
      <span className="turn-usage__cost">{formatCost(usage.cost, usage.currency)}</span>
    </p>
  );
}

function SummaryGrid({
  summary,
  title,
}: {
  summary: UsageSummary;
  title: string;
}): React.JSX.Element {
  const failed = summary.calls - summary.succeeded;

  return (
    <section className="panel" aria-labelledby={`usage-${title}`}>
      <h2 id={`usage-${title}`} className="panel__title">
        {title}
      </h2>
      <dl className="kv">
        <dt>调用次数</dt>
        <dd>
          {summary.calls}
          {failed > 0 && (
            // 失败次数与总次数并列显示。只给总数会让「大部分调用都失败了」
            // 这个事实被藏起来
            <span className="usage__failed">其中失败 {failed} 次</span>
          )}
        </dd>
        <dt>token</dt>
        <dd>
          输入 {formatTokens(summary.tokensIn)} · 输出 {formatTokens(summary.tokensOut)}
        </dd>
        <dt>成本</dt>
        <dd className="usage__cost">{formatCost(summary.cost)}</dd>
        <dt>延迟中位数</dt>
        <dd>
          {summary.medianLatencyMs} ms
          {/* 说明为什么是中位数：用均值会被少数超慢调用带偏 */}
          <span className="usage__hint">（中位数，不受个别超慢调用影响）</span>
        </dd>
      </dl>
    </section>
  );
}

function ModelTable({ rows }: { rows: readonly ModelUsageSummary[] }): React.JSX.Element {
  if (rows.length === 0) return <p className="view__empty">还没有调用记录。</p>;

  return (
    <table className="usage-table">
      <caption>按模型分组（按成本降序）</caption>
      <thead>
        <tr>
          <th scope="col">模型</th>
          <th scope="col">调用</th>
          <th scope="col">token</th>
          <th scope="col">成本</th>
          <th scope="col">平均延迟</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.providerId}/${row.modelId}`}>
            <th scope="row">
              <code>{row.modelId}</code>
              <span className="usage__provider">{row.providerId}</span>
            </th>
            <td>
              {row.calls}
              {row.succeeded < row.calls && (
                <span className="usage__failed">失败 {row.calls - row.succeeded}</span>
              )}
            </td>
            <td>
              {formatTokens(row.tokensIn)} / {formatTokens(row.tokensOut)}
            </td>
            <td className="usage__cost">{formatCost(row.cost)}</td>
            <td>{row.medianLatencyMs} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FailureList({ failures }: { failures: readonly FailureBreakdown[] }): React.JSX.Element {
  if (failures.length === 0) {
    return <p className="view__empty">没有失败记录。</p>;
  }

  return (
    <ul className="failures">
      {failures.map((f) => (
        <li key={f.status} className="failures__item">
          <div className="failures__head">
            <span className="failures__status">{STATUS_LABEL[f.status] ?? f.status}</span>
            <span className="failures__count">{f.count} 次</span>
            <span className="failures__time">
              最近 {new Date(f.lastAt).toLocaleString('zh-CN', { hour12: false })}
            </span>
          </div>

          {/* 只报分类不给动作，用户看到「被限流 12 次」也不知道该做什么 */}
          {STATUS_ACTION[f.status] !== undefined && (
            <p className="failures__action">{STATUS_ACTION[f.status]}</p>
          )}

          {f.lastError !== null && (
            <details className="failures__detail">
              <summary>最近一次的错误消息</summary>
              {/* 已在写入前脱敏，见 UsageRepo.redactError */}
              <pre>{f.lastError}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function RecentList({ rows }: { rows: readonly UsageRow[] }): React.JSX.Element {
  if (rows.length === 0) return <p className="view__empty">还没有调用记录。</p>;

  return (
    <ul className="usage-recent">
      {rows.map((row) => (
        <li
          key={row.id}
          className={`usage-recent__item usage-recent__item--${row.status === 'ok' ? 'ok' : 'bad'}`}
        >
          <span className="usage-recent__time">
            {new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
          <code className="usage-recent__model">{row.modelId}</code>
          <span className="usage-recent__status">{STATUS_LABEL[row.status] ?? row.status}</span>
          <span className="usage-recent__tokens">
            {formatTokens(row.tokensIn)}/{formatTokens(row.tokensOut)}
          </span>
          <span className="usage-recent__cost">{formatCost(row.cost)}</span>
          <span className="usage-recent__latency">{row.latencyMs} ms</span>
        </li>
      ))}
    </ul>
  );
}

/** 按天的成本趋势。用纯 CSS 条形图，不引图表库。 */
function DailyChart({
  daily,
}: {
  daily: ReadonlyArray<{ date: string; calls: number; cost: number }>;
}): React.JSX.Element {
  if (daily.length === 0) return <p className="view__empty">还没有数据。</p>;

  const max = Math.max(...daily.map((d) => d.cost), 1e-9);

  return (
    <ul className="daily">
      {daily.map((d) => (
        <li key={d.date} className="daily__row">
          <span className="daily__date">{d.date}</span>
          <span className="daily__bar-wrap">
            <span
              className="daily__bar"
              style={{ inlineSize: `${String(Math.max(2, (d.cost / max) * 100))}%` }}
              // 条形图不能是唯一的信息载体：数值同时以文字给出
              aria-hidden="true"
            />
          </span>
          <span className="daily__value">{formatCost(d.cost)}</span>
          <span className="daily__calls">{d.calls} 次</span>
        </li>
      ))}
    </ul>
  );
}

export function UsagePanel({
  projectId,
  conversationId,
}: {
  projectId: string | null;
  conversationId: string | null;
}): React.JSX.Element {
  const [projectSummary, setProjectSummary] = useState<UsageSummary | null>(null);
  const [convSummary, setConvSummary] = useState<UsageSummary | null>(null);
  const [breakdown, setBreakdown] = useState<Awaited<ReturnType<typeof loadUsageBreakdown>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (projectId === null) return;

    void Promise.all([
      loadUsageSummary(projectId),
      conversationId === null
        ? Promise.resolve(null)
        : loadUsageSummary(projectId, { conversationId }),
      loadUsageBreakdown(projectId),
    ])
      .then(([project, conv, bd]) => {
        setProjectSummary(project.summary);
        setConvSummary(conv?.summary ?? null);
        setBreakdown(bd);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId, conversationId]);

  useEffect(reload, [reload]);

  if (projectId === null) return <p className="view__empty">请先选择一个项目。</p>;
  if (error !== null) return <p className="view__error">{error}</p>;

  return (
    <div className="view">
      <div className="view__toolbar">
        <button type="button" className="btn btn--small" onClick={reload}>
          刷新
        </button>
      </div>

      {convSummary !== null && <SummaryGrid summary={convSummary} title="当前会话" />}
      {projectSummary !== null && <SummaryGrid summary={projectSummary} title="整个项目" />}

      {breakdown !== null && (
        <>
          <section className="panel" aria-labelledby="usage-models">
            <h2 id="usage-models" className="panel__title">
              各模型用量
            </h2>
            <ModelTable rows={breakdown.byModel} />
          </section>

          <section className="panel" aria-labelledby="usage-trend">
            <h2 id="usage-trend" className="panel__title">
              每日成本
            </h2>
            <DailyChart daily={breakdown.daily} />
          </section>

          <section
            className={`panel ${breakdown.failures.length > 0 ? 'panel--warn' : ''}`}
            aria-labelledby="usage-failures"
          >
            <h2 id="usage-failures" className="panel__title">
              失败分布
            </h2>
            <FailureList failures={breakdown.failures} />
          </section>

          <section className="panel" aria-labelledby="usage-recent">
            <h2 id="usage-recent" className="panel__title">
              最近调用
            </h2>
            <RecentList rows={breakdown.recent} />
          </section>
        </>
      )}
    </div>
  );
}
