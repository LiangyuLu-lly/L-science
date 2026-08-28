/**
 * 记忆写入的准入判定（任务 12.9，需求 16.4）。
 *
 * 需求 16.4 说「不应将会话中的一次性细节写入长期记忆」。这条只靠提示词是守不住的：
 * 模型在一次成功的分析之后最想记下来的恰恰是那次的结果（「额叶的 p 值是 0.03」），
 * 而那不是记忆，是结论——结论属于制品与断言，它有版本、有血缘、可以被重算。
 *
 * 写进记忆的后果很具体：记忆会被注入**每一个**后续会话的系统提示词。几十次会话
 * 之后，注入预算被一堆过期的具体数字占满，而真正该记住的「本项目被试编号是
 * S01-S24」被挤掉。更糟的是那些数字会被模型当成现成事实引用，而它们可能早就
 * 因为重新分析而变了。
 *
 * 因此这里做**确定性拦截**，并且每条拒绝都要说清「该改写成什么」——只说「不许写」
 * 会让模型放弃使用记忆，那等于把这个能力关掉。
 */

import type { MemoryKind, MemoryScope } from '../repo/memory.js';

export interface MemoryVerdict {
  ok: boolean;
  /** 不通过的原因，直接回给模型。要包含改写建议。 */
  reason: string;
  /** 命中的规则名，便于测试与排查。 */
  rule: string | null;
}

const OK: MemoryVerdict = { ok: true, reason: '', rule: null };

/** 内容下限。比这更短的东西承载不了一条可复用的知识。 */
const MIN_CHARS = 8;
/**
 * 内容上限。
 *
 * 记忆会进每一轮的系统提示词，一条 2000 字的笔记等于每轮多花两千字预算。
 * 真需要长文档的话应该写成技能或制品——它们是按需加载的。
 */
const MAX_CHARS = 1_200;

/**
 * 一次性细节的时间指代。
 *
 * 只列指向「当下这一轮」的词。刻意不含「以前」「历来」这类指向长期习惯的表达，
 * 那些恰恰是记忆该收的内容。
 */
const EPISODIC_TIME =
  /(刚才|刚刚|这次|本次|这一轮|这一次|上一个\s*cell|上一步|接下来我|现在正在|正在跑|今天|昨天|明天|稍后|马上)/;

/** 完成陈述。它描述的是一个已经发生的动作，不是可复用的知识。 */
const COMPLETION = /(已完成|已经完成|已保存|已生成|已导出|跑完了|执行成功|运行成功|成功保存)/;

/**
 * 具体的统计结果。
 *
 * 模式收得很窄：必须是「统计量 = 具体数值」的形状。这样「用 p < .05 作为显著性
 * 阈值」这类**约定**不会被误伤——它没有具体的观测值，只有阈值语境。
 */
const STAT_RESULT: readonly RegExp[] = [
  /\bp\s*[=＝]\s*0?\.\d/i,
  /\bp\s*值\s*(是|为)\s*0?\.\d/,
  /\b(mean|SD|SEM|M)\s*[=＝]\s*-?\d/i,
  /\b[rt]\s*\(\s*\d+\s*\)\s*[=＝]/i,
  /\bF\s*\(\s*\d+\s*,\s*\d+\s*\)\s*[=＝]/i,
  /\b(OR|RR|HR|AUC|ICC|R2|R²|Cohen'?s?\s*d|β|beta)\s*[=＝]\s*-?\d/i,
  /95%\s*(CI|置信区间)\s*[=＝[（(]/i,
  /\bn\s*[=＝]\s*\d+\s*(时|的时候)?[，,。]?\s*(结果|发现|显示)/i,
  /*
   * 中文统计量名不能用 `\b` 打头。
   *
   * `\b` 是按 `[A-Za-z0-9_]` 判定的：`的均值` 里 `的` 与 `均` 都不是 word 字符，
   * 两者之间没有边界，于是 `/\b均值/` 永远匹配不上。写测试时就撞到了——
   * 「睡眠效率的均值 = 82.4」被放行了。
   */
  /(均值|平均值|中位数|标准差|标准误)\s*[=＝]\s*-?\d/,
  /(均值|平均值|中位数)\s*(是|为)\s*-?\d/,
];

/** 一次性的对象 id。指向某一次执行的产物或记录，换个会话就没有意义。 */
const EPISODIC_ID: readonly RegExp[] = [
  /\bav_[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\bfd_[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\bap_[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\bpl_[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\bbg_[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\brr_[0-9a-f]{8}-[0-9a-f]{4}/i,
];

/** 各类别允许的作用域。 */
const KIND_SCOPES: Readonly<Record<MemoryKind, readonly MemoryScope[]>> = {
  preference: ['global', 'project'],
  background: ['project'],
  convention: ['global', 'project'],
  decision: ['project'],
  data: ['project'],
  environment: ['compute'],
};

const KIND_HINT: Readonly<Record<MemoryKind, string>> = {
  preference: '用户偏好与工作习惯（例如「图表默认用 300 dpi」「统计结果要带效应量」）',
  background: '项目背景（研究问题、被试来源、采集设置这类长期不变的事实）',
  convention: '术语与命名约定（例如「被试编号用 S01-S24」「事件标记 N2 指第二阶段」）',
  decision: '既定决策（例如「本项目统一用混合效应模型而不是重复测量 ANOVA」及其理由）',
  data: '数据说明（文件布局、字段含义、已知缺陷与坑）',
  environment: '算力环境笔记（分区、账户、文件系统布局、环境激活方式、调度器的坑）',
};

/** 记忆该收什么，给模型看的一段说明。拒绝时附上它，让模型知道怎么改。 */
export function memoryGuidance(): string {
  return [
    '记忆存的是**跨会话仍然成立的知识**：约定、背景、既定决策、环境事实、用户偏好。',
    '不存这一轮发生了什么、也不存具体的分析结果——那些属于制品与断言，它们有版本与血缘，',
    '而记忆没有；把结果写进记忆之后，它会被后续每个会话当成现成事实引用，',
    '哪怕重新分析之后早就变了。',
    '',
    ...Object.entries(KIND_HINT).map(([kind, hint]) => `- \`${kind}\`：${hint}`),
  ].join('\n');
}

/**
 * 判定一条候选记忆能不能写。
 *
 * 返回不通过时 `reason` 已经是可以直接回给模型的完整说明。
 */
export function classifyMemoryCandidate(input: {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  reason: string;
}): MemoryVerdict {
  const content = input.content.trim();

  if (content.length < MIN_CHARS) {
    return {
      ok: false,
      rule: 'too-short',
      reason:
        `内容太短（${String(content.length)} 字），承载不了一条可复用的知识。` +
        '把它写成一句完整的、离开当前上下文也读得懂的陈述。',
    };
  }

  if (content.length > MAX_CHARS) {
    return {
      ok: false,
      rule: 'too-long',
      reason:
        `内容 ${String(content.length)} 字，超过 ${String(MAX_CHARS)} 字上限。` +
        '记忆会被注入每一轮的系统提示词，长笔记等于每轮都多花这些预算。' +
        '需要长文档的话请写成技能（按需加载）或存为制品。',
    };
  }

  if (input.reason.trim().length < 4) {
    return {
      ok: false,
      rule: 'no-reason',
      reason:
        '必须说明为什么要长期记住它（需求 16.2）。理由是用户日后审查记忆时' +
        '判断该不该留的唯一依据，「重要」这类话起不到这个作用。',
    };
  }

  const allowedScopes = KIND_SCOPES[input.kind];
  if (!allowedScopes.includes(input.scope)) {
    return {
      ok: false,
      rule: 'scope-mismatch',
      reason:
        `类别 ${input.kind} 不能用 ${input.scope} 作用域，只能用 ${allowedScopes.join(' / ')}。` +
        `\n${input.kind}：${KIND_HINT[input.kind]}`,
    };
  }

  const timeHit = EPISODIC_TIME.exec(content);
  if (timeHit !== null) {
    return {
      ok: false,
      rule: 'episodic-time',
      reason:
        `内容里有指向当前这一轮的说法（「${timeHit[0]}」），这是一次性细节而不是长期知识。\n` +
        memoryGuidance(),
    };
  }

  const completionHit = COMPLETION.exec(content);
  if (completionHit !== null) {
    return {
      ok: false,
      rule: 'completion',
      reason:
        `内容描述的是一个已经发生的动作（「${completionHit[0]}」）。` +
        '做过什么在会话历史与制品血缘里已经有记录，不需要也不应该进记忆。\n' +
        memoryGuidance(),
    };
  }

  for (const pattern of STAT_RESULT) {
    const hit = pattern.exec(content);
    if (hit !== null) {
      return {
        ok: false,
        rule: 'stat-result',
        reason:
          `内容里有具体的统计结果（「${hit[0].trim()}」）。结果属于制品与断言——它们有` +
          '版本与血缘，可以被重算和核对；而记忆没有，写进来之后它会被后续会话当成' +
          '现成事实引用，哪怕重新分析之后早就变了。\n' +
          '如果你想记住的是**方法上的约定**（比如「显著性阈值用 p < .05 并做 FDR 校正」），' +
          '把具体数值去掉重写一遍。',
      };
    }
  }

  for (const pattern of EPISODIC_ID) {
    const hit = pattern.exec(content);
    if (hit !== null) {
      return {
        ok: false,
        rule: 'episodic-id',
        reason:
          `内容里有一次性的对象 id（${hit[0]}）。它指向某一次执行的产物或记录，` +
          '换个会话就没有意义了。要引用产物请在会话里用制品工具，不要写进记忆。',
      };
    }
  }

  return OK;
}
