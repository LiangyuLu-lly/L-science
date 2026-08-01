/**
 * Electron 侧协议客户端测试（任务 2.3）。
 *
 * 这是主进程里唯一的协议实现，它出错的表现是「渲染层永久转圈」——没有异常、
 * 没有日志，最难排查。因此重点测的是几个容易悄悄失效的性质：
 * 响应关联、超时后不泄漏 pending、后端退出时拒绝全部在途请求、
 * stdout 出现非协议内容时不把它当帧。
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '@l-science/shell/backend-client';
import { errResponse, eventFrame, makeError, okResponse } from '@l-science/shared';

/** 伪造一个只有三个流的子进程。 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
  };
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.exitCode = null;
  return emitter;
}

interface Harness {
  client: BackendClient;
  child: ReturnType<typeof fakeChild>;
  /** 后端写给客户端的帧。 */
  reply(frame: unknown): void;
  /** 客户端写给后端的请求帧。 */
  sent(): Array<{ id: string; payload: { method: string } }>;
  events: Array<{ id: string | null; payload: unknown }>;
  logs: string[];
}

function harness(requestTimeoutMs?: number): Harness {
  const child = fakeChild();
  const events: Harness['events'] = [];
  const logs: string[] = [];
  const sentLines: string[] = [];

  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') sentLines.push(line.trim());
    }
  });

  const client = new BackendClient({
    // 只用到 stdin/stdout/stderr 与 exit 事件，伪造这几项即可
    child: child as unknown as ChildProcessWithoutNullStreams,
    onEvent: (id, payload) => events.push({ id, payload }),
    onLog: (line) => logs.push(line),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });

  return {
    client,
    child,
    reply: (frame) => child.stdout.write(`${JSON.stringify(frame)}\n`),
    sent: () => sentLines.map((l) => JSON.parse(l) as { id: string; payload: { method: string } }),
    events,
    logs,
  };
}

describe('BackendClient', () => {
  it('请求写出为协议帧，响应按 id 关联回来', async () => {
    const h = harness();
    const p = h.client.invoke({ method: 'app.status' });

    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));
    const frame = h.sent()[0];
    expect(frame?.payload.method).toBe('app.status');

    h.reply(okResponse(frame?.id ?? '', { ready: true }));
    await expect(p).resolves.toEqual({ ready: true });
    expect(h.client.pendingCount).toBe(0);
  });

  it('失败响应以错误信封拒绝', async () => {
    const h = harness();
    const p = h.client.invoke({ method: 'app.status' });
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));

    h.reply(errResponse(h.sent()[0]?.id ?? '', makeError('policy_denied', '用户拒绝')));
    await expect(p).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('并发请求各自关联，乱序响应也能对上', async () => {
    const h = harness();
    const a = h.client.invoke({ method: 'app.status' });
    const b = h.client.invoke({ method: 'project.list', includeArchived: false });

    await vi.waitFor(() => expect(h.sent()).toHaveLength(2));
    const [f1, f2] = h.sent();
    // 故意先回第二个
    h.reply(okResponse(f2?.id ?? '', 'second'));
    h.reply(okResponse(f1?.id ?? '', 'first'));

    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
  });

  it('每个请求分配不同 id', async () => {
    const h = harness();
    void h.client.invoke({ method: 'app.status' }).catch(() => {});
    void h.client.invoke({ method: 'app.status' }).catch(() => {});
    await vi.waitFor(() => expect(h.sent()).toHaveLength(2));
    expect(h.sent()[0]?.id).not.toBe(h.sent()[1]?.id);
    h.client.close();
  });

  it('事件帧交给 onEvent 而不进入响应关联', async () => {
    const h = harness();
    h.reply(eventFrame('m1', { kind: 'text.delta', text: 'x' }));
    h.reply(eventFrame(null, { kind: 'turn.end' }));

    await vi.waitFor(() => expect(h.events).toHaveLength(2));
    expect(h.events[0]?.id).toBe('m1');
    expect(h.events[1]?.id).toBeNull();
  });

  it('超时后拒绝并清空 pending，不泄漏', async () => {
    const h = harness(40);
    const p = h.client.invoke({ method: 'app.status' });
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    expect(h.client.pendingCount).toBe(0);
  });

  it('超时后迟到的响应被丢弃并记录', async () => {
    const h = harness(30);
    const p = h.client.invoke({ method: 'app.status' });
    await expect(p).rejects.toMatchObject({ code: 'timeout' });

    h.reply(okResponse(h.sent()[0]?.id ?? '', 'late'));
    await vi.waitFor(() => expect(h.logs.some((l) => l.includes('无主响应'))).toBe(true));
  });

  it('后端退出时拒绝全部在途请求', async () => {
    const h = harness();
    const a = h.client.invoke({ method: 'app.status' });
    const b = h.client.invoke({ method: 'app.status' });
    await vi.waitFor(() => expect(h.client.pendingCount).toBe(2));

    h.child.exitCode = 1;
    h.child.emit('exit', 1, null);

    await expect(a).rejects.toMatchObject({ code: 'internal' });
    await expect(b).rejects.toMatchObject({ code: 'internal' });
    expect(h.client.pendingCount).toBe(0);
  });

  it('后端已退出后不再接受新请求', async () => {
    const h = harness();
    h.child.exitCode = 0;
    h.child.emit('exit', 0, null);
    await expect(h.client.invoke({ method: 'app.status' })).rejects.toBeInstanceOf(Error);
  });

  it('stdout 出现非 JSON 时记录而不当作帧', async () => {
    const h = harness();
    h.child.stdout.write('这是本该走 stderr 的日志\n');
    await vi.waitFor(() => expect(h.logs.some((l) => l.includes('非协议内容'))).toBe(true));
    expect(h.events).toHaveLength(0);
  });

  it('stdout 出现结构非法的帧时记录而不崩溃', async () => {
    const h = harness();
    h.reply({ v: 42, type: 'response', id: 'x' });
    await vi.waitFor(() => expect(h.logs.some((l) => l.includes('非法帧'))).toBe(true));
  });

  it('后端发来 request 帧属于方向错误，被忽略', async () => {
    const h = harness();
    h.reply({ v: 1, type: 'request', id: 'x', payload: { method: 'app.status' } });
    await vi.waitFor(() => expect(h.logs.some((l) => l.includes('方向错误'))).toBe(true));
  });

  it('stderr 按行转成日志', async () => {
    const h = harness();
    h.child.stderr.write('第一行\n第二行\n');
    await vi.waitFor(() => expect(h.logs).toContain('第一行'));
    expect(h.logs).toContain('第二行');
  });

  it('跨 chunk 的帧能正确拼接', async () => {
    const h = harness();
    const p = h.client.invoke({ method: 'app.status' });
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1));

    const line = JSON.stringify(okResponse(h.sent()[0]?.id ?? '', { ok: 1 }));
    h.child.stdout.write(line.slice(0, 10));
    h.child.stdout.write(line.slice(10));
    h.child.stdout.write('\n');

    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('close 拒绝在途请求并合上 stdin', async () => {
    const h = harness();
    const p = h.client.invoke({ method: 'app.status' });
    await vi.waitFor(() => expect(h.client.pendingCount).toBe(1));

    h.client.close();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });
});
