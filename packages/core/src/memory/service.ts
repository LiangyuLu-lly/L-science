/**
 * Memory Service（任务 12.9，需求 16.1-16.4）。
 *
 * 职责有两块：**准入**与**注入**。
 *
 * 准入把一次性细节挡在外面（`classify.ts`）并给作用域设上限。上限是必要的：记忆会
 * 进每一轮的系统提示词，无上限的记忆最终会把上下文预算吃掉，然后表现为「模型越用
 * 越笨」——因为真正的任务内容被挤到了后面。
 *
 * 注入按预算裁剪，并且**按类别优先级**而不是纯按时间：约定与既定决策直接影响分析
 * 是否正确，用户偏好只影响舒适度。纯按时间排序时，一条刚写的「图表用深色主题」会
 * 把「本项目统一用混合效应模型」挤出预算。
 */

import type { MemoryKind, MemoryNote, MemoryRepo, MemoryScope } from '../repo/memory.js';
import { classifyMemoryCandidate, memoryGuidance, type MemoryVerdict } from './classify.js';

/**
 * 各作用域的条数上限。
 *
 * 数值取自「注入预算 / 单条平均长度」：预算 6000 字符、单条平均 120 字符左右，
 * 大约能装 50 条。上限设得比这略高，让「超了要合并」这件事发生在注入被截断之前——
 * 截断是静默的，而写入被拒是可见的。
 */
export const MEMORY_LIMITS: Readonly<Record<MemoryScope, number>> = {
  global: 40,
  project: 80,
  compute: 30,
};

/** 注入进系统提示词的字符预算。 */
const INJECTION_BUDGET = 6_000;

/**
 * 注入顺序。
 *
 * 越靠前越不容易被预算截掉。约定与决策排在最前面，因为它们决定分析做得对不对；
 * 偏好排最后，它只影响呈现方式。
 */
const KIND_PRIORITY: readonly MemoryKind[] = [
  'convention',
  'decision',
  'data',
  'background',
  'environment',
  'preference',
];

const KIND_LABEL: Readonly<Record<MemoryKind, string>> = {
  preference: '用户偏好',
  background: '项目背景',
  convention: '术语与约定',
  decision: '既定决策',
  data: '数据说明',
  environment: '算力环境',
};

export interface MemoryServiceOptions {
  repo: MemoryRepo;
  /** 校验算力目标是否存在。compute 作用域用它挡掉写给不存在目标的笔记。 */
  computeTargetExists?: (targetId: string) => boolean;
  onLog?: (line: string) => void;
}

export type RememberResult =
  | { ok: true; note: MemoryNote; created: boolean; deduped: boolean }
  | { ok: false; reason: string; rule: string | null };

export class MemoryService {
  readonly #repo: MemoryRepo;
  readonly #targetExists: (targetId: string) => boolean;
  readonly #onLog: (line: string) => void;

  constructor(options: MemoryServiceOptions) {
    this.#repo = options.repo;
    this.#targetExists = options.computeTargetExists ?? ((): boolean => true);
    this.#onLog = options.onLog ?? ((): void => {});
  }

  get repo(): MemoryRepo {
    return this.#repo;
  }

  /**
   * 写入一条记忆。
   *
   * 返回失败而不是抛错：被拒绝是**正常结果**（需求 16.4 要求的正是「拒绝一部分写入」），
   * 用异常表达会让调用方倾向于 catch 之后忽略。
   */
  remember(input: {
    scope: MemoryScope;
    scopeId?: string | null;
    kind: MemoryKind;
    content: string;
    reason: string;
    replaceId?: string;
  }): RememberResult {
    const verdict: MemoryVerdict = classifyMemoryCandidate({
      scope: input.scope,
      kind: input.kind,
      content: input.content,
      reason: input.reason,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, rule: verdict.rule };

    if (input.scope === 'project' && !this.#repo.hasProjectScope) {
      return {
        ok: false,
        rule: 'no-project-context',
        reason: '当前没有项目上下文，无法写入项目作用域的记忆。',
      };
    }

    if (input.scope === 'compute') {
      const targetId = (input.scopeId ?? '').trim();
      if (targetId === '') {
        return {
          ok: false,
          rule: 'missing-target',
          reason:
            'compute 作用域必须指定算力目标 id：不指名的话「这个集群的分区叫 gpu」' +
            '会被套到所有集群上。',
        };
      }
      if (!this.#targetExists(targetId)) {
        return {
          ok: false,
          rule: 'unknown-target',
          reason: `算力目标不存在：${targetId}。先登记算力目标再给它写笔记。`,
        };
      }
    }

    // 替换既有条目不受条数上限约束：它不会让记忆变多，正是我们希望鼓励的行为
    if (input.replaceId === undefined) {
      const limit = MEMORY_LIMITS[input.scope];
      const current = this.#repo.count(
        input.scope,
        input.scope === 'compute' ? (input.scopeId ?? undefined) : undefined,
      );
      if (current >= limit) {
        return {
          ok: false,
          rule: 'limit-reached',
          reason:
            `${input.scope} 作用域已有 ${String(current)} 条记忆，达到上限 ${String(limit)}。\n` +
            '记忆会进每一轮的系统提示词，无上限地增长会把上下文预算吃掉。' +
            '请先用 recall_memory 看一遍，把相近的几条合并成一条（用 replaceId 替换），' +
            '或者删掉已经过时的。',
        };
      }
    }

    try {
      const result = this.#repo.upsert({
        scope: input.scope,
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        kind: input.kind,
        content: input.content,
        reason: input.reason,
        ...(input.replaceId === undefined ? {} : { replaceId: input.replaceId }),
      });
      return { ok: true, note: result.note, created: result.created, deduped: result.deduped };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#onLog(`记忆写入失败：${message}`);
      return { ok: false, rule: 'write-failed', reason: message };
    }
  }

  /** 列出记忆。用于 recall 工具与 UI 审查（需求 16.3）。 */
  list(
    options: { scope?: MemoryScope; scopeId?: string; kind?: MemoryKind } = {},
  ): readonly MemoryNote[] {
    return this.#repo.list(options);
  }

  delete(id: string): boolean {
    return this.#repo.delete(id);
  }

  /**
   * 生成注入进系统提示词的记忆段落。
   *
   * `computeTargetIds` 决定要不要带上算力环境笔记：不在用远程算力时带上它们是纯噪声，
   * 而噪声会挤掉真正相关的内容。
   */
  injection(options: { computeTargetIds?: readonly string[] } = {}): string {
    const notes: MemoryNote[] = [
      ...this.#repo.list({ scope: 'global' }),
      ...(this.#repo.hasProjectScope ? this.#repo.list({ scope: 'project' }) : []),
    ];

    for (const targetId of options.computeTargetIds ?? []) {
      notes.push(...this.#repo.list({ scope: 'compute', scopeId: targetId }));
    }

    if (notes.length === 0) return '';

    notes.sort((a, b) => {
      const byKind = KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
      // 同类别里新的在前：修正过的版本应该比旧的更可信
      return byKind !== 0 ? byKind : b.updatedAt - a.updatedAt;
    });

    const lines: string[] = [];
    let used = 0;
    let dropped = 0;
    let lastKind: MemoryKind | null = null;

    for (const note of notes) {
      const prefix = note.kind === lastKind ? '' : `\n${KIND_LABEL[note.kind]}：\n`;
      const line = `${prefix}- ${note.content.replace(/\n+/g, ' ')}`;

      if (used + line.length > INJECTION_BUDGET) {
        dropped += 1;
        continue;
      }
      used += line.length;
      lines.push(line);
      lastKind = note.kind;
    }

    if (dropped > 0) {
      /*
       * 被截掉多少条要说出来。
       *
       * 静默截断会让模型以为它看到的就是全部记忆，然后在「我记得你说过 X」这件事上
       * 出现无法解释的不一致——用户明明写过，模型却不知道。
       */
      lines.push(
        `\n（还有 ${String(dropped)} 条记忆因为长度预算未展示。` +
          '需要时用 recall_memory 查看全部。）',
      );
      this.#onLog(`记忆注入截断了 ${String(dropped)} 条，建议合并`);
    }

    return lines.join('\n').trim();
  }

  /** 给模型看的写入指引。工具描述与拒绝理由都用它，避免两处说法不一致。 */
  static guidance(): string {
    return memoryGuidance();
  }
}
