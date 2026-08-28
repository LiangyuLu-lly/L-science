/**
 * 五通道 ZMQ 套接字管理。
 *
 * shell / control / stdin 用 DEALER，iopub 用 SUB，hb 用 DEALER。
 *
 * shell 与 control 上可以有多个在途请求，因此每个通道都跑一个接收循环，
 * 按 `parent_header.msg_id` 把回复派发给等待中的 promise，而不是假设
 * 「发一条收一条」。
 */

import { Dealer, Subscriber } from 'zeromq';

import { endpoint, type ConnectionInfo } from './connection.js';
import {
  createHeader,
  decodeMessage,
  encodeMessage,
  ProtocolError,
  type DecodedMessage,
  type JupyterMsgType,
} from './protocol.js';

export type RequestChannel = 'shell' | 'control';

export interface ChannelsOptions {
  info: ConnectionInfo;
  session: string;
  /** 协议层异常的观察点（签名不符、无法解析的帧、无主回复）。 */
  onProtocolIssue?: (message: string) => void;
}

interface Pending {
  resolve: (msg: DecodedMessage) => void;
  reject: (err: Error) => void;
}

const HEARTBEAT_PAYLOAD = Buffer.from('lsci-ping', 'utf8');

/** 「回复无人等待」的 msg_id 记录上限。见 #noteUnwaited。 */
const MAX_UNWAITED = 256;

export class Channels {
  readonly #info: ConnectionInfo;
  readonly #session: string;
  readonly #onIssue: (message: string) => void;

  readonly #shell = new Dealer();
  readonly #control = new Dealer();
  readonly #stdin = new Dealer();
  readonly #iopub = new Subscriber();
  readonly #hb = new Dealer();

  readonly #pending = new Map<string, Pending>();
  /** 经 sendRequest 发出、回复无人等待的 msg_id。用于区分正常回复与迟到回复。 */
  readonly #unwaited = new Set<string>();
  readonly #iopubListeners = new Set<(msg: DecodedMessage) => void>();

  #opened = false;
  #closed = false;

  constructor(opts: ChannelsOptions) {
    this.#info = opts.info;
    this.#session = opts.session;
    this.#onIssue = opts.onProtocolIssue ?? ((): void => {});
  }

  get closed(): boolean {
    return this.#closed;
  }

  open(): void {
    if (this.#opened) throw new Error('通道已打开');
    this.#opened = true;

    this.#shell.connect(endpoint(this.#info, 'shell'));
    this.#control.connect(endpoint(this.#info, 'control'));
    this.#stdin.connect(endpoint(this.#info, 'stdin'));
    this.#hb.connect(endpoint(this.#info, 'hb'));

    this.#iopub.connect(endpoint(this.#info, 'iopub'));
    // 订阅全部 topic。iopub 的 topic 只是分类前缀，我们按 parent_header 过滤。
    this.#iopub.subscribe('');

    void this.#pumpReplies(this.#shell, 'shell');
    void this.#pumpReplies(this.#control, 'control');
    void this.#pumpIopub();
    void this.#pumpStdin();
  }

  /** 订阅 iopub。返回取消订阅函数。 */
  onIopub(listener: (msg: DecodedMessage) => void): () => void {
    this.#iopubListeners.add(listener);
    return () => {
      this.#iopubListeners.delete(listener);
    };
  }

  /**
   * 只发不等回复。
   *
   * **同步**返回 msg_id，发送本身是其中的 promise。这个形状是必要的：调用方
   * 需要在消息真正出去之前就拿到 msg_id 来建立 iopub 过滤器。若等 `await send()`
   * 之后才知道 id，快内核可能在这个窗口里已经把输出推完，那些消息会被过滤器
   * 当作「不是我的」而永久丢弃。
   *
   * 「不等回复」不等于「不会有回复」：`execute_request` 一定会收到
   * `execute_reply`。因此这里要登记一声「这个回复没人等，是预期的」，否则
   * 回复泵会把每一次正常执行都报成无主回复。
   */
  sendRequest(
    channel: RequestChannel,
    msgType: JupyterMsgType,
    content: Record<string, unknown> = {},
  ): { msgId: string; sent: Promise<void> } {
    this.#assertOpen();
    const header = createHeader(msgType, this.#session);
    const parts = encodeMessage({ key: this.#info.key, header, content });
    this.#noteUnwaited(header.msg_id);
    return {
      msgId: header.msg_id,
      sent: this.#socket(channel).send(parts),
    };
  }

  /**
   * 记下一个「回复无人等待」的 msg_id。
   *
   * 有上限并按插入序淘汰：内核在回复到达前死掉时对应的条目没人来清，不设上限
   * 就是一条随会话时长线性增长的泄漏。淘汰掉最老的条目最坏后果只是那条回复
   * 万一迟到会被误报为无主，代价远小于无界增长。
   */
  #noteUnwaited(msgId: string): void {
    if (this.#unwaited.size >= MAX_UNWAITED) {
      const oldest = this.#unwaited.values().next();
      if (!(oldest.done ?? false)) this.#unwaited.delete(oldest.value);
    }
    this.#unwaited.add(msgId);
  }

  /**
   * 发请求并等对应回复。
   *
   * 超时会把 pending 清掉——不清的话内核永久不回时这个 Map 会一直增长，
   * 而且后续同 id 的迟到回复会找到一个早已无人等待的 promise。
   */
  async request(
    channel: RequestChannel,
    msgType: JupyterMsgType,
    content: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<DecodedMessage> {
    this.#assertOpen();
    const header = createHeader(msgType, this.#session);
    const parts = encodeMessage({ key: this.#info.key, header, content });

    const reply = new Promise<DecodedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(header.msg_id);
        reject(new Error(`${msgType} 在 ${String(timeoutMs)}ms 内未收到回复`));
      }, timeoutMs);

      this.#pending.set(header.msg_id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    await this.#socket(channel).send(parts);
    return reply;
  }

  /**
   * 心跳探活。
   *
   * 存在的意义是它在内核忙于执行时也能回应——那种情况下 shell 通道被占住，
   * `kernel_info_request` 会一直等不到回复，无法区分「在算」与「死了」。
   */
  async heartbeat(timeoutMs = 2000): Promise<boolean> {
    if (this.#closed) return false;
    try {
      // 用 REQ 的分帧形式（空分隔帧 + 载荷）而不是裸单帧：ipykernel 的心跳是
      // ROUTER，IRkernel 的是 REP。REP 要求消息以空分隔帧开头，裸单帧会被丢弃，
      // 表现为「R 内核心跳永远不可达」。加上空帧对 ROUTER 无害，两者都能通。
      await this.#hb.send([Buffer.alloc(0), HEARTBEAT_PAYLOAD]);
      const received = await Promise.race([
        this.#hb.receive().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
      ]);
      return received;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const [, pending] of this.#pending) {
      pending.reject(new Error('通道已关闭'));
    }
    this.#pending.clear();
    this.#unwaited.clear();
    this.#iopubListeners.clear();

    for (const socket of [this.#shell, this.#control, this.#stdin, this.#iopub, this.#hb]) {
      try {
        socket.close();
      } catch {
        // 关闭时的异常无处可报，也无需处理
      }
    }
  }

  #socket(channel: RequestChannel): Dealer {
    return channel === 'shell' ? this.#shell : this.#control;
  }

  #assertOpen(): void {
    if (!this.#opened) throw new Error('通道尚未打开');
    if (this.#closed) throw new Error('通道已关闭');
  }

  async #pumpReplies(socket: Dealer, label: string): Promise<void> {
    while (!this.#closed) {
      let parts: Buffer[];
      try {
        parts = (await socket.receive()) as Buffer[];
      } catch {
        return; // 套接字关闭，正常退出
      }

      let msg: DecodedMessage;
      try {
        msg = decodeMessage(parts, this.#info.key);
      } catch (err) {
        this.#onIssue(
          `${label} 通道收到无法解析的消息：${err instanceof ProtocolError ? err.message : String(err)}`,
        );
        continue;
      }

      if (!msg.signatureValid) {
        // 签名不符意味着 key 不匹配或消息被改过，一律丢弃。
        this.#onIssue(`${label} 通道消息签名校验失败，已丢弃（${msg.header.msg_type}）`);
        continue;
      }

      const parentId = msg.parentHeader.msg_id;
      if (parentId === undefined) {
        this.#onIssue(`${label} 通道消息无 parent_header.msg_id，已丢弃`);
        continue;
      }

      const pending = this.#pending.get(parentId);
      if (pending === undefined) {
        if (this.#unwaited.delete(parentId)) {
          // 由 sendRequest 发出的请求，其回复本就无人等待（执行的完成由 iopub
          // 的 status:idle 判定）。这是正常路径，不是异常
          continue;
        }
        // 到这里才是真的异常：超时后迟到的回复。记录下来便于发现超时阈值
        // 设得过紧
        this.#onIssue(`${label} 通道收到无主回复 parent=${parentId}（可能已超时）`);
        continue;
      }
      this.#pending.delete(parentId);
      pending.resolve(msg);
    }
  }

  async #pumpIopub(): Promise<void> {
    while (!this.#closed) {
      let parts: Buffer[];
      try {
        parts = (await this.#iopub.receive()) as Buffer[];
      } catch {
        return;
      }

      let msg: DecodedMessage;
      try {
        msg = decodeMessage(parts, this.#info.key);
      } catch (err) {
        this.#onIssue(
          `iopub 收到无法解析的消息：${err instanceof ProtocolError ? err.message : String(err)}`,
        );
        continue;
      }

      if (!msg.signatureValid) {
        this.#onIssue(`iopub 消息签名校验失败，已丢弃（${msg.header.msg_type}）`);
        continue;
      }

      // 监听器抛异常不能中断泵，否则后续输出全丢。
      for (const listener of [...this.#iopubListeners]) {
        try {
          listener(msg);
        } catch (err) {
          this.#onIssue(
            `iopub 监听器抛出异常：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * stdin 通道。
   *
   * M1 的执行请求一律 `allow_stdin: false`，所以正常不该有消息。真的收到
   * `input_request` 说明有代码在等交互输入，此时必须回一个空 `input_reply`，
   * 否则内核会一直阻塞在那里，表现为「cell 永远不结束」。
   */
  async #pumpStdin(): Promise<void> {
    while (!this.#closed) {
      let parts: Buffer[];
      try {
        parts = (await this.#stdin.receive()) as Buffer[];
      } catch {
        return;
      }

      let msg: DecodedMessage;
      try {
        msg = decodeMessage(parts, this.#info.key);
      } catch {
        continue;
      }

      if (msg.header.msg_type !== 'input_request') continue;

      this.#onIssue('内核请求标准输入，但当前不支持交互输入，已回空值');
      try {
        await this.#stdin.send(
          encodeMessage({
            key: this.#info.key,
            header: createHeader('input_reply', this.#session),
            parentHeader: msg.header,
            content: { value: '' },
          }),
        );
      } catch {
        return;
      }
    }
  }
}
