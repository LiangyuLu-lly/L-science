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

/* ------------------------------------------------------------------ *
 * 算力环境笔记的内容门（任务 14.3，需求 14.5）
 * ------------------------------------------------------------------ */

/*
 * 需求 14.5 把环境笔记的内容限定成「该环境自身的知识」，并明确**不得写入项目内容
 * 或分析结果**。分析结果由通用规则（STAT_RESULT）挡住，项目内容需要单独一道门。
 *
 * 这道门为什么必须存在：环境笔记是**跨项目共享**的。一条写着「本研究的被试是 24 名
 * 健康成人」的环境笔记，会在这台集群被用到的每一个项目里注入——包括另一个研究方向
 * 完全不同的项目。那不只是噪声，它会让模型在项目 B 里引用项目 A 的事实。
 *
 * 判定分两步，顺序是刻意的：
 *
 * 1. **不可能是环境事实的研究内容标记** → 直接拒，并告诉它该用哪个作用域。
 *    这一档的措辞比第二档具体，因此排在前面。
 * 2. **没有任何环境信号** → 拒。这一步比黑名单强得多：黑名单只能挡住列进去的词，
 *    而「这个集群很好用」这类空话没有任何黑名单词却同样不该进。
 *
 * 刻意不做的事：不按「提到了被试」就拒。`数据在 /scratch/eeg 下按被试编号分目录`
 * 是文件系统布局，是环境知识里最有用的一类。黑名单只收那些**永远不会**用来描述
 * 一台机器的词。
 */

/** 永远不会用来描述一台机器的研究内容标记。 */
const RESEARCH_CONTENT: readonly { re: RegExp; what: string }[] = [
  { re: /(研究问题|研究假设|科学假设)/u, what: '研究问题与假设' },
  { re: /(实验设计|被试内设计|被试间设计|随机分组|双盲试验)/u, what: '实验设计' },
  { re: /(自变量|因变量|协变量|混淆变量)/u, what: '变量角色' },
  { re: /(干预组|对照组|安慰剂|基线期|前测|后测)/u, what: '分组与时间点' },
  { re: /(量表|问卷|访谈提纲|评分表)/u, what: '测量工具' },
  { re: /(招募|伦理审查|知情同意|IRB)/u, what: '被试招募与伦理' },
  { re: /(投稿|审稿|返修|期刊要求|参考文献|文献综述)/u, what: '论文与投稿' },
  { re: /(显著性|效应量|置信区间|统计功效|多重比较校正)/u, what: '统计方法与结论' },
  { re: /(我们的(研究|论文|结论|发现)|本研究(的|中)?(结论|发现|结果))/u, what: '本研究的结论' },
];

/**
 * 环境信号。命中任意一条就算「在说这台机器」。
 *
 * 列得宽是刻意的：漏掉一类合法的环境知识（比如「管理员周三上午维护」没有任何路径或
 * 调度器词）会让模型在写一条正确的笔记时被拒，而被拒几次之后它就不再写了——那等于
 * 把需求 14.5 想要的东西整个关掉。
 */
const ENVIRONMENT_SIGNALS: readonly RegExp[] = [
  // 绝对路径与家目录相对路径。文件系统布局是环境知识里最常见的一类
  /(^|[\s（(「"'`])[~/][\w./~-]{2,}/u,
  // Windows 盘符路径
  /\b[A-Za-z]:[\\/][\w\\/.-]+/u,
  // 分区、队列、账户、节点
  /(分区|队列|partition|queue|账户|account|记账|节点|node|机时|配额|quota|限额)/iu,
  // 调度器与它的命令
  /\b(slurm|pbs|torque|lsf|sge|sbatch|squeue|sacct|scontrol|srun|salloc|scancel|qsub|qstat|qdel|bsub)\b/iu,
  // 墙钟、排队、优先级这类调度器行为
  /(墙钟|walltime|超时被杀|排队|优先级|抢占|preempt|作业上限|并发上限)/iu,
  // 环境激活方式
  /\b(module\s+(load|avail|list)|conda|mamba|micromamba|venv|virtualenv|pyenv|spack|easybuild|source\s+\S+activate)\b/iu,
  /(激活环境|环境变量|PATH|LD_LIBRARY_PATH|PYTHONPATH|CUDA_VISIBLE_DEVICES)/u,
  /*
   * 硬件与接入方式分成 ASCII 与中文两组。
   *
   * 中文词**不能**放进 `\b...\b`：`\b` 按 `[A-Za-z0-9_]` 判定，`经跳板机` 里 `经` 与
   * `跳` 都不是 word 字符，两者之间没有边界，于是 `/\b跳板机/` 永远匹配不上。
   * 这个坑在 STAT_RESULT 那边已经踩过一次（`/\b均值/`），写测试时又撞到了第二次。
   */
  /\b(gpu|cpu|nvidia|cuda|a100|h100|v100|rtx|sm_\d+)\b/iu,
  /(显存|内存|核数|架构|算力版本)/u,
  // 存储与文件系统
  /\b(lustre|gpfs|beegfs|nfs|scratch|home|work|tmpdir|inode)\b/iu,
  /(文件系统|挂载|磁盘|软链接|只读挂载|清理策略|保留期)/u,
  // 接入方式
  /\b(ssh|scp|rsync|sftp|proxyjump|known_hosts|ssh-agent|vpn)\b/iu,
  /(跳板机|公钥|私钥|端口|代理|直连|登录方式|免密)/u,
  /*
   * 运维事实。
   *
   * `维护` 收成裸词而不是 `维护窗口|维护时间`：实际写法里「例行维护」「周三维护」
   * 都很常见，而收窄成固定搭配的结果是一条完全正确的笔记被拒。
   *
   * 刻意**不收** `集群` / `机器` / `服务器`：收了之后「这个集群很好用」就会通过，
   * 而那正是第二道门要挡住的那类空话。
   */
  /(管理员|运维|维护|停机|例行重启|排空|工单|公告|登录节点|计算节点)/u,
  // 主机名形态（含点且不是句子里的省略号）
  /\b[a-z0-9-]+\.[a-z0-9-]+\.[a-z]{2,}\b/iu,
];

/** 环境笔记该写什么，附在拒绝理由后面。 */
export function environmentNoteGuidance(): string {
  return [
    '算力环境笔记只收**这台机器自身的知识**（需求 14.5），而且它是**跨项目共享**的——',
    '同一台集群在你所有项目里看到的是同一份笔记。因此它不该包含任何单个项目的内容。',
    '',
    '该写的：',
    '- 分区与队列（「gpu 分区最长 24 小时，long 分区要走审批」）',
    '- 账户与配额（「记账账户是 lab-a，每月 5000 机时」）',
    '- 文件系统布局（「/scratch 30 天清理，家目录只有 20 GB」）',
    '- 环境激活方式（「先 module load python/3.11 再 conda activate，顺序反了会用到系统 python」）',
    '- 调度器的坑（「不给 --time 会用默认 10 分钟然后被杀，报错里不提墙钟」）',
    '- 接入方式（「要经跳板机 bastion，直连不通」）',
    '- 运维事实（「周三 8-10 点例行维护，作业会被排空」）',
    '',
    '不该写的：研究问题、实验设计、被试与分组、统计结论、投稿相关——',
    '那些属于**项目**作用域（scope=project），换个项目就不成立了。',
  ].join('\n');
}

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

  /*
   * 算力环境笔记的内容门（需求 14.5）。
   *
   * 放在最后：前面那些规则对所有作用域都成立，而这一档只针对 compute。顺序反过来的话，
   * 一条既有统计结果又不像环境知识的笔记会先撞上这一档，得到的建议是「加上路径或分区」
   * ——而它真正的问题是里面有个 p 值。
   */
  if (input.scope === 'compute') {
    const verdict = classifyEnvironmentNote(content);
    if (!verdict.ok) return verdict;
  }

  return OK;
}

/**
 * 判定一条候选**环境笔记**（需求 14.5）。
 *
 * 单独导出，因为它也用在算力目标详情页的「这条笔记为什么被拒」提示上，而那里没有
 * 完整的记忆候选上下文。
 */
export function classifyEnvironmentNote(content: string): MemoryVerdict {
  for (const rule of RESEARCH_CONTENT) {
    const hit = rule.re.exec(content);
    if (hit !== null) {
      return {
        ok: false,
        rule: 'project-content-in-environment-note',
        reason:
          `这条笔记里有项目内容（${rule.what}：「${hit[0]}」），而环境笔记是**跨项目共享**的。\n` +
          '写进来之后，这台机器被用到的每一个项目都会看到它——包括研究方向完全不同的项目，' +
          '而模型会在那里把它当成现成事实引用。\n' +
          '这类内容请改用 scope=project 写进项目记忆。\n\n' +
          environmentNoteGuidance(),
      };
    }
  }

  const hasSignal = ENVIRONMENT_SIGNALS.some((re) => re.test(content));
  if (!hasSignal) {
    return {
      ok: false,
      rule: 'not-environment-knowledge',
      reason:
        '这条笔记里看不出在说这台机器的哪一方面。\n' +
        '环境笔记要落到具体的环境事实上——路径、分区、账户、调度器行为、环境激活方式、' +
        '接入方式或运维安排。「这台机器很快」「用起来还行」这类判断换个时间就不成立，' +
        '而且对下一个会话没有可操作的价值。\n\n' +
        environmentNoteGuidance(),
    };
  }

  return OK;
}
