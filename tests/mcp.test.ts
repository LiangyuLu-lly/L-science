/**
 * MCP 连接器测试（任务 12.13、12.14，需求 14.1、14.2、17）。
 *
 * 四块重点：
 *
 * 1. **需求 14.2 的硬约束**：MCP 表面只在控制面暴露，不能有任何 `mcp_*` 工具进
 *    ToolRegistry。这一条用结构断言来守——它最容易在「加个工具方便点」的动机下被违反。
 * 2. **stdio 传输不能把父进程环境泄漏给第三方进程**。后端进程里有控制面 token 与
 *    供应商 key，一个连接器拿到它们就等于绕过全部管控。
 * 3. **授权门**：只读放行、非只读要审批、拒绝后返回 denied 而不是抛错、once 不落库。
 * 4. **两级开关**：连接器自己 + 所属组，任一关闭就不可用。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalRepo,
  ApprovalService,
  AppStore,
  BRIDGE_SPECS,
  BUILTIN_CONNECTORS,
  BUILTIN_CONNECTOR_GROUPS,
  ConnectorRepo,
  DEFAULT_CALL_TIMEOUT_MS,
  McpBridgeServer,
  McpClient,
  McpManager,
  buildRequest,
  bridgeIds,
  connectorFingerprint,
  contentToText,
  pickPath,
  syncBuiltinConnectors,
  toMcpTool,
  type BridgeSpec,
  type McpTransport,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let repo: ConnectorRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-mcp-'));
  store = AppStore.open(join(root, 'app'));
  repo = new ConnectorRepo(store.db);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 需求 14.2：只在控制面暴露
 * ------------------------------------------------------------------ */

describe('需求 14.2：MCP 只在控制面暴露', () => {
  it('core 的导出里没有任何 mcp 工具构造函数', async () => {
    const core = (await import('@l-science/core')) as Record<string, unknown>;
    const toolFactories = Object.keys(core).filter(
      (k) => k.startsWith('create') && k.endsWith('Tool'),
    );
    // 注册一个 mcp_* 工具进 ToolRegistry 就等于把 MCP 通道给了普通 python 内核
    const mcpTools = toolFactories.filter((k) => /mcp/i.test(k));
    expect(mcpTools).toEqual([]);
  });

  it('mcp 模块的导出里没有 ToolDefinition 工厂', async () => {
    const mod = (await import('@l-science/core')) as Record<string, unknown>;
    // McpManager 是唯一入口，它被 hostapi 的 mcp 表面引用，而那只在控制面 RPC 上注册
    expect(typeof mod.McpManager).toBe('function');
    expect(mod.createMcpCallTool).toBeUndefined();
    expect(mod.createConnectorTool).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 协议辅助
 * ------------------------------------------------------------------ */

describe('协议辅助', () => {
  it('contentToText 把文本块拼起来', () => {
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('图像不进上下文，只给大小说明', () => {
    // 几百 KB 的 base64 会挤掉真正的内容，而模型读不出图里画了什么
    const text = contentToText([{ type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' }]);
    expect(text).toContain('image/png');
    expect(text).not.toContain('AAAA');
  });

  it('资源块有文本时取文本，没有时给引用', () => {
    expect(contentToText([{ type: 'resource', resource: { uri: 'x://1', text: '内容' } }])).toBe(
      '内容',
    );
    expect(
      contentToText([
        { type: 'resource', resource: { uri: 'x://1', mimeType: 'application/pdf' } },
      ]),
    ).toContain('x://1');
  });

  it('pickPath 按点分路径取值', () => {
    const obj = { a: { b: [1, 2, 3] } };
    expect(pickPath(obj, 'a.b')).toEqual([1, 2, 3]);
    expect(pickPath(obj, 'a.b[]')).toEqual([1, 2, 3]);
    expect(pickPath(obj, 'a.missing')).toBeNull();
    expect(pickPath(obj, undefined)).toBe(obj);
  });
});

/* ------------------------------------------------------------------ *
 * 请求构造
 * ------------------------------------------------------------------ */

describe('buildRequest', () => {
  const bridge: BridgeSpec = {
    id: 'demo',
    baseUrl: 'https://example.org/api/',
    defaultHeaders: { 'user-agent': 'test' },
    endpoints: [],
  };

  it('路径参数被 URL 编码', () => {
    // 基因符号里的 / 或化合物名里的空格不编码会拼出指向别处的 URL，
    // 而服务端会老实地返回那个别处的内容
    const { url } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '/lookup/{id}',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: '' }],
      },
      { id: 'a/b c' },
    );
    expect(url).toBe('https://example.org/api/lookup/a%2Fb%20c');
  });

  it('查询参数与固定查询合并', () => {
    const { url } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '/search',
        fixedQuery: { format: 'json' },
        params: [{ name: 'q', in: 'query', type: 'string', required: true, description: '' }],
      },
      { q: 'brca1' },
    );
    expect(url).toContain('format=json');
    expect(url).toContain('q=brca1');
  });

  it('缺必需参数时抛错', () => {
    expect(() =>
      buildRequest(
        bridge,
        {
          name: 'x',
          description: '',
          path: '/a/{id}',
          params: [{ name: 'id', in: 'path', type: 'string', required: true, description: '' }],
        },
        {},
      ),
    ).toThrow(/缺少必需参数/);
  });

  it('未替换的路径占位被拦下', () => {
    // 拼出字面含 {id} 的 URL 会让服务端返回 404，而那个 404 看起来像「查不到这条记录」
    expect(() => buildRequest(bridge, { name: 'x', description: '', path: '/a/{id}' }, {})).toThrow(
      /未提供/,
    );
  });

  it('enum 校验', () => {
    expect(() =>
      buildRequest(
        bridge,
        {
          name: 'x',
          description: '',
          path: '/a',
          params: [
            {
              name: 'type',
              in: 'query',
              type: 'string',
              description: '',
              enum: ['cds', 'protein'],
            },
          ],
        },
        { type: 'genomic' },
      ),
    ).toThrow(/只能是/);
  });

  it('默认值生效', () => {
    const { url } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '/a',
        params: [
          {
            name: 'species',
            in: 'query',
            type: 'string',
            description: '',
            default: 'homo_sapiens',
          },
        ],
      },
      {},
    );
    expect(url).toContain('species=homo_sapiens');
  });

  it('GraphQL 端点把 query 放进 body，变量只取声明过的参数', () => {
    const { init } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '',
        graphql: 'query Q($id: String!) { a(id: $id) }',
        params: [{ name: 'id', in: 'body', type: 'string', required: true, description: '' }],
      },
      // 未声明的 extra 不该进变量：工具 schema 就是契约，
      // 透传会让调用方把没写在 schema 里的变量塞进查询
      { id: 'X', extra: 'nope' },
    );
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('query Q');
    expect(body.variables.id).toBe('X');
    expect(body.variables.extra).toBeUndefined();
  });

  it('GraphQL 变量会填上声明里的默认值', () => {
    // 这条守的是一个真出现过的 bug：变量原来直接用 args，
    // 于是「必需但有默认值」的变量在模型省略它时会让整个查询失败（gnomAD 的 referenceGenome）
    const { init } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '',
        graphql:
          'query Q($sym: String!, $ref: ReferenceGenomeId!) { gene(s: $sym, r: $ref) { id } }',
        params: [
          { name: 'sym', in: 'body', type: 'string', required: true, description: '' },
          { name: 'ref', in: 'body', type: 'string', description: '', default: 'GRCh38' },
        ],
      },
      { sym: 'BRCA1' },
    );
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> };
    expect(body.variables.ref).toBe('GRCh38');
  });

  it('GraphQL 变量按声明的类型收敛', () => {
    // GraphQL 的 Int! 会拒绝字符串 "5"，而那个报错读起来像查询本身写错了
    const { init } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '',
        graphql: 'query Q($size: Int!) { a(size: $size) }',
        params: [{ name: 'size', in: 'body', type: 'number', required: true, description: '' }],
      },
      { size: '5' },
    );
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> };
    expect(body.variables.size).toBe(5);
  });

  it('声明了 slashes 的路径参数保留斜杠，但拒绝 ..', () => {
    const spec = {
      name: 'x',
      description: '',
      path: '/details/{interval}',
      params: [
        {
          name: 'interval',
          in: 'path' as const,
          type: 'string' as const,
          required: true,
          slashes: true,
          description: '',
        },
      ],
    };
    const { url } = buildRequest(bridge, spec, { interval: '2026-07-20/2026-07-22' });
    expect(url).toContain('/details/2026-07-20/2026-07-22');
    // 允许斜杠不等于允许把请求挪到别的路径上
    expect(() => buildRequest(bridge, spec, { interval: '../../etc' })).toThrow();
  });

  it('默认路径参数里的斜杠仍被编码', () => {
    const { url } = buildRequest(
      bridge,
      {
        name: 'x',
        description: '',
        path: '/x/{name}',
        params: [{ name: 'name', in: 'path', type: 'string', required: true, description: '' }],
      },
      { name: 'a/b' },
    );
    expect(url).toContain('/x/a%2Fb');
  });

  it('端点可以覆盖桥的 baseUrl', () => {
    const { url } = buildRequest(
      bridge,
      { name: 'x', description: '', path: '/y', baseUrl: 'https://other.example' },
      {},
    );
    expect(url).toBe('https://other.example/y');
  });

  it('toMcpTool 把只读声明成注解', () => {
    const tool = toMcpTool({ name: 'q', description: 'd', path: '/x' });
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    // 数据来自外部服务，不是封闭世界
    expect(tool.annotations?.openWorldHint).toBe(true);
  });

  it('toMcpTool 的 required 只含必需参数', () => {
    const tool = toMcpTool({
      name: 'q',
      description: 'd',
      path: '/x',
      params: [
        { name: 'a', in: 'query', type: 'string', required: true, description: '' },
        { name: 'b', in: 'query', type: 'number', description: '' },
      ],
    });
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(['a']);
  });
});

/* ------------------------------------------------------------------ *
 * 桥服务
 * ------------------------------------------------------------------ */

describe('McpBridgeServer', () => {
  let bridge: McpBridgeServer;
  let upstreamCalls: string[];

  const spec: BridgeSpec = {
    id: 'demo',
    baseUrl: 'https://upstream.test',
    endpoints: [
      {
        name: 'get_item',
        description: '取一条记录',
        path: '/items/{id}',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'id' }],
        pick: 'data',
      },
      {
        name: 'list_items',
        description: '列出记录',
        path: '/items',
        pick: 'data',
        limit: 2,
      },
    ],
  };

  beforeEach(async () => {
    upstreamCalls = [];
    bridge = new McpBridgeServer({
      specs: [spec],
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        upstreamCalls.push(url);
        if (url.includes('/items/404')) {
          return new Response('not found', { status: 404 });
        }
        if (url.includes('/items/500')) {
          return new Response('boom', { status: 500 });
        }
        if (url.endsWith('/items')) {
          return Response.json({ data: [1, 2, 3, 4, 5] });
        }
        return Response.json({ data: { id: 'x', name: 'n' } });
      }) as unknown as typeof fetch,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
  });

  const rpc = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${bridge.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };

  it('initialize 返回协议版本与服务端信息', async () => {
    const res = await rpc('/mcp/demo', { jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = res.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.serverInfo.name).toContain('demo');
  });

  it('tools/list 从端点声明生成工具', async () => {
    const res = await rpc('/mcp/demo', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['get_item', 'list_items']);
  });

  it('tools/call 走上游并按 pick 取值', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_item', arguments: { id: 'abc' } },
    });
    const result = res.result as { content: Array<{ text: string }>; structuredContent: unknown };
    expect(upstreamCalls[0]).toBe('https://upstream.test/items/abc');
    expect(result.structuredContent).toEqual({ id: 'x', name: 'n' });
    expect(result.content[0]?.text).toContain('"id": "x"');
  });

  it('数组超过 limit 时截断并说明总数', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_items', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain('共 5 条');
    expect(result.content[0]?.text).toContain('前 2 条');
  });

  it('404 被解释为「查不到」而不是裸状态码', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_item', arguments: { id: '404' } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    // 404 是「查不到」，429 是「太频繁」，两者的应对完全不同
    expect(result.content[0]?.text).toContain('查不到');
  });

  it('5xx 说明可以重试', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_item', arguments: { id: '500' } },
    });
    expect((res.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('重试');
  });

  it('参数不合法是工具层失败而不是协议错误', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_item', arguments: {} },
    });
    // 模型应当读到它并改参数，而不是把它当环境故障去重试
    expect(res.error).toBeUndefined();
    expect((res.result as { isError: boolean }).isError).toBe(true);
  });

  it('未知工具名列出可用的', async () => {
    const res = await rpc('/mcp/demo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect((res.error as { message: string }).message).toContain('get_item');
  });

  it('未知桥标识回 404', async () => {
    const res = await fetch(`${bridge.baseUrl}/mcp/no-such-source`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('resources/list 与 prompts/list 明确回空而不是报错', async () => {
    // 客户端握手后会逐个探测，报错会让整条连接看起来有问题
    for (const method of ['resources/list', 'prompts/list']) {
      const res = await rpc('/mcp/demo', { jsonrpc: '2.0', id: 1, method });
      expect(res.error).toBeUndefined();
    }
  });

  it('通知（无 id）不产生响应体', async () => {
    const res = await fetch(`${bridge.baseUrl}/mcp/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });

  it('只绑回环', () => {
    expect(bridge.baseUrl).toContain('127.0.0.1');
  });
});

/* ------------------------------------------------------------------ *
 * 桥：响应形态的处理
 *
 * 这一组守的都是「看起来成功的失败」：上游回了 200，但内容不是我们要的东西。
 * 静默通过这些的代价是模型把导航栏或错误页当成科学数据。
 * ------------------------------------------------------------------ */

describe('McpBridgeServer：响应形态', () => {
  let bridge: McpBridgeServer;

  const spec: BridgeSpec = {
    id: 'shape',
    baseUrl: 'https://upstream.test',
    endpoints: [
      { name: 'json_route', description: '', path: '/json', pick: 'data' },
      { name: 'html_route', description: '', path: '/html', pick: 'data' },
      { name: 'text_route', description: '', path: '/fasta', responseType: 'text' },
      {
        name: 'omit_route',
        description: '',
        path: '/big',
        pick: 'data',
        omit: ['sequence', 'blob'],
      },
      {
        name: 'gql_route',
        description: '',
        path: '/gql',
        graphql: 'query Q { a }',
        pick: 'data.a',
      },
      { name: 'broken_body', description: '', path: '/broken', pick: 'data' },
      {
        name: 'static_route',
        description: '',
        path: '/',
        staticText: '这里没有查询接口，改用 RDKit。',
      },
    ],
  };

  beforeEach(async () => {
    bridge = new McpBridgeServer({
      specs: [spec],
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/html')) {
          // 路由不存在时回 200 + 整页 HTML：ZINC 与 UniBind 都这么干
          return new Response('<!doctype html><html><body>nav</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url.endsWith('/fasta')) {
          return new Response('>sp|P38398|BRCA1\nMDLSAL', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        if (url.endsWith('/big')) {
          return Response.json({
            data: [
              { id: 1, sequence: 'MDLSALRVEE', blob: 'xxxx', keep: 'a' },
              { id: 2, nested: { sequence: 'AAAA', keep: 'b' } },
            ],
          });
        }
        if (url.endsWith('/gql')) {
          // GraphQL 的失败是 HTTP 200 + errors
          return Response.json({ errors: [{ message: "Cannot query field 'id'" }] });
        }
        if (url.endsWith('/broken')) {
          // 读响应体时连接断开
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('socket hang up'));
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return Response.json({ data: { ok: true } });
      }) as unknown as typeof fetch,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
  });

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: unknown;
  }> => {
    const res = await fetch(`${bridge.baseUrl}/mcp/shape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
    };
    return body.result;
  };

  it('期望 JSON 却拿到网页时报错，而不是把网页当结果', async () => {
    const out = await call('html_route');
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('不是 JSON');
    // 说清是「这个路径不存在」而不是「数据源坏了」
    expect(out.content[0]?.text).toContain('网页');
  });

  it('声明为纯文本的端点原样返回', async () => {
    const out = await call('text_route');
    expect(out.isError).toBeUndefined();
    expect(out.content[0]?.text).toContain('>sp|P38398');
  });

  it('omit 递归剪掉大字段但保留其余', async () => {
    const out = await call('omit_route');
    const data = out.structuredContent as Array<Record<string, unknown>>;
    expect(data[0]?.sequence).toBeUndefined();
    expect(data[0]?.blob).toBeUndefined();
    expect(data[0]?.keep).toBe('a');
    // 嵌套一层里的同名字段也要剪掉
    expect((data[1]?.nested as Record<string, unknown>).sequence).toBeUndefined();
    expect((data[1]?.nested as Record<string, unknown>).keep).toBe('b');
  });

  it('GraphQL 的 200 + errors 报成失败而不是空结果', async () => {
    const out = await call('gql_route');
    expect(out.isError).toBe(true);
    // 不特判的话 pick 会取到 null，读起来像「查不到这条数据」
    expect(out.content[0]?.text).toContain("Cannot query field 'id'");
  });

  it('读响应体失败与「不是 JSON」分开报', async () => {
    const out = await call('broken_body');
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('读取');
    expect(out.content[0]?.text).not.toContain('不是 JSON');
  });

  it('静态端点不发请求也不报错', async () => {
    let called = false;
    const quiet = new McpBridgeServer({
      specs: [spec],
      fetchImpl: (async () => {
        called = true;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await quiet.start();
    const res = await fetch(`${quiet.baseUrl}/mcp/shape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'static_route', arguments: {} },
      }),
    });
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    await quiet.stop();
    expect(called).toBe(false);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain('RDKit');
  });
});

/* ------------------------------------------------------------------ *
 * 客户端与授权门
 * ------------------------------------------------------------------ */

/** 假传输：直接按方法名回预设结果，用于验客户端逻辑。 */
function fakeTransport(handlers: Record<string, (params: unknown) => unknown>): McpTransport & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    kind: 'stdio',
    closed: false,
    calls,
    start: async () => undefined,
    notify: async () => undefined,
    close: async () => undefined,
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        const { McpError } = await import('@l-science/core');
        throw new McpError(`未实现 ${method}`, { retryable: false });
      }
      return handler(params);
    },
  } as never;
}

const initResult = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'fake', version: '1' },
};

describe('McpClient 授权门', () => {
  let project: ProjectStore;
  let approvals: ApprovalService;
  let published: string[];

  beforeEach(() => {
    const created = store.createProject({ name: '连接器测试' });
    project = store.openProject(created.id);
    published = [];
    approvals = new ApprovalService({
      repo: new ApprovalRepo(project.db),
      publish: (req) => {
        published.push(req.id);
      },
    });
  });

  afterEach(() => {
    approvals.close();
  });

  const client = (tools: unknown[], opts: { withApprovals?: boolean } = {}) =>
    new McpClient({
      connectorId: 'c1',
      connectorName: '测试连接器',
      transport: fakeTransport({
        initialize: () => initResult,
        'tools/list': () => ({ tools }),
        'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }),
      grants: {
        isAllowed: (input) => repo.isToolAllowed({ ...input, connectorId: 'c1' }),
        allow: (input) => {
          repo.allowTool(input);
        },
      },
      ...(opts.withApprovals === false ? {} : { approvals }),
    });

  it('只读工具直接放行', async () => {
    const c = client([{ name: 'query', inputSchema: {}, annotations: { readOnlyHint: true } }]);
    const out = await c.callTool('query', {}, { conversationId: null, projectId: null });
    expect(out.ok).toBe(true);
    expect(out.denied).toBe(false);
    // 只读不该打扰用户
    expect(published).toEqual([]);
  });

  it('声明了破坏性的工具即便标只读也要审批', async () => {
    const c = client([
      { name: 'wipe', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: true } },
    ]);
    const pending = c.callTool('wipe', {}, { conversationId: null, projectId: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(published).toHaveLength(1);
    approvals.decide({ approvalId: published[0] ?? '', decision: 'approve', scope: 'once' });
    expect((await pending).ok).toBe(true);
  });

  it('未声明只读的工具要审批', async () => {
    const c = client([{ name: 'submit', inputSchema: {} }]);
    const pending = c.callTool('submit', {}, { conversationId: null, projectId: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(published).toHaveLength(1);
    approvals.decide({ approvalId: published[0] ?? '', decision: 'approve', scope: 'once' });
    expect((await pending).ok).toBe(true);
  });

  it('拒绝时返回 denied 而不是抛错，且提示不要重试', async () => {
    const c = client([{ name: 'submit', inputSchema: {} }]);
    const pending = c.callTool('submit', {}, { conversationId: null, projectId: null });
    await new Promise((r) => setTimeout(r, 20));
    approvals.decide({ approvalId: published[0] ?? '', decision: 'deny' });

    const out = await pending;
    // 用异常表达拒绝会让调用方倾向于 catch 之后继续，那正是审批要防的事
    expect(out.denied).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('不要重试');
  });

  it('once 不落授权记录', async () => {
    const c = client([{ name: 'submit', inputSchema: {} }]);
    const pending = c.callTool('submit', {}, { conversationId: null, projectId: 'p1' });
    await new Promise((r) => setTimeout(r, 20));
    approvals.decide({ approvalId: published[0] ?? '', decision: 'approve', scope: 'once' });
    await pending;

    // once 的意义正是「放行这一次但不建立长期授权」
    expect(repo.listToolGrants()).toHaveLength(0);
  });

  it('project 作用域落库并在同项目内复用', async () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'x', config: {} });

    const c = client([{ name: 'submit', inputSchema: {} }]);
    const first = c.callTool('submit', {}, { conversationId: null, projectId: 'p1' });
    await new Promise((r) => setTimeout(r, 20));
    approvals.decide({ approvalId: published[0] ?? '', decision: 'approve', scope: 'project' });
    await first;

    expect(repo.listToolGrants()).toHaveLength(1);

    // 第二次不该再打扰用户
    published.length = 0;
    const second = await c.callTool('submit', {}, { conversationId: null, projectId: 'p1' });
    expect(second.ok).toBe(true);
    expect(published).toEqual([]);
  });

  it('project 授权不跨项目', async () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'x', config: {} });
    repo.allowTool({ connectorId: 'c1', toolName: 'submit', scope: 'project', scopeId: 'p1' });

    expect(
      repo.isToolAllowed({
        connectorId: 'c1',
        toolName: 'submit',
        projectId: 'p1',
        conversationId: null,
      }),
    ).toBe(true);
    expect(
      repo.isToolAllowed({
        connectorId: 'c1',
        toolName: 'submit',
        projectId: 'p2',
        conversationId: null,
      }),
    ).toBe(false);
  });

  it('没有审批通道时非只读工具一律拒绝', async () => {
    const c = client([{ name: 'submit', inputSchema: {} }], { withApprovals: false });
    const out = await c.callTool('submit', {}, { conversationId: null, projectId: null });
    // 没人能批准就不能放行有副作用的调用
    expect(out.denied).toBe(true);
    expect(out.text).toContain('没有可用的审批通道');
  });

  it('未知工具列出可用的，不当成协议错误', async () => {
    const c = client([{ name: 'query', inputSchema: {}, annotations: { readOnlyHint: true } }]);
    const out = await c.callTool('nope', {}, { conversationId: null, projectId: null });
    expect(out.ok).toBe(false);
    expect(out.denied).toBe(false);
    expect(out.text).toContain('query');
  });

  it('服务端只声明 tools 时 resources/prompts 为空而不是让连接失败', async () => {
    const c = client([{ name: 'query', inputSchema: {}, annotations: { readOnlyHint: true } }]);
    await c.connect();
    expect(c.tools).toHaveLength(1);
    expect(c.resources).toEqual([]);
    expect(c.prompts).toEqual([]);
  });

  it('并发 connect 只握一次手', async () => {
    const transport = fakeTransport({
      initialize: () => initResult,
      'tools/list': () => ({ tools: [] }),
    });
    const c = new McpClient({ connectorId: 'c1', connectorName: 'x', transport });
    await Promise.all([c.connect(), c.connect(), c.connect()]);
    const inits = (transport as unknown as { calls: Array<{ method: string }> }).calls.filter(
      (x) => x.method === 'initialize',
    );
    expect(inits).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * stdio 传输的环境隔离
 * ------------------------------------------------------------------ */

describe('stdio 传输不泄漏父进程环境', () => {
  /**
   * 起一个真的子进程，让它把自己看到的环境变量回报出来。
   *
   * 这一条必须用真进程验：后端进程里有 `L_SCIENCE_HOST_TOKEN`（控制面特权凭据）与
   * 供应商 API key，一个第三方连接器进程拿到它们就等于绕过了平台的全部管控。
   * 用假传输测不到这件事，因为泄漏发生在 spawn 那一刻。
   */
  const echoServer = [
    '-e',
    `
    let buf = '';
    process.stdin.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const req = JSON.parse(line);
        const leaked = Object.keys(process.env).filter((k) => k.startsWith('L_SCIENCE_'));
        const result = req.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} },
              serverInfo: { name: 'echo', version: '1' } }
          : req.method === 'tools/list'
            ? { tools: [{ name: 'env_report', inputSchema: {},
                          annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: JSON.stringify({
                  leaked, hasPath: process.env.PATH !== undefined || process.env.Path !== undefined,
                  injected: process.env.MY_CONNECTOR_TOKEN ?? null,
                  envCount: Object.keys(process.env).length }) }] };
        if (req.id !== undefined) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
        }
      }
    });
    `,
  ];

  it('特权环境变量不进子进程，但基础变量与显式注入的在', async () => {
    // 模拟后端进程里确实有这些
    process.env.L_SCIENCE_HOST_TOKEN = 'super-secret-token';
    process.env.L_SCIENCE_HOST_URL = 'http://127.0.0.1:1';

    try {
      repo.upsert({
        id: 'echo',
        kind: 'mcp-stdio',
        name: 'Echo',
        config: {
          command: process.execPath,
          args: echoServer,
          env: { MY_CONNECTOR_TOKEN: 'given-on-purpose' },
        },
      });

      const manager = new McpManager({ repo, connectTimeoutMs: 20_000 });
      try {
        const client = await manager.client('echo');
        const out = await client.callTool(
          'env_report',
          {},
          {
            conversationId: null,
            projectId: null,
          },
        );
        const report = JSON.parse(out.text) as {
          leaked: string[];
          hasPath: boolean;
          injected: string | null;
          envCount: number;
        };

        // 核心断言：控制面 token 一个都不能过去
        expect(report.leaked).toEqual([]);
        // 但要能找到可执行文件，否则连接器根本跑不起来
        expect(report.hasPath).toBe(true);
        // 显式给它的配置要到位
        expect(report.injected).toBe('given-on-purpose');
        // 整体环境应当很小——继承了 process.env 的话会有几十上百个
        expect(report.envCount).toBeLessThan(20);
      } finally {
        await manager.close();
      }
    } finally {
      delete process.env.L_SCIENCE_HOST_TOKEN;
      delete process.env.L_SCIENCE_HOST_URL;
    }
  }, 40_000);

  it('命令不存在时给出可读错误而不是挂住', async () => {
    repo.upsert({
      id: 'missing',
      kind: 'mcp-stdio',
      name: 'Missing',
      config: { command: 'definitely-not-a-real-command-xyz' },
    });
    const manager = new McpManager({ repo, connectTimeoutMs: 8_000 });
    try {
      await expect(manager.client('missing')).rejects.toThrow(/无法启动|超时/);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * 注册表与两级开关
 * ------------------------------------------------------------------ */

describe('ConnectorRepo', () => {
  it('两级开关：组关掉后连接器不生效', () => {
    repo.upsertGroup({ id: 'g1', name: '组一' });
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', groupId: 'g1', config: {} });

    expect(repo.listEffective().map((c) => c.id)).toEqual(['c1']);

    repo.setGroupEnabled('g1', false);
    // 只看连接器级会让「关掉整组」失效，而用户会以为已经关了
    expect(repo.listEffective()).toEqual([]);
  });

  it('连接器自己关掉也不生效', () => {
    repo.upsertGroup({ id: 'g1', name: '组一' });
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', groupId: 'g1', config: {} });
    repo.setEnabled('c1', false);
    expect(repo.listEffective()).toEqual([]);
  });

  it('重复 upsert 不覆盖用户的启用选择', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: { url: 'a' } });
    repo.setEnabled('c1', false);
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1 改名', config: { url: 'b' } });

    const record = repo.get('c1');
    // 用 INSERT OR REPLACE 会把它重置，表现为「每次重启后我关掉的那个又开了」
    expect(record?.enabled).toBe(false);
    expect(record?.name).toBe('C1 改名');
    expect(record?.config.url).toBe('b');
  });

  it('组同样不被同步覆盖启用状态', () => {
    repo.upsertGroup({ id: 'g1', name: '组一' });
    repo.setGroupEnabled('g1', false);
    repo.upsertGroup({ id: 'g1', name: '组一（新名）' });
    expect(repo.getGroup('g1')?.enabled).toBe(false);
  });

  it('内置连接器不能删，只能禁用', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', builtin: true, config: {} });
    const result = repo.delete('c1');
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain('只能禁用');
  });

  it('用户自建的可以删', () => {
    repo.upsert({ id: 'mine', kind: 'mcp-stdio', name: 'Mine', config: { command: 'x' } });
    expect(repo.delete('mine').deleted).toBe(true);
  });

  it('pruneBuiltins 只删内置，不碰用户自建', () => {
    repo.upsert({ id: 'b1', kind: 'mcp-http', name: 'B1', builtin: true, config: {} });
    repo.upsert({ id: 'b2', kind: 'mcp-http', name: 'B2', builtin: true, config: {} });
    repo.upsert({ id: 'mine', kind: 'mcp-stdio', name: 'Mine', config: {} });

    expect(repo.pruneBuiltins(['b1'])).toBe(1);
    expect(
      repo
        .list({ includeDisabled: true })
        .map((c) => c.id)
        .sort(),
    ).toEqual(['b1', 'mine']);
  });

  it('域名按生效连接器汇总', () => {
    repo.upsertGroup({ id: 'g1', name: '组一' });
    repo.upsert({
      id: 'c1',
      kind: 'mcp-http',
      name: 'C1',
      groupId: 'g1',
      config: {},
      domains: ['a.test', 'b.test'],
    });
    repo.upsert({ id: 'c2', kind: 'mcp-http', name: 'C2', config: {}, domains: ['c.test'] });

    expect([...repo.effectiveDomains()]).toEqual(['a.test', 'b.test', 'c.test']);

    repo.setGroupEnabled('g1', false);
    // 关了组，它的域名要跟着撤——否则用户以为断网了而内核里的代码照样能连
    expect([...repo.effectiveDomains()]).toEqual(['c.test']);
  });

  it('域名整体替换而不是累加', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {}, domains: ['a.test'] });
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {}, domains: ['b.test'] });
    expect(repo.get('c1')?.domains).toEqual(['b.test']);
  });

  it('always 授权跨项目与会话都有效', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {} });
    repo.allowTool({ connectorId: 'c1', toolName: 't', scope: 'always' });
    expect(
      repo.isToolAllowed({
        connectorId: 'c1',
        toolName: 't',
        projectId: 'any',
        conversationId: 'any',
      }),
    ).toBe(true);
  });

  it('过期的授权不再有效', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {} });
    repo.allowTool({
      connectorId: 'c1',
      toolName: 't',
      scope: 'always',
      expiresAt: Date.now() - 1000,
    });
    expect(
      repo.isToolAllowed({
        connectorId: 'c1',
        toolName: 't',
        projectId: null,
        conversationId: null,
      }),
    ).toBe(false);
  });

  it('撤销是软删除，保留审计痕迹', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {} });
    const grant = repo.allowTool({ connectorId: 'c1', toolName: 't', scope: 'always' });

    expect(repo.revokeToolGrant(grant.id)).toBe(true);
    expect(repo.listToolGrants()).toHaveLength(0);
    // 「曾经授权过什么」是审计内容
    expect(repo.listToolGrants({ includeRevoked: true })).toHaveLength(1);
    expect(repo.revokeToolGrant(grant.id)).toBe(false);
  });

  it('revokeAllForConnector 一次撤销该连接器的全部授权', () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {} });
    repo.allowTool({ connectorId: 'c1', toolName: 'a', scope: 'always' });
    repo.allowTool({ connectorId: 'c1', toolName: 'b', scope: 'always' });
    expect(repo.revokeAllForConnector('c1')).toBe(2);
    expect(repo.listToolGrants()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 内置目录
 * ------------------------------------------------------------------ */

describe('内置连接器目录', () => {
  it('同步是幂等的', () => {
    const first = syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:1234' });
    expect(first.added).toBe(BUILTIN_CONNECTORS.length);

    const second = syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:1234' });
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(BUILTIN_CONNECTORS.length);
  });

  it('桥地址变了会更新配置', () => {
    syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:1111' });
    const changed = syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:2222' });
    // 端口每次启动都可能变，配置必须跟着更新，否则连的是一个不存在的端口
    expect(changed.updated).toBe(BUILTIN_CONNECTORS.length);
    expect(repo.get('pubmed')?.config.url).toContain('2222');
  });

  it('同步不覆盖用户关掉的连接器', () => {
    syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:1111' });
    repo.setEnabled('pubmed', false);
    syncBuiltinConnectors({ repo, bridgeUrl: 'http://127.0.0.1:2222' });
    expect(repo.get('pubmed')?.enabled).toBe(false);
  });

  it('每个连接器都归入一个已定义的组', () => {
    const groupIds = new Set(BUILTIN_CONNECTOR_GROUPS.map((g) => g.id));
    const orphans = BUILTIN_CONNECTORS.filter((c) => !groupIds.has(c.groupId));
    expect(orphans.map((c) => c.id)).toEqual([]);
  });

  it('每个连接器都有对应的桥定义', () => {
    const ids = new Set(bridgeIds());
    const missing = BUILTIN_CONNECTORS.filter((c) => !ids.has(c.bridge));
    // 没有桥定义的连接器会在第一次调用时拿到 404，而那个 404 看起来像配置写错了
    expect(missing.map((c) => `${c.id}→${c.bridge}`)).toEqual([]);
  });

  it('每个桥定义都被至少一个连接器引用', () => {
    const used = new Set(BUILTIN_CONNECTORS.map((c) => c.bridge));
    const unused = bridgeIds().filter((id) => !used.has(id));
    expect(unused).toEqual([]);
  });

  it('每个桥的每个端点都有描述与名称', () => {
    const bad: string[] = [];
    for (const spec of BRIDGE_SPECS) {
      for (const ep of spec.endpoints) {
        if (ep.name.trim() === '' || ep.description.trim().length < 10) {
          bad.push(`${spec.id}.${ep.name}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('端点名在同一个桥内唯一', () => {
    const dupes: string[] = [];
    for (const spec of BRIDGE_SPECS) {
      const seen = new Set<string>();
      for (const ep of spec.endpoints) {
        if (seen.has(ep.name)) dupes.push(`${spec.id}.${ep.name}`);
        seen.add(ep.name);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('所有 baseUrl 都是 https（本地 Ketcher 例外）', () => {
    const insecure = BRIDGE_SPECS.filter(
      (s) => !s.baseUrl.startsWith('https://') && !s.baseUrl.startsWith('http://127.0.0.1'),
    );
    expect(insecure.map((s) => s.id)).toEqual([]);
  });

  it('连接器声明的域名覆盖桥与端点用到的所有主机', () => {
    const byId = new Map(BRIDGE_SPECS.map((s) => [s.id, s]));
    const mismatch: string[] = [];
    for (const conn of BUILTIN_CONNECTORS) {
      const spec = byId.get(conn.bridge);
      if (spec === undefined) continue;
      // 端点可以覆盖 baseUrl（ClinGen 的能力散在三个主机上），
      // 所以要把端点级的主机也算进来——漏一个就等于那个端点在白名单里不存在
      const hosts = new Set<string>([new URL(spec.baseUrl).hostname]);
      for (const ep of spec.endpoints) {
        if (ep.baseUrl !== undefined) hosts.add(new URL(ep.baseUrl).hostname);
      }
      for (const host of hosts) {
        if (host === '127.0.0.1') continue;
        if (!conn.domains.includes(host)) mismatch.push(`${conn.id}: 缺 ${host}`);
      }
    }
    expect(mismatch).toEqual([]);
  });

  it('端点声明的超时都短于 MCP 客户端的调用超时', () => {
    /*
     * 桥等得比客户端久是没有意义的：客户端到点就放弃，用户看到「调用超时」，
     * 而上游还在为一个没人接收的结果干活。这条断言让「加一个慢端点」时必须面对这个上限。
     */
    const tooLong = BRIDGE_SPECS.flatMap((s) =>
      s.endpoints
        .filter((e) => e.timeoutMs !== undefined && e.timeoutMs >= DEFAULT_CALL_TIMEOUT_MS)
        .map((e) => `${s.id}.${e.name}=${String(e.timeoutMs)}`),
    );
    expect(tooLong).toEqual([]);
  });

  it('声明了 pick 或 graphql 的端点不会同时声明 responseType: text', () => {
    // 两者矛盾：pick 要解析 JSON，text 直接原样返回，pick 会被静默忽略
    const conflict = BRIDGE_SPECS.flatMap((s) =>
      s.endpoints
        .filter(
          (e) => e.responseType === 'text' && (e.pick !== undefined || e.graphql !== undefined),
        )
        .map((e) => `${s.id}.${e.name}`),
    );
    expect(conflict).toEqual([]);
  });

  it('静态端点不声明参数或 pick', () => {
    // 静态端点不发请求，声明参数只会让模型以为可以过滤
    const bad = BRIDGE_SPECS.flatMap((s) =>
      s.endpoints
        .filter(
          (e) =>
            e.staticText !== undefined && ((e.params?.length ?? 0) > 0 || e.pick !== undefined),
        )
        .map((e) => `${s.id}.${e.name}`),
    );
    expect(bad).toEqual([]);
  });

  it('指纹对配置变化敏感、对键顺序不敏感', () => {
    const a = connectorFingerprint({
      id: 'x',
      kind: 'mcp-http',
      config: { a: 1, b: 2 },
      domains: ['p', 'q'],
    });
    const b = connectorFingerprint({
      id: 'x',
      kind: 'mcp-http',
      config: { a: 1, b: 2 },
      domains: ['q', 'p'],
    });
    const c = connectorFingerprint({
      id: 'x',
      kind: 'mcp-http',
      config: { a: 1, b: 3 },
      domains: ['p', 'q'],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('目录规模达到对标要求', () => {
    // 对标的 Featured 连接器约 50 个
    expect(BUILTIN_CONNECTORS.length).toBeGreaterThanOrEqual(45);
    expect(BUILTIN_CONNECTOR_GROUPS.length).toBeGreaterThanOrEqual(15);
  });

  it('对标清单里的连接器逐项存在', () => {
    const ids = new Set(BUILTIN_CONNECTORS.map((c) => c.id));
    const reference = [
      'ensembl',
      'ucsc',
      'mygene',
      'uniprot',
      'gene-ontology',
      'reactome',
      'ols',
      'gnomad',
      'clinvar',
      'dbsnp',
      'gwas-catalog',
      'eqtl-catalogue',
      'finngen',
      'biobank-japan',
      'clingen',
      'civic',
      'open-targets',
      'gtex',
      'encode',
      'jaspar',
      'unibind',
      'interpro',
      'pfam',
      'human-protein-atlas',
      'string',
      'pdb',
      'alphafold-db',
      'emdb',
      'complex-portal',
      'intact',
      'rfam',
      'geo',
      'arrayexpress',
      'pride',
      'mgnify',
      'metabolights',
      'cbioportal',
      'pubchem',
      'chebi',
      'rhea',
      'bindingdb',
      'zinc',
      'ketcher',
      'openfda',
      'openalex',
      'arxiv',
      'grants-gov',
      'antibody-registry',
      'pubmed',
      'clinicaltrials',
      'chembl',
      'biorxiv',
    ];
    const missing = reference.filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 管理器
 * ------------------------------------------------------------------ */

describe('McpManager', () => {
  it('未启用的连接器拒绝连接并说明是组还是自己被关了', async () => {
    repo.upsertGroup({ id: 'g1', name: '结构与相互作用' });
    repo.upsert({
      id: 'c1',
      kind: 'mcp-http',
      name: 'C1',
      groupId: 'g1',
      config: { url: 'http://x' },
    });
    repo.setGroupEnabled('g1', false);

    const manager = new McpManager({ repo });
    await expect(manager.client('c1')).rejects.toThrow(/结构与相互作用/);
  });

  it('不存在的连接器给出明确错误', async () => {
    const manager = new McpManager({ repo });
    await expect(manager.client('nope')).rejects.toThrow(/不存在/);
  });

  it('status 不触发连接，且反映两级开关', () => {
    repo.upsertGroup({ id: 'g1', name: '组一' });
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', groupId: 'g1', config: {} });
    repo.setGroupEnabled('g1', false);

    const manager = new McpManager({ repo });
    const status = manager.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.enabled).toBe(false);
    expect(status[0]?.connected).toBe(false);
  });

  it('连接失败会把原因落库供排查', async () => {
    repo.upsert({
      id: 'c1',
      kind: 'mcp-http',
      name: 'C1',
      config: { url: 'http://127.0.0.1:1/mcp' },
    });
    const manager = new McpManager({
      repo,
      connectTimeoutMs: 500,
      fetchImpl: (async () => {
        throw new Error('连不上');
      }) as unknown as typeof fetch,
    });

    await expect(manager.client('c1')).rejects.toThrow();
    // 只记内存的话重启就没了，而健康状态是用户排查的第一入口
    expect(repo.get('c1')?.health?.ok).toBe(false);
    expect(repo.get('c1')?.lastError).toContain('连不上');
  });

  it('缺少必要配置时拒绝构造传输', async () => {
    repo.upsert({ id: 'c1', kind: 'mcp-http', name: 'C1', config: {} });
    const manager = new McpManager({ repo });
    await expect(manager.client('c1')).rejects.toThrow(/缺少 url/);

    repo.upsert({ id: 'c2', kind: 'mcp-stdio', name: 'C2', config: {} });
    await expect(manager.client('c2')).rejects.toThrow(/缺少 command/);
  });
});
