/**
 * 算力操作的审批门控（任务 14.2、14.5，需求 14.4、17.1-17.5）。
 *
 * 四类操作各走一道门，卡片的措辞与可选作用域都不同：
 *
 * | 操作 | kind | 最宽作用域 | 为什么 |
 * |---|---|---|---|
 * | 登记目标 | `compute-target` | 一次性 | 它建立的是一条通道，不该有「以后都同意登记」 |
 * | 只读命令 | `ssh-command` | always | 不给的话一次排查十几张卡片，疲劳换来更宽的授权 |
 * | 写命令 | `ssh-command` | project | 跨项目的「随便写」不该出现在下拉框里 |
 * | 破坏性命令 | `ssh-command` | **无** | 每次单独问，持久授权对它无效 |
 * | 提交作业 | `compute-job` | project | 消耗集群配额，云上直接是钱 |
 * | 使用凭据 | `compute-provider` | project | 同上 |
 *
 * 门控的返回值一律带 `retryable`。这条区分来自需求 17.3：**显式拒绝不可重试**，
 * 超时与取消可以。合成一个布尔的话，模型会在用户明确说「不行」之后再问一次。
 */

import type { GrantScope } from '@l-science/shared';

import type { ApprovalService } from '../approval/service.js';
import {
  grantScopeOptions,
  type ComputeGrant,
  type ComputeGrantRisk,
  type ComputeGrantsRepo,
  type ComputeTargetRecord,
} from '../repo/compute.js';
import type { CredentialVault } from '../credentials/vault.js';

import { classifyCommand, RISK_LABEL, type CommandRisk, type RiskVerdict } from './risk.js';
import { sshDestination } from './ssh.js';
import type { ComputeTargetConfig, JobSpec, SshTargetConfig } from './types.js';

export interface GateDecision {
  ok: boolean;
  reason: string | null;
  /** 只有超时与取消值得重试。显式拒绝不可重试（需求 17.3）。 */
  retryable: boolean;
  /** 走了哪条路：已有授权 / 本次审批通过。审计与提示都要用。 */
  source: 'existing-grant' | 'approved' | 'denied';
  /** 命中的持久授权。一次性放行时为 null。 */
  grant: ComputeGrant | null;
}

const DENIED: Omit<GateDecision, 'reason'> = {
  ok: false,
  retryable: false,
  source: 'denied',
  grant: null,
};

export interface ComputeGateDeps {
  approvals: () => ApprovalService;
  grants: ComputeGrantsRepo;
  vault?: CredentialVault;
  projectId: string;
}

/** 目标的一行描述，用于卡片标题。 */
export function describeTarget(target: ComputeTargetRecord): string {
  const config = target.config;
  switch (config.family) {
    case 'local':
      return `${target.name}（本机）`;
    case 'ssh':
      return `${target.name}（${sshDestination(config)}${
        config.scheduler === 'none' ? '' : `，${config.scheduler}`
      }）`;
    case 'byoc':
      return `${target.name}（${config.platform}）`;
    default:
      return target.name;
  }
}

/** 把审批的非通过结果翻译成 GateDecision。 */
function fromApproval(
  result: Awaited<ReturnType<ApprovalService['request']>>,
  what: string,
): GateDecision | null {
  if (result.state === 'approved') return null;

  const reason =
    result.state === 'denied'
      ? result.fromPriorDenial
        ? `此前已拒绝过同一请求（${what}），不再重复询问。`
        : `用户拒绝了${what}。${result.note ?? ''}`.trim()
      : result.state === 'timeout'
        ? `审批超时，${what}未获批准。`
        : `审批被取消：${result.reason}`;

  return { ...DENIED, reason, retryable: result.state !== 'denied' };
}

export class ComputeGate {
  readonly #deps: ComputeGateDeps;

  constructor(deps: ComputeGateDeps) {
    this.#deps = deps;
  }

  /* ---------------- 登记目标 ---------------- */

  /**
   * 登记一个算力目标。
   *
   * **不提供持久授权**：`scopeOptions` 为空。「以后登记任何算力目标都不用问我」不是
   * 一个应该存在的选项——登记建立的是一条通往外部主机、会带上凭据与数据的通道，
   * 而每条通道的对端都不一样。
   *
   * 本地目标不走审批：它不建立任何对外通道，命令跑在用户自己的机器上，而那台机器
   * 上的执行边界由沙箱与路径授权负责。为它弹一张卡片只会稀释这类卡片的意义。
   */
  async authorizeRegister(input: {
    name: string;
    config: ComputeTargetConfig;
    credentialRef: string | null;
    conversationId: string | null;
  }): Promise<GateDecision> {
    if (input.config.family === 'local') {
      return { ok: true, reason: null, retryable: false, source: 'existing-grant', grant: null };
    }

    const detail: string[] = [];
    let impact: string;

    if (input.config.family === 'ssh') {
      const config = input.config;
      detail.push(
        `主机：${sshDestination(config)}${config.port === null ? '' : `:${String(config.port)}`}`,
      );
      detail.push(`调度器：${config.scheduler === 'none' ? '无（直接跑命令）' : config.scheduler}`);
      detail.push(`远端工作目录：${config.remoteWorkdir}`);
      if (config.activate !== null) detail.push(`环境激活：${config.activate}`);
      if (Object.keys(config.sshOptions).length > 0) {
        detail.push(
          `额外 ssh 选项：${Object.entries(config.sshOptions)
            .map(([k, v]) => `${k}=${v}`)
            .join('、')}`,
        );
      }
      detail.push('');
      detail.push('登记本身不会连接。连接要等你确认主机公钥之后。');
      impact =
        '登记之后 agent 可以请求在这台主机上执行命令与提交作业——每一次仍然要经过审批。' +
        '发往远端的内容包括作业脚本，而脚本里可能含有工作区的数据。';
    } else {
      const config = input.config;
      detail.push(`平台：${config.platform}`);
      detail.push(`提交命令模板：${config.submitTemplate}`);
      detail.push(`查询命令模板：${config.statusTemplate}`);
      if (config.cancelTemplate !== null) detail.push(`取消命令模板：${config.cancelTemplate}`);
      detail.push(
        `模板在哪执行：${config.runVia === 'local' ? '本机' : `ssh 目标 ${config.runVia.targetId}`}`,
      );
      if (config.endpoint !== null) detail.push(`端点：${config.endpoint}`);
      detail.push('');
      detail.push('模板由你负责正确。平台只做占位符替换与状态映射，不校验命令语义。');
      impact =
        '登记之后 agent 可以请求用这些模板提交作业——每一次仍然要经过审批。' +
        '模板执行时使用的是你本机已登录的云凭据，费用记在你的账户上。';
    }

    if (input.credentialRef !== null) {
      detail.push('');
      detail.push(`绑定的凭据：${input.credentialRef}`);
      const vault = this.#deps.vault;
      if (
        vault !== undefined &&
        vault.available &&
        vault.exists &&
        !vault.has(input.credentialRef)
      ) {
        // 如实说凭据不存在，而不是等第一次使用时报一个含糊的认证失败
        detail.push('  ⚠ 这个引用在凭据库里不存在。登记不会失败，但使用时会。');
      }
    }

    const result = await this.#deps.approvals().request({
      kind: 'compute-target',
      title: `登记算力目标「${input.name}」？`,
      detail: detail.join('\n'),
      impact,
      reversible: true,
      undoHint: '可在设置的算力目标列表里删除。删除会同时撤销它上面的全部授权。',
      // 刻意为空：登记建立的是一条通道，不该有「以后都同意」
      scopeOptions: [],
      payload: { name: input.name, family: input.config.family },
      ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
    });

    const rejected = fromApproval(result, '登记算力目标');
    if (rejected !== null) return rejected;
    return { ok: true, reason: null, retryable: false, source: 'approved', grant: null };
  }

  /* ---------------- 主机公钥 ---------------- */

  /**
   * 确认主机公钥。
   *
   * 这道门**不能省也不能有持久授权**。指纹是这条通道可信性的全部依据，而「以后自动
   * 信任任何主机的公钥」等价于 `StrictHostKeyChecking=no`。
   *
   * 卡片刻意标 `reversible: false`：删掉 known_hosts 里的一行在技术上很容易，但如果
   * 确认的是一个中间人的公钥，那次确认之后发出去的凭据已经收不回来了。把它标成
   * 可逆会让用户按「反正能撤销」的心态点同意。
   */
  async authorizeHostKey(input: {
    targetName: string;
    config: SshTargetConfig;
    fingerprint: string;
    keyType: string;
    conversationId: string | null;
  }): Promise<GateDecision> {
    const dest = sshDestination(input.config);
    const result = await this.#deps.approvals().request({
      kind: 'compute-target',
      title: `确认 ${dest} 的主机公钥？`,
      detail: [
        `目标：${input.targetName}`,
        `密钥类型：${input.keyType}`,
        `指纹：${input.fingerprint}`,
        '',
        '请把这串指纹与管理员公布的值核对。核对途径不能是「再连一次看看」——',
        '中间人每次都会给出同一个（它自己的）指纹。',
        '',
        '如果这台主机你以前确认过而指纹变了，平台不会替你覆盖：',
        '那种情况要么是主机重装了系统，要么就是中间人，两者必须由人来分辨。',
      ].join('\n'),
      impact:
        '确认之后这个公钥会写进 ~/.ssh/known_hosts，此后平台与你的终端都会信任它。' +
        '之后发往这台主机的内容包括作业脚本与其中的数据。',
      // 技术上可以删掉 known_hosts 里那一行，但确认之后发出去的东西收不回来
      reversible: false,
      undoHint: null,
      scopeOptions: [],
      payload: { host: input.config.host, fingerprint: input.fingerprint },
      ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
    });

    const rejected = fromApproval(result, '确认主机公钥');
    if (rejected !== null) return rejected;
    return { ok: true, reason: null, retryable: false, source: 'approved', grant: null };
  }

  /* ---------------- 远程命令 ---------------- */

  /**
   * 在远程主机上执行命令。
   *
   * 破坏性命令的处理是这里的核心：它**先不查已有授权**。查了就会命中那条为了不被
   * `ls` 烦到而给出的 always 授权，于是 `rm -rf` 直接放行——而这正是分档存在的
   * 唯一理由。
   */
  async authorizeCommand(input: {
    target: ComputeTargetRecord;
    command: string;
    purpose: string;
    conversationId: string | null;
    /** 已经算过危险度时传进来，避免重复判定（审计里要记同一个值）。 */
    verdict?: RiskVerdict;
  }): Promise<GateDecision & { verdict: RiskVerdict }> {
    const verdict = input.verdict ?? classifyCommand(input.command);
    const risk: CommandRisk = verdict.risk;

    // 破坏性命令不查授权：持久授权对它无效
    if (risk !== 'destructive') {
      const grantRisk: ComputeGrantRisk = risk === 'read' ? 'read' : 'write';
      const existing = this.#deps.grants.check({
        targetId: input.target.id,
        risk: grantRisk,
        projectId: this.#deps.projectId,
        conversationId: input.conversationId,
      });
      if (existing !== null) {
        return {
          ok: true,
          reason: null,
          retryable: false,
          source: 'existing-grant',
          grant: existing,
          verdict,
        };
      }
    }

    const grantRisk: ComputeGrantRisk = risk === 'read' ? 'read' : 'write';
    const scopeOptions: readonly GrantScope[] =
      risk === 'destructive' ? [] : grantScopeOptions(grantRisk);

    const detail = [
      `目标：${describeTarget(input.target)}`,
      `用途：${input.purpose}`,
      `判定：${RISK_LABEL[risk]} —— ${verdict.reason}`,
      ...(verdict.matched === null ? [] : [`触发判定的片段：${verdict.matched}`]),
      '',
      '命令：',
      input.command.length > 4000 ? `${input.command.slice(0, 4000)}\n…（已截断）` : input.command,
    ];

    if (risk === 'destructive') {
      detail.push('');
      detail.push('这一档不提供「以后不再询问」：破坏性命令每次都会单独问你，');
      detail.push('即使你此前给过这台主机的持久授权。');
    }

    const result = await this.#deps.approvals().request({
      kind: 'ssh-command',
      title:
        risk === 'destructive'
          ? `在 ${input.target.name} 上执行破坏性命令？`
          : `在 ${input.target.name} 上执行命令？`,
      detail: detail.join('\n'),
      impact:
        risk === 'read'
          ? '命令只读取远端内容。读到的数据会进入会话上下文，可能被发送给云端模型。'
          : risk === 'write'
            ? '命令可能修改远端文件或状态。远端没有版本控制，改动不会自动留痕。'
            : '命令会删除数据、改动权限或终止进程。远端通常没有回收站，也没有快照。',
      reversible: risk === 'read',
      undoHint: risk === 'read' ? '读取本身无需撤销；持久授权可在设置里撤销。' : null,
      scopeOptions,
      // payload 决定审批指纹（需求 17.3 的「同一请求」）。带上命令本身：
      // 拒绝了一条命令不该顺带拒绝这台主机上的所有命令
      payload: { targetId: input.target.id, command: input.command, risk },
      ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
    });

    const rejected = fromApproval(result, '执行远程命令');
    if (rejected !== null) return { ...rejected, verdict };

    let grant: ComputeGrant | null = null;
    if (result.state === 'approved' && result.scope !== 'once' && risk !== 'destructive') {
      grant = this.#deps.grants.grant({
        targetId: input.target.id,
        risk: grantRisk,
        scope: result.scope,
        scopeId: scopeIdFor(result.scope, this.#deps.projectId, input.conversationId),
        reason: `用户批准在 ${input.target.name} 上执行${RISK_LABEL[risk]}命令`,
        expiresAt: result.expiresAt,
      });
    }

    return { ok: true, reason: null, retryable: false, source: 'approved', grant, verdict };
  }

  /* ---------------- 作业提交 ---------------- */

  /**
   * 提交作业。
   *
   * 与命令执行分开的理由是**代价量级**：一条 `ls` 什么也不消耗，一个作业消耗集群
   * 配额，在云上直接是钱。合成一类的话，用户为了不被 `ls` 烦到给出的授权会顺带放行
   * 提交作业。
   *
   * 卡片必须列出资源请求。「提交一个作业」与「提交一个占 8 张 A100 跑 48 小时的作业」
   * 在用户要不要同意上是两个不同的问题。
   */
  async authorizeJob(input: {
    target: ComputeTargetRecord;
    spec: JobSpec;
    conversationId: string | null;
  }): Promise<GateDecision> {
    const existing = this.#deps.grants.check({
      targetId: input.target.id,
      risk: 'job',
      projectId: this.#deps.projectId,
      conversationId: input.conversationId,
    });
    if (existing !== null) {
      return {
        ok: true,
        reason: null,
        retryable: false,
        source: 'existing-grant',
        grant: existing,
      };
    }

    const resources: string[] = [];
    if (input.spec.cpus !== null) resources.push(`${String(input.spec.cpus)} CPU`);
    if (input.spec.gpus !== null && input.spec.gpus > 0) {
      resources.push(`${String(input.spec.gpus)} GPU`);
    }
    if (input.spec.memoryMb !== null) resources.push(`${String(input.spec.memoryMb)} MB 内存`);
    if (input.spec.minutes !== null) resources.push(`最长 ${String(input.spec.minutes)} 分钟`);

    const scriptPreview =
      input.spec.script.length > 3000
        ? `${input.spec.script.slice(0, 3000)}\n…（已截断，完整脚本会写进远端工作目录）`
        : input.spec.script;

    const result = await this.#deps.approvals().request({
      kind: 'compute-job',
      title: `在 ${input.target.name} 上提交作业「${input.spec.name}」？`,
      detail: [
        `目标：${describeTarget(input.target)}`,
        `资源请求：${resources.length === 0 ? '未指定（会用队列默认值）' : resources.join('、')}`,
        ...(input.spec.partition === null ? [] : [`分区/队列：${input.spec.partition}`]),
        ...(input.spec.account === null ? [] : [`记账账户：${input.spec.account}`]),
        '',
        '脚本：',
        scriptPreview,
      ].join('\n'),
      impact:
        '作业会消耗这个目标的计算配额。若这是云算力，费用记在你的账户上。' +
        '脚本内容会写进远端工作目录，其中可能含有工作区的数据。',
      reversible: true,
      undoHint: '作业提交后可以取消，但已消耗的机时不会退回。',
      // 不给 always：跨项目的「随便花钱」不该出现在下拉框里
      scopeOptions: grantScopeOptions('job'),
      payload: { targetId: input.target.id, name: input.spec.name },
      ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
    });

    const rejected = fromApproval(result, '提交作业');
    if (rejected !== null) return rejected;

    let grant: ComputeGrant | null = null;
    if (result.state === 'approved' && result.scope !== 'once') {
      grant = this.#deps.grants.grant({
        targetId: input.target.id,
        risk: 'job',
        scope: result.scope,
        scopeId: scopeIdFor(result.scope, this.#deps.projectId, input.conversationId),
        reason: `用户批准在 ${input.target.name} 上提交作业`,
        expiresAt: result.expiresAt,
      });
    }

    return { ok: true, reason: null, retryable: false, source: 'approved', grant };
  }

  /* ---------------- 凭据使用 ---------------- */

  /**
   * 使用一个已存的算力凭据（需求 14.4、17.1）。
   *
   * 与「登记时绑定了这个引用」分开问：绑定只是写了一个字符串，而使用意味着**密文
   * 被解出来交给一个外部进程**。把两者合成一次审批的话，一次登记就永久放行了此后
   * 所有的凭据读取。
   *
   * 卡片里只给指纹（长度 + 末尾几位），不给明文。给明文会让这张卡片本身变成泄漏
   * 途径——它会进会话历史，而会话历史可能被发给云端模型。
   */
  async authorizeCredential(input: {
    target: ComputeTargetRecord;
    credentialRef: string;
    purpose: string;
    conversationId: string | null;
  }): Promise<GateDecision> {
    const existing = this.#deps.grants.check({
      targetId: input.target.id,
      risk: 'credential',
      projectId: this.#deps.projectId,
      conversationId: input.conversationId,
    });
    if (existing !== null) {
      return {
        ok: true,
        reason: null,
        retryable: false,
        source: 'existing-grant',
        grant: existing,
      };
    }

    const vault = this.#deps.vault;
    const fingerprint = vault?.fingerprint(input.credentialRef) ?? null;

    const result = await this.#deps.approvals().request({
      kind: 'compute-provider',
      title: `使用凭据「${input.credentialRef}」？`,
      detail: [
        `目标：${describeTarget(input.target)}`,
        `用途：${input.purpose}`,
        fingerprint === null
          ? '凭据库里找不到这个引用——使用会失败。'
          : `凭据指纹：长度 ${String(fingerprint.length)}，末尾 ${fingerprint.tail}`,
        '',
        '卡片里刻意不显示明文：这张卡片会进会话历史，而历史可能被发给云端模型。',
      ].join('\n'),
      impact:
        '凭据会被解密并交给执行命令的进程。进程能看到它，因此它也可能出现在' +
        '该进程的日志或错误信息里。',
      reversible: true,
      undoHint: '可在设置里撤销这条授权，或删除凭据本身。已经用过的那次无法收回。',
      scopeOptions: grantScopeOptions('credential'),
      payload: { targetId: input.target.id, credentialRef: input.credentialRef },
      ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
    });

    const rejected = fromApproval(result, '使用算力凭据');
    if (rejected !== null) return rejected;

    let grant: ComputeGrant | null = null;
    if (result.state === 'approved' && result.scope !== 'once') {
      grant = this.#deps.grants.grant({
        targetId: input.target.id,
        risk: 'credential',
        scope: result.scope,
        scopeId: scopeIdFor(result.scope, this.#deps.projectId, input.conversationId),
        reason: `用户批准为 ${input.target.name} 使用凭据 ${input.credentialRef}`,
        expiresAt: result.expiresAt,
      });
    }

    return { ok: true, reason: null, retryable: false, source: 'approved', grant };
  }
}

/**
 * 作用域对应的 id。
 *
 * session 作用域没有会话 id 时降级为 project：一条 scopeId 为 null 的 session 授权
 * 永远命中不了（`computeScopeCovers` 要求相等），那等于用户白点了一次同意。
 */
function scopeIdFor(
  scope: GrantScope,
  projectId: string,
  conversationId: string | null,
): string | null {
  if (scope === 'session') return conversationId ?? projectId;
  if (scope === 'project') return projectId;
  return null;
}
