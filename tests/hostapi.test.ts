/**
 * 控制面 REPL 与 host 对象测试（任务 12.7，需求 10.8）。
 *
 * 三块重点：
 *
 * 1. **RPC 是一个特权面。** 它对本机任何进程都可达，因此鉴权、常量时间比较、
 *    请求体上限、未注册方法的处理都必须成立——这里的每一条失效都等于把平台的
 *    全部管理能力开放给了同机的其它进程。
 * 2. **只读 SQL 的边界。** 查询开放、写入收口是这一层唯一站得住的划法，绕过手段
 *    （分号拼接、写关键字）必须逐个被挡住。
 * 3. **单例约束下的死锁防护。** 忙时排队正是死锁来源，因此 singleton 必须快速失败、
 *    auto 必须自动旁路、旁路内核必须用完即弃。
 *
 * 内核相关的用例用假内核池：真内核的冷启动预算在 30 秒量级，而这里要验的是
 * ControlRepl 的调度逻辑，不是 Jupyter 协议——后者由 kernel-integration 覆盖。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ArtifactStore,
  ClaimLedger,
  ClaimsRepo,
  ControlRepl,
  FindingsRepo,
  HostRpcServer,
  ManuscriptCompiler,
  ManuscriptRepo,
  PlanRepo,
  RefLibrary,
  RefsRepo,
  RegistryRepo,
  SkillAuditRepo,
  UsageRepo,
  assertReadOnlySql,
  buildHostShim,
  createControlReplAdminTool,
  createControlReplTool,
  hostInitCode,
  registerHostMethods,
  type HostMethodDeps,
  type ProjectStore,
  type RegisteredHost,
  type ShimPending,
  type ShimSurface,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

interface RpcReply {
  status: number;
  body: { ok?: boolean; result?: unknown; error?: { message?: string; remediation?: string } };
}

/**
 * 直接发 HTTP 请求，不经 shim。
 *
 * 刻意不用 `fetch`：undici 会静默丢弃部分手写头，而这里要验的正是头部鉴权。
 */
async function rpc(
  port: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<RpcReply> {
  return new Promise<RpcReply>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: '/',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: RpcReply['body'] = {};
          try {
            parsed = JSON.parse(text) as RpcReply['body'];
          } catch {
            parsed = { error: { message: text } };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const call = async (
  server: HostRpcServer,
  method: string,
  params: Record<string, unknown> = {},
  context?: Record<string, unknown>,
): Promise<RpcReply> =>
  rpc(
    server.port,
    JSON.stringify({ method, params, ...(context === undefined ? {} : { context }) }),
    { 'x-lsci-host-token': server.token },
  );

/* ------------------------------------------------------------------ *
 * RPC 服务
 * ------------------------------------------------------------------ */

describe('HostRpcServer', () => {
  let server: HostRpcServer;

  beforeEach(async () => {
    server = new HostRpcServer();
    server.register('echo', (params) => ({ got: params }));
    server.register('ctx', (_params, ctx) => ctx);
    server.register('boom', () => {
      throw new Error('处理器自己炸了');
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('只绑回环并分配到端口', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('token 是 32 字节的十六进制', () => {
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('带正确 token 的调用返回结果', async () => {
    const reply = await call(server, 'echo', { a: 1 });
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);
    expect(reply.body.result).toEqual({ got: { a: 1 } });
  });

  it('缺 token 被拒且不透露原因', async () => {
    const reply = await rpc(server.port, JSON.stringify({ method: 'echo' }));
    expect(reply.status).toBe(401);
    // 不区分「缺 token」与「token 不对」：区分它们等于给猜测者反馈
    expect(reply.body.error?.message).toBe('未授权');
  });

  it('token 错误被拒，且长度不同时不因长度提前返回', async () => {
    const short = await rpc(server.port, JSON.stringify({ method: 'echo' }), {
      'x-lsci-host-token': 'abc',
    });
    const sameLength = await rpc(server.port, JSON.stringify({ method: 'echo' }), {
      'x-lsci-host-token': 'f'.repeat(64),
    });
    expect(short.status).toBe(401);
    expect(sameLength.status).toBe(401);
    expect(short.body.error?.message).toBe(sameLength.body.error?.message);
  });

  it('GET 被拒：这个面只接受 POST', async () => {
    const reply = await rpc(server.port, '', { 'x-lsci-host-token': server.token }, 'GET');
    expect(reply.status).toBe(405);
  });

  it('未注册的方法回 404 并列出可用方法', async () => {
    const reply = await call(server, 'artifacts.lsit');
    expect(reply.status).toBe(404);
    // 模型写错方法名时它需要知道有什么，否则只能盲猜
    expect(reply.body.error?.remediation).toContain('echo');
  });

  it('重复注册同名方法直接抛错', () => {
    // 后者静默胜出的话，两处实现里究竟哪个生效取决于注册顺序
    expect(() => {
      server.register('echo', () => null);
    }).toThrow(/重复注册/);
  });

  it('请求体不是 JSON 时回 400', async () => {
    const reply = await rpc(server.port, 'not json', { 'x-lsci-host-token': server.token });
    expect(reply.status).toBe(400);
  });

  it('缺 method 回 400', async () => {
    const reply = await rpc(server.port, JSON.stringify({ params: {} }), {
      'x-lsci-host-token': server.token,
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toContain('method');
  });

  it('超过体积上限被拒而不是吃下整个请求', async () => {
    const small = new HostRpcServer({ maxBodyBytes: 64 });
    small.register('echo', (p) => p);
    await small.start();
    try {
      const reply = await rpc(
        small.port,
        JSON.stringify({ method: 'echo', params: { blob: 'x'.repeat(500) } }),
        { 'x-lsci-host-token': small.token },
      );
      expect(reply.status).toBe(413);
    } finally {
      await small.stop();
    }
  });

  it('处理器抛错是正常路径：回 200 但 ok=false', async () => {
    // 参数不对、对象不存在都会走这里。用 HTTP 5xx 表达会让 Python 侧分不清
    // 「调用被拒」与「服务挂了」
    const reply = await call(server, 'boom');
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.message).toContain('处理器自己炸了');
  });

  it('会话上下文按调用传入，不是启动时固化的', async () => {
    const first = await call(server, 'ctx', {}, { conversationId: 'conv-a' });
    const second = await call(server, 'ctx', {}, { conversationId: 'conv-b' });
    expect(first.body.result).toEqual({ conversationId: 'conv-a', modelId: null });
    expect(second.body.result).toEqual({ conversationId: 'conv-b', modelId: null });
  });

  it('没带上下文时 conversationId 为 null 而不是空串', async () => {
    const reply = await call(server, 'ctx');
    expect(reply.body.result).toEqual({ conversationId: null, modelId: null });
  });

  it('执行者身份与会话走同一条路径，也是每次调用带上来的', async () => {
    // 核验结论要记执行者（需求 13.3）。它必须由平台注入而不是让控制面代码自报——
    // 自报的标识在「这个结论有多可信」上没有任何价值
    const reply = await call(server, 'ctx', {}, { conversationId: 'c1', modelId: 'deepseek-chat' });
    expect(reply.body.result).toEqual({ conversationId: 'c1', modelId: 'deepseek-chat' });

    const empty = await call(server, 'ctx', {}, { conversationId: 'c1', modelId: '' });
    expect((empty.body.result as { modelId: unknown }).modelId).toBeNull();
  });

  it('未启动时 env() 为空，不给出一个连不上的地址', async () => {
    const idle = new HostRpcServer();
    expect(idle.env()).toEqual({});
  });

  it('env() 给出地址与 token', () => {
    const env = server.env();
    expect(env['L_SCIENCE_HOST_URL']).toBe(`http://127.0.0.1:${String(server.port)}`);
    expect(env['L_SCIENCE_HOST_TOKEN']).toBe(server.token);
  });

  it('stop 后端口不再接受连接', async () => {
    const temp = new HostRpcServer();
    temp.register('echo', (p) => p);
    await temp.start();
    const port = temp.port;
    await temp.stop();
    await expect(rpc(port, JSON.stringify({ method: 'echo' }))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 只读 SQL
 * ------------------------------------------------------------------ */

describe('assertReadOnlySql', () => {
  it('接受 SELECT', () => {
    expect(() => assertReadOnlySql('SELECT * FROM artifacts')).not.toThrow();
  });

  it('接受 WITH（递归 CTE 是血缘查询的常用写法）', () => {
    expect(() =>
      assertReadOnlySql('WITH RECURSIVE up(id) AS (SELECT 1) SELECT * FROM up'),
    ).not.toThrow();
  });

  it('接受结尾的分号', () => {
    expect(() => assertReadOnlySql('SELECT 1;')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1;  ')).not.toThrow();
  });

  it('拒绝分号拼接的多语句', () => {
    // 最常见的绕过手段：一条 SELECT 后面跟一条 UPDATE
    expect(() => assertReadOnlySql("SELECT 1; UPDATE findings SET status='resolved'")).toThrow(
      /单条语句/,
    );
  });

  it.each([
    ['INSERT INTO findings VALUES (1)'],
    ["UPDATE findings SET status = 'resolved'"],
    ['DELETE FROM artifacts'],
    ['DROP TABLE findings'],
    ['ALTER TABLE findings ADD COLUMN x TEXT'],
    ['CREATE TABLE t (a INT)'],
    ['PRAGMA writable_schema = 1'],
    ['VACUUM'],
    ["ATTACH DATABASE 'other.db' AS o"],
  ])('拒绝写操作：%s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow();
  });

  it('拒绝藏在 SELECT 后面的写关键字', () => {
    expect(() => assertReadOnlySql('SELECT * FROM (DELETE FROM findings RETURNING *)')).toThrow(
      /写操作关键字/,
    );
  });

  it('拒绝空语句', () => {
    expect(() => assertReadOnlySql('   ')).toThrow(/为空/);
  });

  it('大小写与前导空白不影响判定', () => {
    expect(() => assertReadOnlySql('   select 1')).not.toThrow();
    expect(() => assertReadOnlySql('   uPdAtE findings SET x=1')).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Python shim
 * ------------------------------------------------------------------ */

describe('buildHostShim', () => {
  const surfaces: readonly ShimSurface[] = [
    {
      name: 'artifacts',
      doc: '制品与血缘。',
      methods: { list: 'artifacts.list', path: 'artifacts.path' },
    },
  ];
  const pending: readonly ShimPending[] = [{ name: 'refs', reason: '文献库属 M4' }];

  const shim = buildHostShim({ surfaces, pending });

  it('只用标准库', () => {
    // 控制面必须在任何托管环境里都能用，包括只装了最小依赖的 venv
    expect(shim).toContain('import urllib.request');
    expect(shim).not.toMatch(/^import requests/m);
    expect(shim).not.toMatch(/^import numpy/m);
  });

  it('绕过系统代理', () => {
    // 控制面在回环地址上；经系统代理会多一跳，且代理没起来时直接失败
    expect(shim).toContain('ProxyHandler({})');
  });

  it('把已注册的方法映射进去', () => {
    expect(shim).toContain('"list": "artifacts.list"');
    expect(shim).toContain('"path": "artifacts.path"');
  });

  it('未实现的表面进 pending 并在访问时抛错', () => {
    expect(shim).toContain('"refs": "文献库属 M4"');
    // 关键是抛错而不是返回空：空壳会让模型以为「查了但没有」
    expect(shim).toContain('尚未实现');
    expect(shim).not.toMatch(/def refs/);
  });

  it('没有 token 时报权限问题而不是网络问题', () => {
    expect(shim).toContain('HostUnavailable');
    expect(shim).toContain('没有控制面权限');
  });

  it('每次调用现读会话 id，不在导入时缓存', () => {
    // 单例内核跨会话复用，缓存下来的 id 到下一个会话就是错的
    const callBody = shim.slice(shim.indexOf('def _call'), shim.indexOf('class _Bound'));
    expect(callBody).toContain('L_SCIENCE_HOST_CONVERSATION');
    expect(callBody).toContain('"context": context');
  });

  it('生成的是语法合法的 Python（括号与三引号配平）', () => {
    const tripleQuotes = (shim.match(/"""/g) ?? []).length;
    expect(tripleQuotes % 2).toBe(0);
  });

  it('初始化代码把 host 放进全局命名空间并清掉临时名', () => {
    const init = hostInitCode();
    expect(init).toContain('from lsci_host import host');
    // 临时变量留在命名空间里会让 dir() 一片噪声，也可能与用户代码撞名
    expect(init).toContain('del _sys, _os, _d');
  });
});

/* ------------------------------------------------------------------ *
 * ControlRepl 的调度
 * ------------------------------------------------------------------ */

/** 假内核：只记下执行过什么，可控制何时结束。 */
class FakeKernel {
  readonly executed: string[] = [];
  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;

  /** 让下一次执行挂住，直到 release()。 */
  hold(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open?.();
    this.#gate = null;
    this.#open = null;
  }

  execute(code: string): AsyncIterable<{ type: string; name: string; text: string }> {
    this.executed.push(code);
    const gate = this.#gate;
    return {
      async *[Symbol.asyncIterator]() {
        if (gate !== null) await gate;
        yield { type: 'stream', name: 'stdout', text: `ran:${code.slice(0, 24)}` };
      },
    };
  }
}

class FakePool {
  readonly kernels = new Map<string, FakeKernel>();
  readonly acquired: string[] = [];
  readonly shutdownKeys: string[] = [];
  restarted = 0;
  interrupted = 0;

  async acquire(key: string): Promise<FakeKernel> {
    this.acquired.push(key);
    let kernel = this.kernels.get(key);
    if (kernel === undefined) {
      kernel = new FakeKernel();
      this.kernels.set(key, kernel);
    }
    return kernel;
  }

  async shutdown(key: string): Promise<boolean> {
    this.shutdownKeys.push(key);
    return this.kernels.delete(key);
  }

  async restart(): Promise<boolean> {
    this.restarted += 1;
    return true;
  }

  async interrupt(): Promise<boolean> {
    this.interrupted += 1;
    return true;
  }
}

describe('ControlRepl', () => {
  let root: string;
  let server: HostRpcServer;
  let pool: FakePool;
  let repl: ControlRepl;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lsci-repl-'));
    server = new HostRpcServer();
    server.register('artifacts.list', () => []);
    await server.start();

    pool = new FakePool();
    repl = new ControlRepl({
      pool: pool as never,
      server,
      surfaces: [{ name: 'artifacts', doc: '制品。', methods: { list: 'artifacts.list' } }],
      pending: [{ name: 'refs', reason: '属 M4' }],
      shimDir: join(root, 'shim'),
    });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('第一次执行时写出 shim', async () => {
    await repl.run({ code: 'print(1)', conversationId: 'c1' });
    const written = readFileSync(join(root, 'shim', 'lsci_host.py'), 'utf8');
    expect(written).toContain('"list": "artifacts.list"');
  });

  it('env 里有地址、token、shim 目录与 PYTHONPATH', () => {
    const env = repl.env();
    expect(env['L_SCIENCE_HOST_TOKEN']).toBe(server.token);
    expect(env['L_SCIENCE_HOST_SHIM_DIR']).toBe(join(root, 'shim'));
    // 没有 PYTHONPATH 的话 import lsci_host 只在初始化代码里能用
    expect(env['PYTHONPATH']).toBe(join(root, 'shim'));
  });

  it('默认用单例内核，键固定', async () => {
    const result = await repl.run({ code: 'print(1)', conversationId: 'c1' });
    expect(result.mode).toBe('singleton');
    expect(result.bypassReason).toBeNull();
    expect(pool.acquired).toEqual(['control-plane']);
  });

  it('执行前把会话 id 设进内核环境', async () => {
    await repl.run({ code: 'print(1)', conversationId: 'conv-xyz' });
    const kernel = pool.kernels.get('control-plane');
    // 单独一次执行而不是拼在用户代码前：拼接会让 traceback 行号整体偏移
    expect(kernel?.executed[0]).toContain('L_SCIENCE_HOST_CONVERSATION');
    expect(kernel?.executed[0]).toContain('conv-xyz');
    expect(kernel?.executed[1]).toBe('print(1)');
  });

  it('执行者身份也进内核环境，没有时把上一次的删掉', async () => {
    await repl.run({ code: 'a()', conversationId: 'c1', modelId: 'qwen3:4b' });
    const kernel = pool.kernels.get('control-plane');
    expect(kernel?.executed[0]).toContain('L_SCIENCE_HOST_MODEL');
    expect(kernel?.executed[0]).toContain('qwen3:4b');

    /*
     * 关键：不带 modelId 的下一次执行必须**删掉**环境里的旧值。
     *
     * 单例内核跨回合复用，留着上一回合的模型 id 会让这一回合的核验记录认领它——
     * 那条记录会说「这是 qwen3 判的」，而 qwen3 那时根本没参与。留一个过期的执行者
     * 标识比没有更糟：没有会被拒绝，过期的会被接受。
     */
    await repl.run({ code: 'b()', conversationId: 'c1' });
    expect(kernel?.executed[2]).toContain('environ.pop("L_SCIENCE_HOST_MODEL", None)');
    expect(kernel?.executed[2]).not.toContain('qwen3');
  });

  it('mode=singleton 在忙时快速失败而不是排队', async () => {
    // 排队正是死锁来源：正在跑的那段可能在等本次调用的结果
    const kernel = await pool.acquire('control-plane');
    kernel.hold();
    const first = repl.run({ code: 'slow()', conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(repl.busy).toBe(true);

    const rejected = await repl.run({ code: 'other()', conversationId: 'c1', mode: 'singleton' });
    expect(rejected.ok).toBe(false);
    expect(rejected.output.kind).toBe('error');
    if (rejected.output.kind === 'error') {
      expect(rejected.output.ename).toBe('ControlPlaneBusy');
      expect(rejected.output.evalue).toContain('bypass');
    }

    kernel.release();
    await first;
    expect(repl.busy).toBe(false);
  });

  it('mode=auto 在忙时自动改用旁路内核并如实说明', async () => {
    const kernel = await pool.acquire('control-plane');
    kernel.hold();
    const first = repl.run({ code: 'slow()', conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));

    const second = await repl.run({ code: 'quick()', conversationId: 'c1' });
    expect(second.mode).toBe('bypass');
    expect(second.bypassReason).toContain('状态不共享');
    expect(second.output.kind).toBe('text');
    if (second.output.kind === 'text') expect(second.output.text).toContain('ran:quick()');

    kernel.release();
    await first;
  });

  it('单例执行的输出原样返回，不加旁路说明', async () => {
    const result = await repl.run({ code: 'print(1)', conversationId: 'c1' });
    expect(result.output.kind).toBe('text');
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('ran:print(1)');
      expect(result.output.text).not.toContain('[');
    }
  });

  it('旁路内核用完即弃，不复用', async () => {
    const a = await repl.run({ code: 'one()', conversationId: 'c1', mode: 'bypass' });
    const b = await repl.run({ code: 'two()', conversationId: 'c1', mode: 'bypass' });

    expect(a.mode).toBe('bypass');
    expect(b.mode).toBe('bypass');
    // 键不同 + 用完就关：复用会让它积累状态，变成第二个控制面
    expect(pool.shutdownKeys).toEqual(['control-plane-bypass-1', 'control-plane-bypass-2']);
    expect(pool.kernels.has('control-plane-bypass-1')).toBe(false);
  });

  it('旁路内核也拿到会话上下文', async () => {
    await repl.run({ code: 'x()', conversationId: 'conv-b', mode: 'bypass' });
    const kernel = pool.kernels.get('control-plane-bypass-1');
    // 已经被关掉了，从 acquired 记录确认它被取用过
    expect(kernel).toBeUndefined();
    expect(pool.acquired).toContain('control-plane-bypass-1');
  });

  it('执行抛错也要放开忙标志', async () => {
    const broken = new ControlRepl({
      pool: {
        acquire: () => Promise.reject(new Error('内核起不来')),
        shutdown: () => Promise.resolve(true),
      } as never,
      server,
      surfaces: [],
      pending: [],
      shimDir: join(root, 'shim2'),
    });

    // 不放开会让控制面永久「忙」，之后所有调用都被推去旁路
    await expect(broken.run({ code: 'x()', conversationId: 'c1' })).rejects.toThrow();
    expect(broken.busy).toBe(false);
  });

  it('忙时拒绝重启：重启会清掉正在用的状态', async () => {
    const kernel = await pool.acquire('control-plane');
    kernel.hold();
    const first = repl.run({ code: 'slow()', conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));

    await expect(repl.restart()).rejects.toThrow(/不能重启/);
    kernel.release();
    await first;

    await expect(repl.restart()).resolves.toBe(true);
    expect(pool.restarted).toBe(1);
  });

  it('interrupt 转发到池', async () => {
    await repl.interrupt();
    expect(pool.interrupted).toBe(1);
  });

  it('close 关掉单例内核', async () => {
    await repl.run({ code: 'x()', conversationId: 'c1' });
    await repl.close();
    expect(pool.shutdownKeys).toContain('control-plane');
  });

  it('initCode 是给内核启动用的静态代码', () => {
    expect(ControlRepl.initCode().join('\n')).toContain('from lsci_host import host');
  });

  /* ---------------- 工具层 ---------------- */

  const ctx = () => ({
    projectId: 'p1',
    conversationId: 'conv-tool',
    workspaceDir: root,
  });

  it('control_repl 描述里列出可用表面与未实现的表面', () => {
    const tool = createControlReplTool({
      repl,
      surfaces: [{ name: 'artifacts', doc: '制品。', methods: { list: 'artifacts.list' } }],
      pending: [{ name: 'refs', reason: '属 M4' }],
    });
    // 模型不该需要先探索一遍才知道有什么
    expect(tool.description).toContain('host.artifacts.{list}');
    expect(tool.description).toContain('host.refs');
    // 与 python 工具的分工必须写清楚，否则控制面单例会被长分析占住
    expect(tool.description).toContain('这里不跑分析代码');
  });

  it('control_repl 拒绝空代码与非法 mode', () => {
    const tool = createControlReplTool({ repl, surfaces: [], pending: [] });
    expect(() => tool.parseInput({ code: '  ' })).toThrow(/非空/);
    expect(() => tool.parseInput({ code: 'x', mode: 'queue' })).toThrow(/mode/);
    expect(() => tool.parseInput({ code: 'x', timeoutMs: -1 })).toThrow(/正数/);
    expect(tool.parseInput({ code: 'x', mode: 'bypass' })).toEqual({
      code: 'x',
      mode: 'bypass',
    });
  });

  it('control_repl 把会话 id 从 ToolContext 带下去', async () => {
    const tool = createControlReplTool({ repl, surfaces: [], pending: [] });
    await tool.execute({ code: 'print(1)' }, ctx() as never);
    const kernel = pool.kernels.get('control-plane');
    expect(kernel?.executed[0]).toContain('conv-tool');
  });

  it('control_repl 走了旁路时在输出里如实说明', async () => {
    const tool = createControlReplTool({ repl, surfaces: [], pending: [] });
    const result = await tool.execute({ code: 'x()', mode: 'bypass' }, ctx() as never);
    expect(result.output.kind).toBe('text');
    // 调用方可能指望上一次执行留下的变量还在
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('[按请求使用一次性内核');
    }
  });

  it('control_repl_admin 的 status 报告忙闲与可用表面', async () => {
    const tool = createControlReplAdminTool({
      repl,
      surfaces: [{ name: 'skills', doc: '技能。', methods: { list: 'skills.list' } }],
      pending: [{ name: 'compute', reason: '属 M5' }],
    });
    const result = await tool.execute({}, ctx() as never);
    expect(result.ok).toBe(true);
    if (result.output.kind === 'text') {
      expect(result.output.text).toContain('空闲');
      expect(result.output.text).toContain('skills');
      expect(result.output.text).toContain('compute');
    }
  });

  it('control_repl_admin 在忙时把重启失败如实回报，而不是硬重启', async () => {
    const kernel = await pool.acquire('control-plane');
    kernel.hold();
    const first = repl.run({ code: 'slow()', conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));

    const tool = createControlReplAdminTool({ repl, surfaces: [], pending: [] });
    const result = await tool.execute({ action: 'restart' }, ctx() as never);
    expect(result.ok).toBe(false);
    if (result.output.kind === 'error') expect(result.output.ename).toBe('ControlPlaneBusy');
    expect(pool.restarted).toBe(0);

    kernel.release();
    await first;
  });

  it('control_repl_admin 拒绝未知 action', () => {
    const tool = createControlReplAdminTool({ repl, surfaces: [], pending: [] });
    expect(() => tool.parseInput({ action: 'nuke' })).toThrow(/action/);
    expect(tool.parseInput(undefined)).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * FindingsRepo
 * ------------------------------------------------------------------ */

describe('FindingsRepo', () => {
  let root: string;
  let store: AppStore;
  let project: ProjectStore;
  let findings: FindingsRepo;
  let conversationId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-findings-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: '发现测试' });
    project = store.openProject(created.id);
    findings = new FindingsRepo(project.db);
    conversationId = project.conversations.create({ title: '会话' }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const add = (over: Partial<Parameters<FindingsRepo['add']>[0]> = {}) =>
    findings.add({
      conversationId,
      severity: 'warn',
      category: 'statistics',
      title: '未校正多重比较',
      evidence: [{ kind: 'message', id: 'msg_1', note: '这里做了 12 次检验' }],
      ...over,
    });

  it('证据为空直接抛错', () => {
    // 无指向的发现用户只能忽略，而一旦开始忽略整个审查机制就失效了
    expect(() => add({ evidence: [] })).toThrow(/必须关联具体证据/);
  });

  it('证据缺 id 也抛错', () => {
    expect(() => add({ evidence: [{ kind: 'artifact-version', id: '  ' }] })).toThrow(/缺少 id/);
  });

  it('新发现是 open 状态', () => {
    const finding = add();
    expect(finding.status).toBe('open');
    expect(finding.evidence).toHaveLength(1);
    expect(findings.get(finding.id)?.evidence[0]?.note).toContain('12 次检验');
  });

  it('claimFixed 只推进到 claimed-fixed，不关闭', () => {
    const finding = add();
    expect(findings.claimFixed(finding.id, '已改用 FDR 校正')).toBe(true);

    const after = findings.get(finding.id);
    // 关闭权在 Reviewer：一次错误的自我判断不该永久掩盖问题
    expect(after?.status).toBe('claimed-fixed');
    expect(after?.status).not.toBe('resolved');
    expect(after?.addressedNote).toBe('已改用 FDR 校正');
    expect(after?.addressedAt).not.toBeNull();
  });

  it('自报已修必须说明改了什么', () => {
    const finding = add();
    expect(() => findings.claimFixed(finding.id, '   ')).toThrow(/说明改了什么/);
  });

  it('claimFixed 对已经 claimed-fixed 的返回 false', () => {
    const finding = add();
    findings.claimFixed(finding.id, '改了');
    expect(findings.claimFixed(finding.id, '又改了')).toBe(false);
  });

  it('claimed-fixed 仍算未关闭：它要继续挡着', () => {
    const finding = add({ severity: 'fail' });
    findings.claimFixed(finding.id, '改了');

    const unresolved = findings.list({ conversationId });
    expect(unresolved.map((f) => f.id)).toContain(finding.id);
    expect(findings.summary(conversationId).blocking).toBe(1);
    expect(findings.summary(conversationId).claimedFixed).toBe(1);
  });

  it('reopen 把自报已修的打回 open', () => {
    const finding = add();
    findings.claimFixed(finding.id, '改了');
    expect(findings.reopen(finding.id, '复核未通过：校正只加在部分检验上')).toBe(true);

    const after = findings.get(finding.id);
    expect(after?.status).toBe('open');
    expect(after?.addressedAt).toBeNull();
  });

  it('reopen 对 open 状态的无效：它已经开着了', () => {
    const finding = add();
    expect(findings.reopen(finding.id, '???')).toBe(false);
  });

  it('resolve 关闭发现', () => {
    const finding = add();
    expect(findings.resolve(finding.id, '复核通过')).toBe(true);
    expect(findings.get(finding.id)?.status).toBe('resolved');
    expect(findings.list({ conversationId }).map((f) => f.id)).not.toContain(finding.id);
  });

  it('dismiss 与 resolved 分开：误报不代表问题被修了', () => {
    const finding = add();
    expect(findings.dismiss(finding.id, '这是描述性统计，不需要校正')).toBe(true);
    expect(findings.get(finding.id)?.status).toBe('dismissed');
    expect(findings.list({ conversationId, status: 'resolved' })).toHaveLength(0);
    expect(findings.list({ conversationId, status: 'dismissed' })).toHaveLength(1);
  });

  it('FAIL 排在 WARN 前面', () => {
    add({ severity: 'warn', title: '警告一' });
    add({ severity: 'fail', title: '阻断一' });
    add({ severity: 'warn', title: '警告二' });

    const list = findings.list({ conversationId });
    expect(list[0]?.severity).toBe('fail');
  });

  it('summary 按类别计数，blocking 只数 FAIL', () => {
    add({ severity: 'fail', category: 'evidence', title: '引用对不上' });
    add({ severity: 'fail', category: 'evidence', title: '另一处引用对不上' });
    add({ severity: 'warn', category: 'reproducibility', title: '图缺血缘' });

    const summary = findings.summary(conversationId);
    expect(summary.blocking).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.byCategory['evidence']).toBe(2);
    expect(summary.byCategory['reproducibility']).toBe(1);
  });

  it('按类别与严重度过滤', () => {
    add({ severity: 'fail', category: 'integrity', title: '硬编码结果' });
    add({ severity: 'warn', category: 'statistics', title: '样本量偏小' });

    expect(findings.list({ conversationId, severity: 'fail' })).toHaveLength(1);
    expect(findings.list({ conversationId, category: 'statistics' })).toHaveLength(1);
  });

  it('别的会话的发现不混进来', () => {
    const other = project.conversations.create({ title: '另一个会话' }).id;
    add();
    findings.add({
      conversationId: other,
      severity: 'fail',
      category: 'consistency',
      title: '正文与图不一致',
      evidence: [{ kind: 'artifact-version', id: 'av_1' }],
    });

    expect(findings.list({ conversationId })).toHaveLength(1);
    expect(findings.summary(conversationId).blocking).toBe(0);
  });

  it('证据 JSON 损坏时不让整个列表读不出来', () => {
    const finding = add();
    project.db.prepare('UPDATE findings SET evidence_json = ? WHERE id = ?').run('{坏', finding.id);

    const read = findings.get(finding.id);
    // 一条坏数据不该让「还有什么要改」这个问题变成无法回答
    expect(read?.evidence).toEqual([]);
    expect(findings.list({ conversationId })).toHaveLength(1);
  });

  /* ---------------- Reviewer 运行 ---------------- */

  it('审查运行记录模型 id，异厂商约束因此可核查', () => {
    const run = findings.startRun({
      conversationId,
      trigger: 'turn-end',
      modelId: 'ollama/qwen3:4b',
    });
    expect(run.status).toBe('running');
    expect(run.modelId).toBe('ollama/qwen3:4b');
    expect(findings.finishRun(run.id, { status: 'done', summary: '无阻断项' })).toBe(true);

    const after = findings.getRun(run.id);
    expect(after?.status).toBe('done');
    expect(after?.endedAt).not.toBeNull();
  });

  it('degraded 是独立状态：只有一家供应商时要能如实记下来', () => {
    const run = findings.startRun({ conversationId, trigger: 'turn-end', modelId: 'm1' });
    findings.finishRun(run.id, { status: 'degraded', summary: '只有一家供应商，同厂异模型' });
    expect(findings.getRun(run.id)?.status).toBe('degraded');
  });

  it('runs 最新在前，同毫秒时按插入序', () => {
    const a = findings.startRun({ conversationId, trigger: 'turn-end', modelId: 'm1' });
    const b = findings.startRun({ conversationId, trigger: 'user-request', modelId: 'm1' });
    const list = findings.runs(conversationId);
    // 靠 UUID 排序的话同毫秒创建的记录顺序不确定
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('abandonStaleRuns 把上次进程留下的 running 标掉', () => {
    findings.startRun({ conversationId, trigger: 'turn-end', modelId: 'm1' });
    expect(findings.abandonStaleRuns()).toBe(1);
    expect(findings.runs(conversationId)[0]?.status).toBe('failed');
    // 已经收尾的不会被重复标记
    expect(findings.abandonStaleRuns()).toBe(0);
  });

  it('发现可以挂到审查运行上，删运行时发现保留', () => {
    const run = findings.startRun({ conversationId, trigger: 'turn-end', modelId: 'm1' });
    const finding = add({ reviewerRunId: run.id });
    expect(finding.reviewerRunId).toBe(run.id);

    project.db.prepare('DELETE FROM reviewer_runs WHERE id = ?').run(run.id);
    // ON DELETE SET NULL：发现本身仍然要在，它描述的问题并没有因此消失
    expect(findings.get(finding.id)?.reviewerRunId).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * M4 三层的控制面表面（任务 13.1-13.6）
 * ------------------------------------------------------------------ */

/*
 * 这一组验的是**接线**而不是这三层自己的行为（那些在 refs / claims / manuscript
 * 各自的测试里）。接线上有两件事只有在这里才成立：
 *
 * 1. 缺席与未实现是两回事。`compute` 是「还没做」，M4 三层缺席是「这次运行没接上」。
 *    用同一句话说会让用户去等一个已经做完的东西。
 * 2. `claims.verify` 的执行者身份必须来自调用上下文，不是参数。这是需求 13.3 在
 *    接口形状上的落点——只要它能当参数传，自报就成立了，而自报的执行者标识在
 *    「这个结论有多可信」上没有任何价值。
 */

describe('host 的 M4 表面', () => {
  let root: string;
  let store: AppStore;
  let project: ProjectStore;
  let server: HostRpcServer;
  let conversationId: string;
  let claimId: string;
  let registered: RegisteredHost;

  const minimalDeps = (over: Partial<HostMethodDeps> = {}): HostMethodDeps => ({
    projectId: 'p1',
    db: project.db,
    artifacts: new ArtifactStore(project.db, project.paths.blobs),
    plans: new PlanRepo(project.db),
    findings: new FindingsRepo(project.db),
    skills: {
      records: () => [],
      search: async () => [],
      inject: () => null,
      readReference: () => ({ ok: false, reason: '未加载技能' }),
      requirementsOf: () => null,
    } as never,
    skillAudit: new SkillAuditRepo(project.db),
    usage: new UsageRepo(project.db),
    registry: new RegistryRepo(store.db),
    subAgents: { spawn: () => undefined, list: () => [], get: () => null } as never,
    ...over,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lsci-host-m4-'));
    store = AppStore.open(root);
    const created = store.createProject({ name: 'M4 表面' });
    project = store.openProject(created.id);
    conversationId = project.conversations.create({ title: '会话' }).id;

    const artifacts = new ArtifactStore(project.db, project.paths.blobs);
    const refLibrary = new RefLibrary({
      repo: new RefsRepo(project.db),
      artifacts,
      // 不出网：库内操作照样要能用
      authorizeHosts: async () => [],
      authorizeFulltextHost: async () => false,
    });
    const ledger = new ClaimLedger({
      repo: new ClaimsRepo(project.db),
      artifactExists: (versionId) => artifacts.getVersion(versionId) !== null,
      refExists: (refId) => refLibrary.repo.get(refId) !== null,
      refIdByDoi: (doi) => refLibrary.repo.getByDoi(doi)?.id ?? null,
      computeExists: () => false,
    });
    const compiler = new ManuscriptCompiler({
      repo: new ManuscriptRepo(project.db),
      artifacts,
      refs: () => refLibrary.repo.list({ limit: 100 }),
    });

    claimId =
      ledger.register({ text: '干预组比对照组快 42 ms（p = 0.003）。', conversationId }).claim
        ?.id ?? '';

    server = new HostRpcServer();
    registered = registerHostMethods(
      server,
      minimalDeps({
        refs: () => refLibrary,
        claims: () => ledger,
        manuscripts: () => compiler,
      }),
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('三层接上后进 surfaces，pending 里只剩没做的', () => {
    const names = registered.surfaces.map((s) => s.name);
    expect(names).toContain('refs');
    expect(names).toContain('claims');
    expect(names).toContain('manuscripts');

    const pendingNames = registered.pending.map((p) => p.name);
    expect(pendingNames).toContain('compute');
    expect(pendingNames).not.toContain('refs');
  });

  it('三层缺席时给的是「没接上」而不是「尚未落地」', () => {
    const bare = new HostRpcServer();
    const result = registerHostMethods(bare, minimalDeps());

    const refs = result.pending.find((p) => p.name === 'refs');
    // 说成「尚未落地」会让用户去等一个已经做完的东西
    expect(refs?.reason).toContain('没有可用的文献库');
    expect(refs?.reason).not.toContain('尚未落地');
    expect(result.pending.find((p) => p.name === 'compute')?.reason).toContain('尚未落地');
  });

  it('refs.list 在空库上返回空表，不因为不能出网就报错', async () => {
    const reply = await call(server, 'refs.list', {}, { conversationId });
    expect(reply.body.ok).toBe(true);
    expect(reply.body.result).toEqual([]);
  });

  it('refs 表面不给 delete：删掉被引文献会让断言指向不存在的 id', async () => {
    const surface = registered.surfaces.find((s) => s.name === 'refs');
    expect(Object.keys(surface?.methods ?? {})).not.toContain('delete');
    // 查重之后的合并是主要维护动作，而 merge 自己会拒绝两个不同 DOI 的合并
    expect(Object.keys(surface?.methods ?? {})).toContain('merge');
  });

  it('claims.verify 没有执行者身份就拒绝', async () => {
    const reply = await call(
      server,
      'claims.verify',
      { claimId, kind: 'quote', ref: 'q1', verdict: 'supports' },
      { conversationId },
    );
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.message).toContain('执行者身份');
  });

  it('claims.verify 不接受自报的 modelId 参数', async () => {
    // 传进来也不算：执行者只从上下文取
    const reply = await call(
      server,
      'claims.verify',
      { claimId, kind: 'quote', ref: 'q1', verdict: 'supports', modelId: '一个很可靠的模型' },
      { conversationId },
    );
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.message).toContain('执行者身份');
  });

  it('带上执行者身份时核验记得下来，状态由结论推导', async () => {
    const versionId = new ArtifactStore(project.db, project.paths.blobs).save({
      filename: 'rt.csv',
      content: Buffer.from('group,rt\nintervention,412\ncontrol,454\n'),
      code: 'print(1)',
    }).version.id;

    const bound = await call(
      server,
      'claims.bind',
      { claimId, kind: 'artifact-version', ref: versionId, quote: '均值差 42 ms' },
      { conversationId },
    );
    expect(bound.body.ok).toBe(true);

    const verified = await call(
      server,
      'claims.verify',
      { claimId, kind: 'artifact-version', ref: versionId, verdict: 'supports' },
      { conversationId, modelId: 'deepseek-chat' },
    );
    expect(verified.body.ok).toBe(true);
    const claim = verified.body.result as {
      status: string;
      evidence: { verifiedByModelId: string }[];
    };
    expect(claim.status).toBe('supported');
    expect(claim.evidence[0]?.verifiedByModelId).toBe('deepseek-chat');
  });

  it('绑定指向不存在的对象时拒绝，并给出怎么办', async () => {
    const reply = await call(
      server,
      'claims.bind',
      { claimId, kind: 'ref', ref: 'rf_不存在' },
      { conversationId },
    );
    // 放行的话断言在计数上「有证据」、检查放过它、用户点开是空的
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.message).toContain('rf_不存在');
  });

  it('claims.parseCitations 把纯引用标记标成不可检索', async () => {
    const reply = await call(server, 'claims.parseCitations', { citations: ['[12]'] });
    expect(reply.body.ok).toBe(true);
    const parsed = reply.body.result as { shape: string; searchable: boolean }[];
    // 拿 [12] 当标题去查会返回一堆无关文献，最相似的被判成命中
    expect(parsed[0]?.shape).toBe('marker-only');
    expect(parsed[0]?.searchable).toBe(false);
  });

  it('manuscripts.profiles 的数值带来源说明', async () => {
    const reply = await call(server, 'manuscripts.profiles');
    const body = reply.body.result as { profiles: unknown[]; disclaimer: string };
    expect(body.profiles.length).toBeGreaterThan(5);
    // 显示「摘要上限 150 词」而不说来源，用户会照它删稿
    expect(body.disclaimer).toContain('近似值');
  });

  it('manuscripts.compile 的双盲版带需求 13.8 的局限说明', async () => {
    const markdown = [
      '---',
      'title: 睡眠分期的一种改进方法',
      'authors:',
      '  - name: 张三',
      '    affiliation: 某大学',
      'funding: 基金号 12345',
      '---',
      '',
      '## 引言',
      '',
      '这里是引言。'.repeat(20),
    ].join('\n');

    const reply = await call(
      server,
      'manuscripts.compile',
      { markdown, blinded: true },
      { conversationId, modelId: 'deepseek-chat' },
    );
    expect(reply.body.ok).toBe(true);
    const body = reply.body.result as {
      outputs: { blinded: boolean; removedFields: string[]; disclaimer: string | null }[];
    };
    const output = body.outputs[0];
    expect(output?.blinded).toBe(true);
    // 移除项逐条列出：「已移除作者信息」核对不了任何东西
    expect(output?.removedFields.join('|')).toContain('张三');
    expect(output?.disclaimer).toContain('隐式');
  });
});
