/**
 * Jupyter 内核实例。
 *
 * 一个实例 = 一个内核进程 + 一组通道 + 一份连接文件。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Channels } from './channels.js';
import {
  createConnectionInfo,
  removeConnectionFile,
  writeConnectionFile,
  type ConnectionInfo,
} from './connection.js';
import type { LaunchSpec } from './launch.js';
import {
  createSessionId,
  toKernelOutput,
  type DecodedMessage,
  type KernelOutput,
} from './protocol.js';

/**
 * 有界异步队列。
 *
 * 上界存在的理由很实际：一个 `while True: print(x)` 能以远超消费速度的速率产出
 * stream 消息。无界队列会把内存吃光；这里超限后丢弃并计数，最后作为一条
 * stderr 提示告知用户，而不是让整个后端 OOM。
 */
class OutputQueue {
  readonly #items: KernelOutput[] = [];
  readonly #waiters: Array<(r: IteratorResult<KernelOutput>) => void> = [];
  readonly #limit: number;

  #dropped = 0;
  #ended = false;
  #failure: Error | null = null;

  constructor(limit = 20_000) {
    this.#limit = limit;
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(item: KernelOutput): void {
    if (this.#ended) return;

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    if (this.#items.length >= this.#limit) {
      this.#dropped += 1;
      return;
    }
    this.#items.push(item);
  }

  end(failure?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#failure = failure ?? null;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ value: undefined as unknown as KernelOutput, done: true });
    }
  }

  async *iterate(): AsyncGenerator<KernelOutput, void, undefined> {
    for (;;) {
      const buffered = this.#items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#ended) {
        if (this.#failure !== null) throw this.#failure;
        return;
      }
      const next = await new Promise<IteratorResult<KernelOutput>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done === true) {
        if (this.#failure !== null) throw this.#failure;
        return;
      }
      yield next.value;
    }
  }
}

export interface KernelOptions {
  spec: LaunchSpec;
  /** 连接文件与启动器脚本的存放目录。 */
  runtimeDir: string;
  /** 内核工作目录，必须落在项目 workspace 内。 */
  cwd: string;
  onLog?: (line: string) => void;
}

export interface ExecuteOptions {
  /** silent 的 cell 不进历史、不产生 execute_result。用于初始化代码。 */
  silent?: boolean;
  /** 单次执行的墙钟上限。超时会自动中断内核。 */
  timeoutMs?: number;
}

export interface CompletionReply {
  matches: string[];
  cursorStart: number;
  cursorEnd: number;
}

export interface InspectReply {
  found: boolean;
  data: Record<string, unknown>;
}

export interface KernelInfo {
  implementation: string;
  languageName: string;
  languageVersion: string;
  protocolVersion: string;
  banner: string;
}

export class JupyterKernel {
  readonly language: LaunchSpec['language'];

  readonly #spec: LaunchSpec;
  readonly #runtimeDir: string;
  readonly #cwd: string;
  readonly #onLog: (line: string) => void;
  readonly #id: string;

  #session: string;
  #info: ConnectionInfo | null = null;
  #connFile: string | null = null;
  #channels: Channels | null = null;
  #child: ChildProcess | null = null;
  #info_: KernelInfo | null = null;
  #closed = false;
  /** 同一时刻只允许一个 execute 在途，与 Jupyter 的单执行队列语义一致。 */
  #executing = false;
  /**
   * 在途执行的收尾回调。
   *
   * 重启或关闭时必须调用它，否则通道一关，iopub 监听器随之消失，
   * 输出队列永远不会结束——调用方的 `for await` 会永久挂住。
   */
  #finishExecution: ((failure?: Error) => void) | null = null;
  /** 在途的重启任务。期间通道断开，execute 需要先等它完成。 */
  #restarting: Promise<void> | null = null;

  private constructor(opts: KernelOptions) {
    this.#spec = opts.spec;
    this.#runtimeDir = opts.runtimeDir;
    this.#cwd = opts.cwd;
    this.#onLog = opts.onLog ?? ((): void => {});
    this.#id = randomUUID();
    this.#session = createSessionId();
    this.language = opts.spec.language;
  }

  static async start(opts: KernelOptions): Promise<JupyterKernel> {
    const kernel = new JupyterKernel(opts);
    await kernel.#spawn();
    return kernel;
  }

  get id(): string {
    return this.#id;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get kernelInfo(): KernelInfo | null {
    return this.#info_;
  }

  /**
   * 通道端口，供诊断使用。
   *
   * 刻意不暴露连接信息里的 HMAC key：它一旦泄漏，本机任何进程都能伪造消息
   * 让内核执行代码。需要的只是端口。
   */
  get ports(): Record<string, number> | null {
    const info = this.#info;
    if (info === null) return null;
    return {
      shell: info.shell_port,
      iopub: info.iopub_port,
      stdin: info.stdin_port,
      control: info.control_port,
      hb: info.hb_port,
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  get busy(): boolean {
    return this.#executing;
  }

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  async #spawn(): Promise<void> {
    mkdirSync(this.#runtimeDir, { recursive: true });
    mkdirSync(this.#cwd, { recursive: true });

    const info = await createConnectionInfo(this.#spec.kernelName);
    const connFile = join(this.#runtimeDir, `kernel-${this.#id}.json`);
    writeConnectionFile(connFile, info);

    this.#info = info;
    this.#connFile = connFile;
    this.#session = createSessionId();

    const child = spawn(this.#spec.command, [...this.#spec.args, connFile], {
      cwd: this.#cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.#spec.env },
      windowsHide: true,
    });
    this.#child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.#logLines('stdout', chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#logLines('stderr', chunk);
    });

    child.on('error', (err) => {
      this.#onLog(`内核进程启动失败：${err.message}`);
    });

    const channels = new Channels({
      info,
      session: this.#session,
      onProtocolIssue: (m) => this.#onLog(m),
    });
    channels.open();
    this.#channels = channels;

    await this.#waitReady();
    await this.#runInit();
  }

  /**
   * 等内核就绪。
   *
   * 反复发 `kernel_info_request` 直到收到回复，而不是固定 sleep：固定等待
   * 在慢机器上会偶发失败，在快机器上又白等。同时监视子进程退出——启动失败时
   * 应当立刻报错，而不是耗完整个超时预算。
   */
  async #waitReady(): Promise<void> {
    const channels = this.#requireChannels();
    const deadline = Date.now() + this.#spec.startupTimeoutMs;
    let lastError = '未知原因';

    while (Date.now() < deadline) {
      const child = this.#child;
      if (child !== null && child.exitCode !== null) {
        throw new Error(
          `内核进程在就绪前退出（code=${String(child.exitCode)}）。` +
            (this.language === 'r'
              ? '若为 0xC0000135 / 3221225781，说明缺少 DLL 搜索路径，检查 R_HOME 与 PATH 注入。'
              : ''),
        );
      }

      try {
        const reply = await channels.request('shell', 'kernel_info_request', {}, 1500);
        const c = reply.content;
        const li = (c['language_info'] ?? {}) as Record<string, unknown>;
        this.#info_ = {
          implementation: String(c['implementation'] ?? 'unknown'),
          languageName: String(li['name'] ?? 'unknown'),
          languageVersion: String(li['version'] ?? 'unknown'),
          protocolVersion: String(c['protocol_version'] ?? 'unknown'),
          banner: String(c['banner'] ?? ''),
        };
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    throw new Error(`内核在 ${String(this.#spec.startupTimeoutMs)}ms 内未就绪：${lastError}`);
  }

  /** 初始化代码失败不阻塞可用性，只记录。 */
  async #runInit(): Promise<void> {
    for (const code of this.#spec.initCode) {
      try {
        for await (const out of this.#run(code, { silent: true, timeoutMs: 20_000 }, true)) {
          if (out.type === 'error') {
            this.#onLog(`初始化代码失败：${out.ename}: ${out.evalue}`);
          }
        }
      } catch (err) {
        this.#onLog(`初始化代码异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * 重启：完整重建进程。
   *
   * 不走 `shutdown_request(restart=true)`——完整重启的语义更确定（内存状态清空、
   * 工作区文件保留），也不依赖内核端对重启的支持程度。
   */
  async restart(): Promise<void> {
    if (this.#closed) throw new Error('内核已关闭');

    // 已有重启在途时复用它，避免并发重启起出两个进程
    const inFlight = this.#restarting;
    if (inFlight !== null) return inFlight;

    // 先让在途执行收尾，否则通道一关它的输出队列就永远不会结束
    this.#finishExecution?.(new Error('内核已重启，本次执行被中止'));
    this.#finishExecution = null;
    this.#executing = false;

    const task = (async (): Promise<void> => {
      await this.#teardown();
      await this.#spawn();
    })().finally(() => {
      this.#restarting = null;
    });

    this.#restarting = task;
    return task;
  }

  /**
   * 等到内核可用为止。
   *
   * 存在的理由：超时或中断可能在后台触发重启，重启期间通道是断开的。若不等，
   * 调用方会撞上「内核尚未就绪」——而那不是它的错，它无从知道后台在重启。
   */
  async ready(): Promise<void> {
    if (this.#restarting !== null) await this.#restarting;
  }

  /**
   * 中断执行。
   *
   * 返回实际发生了什么，因为在 Windows 上「中断」往往只能靠重启达成：
   *
   * ipykernel 的 `_send_interrupt_children()` 里写着
   * `if os.name == "nt": self.log.error("Interrupt message not supported on Windows")`
   * ——消息式中断在 Windows 上是空操作。jupyter_client 走的是
   * `JPY_INTERRUPT_EVENT`（把一个 Windows Event 句柄经环境变量传给内核，
   * 由 ipykernel 的 ParentPollerWindows 等待），那需要创建内核对象的原生调用，
   * 纯 JS 拿不到。
   *
   * 因此这里的策略是：先按规范发 `interrupt_request`（Linux/macOS 上有效，
   * 内核跑在 WSL2 沙箱里时同样有效），再检查执行是否真的停下；没停就重启，
   * 并如实报告状态已丢失。绝不假装中断成功——那会让用户以为变量还在。
   */
  async interrupt(graceMs = 3000): Promise<'idle' | 'interrupted' | 'restarted'> {
    if (this.#closed) return 'idle';
    if (!this.#executing) return 'idle';

    const channels = this.#requireChannels();
    try {
      await channels.request('control', 'interrupt_request', {}, 5000);
    } catch (err) {
      this.#onLog(`中断请求未获回复：${err instanceof Error ? err.message : String(err)}`);
    }

    // 轮询等执行真正结束，而不是假定 interrupt_request 一定奏效
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!this.#executing) return 'interrupted';
      await new Promise((r) => setTimeout(r, 100));
    }

    this.#onLog(
      '中断未生效（Windows 上 ipykernel 不支持消息式中断），改为重启内核；内存状态将丢失',
    );
    await this.restart();
    return 'restarted';
  }

  /**
   * 存活探测。
   *
   * 先看进程，再看心跳。心跳的价值在于内核忙于执行时也能回应——那种情况下
   * shell 被占住，用 `kernel_info_request` 无法区分「在算」与「死了」。
   */
  async isAlive(): Promise<boolean> {
    if (this.#closed) return false;
    const child = this.#child;
    if (child === null || child.exitCode !== null) return false;
    return this.#requireChannels().heartbeat();
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#finishExecution?.(new Error('内核已关闭，本次执行被中止'));
    this.#finishExecution = null;
    this.#executing = false;
    await this.#teardown();
  }

  async #teardown(): Promise<void> {
    this.#channels?.close();
    this.#channels = null;

    const child = this.#child;
    this.#child = null;
    if (child !== null && child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill();
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    if (this.#connFile !== null) {
      // 连接文件里有 HMAC key，用完即删。
      removeConnectionFile(this.#connFile);
      this.#connFile = null;
    }
    this.#info = null;
    this.#info_ = null;
  }

  /* ---------------------------------------------------------------- *
   * 执行
   * ---------------------------------------------------------------- */

  /**
   * 执行代码，返回归一化后的输出流。
   *
   * iopub 消息按 `parent_header.msg_id` 关联到本次请求——内核在启动阶段与
   * 其他请求也会往 iopub 推消息，按到达顺序取值一定错。
   */
  execute(code: string, opts: ExecuteOptions = {}): AsyncIterable<KernelOutput> {
    return this.#run(code, opts, false);
  }

  /**
   * 执行的统一实现。
   *
   * `internal` 为 true 时不占用「用户执行槽位」（`#executing`）。初始化代码走
   * 这条路：它在重启过程中运行，若占了槽位，用户在重启完成前发起的下一次执行
   * 会撞上「已有执行在途」——而那次重启很可能正是超时或中断替用户触发的，
   * 让它为此报错说不过去。
   */
  #run(code: string, opts: ExecuteOptions, internal: boolean): AsyncIterable<KernelOutput> {
    if (this.#closed) throw new Error('内核已关闭');
    if (!internal && this.#executing) {
      throw new Error('该内核已有执行在途，请等待完成或先中断');
    }

    const queue = new OutputQueue();
    const timeoutMs = opts.timeoutMs ?? 0;

    // 同步占位，保证「拒绝并发」这件事是同步可预期的
    if (!internal) this.#executing = true;

    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      if (!internal) {
        this.#executing = false;
        this.#finishExecution = null;
      }
      if (queue.dropped > 0) {
        queue.push({
          type: 'stream',
          name: 'stderr',
          text: `\n[L-science] 输出过多，已丢弃 ${String(queue.dropped)} 条消息\n`,
        });
      }
      queue.end(failure);
    };

    // 供 restart/shutdown 强制收尾，避免调用方永久挂住
    if (!internal) {
      this.#finishExecution = (failure?: Error): void => {
        finish(failure);
      };
    }

    const started = (async (): Promise<void> => {
      // 后台可能正在重启（超时或中断触发），此时通道是断开的。等它结束，
      // 而不是把「内核尚未就绪」抛给无从知晓此事的调用方。
      try {
        if (!internal) await this.ready();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.#closed) {
        finish(new Error('内核已关闭'));
        return;
      }

      let channels: Channels;
      try {
        channels = this.#requireChannels();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // msg_id 必须在发送之前就确定，否则订阅与发送之间存在丢消息的窗口。
      // 下面 sendRequest 与 onIopub 之间没有 await，是同步相邻的。
      const { msgId, sent } = channels.sendRequest('shell', 'execute_request', {
        code,
        silent: opts.silent === true,
        store_history: opts.silent !== true,
        user_expressions: {},
        // 交互输入无人应答会让内核永久阻塞，一律禁用
        allow_stdin: false,
        stop_on_error: true,
      });

      unsubscribe = channels.onIopub((msg: DecodedMessage) => {
        if (msg.parentHeader.msg_id !== msgId) return;

        const out = toKernelOutput(msg);
        if (out === null) return;

        // status idle 表示本次请求的输出已全部推完
        if (out.type === 'status' && out.state === 'idle') {
          finish();
          return;
        }
        queue.push(out);
      });

      try {
        await sent;
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#onLog(`执行超过 ${String(timeoutMs)}ms，发起中断`);
          // interrupt() 自己负责「中断不生效就重启」，而重启会强制收尾在途执行，
          // 因此这里不需要额外的宽限定时器。
          void this.interrupt().catch((err: unknown) => {
            finish(err instanceof Error ? err : new Error(String(err)));
          });
        }, timeoutMs);
      }
    })();

    void started;
    return { [Symbol.asyncIterator]: () => queue.iterate() };
  }

  /** 收集整段执行的输出，便于不需要流式的场景。 */
  async executeToCompletion(code: string, opts: ExecuteOptions = {}): Promise<KernelOutput[]> {
    const collected: KernelOutput[] = [];
    for await (const out of this.execute(code, opts)) collected.push(out);
    return collected;
  }

  /* ---------------------------------------------------------------- *
   * 补全与内省
   * ---------------------------------------------------------------- */

  async complete(code: string, cursorPos: number): Promise<CompletionReply> {
    await this.ready();
    this.#assertOpen();
    const reply = await this.#requireChannels().request('shell', 'complete_request', {
      code,
      cursor_pos: cursorPos,
    });
    const c = reply.content;
    return {
      matches: Array.isArray(c['matches']) ? (c['matches'] as unknown[]).map(String) : [],
      cursorStart: typeof c['cursor_start'] === 'number' ? c['cursor_start'] : cursorPos,
      cursorEnd: typeof c['cursor_end'] === 'number' ? c['cursor_end'] : cursorPos,
    };
  }

  async inspect(code: string, cursorPos: number, detailLevel: 0 | 1 = 0): Promise<InspectReply> {
    await this.ready();
    this.#assertOpen();
    const reply = await this.#requireChannels().request('shell', 'inspect_request', {
      code,
      cursor_pos: cursorPos,
      detail_level: detailLevel,
    });
    const c = reply.content;
    return {
      found: c['found'] === true,
      data:
        typeof c['data'] === 'object' && c['data'] !== null
          ? (c['data'] as Record<string, unknown>)
          : {},
    };
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  #requireChannels(): Channels {
    if (this.#channels === null) throw new Error('内核通道不可用');
    return this.#channels;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('内核已关闭');
    if (this.#channels === null) throw new Error('内核尚未就绪');
  }

  #logLines(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== '') this.#onLog(`[${this.language}:${stream}] ${trimmed}`);
    }
  }
}
