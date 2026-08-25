/**
 * Windows 原生 API 绑定（经 koffi FFI）。
 *
 * 为什么需要它：有两件事没有原生调用就做不到，而它们都不是可选项。
 *
 * 1. **Job Object** —— 硬性内存限额与 `KILL_ON_JOB_CLOSE`。没有它，资源限额只能
 *    退化成轮询检查（进程在两次轮询之间可以冲到任意大小），进程树终止也只能靠
 *    `taskkill /T` 这种依赖父子关系记录的手段。
 * 2. **内核中断事件** —— ipykernel 的 `_send_interrupt_children()` 对
 *    `os.name == "nt"` 直接放弃，消息式 `interrupt_request` 在 Windows 上是空操作。
 *    jupyter_client 真正用的是 `JPY_INTERRUPT_EVENT`：把一个可继承的 Windows Event
 *    句柄经环境变量传给内核，由 ipykernel 的 ParentPollerWindows 等待。没有它，
 *    「中断」只能退化成「重启内核并丢掉全部变量」。
 *
 * 用 koffi 而不是自己写 N-API 插件：koffi 提供 prebuilt 二进制，不需要本机有
 * C/C++ 工具链，与「所有原生依赖必须 prebuilt」这条约束一致。
 *
 * 非 Windows 平台或 koffi 不可用时，全部能力优雅降级为不可用，由调用方决定
 * 如何如实告知用户，而不是在这里假装成功。
 */

export interface Win32Api {
  createJobObject(): unknown;
  setJobLimits(job: unknown, opts: { memoryBytes?: number; killOnClose: boolean }): void;
  assignProcessToJob(job: unknown, pid: number): void;
  createInheritableEvent(): { handle: unknown; handleValue: string };
  setEvent(handle: unknown): boolean;
  closeHandle(handle: unknown): void;
  lastError(): number;
}

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0000_0100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的 x64 内存布局。
 *
 * 手写偏移而不是用 koffi 的结构体声明：这个结构里有多处对齐填充
 * （`LimitFlags` 之后 4 字节、`ActiveProcessLimit` 之后 4 字节），
 * 用偏移常量写死更不容易出错，也更容易对照文档核查。
 *
 *   JOBOBJECT_BASIC_LIMIT_INFORMATION  0..64
 *     0   PerProcessUserTimeLimit  (LARGE_INTEGER, 8)
 *     8   PerJobUserTimeLimit      (8)
 *     16  LimitFlags               (DWORD, 4)  + 4 填充
 *     24  MinimumWorkingSetSize    (SIZE_T, 8)
 *     32  MaximumWorkingSetSize    (8)
 *     40  ActiveProcessLimit       (DWORD, 4)  + 4 填充
 *     48  Affinity                 (ULONG_PTR, 8)
 *     56  PriorityClass            (DWORD, 4)
 *     60  SchedulingClass          (DWORD, 4)
 *   IO_COUNTERS                        64..112  (6 × ULONGLONG)
 *     112 ProcessMemoryLimit       (SIZE_T, 8)
 *     120 JobMemoryLimit           (8)
 *     128 PeakProcessMemoryUsed    (8)
 *     136 PeakJobMemoryUsed        (8)
 */
const EXT_LIMIT_SIZE = 144;
const OFF_LIMIT_FLAGS = 16;
const OFF_PROCESS_MEMORY_LIMIT = 112;

/** SECURITY_ATTRIBUTES 的 x64 布局：nLength(4) 填充(4) 描述符指针(8) bInheritHandle(4) 填充(4) */
const SA_SIZE = 24;
const OFF_SA_LENGTH = 0;
const OFF_SA_DESCRIPTOR = 8;
const OFF_SA_INHERIT = 16;

/* ------------------------------------------------------------------ *
 * 惰性加载
 * ------------------------------------------------------------------ */

interface Kernel32Funcs {
  CreateJobObjectW: (sa: unknown, name: unknown) => unknown;
  SetInformationJobObject: (job: unknown, cls: number, info: Buffer, len: number) => boolean;
  AssignProcessToJobObject: (job: unknown, proc: unknown) => boolean;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  CloseHandle: (h: unknown) => boolean;
  GetLastError: () => number;
  CreateEventW: (sa: Buffer, manualReset: boolean, initial: boolean, name: unknown) => unknown;
  SetEvent: (h: unknown) => boolean;
}

interface Koffi {
  load(name: string): { func(signature: string): (...args: never[]) => unknown };
  address(ptr: unknown): bigint;
}

let cached: Win32Api | null | undefined;

function loadApi(): Win32Api | null {
  if (process.platform !== 'win32') return null;

  let koffi: Koffi;
  try {
    // require 而非静态 import：koffi 不可用时必须能优雅降级，
    // 静态导入会让整个模块加载失败。
    const { createRequire } = require('node:module') as typeof import('node:module');
    const req = createRequire(import.meta.url);
    koffi = req('koffi') as Koffi;
  } catch {
    return null;
  }

  let fns: Kernel32Funcs;
  try {
    const k32 = koffi.load('kernel32.dll');
    fns = {
      CreateJobObjectW: k32.func(
        'void* CreateJobObjectW(void* sa, const char16_t* name)',
      ) as Kernel32Funcs['CreateJobObjectW'],
      SetInformationJobObject: k32.func(
        'bool SetInformationJobObject(void* job, int cls, void* info, uint32_t len)',
      ) as Kernel32Funcs['SetInformationJobObject'],
      AssignProcessToJobObject: k32.func(
        'bool AssignProcessToJobObject(void* job, void* proc)',
      ) as Kernel32Funcs['AssignProcessToJobObject'],
      OpenProcess: k32.func(
        'void* OpenProcess(uint32_t access, bool inherit, uint32_t pid)',
      ) as Kernel32Funcs['OpenProcess'],
      CloseHandle: k32.func('bool CloseHandle(void* h)') as Kernel32Funcs['CloseHandle'],
      GetLastError: k32.func('uint32_t GetLastError()') as Kernel32Funcs['GetLastError'],
      CreateEventW: k32.func(
        'void* CreateEventW(void* sa, bool manualReset, bool initialState, const char16_t* name)',
      ) as Kernel32Funcs['CreateEventW'],
      SetEvent: k32.func('bool SetEvent(void* h)') as Kernel32Funcs['SetEvent'],
    };
  } catch {
    return null;
  }

  const isNull = (ptr: unknown): boolean => koffi.address(ptr) === 0n;

  return {
    lastError: () => fns.GetLastError(),

    createJobObject(): unknown {
      const job = fns.CreateJobObjectW(null, null);
      if (isNull(job)) {
        throw new Error(`CreateJobObjectW 失败，GetLastError=${String(fns.GetLastError())}`);
      }
      return job;
    },

    setJobLimits(job, opts): void {
      const info = Buffer.alloc(EXT_LIMIT_SIZE);
      let flags = 0;
      if (opts.killOnClose) flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (opts.memoryBytes !== undefined && opts.memoryBytes > 0) {
        flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.writeBigUInt64LE(BigInt(Math.floor(opts.memoryBytes)), OFF_PROCESS_MEMORY_LIMIT);
      }
      info.writeUInt32LE(flags, OFF_LIMIT_FLAGS);

      if (
        !fns.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, EXT_LIMIT_SIZE)
      ) {
        throw new Error(`SetInformationJobObject 失败，GetLastError=${String(fns.GetLastError())}`);
      }
    },

    assignProcessToJob(job, pid): void {
      const proc = fns.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
      if (isNull(proc)) {
        throw new Error(
          `OpenProcess(${String(pid)}) 失败，GetLastError=${String(fns.GetLastError())}`,
        );
      }
      const ok = fns.AssignProcessToJobObject(job, proc);
      const err = ok ? 0 : fns.GetLastError();
      fns.CloseHandle(proc);
      if (!ok) {
        throw new Error(`AssignProcessToJobObject 失败，GetLastError=${String(err)}`);
      }
    },

    /**
     * 创建可继承的自动重置事件。
     *
     * 必须可继承：句柄要经 `CreateProcess` 传给子进程才有意义。Node 的 spawn 在
     * Windows 上以 `bInheritHandles=TRUE` 创建进程（它需要这样传递 stdio），
     * 因此标记为可继承的句柄会被子进程拿到。
     */
    createInheritableEvent(): { handle: unknown; handleValue: string } {
      const sa = Buffer.alloc(SA_SIZE);
      sa.writeUInt32LE(SA_SIZE, OFF_SA_LENGTH);
      sa.writeBigUInt64LE(0n, OFF_SA_DESCRIPTOR);
      sa.writeUInt32LE(1, OFF_SA_INHERIT);

      const handle = fns.CreateEventW(sa, false, false, null);
      if (isNull(handle)) {
        throw new Error(`CreateEventW 失败，GetLastError=${String(fns.GetLastError())}`);
      }
      return { handle, handleValue: koffi.address(handle).toString() };
    },

    setEvent: (handle) => fns.SetEvent(handle),

    closeHandle(handle): void {
      fns.CloseHandle(handle);
    },
  };
}

/** 取得 Windows API 绑定；不可用时返回 null，由调用方决定如何降级。 */
export function win32(): Win32Api | null {
  if (cached === undefined) cached = loadApi();
  return cached;
}

export function win32Available(): boolean {
  return win32() !== null;
}
