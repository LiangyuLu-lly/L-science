/**
 * 控制面 RPC 服务（任务 12.7，需求 10.8）。
 *
 * 控制面 REPL 里的 Python 代码需要调平台自身的能力（列制品、派子 agent、查 findings）。
 * 内核是独立进程，因此需要一条进程间通道。选回环 HTTP 而不是别的：
 *
 * - **不能走 Jupyter 的 stdin 通道**：我们刻意把 `allow_stdin` 关了（无人应答的
 *   交互输入会让内核永久阻塞）。
 * - **不能走文件轮询**：延迟不可接受，且并发时要自己实现锁。
 * - 回环 HTTP 在 Python 侧只需要标准库 `urllib`，不引任何依赖。
 *
 * ## 这是一个特权面
 *
 * 持有 token 的进程可以调用平台的全部管理能力。因此：
 *
 * - **只有控制面 REPL 内核拿到 token**。普通 `python` 工具的内核不注入它，
 *   模型在普通 cell 里写的代码调不到这里。
 * - 只监听 127.0.0.1。多用户 Windows 上 localhost 不等于可信，所以还要 token。
 * - token 用 `timingSafeEqual` 比较。字符串 `===` 的提前返回会泄漏前缀信息，
 *   而这个端口对本机任何进程都可达。
 *
 * 控制面 REPL 里的代码本身是特权代码——它能读到自己进程的环境变量因而能拿到
 * token，这是设计使然而不是缺陷。真正的边界是「谁能往控制面 REPL 里塞代码」。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * 一次控制面调用的上下文。
 *
 * 会话 id 由 Python 侧随每次调用带上来，而不是在内核启动时固化进环境变量：
 * 控制面单例内核**跨会话复用**，启动时那一刻的会话 id 到下一个会话就是错的，
 * 而后果是子 agent 挂到别的会话下、findings 记到别的会话里——两者都不会报错。
 */
export interface HostCallContext {
  conversationId: string | null;
}

export type HostRpcHandler = (
  params: Record<string, unknown>,
  context: HostCallContext,
) => unknown | Promise<unknown>;

export interface HostRpcServerOptions {
  onLog?: (line: string) => void;
  /** 请求体上限。控制面调用传的是参数而不是数据，1 MB 绰绰有余。 */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const TOKEN_HEADER = 'x-lsci-host-token';

/** 常量时间比较。长度不同直接返回假，但仍然走一次比较避免长度侧信道。 */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    // 与自身比较，保持耗时与成功路径同量级
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class HostRpcServer {
  readonly token: string;
  readonly #handlers = new Map<string, HostRpcHandler>();
  readonly #onLog: (line: string) => void;
  readonly #maxBody: number;

  #server: Server | null = null;
  #port = 0;

  constructor(options: HostRpcServerOptions = {}) {
    this.token = randomBytes(32).toString('hex');
    this.#onLog = options.onLog ?? ((): void => {});
    this.#maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  }

  get port(): number {
    return this.#port;
  }

  /** 已注册的方法名，供 `host.__methods__()` 与错误提示使用。 */
  methods(): readonly string[] {
    return [...this.#handlers.keys()].sort();
  }

  register(method: string, handler: HostRpcHandler): void {
    if (this.#handlers.has(method)) {
      // 重复注册意味着两处实现同一个方法，后者会静默胜出
      throw new Error(`控制面方法重复注册：${method}`);
    }
    this.#handlers.set(method, handler);
  }

  async start(): Promise<number> {
    if (this.#server !== null) return this.#port;

    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 端口 0 让系统分配；只绑回环
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    this.#port = typeof address === 'object' && address !== null ? address.port : 0;
    this.#server = server;
    // 不 unref：控制面服务在后端存续期间必须一直可达
    this.#onLog(`控制面 RPC 就绪 127.0.0.1:${String(this.#port)}`);
    return this.#port;
  }

  /** 注入内核的环境变量。Python 侧的 shim 按这两个名字读取。 */
  env(): Record<string, string> {
    if (this.#server === null) return {};
    return {
      L_SCIENCE_HOST_URL: `http://127.0.0.1:${String(this.#port)}`,
      L_SCIENCE_HOST_TOKEN: this.token,
    };
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

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, closeAfter = false): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        // 请求体没读完就回复时必须让连接关掉：keep-alive 下残留的请求体字节会被
        // 当成下一个请求的开头，而那个「请求」是一段乱码
        ...(closeAfter ? { connection: 'close' } : {}),
      });
      res.end(text, () => {
        if (closeAfter) req.destroy();
      });
    };

    if (req.method !== 'POST') {
      reply(405, { ok: false, error: { message: '只接受 POST' } });
      return;
    }

    const given = req.headers[TOKEN_HEADER];
    if (!tokenMatches(this.token, Array.isArray(given) ? given[0] : given)) {
      // 不说明是缺 token 还是 token 不对：区分它们等于给猜测者反馈
      reply(401, { ok: false, error: { message: '未授权' } });
      return;
    }

    let raw: string;
    try {
      raw = await this.#readBody(req);
    } catch (err) {
      /*
       * 必须先把 413 回出去再断开。
       *
       * 早先这里在超限那一刻就 `req.destroy()`，于是响应还没写出连接就断了，
       * Python 侧看到的是 URLError（「控制面不可达」）——一个把「参数传太大了」
       * 说成「服务挂了」的错误，会让排查方向完全跑偏。
       */
      reply(
        413,
        { ok: false, error: { message: err instanceof Error ? err.message : '读取失败' } },
        true,
      );
      return;
    }

    let parsed: { method?: unknown; params?: unknown; context?: unknown };
    try {
      parsed = JSON.parse(raw) as { method?: unknown; params?: unknown; context?: unknown };
    } catch {
      reply(400, { ok: false, error: { message: '请求体不是合法 JSON' } });
      return;
    }

    if (typeof parsed.method !== 'string') {
      reply(400, { ok: false, error: { message: '缺少 method' } });
      return;
    }

    const handler = this.#handlers.get(parsed.method);
    if (handler === undefined) {
      reply(404, {
        ok: false,
        error: {
          message: `控制面没有方法 ${parsed.method}`,
          // 把可用方法列出来：模型写错方法名时它需要知道有什么
          remediation: `可用方法：${this.methods().join('、')}`,
        },
      });
      return;
    }

    const params =
      typeof parsed.params === 'object' && parsed.params !== null && !Array.isArray(parsed.params)
        ? (parsed.params as Record<string, unknown>)
        : {};

    const rawContext =
      typeof parsed.context === 'object' && parsed.context !== null
        ? (parsed.context as Record<string, unknown>)
        : {};
    const conversationId = rawContext['conversationId'];
    const context: HostCallContext = {
      conversationId:
        typeof conversationId === 'string' && conversationId !== '' ? conversationId : null,
    };

    try {
      const result = await handler(params, context);
      reply(200, { ok: true, result: result ?? null });
    } catch (err) {
      // 处理器抛错是正常路径（参数不对、对象不存在），如实回给 Python 侧抛异常
      reply(200, {
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  async #readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;

    return new Promise<string>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        if (exceeded) return;
        size += chunk.length;
        if (size > this.#maxBody) {
          exceeded = true;
          // 只停止累积，不在这里断开连接：断开会让 413 响应发不出去。
          // 已收到的分片直接丢弃，剩下的由调用方回复后断开时一并作废
          chunks.length = 0;
          reject(new Error(`请求体超过 ${String(this.#maxBody)} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (err) => {
        if (!exceeded) reject(err);
      });
    });
  }
}
