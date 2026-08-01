/**
 * 传输层与请求分发测试（任务 2.2）。
 *
 * 重点在三件事：超长帧不会导致无界缓冲、一个坏请求不会拖垮通道、并发请求各自
 * 拿到正确响应。这三条都是「出问题就整条通道失联」的类别，比happy path重要。
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  Dispatcher,
  DispatchError,
  LineDecoder,
  StdioTransport,
  type HandlerContext,
} from '@l-science/core';
import {
  makeError,
  requestFrame,
  type ErrorEnvelope,
  type EventFrame,
  type Frame,
  type ResponseFrame,
} from '@l-science/shared';

/* ------------------------------------------------------------------ *
 * LineDecoder
 * ------------------------------------------------------------------ */

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('LineDecoder', () => {
  it('一次喂入多行全部解出', () => {
    const d = new LineDecoder();
    const { lines } = d.push(buf('a\nb\nc\n'));
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(d.buffered).toBe(0);
  });

  it('残行留在缓冲里，下次补齐', () => {
    const d = new LineDecoder();
    expect(d.push(buf('hel')).lines).toEqual([]);
    expect(d.buffered).toBe(3);
    expect(d.push(buf('lo\n')).lines).toEqual(['hello']);
    expect(d.buffered).toBe(0);
  });

  it('跨多个 chunk 的单行能正确拼接', () => {
    const d = new LineDecoder();
    for (const part of ['{"a"', ':1', ',"b":', '2}']) {
      expect(d.push(buf(part)).lines).toEqual([]);
    }
    expect(d.push(buf('\n')).lines).toEqual(['{"a":1,"b":2}']);
  });

  it('跳过空行与纯空白行', () => {
    const d = new LineDecoder();
    expect(d.push(buf('a\n\n  \nb\n')).lines).toEqual(['a', 'b']);
  });

  it('容忍 CRLF', () => {
    const d = new LineDecoder();
    expect(d.push(buf('a\r\nb\r\n')).lines).toEqual(['a', 'b']);
  });

  it('超长行被丢弃且不无界缓冲', () => {
    const d = new LineDecoder(16);
    const r = d.push(buf('x'.repeat(100)));
    expect(r.lines).toEqual([]);
    expect(r.overflows).toBe(1);
    // 关键：缓冲被清空，而不是继续攒
    expect(d.buffered).toBe(0);
  });

  it('超长行之后的正常行仍能解出', () => {
    const d = new LineDecoder(16);
    const r1 = d.push(buf('x'.repeat(100)));
    expect(r1.overflows).toBe(1);
    // 超长行的剩余部分被跳到换行符为止，之后恢复正常
    const r2 = d.push(buf('yyy\nok\n'));
    expect(r2.lines).toEqual(['ok']);
  });

  it('同一 chunk 内的超长行不影响其后的短行', () => {
    const d = new LineDecoder(8);
    const r = d.push(buf(`${'x'.repeat(50)}\nshort\n`));
    expect(r.overflows).toBe(1);
    expect(r.lines).toEqual(['short']);
  });

  it('拒绝非正的上限', () => {
    expect(() => new LineDecoder(0)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

function makeDispatcher(): { d: Dispatcher; events: EventFrame[] } {
  const events: EventFrame[] = [];
  const d = new Dispatcher((f) => events.push(f));
  return { d, events };
}

describe('Dispatcher', () => {
  it('路由到已注册的处理器并返回结果', async () => {
    const { d } = makeDispatcher();
    d.register('app.status', async () => ({ ready: true }));

    const res = await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ ready: true });
  });

  it('未注册的方法返回 not_found', async () => {
    const { d } = makeDispatcher();
    const res = await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });

  it('重复注册同一方法直接抛错', () => {
    const { d } = makeDispatcher();
    d.register('app.status', async () => null);
    expect(() => d.register('app.status', async () => null)).toThrow(/已注册/);
  });

  it('在途 id 重复返回 conflict', async () => {
    const { d } = makeDispatcher();
    let release: (() => void) | null = null;
    d.register(
      'app.status',
      async () =>
        new Promise((resolve) => {
          release = (): void => resolve(null);
        }),
    );

    const first = d.handle(requestFrame('dup', { method: 'app.status' }));
    // 等到处理器真正在途
    await vi.waitFor(() => expect(d.inflightCount).toBe(1));

    const second = await d.handle(requestFrame('dup', { method: 'app.status' }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('conflict');

    release?.();
    await first;
    expect(d.inflightCount).toBe(0);
  });

  it('处理器抛普通异常转成 internal 且不泄漏栈', async () => {
    const { d } = makeDispatcher();
    d.register('app.status', async () => {
      throw new Error('内部细节');
    });

    const res = await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('internal');
      expect(res.error.detail).toBe('内部细节');
      expect(JSON.stringify(res.error)).not.toContain('at ');
    }
  });

  it('处理器抛 DispatchError 时保留指定的错误码', async () => {
    const { d } = makeDispatcher();
    const envelope: ErrorEnvelope = makeError('sandbox_denied', '路径不在授权范围内');
    d.register('app.status', async () => {
      throw new DispatchError(envelope);
    });

    const res = await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('sandbox_denied');
  });

  it('中断在途请求返回 aborted', async () => {
    const { d } = makeDispatcher();
    d.register(
      'conversation.send',
      async (_req, ctx: HandlerContext) =>
        new Promise((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
          // 故意不自行完成，只能被中断
        }),
    );

    const p = d.handle(
      requestFrame('r1', { method: 'conversation.send', conversationId: 'c1', text: 'hi' }),
    );
    await vi.waitFor(() => expect(d.inflightCount).toBe(1));

    expect(d.abort('r1')).toBe(true);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('aborted');
  });

  it('中断不存在的请求返回 false', () => {
    const { d } = makeDispatcher();
    expect(d.abort('nope')).toBe(false);
  });

  it('处理器发出的事件带上本请求的 id', async () => {
    const { d, events } = makeDispatcher();
    d.register('app.status', async (_req, ctx) => {
      ctx.emit({ kind: 'text.delta', text: 'a' });
      ctx.emit({ kind: 'text.delta', text: 'b' });
      return null;
    });

    await d.handle(requestFrame('r7', { method: 'app.status' }));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.id === 'r7')).toBe(true);
  });

  it('请求结束后再 emit 会被丢弃，不产生无主事件', async () => {
    const { d, events } = makeDispatcher();
    let leaked: HandlerContext | null = null;
    d.register('app.status', async (_req, ctx) => {
      leaked = ctx;
      return null;
    });

    await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(events).toHaveLength(0);

    leaked?.emit({ kind: 'text.delta', text: '迟到的事件' });
    expect(events).toHaveLength(0);
  });

  it('广播事件的 id 为 null', () => {
    const { d, events } = makeDispatcher();
    d.broadcast({ kind: 'turn.end' });
    expect(events[0]?.id).toBeNull();
  });

  it('返回 undefined 的处理器被规范化为 null', async () => {
    const { d } = makeDispatcher();
    d.register('app.status', async () => undefined);
    const res = await d.handle(requestFrame('r1', { method: 'app.status' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBeNull();
  });

  it('abortAll 清空全部在途请求', async () => {
    const { d } = makeDispatcher();
    d.register(
      'conversation.send',
      async (_req, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(null));
        }),
    );

    const a = d.handle(
      requestFrame('a', { method: 'conversation.send', conversationId: 'c', text: 'x' }),
    );
    const b = d.handle(
      requestFrame('b', { method: 'conversation.send', conversationId: 'c', text: 'y' }),
    );
    await vi.waitFor(() => expect(d.inflightCount).toBe(2));

    d.abortAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    expect(d.inflightCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * StdioTransport
 * ------------------------------------------------------------------ */

interface Harness {
  transport: StdioTransport;
  send(frame: unknown): void;
  frames(): Frame[];
  protocolErrors: ErrorEnvelope[];
  close(): Promise<void>;
}

function harness(maxFrameBytes?: number): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const protocolErrors: ErrorEnvelope[] = [];

  const transport = new StdioTransport({
    input,
    output,
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
    onProtocolError: (e) => protocolErrors.push(e),
  });
  transport.start();

  const collected: Frame[] = [];
  const decoder = new LineDecoder();
  output.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk).lines) {
      collected.push(JSON.parse(line) as Frame);
    }
  });

  return {
    transport,
    send: (frame: unknown): void => {
      input.write(`${JSON.stringify(frame)}\n`);
    },
    frames: () => collected,
    protocolErrors,
    close: async (): Promise<void> => {
      await transport.close();
      input.end();
      output.end();
    },
  };
}

describe('StdioTransport', () => {
  it('端到端：请求得到响应', async () => {
    const h = harness();
    h.transport.dispatcher.register('app.status', async () => ({ ok: 1 }));

    h.send(requestFrame('r1', { method: 'app.status' }));
    await vi.waitFor(() => expect(h.frames()).toHaveLength(1));

    const frame = h.frames()[0] as ResponseFrame;
    expect(frame.type).toBe('response');
    expect(frame.id).toBe('r1');
    await h.close();
  });

  it('并发请求各自拿到正确响应，完成顺序可乱序', async () => {
    const h = harness();
    // 第一个慢、第二个快，验证响应按完成顺序回而不是被串行堵住
    h.transport.dispatcher.register('conversation.send', async (req) => {
      const delay = req.text === 'slow' ? 60 : 1;
      await new Promise((r) => setTimeout(r, delay));
      return { echo: req.text };
    });

    h.send(
      requestFrame('slow', { method: 'conversation.send', conversationId: 'c', text: 'slow' }),
    );
    h.send(
      requestFrame('fast', { method: 'conversation.send', conversationId: 'c', text: 'fast' }),
    );

    await vi.waitFor(() => expect(h.frames()).toHaveLength(2), { timeout: 3000 });

    const responses = h.frames() as ResponseFrame[];
    expect(responses[0]?.id).toBe('fast');
    expect(responses[1]?.id).toBe('slow');

    const byId = new Map(responses.map((r) => [r.id, r]));
    const slow = byId.get('slow');
    const fast = byId.get('fast');
    expect(slow?.ok === true && (slow.result as { echo: string }).echo).toBe('slow');
    expect(fast?.ok === true && (fast.result as { echo: string }).echo).toBe('fast');
    await h.close();
  });

  it('事件与响应都带同一个关联 id 且事件先到', async () => {
    const h = harness();
    h.transport.dispatcher.register('conversation.send', async (_req, ctx) => {
      ctx.emit({ kind: 'text.delta', text: 'x' });
      return null;
    });

    h.send(requestFrame('r9', { method: 'conversation.send', conversationId: 'c', text: 'hi' }));
    await vi.waitFor(() => expect(h.frames()).toHaveLength(2));

    expect(h.frames()[0]?.type).toBe('event');
    expect(h.frames()[1]?.type).toBe('response');
    expect(h.frames().every((f) => f.id === 'r9')).toBe(true);
    await h.close();
  });

  it('非法 JSON 只报协议错误，通道继续可用', async () => {
    const h = harness();
    h.transport.dispatcher.register('app.status', async () => 'still alive');

    (h as unknown as { send: (s: unknown) => void }).send('not json at all');
    // 上面那行本身是合法 JSON 字符串，再直接塞一段坏字节
    await vi.waitFor(() => expect(h.protocolErrors.length).toBeGreaterThan(0));

    h.send(requestFrame('r1', { method: 'app.status' }));
    await vi.waitFor(() => expect(h.frames()).toHaveLength(1));
    expect((h.frames()[0] as ResponseFrame).id).toBe('r1');
    await h.close();
  });

  it('后端拒绝入站的 response 与 event 帧', async () => {
    const h = harness();
    h.send({ v: 1, type: 'response', id: 'x', ok: true, result: null });
    h.send({ v: 1, type: 'event', id: null, payload: {} });

    await vi.waitFor(() => expect(h.protocolErrors).toHaveLength(2));
    expect(h.protocolErrors.every((e) => e.code === 'bad_request')).toBe(true);
    expect(h.frames()).toHaveLength(0);
    await h.close();
  });

  it('超长帧被丢弃并报协议错误，后续帧正常', async () => {
    const h = harness(256);
    h.transport.dispatcher.register('app.status', async () => 'ok');

    h.send(
      requestFrame('big', {
        method: 'conversation.send',
        conversationId: 'c',
        text: 'x'.repeat(2000),
      }),
    );
    await vi.waitFor(() => expect(h.protocolErrors.length).toBeGreaterThan(0));
    expect(h.protocolErrors[0]?.remediation).toContain('旁路');

    h.send(requestFrame('small', { method: 'app.status' }));
    await vi.waitFor(() => expect(h.frames()).toHaveLength(1));
    expect((h.frames()[0] as ResponseFrame).id).toBe('small');
    await h.close();
  });

  it('重复 start 抛错', () => {
    const h = harness();
    expect(() => h.transport.start()).toThrow(/已启动/);
    void h.close();
  });

  it('close 后不再写出帧', async () => {
    const h = harness();
    h.transport.dispatcher.register('app.status', async () => 'ok');
    await h.transport.close();

    h.send(requestFrame('r1', { method: 'app.status' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.frames()).toHaveLength(0);
  });
});
