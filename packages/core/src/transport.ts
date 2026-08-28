/**
 * 换行分隔 JSON（NDJSON）over stdio 传输。
 *
 * 为什么是 stdio 而不是本机 TCP：M1 没有跨机需求，而 localhost 在多用户
 * Windows 上并不等于可信——开一个端口就得同时解决鉴权问题。stdio 的可达性
 * 天然等于「能拿到这个子进程句柄」，把鉴权问题消掉而不是解决它。
 *
 * 大体积载荷（DataFrame 预览、图像、长文本）按设计走旁路文件通道，因此这里
 * 的帧应当始终很小。超过上限视为协议违规而不是扩容。
 */

import type { Readable, Writable } from 'node:stream';

import {
  errResponse,
  makeError,
  parseFrame,
  type ErrorEnvelope,
  type EventFrame,
} from '@l-science/shared';

import { Dispatcher } from './dispatcher.js';

/** 单帧字节上限。8 MiB 对控制消息足够宽松，同时挡住无界缓冲。 */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface DecodeResult {
  lines: string[];
  /** 本次喂入中被丢弃的超长帧数量。 */
  overflows: number;
}

/**
 * 增量行解码器。
 *
 * 关键性质：遇到超长行时不会无界增长。做法是丢掉已缓冲内容并进入「跳到下一个
 * 换行符」状态，这样一个恶意的巨型帧只会损失它自己，不会拖垮后续帧的解析。
 */
export class LineDecoder {
  #buf: Buffer = Buffer.alloc(0);
  /** 处于跳过状态：正在丢弃一个超长行的剩余字节，直到遇到换行符。 */
  #skipping = false;
  readonly #max: number;

  constructor(maxBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (maxBytes < 1) throw new Error('maxBytes 必须为正');
    this.#max = maxBytes;
  }

  get buffered(): number {
    return this.#buf.length;
  }

  push(chunk: Buffer): DecodeResult {
    const lines: string[] = [];
    let overflows = 0;
    let cursor = 0;

    while (cursor < chunk.length) {
      if (this.#skipping) {
        const nl = chunk.indexOf(NEWLINE, cursor);
        if (nl === -1) return { lines, overflows };
        this.#skipping = false;
        cursor = nl + 1;
        continue;
      }

      const nl = chunk.indexOf(NEWLINE, cursor);
      if (nl === -1) {
        const rest = chunk.subarray(cursor);
        if (this.#buf.length + rest.length > this.#max) {
          // 还没见到换行符就已超限，丢掉并进入跳过状态。
          this.#buf = Buffer.alloc(0);
          this.#skipping = true;
          overflows += 1;
        } else {
          this.#buf = Buffer.concat([this.#buf, rest]);
        }
        return { lines, overflows };
      }

      const segment = chunk.subarray(cursor, nl);
      cursor = nl + 1;

      if (this.#buf.length + segment.length > this.#max) {
        this.#buf = Buffer.alloc(0);
        overflows += 1;
        continue;
      }

      const line = this.#buf.length === 0 ? segment : Buffer.concat([this.#buf, segment]);
      this.#buf = Buffer.alloc(0);

      const text = line.toString('utf8').trim();
      if (text !== '') lines.push(text);
    }

    return { lines, overflows };
  }
}

export interface TransportOptions {
  input: Readable;
  output: Writable;
  maxFrameBytes?: number;
  /** 协议层错误（非法帧、超长帧）的观察点，用于后端日志。 */
  onProtocolError?: (error: ErrorEnvelope) => void;
}

/**
 * stdio 传输。持有一个 Dispatcher，把入站请求交给它并把出站帧写回。
 */
export class StdioTransport {
  readonly dispatcher: Dispatcher;

  readonly #input: Readable;
  readonly #output: Writable;
  readonly #decoder: LineDecoder;
  readonly #onProtocolError: (error: ErrorEnvelope) => void;

  /** 出站写入串行化：保证帧不交错，且尊重背压。 */
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #onData: ((chunk: Buffer) => void) | null = null;

  constructor(opts: TransportOptions) {
    this.#input = opts.input;
    this.#output = opts.output;
    this.#decoder = new LineDecoder(opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.#onProtocolError = opts.onProtocolError ?? ((): void => {});
    this.dispatcher = new Dispatcher((frame: EventFrame) => {
      this.#send(frame);
    });
  }

  start(): void {
    if (this.#onData !== null) throw new Error('传输已启动');

    this.#onData = (chunk: Buffer): void => {
      const { lines, overflows } = this.#decoder.push(chunk);

      for (let i = 0; i < overflows; i += 1) {
        this.#onProtocolError(
          makeError('bad_request', '帧超过大小上限，已丢弃', {
            remediation: '大体积数据应走文件旁路通道，不要塞进控制消息',
          }),
        );
      }

      for (const line of lines) {
        this.#handleLine(line);
      }
    };

    this.#input.on('data', this.#onData);
  }

  /** 推送不关联请求的广播事件。 */
  broadcast(payload: unknown): void {
    this.dispatcher.broadcast(payload);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#onData !== null) {
      this.#input.off('data', this.#onData);
      this.#onData = null;
    }
    this.dispatcher.abortAll();
    // 等已入队的写入落地，避免关闭时丢掉最后几帧。
    await this.#tail;
  }

  #handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#onProtocolError(makeError('bad_request', '帧不是合法 JSON'));
      return;
    }

    const parsed = parseFrame(raw);
    if (!parsed.ok) {
      this.#onProtocolError(parsed.error);

      /*
       * 能认出这是「哪一次请求」时，必须回一条错误响应。
       *
       * 只记日志然后丢掉的做法有一个致命后果：调用方的 promise 永远不 settle。
       * 参数校验失败是最常见的失败之一（UI 版本与后端不一致、字段拼错），而它的
       * 表现会是界面永久转圈——用户看不到任何错误，开发者也不会想到去翻后端日志。
       *
       * 只在 id 是个合法字符串时回复，且不回显任何请求内容：错误信封由
       * `parseFrame` 生成，只含字段路径与原因，不含值。
       */
      const id = (raw as { id?: unknown } | null)?.id;
      const type = (raw as { type?: unknown } | null)?.type;
      if (type === 'request' && typeof id === 'string' && id.length > 0 && id.length <= 128) {
        this.#send(errResponse(id, parsed.error));
      }
      return;
    }

    const frame = parsed.value;
    if (frame.type !== 'request') {
      // 后端只接受请求。响应与事件是出站方向，收到即为协议违规。
      this.#onProtocolError(
        makeError('bad_request', '后端只接受 request 帧', { detail: `type=${frame.type}` }),
      );
      return;
    }

    // 刻意不 await：多个请求要能并发处理，串行会让一个慢请求堵住整条通道。
    void this.dispatcher.handle(frame).then((response) => {
      this.#send(response);
    });
  }

  #send(frame: unknown): void {
    if (this.#closed) return;

    const line = `${JSON.stringify(frame)}\n`;
    this.#tail = this.#tail.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.#output.write(line)) {
            resolve();
            return;
          }
          // 背压：等 drain 再继续，避免在慢消费者下无界堆积。
          this.#output.once('drain', resolve);
        }),
    );
  }
}
