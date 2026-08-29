/**
 * 连接器管理（任务 12.13，需求 14.1、14.2）。
 *
 * 负责按注册表把 MCP 客户端建起来、缓存连接、汇总工具清单、做健康检查。
 *
 * ## 需求 14.2 的硬约束
 *
 * > 系统应仅在控制面 REPL 内核暴露 MCP 调用表面，Python 与 R 内核不得具备 MCP 通道。
 *
 * 这条靠**结构**保证而不是靠条件判断：
 *
 * - MCP 客户端只被 `hostapi` 的 `mcp` 表面引用，而那个表面只在控制面 RPC 服务上注册；
 *   控制面 token 只注入控制面内核池（见 `hostapi/repl.ts` 与 backend 里两个池的构造）。
 * - **不注册任何 `mcp_*` 工具进 ToolRegistry。** 一旦注册，普通 `python` 内核所在的会话
 *   里模型就能直接调用它，那就等于给了普通内核 MCP 通道。这是最容易不小心违反的一条：
 *   加一个工具比走 host 表面方便得多。
 *
 * 因此这个文件里没有任何 `createXxxTool`。要用 MCP 就得写控制面代码。
 */

import { createHash } from 'node:crypto';

import type { ApprovalService } from '../approval/service.js';
import type { ConnectorRecord, ConnectorRepo } from '../repo/connectors.js';
import { McpClient, type McpCallContext, type McpCallOutcome } from './client.js';
import { McpError, type McpTool } from './protocol.js';
import { HttpMcpTransport, StdioMcpTransport, type McpTransport } from './transport.js';

export interface McpManagerOptions {
  repo: ConnectorRepo;
  /** 取凭据明文。连接器的 header/env 里的 `${credential}` 占位会被替换。 */
  resolveCredential?: (ref: string) => string | null;
  approvals?: (projectId: string | null) => ApprovalService | null;
  onLog?: (line: string) => void;
  /** 注入 fetch，便于测试 HTTP 传输。 */
  fetchImpl?: typeof fetch;
  /** 连接建立的超时。 */
  connectTimeoutMs?: number;
}

export interface ConnectorToolInfo {
  connectorId: string;
  connectorName: string;
  tool: McpTool;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  groupId: string | null;
  kind: ConnectorRecord['kind'];
  enabled: boolean;
  builtin: boolean;
  connected: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  serverInfo: { name: string; version: string } | null;
  lastError: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export class McpManager {
  readonly #opts: McpManagerOptions;
  readonly #onLog: (line: string) => void;
  /** 已连接的客户端，按连接器 id。 */
  readonly #clients = new Map<string, McpClient>();
  /** 正在连接的那次。并发请求共享，否则会为同一个连接器起两个进程。 */
  readonly #connecting = new Map<string, Promise<McpClient>>();

  #closed = false;

  constructor(options: McpManagerOptions) {
    this.#opts = options;
    this.#onLog = options.onLog ?? ((): void => {});
  }

  /* ---------------- 连接 ---------------- */

  /**
   * 取得（必要时建立）某个连接器的客户端。
   *
   * 两级开关都要过：连接器自己启用 **且** 所属组启用。只看一级会让「关掉整组」失效，
   * 而用户会以为已经关了。
   */
  async client(connectorId: string): Promise<McpClient> {
    if (this.#closed) throw new McpError('连接器管理已关闭', { retryable: false });

    const existing = this.#clients.get(connectorId);
    if (existing !== undefined) return existing;

    const inFlight = this.#connecting.get(connectorId);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#connect(connectorId).finally(() => {
      this.#connecting.delete(connectorId);
    });
    this.#connecting.set(connectorId, promise);
    return promise;
  }

  async #connect(connectorId: string): Promise<McpClient> {
    const record = this.#opts.repo.get(connectorId);
    if (record === null) throw new McpError(`连接器不存在：${connectorId}`, { retryable: false });

    const effective = this.#opts.repo.listEffective().some((c) => c.id === connectorId);
    if (!effective) {
      const group = record.groupId === null ? null : this.#opts.repo.getGroup(record.groupId);
      throw new McpError(
        `连接器 ${record.name} 未启用` +
          (group !== null && !group.enabled ? `（所属组「${group.name}」已关闭）` : ''),
        { retryable: false },
      );
    }

    const transport = this.#buildTransport(record);
    const client = new McpClient({
      connectorId: record.id,
      connectorName: record.name,
      transport,
      grants: {
        isAllowed: (input) => this.#opts.repo.isToolAllowed(input),
        allow: (input) => {
          this.#opts.repo.allowTool(input);
        },
      },
      ...(this.#opts.approvals === undefined
        ? {}
        : (() => {
            const svc = this.#opts.approvals(null);
            return svc === null ? {} : { approvals: svc };
          })()),
      onLog: (line) => {
        this.#onLog(`[${record.name}] ${line}`);
      },
    });

    const timeout = this.#opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new McpError(`连接 ${record.name} 超时（${String(timeout)} ms）`, {
                  retryable: true,
                }),
              ),
            timeout,
          );
          t.unref?.();
        }),
      ]);
    } catch (err) {
      // 连接失败要落库：健康状态是用户排查的第一入口，只记内存的话重启就没了
      const detail = err instanceof Error ? err.message : String(err);
      this.#opts.repo.recordHealth(record.id, { ok: false, checkedAt: Date.now(), detail });
      await client.close().catch(() => undefined);
      throw err;
    }

    this.#opts.repo.recordHealth(record.id, { ok: true, checkedAt: Date.now() });
    this.#clients.set(record.id, client);
    this.#onLog(
      `连接器就绪 ${record.name}：${String(client.tools.length)} 个工具、` +
        `${String(client.resources.length)} 个资源、${String(client.prompts.length)} 个提示`,
    );
    return client;
  }

  #buildTransport(record: ConnectorRecord): McpTransport {
    const cfg = record.config;
    const secret =
      record.credentialRef === null
        ? null
        : (this.#opts.resolveCredential?.(record.credentialRef) ?? null);

    /** 把配置里的 `${credential}` 换成明文。凭据本身不落配置文件。 */
    const fill = (value: string): string =>
      secret === null ? value : value.replaceAll('${credential}', secret);

    if (record.kind === 'mcp-http') {
      const url = typeof cfg.url === 'string' ? cfg.url : '';
      if (url === '') throw new McpError(`连接器 ${record.name} 缺少 url`, { retryable: false });

      const rawHeaders =
        typeof cfg.headers === 'object' && cfg.headers !== null
          ? (cfg.headers as Record<string, string>)
          : {};
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k] = fill(String(v));

      return new HttpMcpTransport({
        url,
        headers,
        onLog: (line) => {
          this.#onLog(`[${record.name}] ${line}`);
        },
        ...(this.#opts.fetchImpl === undefined ? {} : { fetchImpl: this.#opts.fetchImpl }),
      });
    }

    const command = typeof cfg.command === 'string' ? cfg.command : '';
    if (command === '')
      throw new McpError(`连接器 ${record.name} 缺少 command`, { retryable: false });

    const rawEnv =
      typeof cfg.env === 'object' && cfg.env !== null ? (cfg.env as Record<string, string>) : {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) env[k] = fill(String(v));

    return new StdioMcpTransport({
      command,
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).map((a) => fill(String(a))) : [],
      ...(typeof cfg.cwd === 'string' ? { cwd: cfg.cwd } : {}),
      env,
      onLog: (line) => {
        this.#onLog(`[${record.name}] ${line}`);
      },
    });
  }

  /* ---------------- 汇总 ---------------- */

  /**
   * 列出全部生效连接器的工具。
   *
   * 逐个连接：某个连接器连不上不影响其余。这一点很重要——五十个内置连接器里有一个的
   * 服务临时挂了，不该让整个 `host.mcp.tools()` 报错。
   */
  async tools(): Promise<readonly ConnectorToolInfo[]> {
    const out: ConnectorToolInfo[] = [];
    for (const record of this.#opts.repo.listEffective()) {
      try {
        const client = await this.client(record.id);
        for (const tool of client.tools) {
          out.push({ connectorId: record.id, connectorName: record.name, tool });
        }
      } catch (err) {
        this.#onLog(`跳过 ${record.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /** 状态总览。不触发连接——它要能在什么都没连的时候回答。 */
  status(): readonly ConnectorStatus[] {
    return this.#opts.repo.list({ includeDisabled: true }).map((record) => {
      const client = this.#clients.get(record.id);
      const group = record.groupId === null ? null : this.#opts.repo.getGroup(record.groupId);
      return {
        id: record.id,
        name: record.name,
        groupId: record.groupId,
        kind: record.kind,
        // 两级开关都算进来，UI 上显示的「已启用」要与实际可用一致
        enabled: record.enabled && (group === null || group.enabled),
        builtin: record.builtin,
        connected: client !== undefined,
        toolCount: client?.tools.length ?? 0,
        resourceCount: client?.resources.length ?? 0,
        promptCount: client?.prompts.length ?? 0,
        serverInfo: client?.info?.serverInfo ?? null,
        lastError: record.lastError,
      };
    });
  }

  /** 调用某个连接器的工具。授权门在 `McpClient` 里。 */
  async callTool(
    connectorId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<McpCallOutcome> {
    const client = await this.client(connectorId);
    return client.callTool(toolName, args, ctx);
  }

  /** 健康检查。连上再断，用于设置页的「测试连接」。 */
  async check(connectorId: string): Promise<{ ok: boolean; detail: string; toolCount: number }> {
    try {
      const client = await this.client(connectorId);
      await client.refresh();
      return {
        ok: true,
        detail:
          client.info === null
            ? '已连接'
            : `${client.info.serverInfo.name} ${client.info.serverInfo.version}`,
        toolCount: client.tools.length,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        toolCount: 0,
      };
    }
  }

  /**
   * 断开某个连接器。
   *
   * 禁用连接器时必须连带断开：只改数据库标记的话已建立的连接还在，模型仍然能通过
   * 已缓存的客户端调用它——用户以为关了但实际没关。
   */
  async disconnect(connectorId: string): Promise<void> {
    const client = this.#clients.get(connectorId);
    if (client === undefined) return;
    this.#clients.delete(connectorId);
    await client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

/** 内置连接器定义的内容指纹。用于判断是否需要重新同步。 */
export function connectorFingerprint(input: {
  id: string;
  kind: string;
  config: unknown;
  domains: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: input.id,
        kind: input.kind,
        config: input.config,
        domains: [...input.domains].sort(),
      }),
    )
    .digest('hex');
}
