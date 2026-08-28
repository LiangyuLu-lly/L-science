/**
 * Job Object 与内核中断事件的高层封装。
 *
 * 两者都在不可用时明确报告，而不是静默变成空操作——「以为设了限额其实没设」
 * 比「知道没有限额」危险得多。
 */

import { win32, win32Available, win32UnavailableReason, type Win32Api } from './ffi.js';

export { win32, win32Available, win32UnavailableReason, resetWin32Cache } from './ffi.js';
export type { Win32Api } from './ffi.js';

/* ------------------------------------------------------------------ *
 * Job Object
 * ------------------------------------------------------------------ */

export interface JobLimits {
  /** 单进程内存上限（MB）。省略表示不限。 */
  memoryMb?: number;
  /**
   * job 句柄关闭时是否终止组内全部进程。
   *
   * 这是「退出不留孤儿」的硬保证：即便控制平面被强杀，操作系统也会在句柄
   * 随进程销毁时清掉整组。比 `taskkill /T` 可靠得多——后者依赖父子关系记录，
   * 进程主动脱离父级就杀不到。
   */
  killOnClose?: boolean;
}

/**
 * Windows Job Object。
 *
 * 把子进程加入 job 后，限额由内核强制执行；超限的进程会被系统直接终止，
 * 不存在「轮询间隙」。
 */
export class JobObject {
  readonly #api: Win32Api;
  #handle: unknown;
  #closed = false;
  readonly #assigned = new Set<number>();

  private constructor(api: Win32Api, handle: unknown) {
    this.#api = api;
    this.#handle = handle;
  }

  /** 创建 job。平台不支持或 FFI 不可用时返回 null。 */
  static create(limits: JobLimits): JobObject | null {
    const api = win32();
    if (api === null) return null;

    const handle = api.createJobObject();
    const job = new JobObject(api, handle);
    try {
      api.setJobLimits(handle, {
        ...(limits.memoryMb === undefined ? {} : { memoryBytes: limits.memoryMb * 1024 * 1024 }),
        killOnClose: limits.killOnClose ?? true,
      });
    } catch (err) {
      job.close();
      throw err;
    }
    return job;
  }

  get assignedCount(): number {
    return this.#assigned.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * 把进程加入 job。
   *
   * 应当在进程启动后尽快调用：从 spawn 到 assign 之间的窗口里，进程不受限额约束。
   * 窗口无法完全消除（Windows 上需要先有 pid），但可以很短。
   */
  assign(pid: number): void {
    if (this.#closed) throw new Error('Job 已关闭');
    this.#api.assignProcessToJob(this.#handle, pid);
    this.#assigned.add(pid);
  }

  /** 尝试加入，失败只返回 false。用于进程可能已退出的场景。 */
  tryAssign(pid: number): boolean {
    try {
      this.assign(pid);
      return true;
    } catch {
      return false;
    }
  }

  /** 关闭 job。若设了 killOnClose，组内进程随之被系统终止。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#api.closeHandle(this.#handle);
    this.#handle = null;
    this.#assigned.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 内核中断事件
 * ------------------------------------------------------------------ */

/**
 * Jupyter 内核的 Windows 中断事件。
 *
 * 解决的问题：ipykernel 的 `_send_interrupt_children()` 里写着
 * `if os.name == "nt": self.log.error("Interrupt message not supported on Windows")`
 * ——控制通道的 `interrupt_request` 在 Windows 上是空操作。真正的机制是把一个
 * 可继承的 Event 句柄经 `JPY_INTERRUPT_EVENT` 环境变量传给内核，ipykernel 的
 * ParentPollerWindows 会在后台线程等待它，触发时在主线程抛 KeyboardInterrupt。
 *
 * 实测：`SetEvent` 后约 1.6 秒内产生真实的 KeyboardInterrupt，而不是让 cell
 * 跑满 30 秒。没有它，「中断」只能退化成「重启内核并丢掉全部变量」。
 */
export class InterruptEvent {
  readonly #api: Win32Api;
  #handle: unknown;
  readonly handleValue: string;
  #closed = false;

  private constructor(api: Win32Api, handle: unknown, handleValue: string) {
    this.#api = api;
    this.#handle = handle;
    this.handleValue = handleValue;
  }

  /** 创建事件。平台不支持或 FFI 不可用时返回 null。 */
  static create(): InterruptEvent | null {
    const api = win32();
    if (api === null) return null;
    const { handle, handleValue } = api.createInheritableEvent();
    return new InterruptEvent(api, handle, handleValue);
  }

  /** 传给内核进程的环境变量。ipykernel 按这个名字读取。 */
  get env(): Record<string, string> {
    return { JPY_INTERRUPT_EVENT: this.handleValue };
  }

  /** 触发中断。返回是否成功递送。 */
  signal(): boolean {
    if (this.#closed) return false;
    return this.#api.setEvent(this.#handle);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#api.closeHandle(this.#handle);
    this.#handle = null;
  }
}

/** 汇总当前平台的原生能力，供 doctor 与 UI 的隔离徽章使用。 */
export interface NativeCapabilities {
  ffi: boolean;
  jobObject: boolean;
  kernelInterrupt: boolean;
  notes: string[];
}

export function nativeCapabilities(): NativeCapabilities {
  const available = win32Available();
  const notes: string[] = [];

  if (process.platform !== 'win32') {
    notes.push('非 Windows 平台：资源限额应改用 cgroups/ulimit，内核中断走 POSIX 信号');
  } else if (!available) {
    notes.push(
      '原生 API 不可用：资源限额退化为轮询检查（存在超限窗口），' +
        '内核中断退化为重启（丢失内存状态）',
    );
    // 把具体原因带上。只说「不可用」时用户唯一能做的就是猜
    notes.push(win32UnavailableReason() ?? '原因未知');
  }

  return {
    ffi: available,
    jobObject: available,
    kernelInterrupt: available,
    notes,
  };
}
