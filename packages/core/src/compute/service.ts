/**
 * 算力服务（任务 14.2，需求 14.3、14.4、14.6、14.7）。
 *
 * 把登记、探测、命令执行、作业提交与状态跟踪串起来。
 *
 * ## 作业跟踪为什么是轮询
 *
 * 保持一条 ssh 连接监听作业结束在纸面上更省事，实际上不可用：笔记本合盖、换网、
 * VPN 重连都会断掉那条连接，而作业还在跑。断了之后要么丢掉跟踪，要么重连——而重连
 * 之后要做的第一件事恰好就是「问一下现在什么状态」，也就是轮询。
 *
 * 轮询是无状态的：进程重启后从库里读回未终止的作业接着问就行。需求 14.7 要求跟踪
 * 到终止态，而「用户关了一次窗口」是长作业期间最常发生的事。
 *
 * ## 间隔要退避
 *
 * 一个八小时的作业，每 5 秒问一次是 5760 次无用往返，每次都是一条 ssh 连接。退避到
 * 五分钟之后总次数降到一百多次，而代价是「结束后最多五分钟才发现」——对一个跑了
 * 八小时的作业来说这个延迟无关紧要。
 */

import { createHash } from 'node:crypto';

import type { ToolOutput } from '@l-science/shared';

import type { ArtifactStore } from '../artifact/store.js';
import type { CredentialVault } from '../credentials/vault.js';
import type { MemoryService, RememberResult } from '../memory/service.js';
import type { MemoryNote } from '../repo/memory.js';
import {
  ComputeGrantsRepo,
  type ComputeJobRecord,
  type ComputeJobsRepo,
  type ComputeTargetRecord,
  type ComputeTargetsRepo,
  type TerminalSource,
} from '../repo/compute.js';

import { ComputeGate, describeTarget, type GateDecision } from './gate.js';
import { defaultLocalShell, pingSsh, probeTarget, runLocalShell } from './probe.js';
import { classifyCommand, riskRank, RISK_LABEL, type RiskVerdict } from './risk.js';
import {
  buildJobScript,
  cancelCommand,
  fetchOutputCommand,
  jobPaths,
  parseOutputs,
  sanitizeJobName,
  statusProbe,
  submitCommands,
  type JobPaths,
} from './schedulers.js';
import {
  checkSshOptions,
  DEFAULT_SSH_TIMEOUT_MS,
  runSsh,
  scanHostKey,
  trustHostKey,
} from './ssh.js';
import {
  isTerminalJobState,
  JOB_STATE_LABEL,
  type ComputeTargetConfig,
  type JobSpec,
  type JobState,
  type ProbeReport,
  type SchedulerKind,
  type SshTargetConfig,
} from './types.js';

/* ------------------------------------------------------------------ *
 * 轮询间隔
 * ------------------------------------------------------------------ */

/**
 * 按作业已运行的时长决定下次轮询间隔。
 *
 * 刚提交时问得密一些（用户在等一个「排上了」的信号），跑久了就拉开。
 */
export function pollIntervalMs(ageMs: number, consecutiveErrors: number): number {
  const base =
    ageMs < 60_000 ? 10_000 : ageMs < 10 * 60_000 ? 30_000 : ageMs < 60 * 60_000 ? 60_000 : 300_000;

  /*
   * 连续失败时退得更狠。
   *
   * 集群登录节点在维护时会连续拒绝连接，而按原间隔死磕只是在制造噪声。指数退避到
   * 十分钟上限——超过它就等于放弃跟踪，而我们不放弃：需求 14.7 要的是跟踪到终止态。
   */
  if (consecutiveErrors <= 0) return base;
  return Math.min(base * 2 ** Math.min(consecutiveErrors, 5), 10 * 60_000);
}

/* ------------------------------------------------------------------ *
 * 依赖
 * ------------------------------------------------------------------ */

export interface ComputeServiceDeps {
  projectId: string;
  targets: ComputeTargetsRepo;
  jobs: ComputeJobsRepo;
  grants: ComputeGrantsRepo;
  gate: ComputeGate;
  artifacts: ArtifactStore;
  vault?: CredentialVault;
  /**
   * 环境笔记（任务 14.3，需求 14.5）。
   *
   * 走记忆服务而不是自己开一张表：需求 14.5 要的「跨项目共享」正是 `memory_notes` 的
   * compute 作用域已经提供的（它在应用库里），而准入规则、条数上限、必须给理由这些
   * 约束也已经在那一层。自己开表意味着把这些逐条重新实现一遍，而重新实现的那份迟早
   * 与记忆那份分叉。
   *
   * 惰性取：记忆服务按项目建，与算力服务同一批接线，顺序上它在前面但用回调更稳妥。
   */
  memory?: () => MemoryService;
  /** 作业状态变化时通知（广播 + 写进会话历史）。 */
  onJobEvent?: (event: JobEvent) => void;
  /** 目标增删改时通知。需求 14.6 的「无需重启即可发现」靠它。 */
  onTargetsChanged?: (info: {
    action: 'add' | 'update' | 'remove' | 'probe';
    targetId: string;
  }) => void;
  onLog?: (line: string) => void;
  now?: () => number;
}

export interface JobEvent {
  kind: 'submitted' | 'state' | 'finished';
  jobId: string;
  targetId: string;
  conversationId: string | null;
  state: JobState;
  detail: string | null;
  /** 终止时带上结论来源，让「不明」与「失败」在通知里也是两回事。 */
  terminalSource: TerminalSource | null;
}

export interface RunCommandResult {
  ok: boolean;
  /** 被审批拒绝时为 null——命令根本没跑。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  risk: RiskVerdict;
  /** 审批结论。`denied` 时 reason 说明为什么。 */
  gate: GateDecision;
  /** 审计记录 id。 */
  auditId: string | null;
  reason: string | null;
}

export interface SubmitResult {
  ok: boolean;
  job: ComputeJobRecord | null;
  gate: GateDecision | null;
  reason: string | null;
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

export class ComputeService {
  readonly #deps: ComputeServiceDeps;
  readonly #log: (line: string) => void;
  readonly #now: () => number;

  /** 正在跟踪的作业：jobId → 定时器。 */
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** 连续轮询失败次数，用于退避。 */
  readonly #errors = new Map<string, number>();

  #closed = false;

  constructor(deps: ComputeServiceDeps) {
    this.#deps = deps;
    this.#log = deps.onLog ?? ((): void => undefined);
    this.#now = deps.now ?? Date.now;
  }

  get targets(): ComputeTargetsRepo {
    return this.#deps.targets;
  }

  get jobs(): ComputeJobsRepo {
    return this.#deps.jobs;
  }

  get grants(): ComputeGrantsRepo {
    return this.#deps.grants;
  }

  /* ---------------- 登记与探测 ---------------- */

  /**
   * 登记一个算力目标。
   *
   * 顺序是「校验配置 → 审批 → 落库 → 探测」。探测放在最后而不是审批之前，因为探测
   * 要连接，而连接需要用户先同意登记这台主机——反过来的话，平台会在用户还没决定
   * 之前就已经连上去了。
   */
  async register(input: {
    name: string;
    config: ComputeTargetConfig;
    notesMd?: string | null;
    credentialRef?: string | null;
    conversationId: string | null;
  }): Promise<{
    ok: boolean;
    target: ComputeTargetRecord | null;
    reason: string | null;
    probe: ProbeReport | null;
  }> {
    const validation = validateConfig(input.config);
    if (!validation.ok) {
      return { ok: false, target: null, reason: validation.reason, probe: null };
    }

    if (this.#deps.targets.getByName(input.name) !== null) {
      return {
        ok: false,
        target: null,
        reason: `已有同名算力目标：${input.name}。名字要能一眼分清是哪台机器。`,
        probe: null,
      };
    }

    const decision = await this.#deps.gate.authorizeRegister({
      name: input.name,
      config: input.config,
      credentialRef: input.credentialRef ?? null,
      conversationId: input.conversationId,
    });
    if (!decision.ok) {
      return { ok: false, target: null, reason: decision.reason, probe: null };
    }

    let target: ComputeTargetRecord;
    try {
      target = this.#deps.targets.add({
        name: input.name,
        family: input.config.family,
        config: input.config,
        notesMd: input.notesMd ?? null,
        credentialRef: input.credentialRef ?? null,
      });
    } catch (err) {
      return {
        ok: false,
        target: null,
        reason: err instanceof Error ? err.message : String(err),
        probe: null,
      };
    }

    this.#deps.onTargetsChanged?.({ action: 'add', targetId: target.id });

    // 登记成功就探测一次：用户此刻正在看结果，而「登记好了但连不上」应该立刻知道
    const probe = await this.probe(target.id);
    return { ok: true, target: this.#deps.targets.get(target.id), reason: null, probe };
  }

  /** 探测一个目标并把结果落库。 */
  async probe(targetId: string): Promise<ProbeReport | null> {
    const target = this.#deps.targets.get(targetId);
    if (target === null) return null;

    const config = withFingerprint(target);
    const report = await probeTarget(config);
    this.#deps.targets.recordProbe(targetId, report);
    this.#deps.onTargetsChanged?.({ action: 'probe', targetId });
    return report;
  }

  /**
   * 确认主机公钥并写进 known_hosts。
   *
   * 取回 → 审批 → 写入三步分开，理由在 `ssh.ts` 的 `scanHostKey` 里说明了：首次连接
   * 自动信任恰好是中间人唯一需要的窗口。
   */
  async confirmHostKey(input: {
    targetId: string;
    conversationId: string | null;
    /** 用户已经从别处核对好的指纹。给了就要求与取回的一致。 */
    expectedFingerprint?: string | null;
  }): Promise<{ ok: boolean; fingerprint: string | null; reason: string | null }> {
    const target = this.#deps.targets.get(input.targetId);
    if (target === null) return { ok: false, fingerprint: null, reason: '算力目标不存在' };
    if (target.config.family !== 'ssh') {
      return { ok: false, fingerprint: null, reason: '只有 ssh 目标需要确认主机公钥' };
    }

    const scan = await scanHostKey(target.config);
    if (!scan.ok || scan.fingerprint === null || scan.raw === null) {
      return { ok: false, fingerprint: null, reason: scan.reason };
    }

    if (
      input.expectedFingerprint !== undefined &&
      input.expectedFingerprint !== null &&
      input.expectedFingerprint.trim() !== '' &&
      input.expectedFingerprint.trim() !== scan.fingerprint
    ) {
      return {
        ok: false,
        fingerprint: scan.fingerprint,
        reason:
          `取回的指纹与你给的不一致。\n给的：${input.expectedFingerprint.trim()}\n取回的：${scan.fingerprint}\n` +
          '不一致意味着这条连接上有第三方，或者主机换过密钥。平台不会替你决定是哪一种。',
      };
    }

    const decision = await this.#deps.gate.authorizeHostKey({
      targetName: target.name,
      config: target.config,
      fingerprint: scan.fingerprint,
      keyType: scan.keyType ?? 'unknown',
      conversationId: input.conversationId,
    });
    if (!decision.ok) return { ok: false, fingerprint: scan.fingerprint, reason: decision.reason };

    const written = await trustHostKey({ raw: scan.raw, fingerprint: scan.fingerprint });
    if (!written.ok) return { ok: false, fingerprint: scan.fingerprint, reason: written.reason };

    this.#deps.targets.update(input.targetId, {
      hostKeyFingerprint: scan.fingerprint,
      config: { ...target.config, hostKeyFingerprint: scan.fingerprint },
    });
    this.#deps.onTargetsChanged?.({ action: 'update', targetId: input.targetId });

    // 确认之后立刻探测：用户想知道的是「现在能用了吗」
    await this.probe(input.targetId);
    return { ok: true, fingerprint: scan.fingerprint, reason: null };
  }

  /** 列出可用目标。需求 14.6：不缓存，每次读库，因此中途新增立刻可见。 */
  list(options: { includeDisabled?: boolean } = {}): readonly ComputeTargetRecord[] {
    return this.#deps.targets.list(options);
  }

  /** 目标列表的版本号。UI 用它做廉价轮询。 */
  revision(): { count: number; latest: number } {
    return this.#deps.targets.revision();
  }

  /** 删除目标，同时撤销它上面的全部授权。 */
  remove(targetId: string): { ok: boolean; revokedGrants: number; reason: string | null } {
    const target = this.#deps.targets.get(targetId);
    if (target === null) return { ok: false, revokedGrants: 0, reason: '算力目标不存在' };

    const active = this.#deps.jobs.list({ targetId, state: 'active', limit: 1 });
    if (active.length > 0) {
      return {
        ok: false,
        revokedGrants: 0,
        reason:
          `这个目标上还有 ${String(this.#deps.jobs.summary({ targetId }).active)} 个未结束的作业。` +
          '删除目标会让它们永远停在当前状态（平台再也问不到调度器）。' +
          '先等它们结束或取消掉。',
      };
    }

    // 先撤授权再删记录：反过来的话外键 CASCADE 会把授权删掉而不是标成已撤销，
    // 于是「这台机器曾被授权过什么」这个审计问题查不出来
    const revoked = this.#deps.grants.revokeForTarget(targetId);
    this.#deps.targets.delete(targetId);
    this.#deps.onTargetsChanged?.({ action: 'remove', targetId });
    return { ok: true, revokedGrants: revoked, reason: null };
  }

  /* ---------------- 环境笔记（任务 14.3，需求 14.5）---------------- */

  /**
   * 一个目标的环境笔记。
   *
   * 两个来源，刻意分开：
   *
   * - `description`（`compute_targets.notes_md`）：**用户登记时填的一段自由说明**。
   *   它是登记材料的一部分，与 host、partition 并列。不受准入规则约束——那套规则是
   *   为了挡住模型把结论写进记忆，而用户手写的说明不需要这个保护。不进系统提示词。
   * - `notes`（compute 作用域的记忆）：**逐条累积的环境知识**。受准入规则约束
   *   （需求 14.5 的内容限制在这一层落地），会随会话触碰该目标而注入系统提示词。
   *
   * 合成一处最省事，但那会让「平台该不该拒绝这段文字」这个问题失去答案：同一个字段
   * 既是用户的自述又是模型的写入口，只能二选一地要么全放行要么全校验。
   */
  notes(targetId: string): {
    targetId: string;
    description: string | null;
    notes: readonly MemoryNote[];
  } {
    const target = this.#deps.targets.get(targetId);
    const memory = this.#deps.memory;
    return {
      targetId,
      description: target?.notesMd ?? null,
      notes:
        memory === undefined
          ? []
          : memory().list({ scope: 'compute', scopeId: targetId, kind: 'environment' }),
    };
  }

  /**
   * 写一条环境笔记。
   *
   * 目标存在性由记忆服务的 `computeTargetExists` 校验——不重复检查，两处各查一次
   * 迟早在「什么算存在」上分叉（比如这里认停用的目标而那里不认）。
   */
  addNote(input: {
    targetId: string;
    content: string;
    reason: string;
    replaceId?: string;
  }): RememberResult {
    const memory = this.#deps.memory;
    if (memory === undefined) {
      return { ok: false, rule: 'no-memory-service', reason: '本次运行没有可用的记忆服务' };
    }
    return memory().remember({
      scope: 'compute',
      scopeId: input.targetId,
      kind: 'environment',
      content: input.content,
      reason: input.reason,
      ...(input.replaceId === undefined ? {} : { replaceId: input.replaceId }),
    });
  }

  /** 删一条环境笔记。删除是用户的权力（需求 16.3），因此模型面不暴露这个。 */
  deleteNote(noteId: string): boolean {
    const memory = this.#deps.memory;
    return memory === undefined ? false : memory().delete(noteId);
  }

  /** 改用户手写的那段说明。不走准入规则。 */
  setDescription(targetId: string, markdown: string | null): boolean {
    return this.#deps.targets.update(targetId, { notesMd: markdown }) !== null;
  }

  /**
   * 这个会话该注入哪些目标的环境笔记（需求 14.5）。
   *
   * 只取会话真的碰过的目标。把全部已登记目标的笔记都注入是纯噪声，而记忆注入有字符
   * 预算——噪声会把真正相关的内容挤出去。
   */
  activeTargetIds(conversationId: string): readonly string[] {
    const touched = new Set(this.#deps.jobs.targetIdsFor(conversationId));
    // 已删除的目标可能仍留在作业记录里（作业记录不随目标消失）。过滤掉：
    // 给一个不存在的目标注入笔记只会让模型引用一台已经没有的机器
    return [...touched].filter((id) => this.#deps.targets.exists(id));
  }

  /** 渲染环境笔记，用于目标详情与工具输出。 */
  renderNotes(targetId: string): string {
    const { description, notes } = this.notes(targetId);
    const lines: string[] = [];

    if (description !== null && description.trim() !== '') {
      lines.push('登记时填的说明：');
      lines.push(description.trim());
    }
    if (notes.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`环境笔记（${String(notes.length)} 条，跨项目共享）：`);
      for (const note of notes) {
        lines.push(`- ${note.content}`);
        lines.push(`  理由：${note.reason}　id ${note.id}`);
      }
    }
    if (lines.length === 0) {
      return (
        '还没有这个目标的环境笔记。\n' +
        '分区上限、账户、文件系统清理策略、环境激活顺序、调度器的坑——' +
        '这些一旦踩过一次就该记下来，它们跨项目共享，下次换个项目也还在。'
      );
    }
    return lines.join('\n');
  }

  /* ---------------- 远程命令 ---------------- */

  /**
   * 在目标上执行一条命令。
   *
   * 审计**无论成败都记**，包括被拒绝的那些：「模型试过要执行 rm -rf 但被我拒了」
   * 是事后回看时最有价值的一条记录，而它恰好是最容易被漏掉的（失败路径通常直接
   * return）。
   */
  async runCommand(input: {
    targetRef: string;
    command: string;
    purpose: string;
    conversationId: string | null;
    timeoutMs?: number;
    modelId?: string | null;
  }): Promise<RunCommandResult> {
    const verdict = classifyCommand(input.command);
    const target = this.#deps.targets.resolve(input.targetRef);

    if (target === null) {
      return this.#commandFailure({
        verdict,
        reason:
          `找不到算力目标：${input.targetRef}。` +
          `已登记的：${
            this.#deps.targets
              .list()
              .map((t) => t.name)
              .join('、') || '（一个都没有）'
          }`,
      });
    }
    if (!target.enabled) {
      return this.#commandFailure({
        verdict,
        reason: `算力目标「${target.name}」已停用：${target.disabledReason ?? '未说明原因'}`,
      });
    }
    if (target.config.family === 'byoc') {
      return this.#commandFailure({
        verdict,
        reason:
          'BYOC 目标不支持直接执行命令——它只有提交/查询/取消三条模板。' +
          '要在云上跑一条命令，把它写成一个作业提交。',
      });
    }
    if (target.config.family === 'ssh' && target.hostKeyFingerprint === null) {
      return this.#commandFailure({
        verdict,
        reason:
          `${target.name} 的主机公钥还没确认过。确认之前不会连接——` +
          '首次连接自动信任正是中间人需要的窗口。先在目标详情里确认主机公钥。',
      });
    }

    const gate = await this.#deps.gate.authorizeCommand({
      target,
      command: input.command,
      purpose: input.purpose,
      conversationId: input.conversationId,
      verdict,
    });

    if (!gate.ok) {
      const auditId = this.#deps.jobs.addCommand({
        targetId: target.id,
        conversationId: input.conversationId,
        command: input.command,
        risk: verdict.risk,
        stderrHead: gate.reason,
        modelId: input.modelId ?? null,
      });
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 0,
        risk: verdict,
        gate,
        auditId,
        reason: gate.reason,
      };
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
    const executed =
      target.config.family === 'ssh'
        ? await runSsh({
            config: withFingerprint(target) as SshTargetConfig,
            script: input.command,
            timeoutMs,
          })
        : await runLocalShell({
            command: input.command,
            shell: target.config.shell,
            timeoutMs,
            ...(target.config.visibleDevices === null
              ? {}
              : { env: { CUDA_VISIBLE_DEVICES: target.config.visibleDevices } }),
          });

    const connectionError = 'connectionError' in executed ? executed.connectionError : null;

    const auditId = this.#deps.jobs.addCommand({
      targetId: target.id,
      conversationId: input.conversationId,
      command: input.command,
      risk: verdict.risk,
      approvalId: gate.grant?.id ?? null,
      exitCode: executed.exitCode,
      stdoutHead: executed.stdout,
      stderrHead: executed.stderr,
      truncated: executed.truncated,
      timedOut: executed.timedOut,
      durationMs: executed.durationMs,
      modelId: input.modelId ?? null,
    });

    return {
      ok: executed.ok,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      truncated: executed.truncated,
      timedOut: executed.timedOut,
      durationMs: executed.durationMs,
      risk: verdict,
      gate,
      auditId,
      reason: executed.ok
        ? null
        : connectionError !== null
          ? `连接层失败：${connectionError}`
          : executed.timedOut
            ? `命令超过 ${String(timeoutMs)} ms 未结束，已终止。长任务请提交成作业。`
            : `命令以退出码 ${String(executed.exitCode)} 结束`,
    };
  }

  #commandFailure(input: { verdict: RiskVerdict; reason: string }): RunCommandResult {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 0,
      risk: input.verdict,
      gate: { ok: false, reason: input.reason, retryable: false, source: 'denied', grant: null },
      auditId: null,
      reason: input.reason,
    };
  }

  /* ---------------- 作业 ---------------- */

  /**
   * 提交作业。
   *
   * 作业记录**先落库再提交**。反过来的话，提交成功但落库失败会留下一个在集群上跑着
   * 而平台完全不知道的作业——它会一直占配额，而用户在界面上找不到它，连取消都做不到。
   */
  async submitJob(input: {
    targetRef: string;
    spec: Partial<JobSpec> & { name: string; script: string };
    conversationId: string | null;
  }): Promise<SubmitResult> {
    const target = this.#deps.targets.resolve(input.targetRef);
    if (target === null) {
      return {
        ok: false,
        job: null,
        gate: null,
        reason:
          `找不到算力目标：${input.targetRef}。` +
          `已登记的：${
            this.#deps.targets
              .list()
              .map((t) => t.name)
              .join('、') || '（一个都没有）'
          }`,
      };
    }
    if (!target.enabled) {
      return {
        ok: false,
        job: null,
        gate: null,
        reason: `算力目标「${target.name}」已停用：${target.disabledReason ?? '未说明原因'}`,
      };
    }
    if (target.config.family === 'ssh' && target.hostKeyFingerprint === null) {
      return {
        ok: false,
        job: null,
        gate: null,
        reason: `${target.name} 的主机公钥还没确认过。先在目标详情里确认。`,
      };
    }

    const spec = normalizeSpec(input.spec, target);
    if (target.config.family === 'local' && target.config.maxConcurrent > 0) {
      const active = this.#deps.jobs.summary({ targetId: target.id }).active;
      if (active >= target.config.maxConcurrent) {
        return {
          ok: false,
          job: null,
          gate: null,
          reason:
            `本机目标「${target.name}」已有 ${String(active)} 个作业在跑，达到并发上限 ` +
            `${String(target.config.maxConcurrent)}。两个并行的训练作业通常是双双 OOM ` +
            '而不是各跑一半速度，所以这个上限默认是 1。',
        };
      }
    }

    const gate = await this.#deps.gate.authorizeJob({
      target,
      spec,
      conversationId: input.conversationId,
    });
    if (!gate.ok) return { ok: false, job: null, gate, reason: gate.reason };

    const scheduler = schedulerOf(target);
    const workdir = remoteWorkdirOf(target);

    const job = this.#deps.jobs.add({
      targetId: target.id,
      conversationId: input.conversationId,
      name: spec.name,
      scheduler,
      spec,
      remoteWorkdir: workdir,
      scriptSha256: createHash('sha256').update(spec.script, 'utf8').digest('hex').slice(0, 32),
      approvalId: gate.grant?.id ?? null,
    });

    const paths = jobPaths(workdir, job.id);
    const script = buildJobScript({
      scheduler,
      spec,
      paths,
      activate: target.config.family === 'ssh' ? target.config.activate : null,
    });

    const submitted = await this.#submit({
      target,
      scheduler,
      script,
      paths,
      spec,
      conversationId: input.conversationId,
    });

    if (!submitted.ok || submitted.externalId === null) {
      this.#deps.jobs.setState({
        id: job.id,
        state: 'failed',
        detail: submitted.detail,
        terminalSource: 'exit-code',
      });
      this.#emit({
        kind: 'finished',
        jobId: job.id,
        targetId: target.id,
        conversationId: input.conversationId,
        state: 'failed',
        detail: submitted.detail,
        terminalSource: 'exit-code',
      });
      return {
        ok: false,
        job: this.#deps.jobs.get(job.id),
        gate,
        reason: `提交失败：${submitted.detail}`,
      };
    }

    this.#deps.jobs.setExternalId(job.id, submitted.externalId);
    this.#deps.jobs.setState({ id: job.id, state: 'queued', detail: submitted.detail });

    this.#emit({
      kind: 'submitted',
      jobId: job.id,
      targetId: target.id,
      conversationId: input.conversationId,
      state: 'queued',
      detail: `作业 ${submitted.externalId} 已提交`,
      terminalSource: null,
    });

    this.track(job.id);
    return { ok: true, job: this.#deps.jobs.get(job.id), gate, reason: null };
  }

  async #submit(input: {
    target: ComputeTargetRecord;
    scheduler: SchedulerKind;
    script: string;
    paths: JobPaths;
    spec: JobSpec;
    conversationId: string | null;
  }): Promise<{ ok: boolean; externalId: string | null; detail: string }> {
    if (input.target.config.family === 'byoc') {
      return this.#submitByoc(input.target, input.spec, input.script, input.conversationId);
    }

    const commands = submitCommands({
      scheduler: input.scheduler,
      script: input.script,
      paths: input.paths,
    });
    const result = await this.#exec(input.target, commands.command, 60_000);

    if (!result.ok) {
      return {
        ok: false,
        externalId: null,
        detail: `${result.stderr.trim() || result.stdout.trim() || '提交命令失败'}`.slice(0, 2000),
      };
    }

    const externalId = commands.parseJobId(result.stdout);
    if (externalId === null) {
      return {
        ok: false,
        externalId: null,
        // 提交命令退出码 0 但拿不到作业 id 是真实会发生的情况（sbatch 的输出格式变过），
        // 因此把原文摆出来而不是报一句「解析失败」
        detail:
          `提交命令成功了但没能从输出里取出作业 id。原始输出：\n${result.stdout.slice(0, 1000)}\n` +
          '作业可能其实已经提交上去了——请到集群上用 squeue/qstat 确认，避免重复提交。',
      };
    }
    return { ok: true, externalId, detail: result.stdout.trim().slice(0, 500) };
  }

  /**
   * BYOC 提交。
   *
   * 脚本先写到本地临时文件，再把路径填进模板。不用 stdin 传：模板是用户写的任意命令，
   * 我们无法假定它读 stdin。
   */
  async #submitByoc(
    target: ComputeTargetRecord,
    spec: JobSpec,
    script: string,
    conversationId: string | null,
  ): Promise<{ ok: boolean; externalId: string | null; detail: string }> {
    if (target.config.family !== 'byoc') {
      return { ok: false, externalId: null, detail: '目标类型不是 byoc' };
    }
    const config = target.config;

    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'lsci-byoc-'));
    const scriptPath = join(dir, `${sanitizeJobName(spec.name)}.sh`);

    try {
      writeFileSync(scriptPath, script, 'utf8');

      const command = fillTemplate(config.submitTemplate, {
        script: scriptPath,
        name: sanitizeJobName(spec.name),
        cpus: spec.cpus === null ? '' : String(spec.cpus),
        gpus: spec.gpus === null ? '' : String(spec.gpus),
        memoryMb: spec.memoryMb === null ? '' : String(spec.memoryMb),
        minutes: spec.minutes === null ? '' : String(spec.minutes),
        workdir: dir,
      });

      const result = await this.#execByoc(target, command, 120_000, conversationId);
      if (!result.ok) {
        return {
          ok: false,
          externalId: null,
          detail: (result.stderr.trim() || result.stdout.trim() || '提交命令失败').slice(0, 2000),
        };
      }

      let externalId: string | null = null;
      try {
        const match = new RegExp(config.jobIdPattern, 'u').exec(
          `${result.stdout}\n${result.stderr}`,
        );
        externalId = match?.[1] ?? null;
      } catch (err) {
        return {
          ok: false,
          externalId: null,
          detail: `作业 id 正则无法编译：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (externalId === null) {
        return {
          ok: false,
          externalId: null,
          detail:
            `提交命令成功了但正则 /${config.jobIdPattern}/ 没能从输出里取出作业 id。\n` +
            `原始输出：\n${result.stdout.slice(0, 1000)}\n` +
            '作业可能其实已经提交上去了——请到平台上确认，避免重复提交。',
        };
      }
      return { ok: true, externalId, detail: result.stdout.trim().slice(0, 500) };
    } finally {
      // 脚本已经交给平台了，本地副本没有保留价值；作业记录里存了它的 sha256
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ---------------- 状态跟踪 ---------------- */

  /**
   * 恢复跟踪。进程启动时调用一次。
   *
   * 需求 14.7 的「跟踪到终止态」不能因为用户关了一次窗口就作废，而那正是长作业期间
   * 最常发生的事。
   */
  resume(): number {
    const pending = this.#deps.jobs.pending();
    for (const job of pending) this.track(job.id);
    if (pending.length > 0) {
      this.#log(`恢复跟踪 ${String(pending.length)} 个未结束的作业`);
    }
    return pending.length;
  }

  /** 开始跟踪一个作业。重复调用是安全的。 */
  track(jobId: string): void {
    if (this.#closed || this.#timers.has(jobId)) return;
    const job = this.#deps.jobs.get(jobId);
    if (job === null || isTerminalJobState(job.state)) return;
    this.#schedule(jobId, pollIntervalMs(this.#now() - job.submittedAt, 0));
  }

  #schedule(jobId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(jobId);
      void this.pollOnce(jobId).then((state) => {
        if (this.#closed || state === null || isTerminalJobState(state)) return;
        const job = this.#deps.jobs.get(jobId);
        if (job === null) return;
        this.#schedule(
          jobId,
          pollIntervalMs(this.#now() - job.submittedAt, this.#errors.get(jobId) ?? 0),
        );
      });
    }, delayMs);

    // 不让轮询定时器拖着进程不退出：作业在远端跑，平台退出不影响它
    timer.unref?.();
    this.#timers.set(jobId, timer);
  }

  /**
   * 问一次状态。返回当前状态，null 表示作业不存在。
   *
   * 对外暴露是刻意的：用户在界面上点「刷新」时应该立刻问一次，而不是等下一个
   * 轮询周期。
   */
  async pollOnce(jobId: string): Promise<JobState | null> {
    const job = this.#deps.jobs.get(jobId);
    if (job === null) return null;
    if (isTerminalJobState(job.state)) return job.state;

    const target = this.#deps.targets.get(job.targetId);
    if (target === null) {
      /*
       * 目标被删了。
       *
       * 这不该发生（`remove` 会拒绝还有活跃作业的目标），但库可能被手工改过。
       * 判 `lost` 而不是 failed：我们确实不知道它怎么了。
       */
      this.#deps.jobs.setState({
        id: jobId,
        state: 'lost',
        detail: '算力目标记录已不存在，无法再查询这个作业的状态。',
        terminalSource: 'unavailable',
      });
      this.#finish(jobId);
      return 'lost';
    }

    if (job.externalId === null) {
      this.#deps.jobs.recordPoll(jobId, '没有调度器作业 id，无法查询');
      return job.state;
    }

    const reading = await this.#readState(target, job);
    if (reading === null) {
      const errors = (this.#errors.get(jobId) ?? 0) + 1;
      this.#errors.set(jobId, errors);
      this.#deps.jobs.recordPoll(jobId, `第 ${String(errors)} 次查询失败`);
      return job.state;
    }

    this.#errors.delete(jobId);
    this.#deps.jobs.recordPoll(jobId, null);

    if (reading.state === job.state && !isTerminalJobState(reading.state)) {
      return reading.state;
    }

    this.#deps.jobs.setState({
      id: jobId,
      state: reading.state,
      detail: reading.detail,
      exitCode: reading.exitCode,
      ...(isTerminalJobState(reading.state)
        ? { terminalSource: reading.source ?? 'unavailable' }
        : {}),
    });

    this.#emit({
      kind: isTerminalJobState(reading.state) ? 'finished' : 'state',
      jobId,
      targetId: target.id,
      conversationId: job.conversationId,
      state: reading.state,
      detail: reading.detail,
      terminalSource: isTerminalJobState(reading.state) ? (reading.source ?? 'unavailable') : null,
    });

    if (isTerminalJobState(reading.state)) {
      // 取输出放在通知之后：取输出可能慢，而「作业结束了」这个信号越早越好
      await this.collectOutputs(jobId).catch((err: unknown) => {
        this.#log(`取作业输出失败：${err instanceof Error ? err.message : String(err)}`);
      });
      this.#finish(jobId);
    }

    return reading.state;
  }

  async #readState(
    target: ComputeTargetRecord,
    job: ComputeJobRecord,
  ): Promise<{
    state: JobState;
    source: TerminalSource | null;
    exitCode: number | null;
    detail: string;
  } | null> {
    if (job.externalId === null) return null;

    if (target.config.family === 'byoc') {
      return this.#readByocState(target, job);
    }

    const probe = statusProbe({
      scheduler: schedulerOf(target),
      externalId: job.externalId,
      paths: jobPaths(job.remoteWorkdir ?? remoteWorkdirOf(target), job.id),
    });

    const result = await this.#exec(target, probe.command, 45_000);
    /*
     * 命令本身失败（连不上）与「查到了但作业不在队列里」必须分开。
     *
     * 混起来的话，一次 VPN 断线会让作业被判成 lost——而它还在跑。这就是
     * `poll_error` 那一列存在的理由：让「作业卡住了」与「问不到调度器」可以分开。
     */
    if (!result.ok && result.stdout.trim() === '') return null;

    return probe.parse(result.stdout, result.stderr);
  }

  async #readByocState(
    target: ComputeTargetRecord,
    job: ComputeJobRecord,
  ): Promise<{
    state: JobState;
    source: TerminalSource | null;
    exitCode: number | null;
    detail: string;
  } | null> {
    if (target.config.family !== 'byoc' || job.externalId === null) return null;
    const config = target.config;

    const command = fillTemplate(config.statusTemplate, { jobId: job.externalId });
    const result = await this.#execByoc(target, command, 60_000, job.conversationId);
    if (!result.ok && result.stdout.trim() === '') return null;

    const text = `${result.stdout}\n${result.stderr}`;
    const lower = text.toLowerCase();

    for (const [needle, state] of Object.entries(config.stateMap)) {
      if (lower.includes(needle.toLowerCase())) {
        return {
          state,
          source: isTerminalJobState(state) ? 'platform' : null,
          exitCode: null,
          detail: `${config.platform}: ${needle}`,
        };
      }
    }

    return {
      state: 'lost',
      source: 'unavailable',
      exitCode: null,
      detail:
        `${config.platform} 的状态输出里没有任何一条已配置的映射能匹配上。` +
        '平台不猜——猜错的方向是把还在跑的作业当成完成，然后去读一份没写出来的输出。\n' +
        `原始输出：${text.trim().slice(0, 500)}`,
    };
  }

  #finish(jobId: string): void {
    const timer = this.#timers.get(jobId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(jobId);
    this.#errors.delete(jobId);
  }

  /**
   * 取回作业输出并落成制品。
   *
   * 落成制品而不是塞进作业记录：集群作业的 stdout 动辄几十 MB，放在库里会让每次
   * 列表查询都拖上它。制品还带血缘，因此「这张图是哪个作业跑出来的」可以回答。
   */
  async collectOutputs(
    jobId: string,
    options: { tailLines?: number } = {},
  ): Promise<{ stdout: string; stderr: string; stdoutArtifactId: string | null }> {
    const job = this.#deps.jobs.get(jobId);
    if (job === null) return { stdout: '', stderr: '', stdoutArtifactId: null };
    const target = this.#deps.targets.get(job.targetId);
    if (target === null || target.config.family === 'byoc') {
      return { stdout: '', stderr: '', stdoutArtifactId: null };
    }

    const paths = jobPaths(job.remoteWorkdir ?? remoteWorkdirOf(target), job.id);
    const result = await this.#exec(
      target,
      fetchOutputCommand(paths, options.tailLines ?? 0),
      120_000,
    );
    const outputs = parseOutputs(result.stdout);

    let stdoutArtifactId: string | null = null;
    let stderrArtifactId: string | null = null;

    if (outputs.stdout.trim() !== '') {
      const saved = this.#deps.artifacts.save({
        filename: `${sanitizeJobName(job.name ?? 'job')}-${job.id}.out`,
        content: Buffer.from(outputs.stdout, 'utf8'),
        // 作业脚本就是产出这份输出的代码，落进 code 让血缘完整（需求 6.6）
        code: job.spec?.script ?? null,
        language: 'shell',
      });
      stdoutArtifactId = saved.artifact.id;
    }
    if (outputs.stderr.trim() !== '') {
      const saved = this.#deps.artifacts.save({
        filename: `${sanitizeJobName(job.name ?? 'job')}-${job.id}.err`,
        content: Buffer.from(outputs.stderr, 'utf8'),
        code: job.spec?.script ?? null,
        language: 'shell',
      });
      stderrArtifactId = saved.artifact.id;
    }

    if (stdoutArtifactId !== null || stderrArtifactId !== null) {
      this.#deps.jobs.setOutputs(jobId, { stdoutArtifactId, stderrArtifactId });
    }

    return { stdout: outputs.stdout, stderr: outputs.stderr, stdoutArtifactId };
  }

  /**
   * 取消作业。
   *
   * 取消是**破坏性**的（正在跑的计算被丢弃），但它不走 `authorizeCommand` 那道门——
   * 取消的是平台自己提交的作业，而且用户是发起者。给它弹一张「破坏性命令」卡片会让
   * 「点取消之后还要再确认一次取消」，那种多余的确认恰好会训练用户忽略卡片。
   */
  async cancelJob(jobId: string): Promise<{ ok: boolean; reason: string | null }> {
    const job = this.#deps.jobs.get(jobId);
    if (job === null) return { ok: false, reason: '作业不存在' };
    if (isTerminalJobState(job.state)) {
      return { ok: false, reason: `作业已经是终止态（${JOB_STATE_LABEL[job.state]}），无法取消` };
    }
    const target = this.#deps.targets.get(job.targetId);
    if (target === null) return { ok: false, reason: '算力目标记录已不存在' };
    if (job.externalId === null) {
      // 还没拿到调度器 id：本地标成取消即可，远端没有东西要杀
      this.#deps.jobs.setState({
        id: jobId,
        state: 'cancelled',
        detail: '提交回执还没拿到就被取消',
        terminalSource: 'cancelled',
      });
      this.#finish(jobId);
      return { ok: true, reason: null };
    }

    let result: { ok: boolean; stdout: string; stderr: string };
    if (target.config.family === 'byoc') {
      if (target.config.cancelTemplate === null) {
        return {
          ok: false,
          reason:
            `${target.config.platform} 目标没有配置取消命令模板，平台无法替你取消。` +
            '请到平台自己的控制台上取消。',
        };
      }
      result = await this.#execByoc(
        target,
        fillTemplate(target.config.cancelTemplate, { jobId: job.externalId }),
        60_000,
        job.conversationId,
      );
    } else {
      result = await this.#exec(target, cancelCommand(schedulerOf(target), job.externalId), 45_000);
    }

    if (!result.ok) {
      return {
        ok: false,
        reason:
          `取消命令失败：${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}\n` +
          '作业状态没有改动——它可能还在跑。',
      };
    }

    this.#deps.jobs.setState({
      id: jobId,
      state: 'cancelled',
      detail: '用户取消',
      terminalSource: 'cancelled',
    });
    this.#emit({
      kind: 'finished',
      jobId,
      targetId: target.id,
      conversationId: job.conversationId,
      state: 'cancelled',
      detail: '用户取消',
      terminalSource: 'cancelled',
    });
    this.#finish(jobId);
    return { ok: true, reason: null };
  }

  /* ---------------- 执行辅助 ---------------- */

  /** 在目标上跑一条平台自己发起的命令。**不经审批**——它不是用户或模型的请求。 */
  async #exec(
    target: ComputeTargetRecord,
    command: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
    if (target.config.family === 'ssh') {
      const result = await runSsh({
        config: withFingerprint(target) as SshTargetConfig,
        script: command,
        timeoutMs,
      });
      return {
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }
    if (target.config.family === 'local') {
      const result = await runLocalShell({
        // 本地目标的调度命令是 sh 语法（提交脚本、kill -0），因此固定用 bash 而不是
        // 目标配置里那个给用户命令用的 shell。混用会让 `kill -0` 在 PowerShell 下报错
        command,
        shell: 'bash',
        timeoutMs,
      });
      return {
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }
    return { ok: false, stdout: '', stderr: 'BYOC 目标不支持直接执行命令', exitCode: null };
  }

  /** 跑一条 BYOC 模板命令。按 `runVia` 决定在哪跑。 */
  async #execByoc(
    target: ComputeTargetRecord,
    command: string,
    timeoutMs: number,
    conversationId: string | null,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
    if (target.config.family !== 'byoc') {
      return { ok: false, stdout: '', stderr: '目标类型不是 byoc', exitCode: null };
    }
    const config = target.config;
    if (config.runVia === 'local') {
      const credentialEnv = await this.#credentialEnv(target, conversationId);
      if (!credentialEnv.ok) {
        return {
          ok: false,
          stdout: '',
          stderr: credentialEnv.reason,
          exitCode: null,
        };
      }
      const result = await runLocalShell({
        command,
        shell: defaultLocalShell(),
        timeoutMs,
        ...(credentialEnv.env === undefined ? {} : { env: credentialEnv.env }),
      });
      return {
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }

    const via = this.#deps.targets.get(config.runVia.targetId);
    if (via === null || via.config.family !== 'ssh') {
      return {
        ok: false,
        stdout: '',
        stderr: `runVia 指向的 ssh 目标不存在或类型不对：${config.runVia.targetId}`,
        exitCode: null,
      };
    }
    // 远端 BYOC 只用机器上已有的环境凭据，不把 vault 明文送进 ssh 命令行.
    const result = await runSsh({
      config: withFingerprint(via) as SshTargetConfig,
      script: command,
      timeoutMs,
    });
    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * BYOC 命令的凭据环境变量。
   *
   * 目前只支持一种形式：把凭据整体作为 `LSCI_COMPUTE_CREDENTIAL` 传进去，由用户的
   * 模板自己决定怎么用（`--token $LSCI_COMPUTE_CREDENTIAL`）。
   *
   * 不去解析凭据内容（比如「这看起来像 AWS 的 key pair，拆成两个变量」）：猜错的
   * 后果是认证失败，而认证失败的报错通常不会提到我们改过它的形状。
   */
  async #credentialEnv(
    target: ComputeTargetRecord,
    conversationId: string | null,
  ): Promise<
    | { readonly ok: true; readonly env?: Record<string, string> }
    | { readonly ok: false; readonly reason: string }
  > {
    if (
      target.config.family !== 'byoc' ||
      target.config.runVia !== 'local' ||
      target.credentialRef === null
    ) {
      return { ok: true };
    }
    const decision = await this.#deps.gate.authorizeCredential({
      target,
      credentialRef: target.credentialRef,
      purpose: '执行 BYOC 模板命令',
      conversationId,
    });
    if (!decision.ok) {
      return { ok: false, reason: decision.reason ?? '凭据未授权' };
    }
    const secret = this.#deps.vault?.get(target.credentialRef);
    if (secret === undefined || secret === null || secret === '') {
      return { ok: true };
    }
    return { ok: true, env: { LSCI_COMPUTE_CREDENTIAL: secret } };
  }

  #emit(event: JobEvent): void {
    try {
      this.#deps.onJobEvent?.(event);
    } catch (err) {
      // 通知失败不影响状态：状态已经落库了
      this.#log(`作业事件投递失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 渲染一段人读的作业状态摘要。 */
  renderJob(job: ComputeJobRecord): string {
    const target = this.#deps.targets.get(job.targetId);
    const lines = [
      `作业 ${job.name ?? job.id}（${job.id}）`,
      `目标：${target === null ? job.targetId : describeTarget(target)}`,
      `状态：${JOB_STATE_LABEL[job.state]}${
        job.externalId === null ? '' : `　调度器 id ${job.externalId}`
      }`,
    ];
    if (job.exitCode !== null) lines.push(`退出码：${String(job.exitCode)}`);
    if (job.detail !== null) lines.push(`详情：${job.detail}`);
    if (job.state === 'lost') {
      lines.push(
        '「结果不明」不等于失败，也不等于成功：调度器不再报告它，而历史记录拿不到。' +
          '不要按成功处理——先到集群上确认。',
      );
    }
    if (job.pollError !== null) {
      lines.push(`最近一次查询失败：${job.pollError}（作业本身可能仍在正常运行）`);
    }
    if (job.stdoutArtifactId !== null) lines.push(`stdout 制品：${job.stdoutArtifactId}`);
    if (job.stderrArtifactId !== null) lines.push(`stderr 制品：${job.stderrArtifactId}`);
    return lines.join('\n');
  }

  /** 一句话状态，用于「现在有什么在跑」。 */
  activeSummary(conversationId?: string): string {
    const summary = this.#deps.jobs.summary(conversationId === undefined ? {} : { conversationId });
    if (summary.total === 0) return '还没有提交过算力作业。';
    const parts = [`共 ${String(summary.total)} 个作业`];
    if (summary.active > 0) parts.push(`${String(summary.active)} 个未结束`);
    if (summary.completed > 0) parts.push(`${String(summary.completed)} 个已完成`);
    if (summary.failed > 0) parts.push(`${String(summary.failed)} 个失败`);
    if (summary.lost > 0) parts.push(`${String(summary.lost)} 个结果不明`);
    return parts.join('，');
  }

  /** 关掉全部轮询。进程退出时调用。远端作业不受影响。 */
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#errors.clear();
  }

  /** 快速测活，用于列表页。 */
  async ping(targetId: string): Promise<{ ok: boolean; detail: string }> {
    const target = this.#deps.targets.get(targetId);
    if (target === null) return { ok: false, detail: '算力目标不存在' };
    if (target.config.family === 'ssh') {
      if (target.hostKeyFingerprint === null) {
        return { ok: false, detail: '主机公钥还没确认过' };
      }
      return pingSsh(withFingerprint(target) as SshTargetConfig);
    }
    if (target.config.family === 'local') return { ok: true, detail: '本机' };
    return { ok: true, detail: 'BYOC 目标的可用性要等提交时才知道' };
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 把库里那份权威的指纹合进配置。
 *
 * 指纹在 `compute_targets.host_key_fingerprint` 列上而不是 config_json 里（迁移 M004
 * 的注释说明了理由），因此每次拿配置去连接都要合一次。忘记合的表现是「确认过公钥
 * 但还是被判成未确认」。
 */
function withFingerprint(target: ComputeTargetRecord): ComputeTargetConfig {
  if (target.config.family !== 'ssh') return target.config;
  return { ...target.config, hostKeyFingerprint: target.hostKeyFingerprint };
}

function schedulerOf(target: ComputeTargetRecord): SchedulerKind {
  return target.config.family === 'ssh' ? target.config.scheduler : 'none';
}

/** 本地目标的作业目录。 */
const LOCAL_JOB_WORKDIR = '/tmp/lsci-jobs';

function remoteWorkdirOf(target: ComputeTargetRecord): string {
  if (target.config.family === 'ssh') return target.config.remoteWorkdir;
  /*
   * 本地目标把作业文件放进一个固定子目录：作业结束后用户可能还要看输出，因此不用
   * 一次性的 mkdtemp。
   *
   * 在 Windows 上也用 POSIX 形式的 `/tmp/...` 而不是 `%TEMP%` 下的真实路径，这是
   * 刻意的：这个字符串会被插进作业脚本，而本地作业既可能走 PowerShell 也可能走
   * WSL 里的 bash。`/tmp/lsci-jobs` 在 PowerShell 里解析成当前盘的 `\tmp\lsci-jobs`，
   * 在 bash 里就是它本身；换成带反斜杠的绝对路径则会在 bash 分支里被当成转义字符。
   */
  return LOCAL_JOB_WORKDIR;
}

/** 填模板。未提供的占位符替换成空串而不是留着——留着会把 `{{gpus}}` 原样传给 CLI。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/gu, (_match, key: string) => values[key] ?? '');
}

/** 补齐 JobSpec 的默认值，并把目标上的默认分区/账户带进来。 */
export function normalizeSpec(
  partial: Partial<JobSpec> & { name: string; script: string },
  target: ComputeTargetRecord,
): JobSpec {
  const ssh = target.config.family === 'ssh' ? target.config : null;
  return {
    name: sanitizeJobName(partial.name),
    script: partial.script,
    cpus: partial.cpus ?? null,
    gpus: partial.gpus ?? null,
    memoryMb: partial.memoryMb ?? null,
    minutes: partial.minutes ?? null,
    // 目标上配了默认分区就带上：用户在登记时说过「这台机器用 gpu 分区」，
    // 不该要求他每次提交再说一遍
    partition: partial.partition ?? ssh?.partition ?? null,
    account: partial.account ?? ssh?.account ?? null,
    extraDirectives: partial.extraDirectives ?? [],
    env: partial.env ?? {},
  };
}

/** 配置校验。返回不通过的原因，直接给用户看。 */
export function validateConfig(
  config: ComputeTargetConfig,
): { ok: true } | { ok: false; reason: string } {
  switch (config.family) {
    case 'local': {
      if (config.maxConcurrent < 1) {
        return { ok: false, reason: 'maxConcurrent 至少是 1' };
      }
      return { ok: true };
    }
    case 'ssh': {
      if (config.host.trim() === '') return { ok: false, reason: 'ssh 目标必须给出主机' };
      if (/\s/u.test(config.host)) {
        return { ok: false, reason: `主机名里不能有空白字符：${config.host}` };
      }
      if (config.port !== null && (config.port < 1 || config.port > 65535)) {
        return { ok: false, reason: `端口不合法：${String(config.port)}` };
      }
      if (config.remoteWorkdir.trim() === '') {
        return {
          ok: false,
          reason: '必须给出远端工作目录：作业脚本与输出都要落在那里',
        };
      }
      if (!config.remoteWorkdir.startsWith('/') && !config.remoteWorkdir.startsWith('~')) {
        return {
          ok: false,
          reason:
            `远端工作目录要用绝对路径或 ~ 开头：${config.remoteWorkdir}。` +
            '相对路径会相对于登录时的家目录，而那在不同集群上不一样。',
        };
      }
      const issues = checkSshOptions(config.sshOptions);
      if (issues.length > 0) {
        return {
          ok: false,
          reason: `ssh 选项有问题：\n${issues.map((i) => `- ${i.key}：${i.reason}`).join('\n')}`,
        };
      }
      return { ok: true };
    }
    case 'byoc': {
      if (config.platform.trim() === '') return { ok: false, reason: 'BYOC 目标必须给出平台名' };
      if (!config.submitTemplate.includes('{{script}}')) {
        return {
          ok: false,
          reason: '提交模板里必须有 {{script}} 占位符，否则平台无法把作业脚本交给平台',
        };
      }
      if (!config.statusTemplate.includes('{{jobId}}')) {
        return { ok: false, reason: '查询模板里必须有 {{jobId}} 占位符' };
      }
      try {
        new RegExp(config.jobIdPattern, 'u');
      } catch (err) {
        return {
          ok: false,
          reason: `作业 id 正则无法编译：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!/\([^?]/u.test(config.jobIdPattern)) {
        return {
          ok: false,
          reason: '作业 id 正则需要一个捕获组——平台靠它从提交输出里取作业 id',
        };
      }
      if (Object.keys(config.stateMap).length === 0) {
        return {
          ok: false,
          reason:
            '状态映射不能为空。映射不到的状态会被记成「结果不明」，' +
            '而一个空映射意味着每个作业都会以「结果不明」收尾。',
        };
      }
      return { ok: true };
    }
    default:
      return {
        ok: false,
        reason: `未知的目标类型：${String((config as { family?: unknown }).family)}`,
      };
  }
}

/** 把命令结果渲染成工具输出。 */
export function renderCommandResult(result: RunCommandResult): ToolOutput {
  if (!result.ok && result.gate.source === 'denied') {
    return {
      kind: 'error',
      ename: 'ComputeApprovalDenied',
      evalue: result.reason ?? '命令未获批准',
      traceback: [],
    };
  }

  const parts: string[] = [];
  parts.push(`判定：${RISK_LABEL[result.risk.risk]}（${result.risk.reason}）`);
  if (result.gate.source === 'existing-grant') {
    parts.push('放行依据：此前已批准的持久授权');
  }
  if (result.stdout.trim() !== '') parts.push(`<stdout>\n${result.stdout.trimEnd()}\n</stdout>`);
  if (result.stderr.trim() !== '') parts.push(`<stderr>\n${result.stderr.trimEnd()}\n</stderr>`);
  if (result.truncated) parts.push('<note>输出已截断</note>');
  if (result.timedOut) parts.push('<note>命令超时被终止。长任务请提交成作业。</note>');
  parts.push(`<exit>${result.exitCode === null ? 'null' : String(result.exitCode)}</exit>`);

  return { kind: 'text', text: parts.join('\n') };
}

/** 危险度取最高的那一档，用于一次调用里包含多条命令的场合。 */
export function worstRisk(verdicts: readonly RiskVerdict[]): RiskVerdict | null {
  return verdicts.reduce<RiskVerdict | null>(
    (worst, v) => (worst === null || riskRank(v.risk) > riskRank(worst.risk) ? v : worst),
    null,
  );
}

export { ComputeGate, ComputeGrantsRepo };
