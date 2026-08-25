/**
 * 审批的类型定义（需求 17）。
 */

import type { ApprovalKind, ApprovalRequest, GrantScope } from '@l-science/shared';

/**
 * 审批结果。
 *
 * 刻意把「拒绝」与「超时」分成两种状态，而不是都归为 `false`。两者都必须阻止
 * 操作继续，但**重试语义相反**：显式拒绝表达了用户的意志，不允许再问
 * （需求 17.3）；超时只说明用户当时不在，稍后重新发起是合理的。
 * 合成一个布尔值会让这个区别在代码里无法表达，结果必然是二者之一被错误处理。
 */
export type ApprovalResult =
  | { state: 'approved'; note?: string; scope: GrantScope; expiresAt: number | null }
  | { state: 'denied'; note?: string; fromPriorDenial: boolean }
  | { state: 'timeout'; waitedMs: number }
  | { state: 'cancelled'; reason: string };

/** 发起审批时提供的信息。id 由服务生成。 */
export interface ApprovalDraft {
  kind: ApprovalKind;
  title: string;
  detail: string;
  impact: string;
  reversible: boolean;
  undoHint?: string | null;
  /** 可选的授权作用域。省略时视为一次性确认。 */
  scopeOptions?: readonly GrantScope[];
  payload: unknown;
  /** 所属会话。用于把拒绝记忆限定在会话内，也用于持久化关联。 */
  conversationId?: string | null;
  /**
   * 等待上限。超过后返回 timeout 而不是继续挂着。
   *
   * 默认值刻意较长（10 分钟）：审批常常需要用户离开屏幕去确认一些事情
   * （比如看看那个文件到底是什么），几十秒的超时会把正常使用变成反复重试。
   */
  timeoutMs?: number;
}

/**
 * 请求指纹，用于识别「同一请求」（需求 17.3）。
 *
 * 只由种类与载荷决定，不含 id 与时间——否则每次发起都是新指纹，拒绝记忆
 * 永远命中不了，agent 可以无限次拿同一件事去烦用户。
 */
export function approvalFingerprint(kind: ApprovalKind, payload: unknown): string {
  return `${kind}:${stableStringify(payload)}`;
}

/**
 * 稳定序列化：对象键按字典序排列。
 *
 * `JSON.stringify` 保留插入顺序，因此 `{a:1,b:2}` 与 `{b:2,a:1}` 会得到不同
 * 字符串。用它做指纹会让「同一个请求」因为构造顺序不同而算成两个，
 * 拒绝记忆随之失效——而这种失效是无声的。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 已发起但未决议的审批，供 UI 列出待办。 */
export interface PendingApproval {
  request: ApprovalRequest;
  conversationId: string | null;
  requestedAt: number;
  /** 超时时刻。null 表示不超时。 */
  deadline: number | null;
}
