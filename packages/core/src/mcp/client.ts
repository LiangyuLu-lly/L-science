/**
 * MCP 客户端（任务 12.13，需求 14.1、14.2、17.1）。
 *
 * 一个连接器 = 一个 MCP 服务端 = 一个 `McpClient` 实例。它负责握手、缓存能力清单、
 * 在每次工具调用前过授权门，并把结果归一化成平台的 `ToolOutput` 语义。
 *
 * ## 授权门为什么在这一层
 *
 * 放在这里而不是放在工具注册表里，是因为**工具清单是运行期从服务端拿到的**。注册表在
 * 构造时不知道有哪些工具，也就没法为每个工具预先声明 `needsApproval`。而授权必须按
 * 「哪个连接器的哪个工具」判定：同一个连接器上「查基因」与「提交作业」的风险完全不同，
 * 用一条连接器级授权覆盖两者等于没有管控。
 *
 * ## 服务端声明的 hint 只影响默认值
 *
 * `annotations.readOnlyHint` 由服务端自己填，没有任何强制机制——一个声称只读的工具完全
 * 可以写数据。因此它只用来决定「默认要不要问用户」，不能用来跳过授权检查本身。
 */

import type { ApprovalService } from '../approval/service.js';
import type { GrantScope } from '@l-science/shared';
import {
  CLIENT_CAPABILITIES,
  MCP_PROTOCOL_VERSION,
  McpError,
  contentToText,
  type McpInitializeResult,
  type McpPrompt,
  type McpResource,
  type McpTool,
  type McpToolResult,
} from './protocol.js';
import type { McpTransport } from './transport.js';

export interface ToolGrantStore {
  /** 是否已有覆盖该工具的有效授权。 */
  isAllowed: (input: {
    connectorId: string;
    toolName: string;
    conversationId: string | null;
    projectId: string | null;
  }) => boolean;
  /** 记一条授权。`once` 不落库，由调用方判断后不调用这里。 */
  allow: (input: {
    connectorId: string;
    toolName: string;
    scope: GrantScope;
    scopeId: string | null;
  }) => void;
}

export interface McpClientOptions {
  connectorId: string;
  connectorName: string;
  transport: McpTransport;
  /** 授权账本。省略时**每次调用都要审批**，不缓存。 */
  grants?: ToolGrantStore;
  /** 审批服务。省略时非只读工具一律拒绝——没有审批通道就不能放行有副作用的调用。 */
  approvals?: ApprovalService;
  onLog?: (line: string) => void;
  /** 单次工具调用的超时。 */
  callTimeoutMs?: number;
}

export interface McpCallContext {
  conversationId: string | null;
  projectId: string | null;
}

export interface McpCallOutcome {
  ok: boolean;
  text: string;
  structured: unknown;
  /** 被授权门拦下时为 true。与工具自身失败区分开。 */
  denied: boolean;
}

/**
 * 单次工具调用的默认超时。
 *
 * **桥里任何端点的超时都必须比它短**，否则客户端会先放弃，而上游请求还在跑——
 * 用户看到「调用超时」，同时那台服务器仍在为一个没人接收的结果干活。
 * `MAX_ENDPOINT_TIMEOUT_MS` 与这条断言在 tests/mcp.test.ts 里守着。
 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export class McpClient {
  readonly connectorId: string;
  readonly connectorName: string;

  readonly #opts: McpClientOptions;
  readonly #onLog: (line: string) => void;

  #initialized: McpInitializeResult | null = null;
  #tools: readonly McpTool[] = [];
  #resources: readonly McpResource[] = [];
  #prompts: readonly McpPrompt[] = [];
  /** 握手中或已完成的那次。并发 connect 必须共享，否则会握两次手。 */
  #connecting: Promise<McpInitializeResult> | null = null;

  constructor(options: McpClientOptions) {
    this.#opts = options;
    this.connectorId = options.connectorId;
    this.connectorName = options.connectorName;
    this.#onLog = options.onLog ?? ((): void => {});
  }

  get info(): McpInitializeResult | null {
    return this.#initialized;
  }

  get tools(): readonly McpTool[] {
    return this.#tools;
  }

  get resources(): readonly McpResource[] {
    return this.#resources;
  }

  get prompts(): readonly McpPrompt[] {
    return this.#prompts;
  }

  /** 握手并拉取能力清单。并发调用共享同一次。 */
  async connect(): Promise<McpInitializeResult> {
    if (this.#initialized !== null) return this.#initialized;
    this.#connecting ??= this.#doConnect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<McpInitializeResult> {
    await this.#opts.transport.start();

    const result = (await this.#opts.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'L-science', version: '1' },
    })) as McpInitializeResult;

    if (typeof result?.protocolVersion !== 'string') {
      throw new McpError('服务端的 initialize 响应缺少 protocolVersion', { retryable: false });
    }
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION) {
      /*
       * 版本不一致只警告不拒绝。
       *
       * MCP 的版本协商允许服务端回一个它支持的版本，多数差异不影响基本的
       * tools/list 与 tools/call。直接拒绝会让一批只是版本号旧一点的服务端全部不可用，
       * 而真正不兼容的地方会在具体调用上报错——那个报错比「版本不匹配」更有指向性。
       */
      this.#onLog(
        `协议版本不一致：我们声明 ${MCP_PROTOCOL_VERSION}，服务端回 ${result.protocolVersion}。继续尝试`,
      );
    }

    // 握手完成的通知。不发的话有些服务端不会开始接受请求
    await this.#opts.transport.notify('notifications/initialized');

    this.#initialized = result;
    await this.refresh();
    return result;
  }

  /**
   * 重新拉取能力清单。
   *
   * 三个 list 各自独立 try：服务端只声明了 tools 时，去调 `resources/list` 会拿到
   * 「方法不存在」——那是正常情况而不是故障，不能因此让整个连接不可用。
   */
  async refresh(): Promise<void> {
    this.#tools = await this.#listSafe<McpTool>('tools/list', 'tools');
    this.#resources = await this.#listSafe<McpResource>('resources/list', 'resources');
    this.#prompts = await this.#listSafe<McpPrompt>('prompts/list', 'prompts');
  }

  async #listSafe<T>(method: string, key: string): Promise<readonly T[]> {
    try {
      const res = (await this.#opts.transport.request(method)) as Record<string, unknown>;
      const items = res?.[key];
      return Array.isArray(items) ? (items as T[]) : [];
    } catch (err) {
      if (err instanceof McpError && !err.retryable) return []; // 未实现该能力
      this.#onLog(`${method} 失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /* ---------------- 工具调用 ---------------- */

  /**
   * 调用一个工具。授权不通过时返回 `denied: true` 而不是抛错。
   *
   * 用返回值而不是异常表达拒绝：拒绝是**正常结果**（需求 17.3 要求拒绝后不得重试同一请求），
   * 用异常表达会让调用方倾向于 catch 之后继续，那正是审批要防的事。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<McpCallOutcome> {
    await this.connect();

    const tool = this.#tools.find((t) => t.name === name);
    if (tool === undefined) {
      const available = this.#tools.map((t) => t.name).join('、');
      return {
        ok: false,
        denied: false,
        structured: null,
        text:
          `连接器 ${this.connectorName} 没有工具 ${name}。` +
          (available === '' ? '它没有暴露任何工具。' : `可用：${available}`),
      };
    }

    const gate = await this.#authorize(tool, args, ctx);
    if (!gate.allowed) {
      return { ok: false, denied: true, structured: null, text: gate.reason };
    }

    let result: McpToolResult;
    try {
      result = (await this.#opts.transport.request(
        'tools/call',
        { name, arguments: args },
        this.#opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      )) as McpToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof McpError ? err.retryable : false;
      return {
        ok: false,
        denied: false,
        structured: null,
        // 可否重试要说出来：不说的话模型会对着一个方法不存在的错误反复试
        text:
          `调用 ${this.connectorName}.${name} 失败：${message}` +
          (retryable ? '（可以重试）' : '（重试不会改变结果，请换个方式）'),
      };
    }

    const content = Array.isArray(result?.content) ? result.content : [];
    return {
      // 工具层面的失败（isError）与协议错误分开：前者模型应当读到并调整
      ok: result?.isError !== true,
      denied: false,
      structured: result?.structuredContent ?? null,
      text: contentToText(content),
    };
  }

  /**
   * 授权门。
   *
   * 顺序刻意如此：
   * 1. 已有有效授权 → 直接放行（不重复打扰用户）
   * 2. 服务端声明只读且非破坏性 → 放行（这是 `readOnlyHint` 唯一的作用）
   * 3. 有审批通道 → 发审批卡片并阻塞等待
   * 4. 没有审批通道 → **拒绝**。没人能批准就不能放行有副作用的调用
   */
  async #authorize(
    tool: McpTool,
    args: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    if (
      this.#opts.grants?.isAllowed({
        connectorId: this.connectorId,
        toolName: tool.name,
        conversationId: ctx.conversationId,
        projectId: ctx.projectId,
      }) === true
    ) {
      return { allowed: true };
    }

    const readOnly = tool.annotations?.readOnlyHint === true;
    const destructive = tool.annotations?.destructiveHint === true;
    if (readOnly && !destructive) return { allowed: true };

    const approvals = this.#opts.approvals;
    if (approvals === undefined) {
      return {
        allowed: false,
        reason:
          `工具 ${this.connectorName}.${tool.name} 未声明为只读，需要用户批准，` +
          '而当前没有可用的审批通道，因此已拒绝。',
      };
    }

    const result = await approvals.request({
      kind: 'ssh-command',
      title: `允许 ${this.connectorName} 执行 ${tool.name}？`,
      detail:
        (tool.description ?? '服务端没有提供说明。') +
        `\n\n参数：${JSON.stringify(args).slice(0, 500)}` +
        (destructive ? '\n\n服务端把这个工具标记为**有破坏性**。' : ''),
      impact:
        `连接器 ${this.connectorName} 将以你的身份执行 ${tool.name}。` +
        '它可能读取或修改该服务上的数据。',
      reversible: !destructive,
      ...(destructive ? { undoHint: null } : { undoHint: '具体能否撤销取决于该服务本身。' }),
      scopeOptions: ['once', 'session', 'project', 'always'],
      payload: { connectorId: this.connectorId, toolName: tool.name },
      ...(ctx.conversationId === null ? {} : { conversationId: ctx.conversationId }),
    });

    if (result.state !== 'approved') {
      const why =
        result.state === 'denied'
          ? result.fromPriorDenial
            ? '此前已拒绝过同一请求，因此没有再次打扰用户。'
            : '用户拒绝了这次调用。'
          : result.state === 'timeout'
            ? '审批超时，按不放行处理。'
            : `审批被取消：${result.reason}`;
      return {
        allowed: false,
        reason: `${why}不要重试同一调用，改问用户想怎么处理，或走别的路径。`,
      };
    }

    // once 不落库：它的意义正是「放行这一次但不建立长期授权」
    if (result.scope !== 'once') {
      this.#opts.grants?.allow({
        connectorId: this.connectorId,
        toolName: tool.name,
        scope: result.scope,
        scopeId:
          result.scope === 'project'
            ? ctx.projectId
            : result.scope === 'session'
              ? ctx.conversationId
              : null,
      });
    }

    return { allowed: true };
  }

  /* ---------------- 资源与提示 ---------------- */

  async readResource(uri: string): Promise<{ ok: boolean; text: string }> {
    await this.connect();
    try {
      const res = (await this.#opts.transport.request('resources/read', { uri })) as {
        contents?: ReadonlyArray<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
      };
      const parts = (res.contents ?? []).map((c) =>
        typeof c.text === 'string' ? c.text : `[二进制资源 ${c.uri} ${c.mimeType ?? ''}]`,
      );
      return { ok: true, text: parts.join('\n') };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; text: string }> {
    await this.connect();
    try {
      const res = (await this.#opts.transport.request('prompts/get', {
        name,
        arguments: args,
      })) as {
        messages?: ReadonlyArray<{ role: string; content: { type: string; text?: string } }>;
      };
      const parts = (res.messages ?? []).map(
        (m) => `${m.role}: ${m.content.text ?? `[${m.content.type}]`}`,
      );
      return { ok: true, text: parts.join('\n') };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await this.#opts.transport.close();
    this.#initialized = null;
    this.#tools = [];
    this.#resources = [];
    this.#prompts = [];
  }
}
