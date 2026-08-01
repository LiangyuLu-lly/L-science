/**
 * Jupyter 消息协议的编解码与签名。
 *
 * 一条 wire 消息的分段形式：
 *   [可选的 routing/topic 前缀...] <IDS|MSG> signature header parent_header metadata content [buffers...]
 *
 * 关键点：iopub 的 SUB 消息带 topic 前缀，shell/control 的 DEALER 消息没有，
 * 因此定位分段必须靠查找分隔符而不是固定下标。
 */

import { createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

/** 消息分段的分隔符。规范固定为这个字面量。 */
export const SIGNATURE_DELIMITER = '<IDS|MSG>';

/** Jupyter 消息协议版本。5.3 是当前内核普遍实现的版本。 */
export const JUPYTER_PROTOCOL_VERSION = '5.3' as const;

export type SignatureScheme = 'hmac-sha256';

export type JupyterMsgType =
  | 'execute_request'
  | 'execute_reply'
  | 'execute_result'
  | 'execute_input'
  | 'stream'
  | 'display_data'
  | 'update_display_data'
  | 'clear_output'
  | 'error'
  | 'status'
  | 'complete_request'
  | 'complete_reply'
  | 'inspect_request'
  | 'inspect_reply'
  | 'is_complete_request'
  | 'is_complete_reply'
  | 'interrupt_request'
  | 'interrupt_reply'
  | 'shutdown_request'
  | 'shutdown_reply'
  | 'input_request'
  | 'input_reply'
  | 'kernel_info_request'
  | 'kernel_info_reply'
  | 'comm_open'
  | 'comm_msg'
  | 'comm_close';

export interface JupyterHeader {
  msg_id: string;
  session: string;
  username: string;
  date: string;
  msg_type: JupyterMsgType;
  version: string;
}

/** 解码后的消息。`signatureValid` 为 false 时调用方应当丢弃。 */
export interface DecodedMessage {
  header: JupyterHeader;
  parentHeader: Partial<JupyterHeader>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  buffers: Buffer[];
  signatureValid: boolean;
}

export function createSessionId(): string {
  return randomBytes(16).toString('hex');
}

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

/**
 * 计算签名：HMAC-SHA256 依次喂入 header、parent_header、metadata、content 四段的
 * **原始字节**，输出十六进制小写。
 *
 * 接受 Buffer 而不是对象，是为了让校验入站消息时能用收到的原始字节。若先
 * `JSON.parse` 再 `JSON.stringify` 去算，键序与空白的任何差异都会让校验失败，
 * 而症状是「内核消息被无声丢弃」——极难定位。
 */
export function signParts(key: string, parts: readonly Buffer[]): string {
  const hmac = createHmac('sha256', key);
  for (const part of parts) hmac.update(part);
  return hmac.digest('hex');
}

/** 用固定时间比较校验签名。空 key 表示内核未启用签名（规范允许）。 */
export function verifySignature(key: string, parts: readonly Buffer[], signature: string): boolean {
  if (key === '') return true;
  const expected = Buffer.from(signParts(key, parts), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface EncodeInput {
  key: string;
  header: JupyterHeader;
  parentHeader?: Partial<JupyterHeader>;
  metadata?: Record<string, unknown>;
  content?: Record<string, unknown>;
  buffers?: readonly Buffer[];
}

/** 编码为可直接交给 ZMQ 发送的分段数组。 */
export function encodeMessage(input: EncodeInput): Buffer[] {
  const header = Buffer.from(JSON.stringify(input.header), 'utf8');
  const parentHeader = Buffer.from(JSON.stringify(input.parentHeader ?? {}), 'utf8');
  const metadata = Buffer.from(JSON.stringify(input.metadata ?? {}), 'utf8');
  const content = Buffer.from(JSON.stringify(input.content ?? {}), 'utf8');

  const signature = signParts(input.key, [header, parentHeader, metadata, content]);

  return [
    Buffer.from(SIGNATURE_DELIMITER, 'utf8'),
    Buffer.from(signature, 'utf8'),
    header,
    parentHeader,
    metadata,
    content,
    ...(input.buffers ?? []),
  ];
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function parseJsonObject(buf: Buffer | undefined, what: string): Record<string, unknown> {
  if (buf === undefined) throw new ProtocolError(`消息缺少 ${what} 段`);
  const text = buf.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError(`${what} 段不是合法 JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${what} 段不是对象`);
  }
  return value as Record<string, unknown>;
}

function isHeader(
  value: Record<string, unknown>,
): value is Record<string, unknown> & JupyterHeader {
  return typeof value['msg_id'] === 'string' && typeof value['msg_type'] === 'string';
}

/**
 * 解码一条 wire 消息。
 *
 * 分隔符之前的分段（DEALER 的 routing id、SUB 的 topic）一律忽略。
 */
export function decodeMessage(parts: readonly Buffer[], key: string): DecodedMessage {
  const delimIndex = parts.findIndex((p) => p.toString('utf8') === SIGNATURE_DELIMITER);
  if (delimIndex === -1) {
    throw new ProtocolError(`消息中找不到分隔符 ${SIGNATURE_DELIMITER}`);
  }

  const signatureBuf = parts[delimIndex + 1];
  if (signatureBuf === undefined) throw new ProtocolError('消息缺少签名段');

  const headerBuf = parts[delimIndex + 2];
  const parentBuf = parts[delimIndex + 3];
  const metadataBuf = parts[delimIndex + 4];
  const contentBuf = parts[delimIndex + 5];

  // 先用原始字节校验，再解析。顺序反了就会踩到重序列化的坑。
  const signatureValid =
    headerBuf !== undefined &&
    parentBuf !== undefined &&
    metadataBuf !== undefined &&
    contentBuf !== undefined &&
    verifySignature(
      key,
      [headerBuf, parentBuf, metadataBuf, contentBuf],
      signatureBuf.toString('utf8'),
    );

  const header = parseJsonObject(headerBuf, 'header');
  if (!isHeader(header)) throw new ProtocolError('header 段缺少 msg_id 或 msg_type');

  return {
    header: header as unknown as JupyterHeader,
    parentHeader: parseJsonObject(parentBuf, 'parent_header') as Partial<JupyterHeader>,
    metadata: parseJsonObject(metadataBuf, 'metadata'),
    content: parseJsonObject(contentBuf, 'content'),
    buffers: parts.slice(delimIndex + 6).map((b) => Buffer.from(b)),
    signatureValid,
  };
}

/* ------------------------------------------------------------------ *
 * 归一化后的内核输出
 * ------------------------------------------------------------------ */

export interface MimeBundle {
  [mimeType: string]: unknown;
}

export type KernelOutput =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'execute_result'; data: MimeBundle; executionCount: number | null }
  | { type: 'display_data'; data: MimeBundle }
  | { type: 'update_display_data'; data: MimeBundle }
  | { type: 'clear_output'; wait: boolean }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }
  | { type: 'status'; state: 'busy' | 'idle' | 'starting' }
  | { type: 'execute_input'; code: string; executionCount: number | null };

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asMimeBundle(value: unknown): MimeBundle {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as MimeBundle)
    : {};
}

/**
 * 把 iopub 消息归一化为 `KernelOutput`。
 * 无法识别的消息类型返回 null——comm 相关消息属于 widget 协议，M1 不处理。
 */
export function toKernelOutput(msg: DecodedMessage): KernelOutput | null {
  const c = msg.content;
  switch (msg.header.msg_type) {
    case 'stream':
      return {
        type: 'stream',
        name: c['name'] === 'stderr' ? 'stderr' : 'stdout',
        text: asString(c['text']),
      };
    case 'execute_result':
      return {
        type: 'execute_result',
        data: asMimeBundle(c['data']),
        executionCount: typeof c['execution_count'] === 'number' ? c['execution_count'] : null,
      };
    case 'display_data':
      return { type: 'display_data', data: asMimeBundle(c['data']) };
    case 'update_display_data':
      return { type: 'update_display_data', data: asMimeBundle(c['data']) };
    case 'clear_output':
      return { type: 'clear_output', wait: c['wait'] === true };
    case 'error':
      return {
        type: 'error',
        ename: asString(c['ename'], 'Error'),
        evalue: asString(c['evalue']),
        traceback: Array.isArray(c['traceback'])
          ? (c['traceback'] as unknown[]).map((t) => asString(t))
          : [],
      };
    case 'status': {
      const state = c['execution_state'];
      if (state === 'busy' || state === 'idle' || state === 'starting') {
        return { type: 'status', state };
      }
      return null;
    }
    case 'execute_input':
      return {
        type: 'execute_input',
        code: asString(c['code']),
        executionCount: typeof c['execution_count'] === 'number' ? c['execution_count'] : null,
      };
    default:
      return null;
  }
}
