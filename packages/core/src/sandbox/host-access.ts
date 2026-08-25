/**
 * 宿主路径授权（任务 5.5，需求 5.5、17.1、17.5）。
 *
 * 沙箱把内核限制在项目工作目录内。但科研数据经常在别处——外置硬盘上的
 * 原始记录、共享盘上的数据集。这个模块处理「让 agent 访问那些地方」这件事：
 * 已有有效授权就直接放行，没有就发起审批并阻塞等待。
 *
 * 关键判断：**审批卡片必须说清授权的后果，而不只是路径**。用户看到
 * 「允许访问 E:\data 吗」无法判断风险；看到「读写权限、该目录下 1.2 万个文件、
 * 授权后本项目内不再询问」才能。
 */

import { statSync } from 'node:fs';
import { isAbsolute, normalize, parse } from 'node:path';

import type { GrantScope } from '@l-science/shared';

import type { ApprovalService } from '../approval/service.js';
import type { GrantMode, GrantRepo, HostGrant } from '../repo/grants.js';

export type HostAccessDecision =
  | { granted: true; grant: HostGrant | null; source: 'existing-grant' | 'approved' }
  | { granted: false; reason: string; retryable: boolean };

/**
 * 路径规范化。
 *
 * 必须在授权与检查两侧用同一套规则，否则会出现「授权了 `E:\data\` 但检查
 * `E:\data` 时说没授权」这类问题。同时也是安全前提：不规范化的话
 * `E:\data\..\..\Windows` 会被当成 `E:\data` 的子路径通过检查。
 */
export function normalizeHostPath(input: string): string {
  const normalized = normalize(input);

  // 剥尾部分隔符，但盘根例外：`E:\` 剥成 `E:` 之后 isAbsolute 会返回 false，
  // 盘根检查因此永远跑不到，请求会被「必须是绝对路径」这条误导性的规则拦下。
  // `E:` 在 Windows 上还有「E 盘的当前目录」这个完全不同的含义
  const { root } = parse(normalized);
  const stripped = normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');

  // Windows 路径大小写不敏感，统一小写以免同一目录有两条授权
  return stripped.toLowerCase();
}

/**
 * 判断路径是否危险到不该授权。
 *
 * 这不是替用户做决定，而是挡住几类几乎肯定是错误的请求：授权整个盘根或系统
 * 目录，等于把沙箱边界完全取消。真需要这么大范围时用户可以逐个子目录授权——
 * 那个摩擦是刻意的。
 */
export function assessHostPath(hostPath: string): { blocked: boolean; reason: string } {
  const normalized = normalizeHostPath(hostPath);

  if (!isAbsolute(normalized)) {
    return {
      blocked: true,
      reason: '必须是绝对路径。相对路径的含义取决于当前工作目录，无法审计。',
    };
  }

  const { root } = parse(normalized);
  if (normalized === normalizeHostPath(root)) {
    return {
      blocked: true,
      reason: `不允许授权整个盘根（${root}）。授权盘根等于取消沙箱边界，请改为授权具体的数据目录。`,
    };
  }

  const systemDirs = [
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  ].map(normalizeHostPath);

  for (const dir of systemDirs) {
    if (normalized === dir || normalized.startsWith(`${dir}\\`)) {
      return {
        blocked: true,
        reason: `不允许授权系统目录（${dir}）。分析数据不需要它，而写入权限会让沙箱形同虚设。`,
      };
    }
  }

  return { blocked: false, reason: '' };
}

/** 目录规模概览，用于审批卡片。 */
function describeTarget(hostPath: string): string {
  try {
    const stat = statSync(hostPath);
    if (stat.isDirectory()) return '一个目录';
    return `一个文件（${(stat.size / 1024).toFixed(0)} KB）`;
  } catch {
    // 路径不存在也照样走审批：用户可能打算让 agent 创建它。
    // 但要如实说明，否则用户以为自己在授权一个已有目录
    return '该路径当前不存在';
  }
}

/** 把授权无效的原因翻译成用户能据以行动的话。 */
function explainInvalid(reason: string, mode: GrantMode): string {
  switch (reason) {
    case 'revoked':
      return '此前的授权已被撤销。';
    case 'expired':
      return '此前的授权已过期。';
    case 'mode-insufficient':
      return `此前只授权了只读访问，本次需要${mode === 'rw' ? '写入' : '读取'}权限。`;
    case 'scope-mismatch':
      return '此前的授权限定在其他项目或会话，不覆盖当前上下文。';
    default:
      return '尚未授权。';
  }
}

export interface RequestHostAccessInput {
  grants: GrantRepo;
  approvals: ApprovalService;
  hostPath: string;
  mode: GrantMode;
  purpose: string;
  projectId: string;
  conversationId: string | null;
}

/**
 * 请求访问宿主路径。已授权则直接放行，否则发起审批。
 */
export async function requestHostAccess(
  input: RequestHostAccessInput,
): Promise<HostAccessDecision> {
  const normalized = normalizeHostPath(input.hostPath);

  const assessment = assessHostPath(input.hostPath);
  if (assessment.blocked) {
    // 这类请求不发审批：让用户对一个明显错误的请求点「同意」毫无意义，
    // 而且反复弹这种卡片会训练他习惯性点同意
    return { granted: false, reason: assessment.reason, retryable: false };
  }

  const existing = input.grants.checkHostPath({
    hostPath: normalized,
    requiredMode: input.mode,
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
  if (existing.ok) {
    return { granted: true, grant: existing.grant, source: 'existing-grant' };
  }

  const prior = explainInvalid(existing.reason, input.mode);
  const modeText = input.mode === 'rw' ? '读写' : '只读';

  const result = await input.approvals.request({
    kind: 'host-access',
    title: `允许${modeText}访问 ${input.hostPath}？`,
    detail: `用途：${input.purpose}\n目标：${describeTarget(input.hostPath)}\n当前状态：${prior}`,
    impact:
      input.mode === 'rw'
        ? `agent 可以读取、修改和删除该路径下的内容。这超出了沙箱的项目工作目录边界。`
        : `agent 可以读取该路径下的内容。读取的数据会进入会话上下文，可能被发送给云端模型。`,
    // 授权本身可撤销，但授权期间发生的读写不可撤销——如实说明而不是
    // 笼统地标成可逆
    reversible: true,
    undoHint: '可随时在设置的授权列表里撤销。但撤销不会撤回此前已读取或已修改的内容。',
    scopeOptions: ['once', 'session', 'project', 'always'],
    payload: { hostPath: normalized, mode: input.mode },
    conversationId: input.conversationId,
  });

  if (result.state !== 'approved') {
    const reason =
      result.state === 'denied'
        ? result.fromPriorDenial
          ? '此前已拒绝过同一路径的访问请求，不再重复询问。'
          : `用户拒绝了访问请求。${result.note ?? ''}`.trim()
        : result.state === 'timeout'
          ? '审批超时，未获得访问许可。'
          : `审批被取消：${result.reason}`;

    // 只有超时与取消值得重试。显式拒绝不可重试（需求 17.3）
    return { granted: false, reason, retryable: result.state !== 'denied' };
  }

  // once 作用域不建立持久授权：它的语义就是「这一次放行」
  if (result.scope === 'once') {
    return { granted: true, grant: null, source: 'approved' };
  }

  const grant = input.grants.grantHostPath({
    hostPath: normalized,
    guestPath: normalized,
    mode: input.mode,
    scope: result.scope,
    scopeId: scopeIdFor(result.scope, input),
    expiresAt: result.expiresAt,
  });

  return { granted: true, grant, source: 'approved' };
}

/**
 * 作用域对应的 id。
 *
 * session 作用域没有会话 id 时降级为 project：一条 scopeId 为 null 的 session
 * 授权永远不会命中（`scopeCovers` 要求 scopeId 相等），那等于用户白点了一次同意。
 */
function scopeIdFor(scope: GrantScope, input: RequestHostAccessInput): string | null {
  if (scope === 'session') return input.conversationId ?? input.projectId;
  if (scope === 'project') return input.projectId;
  return null;
}
