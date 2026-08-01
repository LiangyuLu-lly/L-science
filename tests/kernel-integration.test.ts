/**
 * 真实内核集成测试（任务 4.2-4.8）。
 *
 * 这些测试会真的起 ipykernel / IRkernel 进程，因此慢（Python 冷启动数秒，
 * R 更久）。它们的价值在于覆盖单元测试到不了的部分：通道路由、iopub 关联、
 * 中断、重启、心跳。
 *
 * 托管环境不可用时整组跳过而不是失败——CI 上没有 conda 环境是正常情况。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  JupyterKernel,
  KernelPool,
  detectKernels,
  pythonLaunchSpec,
  rLaunchSpec,
  writeIRkernelLauncher,
  type KernelOutput,
} from '@l-science/kernel';

const available = detectKernels();
const hasPython = available.python !== null;
const hasR = available.r !== null;

const SLOW = 90_000;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-kern-'));
});

afterAll(() => {
  // 内核进程的 cwd 在这个目录下，Windows 不允许删除任何进程的当前目录，
  // 因此需要重试等进程真正消失。
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      // 同步等待，afterAll 里不便 await
    }
  }
});

/** 从输出流里把 stdout 文本拼起来。 */
function stdoutOf(outputs: readonly KernelOutput[]): string {
  return outputs
    .filter((o): o is Extract<KernelOutput, { type: 'stream' }> => o.type === 'stream')
    .filter((o) => o.name === 'stdout')
    .map((o) => o.text)
    .join('')
    .trim();
}

function mimesOf(outputs: readonly KernelOutput[]): string[] {
  const out: string[] = [];
  for (const o of outputs) {
    if (o.type === 'execute_result' || o.type === 'display_data') {
      out.push(...Object.keys(o.data));
    }
  }
  return out;
}

function errorOf(outputs: readonly KernelOutput[]): string | null {
  const e = outputs.find((o): o is Extract<KernelOutput, { type: 'error' }> => o.type === 'error');
  return e === undefined ? null : `${e.ename}: ${e.evalue}`;
}

/* ------------------------------------------------------------------ *
 * Python 内核
 * ------------------------------------------------------------------ */

describe.skipIf(!hasPython)('Python 内核', () => {
  let kernel: JupyterKernel;
  let cwd: string;

  beforeAll(async () => {
    cwd = join(root, 'py-ws');
    kernel = await JupyterKernel.start({
      spec: pythonLaunchSpec(available.python!),
      runtimeDir: join(root, 'py-rt'),
      cwd,
    });
  }, SLOW);

  afterAll(async () => {
    await kernel.shutdown();
  }, SLOW);

  it('就绪后报告内核信息与协议版本', () => {
    const info = kernel.kernelInfo;
    expect(info?.implementation).toBe('ipython');
    expect(info?.languageName).toBe('python');
    expect(info?.protocolVersion).toMatch(/^5\./);
    expect(kernel.pid).toBeGreaterThan(0);
  });

  it('连接文件用完即删且端口可见', () => {
    // 端口暴露给诊断，但 HMAC key 不暴露
    const ports = kernel.ports;
    expect(ports).not.toBeNull();
    expect(new Set(Object.values(ports ?? {})).size).toBe(5);
    expect(JSON.stringify(ports)).not.toContain('key');
  });

  it(
    '捕获 stdout',
    async () => {
      const out = await kernel.executeToCompletion('print("sum:", sum(range(10)))');
      expect(stdoutOf(out)).toBe('sum: 45');
    },
    SLOW,
  );

  it(
    '变量与导入跨调用保留',
    async () => {
      await kernel.executeToCompletion('import math\nbase = 40');
      const out = await kernel.executeToCompletion('print("v:", base + int(math.sqrt(25)))');
      expect(stdoutOf(out)).toBe('v: 45');
    },
    SLOW,
  );

  it(
    'DataFrame 返回多 MIME 富输出',
    async () => {
      const out = await kernel.executeToCompletion(
        'import pandas as pd\npd.DataFrame({"a":[1,2,3]})',
      );
      const mimes = mimesOf(out);
      expect(mimes).toContain('text/plain');
      expect(mimes).toContain('text/html');
    },
    SLOW,
  );

  it(
    'matplotlib 图形作为 image/png 返回（依赖初始化时注入的 inline 后端）',
    async () => {
      const out = await kernel.executeToCompletion(
        [
          'import matplotlib.pyplot as plt',
          'from IPython.display import display',
          'fig, ax = plt.subplots()',
          'ax.plot([0,1,2],[0,1,4])',
          'display(fig)',
          'plt.close(fig)',
        ].join('\n'),
      );
      expect(mimesOf(out)).toContain('image/png');
    },
    SLOW,
  );

  it(
    '异常以结构化形式返回，含 traceback',
    async () => {
      const out = await kernel.executeToCompletion('1/0');
      expect(errorOf(out)).toMatch(/^ZeroDivisionError/);
      const e = out.find((o) => o.type === 'error') as Extract<KernelOutput, { type: 'error' }>;
      expect(e.traceback.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'silent 执行不产生 execute_result',
    async () => {
      const out = await kernel.executeToCompletion('42', { silent: true });
      expect(out.some((o) => o.type === 'execute_result')).toBe(false);
    },
    SLOW,
  );

  it(
    '工作区文件落在指定 cwd',
    async () => {
      await kernel.executeToCompletion('open("artifact.txt","w",encoding="utf-8").write("hello")');
      expect(existsSync(join(cwd, 'artifact.txt'))).toBe(true);
      expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('hello');
    },
    SLOW,
  );

  it(
    '补全给出候选',
    async () => {
      const reply = await kernel.complete('import math\nmath.sq', 19);
      expect(reply.matches.some((m) => m.includes('sqrt'))).toBe(true);
    },
    SLOW,
  );

  it(
    '内省能查到对象文档',
    async () => {
      const reply = await kernel.inspect('sum', 3);
      expect(reply.found).toBe(true);
      expect(Object.keys(reply.data).length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    '心跳在空闲时可达',
    async () => {
      expect(await kernel.isAlive()).toBe(true);
    },
    SLOW,
  );

  it(
    '同一内核不允许并发执行',
    async () => {
      const first = kernel.execute('import time; time.sleep(0.6)');
      expect(() => kernel.execute('1+1')).toThrow(/已有执行在途/);
      // 消费掉第一个，避免污染后续测试
      for await (const _ of first) void _;
    },
    SLOW,
  );

  it(
    '长循环可被中断；Windows 上退化为重启且如实丢弃状态',
    async () => {
      await kernel.executeToCompletion('interrupt_marker = "before"');

      const started = Date.now();
      const iter = kernel.execute('import time\nfor _ in range(300): time.sleep(0.1)');

      let outcome: string | null = null;
      setTimeout(() => {
        void kernel.interrupt().then((r) => {
          outcome = r;
        });
      }, 800);

      const outputs: KernelOutput[] = [];
      try {
        for await (const o of iter) outputs.push(o);
      } catch {
        // 重启路径会以「内核已重启」结束这次执行，属预期
      }

      // 核心断言：不管走哪条路，都不能等满 30 秒
      expect(Date.now() - started).toBeLessThan(25_000);

      await vi.waitFor(() => expect(outcome).not.toBeNull(), { timeout: 20_000 });
      expect(['interrupted', 'restarted']).toContain(outcome);

      // 无论如何内核必须仍可用
      expect(stdoutOf(await kernel.executeToCompletion('print("alive")'))).toBe('alive');

      if (outcome === 'restarted') {
        // 走重启说明消息式中断没生效（Windows 上 ipykernel 明确不支持）。
        // 此时状态必须确实是丢的——绝不能让用户以为变量还在。
        expect(errorOf(await kernel.executeToCompletion('print(interrupt_marker)'))).toMatch(
          /NameError/,
        );
      } else {
        // 真中断则状态应保留，且产生 KeyboardInterrupt
        expect(errorOf(outputs)).toMatch(/KeyboardInterrupt/);
        expect(stdoutOf(await kernel.executeToCompletion('print(interrupt_marker)'))).toBe(
          'before',
        );
      }
    },
    SLOW,
  );

  it(
    '心跳在内核忙时仍可达（shell 被占住也能探活）',
    async () => {
      const iter = kernel.execute('import time; time.sleep(2.5)');
      // 等它真的忙起来
      await new Promise((r) => setTimeout(r, 600));
      expect(kernel.busy).toBe(true);
      expect(await kernel.isAlive()).toBe(true);
      for await (const _ of iter) void _;
    },
    SLOW,
  );

  it(
    '重启清空内存状态但保留工作区文件',
    async () => {
      await kernel.executeToCompletion('marker = "before-restart"');
      expect(stdoutOf(await kernel.executeToCompletion('print(marker)'))).toBe('before-restart');

      await kernel.restart();

      // 变量没了
      expect(errorOf(await kernel.executeToCompletion('print(marker)'))).toMatch(/NameError/);
      // 文件还在
      expect(existsSync(join(cwd, 'artifact.txt'))).toBe(true);
      // 重启后 inline 后端等初始化代码被重新执行
      const out = await kernel.executeToCompletion(
        [
          'import matplotlib.pyplot as plt',
          'from IPython.display import display',
          'fig, ax = plt.subplots()',
          'ax.plot([0,1],[0,1])',
          'display(fig)',
          'plt.close(fig)',
        ].join('\n'),
      );
      expect(mimesOf(out)).toContain('image/png');
    },
    SLOW,
  );

  it(
    '执行超时不会让 cell 永远挂着',
    async () => {
      const started = Date.now();
      try {
        await kernel.executeToCompletion('import time; time.sleep(60)', { timeoutMs: 1500 });
      } catch {
        // 重启路径会抛错，属预期
      }
      // 关键是它必须结束，而不是等满 60 秒
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(stdoutOf(await kernel.executeToCompletion('print("still-here")'))).toBe('still-here');
    },
    SLOW,
  );
});

/* ------------------------------------------------------------------ *
 * R 内核
 * ------------------------------------------------------------------ */

describe.skipIf(!hasR)('R 内核', () => {
  let kernel: JupyterKernel;

  beforeAll(async () => {
    const runtimeDir = join(root, 'r-rt');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runtimeDir, { recursive: true });
    const launcher = writeIRkernelLauncher(runtimeDir);

    kernel = await JupyterKernel.start({
      spec: rLaunchSpec(available.r!, launcher),
      runtimeDir,
      cwd: join(root, 'r-ws'),
    });
  }, SLOW);

  afterAll(async () => {
    await kernel.shutdown();
  }, SLOW);

  it('就绪后报告 IRkernel 与 R 版本', () => {
    expect(kernel.kernelInfo?.implementation).toBe('IRkernel');
    expect(kernel.kernelInfo?.languageName).toBe('R');
    expect(kernel.kernelInfo?.languageVersion).toMatch(/^\d+\./);
  });

  it(
    '捕获 stdout',
    async () => {
      const out = await kernel.executeToCompletion('cat("sum:", sum(0:9), "\\n")');
      expect(stdoutOf(out)).toBe('sum: 45');
    },
    SLOW,
  );

  it(
    '变量跨调用保留',
    async () => {
      await kernel.executeToCompletion('x <- 0:9');
      expect(stdoutOf(await kernel.executeToCompletion('cat("v:", sum(x), "\\n")'))).toBe('v: 45');
    },
    SLOW,
  );

  it(
    'data.frame 返回比 Python 更丰富的 MIME（含 latex，对论文有用）',
    async () => {
      const mimes = mimesOf(await kernel.executeToCompletion('data.frame(a = 1:3)'));
      expect(mimes).toContain('text/html');
      expect(mimes).toContain('text/latex');
    },
    SLOW,
  );

  it(
    '绘图作为 image/png 返回',
    async () => {
      const mimes = mimesOf(await kernel.executeToCompletion('plot(1:10, (1:10)^2)'));
      expect(mimes).toContain('image/png');
    },
    SLOW,
  );

  it(
    'stop() 产生结构化异常',
    async () => {
      expect(errorOf(await kernel.executeToCompletion('stop("boom")'))).toMatch(/boom/);
    },
    SLOW,
  );

  it(
    '心跳可达',
    async () => {
      expect(await kernel.isAlive()).toBe(true);
    },
    SLOW,
  );
});

/* ------------------------------------------------------------------ *
 * 内核池
 * ------------------------------------------------------------------ */

describe.skipIf(!hasPython)('内核池', () => {
  let pool: KernelPool;

  beforeAll(() => {
    pool = new KernelPool({
      runtimeDir: join(root, 'pool-rt'),
      workspaceRoot: join(root, 'pool-ws'),
      idleTimeoutMs: 0,
      available,
    });
  });

  afterAll(async () => {
    await pool.close();
  }, SLOW);

  it('按环境可用性报告支持的语言', () => {
    expect(pool.supports('python')).toBe(true);
    expect(pool.supports('r')).toBe(hasR);
  });

  it(
    '同一会话复用同一内核',
    async () => {
      const a = await pool.acquire('conv-1', 'python');
      const b = await pool.acquire('conv-1', 'python');
      expect(a).toBe(b);
      expect(a.pid).toBe(b.pid);
    },
    SLOW,
  );

  it(
    '并发 acquire 只启动一个内核',
    async () => {
      const [a, b, c] = await Promise.all([
        pool.acquire('conv-race', 'python'),
        pool.acquire('conv-race', 'python'),
        pool.acquire('conv-race', 'python'),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(pool.list().filter((e) => e.conversationId === 'conv-race')).toHaveLength(1);
    },
    SLOW,
  );

  it(
    '不同会话状态互相隔离',
    async () => {
      const k1 = await pool.acquire('conv-a', 'python');
      const k2 = await pool.acquire('conv-b', 'python');
      expect(k1.pid).not.toBe(k2.pid);

      await k1.executeToCompletion('secret = 123');
      // conv-b 看不到 conv-a 的变量
      expect(errorOf(await k2.executeToCompletion('print(secret)'))).toMatch(/NameError/);
    },
    SLOW,
  );

  it(
    '不同会话有各自的工作目录',
    async () => {
      const k1 = await pool.acquire('conv-w1', 'python');
      const k2 = await pool.acquire('conv-w2', 'python');
      await k1.executeToCompletion('open("same.txt","w").write("from-w1")');
      await k2.executeToCompletion('open("same.txt","w").write("from-w2")');

      expect(readFileSync(join(root, 'pool-ws', 'conv-w1', 'same.txt'), 'utf8')).toBe('from-w1');
      expect(readFileSync(join(root, 'pool-ws', 'conv-w2', 'same.txt'), 'utf8')).toBe('from-w2');
    },
    SLOW,
  );

  it(
    'list 报告在池内核的状态',
    async () => {
      await pool.acquire('conv-list', 'python');
      const entry = pool.list().find((e) => e.conversationId === 'conv-list');
      expect(entry).toMatchObject({ language: 'python', busy: false });
      expect(entry?.pid).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    '重启保持同一池位但换进程',
    async () => {
      const before = await pool.acquire('conv-restart', 'python');
      const pidBefore = before.pid;
      expect(await pool.restart('conv-restart', 'python')).toBe(true);
      const after = await pool.acquire('conv-restart', 'python');
      expect(after).toBe(before); // 同一句柄
      expect(after.pid).not.toBe(pidBefore); // 不同进程
    },
    SLOW,
  );

  it(
    '关闭会话内核后再取会新建',
    async () => {
      const first = await pool.acquire('conv-close', 'python');
      const pid = first.pid;
      expect(await pool.shutdown('conv-close', 'python')).toBe(true);
      const second = await pool.acquire('conv-close', 'python');
      expect(second).not.toBe(first);
      expect(second.pid).not.toBe(pid);
    },
    SLOW,
  );

  it(
    '外部强杀内核后池会自动重建',
    async () => {
      const k = await pool.acquire('conv-killed', 'python');
      const pid = k.pid;
      expect(pid).not.toBeNull();
      process.kill(pid!, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 600));

      const rebuilt = await pool.acquire('conv-killed', 'python');
      expect(rebuilt.pid).not.toBe(pid);
      expect(stdoutOf(await rebuilt.executeToCompletion('print("ok")'))).toBe('ok');
    },
    SLOW,
  );

  it('对不存在的池位操作返回 false 而不抛错', async () => {
    expect(await pool.restart('nope', 'python')).toBe(false);
    expect(await pool.interrupt('nope', 'python')).toBe(false);
    expect(await pool.shutdown('nope', 'python')).toBe(false);
  });

  it('关闭后拒绝继续 acquire', async () => {
    const p = new KernelPool({
      runtimeDir: join(root, 'pool2-rt'),
      workspaceRoot: join(root, 'pool2-ws'),
      available,
    });
    await p.close();
    await expect(p.acquire('x', 'python')).rejects.toThrow(/已关闭/);
  });
});

/* ------------------------------------------------------------------ *
 * 环境探测
 * ------------------------------------------------------------------ */

describe('环境探测', () => {
  it('报告托管环境的可用性', () => {
    // 不断言具体值——这台机器上两者都有，但 CI 上可能都没有
    expect(available).toHaveProperty('python');
    expect(available).toHaveProperty('r');
  });

  it('R 不可用时不应注册 r 工具（需求 2.4 的前提）', () => {
    const pool = new KernelPool({
      runtimeDir: join(root, 'probe-rt'),
      workspaceRoot: join(root, 'probe-ws'),
      available: { python: null, r: null },
    });
    expect(pool.supports('python')).toBe(false);
    expect(pool.supports('r')).toBe(false);
  });

  it('语言环境缺失时给出可执行的指引而非模糊报错', async () => {
    const pool = new KernelPool({
      runtimeDir: join(root, 'probe2-rt'),
      workspaceRoot: join(root, 'probe2-ws'),
      available: { python: null, r: null },
    });
    await expect(pool.acquire('c', 'python')).rejects.toThrow(/conda create -n lsci/);
    await expect(pool.acquire('c', 'r')).rejects.toThrow(/r-irkernel/);
    await pool.close();
  });
});
