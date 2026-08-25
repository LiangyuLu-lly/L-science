/**
 * 审批与用户交互（需求 17）。
 *
 * 两个服务：`ApprovalService` 处理「放行或不放行」，`QuestionService` 处理
 * 「获取一段信息」。两者共享同一种等待机制，但结果类型不同——合成一个服务会
 * 让返回类型变成 `boolean | string`，每个调用点都得先判断拿到的是哪种。
 */

export { ApprovalService } from './service.js';
export type { ApprovalServiceOptions } from './service.js';

export { QuestionService } from './questions.js';
export type { QuestionDraft, QuestionResult, QuestionServiceOptions } from './questions.js';

export { approvalFingerprint, stableStringify } from './types.js';
export type { ApprovalDraft, ApprovalResult, PendingApproval } from './types.js';
