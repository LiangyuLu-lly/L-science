/**
 * 数据目录的实例锁（任务 15.2，需求 20.4.2）。
 *
 * 需求 20.4.2 要的是「通过环境变量覆盖数据目录，以支持测试与多实例并行」。覆盖本身
 * 早就有了（`dataDir()`），缺的是另一半：**并行必须是安全的并行**。
 *
 * 在这之前，两个后端指向同一个数据目录时**两边都能打开成功，谁也不报错**——SQLite
 * 只配了 WAL 与 5 秒 busy_timeout，那让并发写入不至于立刻失败，但它不解决任何一处
 * 读改写。实际后果是具体的：
 *
 * - `credentials/vault.bin` 是整文件读改写。两个实例各存一个 API key，后写的那个把
 *   前一个覆盖掉，而用户看到的是「我刚配好的凭据不见了」。
 * - REST→MCP 桥的地址（临时端口）会被写进 `app.db` 的连接器行。第二个实例启动时
 *   覆盖它，于是第一个实例的连接器指向第二个实例的桥；第二个退出后，第一个的连接器
 *   全部连不上，而错误信息是「连接被拒绝」。
 * - 内置技能安装与连接器域名同步都是启动期的幂等写入，两个实例交错跑会互相踩。
 *
 * 这些都不会以「冲突」的形式出现，它们表现为几天后某个功能莫名其妙不对了。因此这里
 * 选择**明确拒绝启动**：一条说清「另一个实例正在用这个目录」的错误，比一个能启动
 * 但慢慢损坏数据的实例有用得多。
 *
 * ## 为什么不用 flock
 *
 * Windows 上没有 flock，而 Node 不提供跨平台的文件锁。`openSync(path, 'wx')` 能给出
 * 原子的「创建且必须不存在」，但它有个必然的缺口：进程崩溃后文件留着，锁不会自动
 * 释放。因此这里配一份**持有者存活检查**——记下 pid，冲突时先确认那个进程还在。
 *
 * 这套做法有一个诚实的局限：pid 会被系统复用。一个已经死掉的持有者，它的 pid 若被
 * 别的进程占用，我们会误判成「还在跑」并拒绝启动。方向上这是偏保守的一侧（多一次
 * 手动删锁 vs 两个实例同时写一个库），而 `describeLockConflict` 会把锁文件路径直接
 * 告诉用户，让他能自己确认并删掉。
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

/** 锁文件在数据目录里的相对位置。 */
const LOCK_RELATIVE = ['config', 'instance.lock'];

/** 数据目录被占用时后端的退出码。 */
export const INSTANCE_LOCK_EXIT_CODE = 78;

export interface InstanceLockInfo {
  /** 持有者进程号。 */
  pid: number;
  /** 取得锁的时刻（epoch ms）。 */
  startedAt: number;
  /** 持有者认为自己在用哪个数据目录。用于发现锁文件被整个目录复制走的情况。 */
  dataDir: string;
  hostname: string;
  /** 持有者的 Node 版本。诊断「是不是我以为的那个进程」时有用。 */
  node: string;
}

export interface InstanceLockHandle {
  /** 锁文件路径。错误信息里要带上它——用户需要能自己确认并删掉。 */
  readonly path: string;
  readonly info: InstanceLockInfo;
  /**
   * 接管的过期锁。非 null 表示上一个持有者是崩溃退出的。
   *
   * 要报出来而不是静默接管：崩溃退出意味着上次可能留下了没跑完的迁移或半个内核，
   * 而那是用户排查「上次为什么不对」时唯一的线索。
   */
  readonly tookOverStale: InstanceLockInfo | null;
  release(): void;
}

export type AcquireLockResult =
  | { ok: true; lock: InstanceLockHandle }
  | {
      ok: false;
      /** 当前持有者。锁文件损坏到读不出内容时为 null。 */
      holder: InstanceLockInfo | null;
      path: string;
      reason: string;
    };

export interface AcquireLockOptions {
  /** 数据目录。 */
  root: string;
  /** 本进程 pid。仅测试注入。 */
  pid?: number;
  /** 当前时刻。仅测试注入。 */
  now?: () => number;
  /** 判断某个 pid 是否还活着。仅测试注入。 */
  isAlive?: (pid: number) => boolean;
  /** 记日志。 */
  onLog?: (line: string) => void;
}

export function instanceLockPath(root: string): string {
  return join(root, ...LOCK_RELATIVE);
}

/**
 * 判断进程是否存活。
 *
 * `signal 0` 不发信号，只做权限与存在性检查。EPERM 要算**存活**：那表示进程在，
 * 只是属于别的用户。算成不存在会让我们抢掉一个正在运行的实例的锁。
 */
function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): InstanceLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const info = parsed as Partial<InstanceLockInfo>;
    if (typeof info.pid !== 'number') return null;
    return {
      pid: info.pid,
      startedAt: typeof info.startedAt === 'number' ? info.startedAt : 0,
      dataDir: typeof info.dataDir === 'string' ? info.dataDir : '',
      hostname: typeof info.hostname === 'string' ? info.hostname : '',
      node: typeof info.node === 'string' ? info.node : '',
    };
  } catch {
    // 读不出来的锁文件按「损坏」处理，而不是按「被占用」——一次写锁过程中断电
    // 会留下半个 JSON，而那时把目录永久锁死没有任何好处
    return null;
  }
}

/**
 * 取得数据目录的独占权。
 *
 * 成功时返回句柄，调用方**必须**在退出路径上调用 `release()`。失败时返回当前持有者，
 * 调用方应当拒绝启动——见文件头对「为什么不是警告」的说明。
 */
export function acquireInstanceLock(options: AcquireLockOptions): AcquireLockResult {
  const path = instanceLockPath(options.root);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const log = options.onLog ?? ((): void => {});

  mkdirSync(dirname(path), { recursive: true });

  const info: InstanceLockInfo = {
    pid,
    startedAt: now(),
    dataDir: options.root,
    hostname: hostname(),
    node: process.version,
  };

  let tookOverStale: InstanceLockInfo | null = null;

  /*
   * 最多两轮。
   *
   * 第一轮撞上过期锁时删掉重试；第二轮再撞上就说明有另一个进程正在同一瞬间抢锁，
   * 那时**不再重试**——继续循环会让两个进程都可能拿到锁，而那正是要防的事。
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      // 'wx' 是原子的「创建且必须不存在」。用 existsSync 先判再写会留下竞态窗口
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return {
          ok: false,
          holder: null,
          path,
          reason: `无法创建锁文件：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const holder = readLock(path);

      if (holder === null) {
        log(`锁文件内容无法解析，按过期处理：${path}`);
        try {
          unlinkSync(path);
        } catch {
          return { ok: false, holder: null, path, reason: '锁文件损坏且无法删除' };
        }
        continue;
      }

      if (holder.pid === pid) {
        // 同一个进程重复取锁：当成已持有，而不是报冲突（自己跟自己冲突没有意义）
        return {
          ok: true,
          lock: makeHandle(path, holder, tookOverStale, pid),
        };
      }

      if (isAlive(holder.pid)) {
        return {
          ok: false,
          holder,
          path,
          reason: `进程 ${String(holder.pid)} 正在使用这个数据目录`,
        };
      }

      log(`上一个持有者（pid ${String(holder.pid)}）已不存在，接管过期锁`);
      tookOverStale = holder;
      try {
        unlinkSync(path);
      } catch {
        return { ok: false, holder, path, reason: '过期锁无法删除' };
      }
      continue;
    }

    try {
      writeSync(fd, JSON.stringify(info, null, 2));
    } finally {
      closeSync(fd);
    }
    return { ok: true, lock: makeHandle(path, info, tookOverStale, pid) };
  }

  return {
    ok: false,
    holder: readLock(path),
    path,
    reason: '锁被另一个正在启动的实例抢先取得',
  };
}

function makeHandle(
  path: string,
  info: InstanceLockInfo,
  tookOverStale: InstanceLockInfo | null,
  ownPid: number,
): InstanceLockHandle {
  let released = false;
  return {
    path,
    info,
    tookOverStale,
    release(): void {
      if (released) return;
      released = true;
      /*
       * 只删自己的锁。
       *
       * 不核对 pid 就删的话，一个「已经被别人接管」的场景里我们会删掉新持有者的锁
       * ——那之后第三个实例就能进来，于是同时有两个实例在写同一个库。这个分支听起来
       * 很远，但退出路径上的清理恰好是最容易在异常情况下被执行两次的代码。
       */
      const current = readLock(path);
      if (current !== null && current.pid !== ownPid) return;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // 删不掉不是致命问题：下一次启动会发现 pid 已死并接管
      }
    },
  };
}

/**
 * 冲突时给用户看的说明。
 *
 * 三件事必须都在：**是谁**占着（pid）、**锁文件在哪**（这样他能自己确认并删掉）、
 * **怎么并行**（多实例是被支持的用法，只是要各用一个数据目录）。少了最后一条，
 * 用户会以为平台不支持同时开两个。
 */
export function describeLockConflict(result: Extract<AcquireLockResult, { ok: false }>): string {
  const who =
    result.holder === null
      ? '另一个实例'
      : `进程 ${String(result.holder.pid)}（启动于 ${new Date(result.holder.startedAt).toLocaleString()}）`;

  return [
    `数据目录已被占用：${who}正在使用它。`,
    '',
    '同一个数据目录只能有一个实例：里面的凭据库与连接器配置是整文件读改写，',
    '两个实例同时写会让后写的覆盖前一个，而那不会报错，只会在几天后表现为',
    '「我配好的东西不见了」。',
    '',
    '要同时开两个实例，给其中一个换一个数据目录：',
    '  $env:L_SCIENCE_DATA_DIR = "D:\\lsci-second"',
    '',
    `锁文件：${result.path}`,
    '如果确认没有别的实例在跑（比如上次是强制结束进程），删掉这个文件即可。',
  ].join('\n');
}
