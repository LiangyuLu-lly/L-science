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
  /** 该能力在这台机器上不存在（例如凭据库依赖的 DPAPI）。重试无意义。 */
  | 'unavailable'
  | 'internal';

const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'bad_request',
  'not_found',
  'conflict',
  'policy_denied',
  'content_filtered',
  'sandbox_denied',
  'unavailable',
]);

export class BackendError extends Error {
  readonly code: ErrorCode;
  /** 排障用的补充信息。 */
  readonly detail: string | undefined;
  /**
   * 用户能执行的下一步。
   *
   * 后端为几乎每个错误都填了它，而它曾经在 Electron 那一跳被整个丢掉——
   * 界面上只剩一句「凭据库里没有 xxx」，不告诉用户先去写入凭据。
   */
  readonly remediation: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { detail?: string; remediation?: string } = {},
  ) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.detail = extra.detail;
    this.remediation = extra.remediation;
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
  'unavailable',
  'internal',
]);

/** 与 shell 主进程约定的哨兵。见那一侧 encodeEnvelope 的说明。 */
const ERROR_SENTINEL = 'L-SCIENCE-ENVELOPE ';

/**
 * 还原后端的错误信封。
 *
 * 主进程把整个信封序列化成 JSON 并加哨兵前缀；Electron 会在前面接上自己的
 * 「Error invoking remote method ...」，所以要按哨兵定位而不是从头解析。
 * 保留旧的 `code: message` 分支作为兜底——新旧外壳版本混用时不至于把所有错误
 * 都归到 internal。
 */
function toBackendError(err: unknown): BackendError {
  const raw = err instanceof Error ? err.message : String(err);

  const at = raw.indexOf(ERROR_SENTINEL);
  if (at !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(at + ERROR_SENTINEL.length)) as {
        code?: unknown;
        message?: unknown;
        detail?: unknown;
        remediation?: unknown;
      };
      const code =
        typeof parsed.code === 'string' && KNOWN_CODES.has(parsed.code)
          ? (parsed.code as ErrorCode)
          : 'internal';
      return new BackendError(code, typeof parsed.message === 'string' ? parsed.message : raw, {
        ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
        ...(typeof parsed.remediation === 'string' ? { remediation: parsed.remediation } : {}),
      });
    } catch {
      // JSON 坏了就走下面的兜底，不要因为解析失败而丢掉整个错误
    }
  }

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
  exportDiagnostics?: () => Promise<void>;
  checkUpdates?: () => Promise<void>;
  getReleasesUrl?: () => Promise<string>;
  setReleasesUrl?: (url: string) => Promise<void>;
  revealPath?: (path: string) => Promise<void>;
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
  /** Electron 外壳注入的产品版本；未注入时为空字符串。 */
  version: string;
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
  if (!hasBackend()) return () => {};
  return api().onEvent(listener);
}

export function subscribeLogs(listener: (line: string) => void): Unsubscribe {
  if (!hasBackend()) return () => {};
  return api().onLog(listener);
}
