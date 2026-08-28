/**
 * 计划校验（任务 12.5，需求 10.2、10.3）。
 *
 * 分两级：
 *
 * - **error**：计划做不到，不允许执行。绑定了不存在的技能、声明了没注册的工具、
 *   依赖成环——这些在执行时才失败，而那时用户已经批准了整个计划，等于批准了一个
 *   做不到的承诺。
 * - **warning**：计划可能有问题，展示给用户但不阻止。硬编码数值、缺少产物声明
 *   这类判断是启发式的，硬拦会拦掉合法的计划。
 *
 * 每条问题都要带**可执行的修正建议**。「步骤 s3 绑定的技能不存在」只说了症状，
 * 「可用的相近技能是 sleep-staging」才能让模型自己改对。
 */

import type { PlanSpec, PlanStepSpec } from './spec.js';
import { planBatches } from './spec.js';

export type PlanIssueCode =
  | 'unknown-skill'
  | 'disabled-skill'
  | 'skill-requirements-missing'
  | 'unknown-tool'
  | 'unknown-dependency'
  | 'dependency-cycle'
  | 'cross-phase-dependency'
  | 'hardcoded-value'
  | 'no-produces'
  | 'orphan-dependency'
  | 'parallel-with-dependency';

export interface PlanIssue {
  severity: 'error' | 'warning';
  code: PlanIssueCode;
  /** 相关步骤的 ref。与整体计划有关时为 null。 */
  stepRef: string | null;
  message: string;
  remediation: string;
}

export interface ValidatePlanInput {
  spec: PlanSpec;
  /** 当前**已启用**的技能 slug。 */
  availableSkills: ReadonlySet<string>;
  /** 已登记但被禁用的技能。区分它与「不存在」，两者的修正办法不同。 */
  disabledSkills?: ReadonlySet<string>;
  /** 当前已注册的工具名。 */
  availableTools: ReadonlySet<string>;
  /** 依赖未满足的技能 slug → 缺失说明。绑定它们不是错误，但要提醒。 */
  skillsWithMissingRequirements?: ReadonlyMap<string, string>;
}

/* ------------------------------------------------------------------ *
 * 硬编码数值检测（需求 10.3）
 * ------------------------------------------------------------------ */

/**
 * 带单位的数值。
 *
 * 这些单位在本领域里几乎总意味着一个「有权威来源」的阈值或参数：
 * 幅度阈值、频段边界、时长判据、采样率。写在计划里就是从记忆里取的。
 */
const UNIT_PATTERN =
  /(\d+(?:\.\d+)?)\s*(µV|uV|μV|mV|Hz|hz|kHz|ms|毫秒|秒|s\b|min\b|分钟|小时|h\b|dB|%|次\/分)/g;

/**
 * 阈值语境里的裸数值。
 *
 * 没有单位但出现在「阈值」「取」「设为」「大于」这类词附近的数值，同样可疑。
 * 只看这些关键词而不是所有数值：步骤里的「分 5 折交叉验证」「重复 1000 次置换」
 * 是方法学选择而不是需要查证的领域事实，把它们也报出来会让警告失去意义。
 */
const THRESHOLD_CONTEXT =
  /(阈值|临界|截止|cutoff|threshold|判据|标准值|参考值|正常范围|取值为|设为|设定为|应为|不低于|不高于|至少|至多)[^。；\n]{0,24}?(\d+(?:\.\d+)?)/g;

export interface SuspectValue {
  value: string;
  /** 数值周围的片段，便于用户定位。 */
  context: string;
}

/** 找出一段描述里可疑的硬编码数值。 */
export function findSuspectValues(description: string): readonly SuspectValue[] {
  const found = new Map<string, SuspectValue>();

  const push = (value: string, index: number): void => {
    if (found.has(value)) return;
    const from = Math.max(0, index - 20);
    const to = Math.min(description.length, index + value.length + 20);
    found.set(value, { value, context: description.slice(from, to).replace(/\s+/g, ' ') });
  };

  for (const m of description.matchAll(UNIT_PATTERN)) {
    push(m[0].trim(), m.index);
  }
  for (const m of description.matchAll(THRESHOLD_CONTEXT)) {
    push(m[0].trim(), m.index);
  }

  return [...found.values()];
}

/**
 * 这一步的数值是否已由某个检索步骤支撑。
 *
 * 判据是「依赖链上存在标了 retrieval 的步骤」。只看直接依赖不够：
 * 常见形态是「查阈值 → 整理成参数表 → 用参数表跑分析」，第三步的直接依赖是第二步。
 */
function hasRetrievalUpstream(
  step: PlanStepSpec,
  byRef: ReadonlyMap<string, PlanStepSpec>,
): boolean {
  const seen = new Set<string>();
  const queue = [...step.dependsOn];

  while (queue.length > 0) {
    const ref = queue.shift();
    if (ref === undefined || seen.has(ref)) continue;
    seen.add(ref);

    const dep = byRef.get(ref);
    if (dep === undefined) continue;
    if (dep.retrieval) return true;
    queue.push(...dep.dependsOn);
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * 相近技能建议
 * ------------------------------------------------------------------ */

/** 找出与给定 slug 最像的可用技能，用于「你是不是想写这个」。 */
function closestSlug(target: string, candidates: Iterable<string>): string | null {
  let best: { slug: string; score: number } | null = null;

  for (const candidate of candidates) {
    const score = similarity(target, candidate);
    if (best === null || score > best.score) best = { slug: candidate, score };
  }
  // 低于 0.5 时给建议只会误导，不如不给
  return best !== null && best.score >= 0.5 ? best.slug : null;
}

/** 简单的二元组重合度。够用来抓拼写错误与单复数差异。 */
function similarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    const t = s.toLowerCase();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;

  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return (2 * shared) / (ga.size + gb.size);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

export function validatePlan(input: ValidatePlanInput): readonly PlanIssue[] {
  const { spec, availableSkills, availableTools } = input;
  const disabled = input.disabledSkills ?? new Set<string>();
  const missingReq = input.skillsWithMissingRequirements ?? new Map<string, string>();

  const issues: PlanIssue[] = [];
  const byRef = new Map(spec.steps.map((s) => [s.ref, s]));

  for (const step of spec.steps) {
    /* --- 技能绑定（需求 10.2）--- */
    if (step.skillSlug !== null) {
      if (disabled.has(step.skillSlug)) {
        issues.push({
          severity: 'error',
          code: 'disabled-skill',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 绑定的技能 ${step.skillSlug} 已被用户禁用`,
          remediation: '在设置里重新启用它，或改绑其他技能。',
        });
      } else if (!availableSkills.has(step.skillSlug)) {
        const near = closestSlug(step.skillSlug, availableSkills);
        issues.push({
          severity: 'error',
          code: 'unknown-skill',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 绑定的技能 ${step.skillSlug} 不存在`,
          remediation:
            near === null
              ? '先用 search_skills 确认有哪些技能，再绑定实际存在的 slug；确实没有对应技能时把 skillSlug 留空。'
              : `最相近的可用技能是 ${near}。先用 search_skills 确认，再改绑。`,
        });
      } else {
        const missing = missingReq.get(step.skillSlug);
        if (missing !== undefined) {
          issues.push({
            severity: 'warning',
            code: 'skill-requirements-missing',
            stepRef: step.ref,
            message: `步骤 ${step.ref} 绑定的技能 ${step.skillSlug} 的依赖尚未满足`,
            remediation: `执行到这一步之前先补齐依赖：\n${missing}`,
          });
        }
      }
    }

    /* --- 工具（需求 10.2）--- */
    for (const tool of step.tools) {
      if (availableTools.has(tool)) continue;
      const near = closestSlug(tool, availableTools);
      issues.push({
        severity: 'error',
        code: 'unknown-tool',
        stepRef: step.ref,
        message: `步骤 ${step.ref} 声明的工具 ${tool} 不可用`,
        remediation:
          near === null
            ? `当前可用工具：${[...availableTools].sort().join('、')}。`
            : `最相近的可用工具是 ${near}。当前可用：${[...availableTools].sort().join('、')}。`,
      });
    }

    /* --- 依赖 --- */
    for (const dep of step.dependsOn) {
      if (dep === step.ref) {
        issues.push({
          severity: 'error',
          code: 'dependency-cycle',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 依赖自己`,
          remediation: '去掉这条自依赖。',
        });
        continue;
      }
      if (!byRef.has(dep)) {
        issues.push({
          severity: 'error',
          code: 'unknown-dependency',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 依赖的 ${dep} 不在本计划里`,
          remediation: `可用的步骤 ref：${spec.steps.map((s) => s.ref).join('、')}。`,
        });
        continue;
      }

      const upstream = byRef.get(dep);
      if (upstream !== undefined && upstream.phase > step.phase) {
        // 依赖后面阶段的产物在时序上不可能满足
        issues.push({
          severity: 'error',
          code: 'cross-phase-dependency',
          stepRef: step.ref,
          message: `步骤 ${step.ref}（阶段 ${String(step.phase)}）依赖了阶段 ${String(upstream.phase)} 的 ${dep}`,
          remediation: '把这一步移到更后的阶段，或把被依赖的步骤移到更前的阶段。',
        });
      }

      if (upstream !== undefined && upstream.produces.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'no-produces',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 依赖 ${dep}，但 ${dep} 没有声明产物`,
          remediation:
            '在 produces 里写清它产出什么（具体的文件名或制品说明）。' +
            '步骤之间必须经文件或制品交接，写不出产物通常说明这一步实际什么都没交出去。',
        });
      }
    }

    /* --- 并行与依赖的一致性 --- */
    if (step.delegation?.parallel === true) {
      const sameBatchDep = step.dependsOn.filter((dep) => byRef.get(dep)?.phase === step.phase);
      if (sameBatchDep.length > 0) {
        issues.push({
          severity: 'warning',
          code: 'parallel-with-dependency',
          stepRef: step.ref,
          message: `步骤 ${step.ref} 标了并行，但它依赖同阶段的 ${sameBatchDep.join('、')}`,
          remediation:
            '有依赖就不可能真并行，执行器会按依赖串行化。要么去掉依赖，要么去掉 parallel 标记以免计划看起来比实际快。',
        });
      }
    }

    /* --- 硬编码数值（需求 10.3）--- */
    if (!step.retrieval) {
      const suspects = findSuspectValues(step.description);
      if (suspects.length > 0 && !hasRetrievalUpstream(step, byRef)) {
        issues.push({
          severity: 'warning',
          code: 'hardcoded-value',
          stepRef: step.ref,
          message:
            `步骤 ${step.ref} 里出现了看起来是领域阈值或参数的数值：` +
            suspects.map((s) => `${s.value}（…${s.context}…）`).join('；'),
          remediation:
            '这些数值若来自记忆则可能有误，而错了之后整条分析都错，且没有地方会发现。' +
            '正确形态是先加一步「从手册或文献确认该数值」并标 retrieval: true，' +
            '再让本步依赖它。数值确实是本次的方法学选择（比如交叉验证折数）时可以忽略这条。',
        });
      }
    }
  }

  /* --- 环 --- */
  if (planBatches(spec) === null) {
    // planBatches 返回 null 只说明存在环，具体是哪个环要自己找出来才有用
    const cycle = findCycle(spec);
    issues.push({
      severity: 'error',
      code: 'dependency-cycle',
      stepRef: cycle[0] ?? null,
      message:
        cycle.length > 0
          ? `依赖成环：${cycle.join(' → ')} → ${cycle[0] ?? ''}`
          : '依赖关系无法排出执行顺序（存在环）',
      remediation: '打断这个环。若两步真的互相需要对方的产物，说明它们应该合成一步。',
    });
  }

  /* --- 孤立步骤 --- */
  const referenced = new Set(spec.steps.flatMap((s) => s.dependsOn));
  for (const step of spec.steps) {
    if (step.phase === 1) continue;
    if (step.dependsOn.length > 0 || referenced.has(step.ref)) continue;
    issues.push({
      severity: 'warning',
      code: 'orphan-dependency',
      stepRef: step.ref,
      message: `步骤 ${step.ref} 在阶段 ${String(step.phase)}，但既不依赖任何步骤也不被依赖`,
      remediation:
        '它要么可以提到阶段 1，要么漏写了依赖。孤立的后段步骤通常意味着执行顺序没被真正想清楚。',
    });
  }

  return issues;
}

/** 找出一个具体的环，用于报告。返回环上的 ref 序列。 */
function findCycle(spec: PlanSpec): readonly string[] {
  const byRef = new Map(spec.steps.map((s) => [s.ref, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (ref: string): readonly string[] | null => {
    const current = state.get(ref);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const at = stack.indexOf(ref);
      return stack.slice(at);
    }

    state.set(ref, 'visiting');
    stack.push(ref);
    for (const dep of byRef.get(ref)?.dependsOn ?? []) {
      if (!byRef.has(dep)) continue;
      const found = visit(dep);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(ref, 'done');
    return null;
  };

  for (const step of spec.steps) {
    const found = visit(step.ref);
    if (found !== null) return found;
  }
  return [];
}

/** 计划是否可执行（没有 error 级问题）。 */
export function planExecutable(issues: readonly PlanIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

/** 把问题列表整理成给模型看的说明。 */
export function describeIssues(issues: readonly PlanIssue[]): string {
  if (issues.length === 0) return '';

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(`计划有 ${String(errors.length)} 处必须修正才能执行：`);
    for (const issue of errors) {
      lines.push(`  ✗ ${issue.message}`);
      lines.push(`    → ${issue.remediation}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`另有 ${String(warnings.length)} 处提醒（不阻止执行，但请确认）：`);
    for (const issue of warnings) {
      lines.push(`  ! ${issue.message}`);
      lines.push(`    → ${issue.remediation}`);
    }
  }

  return lines.join('\n');
}
