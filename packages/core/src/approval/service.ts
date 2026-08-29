/**
 * Approval Service（任务 8.1，需求 17）。
 *
 * 职责：把「这个操作需要用户点头」变成一个可 await 的调用。发起方写
 * `const r = await approvals.request({...})`，服务负责推事件给 UI、挂起、
 * 等决议、处理超时、留审计痕迹。
 *
 * 三条贯穿设计的判断：
 *
 * 1. **默认拒绝。** 超时、取消、进程关闭都导向「不放行」。审批机制唯一的价值
 *    是在不确定时停下来，任何「出错就放行」的分支都会让它在最需要的时候失效。
 * 2. **拒绝要有记忆。** 需求 17.3 要求拒绝后不得重试同一请求。没有记忆的话，
 *    一个循环里的 agent 可以拿同一件事问用户几十次，用户最终会为了脱身而点
 *    同意——这比不问更糟。
 * 3. **审批与授权分开。** 一次审批的产物可以是一次性放行，也可以是一条带
 *    作用域与有效期的持久授权（需求 17.5）。服务返回用户选择的作用域，
 *    由调用方决定要不要据此建立授权记录。
 */

import { randomUUID } from 'node:crypto';

import { APPROVAL_EXPIRY_PRESETS, type ApprovalRequest, type GrantScope } from '@l-science/shared';

import type { ApprovalRepo, ApprovalRow, ApprovalState } from '../repo/approvals.js';
import {
  approvalFingerprint,
  type ApprovalDraft,
  type ApprovalResult,
  type PendingApproval,
} from './types.js';

/** 默认等待上限。见 ApprovalDraft.timeoutMs 的说明。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 各作用域的**默认**有效期（需求 17.5）。
 *
 * `session` 与 `project` 是 null 而不是某个时长：它们的生命周期由会话与项目决定，
 * 用时钟去限制会造出一个奇怪的状态——授权还在作用域内但已经过期，而用户找不到
 * 任何时间线索来解释它为什么失效了。
 *
 * `always` 默认给 90 天而不是永久。「所有项目内都不再询问」是这套机制里最宽的一档，
 * 而用户按下它时想的通常是「这段时间我都在弄这个」，不是「余生都同意」。给一个
 * 到期日意味着这条授权会被重新审视一次，而重新审视是这类宽授权唯一的安全阀。
 * 用户可以在卡片上显式选「不过期」——那是他明确的意思，与默认落到永久不是一回事。
 */
const SCOPE_DEFAULT_DURATION_MS: Readonly<Record<GrantScope, number | null>> = {
  once: 0,
  session: null,
  project: null,
  always: 90 * 24 * 60 * 60 * 1000,
};

interface Waiter {
  request: ApprovalRequest;
  conversationId: string | null;
  requestedAt: number;
  deadline: number | null;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout | null;
}

export interface ApprovalServiceOptions {
  repo: ApprovalRepo;
  /**
   * 把审批请求推给用户。通常是往会话事件流写一条 `approval.request`。
   *
   * 这个回调**不应抛错**。若推送失败（UI 未连接），审批会一直挂到超时——
   * 那是正确的行为：没人看得到的审批不该被当作已批准。
   */
  publish: (request: ApprovalRequest, conversationId: string | null) => void;
  /** 注入时钟便于测试。 */
  now?: () => number;
}

export class ApprovalService {
  readonly #repo: ApprovalRepo;
  readonly #publish: ApprovalServiceOptions['publish'];
  readonly #now: () => number;

  /** 按 id 索引的等待者。并发审批各自独立，互不干扰。 */
  readonly #waiters = new Map<string, Waiter>();

  /**
   * 拒绝记忆。键为 `${conversationId ?? ''}|${fingerprint}`。
   *
   * **刻意只存在内存里，不跨进程重启。** 这条记忆要解决的问题是「agent 在一个
   * 循环里拿同一件事反复问用户」，那个问题只存在于进程生命周期内。让拒绝
   * 永久生效会造成正相反的困扰：用户隔天回来明确表示现在可以了，系统却仍然
   * 直接拒绝，而且不给他任何被询问的机会。
   *
   * 数据库里的 denied 行因此只用于审计，不参与这个判断。
   */
  readonly #denied = new Map<string, { note: string | null; at: number }>();

  #closed = false;

  constructor(options: ApprovalServiceOptions) {
    this.#repo = options.repo;
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;

    // 上一次进程留下的 pending 记录没人在等，标记掉而不是重新挂起
    this.#repo.abandonStale();
  }

  /**
   * 发起审批并等待决议。
   *
   * 返回的 Promise 永不 reject——审批被拒绝是**正常结果**而不是异常。用异常
   * 表达拒绝会让调用方倾向于 try/catch 后继续执行，那正是审批要防止的事。
   */
  async request(draft: ApprovalDraft): Promise<ApprovalResult> {
    if (this.#closed) {
      return { state: 'cancelled', reason: '审批服务已关闭' };
    }

    const conversationId = draft.conversationId ?? null;

    // 需求 17.3：本进程内拒绝过同一请求时直接返回，不再打扰用户
    const prior = this.#denied.get(this.#denialKey(conversationId, draft.kind, draft.payload));
    if (prior !== undefined) {
      return {
        state: 'denied',
        fromPriorDenial: true,
        ...(prior.note !== null ? { note: prior.note } : {}),
      };
    }

    const scopeOptions = draft.scopeOptions ?? [];
    /*
     * 有效期档位（需求 17.5）。
     *
     * 只在存在**持久**作用域时提供。一次性确认给有效期选择是纯粹的困惑：那次放行
     * 在操作结束的一刻就结束了，「7 天」对它没有意义。
     */
    const expiryOptions =
      draft.expiryOptions ??
      (scopeOptions.some((s) => s !== 'once') ? APPROVAL_EXPIRY_PRESETS : []);

    const request: ApprovalRequest = {
      id: `ap_${randomUUID()}`,
      kind: draft.kind,
      title: draft.title,
      detail: draft.detail,
      impact: draft.impact,
      reversible: draft.reversible,
      undoHint: draft.undoHint ?? null,
      scopeOptions,
      expiryOptions,
      payload: draft.payload,
    };

    const requestedAt = this.#now();
    const timeoutMs = draft.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = timeoutMs > 0 ? requestedAt + timeoutMs : null;

    this.#repo.insert({ request, conversationId, requestedAt });

    return new Promise<ApprovalResult>((resolve) => {
      const timer =
        deadline === null
          ? null
          : setTimeout(() => {
              // 超时按不放行处理，但状态与显式拒绝区分开：
              // 用户当时不在，稍后重新发起是合理的
              this.#settle(request.id, {
                state: 'timeout',
                waitedMs: this.#now() - requestedAt,
              });
            }, timeoutMs);

      // Node 的定时器会让进程无法退出。审批超时不该拖着整个后端不关，
      // 因此取消其对事件循环的引用
      timer?.unref?.();

      this.#waiters.set(request.id, {
        request,
        conversationId,
        requestedAt,
        deadline,
        resolve,
        timer,
      });

      // 先登记等待者再推送：反过来的话，一个同步实现的 publish
      // （测试里很常见）可能在等待者登记之前就调用 decide，决议丢失
      this.#publish(request, conversationId);
    });
  }

  /**
   * 用户决议。
   *
   * 返回是否命中了一个等待中的审批。返回 false 说明这个 id 不存在或已决议——
   * 调用方（IPC 层）应据此告知 UI，而不是静默成功。静默成功会让「点了没反应」
   * 这类问题无从排查。
   */
  decide(input: {
    approvalId: string;
    decision: 'approve' | 'deny';
    note?: string;
    /** 用户选择的作用域。仅在 approve 且请求提供了 scopeOptions 时有意义。 */
    scope?: GrantScope;
    /**
     * 用户选择的有效期（毫秒），`null` 表示不过期（需求 17.5）。
     *
     * 省略时用该作用域的默认值。不在 `expiryOptions` 里的值会被拒收并降级到默认——
     * 与作用域同一条理由：那通常是 UI 与后端版本不一致，此时按更保守的默认处理
     * 比接受一个我们没打算提供的值更合理。
     */
    expiresInMs?: number | null;
  }): boolean {
    const waiter = this.#waiters.get(input.approvalId);
    if (waiter === undefined) return false;

    if (input.decision === 'deny') {
      // 记住拒绝，防止同一请求被反复发起
      const key = this.#denialKey(
        waiter.conversationId,
        waiter.request.kind,
        waiter.request.payload,
      );
      this.#denied.set(key, { note: input.note ?? null, at: this.#now() });

      this.#settle(input.approvalId, {
        state: 'denied',
        fromPriorDenial: false,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return true;
    }

    const scope = this.#resolveScope(waiter.request, input.scope);
    this.#settle(input.approvalId, {
      state: 'approved',
      scope,
      expiresAt: this.#expiryFor(waiter.request, scope, input.expiresInMs),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return true;
  }

  /**
   * 校验并确定作用域。
   *
   * 用户提交了一个请求没有提供的作用域时降级到 `once` 而不是报错：这通常是
   * UI 与后端版本不一致造成的，此时按最小权限处理比拒绝整个操作更合理。
   */
  #resolveScope(request: ApprovalRequest, requested: GrantScope | undefined): GrantScope {
    if (request.scopeOptions.length === 0) return 'once';
    if (requested !== undefined && request.scopeOptions.includes(requested)) return requested;
    // 没选就取最保守的那个，而不是列表第一个——顺序不该影响安全默认值
    const order: readonly GrantScope[] = ['once', 'session', 'project', 'always'];
    return order.find((s) => request.scopeOptions.includes(s)) ?? 'once';
  }

  /**
   * 确定到期时刻（需求 17.5）。
   *
   * 顺序：用户选的（且在提供的档位内）→ 该作用域的默认值 → 不过期。
   *
   * `once` 恒为 null：它不产生持久授权，一个到期时刻对它没有意义，而写上一个会让
   * 调用方误以为要落库。
   */
  #expiryFor(
    request: ApprovalRequest,
    scope: GrantScope,
    requested: number | null | undefined,
  ): number | null {
    if (scope === 'once') return null;

    if (requested !== undefined && request.expiryOptions.includes(requested)) {
      return requested === null ? null : this.#now() + requested;
    }

    const fallback = SCOPE_DEFAULT_DURATION_MS[scope];
    return fallback === null || fallback === 0 ? null : this.#now() + fallback;
  }

  #settle(id: string, result: ApprovalResult): void {
    const waiter = this.#waiters.get(id);
    if (waiter === undefined) return;

    this.#waiters.delete(id);
    if (waiter.timer !== null) clearTimeout(waiter.timer);

    const note = 'note' in result ? (result.note ?? null) : null;
    const dbState =
      result.state === 'approved'
        ? 'approved'
        : result.state === 'denied'
          ? 'denied'
          : result.state === 'timeout'
            ? 'timeout'
            : 'abandoned';
    this.#repo.settle(id, dbState, note);

    waiter.resolve(result);
  }

  #denialKey(
    conversationId: string | null,
    kind: ApprovalRequest['kind'],
    payload: unknown,
  ): string {
    return `${conversationId ?? ''}|${approvalFingerprint(kind, payload)}`;
  }

  /**
   * 查询此前是否拒绝过同一请求。
   *
   * 与自动拒绝分开暴露：UI 可以在审批卡片上提示「你此前拒绝过类似请求」，
   * 让用户带着这个上下文做决定。这与「直接替他拒绝」是两件事——前者提供信息，
   * 后者代替判断。
   */
  priorDenialOf(
    kind: ApprovalRequest['kind'],
    payload: unknown,
    conversationId: string | null,
  ): { note: string | null; decidedAt: number } | null {
    const row = this.#repo.priorDenial(kind, payload, conversationId);
    return row === null ? null : { note: row.note, decidedAt: row.decidedAt ?? row.requestedAt };
  }

  /** 列出待决议的审批，供 UI 恢复显示（例如重新打开窗口后）。 */
  pending(): readonly PendingApproval[] {
    return [...this.#waiters.values()].map((w) => ({
      request: w.request,
      conversationId: w.conversationId,
      requestedAt: w.requestedAt,
      deadline: w.deadline,
    }));
  }

  /**
   * 撤销此前的拒绝记忆，让同一请求可以重新发起（需求 17.5 的「随时撤销」的
   * 对偶：用户改变主意时应该能重新被询问）。
   */
  forgetDenial(
    kind: ApprovalRequest['kind'],
    payload: unknown,
    conversationId: string | null,
  ): void {
    this.#denied.delete(this.#denialKey(conversationId, kind, payload));
  }

  /**
   * 按审批 id 撤销拒绝记忆。
   *
   * 比 `forgetDenial` 好用的地方是调用方不必重构出当初的 payload——界面上用户看到的是
   * 一条历史记录，而从那条记录反推 payload 要求 UI 复制一份指纹逻辑。
   *
   * 返回是否命中。返回假说明那条记录不是被拒绝的，或者它的载荷已经读不出来了。
   */
  forgetDenialById(approvalId: string): boolean {
    const row = this.#repo.get(approvalId);
    if (row === null || row.state !== 'denied') return false;
    this.forgetDenial(row.kind, row.request.payload, row.conversationId);
    return true;
  }

  /**
   * 审批历史（需求 17.1、17.2 的可核查面）。
   *
   * 落盘的目的一直是留审计痕迹（见 `ApprovalRepo` 的文件头），但在这之前它没有出口——
   * 「谁在什么时候批准了删除哪个制品」在库里有答案而界面上问不出来，那等于没有审计。
   *
   * 一并给出**当前是否仍在拒绝记忆里**：数据库里的 denied 行是历史，而拒绝记忆是
   * 进程内的、决定「现在还会不会被自动拒绝」的那份。两者在界面上必须分开——用户看到
   * 一条三天前的拒绝记录时，他想知道的是「现在还挡着吗」。
   */
  history(
    options: { conversationId?: string; state?: ApprovalState; limit?: number } = {},
  ): readonly (ApprovalRow & { stillDenied: boolean })[] {
    return this.#repo.list(options).map((row) => ({
      ...row,
      stillDenied:
        row.state === 'denied' &&
        this.#denied.has(this.#denialKey(row.conversationId, row.kind, row.request.payload)),
    }));
  }

  /** 取消某个等待中的审批。用于会话被中止等场景。 */
  cancel(approvalId: string, reason: string): boolean {
    if (!this.#waiters.has(approvalId)) return false;
    this.#settle(approvalId, { state: 'cancelled', reason });
    return true;
  }

  /**
   * 关闭服务，取消全部等待中的审批。
   *
   * 必须把等待者一一 resolve 而不是直接丢弃：丢弃会让 await 它们的调用方
   * 永久挂起，进程也就永远关不掉。
   */
  close(reason = '后端正在关闭'): void {
    this.#closed = true;
    for (const id of [...this.#waiters.keys()]) {
      this.#settle(id, { state: 'cancelled', reason });
    }
  }
}
