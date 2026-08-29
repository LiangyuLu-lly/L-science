/**
 * 算力目标与作业仓储（任务 14.2，需求 14.3、14.6、14.7）。
 *
 * 两张表分处两库，这是刻意的：
 *
 * - **目标在应用库**（`compute_targets`）。一台集群是研究者的基础设施，不属于某个
 *   项目。放进项目库会让「新建项目后要把三台机器重新登记一遍」，而重新登记意味着
 *   host key 要重新确认、环境笔记要重写——那些恰恰是最不该重复的东西。
 * - **作业在项目库**（`compute_jobs`）。需求 14.7 要求作业结果关联回发起会话，而
 *   会话在项目库里。放进应用库的话这条关联要跨库维护，而跨库外键 SQLite 不支持，
 *   于是「作业指向一个已删除项目的会话」这种状态无法被挡住。
 */

import { randomUUID } from 'node:crypto';

import type { GrantScope } from '@l-science/shared';

import type { Db } from '../db.js';
import type {
  ComputeFamily,
  ComputeTargetConfig,
  JobSpec,
  JobState,
  ProbeReport,
} from '../compute/types.js';

/* ------------------------------------------------------------------ *
 * 目标
 * ------------------------------------------------------------------ */

export interface ComputeTargetRecord {
  id: string;
  name: string;
  family: ComputeFamily;
  config: ComputeTargetConfig;
  /** 用户手写的自由说明。与模型写的环境记忆分开，见 `notes` 的注释。 */
  notesMd: string | null;
  credentialRef: string | null;
  enabled: boolean;
  /** 停用原因。用户主动停用与探测连续失败后自动停用要能分开。 */
  disabledReason: string | null;
  lastProbe: ProbeReport | null;
  lastProbeAt: number | null;
  /** 经用户审批确认过的主机公钥指纹。ssh 目标以外恒为 null。 */
  hostKeyFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TargetRow {
  id: string;
  name: string;
  family: string;
  config_json: string;
  notes_md: string | null;
  credential_ref: string | null;
  enabled: number;
  last_probe_json: string | null;
  created_at: number | null;
  updated_at: number | null;
  last_probe_at: number | null;
  host_key_fingerprint: string | null;
  disabled_reason: string | null;
}

/**
 * JSON 解析失败时返回 null 而不是抛。
 *
 * 一条配置损坏不该让「我有哪些算力目标」这个问题变成无法回答——那会让用户连
 * 「删掉这一条」都做不到。调用方按 null 显示成「配置损坏」。
 */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class ComputeTargetsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: TargetRow): ComputeTargetRecord {
    const config = parseJson<ComputeTargetConfig>(row.config_json);
    return {
      id: row.id,
      name: row.name,
      family: row.family as ComputeFamily,
      // 配置损坏时给一个最小可用的壳，让列表与删除仍然可用
      config: config ?? ({ family: row.family } as unknown as ComputeTargetConfig),
      notesMd: row.notes_md,
      credentialRef: row.credential_ref,
      enabled: row.enabled === 1,
      disabledReason: row.disabled_reason,
      lastProbe: parseJson<ProbeReport>(row.last_probe_json),
      lastProbeAt: row.last_probe_at,
      hostKeyFingerprint: row.host_key_fingerprint,
      // M001 建表时没有时间列，M004 补的；旧行退回 0 而不是当前时间——
      // 当前时间会让一条 2023 年建的目标看起来是刚建的
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? row.created_at ?? 0,
    };
  }

  add(input: {
    name: string;
    family: ComputeFamily;
    config: ComputeTargetConfig;
    notesMd?: string | null;
    credentialRef?: string | null;
    hostKeyFingerprint?: string | null;
    enabled?: boolean;
  }): ComputeTargetRecord {
    const name = input.name.trim();
    if (name === '') throw new Error('算力目标必须有名字');
    if (this.getByName(name) !== null) {
      throw new Error(`已有同名算力目标：${name}。名字要能一眼分清是哪台机器。`);
    }

    const id = `ct_${randomUUID()}`;
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO compute_targets
           (id, name, family, config_json, notes_md, credential_ref, enabled,
            last_probe_json, created_at, updated_at, last_probe_at,
            host_key_fingerprint, disabled_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        id,
        name,
        input.family,
        JSON.stringify(input.config),
        input.notesMd ?? null,
        input.credentialRef ?? null,
        (input.enabled ?? true) ? 1 : 0,
        now,
        now,
        input.hostKeyFingerprint ?? null,
      );

    return this.get(id) as ComputeTargetRecord;
  }

  get(id: string): ComputeTargetRecord | null {
    const row = this.#db.prepare('SELECT * FROM compute_targets WHERE id = ?').get(id) as
      TargetRow | undefined;
    return row === undefined ? null : this.#toRecord(row);
  }

  getByName(name: string): ComputeTargetRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM compute_targets WHERE name = ? COLLATE NOCASE')
      .get(name.trim()) as TargetRow | undefined;
    return row === undefined ? null : this.#toRecord(row);
  }

  /**
   * 按名字或 id 找。
   *
   * 模型与用户都更习惯用名字（「在 hpc1 上跑」），而 id 是 uuid。两种都接受，
   * 但**名字优先**：id 是内部标识，用户不会去记它。
   */
  resolve(ref: string): ComputeTargetRecord | null {
    return this.getByName(ref) ?? this.get(ref.trim());
  }

  list(
    options: { includeDisabled?: boolean; family?: ComputeFamily } = {},
  ): readonly ComputeTargetRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.includeDisabled !== true) clauses.push('enabled = 1');
    if (options.family !== undefined) {
      clauses.push('family = ?');
      params.push(options.family);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.#db
      .prepare(`SELECT * FROM compute_targets ${where} ORDER BY name COLLATE NOCASE`)
      .all(...params) as TargetRow[];
    return rows.map((r) => this.#toRecord(r));
  }

  /** 有没有变化。需求 14.6 的「无需重启即可发现」靠它做廉价轮询。 */
  revision(): { count: number; latest: number } {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS latest FROM compute_targets')
      .get() as { n: number; latest: number };
    return { count: row.n, latest: row.latest };
  }

  update(
    id: string,
    patch: {
      name?: string;
      config?: ComputeTargetConfig;
      notesMd?: string | null;
      credentialRef?: string | null;
      hostKeyFingerprint?: string | null;
    },
  ): ComputeTargetRecord | null {
    const existing = this.get(id);
    if (existing === null) return null;

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw new Error('算力目标必须有名字');
      const clash = this.getByName(name);
      if (clash !== null && clash.id !== id) throw new Error(`已有同名算力目标：${name}`);
    }

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name.trim());
    }
    if (patch.config !== undefined) {
      sets.push('config_json = ?');
      params.push(JSON.stringify(patch.config));
    }
    if (patch.notesMd !== undefined) {
      sets.push('notes_md = ?');
      params.push(patch.notesMd);
    }
    if (patch.credentialRef !== undefined) {
      sets.push('credential_ref = ?');
      params.push(patch.credentialRef);
    }
    if (patch.hostKeyFingerprint !== undefined) {
      sets.push('host_key_fingerprint = ?');
      params.push(patch.hostKeyFingerprint);
    }

    params.push(id);
    this.#db.prepare(`UPDATE compute_targets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  /**
   * 启用 / 停用。
   *
   * 停用要求给原因：一个灰掉的目标而没有原因，用户唯一能做的是把它重新打开试试，
   * 而那可能正是探测判定它不可用的原因。
   */
  setEnabled(id: string, enabled: boolean, reason?: string | null): boolean {
    if (!enabled && (reason ?? '').trim() === '') {
      throw new Error('停用算力目标必须说明原因');
    }
    return (
      this.#db
        .prepare(
          'UPDATE compute_targets SET enabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?',
        )
        .run(enabled ? 1 : 0, enabled ? null : (reason ?? null), Date.now(), id).changes > 0
    );
  }

  /**
   * 记一次探测结果。
   *
   * **失败也要记**，而且要更新 `last_probe_at`：不记的话，一台确定连不上的机器会在
   * 每次列表刷新时被重新探测一遍，每次挂 10 秒超时。
   */
  recordProbe(id: string, report: ProbeReport): boolean {
    return (
      this.#db
        .prepare(
          'UPDATE compute_targets SET last_probe_json = ?, last_probe_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(report), report.at, Date.now(), id).changes > 0
    );
  }

  /**
   * 删除。
   *
   * 硬删：算力目标不是研究记录，没有「曾经登记过」的审计价值——真正需要留痕的是
   * 在它上面跑过什么，而那些记在项目库的 compute_jobs / compute_commands 里，
   * 按 target_id 存着，不随目标消失。
   */
  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM compute_targets WHERE id = ?').run(id).changes > 0;
  }

  exists(id: string): boolean {
    return (
      (this.#db.prepare('SELECT 1 FROM compute_targets WHERE id = ?').get(id) as unknown) !==
      undefined
    );
  }
}

/* ------------------------------------------------------------------ *
 * 作业
 * ------------------------------------------------------------------ */

/** 终止结论从哪来。`state='lost'` 的行必须能回答「为什么判定不明」。 */
export type TerminalSource =
  /** 调度器当前队列（squeue / qstat） */
  | 'queue'
  /** 调度器历史记录（sacct / qstat -x） */
  | 'accounting'
  /** 进程退出码（本地目标或 scheduler=none） */
  | 'exit-code'
  /** BYOC 平台的状态命令 */
  | 'platform'
  /** 用户或平台主动取消 */
  | 'cancelled'
  /** 队列里没有、历史记录也拿不到 */
  | 'unavailable';

export interface ComputeJobRecord {
  id: string;
  targetId: string;
  conversationId: string | null;
  /** 调度器给的作业 id。提交失败时为 null。 */
  externalId: string | null;
  name: string | null;
  scheduler: string | null;
  state: JobState;
  spec: JobSpec | null;
  result: Record<string, unknown> | null;
  detail: string | null;
  exitCode: number | null;
  remoteWorkdir: string | null;
  scriptSha256: string | null;
  stdoutArtifactId: string | null;
  stderrArtifactId: string | null;
  submittedAt: number;
  finishedAt: number | null;
  lastPolledAt: number | null;
  pollCount: number;
  /** 上次轮询失败的原因。非空时「作业卡住了」与「问不到调度器」可以分开。 */
  pollError: string | null;
  terminalSource: TerminalSource | null;
  updatedAt: number;
  approvalId: string | null;
}

interface JobRow {
  id: string;
  target_id: string;
  conversation_id: string | null;
  external_id: string | null;
  state: string;
  spec_json: string | null;
  result_json: string | null;
  submitted_at: number | null;
  finished_at: number | null;
  name: string | null;
  scheduler: string | null;
  detail: string | null;
  exit_code: number | null;
  remote_workdir: string | null;
  script_sha256: string | null;
  stdout_artifact_id: string | null;
  stderr_artifact_id: string | null;
  last_polled_at: number | null;
  poll_count: number;
  poll_error: string | null;
  terminal_source: string | null;
  updated_at: number | null;
  approval_id: string | null;
}

export class ComputeJobsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: JobRow): ComputeJobRecord {
    return {
      id: row.id,
      targetId: row.target_id,
      conversationId: row.conversation_id,
      externalId: row.external_id,
      name: row.name,
      scheduler: row.scheduler,
      state: row.state as JobState,
      spec: parseJson<JobSpec>(row.spec_json),
      result: parseJson<Record<string, unknown>>(row.result_json),
      detail: row.detail,
      exitCode: row.exit_code,
      remoteWorkdir: row.remote_workdir,
      scriptSha256: row.script_sha256,
      stdoutArtifactId: row.stdout_artifact_id,
      stderrArtifactId: row.stderr_artifact_id,
      submittedAt: row.submitted_at ?? 0,
      finishedAt: row.finished_at,
      lastPolledAt: row.last_polled_at,
      pollCount: row.poll_count,
      pollError: row.poll_error,
      terminalSource: row.terminal_source as TerminalSource | null,
      updatedAt: row.updated_at ?? row.submitted_at ?? 0,
      approvalId: row.approval_id,
    };
  }

  add(input: {
    targetId: string;
    conversationId?: string | null;
    name: string;
    scheduler: string;
    spec: JobSpec;
    remoteWorkdir?: string | null;
    scriptSha256?: string | null;
    approvalId?: string | null;
  }): ComputeJobRecord {
    const id = `cj_${randomUUID()}`;
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO compute_jobs
           (id, target_id, conversation_id, external_id, state, spec_json, result_json,
            submitted_at, finished_at, name, scheduler, detail, exit_code, remote_workdir,
            script_sha256, stdout_artifact_id, stderr_artifact_id, last_polled_at,
            poll_count, poll_error, terminal_source, updated_at, approval_id)
         VALUES (?, ?, ?, NULL, 'submitted', ?, NULL, ?, NULL, ?, ?, NULL, NULL, ?,
                 ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.targetId,
        input.conversationId ?? null,
        JSON.stringify(input.spec),
        now,
        input.name,
        input.scheduler,
        input.remoteWorkdir ?? null,
        input.scriptSha256 ?? null,
        now,
        input.approvalId ?? null,
      );
    return this.get(id) as ComputeJobRecord;
  }

  get(id: string): ComputeJobRecord | null {
    const row = this.#db.prepare('SELECT * FROM compute_jobs WHERE id = ?').get(id) as
      JobRow | undefined;
    return row === undefined ? null : this.#toRecord(row);
  }

  /** 提交回执：记下调度器给的 id。 */
  setExternalId(id: string, externalId: string): boolean {
    return (
      this.#db
        .prepare('UPDATE compute_jobs SET external_id = ?, updated_at = ? WHERE id = ?')
        .run(externalId, Date.now(), id).changes > 0
    );
  }

  /**
   * 更新状态。
   *
   * 终止态**必须**带 `terminalSource`：一条 `lost` 而不说为什么不明，与一次网络抖动
   * 造成的误判无法区分。非终止态不接受 terminalSource——那会让「已经定论」这件事
   * 变得可疑。
   */
  setState(input: {
    id: string;
    state: JobState;
    detail?: string | null;
    exitCode?: number | null;
    terminalSource?: TerminalSource | null;
    result?: Record<string, unknown> | null;
  }): boolean {
    const terminal = (
      ['completed', 'failed', 'cancelled', 'timeout', 'lost'] as readonly JobState[]
    ).includes(input.state);
    if (terminal && (input.terminalSource === undefined || input.terminalSource === null)) {
      throw new Error(`终止态 ${input.state} 必须说明结论来源（terminalSource）`);
    }

    const now = Date.now();
    return (
      this.#db
        .prepare(
          `UPDATE compute_jobs
              SET state = ?, detail = ?, exit_code = ?, terminal_source = ?,
                  result_json = COALESCE(?, result_json),
                  finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.state,
          input.detail ?? null,
          input.exitCode ?? null,
          terminal ? (input.terminalSource ?? null) : null,
          input.result === undefined || input.result === null ? null : JSON.stringify(input.result),
          terminal ? 1 : 0,
          now,
          now,
          input.id,
        ).changes > 0
    );
  }

  /** 记一次轮询。成功时清掉上次的错误，否则「已经恢复」看不出来。 */
  recordPoll(id: string, error?: string | null): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE compute_jobs
              SET last_polled_at = ?, poll_count = poll_count + 1, poll_error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(Date.now(), error ?? null, Date.now(), id).changes > 0
    );
  }

  setOutputs(
    id: string,
    input: { stdoutArtifactId?: string | null; stderrArtifactId?: string | null },
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE compute_jobs
              SET stdout_artifact_id = COALESCE(?, stdout_artifact_id),
                  stderr_artifact_id = COALESCE(?, stderr_artifact_id),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(input.stdoutArtifactId ?? null, input.stderrArtifactId ?? null, Date.now(), id)
        .changes > 0
    );
  }

  list(
    options: {
      targetId?: string;
      conversationId?: string;
      /** 省略时返回全部；`'active'` 只返回未终止的。 */
      state?: JobState | 'active' | 'all';
      limit?: number;
    } = {},
  ): readonly ComputeJobRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.targetId !== undefined) {
      clauses.push('target_id = ?');
      params.push(options.targetId);
    }
    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    const state = options.state ?? 'all';
    if (state === 'active') {
      clauses.push("state NOT IN ('completed', 'failed', 'cancelled', 'timeout', 'lost')");
    } else if (state !== 'all') {
      clauses.push('state = ?');
      params.push(state);
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(options.limit ?? 100);
    const rows = this.#db
      .prepare(`SELECT * FROM compute_jobs ${where} ORDER BY submitted_at DESC LIMIT ?`)
      .all(...params) as JobRow[];
    return rows.map((r) => this.#toRecord(r));
  }

  /**
   * 需要继续跟踪的作业。
   *
   * 进程重启后靠它把跟踪接上——需求 14.7 的「跟踪到终止态」不能因为用户关了一次
   * 窗口就作废，那正是长作业最常发生的事。
   */
  pending(limit = 200): readonly ComputeJobRecord[] {
    return this.list({ state: 'active', limit });
  }

  /**
   * 这个会话碰过哪些算力目标（任务 14.3）。
   *
   * 用途是决定往系统提示词里注入**哪些**目标的环境笔记（需求 14.5）。把全部已登记
   * 目标的笔记都注入是纯噪声：一个只做数据整理的会话不需要知道三台集群各自的分区，
   * 而噪声会挤掉真正相关的内容（记忆注入有字符预算）。
   *
   * 作业与命令两张表都要看：一个会话可能只跑过几条 `squeue` 而还没提交作业，而那时
   * 「这个集群的 sacct 没开」这类笔记恰恰最该在场。
   */
  targetIdsFor(conversationId: string): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT target_id FROM compute_jobs WHERE conversation_id = ?
         UNION
         SELECT target_id FROM compute_commands WHERE conversation_id = ?`,
      )
      .all(conversationId, conversationId) as { target_id: string }[];
    return rows.map((r) => r.target_id);
  }

  summary(options: { targetId?: string; conversationId?: string } = {}): {
    total: number;
    active: number;
    completed: number;
    failed: number;
    lost: number;
    byState: Readonly<Record<string, number>>;
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.targetId !== undefined) {
      clauses.push('target_id = ?');
      params.push(options.targetId);
    }
    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

    const rows = this.#db
      .prepare(`SELECT state, COUNT(*) AS n FROM compute_jobs ${where} GROUP BY state`)
      .all(...params) as { state: string; n: number }[];

    const byState: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byState[row.state] = row.n;
      total += row.n;
    }
    const terminal = ['completed', 'failed', 'cancelled', 'timeout', 'lost'];
    const active = rows.filter((r) => !terminal.includes(r.state)).reduce((s, r) => s + r.n, 0);

    return {
      total,
      active,
      completed: byState['completed'] ?? 0,
      failed: byState['failed'] ?? 0,
      lost: byState['lost'] ?? 0,
      byState,
    };
  }

  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM compute_jobs WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------- 远程命令审计 ---------------- */

  addCommand(input: {
    targetId: string;
    conversationId?: string | null;
    command: string;
    risk: string;
    approvalId?: string | null;
    exitCode?: number | null;
    stdoutHead?: string | null;
    stderrHead?: string | null;
    truncated?: boolean;
    timedOut?: boolean;
    durationMs?: number | null;
    modelId?: string | null;
  }): string {
    const id = `cc_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO compute_commands
           (id, target_id, conversation_id, command, risk, approval_id, exit_code,
            stdout_head, stderr_head, truncated, timed_out, duration_ms, model_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.targetId,
        input.conversationId ?? null,
        input.command,
        input.risk,
        input.approvalId ?? null,
        input.exitCode ?? null,
        // 只留头部：完整输出在工具返回值与会话历史里，这里存的是审计线索
        (input.stdoutHead ?? '').slice(0, 2000) || null,
        (input.stderrHead ?? '').slice(0, 2000) || null,
        (input.truncated ?? false) ? 1 : 0,
        (input.timedOut ?? false) ? 1 : 0,
        input.durationMs ?? null,
        input.modelId ?? null,
        Date.now(),
      );
    return id;
  }

  commands(options: { targetId?: string; conversationId?: string; limit?: number } = {}): readonly {
    id: string;
    targetId: string;
    conversationId: string | null;
    command: string;
    risk: string;
    approvalId: string | null;
    exitCode: number | null;
    stdoutHead: string | null;
    stderrHead: string | null;
    truncated: boolean;
    timedOut: boolean;
    durationMs: number | null;
    modelId: string | null;
    createdAt: number;
  }[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.targetId !== undefined) {
      clauses.push('target_id = ?');
      params.push(options.targetId);
    }
    if (options.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(options.limit ?? 100);

    const rows = this.#db
      .prepare(`SELECT * FROM compute_commands ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as {
      id: string;
      target_id: string;
      conversation_id: string | null;
      command: string;
      risk: string;
      approval_id: string | null;
      exit_code: number | null;
      stdout_head: string | null;
      stderr_head: string | null;
      truncated: number;
      timed_out: number;
      duration_ms: number | null;
      model_id: string | null;
      created_at: number;
    }[];

    return rows.map((r) => ({
      id: r.id,
      targetId: r.target_id,
      conversationId: r.conversation_id,
      command: r.command,
      risk: r.risk,
      approvalId: r.approval_id,
      exitCode: r.exit_code,
      stdoutHead: r.stdout_head,
      stderrHead: r.stderr_head,
      truncated: r.truncated === 1,
      timedOut: r.timed_out === 1,
      durationMs: r.duration_ms,
      modelId: r.model_id,
      createdAt: r.created_at,
    }));
  }
}

/* ------------------------------------------------------------------ *
 * 算力授权（应用库）
 * ------------------------------------------------------------------ */

/**
 * 授权的档位。
 *
 * `destructive` **不在这里**：破坏性命令每次都要单独问，持久授权对它无效。把它加进
 * 这个联合是最容易发生的一次「顺手放宽」——加上之后 `rm -rf` 与 `ls` 就共用一条
 * always 授权了，而那正是分档要防的事。
 */
export type ComputeGrantRisk = 'read' | 'write' | 'job' | 'credential';

export interface ComputeGrant {
  id: string;
  targetId: string;
  risk: ComputeGrantRisk;
  scope: GrantScope;
  scopeId: string | null;
  reason: string | null;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ComputeGrantRow {
  id: string;
  target_id: string;
  risk: string;
  scope: string;
  scope_id: string | null;
  reason: string | null;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function toComputeGrant(row: ComputeGrantRow): ComputeGrant {
  return {
    id: row.id,
    targetId: row.target_id,
    risk: row.risk as ComputeGrantRisk,
    scope: row.scope as GrantScope,
    scopeId: row.scope_id,
    reason: row.reason,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * 作用域是否覆盖当前上下文。
 *
 * 与 `GrantRepo.scopeCovers` 同构，刻意各写一份而不是抽公共函数：两处的 scope 含义
 * 相同但**可选的档位不同**（这里 write 不给 always、job 不给 always），把判定合并会让
 * 那条限制看起来像是可以随便改的参数。
 */
function computeScopeCovers(
  grant: { scope: GrantScope; scopeId: string | null },
  context: { projectId?: string | null; conversationId?: string | null },
): boolean {
  switch (grant.scope) {
    case 'always':
      return true;
    case 'project':
      return grant.scopeId !== null && grant.scopeId === context.projectId;
    case 'session':
      return grant.scopeId !== null && grant.scopeId === context.conversationId;
    case 'once':
      // 一次性授权不入库
      return false;
  }
}

/** 各档位允许的最宽作用域。超出的一律降到这里。 */
export const MAX_GRANT_SCOPE: Readonly<Record<ComputeGrantRisk, GrantScope>> = {
  // 只读命令给到 always：不给的话一次排查要点十几次同意，而那种疲劳换来的是更宽的授权
  read: 'always',
  // 跨项目的「随便写」不该出现在下拉框里
  write: 'project',
  // 作业消耗配额，在云上直接是钱
  job: 'project',
  // 凭据使用同上
  credential: 'project',
};

const SCOPE_ORDER: readonly GrantScope[] = ['once', 'session', 'project', 'always'];

/** 把用户选的作用域收敛到该档位允许的上限内。 */
export function clampGrantScope(risk: ComputeGrantRisk, requested: GrantScope): GrantScope {
  const max = MAX_GRANT_SCOPE[risk];
  return SCOPE_ORDER.indexOf(requested) > SCOPE_ORDER.indexOf(max) ? max : requested;
}

/** 某个档位可以提供给用户选的作用域。 */
export function grantScopeOptions(risk: ComputeGrantRisk): readonly GrantScope[] {
  const max = SCOPE_ORDER.indexOf(MAX_GRANT_SCOPE[risk]);
  return SCOPE_ORDER.slice(0, max + 1);
}

export class ComputeGrantsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  grant(input: {
    targetId: string;
    risk: ComputeGrantRisk;
    scope: GrantScope;
    scopeId?: string | null;
    reason?: string | null;
    expiresAt?: number | null;
  }): ComputeGrant {
    const scope = clampGrantScope(input.risk, input.scope);
    const id = `cg_${randomUUID()}`;
    const grantedAt = Date.now();

    this.#db
      .prepare(
        `INSERT INTO compute_grants
           (id, target_id, risk, scope, scope_id, reason, granted_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.targetId,
        input.risk,
        scope,
        input.scopeId ?? null,
        input.reason ?? null,
        grantedAt,
        input.expiresAt ?? null,
      );

    return {
      id,
      targetId: input.targetId,
      risk: input.risk,
      scope,
      scopeId: input.scopeId ?? null,
      reason: input.reason ?? null,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
  }

  /**
   * 查一个档位有没有生效的授权。
   *
   * `read` 命令也接受 `write` 档的授权：给了写权限还要为只读再问一次是纯粹的骚扰。
   * 反向不成立。
   */
  check(input: {
    targetId: string;
    risk: ComputeGrantRisk;
    projectId?: string | null;
    conversationId?: string | null;
    now?: number;
  }): ComputeGrant | null {
    const acceptable: ComputeGrantRisk[] = input.risk === 'read' ? ['read', 'write'] : [input.risk];

    const now = input.now ?? Date.now();
    const rows = this.#db
      .prepare(
        `SELECT * FROM compute_grants
          WHERE target_id = ? AND revoked_at IS NULL
          ORDER BY granted_at DESC`,
      )
      .all(input.targetId) as ComputeGrantRow[];

    for (const grant of rows.map(toComputeGrant)) {
      if (!acceptable.includes(grant.risk)) continue;
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
      if (!computeScopeCovers(grant, input)) continue;
      return grant;
    }
    return null;
  }

  list(options: { targetId?: string; includeRevoked?: boolean } = {}): readonly ComputeGrant[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.targetId !== undefined) {
      clauses.push('target_id = ?');
      params.push(options.targetId);
    }
    if (options.includeRevoked !== true) clauses.push('revoked_at IS NULL');
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

    const rows = this.#db
      .prepare(`SELECT * FROM compute_grants ${where} ORDER BY granted_at DESC`)
      .all(...params) as ComputeGrantRow[];
    return rows.map(toComputeGrant);
  }

  /** 撤销。软删——审计要能回答「这个目标曾被授权过什么」。 */
  revoke(id: string): boolean {
    return (
      this.#db
        .prepare('UPDATE compute_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(Date.now(), id).changes > 0
    );
  }

  /** 撤销一个目标上的全部授权。停用或删除目标时调用。 */
  revokeForTarget(targetId: string): number {
    return this.#db
      .prepare(
        'UPDATE compute_grants SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL',
      )
      .run(Date.now(), targetId).changes;
  }
}
