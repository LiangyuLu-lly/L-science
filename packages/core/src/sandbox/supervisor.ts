/**
 * 子进程监管：资源限额、墙钟上限、进程树终止。
 *
 * 首选 Windows Job Object（经 koffi FFI）：内存限额由**内核强制执行**，超限进程
 * 被系统直接终止，不存在轮询间隙；`KILL_ON_JOB_CLOSE` 让「退出不留孤儿」成为
 * 操作系统级保证，即便控制平面被强杀也成立。
 *
 * Job Object 不可用时（非 Windows、或 FFI 加载失败）退化为轮询检查 + `taskkill /T`，
 * 并在 `SupervisedResult.enforcement` 里如实标注。差距必须说清楚：
 *
 * - 轮询检查有间隙，进程可以在两次轮询之间冲到任意大小
 * - `taskkill /T` 依赖父子关系记录，进程主动脱离父级就杀不到
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';

import { JobObject } from '../win32/index.js';

const MEMORY_POLL_INTERVAL_MS = 3000;

export type LimitEnforcement =
  /** Job Object：内核强制，无间隙 */
  | 'kernel'
  /** 轮询 + 进程树终止：尽力而为 */
  | 'polling'
  /** 只有墙钟上限 */
  | 'wall-clock-only';

export interface SupervisedSpawn {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
}

export interface SupervisedResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  killedForMemory: boolean;
  durationMs: number;
  enforcement: LimitEnforcement;
}

/**
 * 终止整棵进程树。
 *
 * 只 kill 直接子进程不够：PowerShell 或 python 拉起来的孙子进程会变成孤儿继续跑。
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        // 进程可能已自行退出，taskkill 的失败无需处理
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
}

/** 读取进程工作集（MB）。仅在 Job Object 不可用时作为兜底使用。 */
async function readMemoryMb(pid: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        const match = /"([\d,]+) K"\s*$/.exec(stdout.trim());
        if (match === null) {
          resolve(null);
          return;
        }
        const kb = Number((match[1] ?? '').replace(/,/g, ''));
        resolve(Number.isFinite(kb) ? Math.round(kb / 1024) : null);
      },
    );
  });
}

class BoundedBuffer {
  #chunks: string[] = [];
  #bytes = 0;
  #truncated = false;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  push(text: string): void {
    if (this.#truncated) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (this.#bytes + size > this.#limit) {
      const remaining = this.#limit - this.#bytes;
      if (remaining > 0) this.#chunks.push(text.slice(0, remaining));
      this.#truncated = true;
      return;
    }
    this.#chunks.push(text);
    this.#bytes += size;
  }

  toString(): string {
    const text = this.#chunks.join('');
    return this.#truncated ? `${text}\n[输出超过上限，已截断]` : text;
  }
}

export async function runSupervised(spec: SupervisedSpawn): Promise<SupervisedResult> {
  const startedAt = Date.now();
  const maxOutput = spec.maxOutputBytes ?? 1024 * 1024;

  // 先建 job：从 spawn 到 assign 之间的窗口越短越好
  const job =
    spec.memoryMb === undefined
      ? JobObject.create({ killOnClose: true })
      : JobObject.create({ memoryMb: spec.memoryMb, killOnClose: true });

  const child: ChildProcess = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env === undefined ? process.env : { ...process.env, ...spec.env },
    windowsHide: true,
    // POSIX 上建独立进程组才能整组终止；Windows 上由 Job Object 兜住
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  let enforcement: LimitEnforcement = 'wall-clock-only';
  if (job !== null && pid !== undefined && job.tryAssign(pid)) {
    enforcement = 'kernel';
  } else if (spec.memoryMb !== undefined) {
    enforcement = 'polling';
  }

  const stdout = new BoundedBuffer(maxOutput);
  const stderr = new BoundedBuffer(maxOutput);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => stdout.push(c));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => stderr.push(c));

  let timedOut = false;
  let killedForMemory = false;

  const timer =
    spec.timeoutMs === undefined || spec.timeoutMs <= 0
      ? null
      : setTimeout(() => {
          timedOut = true;
          if (pid !== undefined) void killTree(pid);
        }, spec.timeoutMs);

  // 只有在 Job Object 没接上时才需要轮询兜底
  const poller =
    enforcement !== 'polling' || pid === undefined
      ? null
      : setInterval(() => {
          void readMemoryMb(pid).then((mb) => {
            if (mb !== null && mb > (spec.memoryMb ?? Number.POSITIVE_INFINITY)) {
              killedForMemory = true;
              void killTree(pid);
            }
          });
        }, MEMORY_POLL_INTERVAL_MS);

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  if (timer !== null) clearTimeout(timer);
  if (poller !== null) clearInterval(poller);

  if (pid !== undefined && (timedOut || killedForMemory)) {
    await killTree(pid);
  }
  // 关掉 job：killOnClose 会带走组内残余进程
  job?.close();

  // Job Object 因超限终止进程时退出码是非零，但无法从退出码本身区分原因。
  // 这里只在轮询路径上断言 killedForMemory，避免给出错误归因。
  return {
    exitCode: exit.code,
    signal: exit.signal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    truncated: stdout.truncated || stderr.truncated,
    timedOut,
    killedForMemory,
    durationMs: Date.now() - startedAt,
    enforcement,
  };
}
