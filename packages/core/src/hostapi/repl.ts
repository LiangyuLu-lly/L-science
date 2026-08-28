/**
 * 控制面 REPL（任务 12.7，需求 10.8）。
 *
 * 一个专用的 Python 内核，注入了 `host` 对象。它与普通 `python` 工具的内核是两回事：
 *
 * - 普通内核跑**分析代码**，可以有很多个（每会话一个、每子 agent 一个）。
 * - 控制面内核跑**编排代码**，全项目**只有一个**（需求 10.8 的单例约束）。
 *
 * ## 为什么要单例
 *
 * 控制面代码持有状态：派出去的子 agent 句柄、正在汇总的中间结果、注册的回调。
 * 多个控制面内核意味着这些状态各存一份，而「我刚派出去的那个 agent 在哪个内核里」
 * 没有答案。
 *
 * ## 为什么必须有旁路内核
 *
 * 单例加排队会死锁：控制面代码 A 调 `host.agents.delegate` 派出子 agent，
 * 子 agent 想用控制面 REPL → 排在 A 后面 → A 正等着子 agent → 双方永远等下去。
 *
 * 因此提供**临时旁路内核**：不共享状态、用完即弃。语义上它是「一次性沙盒」而不是
 * 「另一个控制面」——共享状态的旁路会把单例约束的意义抹掉，而复用旁路内核会让它
 * 慢慢积累出状态，变成一个谁都说不清归属的第二控制面。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JupyterKernel, KernelPool, KernelOutput } from '@l-science/kernel';

import { collectExecution, formatExecution } from '../tools/kernel-tools.js';
import type { ToolResult } from '../tools/types.js';
import type { HostRpcServer } from './server.js';
import { buildHostShim, hostInitCode, type ShimPending, type ShimSurface } from './shim.js';

export interface ControlReplOptions {
  pool: KernelPool;
  server: HostRpcServer;
  surfaces: readonly ShimSurface[];
  pending: readonly ShimPending[];
  /** 写 shim 的目录。会被加进内核的 PYTHONPATH。 */
  shimDir: string;
  /** 单例内核的取用键。全项目一个。 */
  singletonKey?: string;
  onLog?: (line: string) => void;
}

export type ReplMode = 'singleton' | 'bypass';

export interface ReplRunResult extends ToolResult {
  mode: ReplMode;
  /** 用旁路内核时说明原因，供输出里如实告知。 */
  bypassReason: string | null;
}

const DEFAULT_SINGLETON_KEY = 'control-plane';

/** 设置会话上下文那一行的超时。它只是一次赋值，慢到这个程度说明内核已经不对了。 */
const CONTEXT_TIMEOUT_MS = 15_000;

export class ControlRepl {
  readonly #opts: ControlReplOptions;
  readonly #singletonKey: string;
  readonly #onLog: (line: string) => void;

  /** 单例内核是否正在执行。排队会死锁，因此这里只用来决定是否走旁路。 */
  #busy = false;
  #bypassCounter = 0;
  #shimWritten = false;

  constructor(options: ControlReplOptions) {
    this.#opts = options;
    this.#singletonKey = options.singletonKey ?? DEFAULT_SINGLETON_KEY;
    this.#onLog = options.onLog ?? ((): void => {});
  }

  get busy(): boolean {
    return this.#busy;
  }

  get singletonKey(): string {
    return this.#singletonKey;
  }

  /**
   * 写出 Python shim。
   *
   * 每次进程启动写一次而不是每次执行都写：内容只由已注册的方法决定，
   * 而那在进程生命周期内不变。
   */
  #ensureShim(): void {
    if (this.#shimWritten) return;
    mkdirSync(this.#opts.shimDir, { recursive: true });
    writeFileSync(
      join(this.#opts.shimDir, 'lsci_host.py'),
      buildHostShim({ surfaces: this.#opts.surfaces, pending: this.#opts.pending }),
      'utf8',
    );
    this.#shimWritten = true;
  }

  /** 注入内核的环境变量：控制面地址、token 与 shim 目录。 */
  env(): Record<string, string> {
    return {
      ...this.#opts.server.env(),
      L_SCIENCE_HOST_SHIM_DIR: this.#opts.shimDir,
      // 让 import lsci_host 在初始化代码之外也能用
      PYTHONPATH: this.#opts.shimDir,
    };
  }

  /**
   * 执行控制面代码。
   *
   * `mode`：
   * - `auto`（默认）：单例空闲时用它，忙时自动走旁路并如实说明。
   * - `singleton`：必须用单例。忙时**快速失败**而不是排队——排队正是死锁的来源。
   * - `bypass`：总是用一次性内核。
   */
  async run(input: {
    code: string;
    /** 本次执行归属的会话。host 调用按它归属子 agent、findings、计划。 */
    conversationId: string;
    mode?: 'auto' | ReplMode;
    timeoutMs?: number;
  }): Promise<ReplRunResult> {
    this.#ensureShim();

    const requested = input.mode ?? 'auto';

    if (requested === 'singleton' && this.#busy) {
      return {
        ok: false,
        mode: 'singleton',
        bypassReason: null,
        output: {
          kind: 'error',
          ename: 'ControlPlaneBusy',
          evalue:
            '控制面 REPL 正在执行别的代码。这里刻意不排队——排队会死锁：' +
            '正在跑的那段可能在等你这一段的结果。' +
            '需要立刻执行请用 mode="bypass"（一次性内核，不共享状态），' +
            '或者等当前执行结束。',
          traceback: [],
        },
      };
    }

    if (requested === 'bypass') {
      return this.#runBypass(input, '按请求使用一次性内核，状态不保留');
    }
    if (this.#busy) {
      // auto 模式下单例忙就自动走旁路。这是防死锁的关键：正在跑的那段可能正等着
      // 本次调用的结果，排队等于双方永远等下去
      return this.#runBypass(
        input,
        '控制面单例内核正忙，已自动改用一次性内核（状态不共享、不保留）',
      );
    }
    return this.#runSingleton(input);
  }

  /**
   * 告诉内核本次执行归属哪个会话。
   *
   * 单独执行一次而不是拼在用户代码前面：拼接会让 traceback 的行号整体偏移，
   * 而控制面代码出错时行号是唯一有用的定位信息。
   *
   * 也不放在启动环境变量里：单例内核跨会话复用，启动那一刻的会话 id 到下一个
   * 会话就是错的。
   */
  async #setContext(kernel: JupyterKernel, conversationId: string): Promise<void> {
    const code = [
      'import os as _lsci_os',
      `_lsci_os.environ["L_SCIENCE_HOST_CONVERSATION"] = ${JSON.stringify(conversationId)}`,
      'del _lsci_os',
    ].join('\n');
    await collectExecution(
      kernel.execute(code, { timeoutMs: CONTEXT_TIMEOUT_MS }) as AsyncIterable<KernelOutput>,
    );
  }

  async #runSingleton(input: {
    code: string;
    conversationId: string;
    timeoutMs?: number;
  }): Promise<ReplRunResult> {
    this.#busy = true;
    try {
      const kernel = await this.#opts.pool.acquire(this.#singletonKey, 'python');
      await this.#setContext(kernel, input.conversationId);
      const outputs = kernel.execute(
        input.code,
        input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
      );
      const collected = await collectExecution(outputs as AsyncIterable<KernelOutput>);
      return { ...formatExecution(collected), mode: 'singleton', bypassReason: null };
    } finally {
      // 无论成败都要放开。不放开会让控制面永久「忙」，之后所有调用都被推去旁路
      this.#busy = false;
    }
  }

  /**
   * 一次性旁路内核。
   *
   * 用完立刻关掉。**不复用**：复用会让它慢慢积累出状态，变成一个谁都说不清归属的
   * 第二控制面，而单例约束的意义就在于「控制面状态只有一份」。
   */
  async #runBypass(
    input: { code: string; conversationId: string; timeoutMs?: number },
    reason: string,
  ): Promise<ReplRunResult> {
    this.#bypassCounter += 1;
    const key = `${this.#singletonKey}-bypass-${String(this.#bypassCounter)}`;

    try {
      const kernel = await this.#opts.pool.acquire(key, 'python');
      await this.#setContext(kernel, input.conversationId);
      const outputs = kernel.execute(
        input.code,
        input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
      );
      const collected = await collectExecution(outputs as AsyncIterable<KernelOutput>);
      return { ...formatExecution(collected), mode: 'bypass', bypassReason: reason };
    } finally {
      // 关掉失败不影响结果，但要记下来：泄漏的内核会一直占几百 MB
      await this.#opts.pool.shutdown(key, 'python').catch((err: unknown) => {
        this.#onLog(
          `旁路内核 ${key} 关闭失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /** 重启单例内核，清掉它的全部状态。 */
  async restart(): Promise<boolean> {
    if (this.#busy) {
      throw new Error('控制面正在执行，不能重启。先等它结束或中断它。');
    }
    return this.#opts.pool.restart(this.#singletonKey, 'python');
  }

  /** 中断单例内核里正在跑的代码。 */
  async interrupt(): Promise<boolean> {
    return this.#opts.pool.interrupt(this.#singletonKey, 'python');
  }

  /** 关掉单例内核。后端退出时用。 */
  async close(): Promise<void> {
    await this.#opts.pool.shutdown(this.#singletonKey, 'python').catch(() => undefined);
  }

  /** 初始化代码：把 host 放进全局命名空间。传给内核启动配置。 */
  static initCode(): readonly string[] {
    return [hostInitCode()];
  }
}
