/**
 * SSH 执行（任务 14.2，需求 14.3、14.4）。
 *
 * ## 为什么用系统的 `ssh` 而不是 JS 的 SSH 库
 *
 * 实验室集群的接入方式几乎从不是「主机名 + 端口 + 私钥」这么干净：跳板机
 * （`ProxyJump`）、按主机匹配的不同私钥（`Match` / `IdentityFile`）、ssh-agent 转发、
 * 硬件密钥（FIDO/`sk-ecdsa`）、Kerberos/GSSAPI——这些用户在 `~/.ssh/config` 里
 * 早就配好了，而且是能用的。
 *
 * 引一个 JS 库意味着把这套配置全部重新实现一遍，而实现不全的表现是「在终端里能
 * 连上，在平台里连不上，且看不出为什么」。用系统 `ssh` 的规则很好解释：**你在终端
 * 能 ssh 上去，平台就能上去**。额外的好处是不引 native 依赖（ssh2 的加密后端需要
 * 编译工具链，而那正是这台机器上没有的东西）。
 *
 * 代价：需要 OpenSSH 客户端。Windows 10 1809 起自带，但可能被管理员移除——因此
 * 探测阶段要显式检查并给出可执行的补救步骤，而不是在第一次连接时报一个
 * 「ENOENT ssh」。
 *
 * ## 三条不能改的选项
 *
 * - `BatchMode=yes`：禁止一切交互提示。不加它的话，需要输入密码或确认 host key 时
 *   `ssh` 会**永久挂住**等一个不存在的 TTY。这与内核那边 `allow_stdin=false` 是同
 *   一条理由：没有人能应答的交互输入等于死锁。
 * - `StrictHostKeyChecking=yes`：首次连接不自动信任。`no` 与 `accept-new` 都等于对
 *   中间人不设防，而这条通道上要跑的是凭据与研究数据。未知主机由 `scanHostKey`
 *   取回指纹、经用户审批后写进 known_hosts。
 * - `PasswordAuthentication=no` / `KbdInteractiveAuthentication=no`：明确排除密码认证。
 *   不排除的话，配置了密码登录的主机会撞上 BatchMode 而报一个含糊的
 *   「Permission denied (publickey,password)」；排除掉之后报的是
 *   「没有可用的公钥」，那才是用户需要看到的。
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

import { runSupervised } from '../sandbox/supervisor.js';

import type { SshTargetConfig } from './types.js';

/** 默认连接超时。集群登录节点在高负载时慢，但 20 秒还连不上就是有问题了。 */
const CONNECT_TIMEOUT_SEC = 20;

/** 命令默认墙钟上限。远程命令是交互式操作，长任务应该走作业提交。 */
export const DEFAULT_SSH_TIMEOUT_MS = 120_000;

/** 输出上限。远程 `cat` 一个大文件是常见误操作，无界缓冲会把内存吃掉。 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 允许用户自定义的 ssh 选项白名单。
 *
 * 不做白名单的话，一个 `-o StrictHostKeyChecking=no` 就能把上面那三条约束里最重要
 * 的一条撤掉，而配置里多一行谁都不会注意到。列在这里的都是「影响怎么连上」而不是
 * 「影响连接安不安全」的选项。
 */
export const SAFE_SSH_OPTIONS: readonly string[] = [
  'ProxyJump',
  'ProxyCommand',
  'IdentityFile',
  'IdentitiesOnly',
  'CertificateFile',
  'ServerAliveInterval',
  'ServerAliveCountMax',
  'Compression',
  'ConnectionAttempts',
  'PreferredAuthentications',
  'PubkeyAcceptedAlgorithms',
  'HostKeyAlgorithms',
  'AddressFamily',
  'BindAddress',
  'SetEnv',
];

/** 被显式拒绝的选项，附上拒绝理由。 */
const FORBIDDEN_SSH_OPTIONS: Readonly<Record<string, string>> = {
  StrictHostKeyChecking: '主机公钥确认由平台的审批流程负责，不能在配置里绕过',
  BatchMode: '关掉 BatchMode 会让需要交互时 ssh 永久挂住——没有 TTY 可以应答',
  PasswordAuthentication: '平台不支持密码认证（无 TTY 可输入），改用密钥或 ssh-agent',
  KbdInteractiveAuthentication: '平台不支持交互式认证（无 TTY 可应答）',
  UserKnownHostsFile: '改 known_hosts 位置会让已确认的主机公钥失效，且不易察觉',
  GlobalKnownHostsFile: '同上',
  LogLevel: '日志级别由平台控制，排查连接问题时需要固定的输出格式',
};

export interface SshOptionIssue {
  key: string;
  reason: string;
}

/** 校验用户给的 ssh 选项。返回被拒绝的项，空数组表示全部可用。 */
export function checkSshOptions(
  options: Readonly<Record<string, string>>,
): readonly SshOptionIssue[] {
  const issues: SshOptionIssue[] = [];
  for (const key of Object.keys(options)) {
    const forbidden = FORBIDDEN_SSH_OPTIONS[key];
    if (forbidden !== undefined) {
      issues.push({ key, reason: forbidden });
      continue;
    }
    if (!SAFE_SSH_OPTIONS.includes(key)) {
      issues.push({
        key,
        reason: `不在白名单内。可用的选项：${SAFE_SSH_OPTIONS.join('、')}`,
      });
    }
  }
  return issues;
}

export interface SshResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /**
   * 连接层面的失败原因。命令本身跑了但退出码非零时为 null——那不是连接问题。
   *
   * 分开是必要的：「连不上」要去检查网络与密钥，「命令失败」要去看 stderr，
   * 而混成一个 `error` 字段会让这两条排查路径混在一起。
   */
  connectionError: SshConnectionError | null;
}

export type SshConnectionError =
  /** 本机没有 ssh 客户端 */
  | 'no-client'
  /** 主机公钥未确认或与已确认的不符 */
  | 'host-key'
  /** 没有可用的公钥认证 */
  | 'auth'
  /** 连接超时或网络不可达 */
  | 'unreachable'
  /** ssh 报了错但归不到上面任何一类 */
  | 'unknown';

/* ------------------------------------------------------------------ *
 * 客户端探测
 * ------------------------------------------------------------------ */

let clientCache: { available: boolean; version: string | null } | null = null;

/**
 * 本机有没有 ssh 客户端。结果缓存——用户不会在一次运行里装上 OpenSSH。
 *
 * 用 `-V` 而不是 `--version`：OpenSSH 只认前者，而且它把版本写在 stderr 上
 * （这不是错误，是 OpenSSH 一贯的行为）。
 */
export async function detectSshClient(): Promise<{ available: boolean; version: string | null }> {
  if (clientCache !== null) return clientCache;

  const result = await new Promise<{ available: boolean; version: string | null }>((resolve) => {
    execFile('ssh', ['-V'], { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      const text = `${stderr}${stdout}`.trim();
      if (err !== null && text === '') {
        resolve({ available: false, version: null });
        return;
      }
      resolve({
        available: text !== '',
        version: text === '' ? null : (text.split('\n')[0] ?? null),
      });
    });
  });

  clientCache = result;
  return result;
}

/** 测试用：清掉客户端探测缓存。 */
export function resetSshClientCache(): void {
  clientCache = null;
}

/** 补救说明。缺客户端时给出可以直接照做的步骤。 */
export function sshClientRemediation(): string {
  return [
    '本机没有可用的 ssh 客户端。',
    '',
    'Windows 10 1809 及以上自带 OpenSSH 客户端，若被移除可以装回来：',
    '  以管理员身份运行 PowerShell，执行',
    '  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
    '',
    '装好后在终端执行 ssh -V 应该能看到版本号。',
    '',
    '平台刻意用系统的 ssh 而不是自带一个实现：你的 ~/.ssh/config 里的跳板机、',
    '私钥与 agent 配置因此可以直接生效。',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 命令构造
 * ------------------------------------------------------------------ */

/** `user@host` 或 `host`（后者让 ~/.ssh/config 里的 User 生效）。 */
export function sshDestination(config: SshTargetConfig): string {
  const user = (config.user ?? '').trim();
  return user === '' ? config.host : `${user}@${config.host}`;
}

/**
 * 把一段远程命令包成「本机不解析、远端也不二次解析」的形式。
 *
 * `ssh host cmd...` 会把 argv 拼成一个字符串交给远端**登录 shell**解析。也就是说
 * 引号、`$`、反引号、`&&`、换行都会被远端再解释一遍——而作业脚本里这些字符是常态
 * （`$SLURM_ARRAY_TASK_ID`、heredoc、多行 if）。任何「小心地加引号」的方案都会在
 * 某个字符组合上破功，而破功的表现是命令被截断成一半后执行。
 *
 * 因此：本地 base64 编码，远端解码后喂给 `sh`。base64 的字母表是
 * `A-Za-z0-9+/=`，其中没有任何对 shell 有意义的字符，单引号包住它是安全的。
 */
export function wrapRemoteCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  // 用 printf 而不是 echo：不同 shell 的 echo 对反斜杠与 -n 的处理不一致
  return `printf '%s' '${encoded}' | base64 -d | /bin/sh -s`;
}

interface BuildArgsInput {
  config: SshTargetConfig;
  /** 远程要执行的内容。已经过 `wrapRemoteCommand`。 */
  remote: string;
  /** 允许未知主机公钥。仅 `scanHostKey` 之后的首次写入流程用。 */
  connectTimeoutSec?: number;
}

function buildSshArgs(input: BuildArgsInput): string[] {
  const { config } = input;
  const args: string[] = [
    // 不分配伪终端：远端不会启动交互式 shell，输出也不会被行缓冲搅乱
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    `ConnectTimeout=${String(input.connectTimeoutSec ?? CONNECT_TIMEOUT_SEC)}`,
    // ERROR 级别：把「连接被拒」这类信息留在 stderr 上，同时不混进调试噪声
    '-o',
    'LogLevel=ERROR',
  ];

  if (config.port !== null && config.port > 0) {
    args.push('-p', String(config.port));
  }

  for (const [key, value] of Object.entries(config.sshOptions)) {
    // 已经在登记时校验过，这里再挡一次：配置可能被手工改过库
    if (FORBIDDEN_SSH_OPTIONS[key] !== undefined || !SAFE_SSH_OPTIONS.includes(key)) continue;
    args.push('-o', `${key}=${value}`);
  }

  args.push(sshDestination(config), input.remote);
  return args;
}

/**
 * 把 ssh 的失败归类。
 *
 * 归类基于 stderr 文本，这不理想但没有替代品：OpenSSH 的退出码只有 255（连接层
 * 失败）与远端命令的退出码两种，255 本身分不出「密钥不对」和「网络不通」。
 */
export function classifySshFailure(
  stderr: string,
  exitCode: number | null,
): SshConnectionError | null {
  const text = stderr.toLowerCase();

  if (text.includes('host key verification failed') || text.includes('no matching host key')) {
    return 'host-key';
  }
  if (
    text.includes('permission denied') ||
    text.includes('no supported authentication') ||
    text.includes('too many authentication failures') ||
    text.includes('publickey')
  ) {
    return 'auth';
  }
  if (
    text.includes('connection timed out') ||
    text.includes('operation timed out') ||
    text.includes('connection refused') ||
    text.includes('no route to host') ||
    text.includes('could not resolve hostname') ||
    text.includes('network is unreachable')
  ) {
    return 'unreachable';
  }
  // 255 是 OpenSSH 自己的失败码；远端命令的非零退出不是连接问题
  return exitCode === 255 ? 'unknown' : null;
}

/** 面向用户的连接失败说明。每一类都要能指向下一步动作。 */
export function explainSshFailure(
  error: SshConnectionError,
  config: SshTargetConfig,
  stderr: string,
): string {
  const dest = sshDestination(config);
  switch (error) {
    case 'no-client':
      return sshClientRemediation();
    case 'host-key':
      return [
        `${dest} 的主机公钥没有通过验证。`,
        '',
        '两种可能，处理方式完全不同：',
        '1. 这台主机还没确认过 —— 在算力目标详情里点「确认主机公钥」，',
        '   平台会取回指纹让你核对后写进 known_hosts。',
        '2. 指纹变了 —— 可能是主机重装了系统，也可能是中间人。',
        '   在确认之前不要继续：这条通道上要发送凭据与研究数据。',
        '   核实途径是找管理员要指纹，而不是删掉 known_hosts 里的那一行。',
        '',
        `ssh 的原文：${stderr.trim()}`,
      ].join('\n');
    case 'auth':
      return [
        `${dest} 拒绝了公钥认证。`,
        '',
        '平台不支持密码登录（没有可以输入密码的终端），因此需要密钥或 ssh-agent：',
        '  1. 本机生成密钥：ssh-keygen -t ed25519',
        `  2. 把公钥装到远端：type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh ${dest} "cat >> ~/.ssh/authorized_keys"`,
        `  3. 验证：ssh ${dest} "echo ok"`,
        '',
        '如果私钥带口令，先启动 ssh-agent 并 ssh-add 一次；',
        '平台不接受私钥口令的原因与上面一样——没有可以输入它的地方。',
        '',
        `ssh 的原文：${stderr.trim()}`,
      ].join('\n');
    case 'unreachable':
      return [
        `连不上 ${dest}。`,
        '',
        '常见原因：不在校园网/VPN 内、主机名写错、端口不对、需要经跳板机。',
        '需要跳板机的话在 sshOptions 里加 ProxyJump（平台允许这个选项，',
        '它决定「怎么连上」而不是「连接安不安全」）。',
        '',
        `ssh 的原文：${stderr.trim()}`,
      ].join('\n');
    case 'unknown':
      return `ssh 报了一个归不到已知类别的错误：\n${stderr.trim()}`;
  }
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

export interface RunSshInput {
  config: SshTargetConfig;
  /** 远程要跑的脚本正文（会被 base64 包装）。 */
  script: string;
  timeoutMs?: number;
  /** 本机工作目录。ssh 本身不用它，但 spawn 需要一个存在的目录。 */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/**
 * 在远程主机上执行一段脚本。
 *
 * **不做审批**：审批是上一层（`gate.ts`）的事。这里混进审批会让「探测连通性」这类
 * 平台自己发起的调用也去弹卡片。
 */
export async function runSsh(input: RunSshInput): Promise<SshResult> {
  const client = await detectSshClient();
  if (!client.available) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: sshClientRemediation(),
      truncated: false,
      timedOut: false,
      durationMs: 0,
      connectionError: 'no-client',
    };
  }

  const args = buildSshArgs({
    config: input.config,
    remote: wrapRemoteCommand(input.script),
  });

  const result = await runSupervised({
    command: 'ssh',
    args,
    cwd: input.cwd ?? tmpdir(),
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  const connectionError = result.timedOut
    ? 'unreachable'
    : classifySshFailure(result.stderr, result.exitCode);

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    connectionError,
  };
}

/* ------------------------------------------------------------------ *
 * 主机公钥
 * ------------------------------------------------------------------ */

export interface HostKeyScan {
  ok: boolean;
  /** `SHA256:...` 形式的指纹，供用户核对。 */
  fingerprint: string | null;
  keyType: string | null;
  /** known_hosts 行的原文。用户确认后由 `trustHostKey` 写进去。 */
  raw: string | null;
  reason: string | null;
}

/**
 * 取回主机公钥指纹，**不写入** known_hosts。
 *
 * 分两步（取回 → 审批 → 写入）而不是一步 `accept-new`，因为「首次连接自动信任」
 * 恰好是中间人攻击唯一需要的窗口。取回来只是拿到一串指纹，用户拿它去和管理员
 * 公布的值核对之后才写入——这一步做不做，决定了这条通道是不是可信的。
 */
export async function scanHostKey(config: SshTargetConfig): Promise<HostKeyScan> {
  const client = await detectSshClient();
  if (!client.available) {
    return {
      ok: false,
      fingerprint: null,
      keyType: null,
      raw: null,
      reason: sshClientRemediation(),
    };
  }

  const port = config.port !== null && config.port > 0 ? config.port : 22;
  const scan = await runSupervised({
    command: 'ssh-keyscan',
    args: ['-T', '10', '-p', String(port), config.host],
    cwd: tmpdir(),
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  });

  const lines = scan.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  if (lines.length === 0) {
    return {
      ok: false,
      fingerprint: null,
      keyType: null,
      raw: null,
      reason:
        `取不到 ${config.host}:${String(port)} 的主机公钥。` +
        `主机可能不可达，或 ssh-keyscan 被防火墙挡住了。\n${scan.stderr.trim()}`,
    };
  }

  /*
   * 优先取 ed25519，其次 ecdsa，最后 rsa。
   *
   * 一台主机会同时提供多种类型的公钥，选哪个决定了此后连接用哪个算法。ed25519
   * 是当前的默认与推荐；把 rsa 排最后是因为老的 ssh-rsa（SHA-1）签名已被 OpenSSH
   * 8.8 默认禁用，选中它会导致一个「指纹确认过了但还是连不上」的怪状态。
   */
  const ranked = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ssh-rsa'];
  const chosen =
    ranked
      .map((type) => lines.find((l) => l.split(/\s+/u)[1] === type))
      .find((l) => l !== undefined) ?? lines[0];

  if (chosen === undefined) {
    return { ok: false, fingerprint: null, keyType: null, raw: null, reason: '公钥格式无法解析' };
  }

  const parts = chosen.split(/\s+/u);
  const keyType = parts[1] ?? null;

  const fingerprint = await fingerprintOf(chosen);
  if (fingerprint === null) {
    return {
      ok: false,
      fingerprint: null,
      keyType,
      raw: chosen,
      reason: '拿到了公钥但算不出指纹（ssh-keygen -lf 失败）。没有指纹就没法核对，因此不继续。',
    };
  }

  return { ok: true, fingerprint, keyType, raw: chosen, reason: null };
}

/**
 * 算一行 known_hosts 的指纹。
 *
 * 走 `ssh-keygen -lf` 而不是自己做 base64 解码 + SHA256：OpenSSH 的指纹格式对不同
 * 密钥类型有细节差异，自己算出来的值与用户从管理员那里拿到的、或者 ssh 首次连接
 * 提示里显示的值只要差一个字符，核对这一步就失去意义。
 */
async function fingerprintOf(knownHostsLine: string): Promise<string | null> {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'lsci-hostkey-'));
  const file = join(dir, `key-${randomUUID()}.pub`);
  try {
    writeFileSync(file, `${knownHostsLine}\n`, 'utf8');
    const result = await runSupervised({
      command: 'ssh-keygen',
      args: ['-lf', file],
      cwd: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
    });
    if (result.exitCode !== 0) return null;
    const match = /(SHA256:[A-Za-z0-9+/=]+)/u.exec(result.stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把已确认的主机公钥写进 known_hosts。
 *
 * 追加而不是覆盖：用户的 known_hosts 里有他自己积累的几十台主机，覆盖掉等于让
 * 他此后每台机器都要重新确认一遍。
 *
 * 写之前先查有没有同名同端口的旧行：有而且内容不同，说明指纹变了。这时**不写**，
 * 让调用方报出来——静默覆盖一条变了的主机公钥正是中间人希望发生的事。
 */
export async function trustHostKey(input: {
  raw: string;
  fingerprint: string;
}): Promise<{ ok: boolean; reason: string | null; knownHostsPath: string }> {
  const { appendFileSync, existsSync, mkdirSync, readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { dirname, join } = await import('node:path');

  const path = join(homedir(), '.ssh', 'known_hosts');
  const line = input.raw.trim();
  const parts = line.split(/\s+/u);
  const hostField = parts[0] ?? '';
  const keyType = parts[1] ?? '';

  try {
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      const conflicting = current
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .filter((l) => {
          const p = l.split(/\s+/u);
          return p[0] === hostField && p[1] === keyType;
        });

      if (conflicting.includes(line)) {
        return { ok: true, reason: '这条主机公钥已经在 known_hosts 里了。', knownHostsPath: path };
      }
      if (conflicting.length > 0) {
        return {
          ok: false,
          knownHostsPath: path,
          reason:
            `known_hosts 里已有 ${hostField} 的 ${keyType} 公钥，且与这次取到的不同。\n` +
            '这意味着主机公钥变了。可能是主机重装了系统，也可能是中间人。\n' +
            '平台不会替你覆盖它——请先向管理员核实新指纹，确认无误后手工删除 known_hosts 里的旧行。\n' +
            `这次取到的指纹：${input.fingerprint}`,
        };
      }
    }

    appendFileSync(path, `${line}\n`, 'utf8');
    return { ok: true, reason: null, knownHostsPath: path };
  } catch (err) {
    return {
      ok: false,
      knownHostsPath: path,
      reason: `写入 known_hosts 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
