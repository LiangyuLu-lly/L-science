/**
 * 执行计划的结构（任务 12.5，需求 10.1、10.2、10.3）。
 *
 * 计划要解决的问题是「一头扎进去乱做」：一个较大的研究目标被拆成可审阅的阶段，
 * 用户在执行前能看懂、能改、能拒绝。因此计划必须是**结构化数据而不是一段散文**
 * ——散文没法逐步跟踪状态，也没法校验每一步是否落在真实存在的能力上。
 *
 * 两条贯穿的约束：
 *
 * 1. **每一步都要落在真实存在的能力上**（需求 10.2）。绑定的技能必须真的存在且
 *    启用，声明的工具必须真的注册过。落空的步骤在执行时才失败，而那时用户已经
 *    批准了整个计划，等于批准了一个做不到的承诺。
 * 2. **不硬编码可检索得到的领域数值**（需求 10.3）。「用 75 µV 作为慢波阈值」
 *    写进计划时，那个数字来自模型的记忆；记错了整条分析就错了，而没有任何地方
 *    会发现。正确形态是先有一步「从 AASM 判读手册确认阈值」，再有一步用它。
 */

/** 计划状态。用户批准之前不执行。 */
export type PlanStatus = 'draft' | 'approved' | 'executing' | 'done' | 'failed' | 'rejected';

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 委派设置（需求 10.5、10.7）。 */
export interface DelegationSpec {
  /**
   * 是否可与同阶段的其他步骤并行。
   *
   * 并行的前提是彼此不依赖，这一点由 `dependsOn` 保证，不靠这个标记。
   */
  parallel: boolean;
  /**
   * 是否阻塞式。
   *
   * 阻塞式委派在用户中断时会被一并取消；非阻塞式不受影响（需求 10.7）。默认阻塞
   * ——「转后台」必须是显式选择，否则用户中断之后仍有东西在跑，而他以为停了。
   */
  blocking: boolean;
  /** 期望的子 agent 数量上限。省略时由执行器按并行度决定。 */
  maxConcurrent?: number;
}

export interface PlanStepSpec {
  /**
   * 计划内唯一的引用名，供 `dependsOn` 使用。
   *
   * 由生成方给出（通常是 `s1`、`load-data` 这类短名），不是数据库主键——
   * 让模型引用 UUID 是不现实的。
   */
  ref: string;
  /** 所属阶段，从 1 开始。 */
  phase: number;
  title: string;
  description: string;
  /** 绑定的技能 slug。null 表示这一步不需要既定方法。 */
  skillSlug: string | null;
  /** 这一步会用到的工具名。 */
  tools: readonly string[];
  /**
   * 这一步产出什么。
   *
   * 产物是步骤之间的交接界面（需求 10.6：经 Artifact 或文件交接，不靠共享内存）。
   * 写成具体的文件名或制品说明，而不是「处理好的数据」。
   */
  produces: readonly string[];
  /** 依赖哪些前置步骤的 ref。 */
  dependsOn: readonly string[];
  /**
   * 这一步是否为「取得可检索的事实或数值」。
   *
   * 标记它的用途是让硬编码数值的检查能识别出「这个数是查来的而不是记来的」
   * ——后续步骤依赖一个 retrieval 步骤时，它里面出现数值就不再报警告。
   */
  retrieval: boolean;
  /** 委派设置。null 表示由主 agent 顺序执行。 */
  delegation: DelegationSpec | null;
}

export interface PlanPhaseSpec {
  phase: number;
  title: string;
}

export interface PlanSpec {
  /** 用户的目标，原话或经确认的改写。 */
  goal: string;
  phases: readonly PlanPhaseSpec[];
  steps: readonly PlanStepSpec[];
}

export class PlanSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanSpecError';
  }
}

const REF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function str(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanSpecError(`${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new PlanSpecError(`${field} 超过 ${String(max)} 字符`);
  }
  return trimmed;
}

function strArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlanSpecError(`${field} 必须是字符串数组`);
  return value.map((item, i) => str(item, `${field}[${String(i)}]`, 500));
}

function parseDelegation(raw: unknown, field: string): DelegationSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanSpecError(`${field} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const maxConcurrent = obj.maxConcurrent;
  if (
    maxConcurrent !== undefined &&
    (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1)
  ) {
    throw new PlanSpecError(`${field}.maxConcurrent 必须是不小于 1 的整数`);
  }

  return {
    parallel: obj.parallel === true,
    // 默认阻塞：「转后台」必须是显式选择，否则用户中断之后仍有东西在跑
    blocking: obj.blocking !== false,
    ...(typeof maxConcurrent === 'number' ? { maxConcurrent } : {}),
  };
}

/**
 * 解析并归一化计划。
 *
 * 结构性错误直接抛错（缺字段、类型不对、ref 重复）；「能不能做到」这类语义问题
 * 交给 `validatePlan`——两者分开是因为前者说明生成方产出了坏数据，
 * 后者说明计划本身需要用户或模型调整。
 */
export function parsePlanSpec(raw: unknown): PlanSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanSpecError('计划必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const goal = str(obj.goal, 'goal', 2000);

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new PlanSpecError('steps 至少要有一步');
  }
  if (obj.steps.length > 200) {
    throw new PlanSpecError('steps 超过 200 步。这个规模下计划本身已无法被审阅，请分解目标');
  }

  const steps: PlanStepSpec[] = [];
  const seenRefs = new Set<string>();

  for (const [i, rawStep] of obj.steps.entries()) {
    if (typeof rawStep !== 'object' || rawStep === null) {
      throw new PlanSpecError(`steps[${String(i)}] 必须是对象`);
    }
    const s = rawStep as Record<string, unknown>;
    const where = `steps[${String(i)}]`;

    const ref = str(s.ref, `${where}.ref`, 64);
    if (!REF_RE.test(ref)) {
      throw new PlanSpecError(`${where}.ref «${ref}» 不合法。只允许字母、数字、连字符与下划线`);
    }
    if (seenRefs.has(ref)) {
      // 重复 ref 会让 dependsOn 指向不确定的那一步，而这个歧义没有任何地方会报
      throw new PlanSpecError(`步骤 ref 重复：${ref}`);
    }
    seenRefs.add(ref);

    const phase = s.phase;
    if (typeof phase !== 'number' || !Number.isInteger(phase) || phase < 1) {
      throw new PlanSpecError(`${where}.phase 必须是不小于 1 的整数`);
    }

    steps.push({
      ref,
      phase,
      title: str(s.title, `${where}.title`, 200),
      description: str(s.description, `${where}.description`),
      skillSlug:
        s.skillSlug === undefined || s.skillSlug === null
          ? null
          : str(s.skillSlug, `${where}.skillSlug`, 64),
      tools: strArray(s.tools, `${where}.tools`),
      produces: strArray(s.produces, `${where}.produces`),
      dependsOn: strArray(s.dependsOn, `${where}.dependsOn`),
      retrieval: s.retrieval === true,
      delegation: parseDelegation(s.delegation, `${where}.delegation`),
    });
  }

  // 阶段标题可省略：省略时按步骤里出现的阶段号补出来，标题留空由 UI 显示阶段号
  const phaseNumbers = [...new Set(steps.map((s) => s.phase))].sort((a, b) => a - b);
  const givenPhases = new Map<number, string>();
  if (Array.isArray(obj.phases)) {
    for (const [i, rawPhase] of obj.phases.entries()) {
      if (typeof rawPhase !== 'object' || rawPhase === null) {
        throw new PlanSpecError(`phases[${String(i)}] 必须是对象`);
      }
      const p = rawPhase as Record<string, unknown>;
      const num = p.phase;
      if (typeof num !== 'number' || !Number.isInteger(num) || num < 1) {
        throw new PlanSpecError(`phases[${String(i)}].phase 必须是不小于 1 的整数`);
      }
      givenPhases.set(num, str(p.title, `phases[${String(i)}].title`, 200));
    }
  }

  const phases: PlanPhaseSpec[] = phaseNumbers.map((phase) => ({
    phase,
    title: givenPhases.get(phase) ?? `阶段 ${String(phase)}`,
  }));

  return { goal, phases, steps };
}

/**
 * 按依赖与阶段排出执行顺序。
 *
 * 同阶段内按依赖拓扑排序，阶段之间按阶段号。返回的是**批次**而不是扁平序列：
 * 同一批次里的步骤彼此无依赖，可以并行——而扁平序列会把这个信息丢掉，
 * 执行器只能退回顺序执行。
 *
 * 有环时返回 null，由 `validatePlan` 负责报告具体的环。
 */
export function planBatches(spec: PlanSpec): readonly (readonly PlanStepSpec[])[] | null {
  const byRef = new Map(spec.steps.map((s) => [s.ref, s]));
  const remaining = new Map(spec.steps.map((s) => [s.ref, s]));
  const done = new Set<string>();
  const batches: PlanStepSpec[][] = [];

  while (remaining.size > 0) {
    // 只考虑当前最小的未完成阶段：阶段是用户可见的推进单位，
    // 跨阶段并行会让「现在做到第几阶段」失去意义
    const minPhase = Math.min(...[...remaining.values()].map((s) => s.phase));

    const ready = [...remaining.values()].filter(
      (s) => s.phase === minPhase && s.dependsOn.every((dep) => done.has(dep) || !byRef.has(dep)),
    );

    if (ready.length === 0) return null;

    ready.sort((a, b) => a.ref.localeCompare(b.ref));
    batches.push(ready);
    for (const s of ready) {
      remaining.delete(s.ref);
      done.add(s.ref);
    }
  }

  return batches;
}
