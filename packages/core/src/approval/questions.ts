/**
 * 向用户提问（任务 8.2，需求 17.4）。
 *
 * 与审批服务分开是因为语义不同：审批是「放行或不放行」这个二元决定，提问是
 * 获取一段信息。合成一个服务会让返回类型变成 `boolean | string`，每个调用点
 * 都得先判断自己拿到的是哪种——那是把两件事强行塞进一个抽象的典型症状。
 *
 * 但等待机制的形状相同，因此两者的关闭与取消语义保持一致：都必须把等待者
 * 一一 resolve，否则 await 它们的调用方永久挂起，进程关不掉。
 */

import { randomUUID } from 'node:crypto';

import type { UserQuestion } from '@l-science/shared';

/**
 * 提问结果。
 *
 * 「用户没答」与「用户答了空串」必须区分：后者是明确表示「没有补充」，
 * 是有效信息；前者说明信息仍然缺失，agent 不该假装拿到了答案继续往下走。
 */
export type QuestionResult =
  | { state: 'answered'; answer: string }
  | { state: 'timeout'; waitedMs: number }
  | { state: 'cancelled'; reason: string };

export interface QuestionDraft {
  kind: UserQuestion['kind'];
  question: string;
  detail?: string | null;
  choices?: readonly string[];
  conversationId?: string | null;
  /** 等待上限。默认与审批一致（10 分钟）。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface Waiter {
  question: UserQuestion;
  conversationId: string | null;
  askedAt: number;
  resolve: (result: QuestionResult) => void;
  timer: NodeJS.Timeout | null;
}

export interface QuestionServiceOptions {
  publish: (question: UserQuestion, conversationId: string | null) => void;
  now?: () => number;
}

export class QuestionService {
  readonly #publish: QuestionServiceOptions['publish'];
  readonly #now: () => number;
  readonly #waiters = new Map<string, Waiter>();
  #closed = false;

  constructor(options: QuestionServiceOptions) {
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
  }

  async ask(draft: QuestionDraft): Promise<QuestionResult> {
    if (this.#closed) return { state: 'cancelled', reason: '提问服务已关闭' };

    const question: UserQuestion = {
      id: `q_${randomUUID()}`,
      kind: draft.kind,
      question: draft.question,
      detail: draft.detail ?? null,
      choices: draft.choices ?? [],
    };

    const conversationId = draft.conversationId ?? null;
    const askedAt = this.#now();
    const timeoutMs = draft.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<QuestionResult>((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#settle(question.id, { state: 'timeout', waitedMs: this.#now() - askedAt });
            }, timeoutMs)
          : null;
      timer?.unref?.();

      // 先登记后推送，避免同步实现的 publish 在等待者就位前就回答
      this.#waiters.set(question.id, { question, conversationId, askedAt, resolve, timer });
      this.#publish(question, conversationId);
    });
  }

  /** 返回是否命中一个等待中的提问。false 表示 id 不存在或已作答。 */
  answer(questionId: string, answer: string): boolean {
    if (!this.#waiters.has(questionId)) return false;
    this.#settle(questionId, { state: 'answered', answer });
    return true;
  }

  cancel(questionId: string, reason: string): boolean {
    if (!this.#waiters.has(questionId)) return false;
    this.#settle(questionId, { state: 'cancelled', reason });
    return true;
  }

  pending(): ReadonlyArray<{
    question: UserQuestion;
    conversationId: string | null;
    askedAt: number;
  }> {
    return [...this.#waiters.values()].map((w) => ({
      question: w.question,
      conversationId: w.conversationId,
      askedAt: w.askedAt,
    }));
  }

  /** 取消某个会话的全部提问。会话被中止时调用。 */
  cancelConversation(conversationId: string, reason: string): number {
    let count = 0;
    for (const [id, waiter] of [...this.#waiters.entries()]) {
      if (waiter.conversationId === conversationId) {
        this.#settle(id, { state: 'cancelled', reason });
        count += 1;
      }
    }
    return count;
  }

  close(reason = '后端正在关闭'): void {
    this.#closed = true;
    for (const id of [...this.#waiters.keys()]) {
      this.#settle(id, { state: 'cancelled', reason });
    }
  }

  #settle(id: string, result: QuestionResult): void {
    const waiter = this.#waiters.get(id);
    if (waiter === undefined) return;
    this.#waiters.delete(id);
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.resolve(result);
  }
}
