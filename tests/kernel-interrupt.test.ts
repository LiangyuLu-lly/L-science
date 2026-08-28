/**
 * 内核中断的真实性验证。
 *
 * 这是 FFI 带来的关键能力：ipykernel 的 `_send_interrupt_children()` 对
 * `os.name == "nt"` 直接放弃，所以控制通道的 `interrupt_request` 在 Windows 上
 * 是空操作。真正的机制是把一个可继承的 Event 句柄经 `JPY_INTERRUPT_EVENT` 传给
 * 内核，由 ipykernel 的 ParentPollerWindows 等待。
 *
 * 两者的差别不是性能，而是语义：
 *  - 有中断事件：中断生效，**内存状态完整保留**
 *  - 没有：只能重启内核，用户的变量全丢
 *
 * 因此这里断言的核心是「中断后变量还在」。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InterruptEvent, win32Available } from '@l-science/core';
import {
  JupyterKernel,
  KernelPool,
  detectKernels,
  pythonLaunchSpec,
  type KernelOutput,
} from '@l-science/kernel';

const available = detectKernels();
const canRun = available.python !== null && win32Available();

/*
 * 单个用例的预算。
 *
 * 按最坏合法情况算：Python 内核冷启动预算本身是 30s，而「退化为重启」这条路径
 * 要启一次再重启一次，加上 3s 宽限期就已经占掉 ~65s。留 90s 意味着三次执行只有
 * 二十来秒余量——冷缓存且多个测试文件并行抢 CPU 时就会超时（实测撞过一次）。
 *
 * 放宽预算不会让断言变松：这些用例对速度的要求是用显式的
 * `expect(elapsed).toBeLessThan(...)` 表达的，那才是「中断没有等满 30 秒」这条
 * 性质的守卫。用例总时限只负责在真卡死时把测试停下来。
 */
const SLOW = 150_000;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-int-'));
});

afterAll(() => {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      /* 内核进程的 cwd 在这个目录下，等它消失 */
    }
  }
});

function stdoutOf(outputs: readonly KernelOutput[]): string {
  return outputs
    .filter((o): o is Extract<KernelOutput, { type: 'stream' }> => o.type === 'stream')
    .filter((o) => o.name === 'stdout')
    .map((o) => o.text)
    .join('')
    .trim();
}

function errorOf(outputs: readonly KernelOutput[]): string | null {
  const e = outputs.find((o): o is Extract<KernelOutput, { type: 'error' }> => o.type === 'error');
  return e === undefined ? null : `${e.ename}: ${e.evalue}`;
}

describe.skipIf(!canRun)('注入中断事件后的内核中断', () => {
  let kernel: JupyterKernel;

  beforeAll(async () => {
    const interrupter = InterruptEvent.create();
    expect(interrupter).not.toBeNull();

    kernel = await JupyterKernel.start({
      spec: pythonLaunchSpec(available.python!),
      runtimeDir: join(root, 'rt'),
      cwd: join(root, 'ws'),
      interrupter: interrupter!,
    });
  }, SLOW);

  afterAll(async () => {
    await kernel.shutdown();
  }, SLOW);

  it(
    '中断真正生效，且内存状态完整保留',
    async () => {
      // 先建立状态，中断后要验证它还在
      await kernel.executeToCompletion('preserved = "still-here"\nimport time');

      const started = Date.now();
      const iter = kernel.execute('for _ in range(300): time.sleep(0.1)');

      // 保存 promise 并在最后 await：读回调里设的变量会在 promise 尚未 resolve 时
      // 断言到 null，那是测试写法问题而非实现问题
      let interruptPromise: Promise<string> | null = null;
      setTimeout(() => {
        interruptPromise = kernel.interrupt();
      }, 900);

      const outputs: KernelOutput[] = [];
      for await (const o of iter) outputs.push(o);

      const elapsed = Date.now() - started;
      const outcome = await interruptPromise;

      // 核心断言：走的是真中断，不是重启
      expect(outcome).toBe('interrupted');
      expect(errorOf(outputs)).toMatch(/KeyboardInterrupt/);
      // 远快于跑满 30 秒，也快于 3 秒的重启宽限期
      expect(elapsed).toBeLessThan(8000);

      // 决定性的一条：变量必须还在。这正是「真中断」相对「重启」的全部价值。
      expect(stdoutOf(await kernel.executeToCompletion('print(preserved)'))).toBe('still-here');
    },
    SLOW,
  );

  it(
    '执行超时走真中断，状态保留',
    async () => {
      await kernel.executeToCompletion('survivor = 42');

      // 用会周期性返回解释器的循环，而不是单个长阻塞调用，原因见下一条测试
      const outputs = await kernel.executeToCompletion('for _ in range(600): time.sleep(0.1)', {
        timeoutMs: 1200,
      });
      expect(errorOf(outputs)).toMatch(/KeyboardInterrupt/);

      // 超时走的是真中断而非重启，因此之前定义的变量必须还在
      expect(stdoutOf(await kernel.executeToCompletion('print(survivor)'))).toBe('42');
    },
    SLOW,
  );

  it(
    '单个长阻塞调用无法被中断，退化为重启（CPython 在 Windows 上的固有限制）',
    async () => {
      await kernel.executeToCompletion('doomed = "gone-after-restart"');

      // interrupt_main() 只设置「待处理信号」标志，由解释器在字节码之间检查。
      // 单个 time.sleep(60) 在返回之前不会检查该标志，因此这种中断无法生效——
      // 只有真正的控制台 CTRL_C 能打断它（CPython 的 sleep 等在 SIGINT 事件对象上）。
      // 平台的正确行为是：尝试中断、确认无效、退化为重启，并如实丢弃状态。
      const started = Date.now();
      try {
        await kernel.executeToCompletion('time.sleep(60)', { timeoutMs: 1200 });
      } catch {
        /* 重启路径会中止这次执行 */
      }

      // 关键：绝不能等满 60 秒
      expect(Date.now() - started).toBeLessThan(20_000);
      // 走了重启，状态确实丢了——这一点必须是真的，不能假装保留
      expect(errorOf(await kernel.executeToCompletion('print(doomed)'))).toMatch(/NameError/);
      // 内核仍可用
      expect(stdoutOf(await kernel.executeToCompletion('print("alive")'))).toBe('alive');
    },
    SLOW,
  );

  it(
    '空闲时中断是无操作',
    async () => {
      expect(await kernel.interrupt()).toBe('idle');
    },
    SLOW,
  );
});

describe.skipIf(!canRun)('内核池注入中断事件', () => {
  let pool: KernelPool;

  beforeAll(() => {
    pool = new KernelPool({
      runtimeDir: join(root, 'pool-rt'),
      workspaceRoot: join(root, 'pool-ws'),
      idleTimeoutMs: 0,
      available,
      interrupterFactory: () => InterruptEvent.create(),
    });
  });

  afterAll(async () => {
    await pool.close();
  }, SLOW);

  it(
    '经池取得的内核中断后保留状态',
    async () => {
      const kernel = await pool.acquire('conv-int', 'python');
      await kernel.executeToCompletion('import time\nkeep = "yes"');

      const iter = kernel.execute('for _ in range(200): time.sleep(0.1)');
      let interruptPromise: Promise<boolean> | null = null;
      setTimeout(() => {
        interruptPromise = pool.interrupt('conv-int', 'python');
      }, 900);

      const outputs: KernelOutput[] = [];
      for await (const o of iter) outputs.push(o);
      await interruptPromise;

      expect(errorOf(outputs)).toMatch(/KeyboardInterrupt/);
      expect(stdoutOf(await kernel.executeToCompletion('print(keep)'))).toBe('yes');
    },
    SLOW,
  );
});

describe('无中断事件时的降级', () => {
  it.skipIf(available.python === null)(
    '未注入中断事件时退化为重启并丢弃状态',
    async () => {
      const kernel = await JupyterKernel.start({
        spec: pythonLaunchSpec(available.python!),
        runtimeDir: join(root, 'nofallback-rt'),
        cwd: join(root, 'nofallback-ws'),
        // 刻意不注入 interrupter
      });
      try {
        await kernel.executeToCompletion('import time\nlost = "will-be-gone"');

        const iter = kernel.execute('for _ in range(300): time.sleep(0.1)');
        let interruptPromise: Promise<string> | null = null;
        setTimeout(() => {
          interruptPromise = kernel.interrupt();
        }, 700);

        try {
          for await (const _ of iter) void _;
        } catch {
          /* 重启路径会中止这次执行 */
        }
        const outcome = await interruptPromise;

        // 在 Windows 上必然走重启；POSIX 上 interrupt_request 有效会走真中断。
        // 两种结果都可接受，但「重启」必须伴随状态丢失。
        expect(['interrupted', 'restarted']).toContain(outcome);
        if (outcome === 'restarted') {
          expect(errorOf(await kernel.executeToCompletion('print(lost)'))).toMatch(/NameError/);
        }
      } finally {
        await kernel.shutdown();
      }
    },
    SLOW,
  );
});
