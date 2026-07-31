/**
 * @l-science/kernel — Jupyter 内核协议客户端。
 *
 * 设计决策 AD-2：直接使用标准 Jupyter 消息协议（5 个 ZMQ 通道 + HMAC-SHA256 签名），
 * 而不是自研 stdio 协议。理由是富输出、标准中断、补全/introspection 与 R 支持
 * （IRkernel）全部免费获得。
 *
 * 本文件目前只包含协议的纯函数部分（连接文件生成、消息签名）与依赖可用性探测。
 * 完整的通道路由与消息循环属于 M1 阶段。
 */

import { createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';

import type { MimeBundle } from '@l-science/shared';

/* ------------------------------------------------------------------ *
 * 连接文件
 * ------------------------------------------------------------------ */

export type SignatureScheme = 'hmac-sha256';

/**
 * Jupyter 连接文件结构。控制平面生成该文件后传给内核进程的 `-f` 参数。
 * 字段名必须与 Jupyter 规范完全一致（snake_case），不能改。
 */
export interface ConnectionInfo {
  transport: 'tcp';
  ip: string;
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  key: string;
  signature_scheme: SignatureScheme;
  kernel_name: string;
}

/** 找一个当前空闲的 TCP 端口。让操作系统分配，避免自己维护端口池。 */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close(() => reject(new Error('无法从监听套接字获取端口号')));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 生成一份新的连接信息。
 *
 * 绑定在 127.0.0.1：Jupyter 内核通道没有传输层加密，只有 HMAC 消息签名，
 * 因此绝不能监听在对外可达的地址上。
 */
export async function createConnectionInfo(kernelName: string): Promise<ConnectionInfo> {
  const ip = '127.0.0.1';
  const ports = await Promise.all([
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
  ]);
  const [shell, iopub, stdin, control, hb] = ports as [number, number, number, number, number];

  return {
    transport: 'tcp',
    ip,
    shell_port: shell,
    iopub_port: iopub,
    stdin_port: stdin,
    control_port: control,
    hb_port: hb,
    key: randomUUID(),
    signature_scheme: 'hmac-sha256',
    kernel_name: kernelName,
  };
}

/* ------------------------------------------------------------------ *
 * 消息签名
 * ------------------------------------------------------------------ */

/** Jupyter 消息的四个可序列化段，签名与传输顺序都必须是这个顺序。 */
export interface MessageFrames {
  header: string;
  parentHeader: string;
  metadata: string;
  content: string;
}

/**
 * 按 Jupyter 规范计算消息签名：
 * HMAC-SHA256(key) 依次喂入 header、parent_header、metadata、content 四段的原始字节，
 * 输出十六进制小写字符串。
 */
export function signMessage(key: string, frames: MessageFrames): string {
  const hmac = createHmac('sha256', key);
  hmac.update(frames.header);
  hmac.update(frames.parentHeader);
  hmac.update(frames.metadata);
  hmac.update(frames.content);
  return hmac.digest('hex');
}

/**
 * 校验签名。用 `timingSafeEqual` 而不是字符串比较，避免时序侧信道。
 * 空 key 表示内核未启用签名（Jupyter 允许），此时跳过校验。
 */
export function verifyMessage(key: string, frames: MessageFrames, signature: string): boolean {
  if (key === '') return true;
  const expected = Buffer.from(signMessage(key, frames), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ *
 * 消息头
 * ------------------------------------------------------------------ */

export type JupyterMsgType =
  | 'execute_request'
  | 'execute_reply'
  | 'execute_result'
  | 'execute_input'
  | 'stream'
  | 'display_data'
  | 'update_display_data'
  | 'error'
  | 'status'
  | 'complete_request'
  | 'complete_reply'
  | 'inspect_request'
  | 'inspect_reply'
  | 'interrupt_request'
  | 'interrupt_reply'
  | 'shutdown_request'
  | 'shutdown_reply'
  | 'input_request'
  | 'input_reply'
  | 'kernel_info_request'
  | 'kernel_info_reply';

export interface JupyterHeader {
  msg_id: string;
  session: string;
  username: string;
  date: string;
  msg_type: JupyterMsgType;
  version: string;
}

/** Jupyter 消息协议版本。5.3 是当前内核普遍实现的版本。 */
export const JUPYTER_PROTOCOL_VERSION = '5.3' as const;

export function createHeader(
  msgType: JupyterMsgType,
  session: string,
  username = 'l-science',
): JupyterHeader {
  return {
    msg_id: randomUUID(),
    session,
    username,
    date: new Date().toISOString(),
    msg_type: msgType,
    version: JUPYTER_PROTOCOL_VERSION,
  };
}

/** 会话 id。内核用它区分不同客户端，同一内核的所有消息应共用一个。 */
export function createSessionId(): string {
  return randomBytes(16).toString('hex');
}

/* ------------------------------------------------------------------ *
 * 内核句柄契约（M1 实现）
 * ------------------------------------------------------------------ */

export type KernelLanguage = 'python' | 'r';

export interface KernelSpec {
  language: KernelLanguage;
  /** conda 环境名，或已注册的 venv 名。 */
  envName: string;
  /** 内核工作目录，必须落在项目 workspace 内。 */
  cwd: string;
}

export type KernelMessage =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'execute_result'; data: MimeBundle; executionCount: number }
  | { type: 'display_data'; data: MimeBundle }
  | { type: 'error'; ename: string; evalue: string; traceback: readonly string[] }
  | { type: 'status'; state: 'busy' | 'idle' | 'starting' };

export interface KernelHandle {
  execute(code: string, opts?: { silent?: boolean }): AsyncIterable<KernelMessage>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  isAlive(): Promise<boolean>;
  shutdown(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 依赖探测
 * ------------------------------------------------------------------ */

export interface ZeromqProbe {
  available: boolean;
  /** libzmq 版本，例如 4.3.5。 */
  version?: string;
  error?: string;
}

/**
 * 探测 zeromq 原生绑定是否可用。
 *
 * 本机没有 C/C++ 工具链，所以我们完全依赖 zeromq 发布的 prebuilt 二进制。
 * 这个探测存在的意义就是把「prebuilt 没匹配上当前 ABI」这类问题在启动时暴露，
 * 而不是等到用户第一次跑 python cell 才炸。
 */
export async function probeZeromq(): Promise<ZeromqProbe> {
  try {
    const zmq = await import('zeromq');
    const version = (zmq as { version?: string }).version;
    return version === undefined ? { available: true } : { available: true, version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
