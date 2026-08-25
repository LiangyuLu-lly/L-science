/**
 * 后台任务与通知投递测试（任务 6.5，需求 3.7、3.11）。
 *
 * 最关键的一条：**会话中断不影响后台任务**。用户把任务转后台的动作本身就
 * 表达了「我不等它」，如果中断会话把它也杀掉，「转后台」在实际使用中就是个
 * 陷阱——提交了两小时的作业，随后打断一句闲聊，作业没了。
 */

import { describe, expect, it, vi } from 'vitest';

import { BackgroundRunner, BackgroundTooManyError, type BackgroundNotice } from '@l-science/core';

/** 等到条件成立，用于观察异步完成。 */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('等待超时');
}

function setup() {
  const notices: BackgroundNotice[] = [];
  const runner = new BackgroundRunner({ deliver: (n) => notices.push(n) });
  return { runner, notices };
}

describe('提交与完成', () => {
  it('立即返回任务 id，不等完成', () => {
    const { runner } = setup();
    const id = runner.submit({
      conversationId: 'c1',
      label: '长任务',
      run: async () => new Promise((r) => setTimeout(() => r({ kind: 'text', text: 'done' }), 50)),
    });
    expect(id).toMatch(/^bg_/);
    expect(runner.get(id)?.state).toBe('running');
  });

  it('完成后投递通知，结果自动回到会话', async () => {
    const { runner, notices } = setup();
    runner.submit({
      conversationId: 'c1',
      label: '算个东西',
      run: async () => ({ kind: 'text', text: '结果是 42' }),
    });

    await until(() => notices.length > 0);
    expect(notices[0]).toMatchObject({
      conversationId: 'c1',
      label: '算个东西',
      state: 'succeeded',
      output: { kind: 'text', text: '结果是 42' },
    });
    expect(notices[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('任务抛错时投递失败通知而不是静默消失', async () => {
    const { runner, notices } = setup();
    runner.submit({
      conversationId: 'c1',
      label: '会失败的任务',
      run: async () => {
        throw new Error('内核崩了');
      },
    });

    await until(() => notices.length > 0);
    expect(notices[0]?.state).toBe('failed');
    expect(notices[0]?.output).toMatchObject({ kind: 'error', evalue: '内核崩了' });
  });

  it('完成后可查询到终态与结果', async () => {
    const { runner, notices } = setup();
    const id = runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async () => ({ kind: 'text', text: 'ok' }),
    });

    await until(() => notices.length > 0);
    const task = runner.get(id);
    expect(task).toMatchObject({ state: 'succeeded', result: { kind: 'text', text: 'ok' } });
    expect(task?.finishedAt).toBeGreaterThan(0);
  });

  it('通知投递失败不把任务标成失败', async () => {
    // 任务本身是成功的，失败的是通知。混淆两者会让用户以为计算白跑了
    const runner = new BackgroundRunner({
      deliver: () => {
        throw new Error('IPC 断了');
      },
    });
    const id = runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async () => ({ kind: 'text', text: 'ok' }),
    });

    await until(() => runner.get(id)?.state !== 'running');
    expect(runner.get(id)?.state).toBe('succeeded');
  });
});

describe('会话中断不影响后台任务（需求 3.11）', () => {
  it('中断会话后任务仍在跑', async () => {
    const { runner, notices } = setup();
    let finished = false;
    const id = runner.submit({
      conversationId: 'c1',
      label: '两小时的作业',
      run: async () =>
        new Promise((r) =>
          setTimeout(() => {
            finished = true;
            r({ kind: 'text', text: '跑完了' });
          }, 60),
        ),
    });

    const result = runner.onConversationInterrupted('c1');
    // 中断只是报告哪些任务不受影响，不取消它们
    expect(result.unaffected.map((t) => t.id)).toEqual([id]);
    expect(runner.get(id)?.state).toBe('running');

    await until(() => notices.length > 0);
    expect(finished).toBe(true);
    expect(notices[0]?.state).toBe('succeeded');
  });

  it('中断只报告本会话的任务', () => {
    const { runner } = setup();
    runner.submit({
      conversationId: 'c1',
      label: 'a',
      run: async () => new Promise((r) => setTimeout(() => r({ kind: 'text', text: '' }), 100)),
    });
    runner.submit({
      conversationId: 'c2',
      label: 'b',
      run: async () => new Promise((r) => setTimeout(() => r({ kind: 'text', text: '' }), 100)),
    });

    expect(runner.onConversationInterrupted('c1').unaffected).toHaveLength(1);
  });

  it('任务收到的信号不因会话中断而触发', async () => {
    // 这是「后台任务不受会话中断影响」这条语义的落点
    const { runner, notices } = setup();
    let sawAbort = false;

    runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async (signal) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        await new Promise((r) => setTimeout(r, 40));
        return { kind: 'text', text: 'ok' };
      },
    });

    runner.onConversationInterrupted('c1');
    await until(() => notices.length > 0);
    expect(sawAbort).toBe(false);
  });
});

describe('显式取消', () => {
  it('取消触发信号并投递取消通知', async () => {
    const { runner, notices } = setup();
    const id = runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ kind: 'text', text: 'ok' }), 500);
        }),
    });

    expect(runner.cancel(id)).toBe(true);
    await until(() => notices.length > 0);
    expect(notices[0]?.state).toBe('cancelled');
    expect(runner.get(id)?.state).toBe('cancelled');
  });

  it('取消不存在的任务返回 false', () => {
    expect(setup().runner.cancel('bg_nope')).toBe(false);
  });

  it('任务正常返回但期间被取消过，按取消处理', async () => {
    // 报成功会让用户看到一个他明确取消过的任务的结果，令人困惑
    const { runner, notices } = setup();
    const id = runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { kind: 'text', text: '其实跑完了' };
      },
    });

    runner.cancel(id);
    await until(() => notices.length > 0);
    expect(notices[0]?.state).toBe('cancelled');
  });
});

describe('并发上限', () => {
  const slow = async () =>
    new Promise<{ kind: 'text'; text: string }>((r) =>
      setTimeout(() => r({ kind: 'text', text: '' }), 200),
    );

  it('超出上限时拒绝提交并说明怎么办', () => {
    const runner = new BackgroundRunner({
      deliver: () => undefined,
      maxConcurrentPerConversation: 2,
    });
    runner.submit({ conversationId: 'c1', label: 'a', run: slow });
    runner.submit({ conversationId: 'c1', label: 'b', run: slow });

    expect(() => runner.submit({ conversationId: 'c1', label: 'c', run: slow })).toThrow(
      BackgroundTooManyError,
    );
    expect(() => runner.submit({ conversationId: 'c1', label: 'c', run: slow })).toThrow(
      /取消不需要的/,
    );
  });

  it('上限按会话分别计算', () => {
    const runner = new BackgroundRunner({
      deliver: () => undefined,
      maxConcurrentPerConversation: 1,
    });
    runner.submit({ conversationId: 'c1', label: 'a', run: slow });
    // 另一个会话不受影响
    expect(() => runner.submit({ conversationId: 'c2', label: 'b', run: slow })).not.toThrow();
  });

  it('任务完成后释放配额', async () => {
    const notices: BackgroundNotice[] = [];
    const runner = new BackgroundRunner({
      deliver: (n) => notices.push(n),
      maxConcurrentPerConversation: 1,
    });
    runner.submit({
      conversationId: 'c1',
      label: 'a',
      run: async () => ({ kind: 'text', text: '' }),
    });

    await until(() => notices.length > 0);
    expect(() => runner.submit({ conversationId: 'c1', label: 'b', run: slow })).not.toThrow();
  });
});

describe('列表与清理', () => {
  it('默认只列在跑的任务', async () => {
    const { runner, notices } = setup();
    runner.submit({
      conversationId: 'c1',
      label: 'done',
      run: async () => ({ kind: 'text', text: '' }),
    });
    await until(() => notices.length > 0);

    runner.submit({
      conversationId: 'c1',
      label: 'running',
      run: async () => new Promise((r) => setTimeout(() => r({ kind: 'text', text: '' }), 200)),
    });

    expect(runner.list().map((t) => t.label)).toEqual(['running']);
    expect(runner.list({ includeFinished: true })).toHaveLength(2);
  });

  it('按会话过滤', () => {
    const { runner } = setup();
    const slow = async () =>
      new Promise<{ kind: 'text'; text: string }>((r) =>
        setTimeout(() => r({ kind: 'text', text: '' }), 200),
      );
    runner.submit({ conversationId: 'c1', label: 'a', run: slow });
    runner.submit({ conversationId: 'c2', label: 'b', run: slow });

    expect(runner.list({ conversationId: 'c1' }).map((t) => t.label)).toEqual(['a']);
  });

  it('清理旧的完成记录', async () => {
    let clock = 1_000_000;
    const notices: BackgroundNotice[] = [];
    const runner = new BackgroundRunner({ deliver: (n) => notices.push(n), now: () => clock });

    runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async () => ({ kind: 'text', text: '' }),
    });
    await until(() => notices.length > 0);

    clock += 2 * 60 * 60 * 1000;
    expect(runner.pruneFinished()).toBe(1);
    expect(runner.list({ includeFinished: true })).toHaveLength(0);
  });

  it('关闭时取消全部在跑的任务', async () => {
    const { runner, notices } = setup();
    runner.submit({
      conversationId: 'c1',
      label: 't',
      run: async (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ kind: 'text', text: '' }), 500);
        }),
    });

    runner.close();
    // 进程要退出了，任务无处可去。取消是唯一选择，但要如实通知
    await until(() => notices.length > 0);
    expect(notices[0]?.state).toBe('cancelled');
  });

  it('关闭后拒绝新提交', () => {
    const { runner } = setup();
    runner.close();
    expect(() =>
      runner.submit({
        conversationId: 'c1',
        label: 't',
        run: async () => ({ kind: 'text', text: '' }),
      }),
    ).toThrow(/已关闭/);
  });
});
