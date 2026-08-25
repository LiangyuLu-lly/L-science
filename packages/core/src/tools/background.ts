/**
 * 后台任务与通知投递（任务 6.5，需求 3.7、3.11）。
 *
 * 中断语义是这个模块最容易写错的部分。两类任务对中断的反应必须相反：
 *
 * - **阻塞式子任务**随会话中断一起取消。用户按下停止是因为他不想等了，
 *   继续跑一个他正在等待的东西毫无意义。
 * - **后台任务**不受会话中断影响。用户把任务转后台的动作本身就表达了
 *   「我不等它，你跑完告诉我」——如果中断会话把它也杀掉，那么「转后台」
 *   这个功能在实际使用中就是个陷阱：用户提交了一个两小时的作业，随后打断
 *   了一句闲聊，作业没了。
 *
 * 把两者合成一套取消机制是最省事的实现，也是最坏的实现。
 */

import { randomUUID } from 'node:crypto';

import type { ToolOutput } from '@l-science/shared';

export type BackgroundState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  conversationId: string;
  /** 人类可读的任务描述，用于通知与列表显示。 */
  label: string;
  state: BackgroundState;
  startedAt: number;
  finishedAt: number | null;
  /** 完成后的结果。未完成时为 null。 */
  result: ToolOutput | null;
}

/** 任务完成时投递的通知。 */
export interface BackgroundNotice {
  taskId: string;
  conversationId: string;
  label: string;
  state: Exclude<BackgroundState, 'running'>;
  output: ToolOutput;
  durationMs: number;
}

export interface BackgroundRunnerOptions {
  /**
   * 投递通知。通常是往会话事件流写一条，让结果自动回到对话里。
   *
   * 这个回调不应抛错：投递失败不该让任务状态变成失败——任务本身是成功的，
   * 失败的是通知。混淆这两者会让用户以为计算白跑了。
   */
  deliver: (notice: BackgroundNotice) => void;
  /** 单个会话允许的并发后台任务数。超出则拒绝提交。 */
  maxConcurrentPerConversation?: number;
  now?: () => number;
}

/** 默认并发上限。太多后台任务会把内核池和 CPU 都占满。 */
const DEFAULT_MAX_CONCURRENT = 3;

interface Running {
  task: BackgroundTask;
  controller: AbortController;
}

export class BackgroundTooManyError extends Error {
  constructor(limit: number) {
    super(
      `当前会话已有 ${String(limit)} 个后台任务在跑，达到并发上限。` +
        '等其中一个完成后再提交，或先取消不需要的任务。',
    );
    this.name = 'BackgroundTooManyError';
  }
}

export class BackgroundRunner {
  readonly #deliver: BackgroundRunnerOptions['deliver'];
  readonly #maxConcurrent: number;
  readonly #now: () => number;

  readonly #running = new Map<string, Running>();
  /** 已完成的任务，保留一段时间供查询。 */
  readonly #finished = new Map<string, BackgroundTask>();

  #closed = false;

  constructor(options: BackgroundRunnerOptions) {
    this.#deliver = options.deliver;
    this.#maxConcurrent = options.maxConcurrentPerConversation ?? DEFAULT_MAX_CONCURRENT;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 提交一个后台任务。立即返回任务 id，不等它完成。
   *
   * `run` 收到一个 AbortSignal——它只在任务被**显式取消**时触发，会话中断
   * 不会触发它。这是「后台任务不受会话中断影响」这条语义的落点。
   */
  submit(input: {
    conversationId: string;
    label: string;
    run: (signal: AbortSignal) => Promise<ToolOutput>;
  }): string {
    if (this.#closed) throw new Error('后台执行器已关闭');

    const active = [...this.#running.values()].filter(
      (r) => r.task.conversationId === input.conversationId,
    );
    if (active.length >= this.#maxConcurrent) {
      throw new BackgroundTooManyError(this.#maxConcurrent);
    }

    const id = `bg_${randomUUID()}`;
    const controller = new AbortController();
    const task: BackgroundTask = {
      id,
      conversationId: input.conversationId,
      label: input.label,
      state: 'running',
      startedAt: this.#now(),
      finishedAt: null,
      result: null,
    };

    this.#running.set(id, { task, controller });

    // 刻意不 await：submit 的语义就是「交出去就返回」
    void this.#execute(id, input.run, controller.signal);

    return id;
  }

  async #execute(
    id: string,
    run: (signal: AbortSignal) => Promise<ToolOutput>,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = this.#running.get(id);
    if (entry === undefined) return;

    let output: ToolOutput;
    let state: Exclude<BackgroundState, 'running'>;

    try {
      output = await run(signal);
      // 任务函数正常返回但期间被取消过：按取消处理而不是成功。
      // 报成功会让用户看到一个他明确取消过的任务的结果，令人困惑
      state = signal.aborted ? 'cancelled' : 'succeeded';
    } catch (err) {
      if (signal.aborted) {
        state = 'cancelled';
        output = { kind: 'text', text: '任务已取消。' };
      } else {
        state = 'failed';
        output = {
          kind: 'error',
          ename: 'BackgroundTaskFailed',
          evalue: err instanceof Error ? err.message : String(err),
          traceback: [],
        };
      }
    }

    // 任务可能在执行期间被 close() 清掉了
    const still = this.#running.get(id);
    if (still === undefined) return;

    this.#running.delete(id);
    const finishedAt = this.#now();
    const finished: BackgroundTask = {
      ...still.task,
      state,
      finishedAt,
      result: output,
    };
    this.#finished.set(id, finished);

    // 投递失败不改任务状态：任务本身是成功的，失败的是通知。
    // 混淆两者会让用户以为计算白跑了
    try {
      this.#deliver({
        taskId: id,
        conversationId: finished.conversationId,
        label: finished.label,
        state,
        output,
        durationMs: finishedAt - finished.startedAt,
      });
    } catch {
      // 通知投递失败已经无处可报，至少不要影响任务状态
    }
  }

  /**
   * 显式取消一个后台任务。
   *
   * 与会话中断分开：只有用户点「取消这个任务」才走这里。
   */
  cancel(taskId: string): boolean {
    const entry = this.#running.get(taskId);
    if (entry === undefined) return false;
    entry.controller.abort();
    return true;
  }

  /**
   * 会话被中断时调用。
   *
   * **刻意什么都不做**，只返回不受影响的后台任务数供 UI 提示。
   *
   * 这个方法存在的意义是让「会话中断不影响后台任务」成为一条被显式表达、
   * 可被测试的决定，而不是「恰好没写取消逻辑」。后者会在某次重构中被人
   * 「顺手补上」，然后用户提交的两小时作业开始因为一句闲聊而消失。
   */
  onConversationInterrupted(conversationId: string): { unaffected: readonly BackgroundTask[] } {
    const unaffected = [...this.#running.values()]
      .filter((r) => r.task.conversationId === conversationId)
      .map((r) => r.task);
    return { unaffected };
  }

  get(taskId: string): BackgroundTask | null {
    return this.#running.get(taskId)?.task ?? this.#finished.get(taskId) ?? null;
  }

  /** 列出任务。默认只列在跑的。 */
  list(
    options: { conversationId?: string; includeFinished?: boolean } = {},
  ): readonly BackgroundTask[] {
    const tasks: BackgroundTask[] = [...this.#running.values()].map((r) => r.task);
    if (options.includeFinished === true) tasks.push(...this.#finished.values());

    const filtered =
      options.conversationId === undefined
        ? tasks
        : tasks.filter((t) => t.conversationId === options.conversationId);

    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 清理完成记录，避免长会话里无限增长。 */
  pruneFinished(olderThanMs = 60 * 60 * 1000): number {
    const cutoff = this.#now() - olderThanMs;
    let removed = 0;
    for (const [id, task] of [...this.#finished.entries()]) {
      if (task.finishedAt !== null && task.finishedAt < cutoff) {
        this.#finished.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 关闭执行器，取消全部在跑的任务。
   *
   * 与会话中断不同：进程要退出了，任务无处可去。这时取消是唯一选择，
   * 但要如实通知用户而不是静默丢弃。
   */
  close(): void {
    this.#closed = true;
    for (const entry of this.#running.values()) entry.controller.abort();
  }
}
