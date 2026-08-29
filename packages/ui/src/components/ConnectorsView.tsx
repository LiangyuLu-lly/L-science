/**
 * 连接器设置页（任务 12.16，需求 14.1、17.1、17.5）。
 *
 * 三件事必须在这一个页面里同时看得见，否则两级开关会变成一个说不清的状态：
 *
 * 1. **组开关与连接器开关的关系**。生效 = 自身启用 **且** 所属组启用。只显示合成
 *    结果的话，用户关掉整组后看到某一项还标着「开」会以为界面坏了；只显示自身状态
 *    的话，「已启用」与实际可用不一致。因此两者都显示，并明说是哪一级把它关掉的。
 * 2. **域名白名单的联动**。关掉一组之后，它的域名要从出口白名单里撤回——
 *    界面上关了而内核里的代码照样能连，是这套设计最容易出现的半开状态，
 *    而它在没有这份清单时完全不可观测。这里把当前生效的域名列出来。
 * 3. **工具级授权**。域名授权与工具授权是两件事：同一个连接器上「查基因」与
 *    「提交作业」的风险完全不同。授权列表可撤销。
 *
 * 另外一条要在界面上说清的事：桥不经出口代理。用户在这里关掉一个连接器，模型就
 * 调不到它的工具；但如果他在 python 内核里手写 requests.get，那条路走的是出口代理，
 * 由域名白名单管。两条路各有控制点，把它说成「网络隔离」是夸大。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  checkConnector,
  listConnectorTools,
  listConnectors,
  listToolGrants,
  revokeToolGrant,
  setConnectorEnabled,
  type ConnectorCatalogView,
  type ConnectorToolView,
  type ConnectorView,
  type ToolGrantView,
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

const SCOPE_LABEL: Record<string, string> = {
  once: '仅一次',
  session: '本会话内',
  project: '本项目内',
  always: '所有项目',
};

/** 一个连接器为什么不可用。答案有三种，混在一起说不清。 */
function disabledReason(connector: ConnectorView): string | null {
  if (connector.enabled) return null;
  if (!connector.groupEnabled && !connector.selfEnabled) return '所属组与它本身都被关闭';
  if (!connector.groupEnabled) return '所属组被关闭';
  return '被单独关闭';
}

export interface ConnectorsViewProps {
  /**
   * 项目 id。
   *
   * 连接器目录本身是全局的，但**运行时状态（是否已连接、暴露了几个工具）按项目**——
   * MCP 客户端连在项目的管理器上。没有项目时只能显示注册表内容，这一点要说出来，
   * 否则用户会以为「工具数 0」意味着连接器坏了。
   */
  projectId: string | null;
}

export function ConnectorsView({ projectId }: ConnectorsViewProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<ConnectorCatalogView | null>(null);
  const [grants, setGrants] = useState<ToolGrantView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tools, setTools] = useState<Map<string, ConnectorToolView[]>>(new Map());
  const [toolError, setToolError] = useState<Map<string, string>>(new Map());
  const [health, setHealth] = useState<
    Map<string, { ok: boolean; detail: string; toolCount: number }>
  >(new Map());
  const [showDomains, setShowDomains] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [cat, gr] = await Promise.all([
        listConnectors(projectId ?? undefined),
        listToolGrants(),
      ]);
      setCatalog(cat);
      setGrants(gr.grants);
    } catch (err) {
      setError(errorText(err));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleGroup = async (groupId: string, enabled: boolean): Promise<void> => {
    setBusy(`group:${groupId}`);
    setNotice(null);
    try {
      const result = await setConnectorEnabled({ groupId }, enabled);
      setNotice(
        enabled
          ? `已开启该组，当前生效连接器 ${String(result.effective)} 个。它的域名已回到出口白名单。`
          : `已关闭该组，当前生效连接器 ${String(result.effective)} 个。` +
              '已断开连接、撤销该组的工具授权，并把它的域名从出口白名单里撤回。',
      );
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleConnector = async (connectorId: string, enabled: boolean): Promise<void> => {
    setBusy(`conn:${connectorId}`);
    setNotice(null);
    try {
      await setConnectorEnabled({ connectorId }, enabled);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const check = async (connectorId: string): Promise<void> => {
    if (projectId === null) return;
    setBusy(`check:${connectorId}`);
    try {
      const result = await checkConnector(projectId, connectorId);
      setHealth((prev) => new Map(prev).set(connectorId, result));
      await refresh();
    } catch (err) {
      setHealth((prev) =>
        new Map(prev).set(connectorId, { ok: false, detail: errorText(err), toolCount: 0 }),
      );
    } finally {
      setBusy(null);
    }
  };

  const loadTools = async (connectorId: string): Promise<void> => {
    if (projectId === null) return;
    setBusy(`tools:${connectorId}`);
    try {
      const result = await listConnectorTools(projectId, connectorId);
      setTools((prev) => new Map(prev).set(connectorId, result.tools));
      setToolError((prev) => {
        const next = new Map(prev);
        next.delete(connectorId);
        return next;
      });
    } catch (err) {
      setToolError((prev) => new Map(prev).set(connectorId, errorText(err)));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (grantId: string): Promise<void> => {
    try {
      await revokeToolGrant(grantId);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const byGroup = useMemo(() => {
    if (catalog === null) return [];
    const map = new Map<string, ConnectorView[]>();
    for (const connector of catalog.connectors) {
      const key = connector.groupId ?? '__ungrouped';
      const list = map.get(key);
      if (list === undefined) map.set(key, [connector]);
      else list.push(connector);
    }
    return catalog.groups
      .map((group) => ({ group, connectors: map.get(group.id) ?? [] }))
      .concat(
        map.has('__ungrouped')
          ? [
              {
                group: { id: '__ungrouped', name: '未分组', description: null, enabled: true },
                connectors: map.get('__ungrouped') ?? [],
              },
            ]
          : [],
      );
  }, [catalog]);

  const effectiveCount = catalog?.connectors.filter((c) => c.enabled).length ?? 0;

  return (
    <section className="view connview" aria-label="连接器">
      <header className="connview__head">
        <h2>连接器</h2>
        <button type="button" className="btn btn--ghost" onClick={() => void refresh()}>
          刷新
        </button>
      </header>

      {catalog !== null && (
        <p className="connview__meta">
          共 {catalog.connectors.length} 个连接器、{catalog.groups.length} 组，当前生效{' '}
          {effectiveCount} 个。
          {projectId === null && (
            <span className="connview__degraded">
              还没有选择项目，因此这里只显示注册表内容——连接状态与工具数需要项目上下文。
            </span>
          )}
        </p>
      )}

      {/*
        这段说明不是客套。用户看到「关掉连接器」很容易理解成断网，
        而实际上出口代理与连接器开关是两个独立的控制点。把弱管控说成强隔离
        是设计目标里明确要避免的事。
      */}
      <details className="connview__scope">
        <summary>这些开关管到哪一层</summary>
        <p>
          关掉一个连接器或一整组，模型就调不到它的工具，同时它声明的域名会从出口白名单里
          撤回。但如果你在 <code>python</code> 内核里自己写 <code>requests.get(...)</code>，
          那条路走的是出口代理，由域名白名单管——两条路各有控制点，谁也绕不过谁，
          但这不等于网络隔离。
        </p>
      </details>

      {notice !== null && (
        <p className="connview__notice" aria-live="polite">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="view__error" role="alert">
          {error}
        </p>
      )}

      {/* 域名联动：让「关了之后网络是不是真断了」可以被看见 */}
      {catalog !== null && (
        <section className="connview__domains" aria-label="出口白名单联动">
          <button
            type="button"
            className="connview__domains-toggle"
            aria-expanded={showDomains}
            onClick={() => setShowDomains(!showDomains)}
          >
            因连接器进入出口白名单的域名（{catalog.effectiveDomains.length}）
          </button>
          {showDomains && (
            <>
              <p className="connview__domains-hint">
                只有生效连接器声明的域名才在这里。关掉一组之后它的域名会从这份清单里消失，
                执行平面里的代码也就连不上了。
              </p>
              <ul className="connview__domains-list">
                {catalog.effectiveDomains.map((d) => (
                  <li key={d}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {byGroup.map(({ group, connectors }) => {
        const enabledInGroup = connectors.filter((c) => c.enabled).length;
        return (
          <section key={group.id} className="conngroup" aria-label={`连接器组：${group.name}`}>
            <header className="conngroup__head">
              <label className="conngroup__toggle">
                <input
                  type="checkbox"
                  checked={group.enabled}
                  disabled={group.id === '__ungrouped' || busy !== null}
                  onChange={(e) => void toggleGroup(group.id, e.target.checked)}
                  aria-label={`启用连接器组 ${group.name}`}
                />
                <span className="conngroup__name">{group.name}</span>
              </label>
              <span className="conngroup__count">
                {enabledInGroup}/{connectors.length} 生效
              </span>
              {!group.enabled && (
                <span className="conngroup__off">整组已关闭，组内连接器全部不可用</span>
              )}
            </header>
            {group.description !== null && <p className="conngroup__desc">{group.description}</p>}

            <ul className="conngroup__list">
              {connectors.map((connector) => {
                const why = disabledReason(connector);
                const live = health.get(connector.id);
                return (
                  <li key={connector.id} className={`connrow ${connector.enabled ? '' : 'is-off'}`}>
                    <div className="connrow__main">
                      <label className="connrow__toggle">
                        <input
                          type="checkbox"
                          checked={connector.selfEnabled}
                          // 组关着时改单项没有意义：它仍然不生效
                          disabled={!connector.groupEnabled || busy !== null}
                          onChange={(e) => void toggleConnector(connector.id, e.target.checked)}
                          aria-label={`启用连接器 ${connector.name}`}
                        />
                      </label>
                      <button
                        type="button"
                        className="connrow__title"
                        aria-expanded={expanded === connector.id}
                        onClick={() => {
                          const next = expanded === connector.id ? null : connector.id;
                          setExpanded(next);
                          if (next !== null && !tools.has(connector.id) && connector.enabled) {
                            void loadTools(connector.id);
                          }
                        }}
                      >
                        <span className="connrow__name">{connector.name}</span>
                        {connector.builtin && <span className="cbadge">内置</span>}
                        <span className="cbadge cbadge--kind">
                          {connector.kind === 'mcp-http' ? 'HTTP' : 'stdio'}
                        </span>
                        {connector.connected && (
                          <span className="cbadge cbadge--ok">
                            已连接 · {connector.toolCount} 个工具
                          </span>
                        )}
                        {/* 三种「不可用」分开说，否则用户不知道该动哪个开关 */}
                        {why !== null && <span className="cbadge cbadge--off">{why}</span>}
                        {connector.lastError !== null && (
                          <span className="cbadge cbadge--bad" title={connector.lastError}>
                            上次连接失败
                          </span>
                        )}
                      </button>
                    </div>

                    {connector.description !== null && (
                      <p className="connrow__desc">{connector.description}</p>
                    )}

                    {expanded === connector.id && (
                      <div className="connrow__detail">
                        <dl>
                          {connector.sources.length > 0 && (
                            <>
                              <dt>数据来源</dt>
                              <dd>{connector.sources.join('、')}</dd>
                            </>
                          )}
                          <dt>域名</dt>
                          <dd>
                            {connector.domains.length === 0
                              ? '（无）'
                              : connector.domains.map((d) => <code key={d}>{d}</code>)}
                          </dd>
                          {connector.credentialRef !== null && (
                            <>
                              <dt>凭据</dt>
                              {/* 只显示引用名，永不显示密钥本身 */}
                              <dd>
                                <code>{connector.credentialRef}</code>
                              </dd>
                            </>
                          )}
                          {connector.health !== null && (
                            <>
                              <dt>上次健康检查</dt>
                              <dd>
                                {connector.health.ok ? '正常' : '失败'} ·{' '}
                                {timeText(connector.health.checkedAt)}
                                {connector.health.detail === undefined
                                  ? ''
                                  : ` · ${connector.health.detail}`}
                              </dd>
                            </>
                          )}
                          {connector.lastError !== null && (
                            <>
                              <dt>上次错误</dt>
                              <dd className="connrow__error">{connector.lastError}</dd>
                            </>
                          )}
                        </dl>

                        <div className="connrow__actions">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={projectId === null || !connector.enabled || busy !== null}
                            title={
                              projectId === null
                                ? '需要先选一个项目：连接是按项目建立的'
                                : !connector.enabled
                                  ? '先启用它（以及它所属的组）'
                                  : '会真的握手一次并拉取工具清单'
                            }
                            onClick={() => void check(connector.id)}
                          >
                            {busy === `check:${connector.id}` ? '检查中…' : '测试连接'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={projectId === null || !connector.enabled || busy !== null}
                            onClick={() => void loadTools(connector.id)}
                          >
                            {busy === `tools:${connector.id}` ? '加载中…' : '查看工具'}
                          </button>
                        </div>

                        {live !== undefined && (
                          <p
                            className={`connrow__check ${live.ok ? 'is-ok' : 'is-bad'}`}
                            aria-live="polite"
                          >
                            {live.ok
                              ? `连接正常：${live.detail}，${String(live.toolCount)} 个工具`
                              : `连接失败：${live.detail}`}
                          </p>
                        )}

                        {toolError.get(connector.id) !== undefined && (
                          <p className="connrow__error" role="alert">
                            {toolError.get(connector.id)}
                          </p>
                        )}

                        {(tools.get(connector.id) ?? []).length > 0 && (
                          <table className="connrow__tools">
                            <caption>{connector.name} 暴露的工具</caption>
                            <thead>
                              <tr>
                                <th scope="col">工具</th>
                                <th scope="col">说明</th>
                                <th scope="col">授权</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(tools.get(connector.id) ?? []).map((tool) => (
                                <tr key={tool.name}>
                                  <td>
                                    <code>{tool.name}</code>
                                  </td>
                                  <td>{tool.description}</td>
                                  <td>
                                    {/*
                                      readOnlyHint 由服务端自己填，没有强制机制。
                                      因此这里写「服务端声明」而不是「只读」——
                                      把服务端的自述当事实是这套注解最容易被误读的地方。
                                    */}
                                    {tool.readOnly ? (
                                      <span
                                        className="cbadge cbadge--ok"
                                        title="服务端声明为只读，因此不需要每次审批"
                                      >
                                        声明只读
                                      </span>
                                    ) : (
                                      <span
                                        className="cbadge cbadge--warn"
                                        title="每次调用都需要你批准"
                                      >
                                        需审批
                                      </span>
                                    )}
                                    {tool.destructive && (
                                      <span className="cbadge cbadge--bad">有破坏性</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className="conngrants" aria-label="工具级授权">
        <h3>工具级授权（{grants.length}）</h3>
        <p className="conngrants__hint">
          这些是你批准过的、可以不再询问的连接器工具调用。
          {/* 说清它与域名授权的区别，否则用户以为在两个地方看到了同一件事 */}
          它与域名白名单是两件事：同一个连接器上「查一条记录」与「提交一个作业」的风险
          完全不同，用一条连接器级授权覆盖两者等于没有管控。
        </p>
        {grants.length === 0 ? (
          <p className="conngrants__empty">
            还没有任何工具授权。内置连接器全部是公共数据库的只读查询，不需要审批。
          </p>
        ) : (
          <table className="conngrants__table">
            <thead>
              <tr>
                <th scope="col">连接器</th>
                <th scope="col">工具</th>
                <th scope="col">范围</th>
                <th scope="col">批准时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td>{grant.connectorId}</td>
                  <td>
                    <code>{grant.toolName}</code>
                  </td>
                  <td>{SCOPE_LABEL[grant.scope] ?? grant.scope}</td>
                  <td>{timeText(grant.grantedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--deny btn--small"
                      onClick={() => void revoke(grant.id)}
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
