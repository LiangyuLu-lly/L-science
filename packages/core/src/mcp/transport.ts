/**
 * MCP 传输层（任务 12.13，需求 14.1）。
 *
 * 两种传输，语义差别不只是「一个走管道一个走网络」：
 *
 * - **stdio**：我们启动服务端进程，它的生命周期由我们管。进程退出就是连接断开，
 *   而且它继承我们的工作目录与环境变量——因此**必须显式收窄环境**，否则一个第三方
 *   连接器进程能读到 `L_SCIENCE_HOST_TOKEN` 这类特权凭据。
 * - **HTTP/SSE**（Streamable HTTP）：POST 发请求，服务端可以用 SSE 回流式响应，
 *   也可以直接回 JSON。会话由 `Mcp-Session-Id` 头维持。
 *
 * 两者共用的一条纪律：**每个在途请求都必须有超时**。没有超时的 JSON-RPC 客户端在
 * 服务端不回应时会永久挂住一个 Promise，而症状是「某个工具调用之后整个回合不动了」，
 * 完全指不到连接器上。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  McpError,
  RPC_INTERNAL_ERROR,
  toMcpError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';

/** 单个请求的默认超时。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 单帧上限。连接器返回的是元数据，不是数据文件。 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface McpTransport {
  readonly kind: 'stdio' | 'http';
  start: () => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  notify: (method: string, params?: unknown) => Promise<void>;
  close: () => Promise<void>;
  readonly closed: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** 在途请求的公共记账。两种传输的差别只在怎么发、怎么收。 */
abstract class BaseTransport implements McpTransport {
  abstract readonly kind: 'stdio' | 'http';

  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closed = false;

  protected constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  get closed(): boolean {
    return this.#closed;
  }

  abstract start(): Promise<void>;
  protected abstract send(frame: JsonRpcRequest): Promise<void>;
  protected abstract shutdown(): Promise<void>;

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) throw new McpError('连接已关闭', { retryable: false });

    const id = this.#nextId;
    this.#nextId += 1;

    const frame: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new McpError(`调用 ${method} 超时（${String(timeoutMs ?? this.#timeoutMs)} ms 未响应）`, {
            retryable: true,
          }),
        );
      }, timeoutMs ?? this.#timeoutMs);
      timer.unref?.();

      // 先登记再发送：反过来的话，一个同步回复的传输（测试里的假传输）可能在
      // 等待者就位之前就把响应送到，于是响应被当成「无主回复」丢掉
      this.#pending.set(id, { resolve, reject, timer, method });

      this.send(frame).catch((err: unknown) => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(err);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    await this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** 子类收到一帧响应时调这里。 */
  protected deliver(frame: JsonRpcResponse): void {
    if (frame.id === null || frame.id === undefined) return; // 服务端发起的通知，忽略
    const id = typeof frame.id === 'number' ? frame.id : Number(frame.id);
    const entry = this.#pending.get(id);
    if (entry === undefined) return;

    this.#pending.delete(id);
    clearTimeout(entry.timer);

    if (frame.error !== undefined) entry.reject(toMcpError(frame.error));
    else entry.resolve(frame.result);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    /*
     * 必须把在途请求一一 reject。
     *
     * 丢弃它们会让 await 的调用方永久挂起，而那正是「关掉连接器之后整个回合不动了」
     * 这类问题的来源——进程都退了，Promise 还在等。
     */
    for (const [id, entry] of [...this.#pending]) {
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new McpError(`连接已关闭，${entry.method} 未完成`, { retryable: true }));
    }

    await this.shutdown();
  }
}

/* ------------------------------------------------------------------ *
 * stdio
 * ------------------------------------------------------------------ */

export interface StdioTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * 传给子进程的环境变量。
   *
   * **不继承 `process.env`。** 这是硬要求：后端进程里有 `L_SCIENCE_HOST_TOKEN`
   * （控制面特权凭据）、供应商 API key 可能出现在环境里、以及出口代理地址。一个第三方
   * 连接器进程拿到这些等于绕过了平台的全部管控，而它只是想让我们帮它查个基因。
   *
   * 需要 PATH 之类的基础变量由 `allowFromParent` 显式点名。
   */
  env?: Readonly<Record<string, string>>;
  /** 从父进程环境里放行的变量名。默认只放行定位可执行文件必需的那几个。 */
  allowFromParent?: readonly string[];
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

/** 默认放行的父进程变量。只够找到可执行文件与临时目录。 */
const DEFAULT_ALLOW: readonly string[] = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
];

export class StdioMcpTransport extends BaseTransport {
  readonly kind = 'stdio' as const;
  readonly #opts: StdioTransportOptions;
  readonly #onLog: (line: string) => void;
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';

  constructor(options: StdioTransportOptions) {
    super(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#opts = options;
    this.#onLog = options.onLog ?? ((): void => {});
  }

  async start(): Promise<void> {
    if (this.#child !== null) return;

    const allow = this.#opts.allowFromParent ?? DEFAULT_ALLOW;
    const env: Record<string, string> = {};
    for (const key of allow) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.#opts.env ?? {});

    const child = spawn(this.#opts.command, [...(this.#opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.#opts.cwd === undefined ? {} : { cwd: this.#opts.cwd }),
      env,
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#buffer += chunk;
      this.#drain();
    });

    // 服务端的日志走 stderr（MCP 的约定）。它不是协议内容，但排查时是唯一线索
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() !== '') this.#onLog(`[server] ${line}`);
      }
    });

    child.on('exit', (code, signal) => {
      this.#onLog(`服务端进程退出 code=${String(code)} signal=${String(signal)}`);
      // 进程没了就等于连接断了。不主动 close 的话在途请求只能等到超时
      void this.close();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(
          new McpError(`无法启动 MCP 服务端 ${this.#opts.command}：${err.message}`, {
            retryable: false,
          }),
        );
      };
      child.once('error', onError);
      // spawn 成功的判据是拿到 pid。等 'spawn' 事件比 setTimeout 可靠
      child.once('spawn', () => {
        child.off('error', onError);
        resolve();
      });
    });

    this.#child = child;
  }

  #drain(): void {
    for (;;) {
      const nl = this.#buffer.indexOf('\n');
      if (nl === -1) {
        if (this.#buffer.length > MAX_FRAME_BYTES) {
          // 超长且没有换行说明对端在乱写。清掉缓冲，否则内存一直涨
          this.#onLog(`丢弃超长帧（${String(this.#buffer.length)} 字节，无换行）`);
          this.#buffer = '';
        }
        return;
      }

      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line === '') continue;

      try {
        this.deliver(JSON.parse(line) as JsonRpcResponse);
      } catch {
        // 单个坏帧不该让整条连接失效——服务端可能往 stdout 打了一行日志
        this.#onLog(`stdout 上出现非 JSON 内容，已忽略：${line.slice(0, 120)}`);
      }
    }
  }

  protected async send(frame: JsonRpcRequest): Promise<void> {
    const child = this.#child;
    if (child === null) throw new McpError('传输尚未启动', { retryable: false });
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`, (err) => {
        if (err === null || err === undefined) resolve();
        else reject(new McpError(`写入服务端失败：${err.message}`, { retryable: true }));
      });
    });
  }

  protected async shutdown(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;

    child.stdin.end();

    // 给它一点时间自己退，超时就杀。不杀的话孤儿进程会一直留着
    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once('exit', () => r(true))),
      new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), 3000);
        t.unref?.();
      }),
    ]);
    if (!exited) child.kill();
  }
}

/* ------------------------------------------------------------------ *
 * HTTP / SSE（Streamable HTTP）
 * ------------------------------------------------------------------ */

export interface HttpTransportOptions {
  url: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  /** 注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch;
}

export class HttpMcpTransport extends BaseTransport {
  readonly kind = 'http' as const;
  readonly #opts: HttpTransportOptions;
  readonly #onLog: (line: string) => void;
  readonly #fetch: typeof fetch;
  #sessionId: string | null = null;

  constructor(options: HttpTransportOptions) {
    super(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#opts = options;
    this.#onLog = options.onLog ?? ((): void => {});
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {
    // Streamable HTTP 没有独立的建连步骤，initialize 那一次 POST 就是建连
  }

  protected async send(frame: JsonRpcRequest): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 必须同时接受两者：服务端可以选择直接回 JSON，也可以回 SSE 流
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(this.#opts.headers ?? {}),
    };
    if (this.#sessionId !== null) headers['mcp-session-id'] = this.#sessionId;

    let res: Response;
    try {
      res = await this.#fetch(this.#opts.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(frame),
      });
    } catch (err) {
      throw new McpError(
        `连接 ${this.#opts.url} 失败：${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    }

    // 会话 id 在第一次响应里给出，之后每次都要带上
    const session = res.headers.get('mcp-session-id');
    if (session !== null && session !== '') this.#sessionId = session;

    if (res.status === 202) return; // 通知被接受，没有响应体

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new McpError(`服务端返回 ${String(res.status)}：${body.slice(0, 300)}`, {
        code: RPC_INTERNAL_ERROR,
        // 4xx 是我们的问题，重试无用；5xx 与 429 值得重试
        retryable: res.status >= 500 || res.status === 429,
      });
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await this.#consumeSse(res);
      return;
    }

    const text = await res.text();
    if (text.trim() === '') return;
    try {
      const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
      // 批量响应也要认：JSON-RPC 允许数组
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) this.deliver(item);
    } catch {
      throw new McpError(`服务端响应不是合法 JSON：${text.slice(0, 200)}`, { retryable: false });
    }
  }

  /**
   * 消费 SSE 流。
   *
   * 手写解析而不是用 EventSource：EventSource 只支持 GET，而 Streamable HTTP 的流是
   * POST 的响应体。
   */
  async #consumeSse(res: Response): Promise<void> {
    const body = res.body;
    if (body === null) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // 事件以空行分隔
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');

        if (data !== '') {
          try {
            this.deliver(JSON.parse(data) as JsonRpcResponse);
          } catch {
            this.#onLog(`SSE 事件不是合法 JSON，已忽略：${data.slice(0, 120)}`);
          }
        }
        sep = buf.indexOf('\n\n');
      }
    }
  }

  protected async shutdown(): Promise<void> {
    if (this.#sessionId === null) return;
    // 显式结束会话，让服务端释放资源。失败无所谓，我们这边已经关了
    try {
      await this.#fetch(this.#opts.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.#sessionId, ...(this.#opts.headers ?? {}) },
      });
    } catch {
      // 忽略
    }
    this.#sessionId = null;
  }
}
