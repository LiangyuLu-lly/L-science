/**
 * 后端进程客户端。
 *
 * 刻意只依赖 `@l-science/shared`，不依赖 `@l-science/core`：core 会拉进
 * better-sqlite3 与 zeromq 两个原生模块，而 Electron 主进程完全不需要它们。
 * 把边界划在这里，Electron 侧就永远不会有原生模块 ABI 的问题。
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  parseFrame,
  requestFrame,
  type ErrorEnvelope,
  type Request,
  type ResponseFrame,
} from '@l-science/shared';

export interface PendingRejection {
  code: ErrorEnvelope['code'];
  message: string;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: ErrorEnvelope) => void;
  timer: NodeJS.Timeout;
}

export interface BackendClientOptions {
  child: ChildProcessWithoutNullStreams;
  /** 收到与请求关联或广播的事件时调用。 */
  onEvent: (id: string | null, payload: unknown) => void;
  /** 后端日志（stderr）与协议异常的观察点。 */
  onLog: (line: string) => void;
  /** 单请求超时。超时后 pending 被拒绝，避免渲染层永久挂起。 */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class BackendClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #onEvent: BackendClientOptions['onEvent'];
  readonly #onLog: BackendClientOptions['onLog'];
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  #seq = 0;
  #stdoutBuf = '';
  #closed = false;

  constructor(opts: BackendClientOptions) {
    this.#child = opts.child;
    this.#onEvent = opts.onEvent;
    this.#onLog = opts.onLog;
    this.#timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      this.#onStdout(chunk);
    });

    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() !== '') this.#onLog(line);
      }
    });

    this.#child.on('exit', (code, signal) => {
      this.#onLog(`后端退出 code=${String(code)} signal=${String(signal)}`);
      this.#failAll({
        code: 'internal',
        message: '后端进程已退出',
        detail: `code=${String(code)} signal=${String(signal)}`,
      });
    });
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async invoke(payload: Request): Promise<unknown> {
    if (this.#closed || this.#child.exitCode !== null) {
      throw Object.assign(new Error('后端不可用'), {
        envelope: { code: 'internal', message: '后端进程不可用' } satisfies ErrorEnvelope,
      });
    }

    this.#seq += 1;
    const id = `m${String(this.#seq)}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject({
          code: 'timeout',
          message: '后端未在预期时间内响应',
          detail: `id=${id} method=${payload.method}`,
        } satisfies ErrorEnvelope);
      }, this.#timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify(requestFrame(id, payload))}\n`);
    });
  }

  close(): void {
    this.#closed = true;
    this.#failAll({ code: 'aborted', message: '客户端已关闭' });
    if (this.#child.exitCode === null) {
      // 先合上 stdin：后端监听 EOF 会自行优雅退出。
      this.#child.stdin.end();
    }
  }

  #failAll(error: ErrorEnvelope): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    let nl = this.#stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.#stdoutBuf.slice(0, nl).trim();
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      if (line !== '') this.#onLine(line);
      nl = this.#stdoutBuf.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 后端把日志写到 stderr，stdout 出现非 JSON 说明有人违反了这条约定。
      this.#onLog(`stdout 出现非协议内容：${line.slice(0, 200)}`);
      return;
    }

    const parsed = parseFrame(raw);
    if (!parsed.ok) {
      this.#onLog(`收到非法帧：${parsed.error.detail ?? parsed.error.message}`);
      return;
    }

    const frame = parsed.value;
    if (frame.type === 'event') {
      this.#onEvent(frame.id, frame.payload);
      return;
    }
    if (frame.type === 'response') {
      this.#settle(frame);
      return;
    }
    this.#onLog(`后端发来了 request 帧，方向错误，已忽略`);
  }

  #settle(frame: ResponseFrame): void {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      // 超时后迟到的响应，丢弃即可，但记录下来便于发现超时阈值设得过紧。
      this.#onLog(`收到无主响应 id=${frame.id}（可能已超时）`);
      return;
    }
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);

    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(frame.error);
  }
}
