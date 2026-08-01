/**
 * 渲染层访问后端的封装。
 *
 * preload 暴露的 `invoke` 是 unknown 进 unknown 出。这一层把它收窄成按方法名
 * 定型的调用，并把主进程编码进 Error message 的错误码还原成结构化错误——
 * 渲染层需要按错误码决定 UI 行为（例如 policy_denied 不该显示「重试」按钮）。
 */

export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'policy_denied'
  | 'content_filtered'
  | 'sandbox_denied'
  | 'kernel_error'
  | 'provider_error'
  | 'timeout'
  | 'aborted'
  | 'internal';

const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'bad_request',
  'not_found',
  'conflict',
  'policy_denied',
  'content_filtered',
  'sandbox_denied',
]);

export class BackendError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }

  get retryable(): boolean {
    return !NON_RETRYABLE.has(this.code);
  }
}

const KNOWN_CODES = new Set<string>([
  'bad_request',
  'not_found',
  'conflict',
  'policy_denied',
  'content_filtered',
  'sandbox_denied',
  'kernel_error',
  'provider_error',
  'timeout',
  'aborted',
  'internal',
]);

/** 主进程把错误码编成 `code: message`，这里还原。无法识别时归到 internal。 */
function toBackendError(err: unknown): BackendError {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron 会给跨进程 Error 的 message 加前缀，取最后一段冒号分隔的码
  const match = /(?:^|[\s:])([a-z_]+):\s*([\s\S]*)$/.exec(raw);
  if (match !== null && KNOWN_CODES.has(match[1] ?? '')) {
    return new BackendError(match[1] as ErrorCode, (match[2] ?? '').trim());
  }
  return new BackendError('internal', raw);
}

export interface BackendEvent {
  id: string | null;
  payload: unknown;
}

type Unsubscribe = () => void;

interface LScienceApi {
  versions: { electron: string; chrome: string; node: string };
  invoke(request: unknown): Promise<unknown>;
  onEvent(listener: (event: BackendEvent) => void): Unsubscribe;
  onLog(listener: (line: string) => void): Unsubscribe;
}

declare global {
  interface Window {
    lscience?: LScienceApi;
  }
}

export function hasBackend(): boolean {
  return typeof window !== 'undefined' && window.lscience !== undefined;
}

/** 在浏览器里直接跑 UI（无 Electron）时给出明确错误，而不是 undefined 崩溃。 */
function api(): LScienceApi {
  const bridge = window.lscience;
  if (bridge === undefined) {
    throw new BackendError('internal', '未检测到 Electron 桥接层，请通过桌面外壳启动');
  }
  return bridge;
}

export interface AppStatus {
  ready: boolean;
  pid: number;
  uptimeMs: number;
  node: string;
  dataDir: string;
  sqlite: string;
  schema: number;
}

export async function invoke<T>(request: { method: string } & Record<string, unknown>): Promise<T> {
  try {
    return (await api().invoke(request)) as T;
  } catch (err) {
    throw toBackendError(err);
  }
}

export function getAppStatus(): Promise<AppStatus> {
  return invoke<AppStatus>({ method: 'app.status' });
}

export function subscribeEvents(listener: (event: BackendEvent) => void): Unsubscribe {
  return api().onEvent(listener);
}

export function subscribeLogs(listener: (line: string) => void): Unsubscribe {
  return api().onLog(listener);
}
