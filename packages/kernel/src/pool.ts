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
  type PythonEnv,
  type REnv,
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
  /**
   * 追加到启动规格之后的初始化代码。
   *
   * 控制面 REPL 用它把 `host` 对象导入全局命名空间。做成池级选项而不是按 key 传参
   * 是刻意的：控制面用**独立的池实例**，于是「哪些内核有控制面权限」由池的边界
   * 决定而不是由一处条件判断决定——后者漏一个分支就等于把特权 token 注入了
   * 普通分析内核。
   */
  extraInitCode?: () => readonly string[];
  /**
   * 覆盖用哪个解释器启动内核（任务 14.4，需求 15.2）。
   *
   * 需求 15.2 要求「注册用户既有的 venv，使内核**直接从该 venv 启动**且代码编辑可持久
   * 生效」。「直接启动」是关键：任何把环境复制一份到平台目录下的做法都会让
   * `pip install -e` 装出来的可编辑包与用户直接改的源码不再生效，而那个失败的表现是
   * 「我改了代码但跑的还是旧的」——最难查的一类。
   *
   * 每次启动现取而不是构造时取一次：用户可以在运行中把默认环境切到另一个 venv，
   * 而缓存下来的那个会让新内核仍然起在旧环境上，且看不出为什么。
   *
   * 返回 null 表示用探测到的托管环境。
   */
  pythonEnv?: () => PythonEnv | null;
  /** 同上，R 侧（需求 15.7 的独立 R 环境仍然可以被换掉）。 */
  rEnv?: () => REnv | null;
}

interface Entry {
  kernel: JupyterKernel;
  lastUsedAt: number;
  /** 启动时用的环境目录。见 PoolEntryInfo.envPrefix 的说明。 */
  envPrefix: string;
}

export interface PoolEntryInfo {
  conversationId: string;
  language: KernelLanguage;
  pid: number | null;
  busy: boolean;
  idleMs: number;
  /**
   * 这个内核是从哪个环境起来的（任务 14.4，需求 15.5）。
   *
   * 记下来而不是事后按「当前默认环境」推断：用户切换默认环境之后，已经跑着的内核仍然
   * 在旧环境上。按当前默认推断会把它们算到新环境头上，于是「在新环境里装包要不要
   * 重启」这个问题的答案是错的——而错的方向是说「要重启」然后清掉一批本来不受影响的
   * 内核的内存状态。
   */
  envPrefix: string;
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
      .then(({ kernel, envPrefix }) => {
        this.#entries.set(key, { kernel, lastUsedAt: Date.now(), envPrefix });
        return kernel;
      })
      .finally(() => {
        this.#starting.delete(key);
      });

    this.#starting.set(key, startup);
    return startup;
  }

  async #start(
    conversationId: string,
    language: KernelLanguage,
  ): Promise<{ kernel: JupyterKernel; envPrefix: string }> {
    const a = this.available();
    const runtimeDir = join(this.#opts.runtimeDir, conversationId);
    const cwd = join(this.#opts.workspaceRoot, conversationId);

    const interrupter = this.#opts.interrupterFactory?.() ?? null;

    if (language === 'python') {
      /*
       * 覆盖优先于探测（需求 15.2）。
       *
       * 用户把默认环境切到自己的 venv 之后，新内核必须起在那个 venv 上——否则
       * 「切换默认环境」这个动作在界面上生效了而实际没有，而两者的区别只在
       * `sys.executable` 里看得出来。
       */
      const python = this.#opts.pythonEnv?.() ?? a.python;
      if (python === null) {
        throw new Error(
          `Python 内核环境不可用。需先创建托管环境：conda create -n lsci python=3.13 并安装 ipykernel`,
        );
      }
      const spec = pythonLaunchSpec(python);
      const extraInit = this.#opts.extraInitCode?.() ?? [];
      const kernel = await JupyterKernel.start({
        // 每次启动都重新取额外环境变量：出口代理的端口在启动时才确定，
        // 取快照会让先起来的内核拿到一个空的代理地址而静默绕过管控
        spec: {
          ...spec,
          env: { ...spec.env, ...(this.#opts.extraEnv?.() ?? {}) },
          initCode: [...spec.initCode, ...extraInit],
        },
        runtimeDir,
        cwd,
        onLog: this.#onLog,
        ...(interrupter === null ? {} : { interrupter }),
      });
      return { kernel, envPrefix: python.prefix };
    }

    const rEnv = this.#opts.rEnv?.() ?? a.r;
    if (rEnv === null) {
      throw new Error(
        `R 内核环境不可用。需先创建托管环境：conda create -n lsci-r -c conda-forge r-base r-irkernel`,
      );
    }
    // 启动器写在该会话的运行目录下，不依赖源码布局。
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runtimeDir, { recursive: true });
    const launcher = writeIRkernelLauncher(runtimeDir);

    const rSpec = rLaunchSpec(rEnv, launcher);
    const kernel = await JupyterKernel.start({
      spec: { ...rSpec, env: { ...rSpec.env, ...(this.#opts.extraEnv?.() ?? {}) } },
      runtimeDir,
      cwd,
      onLog: this.#onLog,
      ...(interrupter === null ? {} : { interrupter }),
    });
    return { kernel, envPrefix: rEnv.prefix };
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
        envPrefix: entry.envPrefix,
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
