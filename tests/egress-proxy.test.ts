/**
 * 出口代理测试（任务 5.6，需求 5.8、5.9）。
 *
 * 起真代理、起一个假的上游服务器、发真 HTTP 请求。用假 fetch 测不到这里最重要的
 * 部分——代理协议本身（绝对 URL 的路径改写、CONNECT 隧道、被拒时客户端看到什么）。
 */

import { createServer, request as nodeRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  EgressProxy,
  GrantRepo,
  isLoopback,
  parseTarget,
  type EgressAttempt,
  type EgressVerdict,
} from '@l-science/core';

let root: string;
let store: AppStore;
let grants: GrantRepo;
let proxy: EgressProxy;
let upstream: Server;
let upstreamPort = 0;
let attempts: Array<{ attempt: EgressAttempt; verdict: EgressVerdict }>;
let approvalCalls: EgressAttempt[];
let approveNext = true;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lsci-egress-'));
  store = AppStore.open(root);
  grants = new GrantRepo(store.db);
  attempts = [];
  approvalCalls = [];
  approveNext = true;

  upstream = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`upstream saw ${req.method} ${req.url}`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const addr = upstream.address();
  upstreamPort = typeof addr === 'object' && addr !== null ? addr.port : 0;

  proxy = new EgressProxy({
    grants,
    requestApproval: async (attempt) => {
      approvalCalls.push(attempt);
      return approveNext;
    },
    onAttempt: (attempt, verdict) => attempts.push({ attempt, verdict }),
  });
  await proxy.start();
});

afterEach(async () => {
  await proxy.stop();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * 通过代理发一个普通 HTTP 请求。
 *
 * 必须用 `node:http` 而不是 `fetch`：undici 把 `Host` 当禁止头**静默丢弃**，
 * 于是请求到达代理时 Host 是代理自己的地址。实测踩过这个坑——代理因此认为目标
 * 是自己，转发给自己，无限递归，测试直接挂死。
 *
 * 这里按真实代理协议构造：请求行带绝对 URL，Host 指向目标。
 */
async function viaProxy(
  targetHost: string,
  path = '/',
  proxyPort = proxy.port,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://${targetHost}${path}`,
        headers: { Host: targetHost },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('目标解析', () => {
  it('剥掉端口再比对白名单', () => {
    // 白名单里写的是 pypi.org，而 CONNECT 目标是 pypi.org:443。
    // 不剥的话永远匹配不上，所有请求都会去走审批
    expect(parseTarget('pypi.org:443', 80)).toEqual({ host: 'pypi.org', port: 443 });
  });

  it('没有端口时用默认值', () => {
    expect(parseTarget('example.com', 80)).toEqual({ host: 'example.com', port: 80 });
  });

  it('主机名归一为小写', () => {
    expect(parseTarget('PyPI.ORG:443', 80).host).toBe('pypi.org');
  });

  it('IPv6 字面量', () => {
    expect(parseTarget('[::1]:8080', 80)).toEqual({ host: '::1', port: 8080 });
    expect(parseTarget('[2001:db8::1]', 443)).toEqual({ host: '2001:db8::1', port: 443 });
  });

  it('端口非法时按无端口处理', () => {
    // 不能把 host 当成 'example.com:abc' 去比对白名单
    expect(parseTarget('example.com:abc', 80).port).toBe(80);
  });
});

describe('回环放行', () => {
  it('识别各种回环写法', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '0.0.0.0']) {
      expect(isLoopback(host), host).toBe(true);
    }
  });

  it('外部地址不是回环', () => {
    for (const host of ['example.com', '8.8.8.8', '192.168.1.1']) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it('回环无需审批直接放行', async () => {
    // 本机 Ollama 就在 127.0.0.1:11434，挡住它会让本地模型完全不可用
    const verdict = await proxy.check({
      host: '127.0.0.1',
      port: 11434,
      method: 'POST',
      tunnel: false,
    });
    expect(verdict).toEqual({ allowed: true, reason: 'whitelisted' });
    expect(approvalCalls).toHaveLength(0);
  });

  it('不预设放行任何外部域名', async () => {
    // 包括 pypi.org。装包会把代码拉进执行环境，那是应当被用户看见并同意的事
    approveNext = false;
    const verdict = await proxy.check({
      host: 'pypi.org',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(approvalCalls).toHaveLength(1);
  });
});

describe('白名单与审批（需求 5.9）', () => {
  it('白名单内直接放行，不发审批', async () => {
    grants.allowDomain({ domain: 'allowed.example', mode: 'ro', scope: 'always' });
    const verdict = await proxy.check({
      host: 'allowed.example',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    expect(verdict).toEqual({ allowed: true, reason: 'whitelisted' });
    expect(approvalCalls).toHaveLength(0);
  });

  it('白名单外发起审批而不是静默拒绝', async () => {
    // 静默拒绝会让代码以一个看不懂的连接错误失败，用户根本不知道是被管控挡住的
    approveNext = true;
    const verdict = await proxy.check({
      host: 'new.example',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    expect(verdict).toEqual({ allowed: true, reason: 'approved' });
    expect(approvalCalls[0]).toMatchObject({ host: 'new.example', port: 443 });
  });

  it('批准后本会话内不再重复询问', async () => {
    // 一次 pip install 会对同一主机发几十个请求。不缓存的话用户要点几十次同意，
    // 而那必然训练他习惯性点同意
    approveNext = true;
    await proxy.check({ host: 'repeat.example', port: 443, method: 'CONNECT', tunnel: true });
    await proxy.check({ host: 'repeat.example', port: 443, method: 'CONNECT', tunnel: true });
    await proxy.check({ host: 'repeat.example', port: 443, method: 'CONNECT', tunnel: true });
    expect(approvalCalls).toHaveLength(1);
  });

  it('拒绝后不再重复询问（需求 17.3）', async () => {
    approveNext = false;
    const first = await proxy.check({
      host: 'denied.example',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    const second = await proxy.check({
      host: 'denied.example',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(approvalCalls).toHaveLength(1);
  });

  it('拒绝的说明告诉用户怎么解决', async () => {
    approveNext = false;
    const verdict = await proxy.check({
      host: 'x.example',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.detail).toContain('白名单');
      expect(verdict.detail).toContain('设置里');
    }
  });

  it('不同端口分别判定', async () => {
    approveNext = true;
    await proxy.check({ host: 'multi.example', port: 443, method: 'CONNECT', tunnel: true });
    await proxy.check({ host: 'multi.example', port: 8443, method: 'CONNECT', tunnel: true });
    // 同一主机的不同端口可能是完全不同的服务
    expect(approvalCalls).toHaveLength(2);
  });

  it('审批链路抛错时按拒绝处理', async () => {
    // 默认拒绝是这一层唯一安全的默认值
    const failing = new EgressProxy({
      grants,
      requestApproval: () => {
        throw new Error('审批服务挂了');
      },
    });
    const verdict = await failing.check({
      host: 'y.example',
      port: 443,
      method: 'GET',
      tunnel: false,
    });
    expect(verdict.allowed).toBe(false);
  });

  it('子域通配的白名单生效', async () => {
    grants.allowDomain({ domain: '.example.org', mode: 'ro', scope: 'always' });
    const verdict = await proxy.check({
      host: 'api.example.org',
      port: 443,
      method: 'CONNECT',
      tunnel: true,
    });
    expect(verdict.reason).toBe('whitelisted');
  });

  it('每次尝试都被记录用于审计', async () => {
    grants.allowDomain({ domain: 'audited.example', mode: 'ro', scope: 'always' });
    await viaProxy('audited.example');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]?.attempt.host).toBe('audited.example');
  });
});

describe('HTTP 转发', () => {
  it('白名单内的请求被转发到上游', async () => {
    // 让白名单命中 127.0.0.1 之外的名字，但实际连回本机的上游服务器：
    // 这里直接用回环放行路径验证转发本身
    const res = await viaProxy(`127.0.0.1:${String(upstreamPort)}`, '/hello?a=1');
    expect(res.status).toBe(200);
    expect(res.body).toContain('upstream saw GET');
    // 绝对 URL 被改写成路径后再转发，上游看到的是 /hello?a=1
    expect(res.body).toContain('/hello?a=1');
  });

  it('被拒时返回 403 与可读说明而不是断开连接', async () => {
    /*
     * 断开会让 requests 抛 ConnectionError，用户看到「连接被重置」后会去查网络、
     * 查防火墙，而真正的原因是被白名单挡住了。403 的正文会被带在异常里。
     */
    approveNext = false;
    const res = await viaProxy('blocked.example');
    expect(res.status).toBe(403);
    expect(res.body).toContain('未获批准');
    expect(res.body).toContain('白名单');
  });

  it('拒绝说明里如实告知这层管控可被绕过', async () => {
    // 把代理级管控说成网络隔离是不诚实的
    approveNext = false;
    const res = await viaProxy('blocked2.example');
    expect(res.body).toContain('代理级');
    expect(res.body).toContain('绕过');
  });

  it('缺少 Host 头时报 400 而不是崩溃', async () => {
    // fetch 总会带 Host，用原始 socket 构造一个没有 Host 的请求
    const { connect } = await import('node:net');
    const socket = connect(proxy.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.0\r\n\r\n');
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    await once(socket, 'close');
    expect(Buffer.concat(chunks).toString('utf8')).toContain('400');
  });

  it('上游不可达时报 502，与策略拒绝的 403 区分开', async () => {
    /*
     * 用回环上一个没人监听的端口，而不是一个不存在的域名：`.invalid` 之类的
     * 名字在有通配 DNS 的网络里会被解析到某个黑洞地址，于是连接不是「立刻
     * 拒绝」而是「一直挂着」——测试会卡死而不是失败。这一点是实测踩到的。
     */
    // 取一个既不是上游也不是代理自己的端口。`upstreamPort + 1` 有实测过的
    // 风险：系统分配的两个临时端口常常相邻，那个值可能正好是代理端口，
    // 于是命中自环保护返回 421 而不是 502
    let deadPort = upstreamPort + 1000;
    while (deadPort === proxy.port || deadPort === upstreamPort) deadPort += 1;

    grants.allowDomain({ domain: '127.0.0.1', mode: 'ro', scope: 'always' });
    const res = await viaProxy(`127.0.0.1:${String(deadPort)}`);
    expect(res.status).toBe(502);
    expect(res.body).toContain('无法连接');
  });

  it('上游挂住不响应时按超时收尾而不是永久挂着', async () => {
    /*
     * 起一个接受连接但从不响应的服务器。没有超时的话这个请求会永久挂着，
     * 内核里的 requests 调用因此永久阻塞，用户看到的是「代码卡住了」，
     * 完全指不到网络上。
     */
    const { createServer: createRawServer } = await import('node:net');
    const blackhole = createRawServer(() => {
      /* 接受连接后什么都不做 */
    });
    blackhole.listen(0, '127.0.0.1');
    await once(blackhole, 'listening');
    const addr = blackhole.address();
    const holePort = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const impatient = new EgressProxy({
      grants,
      requestApproval: async () => true,
      upstreamTimeoutMs: 400,
    });
    await impatient.start();

    try {
      const res = await viaProxy(`127.0.0.1:${String(holePort)}`, '/', impatient.port);
      expect(res.status).toBe(502);
      expect(res.body).toContain('超时');
    } finally {
      await impatient.stop();
      // net.Server 没有 closeAllConnections（那是 http.Server 才有的），
      // 用 unref + close 让它不拖住进程退出
      blackhole.unref();
      blackhole.close();
    }
  });
});

describe('环境变量注入', () => {
  it('运行时给出代理地址', () => {
    const env = proxy.env();
    expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${String(proxy.port)}`);
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
  });

  it('大小写变体都给', () => {
    // requests 读小写优先，urllib 读大写
    const env = proxy.env();
    expect(env.http_proxy).toBe(env.HTTP_PROXY);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
  });

  it('NO_PROXY 包含回环', () => {
    /*
     * 不加的话内核访问本机 Ollama 也会绕一圈代理，多一跳延迟，
     * 且在代理未启动时直接失败
     */
    const env = proxy.env();
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('未启动时返回空，不给出一个连不上的地址', async () => {
    const stopped = new EgressProxy({ grants, requestApproval: async () => true });
    expect(stopped.env()).toEqual({});
    expect(stopped.running).toBe(false);
  });

  it('默认只绑回环', () => {
    // 绑 0.0.0.0 会让同网段的机器都能用这个代理
    expect(proxy.env().HTTP_PROXY).toContain('127.0.0.1');
  });

  it('重复 start 幂等', async () => {
    const port = proxy.port;
    expect(await proxy.start()).toBe(port);
  });

  it('stop 后 running 为 false', async () => {
    const temp = new EgressProxy({ grants, requestApproval: async () => true });
    await temp.start();
    expect(temp.running).toBe(true);
    await temp.stop();
    expect(temp.running).toBe(false);
  });
});

describe('自环保护（实测踩到的缺陷）', () => {
  it('目标是代理自己时拒绝转发', async () => {
    /*
     * 不拦的话每个请求都会转发给自己、再转发给自己——无限递归直到把机器的
     * 连接数与内存耗尽。这不是假想场景：客户端拿着 HTTP_PROXY 发一个 Host
     * 指向代理的请求就会命中，而回环地址本来是放行的，因此不会被白名单挡下。
     *
     * 写测试时正是踩到了它：undici 静默丢弃 Host 头，请求到达代理时 Host 成了
     * 代理自己的地址，测试直接挂死。
     */
    const res = await viaProxy(`127.0.0.1:${String(proxy.port)}`);
    expect(res.status).toBe(421);
    expect(res.body).toContain('代理自己');
  });

  it('localhost 写法同样被识别', async () => {
    const res = await viaProxy(`localhost:${String(proxy.port)}`);
    expect(res.status).toBe(421);
  });

  it('回环上的其他端口不受影响', async () => {
    // 只有端口也相同才是自己。本机 Ollama 在别的端口上，必须能正常转发
    const res = await viaProxy(`127.0.0.1:${String(upstreamPort)}`);
    expect(res.status).toBe(200);
  });
});
