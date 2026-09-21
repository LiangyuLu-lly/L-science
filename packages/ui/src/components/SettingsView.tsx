/**
 * 设置视图：供应商、模型与凭据（任务 11.1b，需求 8.5、8.6）。
 *
 * 这个页面的每一项都要能回答「为什么这个模型没被选中」。多模型路由的价值全部
 * 建立在注册表是准的这个前提上，而注册表不准时的症状极不直观——路由照常工作、
 * 照常给出理由，只是永远选不到某些模型。因此这里坚持三件事：
 *
 * 1. **默认显示全部**，包括被禁用的供应商与模型。只显示启用项会让用户找不到
 *    自己关掉的那个，也就无法重新打开。
 * 2. **区分「没配」与「配不了」**。凭据库依赖 Windows DPAPI，在别的平台上根本
 *    不存在——这时候提示用户「去配置凭据」是把他推向一条走不通的路。
 * 3. **密钥输入框里的值不回显、不留存**。提交后立刻清空，界面上只显示指纹
 *    （长度加末四位）。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  checkProviderHealth,
  deleteCredential,
  forgetApprovalDenial,
  listApprovalHistory,
  listCredentials,
  listGrants,
  listModels,
  listCompatPresets,
  listProjects,
  listProviders,
  registerCompatProvider,
  revokeGrant,
  setCredential,
  setModelEnabled,
  setProviderCredentialRef,
  setProviderEnabled,
  syncProvider,
  STRENGTH_LABEL,
  type ApprovalHistoryEntry,
  type CredentialFingerprint,
  type DomainGrantView,
  type GrantMode,
  type GrantScope,
  type HostGrantView,
  type ModelRecord,
  type CompatPreset,
  type ProviderView,
  type StrengthKey,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

import { AboutFooter } from './AboutFooter.js';

/** 训练策略的中文说明。`unknown` 必须显式说出来，不能显示成空白。 */
const TRAINING_USE_LABEL: Record<string, string> = {
  none: '承诺不用于训练',
  'opt-out-required': '需手动关闭训练用途',
  yes: '会用于训练',
  unknown: '策略未知',
};

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function priceText(pricing: { inputPer1k: number; outputPer1k: number; currency: string }): string {
  if (pricing.inputPer1k === 0 && pricing.outputPer1k === 0) return '免费（本机推理）';
  const unit = pricing.currency === 'USD' ? '$' : `${pricing.currency} `;
  return `${unit}${pricing.inputPer1k.toFixed(4)} / ${unit}${pricing.outputPer1k.toFixed(4)} 每千 token`;
}

function contextText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function fingerprintText(fp: CredentialFingerprint | null): string {
  if (fp === null) return '（读不出）';
  return `${String(fp.length)} 字符，末四位 ${fp.tail}`;
}

const GRANT_SCOPE_LABEL = {
  once: '仅这一次',
  session: '本次会话内',
  project: '本项目内',
  always: '始终允许',
} as const satisfies Record<GrantScope, string>;

const GRANT_MODE_LABEL = {
  ro: '只读',
  rw: '读写',
} as const satisfies Record<GrantMode, string>;

type GrantStatus = 'active' | 'expired' | 'revoked';

const GRANT_STATUS_LABEL = {
  active: '有效',
  expired: '已过期',
  revoked: '已撤销',
} as const satisfies Record<GrantStatus, string>;

function hostGrantStatus(grant: HostGrantView, now: number): GrantStatus {
  if (grant.revokedAt !== null) return 'revoked';
  if (grant.expiresAt !== null && grant.expiresAt <= now) return 'expired';
  return 'active';
}

function formatGrantTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function grantScopeText(scope: GrantScope, scopeId: string | null): string {
  const label = GRANT_SCOPE_LABEL[scope];
  if (scope === 'project' && scopeId !== null) return `${label}（项目 ${scopeId}）`;
  if (scope === 'session' && scopeId !== null) return `${label}（会话 ${scopeId}）`;
  return label;
}

type GrantRowView = {
  readonly id: string;
  readonly kindLabel: string;
  readonly subjectLabel: string;
  readonly subject: string;
  readonly mode: GrantMode;
  readonly scope: GrantScope;
  readonly scopeId: string | null;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly extraLabel: string | null;
  readonly extraValue: string | null;
  readonly status: GrantStatus;
};

function toGrantRows(
  hostPaths: readonly HostGrantView[],
  domains: readonly DomainGrantView[],
  now: number,
): readonly GrantRowView[] {
  const hosts: GrantRowView[] = hostPaths.map((grant) => ({
    id: grant.id,
    kindLabel: '宿主路径',
    subjectLabel: '路径',
    subject: grant.hostPath,
    mode: grant.mode,
    scope: grant.scope,
    scopeId: grant.scopeId,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    extraLabel:
      grant.guestPath !== null && grant.guestPath !== grant.hostPath ? '沙箱内' : null,
    extraValue:
      grant.guestPath !== null && grant.guestPath !== grant.hostPath ? grant.guestPath : null,
    status: hostGrantStatus(grant, now),
  }));
  const domainRows: GrantRowView[] = domains.map((grant) => ({
    id: grant.id,
    kindLabel: '域名',
    subjectLabel: '域名',
    subject: grant.domain,
    mode: grant.mode,
    scope: grant.scope,
    scopeId: grant.scopeId,
    grantedAt: grant.addedAt,
    expiresAt: null,
    extraLabel: grant.reason !== null ? '原因' : null,
    extraValue: grant.reason,
    status: 'active',
  }));
  return [...hosts, ...domainRows].sort((a, b) => b.grantedAt - a.grantedAt);
}

function GrantsSection(): React.JSX.Element {
  const [hostPaths, setHostPaths] = useState<readonly HostGrantView[]>([]);
  const [domains, setDomains] = useState<readonly DomainGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadGrants = useCallback(() => {
    setLoading(true);
    setError(null);
    void listGrants(true)
      .then((result) => {
        setHostPaths(result.hostPaths);
        setDomains(result.domains);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(errorText(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(reloadGrants, [reloadGrants]);

  const rows = toGrantRows(hostPaths, domains, Date.now());
  const empty = !loading && error === null && rows.length === 0;

  const confirmRevoke = async (grantId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await revokeGrant(grantId);
      setPendingRevokeId(null);
      reloadGrants();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="grants-heading">
      <h2 id="grants-heading" className="panel__title">
        授权
      </h2>
      <div className="view__toolbar">
        <button
          type="button"
          className="btn btn--small"
          disabled={loading || busy}
          onClick={reloadGrants}
        >
          刷新
        </button>
      </div>
      {loading && (
        <p className="panel__hint" role="status">
          正在读取授权…
        </p>
      )}
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {empty && (
        <p className="panel__hint">
          授权是工具第一次需要访问宿主路径或域名时，经你同意后留下的放行记录。
        </p>
      )}
      {rows.map((row) => (
        <dl key={row.id} className="kv">
          <dt>类型</dt>
          <dd>{row.kindLabel}</dd>
          <dt>{row.subjectLabel}</dt>
          <dd>
            <code>{row.subject}</code>
          </dd>
          {row.extraLabel !== null && row.extraValue !== null && (
            <>
              <dt>{row.extraLabel}</dt>
              <dd>{row.extraValue}</dd>
            </>
          )}
          <dt>权限</dt>
          <dd>{GRANT_MODE_LABEL[row.mode]}</dd>
          <dt>作用域</dt>
          <dd>{grantScopeText(row.scope, row.scopeId)}</dd>
          <dt>授权时间</dt>
          <dd>{formatGrantTime(row.grantedAt)}</dd>
          {row.expiresAt !== null && (
            <>
              <dt>过期时间</dt>
              <dd>{formatGrantTime(row.expiresAt)}</dd>
            </>
          )}
          <dt>状态</dt>
          <dd>{GRANT_STATUS_LABEL[row.status]}</dd>
          {row.status === 'active' && (
            <>
              <dt>操作</dt>
              <dd>
                {pendingRevokeId === row.id ? (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => void confirmRevoke(row.id)}
                  >
                    确认撤销
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => {
                      setPendingRevokeId(row.id);
                    }}
                  >
                    撤销
                  </button>
                )}
              </dd>
            </>
          )}
        </dl>
      ))}
    </section>
  );
}

const APPROVAL_KIND_LABEL = {
  'artifact-delete': '删除制品',
  'host-access': '访问沙箱外的路径',
  'compute-target': '登记算力目标',
  'ssh-command': '在远程主机执行命令',
  'compute-job': '提交算力作业',
  'compute-provider': '使用算力凭据',
  'domain-allowlist': '新增域名白名单',
  'skill-write': '写入技能',
  'package-install': '安装或卸载依赖包',
} as const satisfies Record<ApprovalHistoryEntry['kind'], string>;

const APPROVAL_STATE_LABEL = {
  pending: '待决议',
  approved: '批准',
  denied: '拒绝',
  timeout: '超时',
  abandoned: '已放弃',
} as const satisfies Record<ApprovalHistoryEntry['state'], string>;

const APPROVAL_DECIDER_LABEL = {
  pending: '尚未决定',
  approved: '用户',
  denied: '用户',
  timeout: '系统（超时）',
  abandoned: '系统（进程重启后放弃）',
} as const satisfies Record<ApprovalHistoryEntry['state'], string>;

function ApprovalsSection(): React.JSX.Element {
  const [entries, setEntries] = useState<readonly ApprovalHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingForgetId, setPendingForgetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadApprovals = useCallback(() => {
    setLoading(true);
    setError(null);
    void listProjects()
      .then(async (listed) => {
        const batches = await Promise.all(
          listed.projects.map((project) => listApprovalHistory(project.id)),
        );
        setEntries(
          batches
            .flatMap((batch) => batch.approvals)
            .sort((a, b) => b.requestedAt - a.requestedAt),
        );
        setError(null);
      })
      .catch((err: unknown) => {
        setError(errorText(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(reloadApprovals, [reloadApprovals]);

  const empty = !loading && error === null && entries.length === 0;

  const confirmForget = async (approvalId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await forgetApprovalDenial(approvalId);
      setPendingForgetId(null);
      reloadApprovals();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="approvals-heading">
      <h2 id="approvals-heading" className="panel__title">
        审批
      </h2>
      <div className="view__toolbar">
        <button
          type="button"
          className="btn btn--small"
          disabled={loading || busy}
          onClick={reloadApprovals}
        >
          刷新
        </button>
      </div>
      {loading && (
        <p className="panel__hint" role="status">
          正在读取审批…
        </p>
      )}
      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {empty && (
        <p className="panel__hint">
          敏感操作被批准或拒绝后会出现在这里，仍被记住的拒绝也可以在此忘记。
        </p>
      )}
      {entries.map((entry) => (
        <dl key={entry.id} className="kv">
          <dt>类型</dt>
          <dd>{APPROVAL_KIND_LABEL[entry.kind]}</dd>
          <dt>请求</dt>
          <dd>{entry.title}</dd>
          {entry.detail !== '' && (
            <>
              <dt>详情</dt>
              <dd>{entry.detail}</dd>
            </>
          )}
          {entry.impact !== '' && (
            <>
              <dt>影响</dt>
              <dd>{entry.impact}</dd>
            </>
          )}
          <dt>决定</dt>
          <dd>{APPROVAL_STATE_LABEL[entry.state]}</dd>
          <dt>决定方</dt>
          <dd>{APPROVAL_DECIDER_LABEL[entry.state]}</dd>
          <dt>请求时间</dt>
          <dd>{formatGrantTime(entry.requestedAt)}</dd>
          {entry.decidedAt !== null && (
            <>
              <dt>决定时间</dt>
              <dd>{formatGrantTime(entry.decidedAt)}</dd>
            </>
          )}
          {entry.note !== null && entry.note !== '' && (
            <>
              <dt>备注</dt>
              <dd>{entry.note}</dd>
            </>
          )}
          {entry.state === 'denied' && (
            <>
              <dt>拒绝记忆</dt>
              <dd>{entry.stillDenied ? '仍在拦截' : '已不再拦截'}</dd>
            </>
          )}
          {entry.state === 'denied' && entry.stillDenied && (
            <>
              <dt>操作</dt>
              <dd>
                {pendingForgetId === entry.id ? (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => void confirmForget(entry.id)}
                  >
                    确认忘记
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => {
                      setPendingForgetId(entry.id);
                    }}
                  >
                    忘记这条拒绝
                  </button>
                )}
              </dd>
            </>
          )}
        </dl>
      ))}
    </section>
  );
}

/** Same convention as core `providerRef`. UI must not import the vault module. */
function providerRef(providerId: string): string {
  return `provider:${providerId}`;
}

/** 健康状态徽章。颜色之外必须有文字，不能只靠颜色传达（需求 20.5.2）。 */
function HealthBadge({ health }: { health: ModelRecord['health'] }): React.JSX.Element {
  if (health === null) {
    return (
      <span
        className="hbadge hbadge--unknown"
        title="还没检查过。未检查不等于不可用，路由会照常尝试它。"
      >
        未检查
      </span>
    );
  }

  const age = Date.now() - health.checkedAt;
  // 五分钟是后端的 HEALTH_TTL_MS：超过它路由就不再采信这个结果
  const stale = age > 5 * 60 * 1000;

  return (
    <span
      className={`hbadge hbadge--${health.ok ? 'ok' : 'bad'} ${stale ? 'hbadge--stale' : ''}`}
      title={health.detail ?? ''}
    >
      {health.ok ? `正常 ${String(health.latencyMs)}ms` : '不可用'}
      {stale && <span className="hbadge__stale">已过期</span>}
    </span>
  );
}

/** 能力向量的横条。数值同时以文字给出，条形不是唯一载体。 */
function StrengthBars({ strengths }: { strengths: Record<string, number> }): React.JSX.Element {
  const keys = Object.keys(STRENGTH_LABEL) as StrengthKey[];

  return (
    <ul className="strengths">
      {keys.map((key) => {
        const value = strengths[key] ?? 0;
        return (
          <li key={key} className="strengths__row">
            <span className="strengths__name">{STRENGTH_LABEL[key]}</span>
            <span className="strengths__bar-wrap">
              <span
                className="strengths__bar"
                style={{ inlineSize: `${String(Math.max(1, value))}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="strengths__value">{value}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ModelRow({
  model,
  busy,
  onToggle,
}: {
  model: ModelRecord;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}): React.JSX.Element {
  const d = model.descriptor;
  const features: string[] = [];
  if (d.features.toolUse) features.push('工具调用');
  if (d.features.vision) features.push('视觉');
  if (d.features.thinking) features.push('思维链');
  if (d.features.promptCache) features.push('提示缓存');
  if (d.local) features.push('本机');

  return (
    <li className={`mrow ${model.enabled ? '' : 'mrow--off'}`}>
      <div className="mrow__head">
        <label className="mrow__toggle">
          <input
            type="checkbox"
            checked={model.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="mrow__name">
            <code>{model.id}</code>
            {d.displayName !== model.id && <span className="mrow__alias">{d.displayName}</span>}
          </span>
        </label>
        <HealthBadge health={model.health} />
      </div>

      <dl className="mrow__meta">
        <dt>上下文</dt>
        <dd>
          {contextText(d.contextWindow)} token，输出上限 {contextText(d.maxOutputTokens)}
        </dd>
        <dt>价格</dt>
        <dd>{priceText(d.pricing)}</dd>
        <dt>能力标记</dt>
        <dd>
          {features.length === 0 ? (
            // 空着会让人以为是没加载出来
            <span className="mrow__none">纯文本对话，无工具与视觉</span>
          ) : (
            features.map((f) => (
              <span key={f} className="chip">
                {f}
              </span>
            ))
          )}
        </dd>
        <dt>数据策略</dt>
        <dd>
          {TRAINING_USE_LABEL[d.policy.trainingUse] ?? d.policy.trainingUse}
          {d.policy.zdr && <span className="chip">零留存</span>}
          {d.policy.retentionDays !== null && (
            <span className="mrow__hint">保留 {d.policy.retentionDays} 天</span>
          )}
        </dd>
      </dl>

      {model.health !== null && !model.health.ok && model.health.detail !== undefined && (
        <p className="mrow__error">{model.health.detail}</p>
      )}

      <details className="mrow__strengths">
        <summary>能力向量（路由打分的输入）</summary>
        <StrengthBars strengths={d.strengths as unknown as Record<string, number>} />
      </details>
    </li>
  );
}

function ProviderCard({
  provider,
  models,
  credentialRefs,
  vaultAvailable,
  onChanged,
}: {
  provider: ProviderView;
  models: readonly ModelRecord[];
  credentialRefs: readonly string[];
  vaultAvailable: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 统一的动作包装：跑动作、报错、结束后让父组件重载。 */
  const run = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await fn();
      if (message !== null) setNotice(message);
      onChanged();
    } catch (err) {
      setError(`${label}失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const enabledModels = models.filter((m) => m.enabled).length;

  return (
    <section className={`pcard ${provider.enabled ? '' : 'pcard--off'}`}>
      <header className="pcard__head">
        <label className="pcard__toggle">
          <input
            type="checkbox"
            checked={provider.enabled}
            disabled={busy}
            onChange={(e) =>
              void run('切换启用状态', async () => {
                await setProviderEnabled(provider.id, e.target.checked);
                return null;
              })
            }
          />
          <span className="pcard__name">{provider.name}</span>
        </label>

        <span className="pcard__id">
          <code>{provider.id}</code>
        </span>

        {!provider.adapterRegistered && (
          // 记录指向一个后端没有的适配器。这条不说出来，用户会一直以为是凭据问题
          <span className="pcard__warn">适配器 {provider.adapter} 未注册</span>
        )}
      </header>

      <dl className="pcard__meta">
        <dt>基地址</dt>
        <dd>{provider.baseUrl === null ? <em>未设置</em> : <code>{provider.baseUrl}</code>}</dd>
        <dt>模型</dt>
        <dd>
          共 {provider.modelCount} 个，启用 {enabledModels} 个
          {provider.modelCount === 0 && <span className="pcard__hint">还没同步过模型列表</span>}
        </dd>
      </dl>

      <div className="pcard__credential">
        <label className="pcard__cred-label" htmlFor={`cred-${provider.id}`}>
          凭据
        </label>
        <select
          id={`cred-${provider.id}`}
          value={provider.credentialRef ?? ''}
          disabled={busy || !vaultAvailable}
          onChange={(e) =>
            void run('绑定凭据', async () => {
              const value = e.target.value === '' ? null : e.target.value;
              await setProviderCredentialRef(provider.id, value);
              return value === null ? '已解绑凭据' : `已绑定 ${value}`;
            })
          }
        >
          <option value="">（不绑定）</option>
          {credentialRefs.map((ref) => (
            <option key={ref} value={ref}>
              {ref}
            </option>
          ))}
          {/* 绑着一个已不在库里的引用名时也要能显示出来，否则下拉框会静默跳到「不绑定」 */}
          {provider.credentialRef !== null && !credentialRefs.includes(provider.credentialRef) && (
            <option value={provider.credentialRef}>{provider.credentialRef}（已丢失）</option>
          )}
        </select>

        {provider.credentialRef === null ? (
          <span className="pcard__cred-state">
            {/* 本机模型不需要凭据。不说明的话用户会去找一个不存在的 key */}
            未绑定
          </span>
        ) : provider.credentialPresent ? (
          <span className="pcard__cred-state pcard__cred-state--ok">已就绪</span>
        ) : (
          <span className="pcard__cred-state pcard__cred-state--bad">
            引用名在凭据库里不存在，该供应商的模型会全部被排除
          </span>
        )}
      </div>

      <div className="pcard__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || provider.baseUrl === null}
          onClick={() =>
            void run('同步模型', async () => {
              const r = await syncProvider(provider.id);
              const parts = [`新增 ${String(r.added.length)}`, `更新 ${String(r.updated.length)}`];
              // 消失的模型被禁用而不是删除，这件事要说出来——否则用户会以为
              // 它还在可选范围里
              if (r.disappeared.length > 0) {
                parts.push(
                  `线上已下线并被禁用 ${String(r.disappeared.length)}：${r.disappeared.join('、')}`,
                );
              }
              return parts.join('，');
            })
          }
        >
          同步模型
        </button>

        <button
          type="button"
          className="btn btn--small"
          disabled={busy || provider.baseUrl === null}
          onClick={() =>
            void run('健康检查', async () => {
              const r = await checkProviderHealth(provider.id);
              return r.health.ok
                ? `可用，延迟 ${String(r.health.latencyMs)} ms（已记到 ${String(r.appliedTo)} 个模型）`
                : `不可用：${r.health.detail ?? '未知原因'}`;
            })
          }
        >
          健康检查
        </button>

        {busy && (
          <span className="pcard__busy" role="status">
            处理中…
          </span>
        )}
      </div>

      {notice !== null && <p className="pcard__notice">{notice}</p>}
      {error !== null && (
        <p className="pcard__error" role="alert">
          {error}
        </p>
      )}

      {models.length > 0 && (
        <ul className="pcard__models">
          {models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              busy={busy}
              onToggle={(enabled) =>
                void run('切换模型', async () => {
                  await setModelEnabled(m.id, enabled);
                  return null;
                })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CredentialSection({
  available,
  credentials,
  usedRefs,
  providerIds,
  onChanged,
}: {
  available: boolean;
  credentials: ReadonlyArray<{ ref: string; fingerprint: CredentialFingerprint | null }>;
  usedRefs: ReadonlySet<string>;
  providerIds: readonly string[];
  onChanged: () => void;
}): React.JSX.Element {
  const [ref, setRef] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!available) {
    return (
      <section className="panel panel--warn" aria-labelledby="cred-heading">
        <h2 id="cred-heading" className="panel__title">
          凭据
        </h2>
        {/*
          「配不了」与「没配」是两件事。提示用户去配置一条走不通的路，
          比直接说明平台限制更糟
        */}
        <p className="panel__hint">
          这台机器无法加密存储凭据（依赖 Windows DPAPI）。可以改用无需凭据的本地模型（Ollama）。
        </p>
      </section>
    );
  }

  const submit = async (): Promise<void> => {
    if (ref.trim() === '' || secret === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await setCredential(ref.trim(), secret);
      setNotice(`已保存 ${r.ref}（${fingerprintText(r.fingerprint)}）`);
      // 密钥立刻从组件状态里清掉，不在内存里多留一秒
      setSecret('');
      setRef('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="cred-heading">
      <h2 id="cred-heading" className="panel__title">
        凭据
      </h2>
      <p className="panel__hint">
        密钥经 DPAPI 加密后存在 <code>%LOCALAPPDATA%\L-science</code> 下，与仓库分离， 只有当前
        Windows 用户在本机能解开。界面上永不回显密钥，只显示长度与末四位。
      </p>

      {credentials.length === 0 ? (
        <p className="view__empty">还没有存过凭据。</p>
      ) : (
        <ul className="creds">
          {credentials.map((c) => (
            <li key={c.ref} className="creds__item">
              <code className="creds__ref">{c.ref}</code>
              <span className="creds__fp">{fingerprintText(c.fingerprint)}</span>
              {usedRefs.has(c.ref) ? (
                // 被引用中的凭据删不掉，按钮直接说明原因而不是让用户点了才知道
                <span className="creds__used">已被供应商引用</span>
              ) : (
                <button
                  type="button"
                  className="btn btn--small btn--deny"
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        await deleteCredential(c.ref);
                        setNotice(`已删除 ${c.ref}`);
                        onChanged();
                      } catch (err) {
                        setError(errorText(err));
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="cred-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="cred-form__field">
          <label htmlFor="cred-provider">供应商</label>
          <select
            id="cred-provider"
            value={providerIds.find((id) => providerRef(id) === ref) ?? ''}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              if (id === '') {
                setRef('');
                return;
              }
              setRef(providerRef(id));
            }}
          >
            <option value="">（选择供应商以填入引用名）</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="cred-form__hint">
            选中后写入 <code>provider:&lt;id&gt;</code>，也可在引用名里手改。
          </span>
        </div>

        <div className="cred-form__field">
          <label htmlFor="cred-ref">引用名</label>
          <input
            id="cred-ref"
            type="text"
            value={ref}
            placeholder="provider:deepseek"
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setRef(e.target.value)}
          />
          <span className="cred-form__hint">
            习惯上用 <code>provider:&lt;供应商 id&gt;</code>。存进数据库的是这个名字，不是密钥。
          </span>
        </div>

        <div className="cred-form__field">
          <label htmlFor="cred-secret">密钥</label>
          <input
            id="cred-secret"
            type="password"
            value={secret}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setSecret(e.target.value)}
          />
          <span className="cred-form__hint">提交后立刻从界面清除，不会回显。</span>
        </div>

        <button type="submit" className="btn" disabled={busy || ref.trim() === '' || secret === ''}>
          保存
        </button>
      </form>

      {notice !== null && <p className="pcard__notice">{notice}</p>}
      {error !== null && (
        <p className="pcard__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function CompatProviderForm({
  available,
  onChanged,
}: {
  available: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const [presets, setPresets] = useState<CompatPreset[]>([]);
  const [presetId, setPresetId] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listCompatPresets()
      .then((result) => {
        setPresets(result.presets);
      })
      .catch((err: unknown) => {
        if (err instanceof Error || typeof err === 'object') return;
      });
  }, []);

  if (!available) {
    return (
      <section className="panel" aria-labelledby="compat-heading">
        <h2 id="compat-heading" className="panel__title">
          OpenAI 兼容接口
        </h2>
        <p className="panel__hint">这台机器无法加密存储凭据，不能添加需要密钥的兼容端点。</p>
      </section>
    );
  }

  const submit = async (): Promise<void> => {
    if (baseUrl.trim() === '' || apiKey === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const custom = presetId === 'custom';
      const result = await registerCompatProvider({
        apiKey,
        ...(custom ? { baseUrl: baseUrl.trim() } : { presetId }),
      });
      setNotice(`已登记 ${result.name}，同步 ${String(result.modelIds.length)} 个模型`);
      setApiKey('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="compat-heading">
        <h2 id="compat-heading" className="panel__title">
          云端与兼容接口
        </h2>
        <p className="panel__hint">
          可同时登记多家。预设走官方兼容端点；自定义须 https，或 http 回环地址。密钥提交后立刻清除。
        </p>
        <form
          className="cred-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="cred-form__field">
            <label htmlFor="compat-preset">供应商</label>
            <select
              id="compat-preset"
              value={presetId}
              disabled={busy}
              onChange={(event) => {
                setPresetId(event.target.value);
              }}
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
              <option value="custom">自定义 OpenAI 兼容端点</option>
            </select>
          </div>
          {presetId === 'custom' && (
          <div className="cred-form__field">
            <label htmlFor="compat-base-url">基地址</label>
          <input
            id="compat-base-url"
            type="text"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
          )}
        <div className="cred-form__field">
          <label htmlFor="compat-api-key">密钥</label>
          <input
            id="compat-api-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn"
          disabled={
            busy ||
            apiKey === '' ||
            (presetId === 'custom' && baseUrl.trim() === '')
          }
        >
          登记
        </button>
      </form>
      {notice !== null && <p className="pcard__notice">{notice}</p>}
      {error !== null && (
        <p className="pcard__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SettingsView({ onRegisterModels }: { onRegisterModels: () => void }): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [credentials, setCredentials] = useState<
    Array<{ ref: string; fingerprint: CredentialFingerprint | null }>
  >([]);
  const [vaultAvailable, setVaultAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void Promise.all([listProviders(), listModels(), listCredentials()])
      .then(([p, m, c]) => {
        setProviders(p.providers);
        setVaultAvailable(p.vaultAvailable);
        setModels(m.models);
        setCredentials(c.credentials);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        setLoaded(true);
      });
  }, []);

  useEffect(reload, [reload]);

  const usedRefs = new Set(
    providers.map((p) => p.credentialRef).filter((r): r is string => r !== null),
  );

  if (!loaded) return <p className="view__empty">正在读取设置…</p>;
  if (error !== null) {
    return (
      <p className="view__error" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="view">
      <div className="view__toolbar">
        <button type="button" className="btn btn--small" onClick={reload}>
          刷新
        </button>
        <button type="button" className="btn btn--small" onClick={onRegisterModels}>
          登记模型
        </button>
      </div>

      <GrantsSection />

      <ApprovalsSection />

      <CredentialSection
        available={vaultAvailable}
        credentials={credentials}
        usedRefs={usedRefs}
        providerIds={providers.map((p) => p.id)}
        onChanged={reload}
      />

      <CompatProviderForm available={vaultAvailable} onChanged={reload} />

      <section className="panel" aria-labelledby="providers-heading">
        <h2 id="providers-heading" className="panel__title">
          供应商与模型
        </h2>

        {providers.length === 0 ? (
          <p className="panel__hint">
            还没有登记任何供应商。点上方「登记模型」录入 DeepSeek 密钥或检测本机 Ollama。
          </p>
        ) : (
          providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              models={models.filter((m) => m.providerId === p.id)}
              credentialRefs={credentials.map((c) => c.ref)}
              vaultAvailable={vaultAvailable}
              onChanged={reload}
            />
          ))
        )}
      </section>

      <AboutFooter />
    </div>
  );
}
