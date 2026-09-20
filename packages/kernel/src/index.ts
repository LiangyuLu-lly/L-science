/**
 * @l-science/kernel — Jupyter 内核协议客户端。
 *
 * 设计决策 AD-2：直接使用标准 Jupyter 消息协议（5 个 ZMQ 通道 + HMAC-SHA256
 * 签名），而不是自研 stdio 协议。理由是富输出、标准中断、补全/introspection
 * 与 R 支持（IRkernel）全部免费获得。
 */

export {
  SIGNATURE_DELIMITER,
  JUPYTER_PROTOCOL_VERSION,
  ProtocolError,
  createHeader,
  createSessionId,
  decodeMessage,
  encodeMessage,
  signParts,
  verifySignature,
  toKernelOutput,
} from './protocol.js';
export type {
  DecodedMessage,
  JupyterHeader,
  JupyterMsgType,
  KernelOutput,
  MimeBundle,
  SignatureScheme,
} from './protocol.js';

export {
  createConnectionInfo,
  endpoint,
  findFreePort,
  removeConnectionFile,
  writeConnectionFile,
} from './connection.js';
export type { ConnectionInfo } from './connection.js';

export { Channels } from './channels.js';
export type { ChannelsOptions, RequestChannel } from './channels.js';

export { JupyterKernel } from './kernel.js';
export type {
  CompletionReply,
  ExecuteOptions,
  InspectReply,
  KernelInfo,
  KernelInterrupter,
  KernelOptions,
} from './kernel.js';

export {
  MANAGED_PYTHON_ENV,
  MANAGED_R_ENV,
  detectKernels,
  listCondaEnvs,
  micromambaEnvPrefix,
  pythonLaunchSpec,
  rLaunchSpec,
  rEnvAt,
  resolveCondaExe,
  resolvePythonEnv,
  resolveREnv,
  writeIRkernelLauncher,
} from './launch.js';
export type { AvailableKernels, KernelLanguage, LaunchSpec, PythonEnv, REnv } from './launch.js';

export { KernelPool } from './pool.js';
export type { KernelPoolOptions, PoolEntryInfo } from './pool.js';

/** 探测 zeromq 原生绑定是否可用。本机无 C/C++ 工具链，完全依赖 prebuilt。 */
export interface ZeromqProbe {
  available: boolean;
  version?: string;
  error?: string;
}

export async function probeZeromq(): Promise<ZeromqProbe> {
  try {
    const zmq = await import('zeromq');
    const version = (zmq as { version?: string }).version;
    return version === undefined ? { available: true } : { available: true, version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
