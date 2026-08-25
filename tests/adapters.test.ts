/**
 * 适配器测试（任务 11.2、11.3）。
 *
 * 重点覆盖三处「错了以后症状隐蔽」的逻辑：
 * - SSE 跨分片解析：按 chunk 独立解析在短响应上能用，长输出才开始丢 token
 * - 流式工具调用累积：参数分片到达，按片处理会得到残缺 JSON
 * - DeepSeek 时段计价：忽略时段会让估价随时间漂移一倍
 *
 * 全部不依赖网络：用假的 fetch 与手工构造的字节流。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeepSeekAdapter,
  OllamaAdapter,
  ProviderError,
  ToolCallAccumulator,
  canonicalizeDeepSeekModel,
  classifyRetryable,
  createDefaultRegistry,
  deepseekPricing,
  isPeakPricing,
  normalizeStopReason,
  sseDataLines,
  type ChatChunk,
} from '@l-science/adapters';

/* ------------------------------------------------------------------ *
 * 工具：把字符串按任意边界切成字节流
 * ------------------------------------------------------------------ */

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/* ------------------------------------------------------------------ *
 * SSE 解析
 * ------------------------------------------------------------------ */

describe('SSE 行解析', () => {
  const body = 'data: {"a":1}\ndata: {"b":2}\ndata: [DONE]\n';

  it('逐行取出 data 载荷', async () => {
    const lines: string[] = [];
    for await (const line of sseDataLines(streamOf(body, 1024))) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('分片切在行中间也不丢内容', async () => {
    // 每次只喂 1 字节，等于把每一行都切碎。按 chunk 独立解析会全军覆没
    for (const size of [1, 2, 3, 7, 13]) {
      const lines: string[] = [];
      for await (const line of sseDataLines(streamOf(body, size))) lines.push(line);
      expect(lines, `chunkSize=${String(size)}`).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
    }
  });

  it('CRLF 行尾下 [DONE] 仍能匹配', async () => {
    // 不剥 \r 的话 [DONE] 会变成 [DONE]\r，哨兵匹配不上，流永不结束
    const lines: string[] = [];
    for await (const line of sseDataLines(streamOf('data: {"a":1}\r\ndata: [DONE]\r\n', 4))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '[DONE]']);
  });

  it('忽略空行与注释心跳', async () => {
    const lines: string[] = [];
    for await (const line of sseDataLines(streamOf('\n: keep-alive\ndata: {"a":1}\n\n', 5))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}']);
  });

  it('末行缺换行也能取到', async () => {
    const lines: string[] = [];
    for await (const line of sseDataLines(streamOf('data: {"a":1}', 3))) lines.push(line);
    expect(lines).toEqual(['{"a":1}']);
  });

  it('已中止时立即停止', async () => {
    const controller = new AbortController();
    controller.abort();
    const lines: string[] = [];
    for await (const line of sseDataLines(streamOf(body, 1), controller.signal)) lines.push(line);
    expect(lines).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 工具调用累积
 * ------------------------------------------------------------------ */

describe('流式工具调用累积', () => {
  it('把分片的参数拼成完整 JSON', () => {
    const acc = new ToolCallAccumulator();
    // 真实分片形态：id 与 name 只在第一片出现，参数逐字符流出
    acc.add({ index: 0, id: 'call_a', function: { name: 'run_python', arguments: '' } });
    acc.add({ index: 0, function: { arguments: '{"co' } });
    acc.add({ index: 0, function: { arguments: 'de":"1+' } });
    acc.add({ index: 0, function: { arguments: '1"}' } });

    expect(acc.drain()).toEqual([
      { id: 'call_a', name: 'run_python', argumentsJson: '{"code":"1+1"}' },
    ]);
  });

  it('多个并行调用按 index 分开归并', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'c0', function: { name: 'first', arguments: '{"x"' } });
    acc.add({ index: 1, id: 'c1', function: { name: 'second', arguments: '{"y"' } });
    acc.add({ index: 1, function: { arguments: ':2}' } });
    acc.add({ index: 0, function: { arguments: ':1}' } });

    // 交错到达也要各归各位，且保持 index 升序
    expect(acc.drain()).toEqual([
      { id: 'c0', name: 'first', argumentsJson: '{"x":1}' },
      { id: 'c1', name: 'second', argumentsJson: '{"y":2}' },
    ]);
  });

  it('缺 id 时合成稳定 id', () => {
    // 部分 Ollama 版本不给 id，没有 id 就无法把工具结果关联回调用
    const acc = new ToolCallAccumulator();
    acc.add({ index: 2, function: { name: 'f', arguments: '{}' } });
    expect(acc.drain()).toEqual([{ id: 'call_2', name: 'f', argumentsJson: '{}' }]);
  });

  it('无参数时给空对象而不是空串', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'c', function: { name: 'noargs' } });
    // 空串不是合法 JSON，下游 JSON.parse 会抛
    expect(acc.drain()[0]?.argumentsJson).toBe('{}');
  });

  it('没有 name 的条目被丢弃', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, function: { arguments: '{"orphan":1}' } });
    expect(acc.drain()).toEqual([]);
  });

  it('index 缺省视为 0', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: 'c', function: { name: 'f', arguments: '{"a"' } });
    acc.add({ function: { arguments: ':1}' } });
    expect(acc.drain()).toEqual([{ id: 'c', name: 'f', argumentsJson: '{"a":1}' }]);
  });
});

/* ------------------------------------------------------------------ *
 * 停止原因与可重试性
 * ------------------------------------------------------------------ */

describe('停止原因归一化', () => {
  it.each([
    ['stop', 'end_turn'],
    ['end_turn', 'end_turn'],
    ['eos', 'end_turn'],
    ['length', 'max_tokens'],
    ['max_tokens', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'content_filter'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeStopReason(raw)).toBe(expected);
  });

  it('未知原因退化为 end_turn，不猜成 tool_use', () => {
    // 猜成 tool_use 会让上层去等一个永远不来的工具调用
    expect(normalizeStopReason('something_new')).toBe('end_turn');
    expect(normalizeStopReason(null)).toBe('end_turn');
    expect(normalizeStopReason(undefined)).toBe('end_turn');
  });
});

describe('可重试性判定', () => {
  it('限流与服务端错误可重试', () => {
    expect(classifyRetryable(429, '')).toBe(true);
    expect(classifyRetryable(500, '')).toBe(true);
    expect(classifyRetryable(503, '')).toBe(true);
    expect(classifyRetryable(408, '')).toBe(true);
  });

  it('鉴权失败不重试', () => {
    // 换模型也一样错，重试只是把一个错误放大成一串
    expect(classifyRetryable(401, 'invalid api key')).toBe(false);
    expect(classifyRetryable(403, 'forbidden')).toBe(false);
  });

  it('上下文超限可重试，因为降级到更大窗口的模型正好能解决', () => {
    expect(classifyRetryable(400, 'This model maximum context length is 65536 tokens')).toBe(true);
    expect(classifyRetryable(400, 'input too long')).toBe(true);
  });

  it('其他 400 不重试', () => {
    expect(classifyRetryable(400, 'unknown parameter foo')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * DeepSeek 时段计价
 * ------------------------------------------------------------------ */

describe('DeepSeek 时段计价', () => {
  // 官方规则：UTC 周一至周五 01:00-04:00 与 06:00-10:00 为高峰，非高峰价减半
  it('工作日高峰时段判定', () => {
    // 2026-07-29 是周三
    expect(isPeakPricing(new Date('2026-07-29T01:00:00Z'))).toBe(true);
    expect(isPeakPricing(new Date('2026-07-29T03:59:00Z'))).toBe(true);
    expect(isPeakPricing(new Date('2026-07-29T06:00:00Z'))).toBe(true);
    expect(isPeakPricing(new Date('2026-07-29T09:59:00Z'))).toBe(true);
  });

  it('工作日非高峰时段判定', () => {
    expect(isPeakPricing(new Date('2026-07-29T00:59:00Z'))).toBe(false);
    expect(isPeakPricing(new Date('2026-07-29T04:00:00Z'))).toBe(false);
    expect(isPeakPricing(new Date('2026-07-29T05:59:00Z'))).toBe(false);
    expect(isPeakPricing(new Date('2026-07-29T10:00:00Z'))).toBe(false);
    expect(isPeakPricing(new Date('2026-07-29T23:00:00Z'))).toBe(false);
  });

  it('周末全天非高峰', () => {
    // 2026-08-01 周六、08-02 周日；落在工作日的高峰钟点内也不算高峰
    expect(isPeakPricing(new Date('2026-08-01T02:00:00Z'))).toBe(false);
    expect(isPeakPricing(new Date('2026-08-02T07:00:00Z'))).toBe(false);
  });

  it('用 UTC 判定而不是本地时间', () => {
    // 东八区 10:00 = UTC 02:00，属高峰。若误用本地时间会判成非高峰
    const utc0200 = new Date(Date.UTC(2026, 6, 29, 2, 0, 0));
    expect(isPeakPricing(utc0200)).toBe(true);
  });

  it('非高峰价恰为高峰价的一半', () => {
    const peak = deepseekPricing('deepseek-v4-pro', new Date('2026-07-29T02:00:00Z'));
    const offPeak = deepseekPricing('deepseek-v4-pro', new Date('2026-07-29T12:00:00Z'));
    expect(peak).not.toBeNull();
    expect(offPeak).not.toBeNull();
    expect(offPeak?.inputPer1k).toBeCloseTo((peak?.inputPer1k ?? 0) / 2, 10);
    expect(offPeak?.outputPer1k).toBeCloseTo((peak?.outputPer1k ?? 0) / 2, 10);
  });

  it('价格与官方公布的费率一致', () => {
    // 官方（每 1M token，cache miss，高峰）：flash 输入 $0.44 输出 $1.32；
    // pro 输入 $1.32 输出 $3.96。这里换算成每 1K
    const peakAt = new Date('2026-07-29T02:00:00Z');
    expect(deepseekPricing('deepseek-v4-flash', peakAt)).toEqual({
      inputPer1k: 0.00044,
      outputPer1k: 0.00132,
      currency: 'USD',
    });
    expect(deepseekPricing('deepseek-v4-pro', peakAt)).toEqual({
      inputPer1k: 0.00132,
      outputPer1k: 0.00396,
      currency: 'USD',
    });
  });

  it('vision 型号与 flash 同价', () => {
    const at = new Date('2026-07-29T02:00:00Z');
    expect(deepseekPricing('deepseek-v4-flash-vision-exp', at)).toEqual(
      deepseekPricing('deepseek-v4-flash', at),
    );
  });

  it('未知模型返回 null 而不是编一个价', () => {
    expect(deepseekPricing('gpt-4')).toBeNull();
  });
});

describe('DeepSeek 模型名归一化', () => {
  it('规范 id 原样通过', () => {
    expect(canonicalizeDeepSeekModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(canonicalizeDeepSeekModel('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('旧别名映射到对应档位', () => {
    // 不归一化的话，同一个模型会以两个 id 各自打分、各自累积反馈统计，
    // 统计量被摊薄，反馈闭环收敛变慢
    expect(canonicalizeDeepSeekModel('deepseek-chat')).toBe('deepseek-v4-flash');
    expect(canonicalizeDeepSeekModel('deepseek-reasoner')).toBe('deepseek-v4-pro');
  });

  it('无关模型名返回 null', () => {
    expect(canonicalizeDeepSeekModel('llama3')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 对话流（假 fetch）
 * ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  ) as unknown as typeof fetch;
}

function sseResponse(events: string[]): Response {
  const text = `${events.map((e) => `data: ${e}`).join('\n')}\ndata: [DONE]\n`;
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const ctx = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-fake' };

describe('DeepSeek 流式对话', () => {
  it('文本分片按序产出，末尾给出 usage 与停止原因', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{"content":"你"}}]}',
        '{"choices":[{"delta":{"content":"好"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    );

    expect(
      chunks.filter((c) => c.kind === 'text').map((c) => (c as { text: string }).text),
    ).toEqual(['你', '好']);
    const done = chunks.at(-1);
    expect(done?.kind).toBe('done');
    expect(done).toMatchObject({ stopReason: 'end_turn' });
    expect((done as { usage: { tokensIn: number; tokensOut: number } }).usage).toMatchObject({
      tokensIn: 10,
      tokensOut: 2,
    });
  });

  it('思维链走 reasoning_content，归一化为 thinking 分片', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{"reasoning_content":"先想一下"}}]}',
        '{"choices":[{"delta":{"content":"答案"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'q' }],
        stream: true,
      }),
    );

    expect(chunks[0]).toEqual({ kind: 'thinking', text: '先想一下' });
    expect(chunks[1]).toEqual({ kind: 'text', text: '答案' });
  });

  it('工具调用等参数拼完才产出，且排在 done 之前', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_python","arguments":""}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"code\\":"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"1+1\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '算 1+1' }],
        tools: [{ name: 'run_python', description: '跑代码', parameters: { type: 'object' } }],
        stream: true,
      }),
    );

    const call = chunks.find((c) => c.kind === 'tool_call');
    expect(call).toEqual({
      kind: 'tool_call',
      id: 'c1',
      name: 'run_python',
      argumentsJson: '{"code":"1+1"}',
    });
    // 参数必须是合法 JSON——中途产出会得到残缺片段
    expect(() => JSON.parse((call as { argumentsJson: string }).argumentsJson)).not.toThrow();
    expect(chunks.at(-1)).toMatchObject({ kind: 'done', stopReason: 'tool_use' });
  });

  it('畸形事件被跳过，不摧毁整个流', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{"content":"前"}}]}',
        'this-is-not-json',
        '{"choices":[{"delta":{"content":"后"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );
    // 已产出的内容仍然有效，比抛错让用户丢失全部输出更好
    expect(
      chunks.filter((c) => c.kind === 'text').map((c) => (c as { text: string }).text),
    ).toEqual(['前', '后']);
  });

  it('内容安全拒答被识别为 content_filter 而非普通结束', async () => {
    mockFetch(() => sseResponse(['{"choices":[{"delta":{},"finish_reason":"content_filter"}]}']));

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );
    // 这个区分是安全边界：不能被降级链当成故障去换模型重试
    expect(chunks.at(-1)).toMatchObject({ stopReason: 'content_filter' });
  });

  it('流式请求带上 include_usage，否则没有 usage 可核算成本', async () => {
    let captured: unknown = null;
    mockFetch((_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}']);
    });

    await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );
    expect(captured).toMatchObject({ stream_options: { include_usage: true } });
  });
});

describe('成本核算', () => {
  it('按注入的价格算出成本', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(
        { ...ctx, pricing: { inputPer1k: 0.001, outputPer1k: 0.002, currency: 'USD' } },
        {
          modelName: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'x' }],
          stream: true,
        },
      ),
    );

    const usage = (chunks.at(-1) as { usage: { cost: number; currency: string } }).usage;
    expect(usage.cost).toBeCloseTo((1000 / 1000) * 0.001 + (500 / 1000) * 0.002, 10);
    expect(usage.currency).toBe('USD');
  });

  it('未注入价格时自动按调用时刻的时段价核算', async () => {
    mockFetch(() =>
      sseResponse([
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1000}}',
      ]),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );

    const usage = (chunks.at(-1) as { usage: { cost: number } }).usage;
    // 时段未知，但必须落在非高峰与高峰两个值之间且大于 0
    const off = deepseekPricing('deepseek-v4-flash', new Date('2026-07-29T12:00:00Z'));
    const peak = deepseekPricing('deepseek-v4-flash', new Date('2026-07-29T02:00:00Z'));
    const low = (off?.inputPer1k ?? 0) + (off?.outputPer1k ?? 0);
    const high = (peak?.inputPer1k ?? 0) + (peak?.outputPer1k ?? 0);
    expect(usage.cost).toBeGreaterThanOrEqual(low - 1e-12);
    expect(usage.cost).toBeLessThanOrEqual(high + 1e-12);
  });
});

describe('错误归一化', () => {
  it('DeepSeek 的裸 {message,type} 形状', async () => {
    // DeepSeek 不把错误包在 error 字段里，与 OpenAI 不同
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: '模型不存在', type: 'invalid_request_error' }), {
          status: 400,
        }),
    );

    await expect(
      collect(
        new DeepSeekAdapter().chat(ctx, {
          modelName: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'x' }],
          stream: true,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ProviderError', status: 400, retryable: false });
  });

  it('OpenAI 的 {error:{message,type}} 形状', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: '限流了', type: 'rate_limit_error' } }), {
          status: 429,
        }),
    );

    const error = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryable: true });
    expect((error as Error).message).toContain('限流了');
  });

  it('非 JSON 响应体保留原始文本，不吞掉诊断信息', async () => {
    mockFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const error = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    ).catch((e: unknown) => e);

    // 在这里抛 SyntaxError 会把「供应商说了什么」这条关键线索弄丢
    expect((error as Error).message).toContain('502 Bad Gateway');
    expect(error).toMatchObject({ retryable: true });
  });

  it('缺凭据时明确指出如何补，且不重试', async () => {
    const error = await collect(
      new DeepSeekAdapter().chat(
        { baseUrl: 'https://api.deepseek.com' },
        {
          modelName: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'x' }],
          stream: true,
        },
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('credential.mjs');
    expect(error).toMatchObject({ retryable: false });
  });

  it('内容安全类错误被标记，禁止换模型绕过', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ message: 'blocked by safety filter', type: 'content_filter' }),
          {
            status: 400,
          },
        ),
    );

    const error = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({ isContentFilter: true });
  });
});

describe('中止', () => {
  it('中止后产出 aborted 而不是抛错', async () => {
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort();
      return sseResponse(['{"choices":[{"delta":{"content":"a"}}]}']);
    });

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
        signal: controller.signal,
      }),
    );
    // 中止是降级链的正常路径，不是故障：上层需要能干净收尾
    expect(chunks.at(-1)).toMatchObject({ kind: 'done', stopReason: 'aborted' });
  });
});

describe('非流式对话', () => {
  it('一次性响应也归一化成同样的分片序列', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '结果' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
    );

    const chunks = await collect(
      new DeepSeekAdapter().chat(ctx, {
        modelName: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      }),
    );

    expect(chunks).toEqual([
      { kind: 'text', text: '结果' },
      expect.objectContaining({ kind: 'done', stopReason: 'end_turn' }),
    ]);
  });
});

describe('模型清单', () => {
  it('把线上 id 映射成带能力与价格的描述', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'deepseek-v4-flash' },
              { id: 'deepseek-v4-pro' },
              { id: 'deepseek-v4-flash-vision-exp' },
            ],
          }),
          { status: 200 },
        ),
    );

    const models = await new DeepSeekAdapter().listModels(ctx);
    expect(models.map((m) => m.id).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ]);

    // 官方公布：全系 1M 上下文、最大输出 384K
    for (const model of models) {
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxOutputTokens).toBe(384_000);
      expect(model.features.toolUse).toBe(true);
      expect(model.local).toBe(false);
    }

    const vision = models.find((m) => m.id === 'deepseek-v4-flash-vision-exp');
    expect(vision?.features.vision).toBe(true);
    expect(vision?.modalities).toContain('image');

    const flash = models.find((m) => m.id === 'deepseek-v4-flash');
    expect(flash?.features.vision).toBe(false);
    expect(flash?.modalities).toEqual(['text']);
  });

  it('认不出的模型被跳过，不编造能力值', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'mystery-model' }] }),
          {
            status: 200,
          },
        ),
    );
    // 编出来的分数会让路由自信地选错模型
    const models = await new DeepSeekAdapter().listModels(ctx);
    expect(models).toHaveLength(1);
  });

  it('pro 档的能力先验高于 flash 档', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }),
          {
            status: 200,
          },
        ),
    );
    const models = await new DeepSeekAdapter().listModels(ctx);
    const pro = models.find((m) => m.id === 'deepseek-v4-pro');
    const flash = models.find((m) => m.id === 'deepseek-v4-flash');
    expect(pro?.strengths.reasoning).toBeGreaterThan(flash?.strengths.reasoning ?? 100);
    // 也更贵——路由需要在这两者之间做权衡
    expect(pro?.pricing.inputPer1k).toBeGreaterThan(flash?.pricing.inputPer1k ?? 0);
  });

  it('数据使用策略标为 unknown 而不是猜一个乐观值', async () => {
    mockFetch(
      () => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 }),
    );
    const models = await new DeepSeekAdapter().listModels(ctx);
    // 猜一个值等于替用户做了他没授权的判断
    expect(models[0]?.policy.trainingUse).toBe('unknown');
  });
});

describe('健康检查', () => {
  it('走 /models 而不发计费请求', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await new DeepSeekAdapter().health(ctx);
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/models');
    expect(urls[0]).not.toContain('completions');
  });

  it('失败时带上原因而不是只给 false', async () => {
    mockFetch(() => new Response(JSON.stringify({ message: 'bad key' }), { status: 401 }));
    const result = await new DeepSeekAdapter().health(ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('bad key');
  });

  it('网络异常不抛出，返回不健康', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const result = await new DeepSeekAdapter().health(ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Ollama
 * ------------------------------------------------------------------ */

const ollamaCtx = { baseUrl: 'http://127.0.0.1:11434/v1' };

describe('Ollama 适配器', () => {
  it('走原生 API 取真实能力，而不是按模型名猜', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ model: 'qwen3:8b', details: { parameter_size: '8.2B' } }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools'],
            model_info: { 'qwen3.context_length': 40960 },
            details: { parameter_size: '8.2B', family: 'qwen3' },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const models = await new OllamaAdapter().listModels(ollamaCtx);
    expect(models).toHaveLength(1);
    // 上下文窗口取自 model_info，不是硬编码默认值
    expect(models[0]?.contextWindow).toBe(40960);
    expect(models[0]?.features.toolUse).toBe(true);
    expect(models[0]?.features.vision).toBe(false);
    expect(models[0]?.local).toBe(true);
    // 本地推理无按 token 计费
    expect(models[0]?.pricing.inputPer1k).toBe(0);
  });

  it('识别视觉能力并反映到 modalities', async () => {
    mockFetch((url) =>
      url.endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ model: 'llava:7b' }] }), { status: 200 })
        : new Response(
            JSON.stringify({
              capabilities: ['completion', 'vision'],
              model_info: { 'llama.context_length': 4096 },
            }),
            { status: 200 },
          ),
    );

    const models = await new OllamaAdapter().listModels(ollamaCtx);
    expect(models[0]?.features.vision).toBe(true);
    expect(models[0]?.modalities).toEqual(['text', 'image']);
  });

  it('查不到详情时用保守假设，不假定支持工具', async () => {
    mockFetch((url) =>
      url.endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ model: 'weird:latest' }] }), { status: 200 })
        : new Response('boom', { status: 500 }),
    );

    const models = await new OllamaAdapter().listModels(ollamaCtx);
    // 宁可少派活，也不要派了执行不了的活
    expect(models[0]?.features.toolUse).toBe(false);
    expect(models[0]?.features.vision).toBe(false);
    expect(models[0]?.contextWindow).toBe(8192);
  });

  it('本地模型的策略反映数据不出本机', async () => {
    mockFetch((url) =>
      url.endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ model: 'm' }] }), { status: 200 })
        : new Response(JSON.stringify({ capabilities: [] }), { status: 200 }),
    );

    const models = await new OllamaAdapter().listModels(ollamaCtx);
    expect(models[0]?.policy).toMatchObject({ trainingUse: 'none', zdr: true, retentionDays: 0 });
  });

  it('不需要 API key', async () => {
    mockFetch(() => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}']));
    const chunks = await collect(
      new OllamaAdapter().chat(ollamaCtx, {
        modelName: 'qwen3:8b',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );
    expect(chunks.some((c) => c.kind === 'text')).toBe(true);
  });

  it('不发送 stream_options（部分版本会拒绝）', async () => {
    let captured: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}']);
    });

    await collect(
      new OllamaAdapter().chat(ollamaCtx, {
        modelName: 'qwen3:8b',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );
    expect(captured.stream_options).toBeUndefined();
  });

  it('连不上时给出可执行的提示而不是裸的 ECONNREFUSED', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('fetch failed')),
    ) as unknown as typeof fetch;
    const result = await new OllamaAdapter().health(ollamaCtx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ollama serve');
  });

  it('在跑但没有模型时视为不健康，并说明怎么办', async () => {
    mockFetch(() => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const result = await new OllamaAdapter().health(ollamaCtx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ollama pull');
  });
});

describe('默认注册表', () => {
  it('内置适配器全部注册，且分属不同厂商', () => {
    const registry = createDefaultRegistry();
    const ids = registry
      .list()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(['deepseek', 'ollama']);
  });

  it('存在至少两家供应商，满足 Reviewer 的异厂商要求', () => {
    // 只有一家时跨厂商复核无法成立，这里守住这个前提
    expect(createDefaultRegistry().list().length).toBeGreaterThanOrEqual(2);
  });

  it('重复注册同一 id 会报错', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(new DeepSeekAdapter())).toThrow(/重复/);
  });

  it('取未注册的适配器会报错而不是返回 undefined', () => {
    expect(() => createDefaultRegistry().get('anthropic')).toThrow(/未注册/);
  });
});
