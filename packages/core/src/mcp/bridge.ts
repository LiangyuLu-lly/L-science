/**
 * REST → MCP 桥（任务 12.14，需求 14.1）。
 *
 * 五十个公共数据库都有现成的 REST / GraphQL 接口。要把它们变成 MCP 连接器，有两条路：
 *
 * - 为每个库写一个 MCP 服务端进程。对标产品大概是这么做的，但对本地优先的桌面应用来说
 *   代价不可接受：用户要装五十个包，运行时要 spawn 五十个子进程，而其中任何一个包的
 *   依赖需要现场编译就会让整个安装在没有 C 工具链的机器上失败。
 * - **一个声明式的桥**：每个连接器用数据描述它的端点，桥把这些描述变成 MCP 工具。
 *
 * 选后者。于是「加一个连接器」是加一段数据而不是写一个进程，而这直接决定了五十个连接器
 * 这件事是否可维护。
 *
 * ## 访问控制在哪
 *
 * 桥跑在后端进程里，不经出口代理——出口代理管的是**执行平面**（内核里的代码）。桥这一侧的
 * 控制点是**连接器与组的两级开关**：只有生效的连接器才会被暴露成工具，而 `McpManager`
 * 在建立客户端时就检查了两级开关。
 *
 * 这个划分是刻意的，也要说清楚：用户关掉一个连接器组，桥就不再暴露它的工具；但如果他在
 * `python` 内核里手写 `requests.get('https://rest.ensembl.org/...')`，那条路走的是出口代理，
 * 由域名白名单管。两条路各有自己的控制点，没有一条能绕过另一条。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTool,
} from './protocol.js';

/* ------------------------------------------------------------------ *
 * 端点声明
 * ------------------------------------------------------------------ */

export interface EndpointParam {
  name: string;
  /** 参数出现在哪：路径模板、查询串，还是 JSON 请求体。 */
  in: 'path' | 'query' | 'body';
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description: string;
  default?: string | number | boolean;
  enum?: readonly string[];
  /**
   * 路径参数允许含 `/`。
   *
   * 少数接口把多个路径段当成一个逻辑参数：bioRxiv 的日期区间就是
   * `/details/biorxiv/2026-07-20/2026-07-22`。默认把 `/` 编码成 `%2F` 是对的
   * （基因符号里真的会出现斜杠），所以这里要显式开口子，并且逐段编码 +
   * 拒绝 `..`，免得参数值把请求指到同一站点的别的路径上去。
   */
  slashes?: boolean;
}

export interface EndpointSpec {
  /** 工具名。会被加上连接器前缀，见 `qualifiedName`。 */
  name: string;
  description: string;
  method?: 'GET' | 'POST';
  /** 路径模板，`{name}` 会被路径参数替换。 */
  path: string;
  /**
   * 覆盖桥的 `baseUrl`。
   *
   * 有些数据源把不同能力放在不同主机上：ClinGen 的变异判读在
   * `erepo.clinicalgenome.org`，临床可干预性在 `actionability.clinicalgenome.org`。
   * 硬要拆成两个连接器的话，用户在设置页看到两个「ClinGen」，而它们其实是一件事。
   */
  baseUrl?: string;
  params?: readonly EndpointParam[];
  /** 固定查询参数。用于 `format=json` 这类每次都一样的东西。 */
  fixedQuery?: Readonly<Record<string, string>>;
  /** 固定请求头。 */
  headers?: Readonly<Record<string, string>>;
  /**
   * 从响应里取哪一段。点分路径，支持 `[]` 表示数组。
   * 省略时返回整个响应。
   */
  pick?: string;
  /** 返回数组时的条数上限。防止一次查询把上下文打爆。 */
  limit?: number;
  /**
   * 从结果对象里删掉的字段。
   *
   * 一些端点会在每条记录里塞完整序列。AlphaFold 的 `/prediction/{acc}` 对 BRCA1 返回 8 个
   * 片段、每个片段带两份 1863 aa 的序列——三万字符，而调用方要的只是坐标文件的 URL。
   * 序列本来就该从 `uniprot.get_fasta` 取。
   */
  omit?: readonly string[];
  /**
   * 是否只读。
   *
   * 内置目录里全部为只读——它们都是公共数据库的查询接口。声明它是为了让
   * `McpClient` 的授权门能放行（只读工具不需要每次审批），而这个默认值必须
   * 显式写出来而不是靠「内置的就是只读」这条隐含假设。
   */
  readOnly?: boolean;
  /** GraphQL 端点：把 query 放进 body。 */
  graphql?: string;
  /**
   * 期望的响应类型。默认 `json`。
   *
   * 这条声明的价值在于**把静默失败变成显式失败**：一些站点在路由不存在时不返回 404，
   * 而是回 200 加一整页 HTML（ZINC 的 SPA、UniBind 的 404 页面都是这样）。不声明的话
   * 桥会把那页 HTML 当成结果交给模型，模型则会试着从导航栏里读科学数据。
   *
   * `text` 用于本来就不是 JSON 的端点：FASTA 序列、arXiv 的 Atom XML、TSV 元数据表。
   */
  responseType?: 'json' | 'text';
  /**
   * 覆盖上游超时。BindingDB 按 UniProt 查亲和力实测要五十秒以上。
   */
  timeoutMs?: number;
  /**
   * 不发请求，直接返回这段文本。
   *
   * 少数「连接器」对应的是本地工具或界面（结构编辑器），它没有查询接口。让这类连接器
   * 暴露一个指向 `http://127.0.0.1/` 的端点，结果是一个**永远报 fetch failed 的工具**，
   * 而模型会把那个错误当成暂时故障反复重试。回一段说明它该走哪条路，才是有用的行为。
   */
  staticText?: string;
}

export interface BridgeSpec {
  /** 与 `BuiltinConnector.bridge` 对应。 */
  id: string;
  baseUrl: string;
  /** 该数据源要求的礼貌性标识（多数公共 API 要求带 UA 或联系邮箱）。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  endpoints: readonly EndpointSpec[];
}

/* ------------------------------------------------------------------ *
 * 工具构造
 * ------------------------------------------------------------------ */

/** 从端点声明造出 MCP 工具描述。 */
export function toMcpTool(spec: EndpointSpec): McpTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of spec.params ?? []) {
    properties[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.enum === undefined ? {} : { enum: p.enum }),
      ...(p.default === undefined ? {} : { default: p.default }),
    };
    if (p.required === true) required.push(p.name);
  }

  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      // 只读且非破坏性：授权门据此放行，不必每次打扰用户
      readOnlyHint: spec.readOnly !== false,
      destructiveHint: false,
      idempotentHint: spec.readOnly !== false,
      // 数据来自外部服务，不是封闭世界
      openWorldHint: true,
    },
  };
}

/** 按点分路径取值。`items[]` 取数组本身。 */
export function pickPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') return value;
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return null;
    const key = seg.endsWith('[]') ? seg.slice(0, -2) : seg;
    if (key !== '') {
      if (typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur ?? null;
}

/** 递归删掉指定字段。用于剪掉端点强行塞进来的大字段（序列之类）。 */
export function omitFields(value: unknown, omit: readonly string[] | undefined): unknown {
  if (omit === undefined || omit.length === 0) return value;
  const drop = new Set(omit);
  const walk = (node: unknown, depth: number): unknown => {
    // 深度上限防自引用结构。公共库的响应嵌套很少超过这个
    if (depth > 12) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (drop.has(k)) continue;
      out[k] = walk(v, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * 把参数值收敛到声明的类型。
 *
 * 模型经常把数字写成字符串。走查询串时无所谓（URL 里都是文本），但 GraphQL 的
 * `Int!` 会拒绝 `"5"`，而那个报错读起来像是查询本身写错了。
 */
function coerce(raw: unknown, type: EndpointParam['type']): unknown {
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(n)) throw new Error(`参数值 ${JSON.stringify(raw)} 不是数字`);
    return n;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw new Error(`参数值 ${JSON.stringify(raw)} 不是布尔值`);
  }
  return String(raw);
}

/**
 * 编码一个路径参数。
 *
 * 默认整值编码（斜杠变 `%2F`）。声明了 `slashes` 的参数逐段编码并保留分隔符，
 * 但拒绝空段与 `..`——否则参数值可以把请求挪到同一站点的另一个路径上，
 * 而返回的内容看起来仍然像是这个工具的结果。
 */
function encodePathValue(value: string, param: EndpointParam): string {
  if (param.slashes !== true) return encodeURIComponent(value);
  const segments = value.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`参数 ${param.name} 的路径段不合法：${JSON.stringify(value)}`);
    }
  }
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

/**
 * 构造请求。
 *
 * 路径参数做 URL 编码是必须的：基因符号里有 `/`（少见但存在）、化合物名里有空格与
 * 特殊字符，不编码会拼出一个指向别处的 URL，而服务端会老实地返回那个别处的内容。
 */
export function buildRequest(
  bridge: BridgeSpec,
  spec: EndpointSpec,
  args: Record<string, unknown>,
): { url: string; init: RequestInit } {
  let path = spec.path;
  const query = new URLSearchParams(spec.fixedQuery ?? {});
  const body: Record<string, unknown> = {};
  /**
   * GraphQL 变量。
   *
   * 不能直接把 `args` 当变量：声明里的 `default` 就不会生效，于是任何「必需但有默认值」
   * 的变量在模型省略它时都会让查询失败（gnomAD 的 `referenceGenome` 正是这种）。
   * 类型也要收敛，见 `coerce`。
   */
  const variables: Record<string, unknown> = {};

  for (const p of spec.params ?? []) {
    const raw = args[p.name] ?? p.default;
    if (raw === undefined || raw === null || raw === '') {
      if (p.required === true) throw new Error(`缺少必需参数 ${p.name}`);
      continue;
    }
    const typed = coerce(raw, p.type);
    const value = String(typed);
    if (p.enum !== undefined && !p.enum.includes(value)) {
      throw new Error(`参数 ${p.name} 只能是 ${p.enum.join(' / ')}`);
    }

    if (spec.graphql !== undefined) {
      // GraphQL 端点上 `in` 无意义：所有声明的参数都是变量
      variables[p.name] = typed;
      continue;
    }

    switch (p.in) {
      case 'path':
        path = path.replaceAll(`{${p.name}}`, encodePathValue(value, p));
        break;
      case 'query':
        query.set(p.name, value);
        break;
      case 'body':
        body[p.name] = typed;
        break;
    }
  }

  const unresolved = /\{([A-Za-z0-9_]+)\}/.exec(path);
  if (unresolved !== null) {
    // 未替换的占位会拼出一个字面含 `{id}` 的 URL，服务端返回 404，
    // 而那个 404 看起来像「查不到这条记录」
    throw new Error(`路径参数 ${unresolved[1] ?? ''} 未提供`);
  }

  const qs = query.toString();
  const base = (spec.baseUrl ?? bridge.baseUrl).replace(/\/+$/, '');
  const url = `${base}${path}${qs === '' ? '' : `?${qs}`}`;

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(bridge.defaultHeaders ?? {}),
    ...(spec.headers ?? {}),
  };

  if (spec.graphql !== undefined) {
    return {
      url,
      init: {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query: spec.graphql, variables }),
      },
    };
  }

  const method = spec.method ?? 'GET';
  if (method === 'POST') {
    return {
      url,
      init: {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    };
  }
  return { url, init: { method, headers } };
}

/* ------------------------------------------------------------------ *
 * 桥服务
 * ------------------------------------------------------------------ */

export interface BridgeServerOptions {
  specs: readonly BridgeSpec[];
  onLog?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** 上游超时。公共数据库偶尔很慢，但不能无限等。 */
  upstreamTimeoutMs?: number;
  /** 单次响应的字符上限。超出截断并标注。 */
  maxResponseChars?: number;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_CHARS = 60_000;

export class McpBridgeServer {
  readonly #opts: BridgeServerOptions;
  readonly #onLog: (line: string) => void;
  readonly #fetch: typeof fetch;
  readonly #byId: Map<string, BridgeSpec>;

  #server: Server | null = null;
  #port = 0;

  constructor(options: BridgeServerOptions) {
    this.#opts = options;
    this.#onLog = options.onLog ?? ((): void => {});
    this.#fetch = options.fetchImpl ?? fetch;
    this.#byId = new Map(options.specs.map((s) => [s.id, s]));
  }

  get port(): number {
    return this.#port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  async start(): Promise<number> {
    if (this.#server !== null) return this.#port;

    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.#onLog(`桥处理异常：${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 只绑回环。桥暴露的是「以本机身份查公共库」的能力，不该对网络开放
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    this.#port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    this.#server = server;
    this.#onLog(`REST→MCP 桥就绪 ${this.baseUrl}（${String(this.#byId.size)} 个数据源）`);
    return this.#port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  /** 已注册的桥标识。用于校验内置目录与桥定义是否对得上。 */
  ids(): readonly string[] {
    return [...this.#byId.keys()].sort();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/mcp\/([a-z0-9-]+)$/.exec(url.pathname);
    if (match === null) {
      reply(404, { error: '路径应为 /mcp/<bridge-id>' });
      return;
    }

    const bridge = this.#byId.get(match[1] ?? '');
    if (bridge === undefined) {
      reply(404, { error: `没有这个数据源：${match[1] ?? ''}` });
      return;
    }

    // DELETE 是 MCP 的会话结束。桥是无状态的，直接接受
    if (req.method === 'DELETE') {
      reply(200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      reply(405, { error: '只接受 POST' });
      return;
    }

    const raw = await this.#readBody(req);
    let frame: JsonRpcRequest;
    try {
      frame = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      reply(200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_PARSE_ERROR, message: '请求体不是合法 JSON' },
      } satisfies JsonRpcResponse);
      return;
    }

    // 通知没有 id，不需要响应
    if (frame.id === undefined) {
      reply(202, {});
      return;
    }

    const respond = (payload: Omit<JsonRpcResponse, 'jsonrpc' | 'id'>): void => {
      reply(200, { jsonrpc: '2.0', id: frame.id ?? null, ...payload } satisfies JsonRpcResponse);
    };

    switch (frame.method) {
      case 'initialize':
        respond({
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: `L-science bridge: ${bridge.id}`, version: '1' },
            instructions:
              `本连接器把 ${bridge.baseUrl} 的公开接口暴露为工具。全部只读。` +
              '返回的是原始 JSON，字段含义参见该数据源的官方文档。',
          },
        });
        return;

      case 'tools/list':
        respond({ result: { tools: bridge.endpoints.map(toMcpTool) } });
        return;

      case 'tools/call': {
        const params = (frame.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        const spec = bridge.endpoints.find((e) => e.name === name);
        if (spec === undefined) {
          respond({
            error: {
              code: RPC_INVALID_PARAMS,
              message: `没有工具 ${name}。可用：${bridge.endpoints.map((e) => e.name).join('、')}`,
            },
          });
          return;
        }
        const args =
          typeof params.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        respond({ result: await this.#call(bridge, spec, args) });
        return;
      }

      // 桥不提供资源与提示。明确回空而不是报错：客户端会在握手后逐个探测
      case 'resources/list':
        respond({ result: { resources: [] } });
        return;
      case 'prompts/list':
        respond({ result: { prompts: [] } });
        return;
      case 'ping':
        respond({ result: {} });
        return;

      default:
        respond({
          error: { code: RPC_METHOD_NOT_FOUND, message: `桥不支持 ${frame.method}` },
        });
        return;
    }
  }

  /** 执行一次上游调用，把结果包成 MCP 的工具返回。 */
  async #call(
    bridge: BridgeSpec,
    spec: EndpointSpec,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  }> {
    // 静态端点不发请求
    if (spec.staticText !== undefined) {
      return { content: [{ type: 'text', text: spec.staticText }] };
    }

    let built: { url: string; init: RequestInit };
    try {
      built = buildRequest(bridge, spec, args);
    } catch (err) {
      // 参数问题是工具层失败而不是协议错误：模型应当读到它并改参数
      return {
        isError: true,
        content: [
          { type: 'text', text: `参数不合法：${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }

    const controller = new AbortController();
    const timeout = spec.timeoutMs ?? this.#opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();

    let res: Response;
    try {
      res = await this.#fetch(built.url, { ...built.init, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: aborted
              ? `请求 ${bridge.id} 超时（${String(timeout)} ms）。这个数据源此刻可能很慢，可以稍后重试。`
              : `请求 ${bridge.id} 失败：${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    } finally {
      clearTimeout(timer);
    }

    /*
     * 读响应体也会失败：连接中途被重置、上游超时在读到一半时触发。
     *
     * 不能把它吞成空串——空串会走到下面的「不是 JSON」分支，报出一条
     * 「响应体无法解析为 JSON，开头：」的空信息，而真实原因是连接断了。
     * 这两件事的应对完全不同（一个该重试，一个该改声明）。
     */
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `读取 ${bridge.id} 的响应失败：${err instanceof Error ? err.message : String(err)}。` +
              '连接可能在传输中断开，这类失败可以重试；' +
              '如果这个查询本来就会返回很大的结果，先把条数或阈值收紧。',
          },
        ],
      };
    }

    if (!res.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            // 把状态码给出来：404 是「查不到」，429 是「太频繁」，两者的应对完全不同
            text:
              `${bridge.id} 返回 ${String(res.status)}。` +
              (res.status === 404
                ? '通常表示查不到这条记录，检查标识符类型与拼写。'
                : res.status === 429
                  ? '请求过于频繁，请降低频率后重试。'
                  : res.status >= 500
                    ? '数据源自身出错，可以稍后重试。'
                    : '请检查参数。') +
              `\n${text.slice(0, 500)}`,
          },
        ],
      };
    }

    // 声明为纯文本的端点（FASTA、Atom XML、TSV）：原样返回，不试着解析
    if (spec.responseType === 'text') {
      return { content: [{ type: 'text', text: this.#truncate(text) }] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      /*
       * 期望 JSON 却拿到别的东西。
       *
       * 这一条不能宽容处理。有些站点在路由不存在时回 200 加一整页 HTML（ZINC 的单页应用、
       * UniBind 的 404 页），旧实现会把那页 HTML 当成结果交给模型——于是模型开始从导航栏里
       * 读数据，而调用方看到的是「成功」。把它报成错误才能让这类端点声明错误暴露出来。
       */
      const head = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      const looksHtml = /^<(!doctype|html|\?xml)/i.test(text.trimStart());
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${bridge.id}.${spec.name} 返回的不是 JSON（content-type ${res.headers.get('content-type') ?? '未知'}）。` +
              (looksHtml
                ? '拿到的是一个网页，通常说明这个路径在该站点上不存在，或者该接口只对浏览器开放。'
                : '响应体无法解析为 JSON。') +
              `\n开头：${head}`,
          },
        ],
      };
    }

    /*
     * GraphQL 的失败是 HTTP 200 + `errors`。
     *
     * 不特判的话 `pick: 'data.gene'` 会取到 null，然后被当成成功返回一个空结果——
     * 调用方读到的是「这个基因没有约束数据」，而真实原因可能是变量类型写错了。
     */
    if (spec.graphql !== undefined && typeof parsed === 'object' && parsed !== null) {
      const errors = (parsed as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const messages = errors
          .map((e) =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as { message?: unknown }).message === 'string'
              ? (e as { message: string }).message
              : JSON.stringify(e),
          )
          .join('；');
        return {
          isError: true,
          content: [{ type: 'text', text: `${bridge.id} 的 GraphQL 查询报错：${messages}` }],
        };
      }
    }

    let picked = omitFields(pickPath(parsed, spec.pick), spec.omit);
    if (Array.isArray(picked) && spec.limit !== undefined && picked.length > spec.limit) {
      const total = picked.length;
      picked = picked.slice(0, spec.limit);
      return {
        structuredContent: picked,
        content: [
          {
            type: 'text',
            text:
              `（共 ${String(total)} 条，只显示前 ${String(spec.limit)} 条）\n` +
              this.#truncate(JSON.stringify(picked, null, 2)),
          },
        ],
      };
    }

    return {
      structuredContent: picked,
      content: [{ type: 'text', text: this.#truncate(JSON.stringify(picked, null, 2)) }],
    };
  }

  #truncate(text: string): string {
    const max = this.#opts.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n\n[... 已截断 ${String(text.length - max)} 字符。请用更具体的查询条件缩小结果 ...]`;
  }

  async #readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    return new Promise<string>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('请求体过大'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
