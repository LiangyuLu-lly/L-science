/**
 * 出口代理与域名白名单（任务 5.6，需求 5.8、5.9、17.1）。
 *
 * 一个本地 HTTP 转发代理，向内核注入 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`。
 * 白名单内的域名直接转发，白名单外的**发起用户审批**而不是静默拒绝——静默拒绝
 * 会让代码以一个看不懂的连接错误失败，用户根本不知道是被管控挡住了。
 *
 * **必须如实告知这个管控是代理级的。** 在 native 后端下它可以被绕过：内核里的
 * 代码完全可以忽略环境变量，直接 `socket.connect()` 到任意地址。requests 与
 * urllib 会读 HTTP_PROXY，而 `socket`、`asyncio`、部分带自己网络栈的库不会。
 * 把这层管控说成「网络隔离」是不诚实的——真隔离要靠 WSL2 的网络命名空间。
 *
 * 因此它的定位是：**防止无意的数据外泄，不防止有意的绕过**。一段从网上抄来的
 * 脚本顺手 pip install 或者请求一个统计上报端点，这类事情它能挡住并让用户知道；
 * 一段刻意要外传数据的代码它挡不住。
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { once } from 'node:events';

import type { GrantRepo } from '../repo/grants.js';

/** 一次出口尝试的判定结果。 */
export type EgressVerdict =
  | { allowed: true; reason: 'whitelisted' | 'approved' }
  | { allowed: false; reason: 'denied' | 'timeout' | 'blocked'; detail: string };

export interface EgressAttempt {
  host: string;
  port: number;
  method: string;
  /** 是否是 CONNECT 隧道（HTTPS）。 */
  tunnel: boolean;
}

export interface EgressProxyOptions {
  grants: GrantRepo;
  /** 判定白名单外的域名。通常接审批服务。返回 false 即拒绝。 */
  requestApproval: (attempt: EgressAttempt) => Promise<boolean>;
  /** 记录每次出口尝试，用于审计。 */
  onAttempt?: (attempt: EgressAttempt, verdict: EgressVerdict) => void;
  projectId?: string | null;
  conversationId?: string | null;
  /** 监听地址。默认只绑回环——绑 0.0.0.0 会让同网段的机器都能用这个代理。 */
  host?: string;
  port?: number;
  /**
   * 上游建连超时，默认 30 秒。
   *
   * 必须有。连不上但不立刻报错的目标（被通配 DNS 解析到黑洞地址、或对方端口
   * 有防火墙丢包）会让请求永久挂着，内核里的 HTTP 调用因此永久阻塞，而用户
   * 看到的是「代码卡住了」，完全指不到网络上。
   */
  upstreamTimeoutMs?: number;
}

/**
 * 从 Host 头或 CONNECT 目标解析主机与端口。
 *
 * 必须剥掉端口再比对白名单：白名单里写的是 `pypi.org`，而 CONNECT 目标是
 * `pypi.org:443`。不剥的话永远匹配不上，所有请求都会去走审批。
 */
export function parseTarget(raw: string, defaultPort: number): { host: string; port: number } {
  // IPv6 字面量形如 [::1]:443
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (v6 !== null) {
    return { host: v6[1] ?? '', port: v6[2] === undefined ? defaultPort : Number(v6[2]) };
  }

  const idx = raw.lastIndexOf(':');
  if (idx === -1) return { host: raw.toLowerCase(), port: defaultPort };

  const portPart = raw.slice(idx + 1);
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: raw.toLowerCase(), port: defaultPort };
  }
  return { host: raw.slice(0, idx).toLowerCase(), port };
}

/**
 * 默认放行的目标。
 *
 * 回环地址必须放行：本机的 Ollama 就在 127.0.0.1:11434，把它挡住会让本地模型
 * 完全不可用。而回环流量不出本机，不构成数据外泄。
 *
 * 刻意**不**在这里放行任何外部域名——包括 pypi.org。装包会把代码拉进执行环境，
 * 那是应当被用户看见并同意的事，不该由平台预设。
 */
export function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  );
}

export class EgressProxy {
  readonly #options: EgressProxyOptions;
  readonly #upstreamTimeoutMs: number;
  #server: Server | null = null;
  #port = 0;

  /**
   * 本次会话内已批准的目标。
   *
   * 只存在内存里，与审批服务的拒绝记忆同理：跨进程持久的放行应当走域名白名单
   * （那是显式的、可查看可撤销的），而不是靠代理进程的隐式记忆。
   *
   * 存在的必要性：一次 `pip install` 会对同一主机发几十个请求。不缓存的话
   * 用户要点几十次同意，而那必然训练他习惯性点同意。
   */
  readonly #approvedThisSession = new Set<string>();

  /** 已拒绝的目标。拒绝后不再重复询问（需求 17.3）。 */
  readonly #deniedThisSession = new Map<string, string>();

  constructor(options: EgressProxyOptions) {
    this.#options = options;
    this.#upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
  }

  get port(): number {
    return this.#port;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  /**
   * 注入给内核的环境变量。
   *
   * `NO_PROXY` 必须包含回环：不加的话内核访问本机 Ollama 也会绕一圈代理，
   * 而代理再连回本机，多一跳延迟且在代理未启动时直接失败。
   */
  env(): Record<string, string> {
    if (this.#server === null) return {};
    const url = `http://127.0.0.1:${String(this.#port)}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      // 小写变体也要给：requests 读小写优先，而 urllib 读大写
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
  }

  async start(): Promise<number> {
    if (this.#server !== null) return this.#port;

    const server = createServer();

    // 普通 HTTP 请求
    server.on('request', (req, res) => {
      void this.#handleRequest(req, res);
    });

    // HTTPS 走 CONNECT 隧道。代理看不到隧道内的内容——只能按主机名判断，
    // 这是 TLS 的性质决定的，也是「代理级管控」的一部分含义
    server.on('connect', (req, clientSocket, head) => {
      // 事件签名给的是 Duplex，但代理场景下它实际总是 Socket
      void this.#handleConnect(req, clientSocket as Socket, head);
    });

    server.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    this.#port = typeof address === 'object' && address !== null ? address.port : 0;
    this.#server = server;
    return this.#port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 判定一次出口尝试。 */
  async check(attempt: EgressAttempt): Promise<EgressVerdict> {
    const key = `${attempt.host}:${String(attempt.port)}`;

    // 回环直接放行。本机 Ollama 就在这里，挡住它会让本地模型完全不可用
    if (isLoopback(attempt.host)) {
      return { allowed: true, reason: 'whitelisted' };
    }

    const allowed = this.#options.grants.isDomainAllowed({
      domain: attempt.host,
      projectId: this.#options.projectId ?? null,
      conversationId: this.#options.conversationId ?? null,
    });
    if (allowed.allowed) return { allowed: true, reason: 'whitelisted' };

    if (this.#approvedThisSession.has(key)) {
      return { allowed: true, reason: 'approved' };
    }

    const denied = this.#deniedThisSession.get(key);
    if (denied !== undefined) {
      return { allowed: false, reason: 'denied', detail: denied };
    }

    // 白名单外发起审批，而不是静默拒绝（需求 5.9）
    let approved: boolean;
    try {
      approved = await this.#options.requestApproval(attempt);
    } catch {
      // 审批链路出错时按拒绝处理。默认拒绝是这一层唯一安全的默认值
      approved = false;
    }

    if (approved) {
      this.#approvedThisSession.add(key);
      return { allowed: true, reason: 'approved' };
    }

    const detail =
      `访问 ${attempt.host} 未获批准。这个域名不在白名单内，本次会话不会再重复询问。` +
      '如果确实需要它，请在设置里把它加入域名白名单。';
    this.#deniedThisSession.set(key, detail);
    return { allowed: false, reason: 'denied', detail };
  }

  #report(attempt: EgressAttempt, verdict: EgressVerdict): void {
    this.#options.onAttempt?.(attempt, verdict);
  }

  /** 目标是否就是代理自己。 */
  #isSelf(host: string, port: number): boolean {
    return port === this.#port && isLoopback(host);
  }

  /**
   * 普通 HTTP 请求。
   *
   * 被拒时返回 403 与**可读的中文说明**，而不是直接断开。断开会让 requests 抛
   * 一个 ConnectionError，用户看到的是「连接被重置」——他会去查网络、查防火墙，
   * 而真正的原因是被本平台的白名单挡住了。403 的正文会被 requests 原样带在
   * 异常里，用户至少能看到发生了什么。
   */
  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawTarget = req.headers.host ?? '';
    const { host, port } = parseTarget(rawTarget, 80);
    const attempt: EgressAttempt = { host, port, method: req.method ?? 'GET', tunnel: false };

    if (host === '') {
      this.#deny(res, 400, '代理请求缺少 Host 头，无法判断目标域名。');
      return;
    }

    /*
     * 自环保护。
     *
     * 目标就是代理自己时必须拒绝，否则每个请求都会转发给自己，再转发给自己
     * ——无限递归直到把机器的连接数与内存耗尽。这不是假想场景：客户端拿着
     * HTTP_PROXY 发一个 Host 指向代理的请求就会命中，而回环地址本来是放行的，
     * 因此不会被白名单挡下来。
     */
    if (this.#isSelf(host, port)) {
      this.#deny(res, 421, `目标 ${host}:${String(port)} 就是代理自己，拒绝转发以避免无限循环。`);
      return;
    }

    const verdict = await this.check(attempt);
    this.#report(attempt, verdict);

    if (!verdict.allowed) {
      this.#deny(res, 403, verdict.detail);
      return;
    }

    // 转发。req.url 在代理模式下是绝对 URL
    let path: string;
    try {
      path =
        new URL(req.url ?? '/', `http://${host}`).pathname +
        new URL(req.url ?? '/', `http://${host}`).search;
    } catch {
      path = req.url ?? '/';
    }

    const upstream = httpRequest(
      {
        host,
        port,
        method: req.method,
        path,
        headers: req.headers,
        timeout: this.#upstreamTimeoutMs,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    /*
     * 上游超时必须显式处理。没有它的话，一个连不上但不立刻报错的目标（被通配
     * DNS 解析到黑洞地址、或者对方端口有防火墙丢包）会让这个请求永久挂着——
     * 内核里的 requests 调用因此永久阻塞，而用户看到的是「代码卡住了」，
     * 完全指不到网络上。
     */
    upstream.on('timeout', () => {
      upstream.destroy(new Error(`连接超时（${String(this.#upstreamTimeoutMs)} ms 无响应）`));
    });

    upstream.on('error', (err) => {
      // 上游失败与被管控拒绝要区分开：前者是网络问题，后者是策略问题。
      // 用同一个状态码会让用户分不清该查网络还是查白名单
      this.#deny(res, 502, `无法连接到 ${host}:${String(port)} —— ${err.message}`);
    });

    req.pipe(upstream);
  }

  #deny(res: ServerResponse, status: number, detail: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const body = Buffer.from(
      `${detail}\n\n` +
        '（这条消息来自 L-science 的出口代理。它按域名白名单管控执行平面的网络出口。' +
        '注意：在 native 沙箱后端下这层管控是代理级的，直接建 socket 的代码可以绕过它。）\n',
      'utf8',
    );
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(body.length),
    });
    res.end(body);
  }

  /**
   * CONNECT 隧道（HTTPS）。
   *
   * 代理看不到隧道内的内容，只能按主机名判断。这不是实现上的偷懒——TLS 的
   * 设计就是让中间人看不见，要看内容就得做 MITM，而那需要给内核装一个自签根
   * 证书。给用户的执行环境装根证书是个远比「按域名管控」更危险的操作。
   */
  async #handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const { host, port } = parseTarget(req.url ?? '', 443);
    const attempt: EgressAttempt = { host, port, method: 'CONNECT', tunnel: true };

    if (host === '') {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    // 隧道同样要防自环
    if (this.#isSelf(host, port)) {
      clientSocket.end('HTTP/1.1 421 Refusing to tunnel to self\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const verdict = await this.check(attempt);
    this.#report(attempt, verdict);

    if (!verdict.allowed) {
      /*
       * CONNECT 被拒时只能给一个状态行——隧道还没建立，没法发正文让 TLS 客户端
       * 看见。因此把原因塞进 reason phrase 里：curl 与 requests 都会把它带在
       * 异常消息里，比一个裸的 403 有信息量。
       */
      clientSocket.end(
        `HTTP/1.1 403 Blocked by L-science egress policy: ${host} not in allowlist\r\n` +
          'Content-Length: 0\r\n\r\n',
      );
      return;
    }

    const upstream = netConnect(port, host, () => {
      // 连上之后取消建连超时。隧道本身可以长时间静默（比如一个持续的下载），
      // 把建连超时留着会在传输中途把连接掐掉
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    // 建连阶段的超时。同 HTTP 路径：不设的话连不上但不报错的目标会让隧道
    // 永久挂着，客户端既收不到 200 也收不到错误
    upstream.setTimeout(this.#upstreamTimeoutMs, () => {
      upstream.destroy(new Error(`连接超时（${String(this.#upstreamTimeoutMs)} ms）`));
    });

    upstream.on('error', (err) => {
      if (!clientSocket.writableEnded) {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Error: ${err.message}\r\n\r\n`);
      }
    });

    // 任一端断开都要收掉另一端，否则连接会悬着直到超时
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  }
}
