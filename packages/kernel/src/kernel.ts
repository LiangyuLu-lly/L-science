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

/**
 * 平台相关的中断递送机制。
 *
 * 由调用方注入而不是在本包内实现：Windows 上它需要经 FFI 创建一个可继承的
 * Event 句柄，而本包刻意不引入 FFI 依赖。`@l-science/core` 的 `InterruptEvent`
 * 在结构上满足这个接口。
 */
export interface KernelInterrupter {
  /** 注入内核进程的环境变量（Windows 上为 `JPY_INTERRUPT_EVENT`）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 触发中断。返回是否成功递送。 */
  signal(): boolean;
  close(): void;
}

export interface KernelOptions {
  spec: LaunchSpec;
  /** 连接文件与启动器脚本的存放目录。 */
  runtimeDir: string;
  /** 内核工作目录，必须落在项目 workspace 内。 */
  cwd: string;
  onLog?: (line: string) => void;
  /**
   * 中断递送机制。
   *
   * 省略时 Windows 上的中断只能退化为重启：ipykernel 的
   * `_send_interrupt_children()` 对 `os.name == "nt"` 直接放弃，控制通道的
   * `interrupt_request` 是空操作。注入后中断能真正生效且保留内存状态。
   *
   * 生命周期归本内核：`shutdown()` 时会关闭它。
   */
  interrupter?: KernelInterrupter;
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
  readonly #interrupter: KernelInterrupter | null;

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
  /**
   * 是否正处在重启的执行体内。
   *
   * 与 `#restarting` 分开是为了挡住自递归：重启过程里的初始化代码超时会走
   * interrupt → restart，而那时复用「在途重启」等于 await 自己。见 restart() 里
   * 的详细说明。
   */
  #restartInProgress = false;
  /**
   * 当前执行的标识。
   *
   * `interrupt()` 必须按「具体哪一次执行」判断是否成功，不能看全局的
   * `#executing`：用户中断后立刻发起下一个 cell 时，全局标志会再次变成 true，
   * 还在轮询的 interrupt 会误判为「中断没生效」而去重启内核——把本该保留的
   * 状态给丢了。
   */
  #executionToken: symbol | null = null;

  private constructor(opts: KernelOptions) {
    this.#spec = opts.spec;
    this.#runtimeDir = opts.runtimeDir;
    this.#cwd = opts.cwd;
    this.#onLog = opts.onLog ?? ((): void => {});
    this.#interrupter = opts.interrupter ?? null;
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
      // 中断事件的句柄经环境变量传入，因此必须在这里合并
      env: { ...process.env, ...this.#spec.env, ...(this.#interrupter?.env ?? {}) },
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

    /*
     * 重启期间再次请求重启是**死锁**，必须挡住。
     *
     * 实测撞到过：重启 → #spawn → #runInit 的初始化代码超时 → interrupt() →
     * 中断不生效 → restart()。此时 `#restarting` 非空，于是「复用在途重启」把
     * 那个**正在等自己的** promise 返回给了自己，await 它就永久挂死——症状是
     * 用户点重启内核之后再也没有回来，且没有任何错误。
     *
     * 复用在途重启这件事本身是对的（并发重启会起出两个进程），错在没有区分
     * 「别人的重启」与「我自己这一层的重启」。用一个标志把后者变成快速失败：
     * 重启已经在做了，再要求一次没有意义。
     */
    if (this.#restartInProgress) {
      throw new Error('内核正在重启中，不能在重启过程内再次触发重启');
    }

    // 已有重启在途时复用它，避免并发重启起出两个进程
    const inFlight = this.#restarting;
    if (inFlight !== null) return inFlight;

    // 先让在途执行收尾，否则通道一关它的输出队列就永远不会结束
    this.#finishExecution?.(new Error('内核已重启，本次执行被中止'));
    this.#finishExecution = null;
    this.#executing = false;
    this.#executionToken = null;

    this.#restartInProgress = true;
    const task = (async (): Promise<void> => {
      await this.#teardown();
      await this.#spawn();
    })().finally(() => {
      this.#restarting = null;
      this.#restartInProgress = false;
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
   * 中断执行。返回实际发生了什么。
   *
   * 两条递送路径，都试：
   *
   * - **中断事件**（注入的 `interrupter`）：Windows 上唯一真正有效的机制。
   *   ipykernel 的 `_send_interrupt_children()` 对 `os.name == "nt"` 直接放弃，
   *   所以控制通道的 `interrupt_request` 在 Windows 上是空操作；真正起作用的是
   *   经 `JPY_INTERRUPT_EVENT` 传入的 Event 句柄。实测触发后约 1.6 秒内产生
   *   KeyboardInterrupt，且**内存状态完整保留**。
   * - **`interrupt_request`**：POSIX 上有效（内核跑在 WSL2 后端里也走这条）。
   *
   * 两条都不奏效时才重启，并如实报告状态已丢失。绝不假装中断成功——那会让
   * 用户以为变量还在。
   */
  async interrupt(graceMs = 3000): Promise<'idle' | 'interrupted' | 'restarted'> {
    if (this.#closed) return 'idle';

    // 记下要中断的是哪一次执行；后文全程按它判断，不看全局的 #executing
    const target = this.#executionToken;
    if (target === null) return 'idle';

    const delivered = this.#interrupter?.signal() ?? false;
    if (!delivered && this.#interrupter !== null) {
      this.#onLog('中断事件递送失败，回落到 interrupt_request');
    }

    // 即便事件已递送也发一次消息：跨平台一致，且对 POSIX 内核是主路径
    try {
      await this.#requireChannels().request('control', 'interrupt_request', {}, 5000);
    } catch (err) {
      this.#onLog(
        `interrupt_request 未获回复：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 轮询等那次执行真正结束。判据是它的标识不再是当前标识——即便用户紧接着
    // 发起了新的执行，原来那次已经停下就算中断成功。
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (this.#executionToken !== target) return 'interrupted';
      await new Promise((r) => setTimeout(r, 100));
    }

    this.#onLog(
      this.#interrupter === null
        ? '中断未生效且未注入中断事件机制，改为重启内核；内存状态将丢失'
        : '中断在宽限期内未生效，改为重启内核；内存状态将丢失',
    );

    /*
     * 已有重启在途时等它而不是再发起一次。
     *
     * 这条路径真实存在：重启过程中的初始化代码超时会触发中断，中断不生效就要重启
     * ——而那时 restart() 会拒绝（防自递归死锁）。等在途的那次是正确处理：它同样
     * 会清空状态，所以报 'restarted' 是准确的，不是敷衍。
     */
    if (this.#restartInProgress) {
      await this.ready().catch(() => undefined);
      return 'restarted';
    }

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
    // 中断事件的生命周期归本内核，见 KernelOptions.interrupter 的说明
    this.#interrupter?.close();
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
    const token = Symbol('execution');
    if (!internal) {
      this.#executing = true;
      this.#executionToken = token;
    }

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
        // 只在仍是自己这次执行时清空，避免抹掉后继执行的标识
        if (this.#executionToken === token) this.#executionToken = null;
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

          /*
           * internal 执行不走中断，直接收尾。
           *
           * 这是个踩出来的死结：internal 执行刻意不占用户执行槽位，因此既不设
           * `#executionToken` 也不设 `#finishExecution`。于是 `interrupt()` 在
           * 第一行就因为 `#executionToken === null` 返回 'idle' 什么都不做，
           * 而 `restart()` 想强制收尾也找不到 `#finishExecution`——两条收尾路径
           * 同时失效，输出队列永远不结束。
           *
           * 后果是 `#runInit` 永久挂死，进而 `#spawn` 挂死、`pool.acquire` 挂死。
           * 症状是「点重启内核之后再也没有回来」，或者新会话第一次执行代码时
           * 永久转圈，而日志里只有一行「执行超过 20000ms，发起中断」。
           * 初始化代码超时并不影响内核可用，如实收尾即可。
           */
          if (internal) {
            finish(new Error(`初始化代码执行超过 ${String(timeoutMs)}ms，已放弃`));
            return;
          }

          // interrupt() 自己负责「中断不生效就重启」，而重启会强制收尾在途执行。
          // 但它也可能报 'idle'（那次执行已经不是当前执行了），此时必须自己收尾，
          // 否则同样会挂住
          void this.interrupt()
            .then((outcome) => {
              if (outcome === 'idle') {
                finish(new Error(`执行超过 ${String(timeoutMs)}ms 且已无法中断`));
              }
            })
            .catch((err: unknown) => {
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
