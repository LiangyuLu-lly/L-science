/**
 * 内核池。
 *
 * 按 (会话, 语言) 复用内核——这正是「变量与导入跨调用保留」这条需求的载体：
 * 同一会话的连续 cell 必须落在同一个内核进程上，不同会话之间必须互不可见。
 *
 * 每个会话有独立的工作目录，因此不同会话写同名文件不会互相覆盖。
 */

import { join } from 'node:path';

import { JupyterKernel, type KernelInterrupter } from './kernel.js';
import {
  detectKernels,
  pythonLaunchSpec,
  rLaunchSpec,
  writeIRkernelLauncher,
  type AvailableKernels,
  type KernelLanguage,
} from './launch.js';

export interface KernelPoolOptions {
  /** 连接文件与启动器脚本的根目录。 */
  runtimeDir: string;
  /** 会话工作目录的父目录。 */
  workspaceRoot: string;
  /** 空闲多久后回收。0 表示不回收。 */
  idleTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** 注入探测结果，便于测试。省略时实时探测。 */
  available?: AvailableKernels;
  /**
   * 为每个内核创建中断递送机制。
   *
   * 省略时 Windows 上的中断会退化成重启（丢失内存状态）。`@l-science/core`
   * 通过 FFI 提供 `InterruptEvent`，本包刻意不引入 FFI 依赖。
   */
  interrupterFactory?: () => KernelInterrupter | null;
  /**
   * 每次启动内核时注入的额外环境变量。
   *
   * 用函数而不是静态对象：出口代理的端口在每次启动时才确定，而代理可能在内核
   * 之后才起来。取静态快照会让先启动的内核拿到一个空的代理地址，于是它的网络
   * 请求完全绕过管控——而这件事不会有任何报错。
   */
  extraEnv?: () => Record<string, string>;
}

interface Entry {
  kernel: JupyterKernel;
  lastUsedAt: number;
}

export interface PoolEntryInfo {
  conversationId: string;
  language: KernelLanguage;
  pid: number | null;
  busy: boolean;
  idleMs: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

function keyOf(conversationId: string, language: KernelLanguage): string {
  return `${language}::${conversationId}`;
}

export class KernelPool {
  readonly #opts: KernelPoolOptions;
  readonly #idleTimeoutMs: number;
  readonly #onLog: (line: string) => void;
  readonly #entries = new Map<string, Entry>();
  /** 同一 key 的并发 acquire 必须共享一次启动，否则会起出两个内核。 */
  readonly #starting = new Map<string, Promise<JupyterKernel>>();

  #available: AvailableKernels | null;
  #sweeper: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(opts: KernelPoolOptions) {
    this.#opts = opts;
    this.#idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#onLog = opts.onLog ?? ((): void => {});
    this.#available = opts.available ?? null;

    if (this.#idleTimeoutMs > 0) {
      this.#sweeper = setInterval(() => {
        void this.#sweep();
      }, SWEEP_INTERVAL_MS);
      this.#sweeper.unref();
    }
  }

  /** 当前环境支持哪些语言。结果缓存，避免每次 acquire 都去问 conda。 */
  available(): AvailableKernels {
    this.#available ??= detectKernels();
    return this.#available;
  }

  supports(language: KernelLanguage): boolean {
    const a = this.available();
    return language === 'python' ? a.python !== null : a.r !== null;
  }

  /**
   * 取得（必要时启动）内核。
   *
   * 已死的内核会被就地替换：进程可能被外部强杀，此时缓存里的句柄已无效，
   * 直接返回会让调用方拿到一个永远不回应的内核。
   */
  async acquire(conversationId: string, language: KernelLanguage): Promise<JupyterKernel> {
    this.#assertOpen();
    const key = keyOf(conversationId, language);

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (!existing.kernel.closed && (await existing.kernel.isAlive())) {
        existing.lastUsedAt = Date.now();
        return existing.kernel;
      }
      this.#onLog(`内核已失效，重建：${key}`);
      this.#entries.delete(key);
      await existing.kernel.shutdown().catch(() => undefined);
    }

    const inFlight = this.#starting.get(key);
    if (inFlight !== undefined) return inFlight;

    const startup = this.#start(conversationId, language)
      .then((kernel) => {
        this.#entries.set(key, { kernel, lastUsedAt: Date.now() });
        return kernel;
      })
      .finally(() => {
        this.#starting.delete(key);
      });

    this.#starting.set(key, startup);
    return startup;
  }

  async #start(conversationId: string, language: KernelLanguage): Promise<JupyterKernel> {
    const a = this.available();
    const runtimeDir = join(this.#opts.runtimeDir, conversationId);
    const cwd = join(this.#opts.workspaceRoot, conversationId);

    const interrupter = this.#opts.interrupterFactory?.() ?? null;

    if (language === 'python') {
      if (a.python === null) {
        throw new Error(
          `Python 内核环境不可用。需先创建托管环境：conda create -n lsci python=3.13 并安装 ipykernel`,
        );
      }
      const spec = pythonLaunchSpec(a.python);
      return JupyterKernel.start({
        // 每次启动都重新取额外环境变量：出口代理的端口在启动时才确定，
        // 取快照会让先起来的内核拿到一个空的代理地址而静默绕过管控
        spec: { ...spec, env: { ...spec.env, ...(this.#opts.extraEnv?.() ?? {}) } },
        runtimeDir,
        cwd,
        onLog: this.#onLog,
        ...(interrupter === null ? {} : { interrupter }),
      });
    }

    if (a.r === null) {
      throw new Error(
        `R 内核环境不可用。需先创建托管环境：conda create -n lsci-r -c conda-forge r-base r-irkernel`,
      );
    }
    // 启动器写在该会话的运行目录下，不依赖源码布局。
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runtimeDir, { recursive: true });
    const launcher = writeIRkernelLauncher(runtimeDir);

    const rSpec = rLaunchSpec(a.r, launcher);
    return JupyterKernel.start({
      spec: { ...rSpec, env: { ...rSpec.env, ...(this.#opts.extraEnv?.() ?? {}) } },
      runtimeDir,
      cwd,
      onLog: this.#onLog,
      ...(interrupter === null ? {} : { interrupter }),
    });
  }

  /** 重启指定内核；不存在则视为无操作。 */
  async restart(conversationId: string, language: KernelLanguage): Promise<boolean> {
    const entry = this.#entries.get(keyOf(conversationId, language));
    if (entry === undefined) return false;
    await entry.kernel.restart();
    entry.lastUsedAt = Date.now();
    return true;
  }

  async interrupt(conversationId: string, language: KernelLanguage): Promise<boolean> {
    const entry = this.#entries.get(keyOf(conversationId, language));
    if (entry === undefined) return false;
    await entry.kernel.interrupt();
    return true;
  }

  async shutdown(conversationId: string, language: KernelLanguage): Promise<boolean> {
    const key = keyOf(conversationId, language);
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    await entry.kernel.shutdown();
    return true;
  }

  /** 关掉某个会话的全部语言内核。 */
  async shutdownConversation(conversationId: string): Promise<number> {
    let n = 0;
    for (const language of ['python', 'r'] as const) {
      if (await this.shutdown(conversationId, language)) n += 1;
    }
    return n;
  }

  list(): PoolEntryInfo[] {
    const now = Date.now();
    const out: PoolEntryInfo[] = [];
    for (const [key, entry] of this.#entries) {
      const [language, conversationId] = key.split('::') as [KernelLanguage, string];
      out.push({
        conversationId,
        language,
        pid: entry.kernel.pid,
        busy: entry.kernel.busy,
        idleMs: now - entry.lastUsedAt,
      });
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    const all = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(all.map((e) => e.kernel.shutdown().catch(() => undefined)));
  }

  /** 回收空闲内核。忙于执行的不动——否则会杀掉正在跑的长任务。 */
  async #sweep(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of [...this.#entries]) {
      if (entry.kernel.busy) continue;
      if (now - entry.lastUsedAt < this.#idleTimeoutMs) continue;
      this.#entries.delete(key);
      this.#onLog(`回收空闲内核：${key}`);
      await entry.kernel.shutdown().catch(() => undefined);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('内核池已关闭');
  }
}
