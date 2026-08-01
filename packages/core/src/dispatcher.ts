/**
 * 请求分发器。
 *
 * 职责：按方法名路由到处理器、维护在途请求以支持中断、把处理器抛出的任何东西
 * 转成错误信封。最后一点是关键——传输循环不能因为某个处理器抛异常而中断，
 * 否则一个坏请求就能让整条通道失联。
 */

import {
  errResponse,
  eventFrame,
  makeError,
  okResponse,
  type ErrorEnvelope,
  type EventFrame,
  type Request,
  type RequestFrame,
  type RequestMethod,
  type RequestOf,
  type ResponseFrame,
} from '@l-science/shared';

export interface HandlerContext {
  readonly requestId: string;
  /** 请求被中断时触发。长任务处理器应当监听它。 */
  readonly signal: AbortSignal;
  /** 推送与本请求关联的事件。请求结束后再调用会被忽略。 */
  emit(payload: unknown): void;
}

export type RequestHandler<M extends RequestMethod> = (
  req: RequestOf<M>,
  ctx: HandlerContext,
) => Promise<unknown>;

export type EventSink = (frame: EventFrame) => void;

/**
 * 注册表内部存的是擦除了方法名的处理器。
 * 类型安全在 `register` 的签名上强制，此处的擦除不对外泄漏。
 */
type ErasedHandler = (req: Request, ctx: HandlerContext) => Promise<unknown>;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * 把处理器抛出的东西转成错误信封。
 *
 * 只透出 `message`，不透出栈：栈里常带绝对路径与内部结构，而错误信封会一路
 * 送到渲染层。栈应该进后端日志，不进这条通道。
 */
function toEnvelope(err: unknown): ErrorEnvelope {
  if (isAbortError(err)) {
    return makeError('aborted', '请求已被中断');
  }
  if (err instanceof DispatchError) {
    return err.envelope;
  }
  const message = err instanceof Error ? err.message : String(err);
  return makeError('internal', '处理请求时发生内部错误', { detail: message });
}

/** 处理器可以抛这个来指定确切的错误码，而不是一律落到 internal。 */
export class DispatchError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'DispatchError';
    this.envelope = envelope;
  }
}

export class Dispatcher {
  readonly #handlers = new Map<RequestMethod, ErasedHandler>();
  readonly #inflight = new Map<string, AbortController>();
  readonly #sink: EventSink;

  constructor(sink: EventSink) {
    this.#sink = sink;
  }

  register<M extends RequestMethod>(method: M, handler: RequestHandler<M>): void {
    if (this.#handlers.has(method)) {
      throw new Error(`方法已注册，不允许覆盖：${method}`);
    }
    this.#handlers.set(method, handler as unknown as ErasedHandler);
  }

  has(method: RequestMethod): boolean {
    return this.#handlers.has(method);
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  /** 中断指定请求。返回是否找到该请求。 */
  abort(requestId: string): boolean {
    const controller = this.#inflight.get(requestId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.#inflight.values()) {
      controller.abort();
    }
  }

  /** 推送不关联任何请求的广播事件。 */
  broadcast(payload: unknown): void {
    this.#sink(eventFrame(null, payload));
  }

  async handle(frame: RequestFrame): Promise<ResponseFrame> {
    const { id, payload } = frame;

    // 重复 id 会让响应无法对应回请求，必须拒绝而不是覆盖在途请求。
    if (this.#inflight.has(id)) {
      return errResponse(
        id,
        makeError('conflict', '请求 id 与在途请求重复', {
          detail: `id=${id}`,
          remediation: '为每个请求生成唯一 id',
        }),
      );
    }

    const handler = this.#handlers.get(payload.method);
    if (handler === undefined) {
      return errResponse(
        id,
        makeError('not_found', '方法尚未实现', { detail: `method=${payload.method}` }),
      );
    }

    const controller = new AbortController();
    this.#inflight.set(id, controller);

    let finished = false;
    const ctx: HandlerContext = {
      requestId: id,
      signal: controller.signal,
      // 请求结束后处理器可能还持有 ctx（例如漏掉 await 的定时器），
      // 此时静默丢弃事件而不是往通道里塞无主消息。
      emit: (eventPayload: unknown): void => {
        if (finished) return;
        this.#sink(eventFrame(id, eventPayload));
      },
    };

    try {
      const result = await handler(payload, ctx);
      if (controller.signal.aborted) {
        return errResponse(id, makeError('aborted', '请求已被中断'));
      }
      return okResponse(id, result === undefined ? null : result);
    } catch (err) {
      return errResponse(id, toEnvelope(err));
    } finally {
      finished = true;
      this.#inflight.delete(id);
    }
  }
}
