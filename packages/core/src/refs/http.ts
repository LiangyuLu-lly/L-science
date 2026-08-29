/**
 * 文献上游的 HTTP 访问层（任务 13.1，需求 12.1、12.3、12.6）。
 *
 * 为什么不复用 `mcp/bridge.ts`：那是给**模型**用的表面，一次调用对应模型的一次
 * 决策，因此它可以把失败原样交回去让模型自己判断要不要重试。这里是后端自己的
 * 检索层，一次「解析这个 DOI」会串起四家上游、十几个请求，失败必须在这一层就
 * 收敛成一句可读的原因，否则调用点要为每家上游各写一遍错误翻译。
 *
 * 两件事在这一层解决，放到调用点会被漏掉：
 *
 * 1. **按主机限速**。NCBI 无 API key 时硬限 3 req/s，超了直接 429；一次二十条
 *    文献的批量解析会发四十个请求。不限速的表现不是「慢」而是「一半文献解析失败」，
 *    而失败原因看起来像是网络问题。
 * 2. **有界重试**。429 与 503 在这些公共接口上是常态（不是异常），且它们会给
 *    Retry-After。不重试等于把一次正常的限流变成用户可见的失败。
 */

/** 上游标识。 */
export type RefSourceId =
  | 'crossref'
  | 'openalex'
  | 'semanticscholar'
  | 'pubmed'
  | 'europepmc'
  | 'datacite'
  | 'arxiv'
  | 'unpaywall'
  | 'openaire';

/**
 * User-Agent。
 *
 * Crossref 与 NCBI 都在礼节说明里要求标明身份与联系方式，且 Crossref 会把带
 * 联系方式的请求路由到更宽松的池子。匿名请求在高峰期被限流得更狠——这不是
 * 合规问题，是能不能用的问题。
 */
export const REF_USER_AGENT = 'L-science/1 (research workbench; local-first; mailto:%MAILTO%)';

/** 请求默认超时。比 MCP 桥的 45 秒短：这一层要串多家上游，单家卡住会拖垮整次解析。 */
export const DEFAULT_REF_TIMEOUT_MS = 20_000;

/** 单次响应的字符上限。超出按失败处理而不是截断——截断的 JSON 解析必然失败。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** 联系邮箱。进 User-Agent 与 Crossref/OpenAlex 的 mailto 参数。 */
  mailto?: string | null;
  signal?: AbortSignal;
  /** 额外请求头。凭据类的头放这里，不进日志。 */
  headers?: Readonly<Record<string, string>>;
  /** 期望的响应类型。json 时会解析并在拿到 HTML 时报错。 */
  accept?: 'json' | 'text' | 'binary';
  limiter?: HostRateLimiter;
  /** 最多重试次数（只对 429/503/504 生效）。默认 2。 */
  maxRetries?: number;
  onLog?: (line: string) => void;
}

export interface HttpResult {
  ok: boolean;
  status: number | null;
  url: string;
  /** accept 为 json 时的解析结果。失败时为 null。 */
  json: unknown;
  /** accept 为 text 时的正文；json 失败时也带上前若干字符用于排错。 */
  text: string | null;
  /** accept 为 binary 时的正文。 */
  bytes: Buffer | null;
  contentType: string | null;
  /** 失败原因。ok 时为 null。文案面向用户，说清是哪一步失败以及能不能重试。 */
  reason: string | null;
  /** 实际发生的请求次数（含重试）。 */
  attempts: number;
  /** 服务端在重定向后的最终地址。用于把「PDF 其实是登录页」这类情况报清楚。 */
  finalUrl: string | null;
  /** 上游 Retry-After 换算出的毫秒数。重试等待优先用它而不是自己猜。 */
  retryAfterMs: number | null;
}

/**
 * 按主机的最小请求间隔。
 *
 * 值取自各家公开的礼节说明，并留了余量：
 * - NCBI（eutils）无 key 时 3 req/s → 350ms
 * - Crossref 未声明硬限，礼节池建议 50 req/s，这里保守到 100ms
 * - OpenAlex 建议 10 req/s → 120ms
 * - Semantic Scholar 无 key 时约 1 req/s（官方说明是「共享池」）→ 1100ms
 *
 * Semantic Scholar 这个值明显偏慢，但它是实测下唯一不 429 的间隔。把它调快的
 * 后果是批量解析里它总是失败，于是这家上游等于不存在。
 */
const HOST_MIN_INTERVAL_MS: Readonly<Record<string, number>> = {
  'eutils.ncbi.nlm.nih.gov': 350,
  'api.crossref.org': 100,
  'api.openalex.org': 120,
  'api.semanticscholar.org': 1100,
  'www.ebi.ac.uk': 200,
  'api.datacite.org': 200,
  'export.arxiv.org': 350,
  'api.unpaywall.org': 120,
  'api.openaire.eu': 300,
};

const DEFAULT_MIN_INTERVAL_MS = 150;

/**
 * 按主机串行化请求并保证最小间隔。
 *
 * 实现是每主机一条 promise 链而不是令牌桶：链式排队天然保证了顺序与串行，
 * 而令牌桶在并发调用下仍可能让两个请求同时出去（各自都看到有令牌）。
 * 代价是同一主机的请求不能并行，对公共 API 而言这正是想要的。
 */
export class HostRateLimiter {
  readonly #chains = new Map<string, Promise<void>>();
  readonly #overrides: Readonly<Record<string, number>>;

  constructor(overrides: Readonly<Record<string, number>> = {}) {
    this.#overrides = overrides;
  }

  intervalFor(host: string): number {
    return this.#overrides[host] ?? HOST_MIN_INTERVAL_MS[host] ?? DEFAULT_MIN_INTERVAL_MS;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const interval = this.intervalFor(host);
    const previous = this.#chains.get(host) ?? Promise.resolve();

    // 先把「本次占用」挂上去再执行：并发调用会各自拿到不同的 previous，
    // 从而排成一条真正的队列
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#chains.set(
      host,
      previous.then(() => slot),
    );

    await previous;
    try {
      return await fn();
    } finally {
      // 间隔在**释放时**等待而不是执行前：这样第一个请求不必白等一个间隔
      if (interval > 0) {
        const timer = setTimeout(release, interval);
        timer.unref?.();
      } else {
        release();
      }
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Retry-After 头。秒数或 HTTP 日期两种形式都要认。上限 10 秒。 */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 10_000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** HTML 嗅探。期望 JSON 却拿到网页时要报错，而不是把登录页当成结果。 */
function looksLikeHtml(text: string, contentType: string | null): boolean {
  if (contentType !== null && /text\/html/i.test(contentType)) return true;
  const head = text.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * 发一次请求，带限速、超时与有界重试。
 *
 * 永不抛异常：全部失败都变成 `ok: false` 加一句原因。调用方要串四家上游，
 * 每家都用 try/catch 包一遍会让编排逻辑埋在异常处理里。
 */
export async function httpRequest(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const accept = options.accept ?? 'json';
  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 5));
  const limiter = options.limiter;
  const host = hostOf(url);

  const mailto = options.mailto ?? null;
  const ua =
    mailto === null || mailto.trim() === ''
      ? REF_USER_AGENT.replace('; mailto:%MAILTO%', '')
      : REF_USER_AGENT.replace('%MAILTO%', mailto.trim());

  const acceptHeader =
    accept === 'json'
      ? 'application/json'
      : accept === 'text'
        ? 'text/plain, application/xml, text/xml, */*'
        : '*/*';

  const base: HttpResult = {
    ok: false,
    status: null,
    url,
    json: null,
    text: null,
    bytes: null,
    contentType: null,
    reason: null,
    attempts: 0,
    finalUrl: null,
    retryAfterMs: null,
  };

  let attempts = 0;

  for (let round = 0; round <= maxRetries; round += 1) {
    if (options.signal?.aborted === true) {
      return { ...base, attempts, reason: '请求已被取消' };
    }

    attempts += 1;

    const exec = async (): Promise<HttpResult> => {
      const controller = new AbortController();
      const timeout = options.timeoutMs ?? DEFAULT_REF_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();

      // 外部中断要能穿透进去：用户点停止时不该等到超时
      const onAbort = (): void => {
        controller.abort();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const res = await doFetch(url, {
          method: 'GET',
          headers: {
            'user-agent': ua,
            accept: acceptHeader,
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
          redirect: 'follow',
        });

        const contentType = res.headers.get('content-type');
        const finalUrl = typeof res.url === 'string' && res.url !== '' ? res.url : url;

        // 先看长度声明。超限时不读正文：读一个 200MB 的响应会把内存吃光
        const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          return {
            ...base,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            reason:
              `响应声明 ${String(Math.round(declared / 1024 / 1024))}MB，超过 ` +
              `${String(MAX_RESPONSE_BYTES / 1024 / 1024)}MB 上限，已放弃读取。`,
          };
        }

        if (!res.ok) {
          let snippet = '';
          try {
            snippet = (await res.text()).slice(0, 300);
          } catch {
            // 错误响应读不出来不影响结论：状态码本身已经说明问题
          }
          return {
            ...base,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            text: snippet === '' ? null : snippet,
            retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
            reason: describeStatus(res.status, snippet),
          };
        }

        if (accept === 'binary') {
          let buffer: Buffer;
          try {
            buffer = Buffer.from(await res.arrayBuffer());
          } catch (err) {
            return {
              ...base,
              status: res.status,
              contentType,
              finalUrl,
              attempts,
              reason: `响应正文读取失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
          if (buffer.byteLength > MAX_RESPONSE_BYTES) {
            return {
              ...base,
              status: res.status,
              contentType,
              finalUrl,
              attempts,
              reason: `响应 ${String(Math.round(buffer.byteLength / 1024 / 1024))}MB 超过上限。`,
            };
          }
          return {
            ...base,
            ok: true,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            bytes: buffer,
          };
        }

        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          // 单独兜住而不是吞成空串：空串会被下游当成「上游返回了空结果」
          return {
            ...base,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            reason: `响应正文读取失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }

        if (accept === 'text') {
          return { ...base, ok: true, status: res.status, contentType, finalUrl, attempts, text };
        }

        if (looksLikeHtml(text, contentType)) {
          return {
            ...base,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            text: text.slice(0, 300),
            reason:
              '期望 JSON 但收到 HTML 页面。常见原因是接口地址变了、需要登录，' +
              '或者被中间网络设备拦截并返回了提示页。',
          };
        }

        try {
          return {
            ...base,
            ok: true,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            json: JSON.parse(text) as unknown,
            text,
          };
        } catch (err) {
          return {
            ...base,
            status: res.status,
            contentType,
            finalUrl,
            attempts,
            text: text.slice(0, 300),
            reason: `响应不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } catch (err) {
        const aborted = controller.signal.aborted;
        const external = options.signal?.aborted === true;
        return {
          ...base,
          attempts,
          reason: aborted
            ? external
              ? '请求已被取消'
              : `请求超过 ${String(options.timeoutMs ?? DEFAULT_REF_TIMEOUT_MS)}ms 未完成`
            : `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    };

    const result = limiter === undefined ? await exec() : await limiter.run(host, exec);

    if (result.ok) return result;

    // 只对限流与网关类错误重试。404 重试一百次也还是 404，而 401 重试会
    // 让上游把这个来源整体拉黑
    const retriable =
      result.status === 429 ||
      result.status === 502 ||
      result.status === 503 ||
      result.status === 504 ||
      (result.status === null && result.reason?.startsWith('网络请求失败') === true);

    if (!retriable || round === maxRetries) {
      return { ...result, attempts };
    }

    // 上游给了 Retry-After 就听它的：自己猜的退避在 429 上要么太短（继续被拒）
    // 要么太长（白等）。上游知道它自己的窗口什么时候重置
    const wait = result.retryAfterMs ?? Math.min(500 * 2 ** round, 4000);
    options.onLog?.(
      `${host} 返回 ${String(result.status ?? 0)}，${String(wait)}ms 后重试（第 ${String(round + 1)} 次）`,
    );
    await sleep(wait);
  }

  return { ...base, attempts, reason: '重试次数已用尽' };
}

/** 把状态码翻译成可读原因，并说明下一步。 */
function describeStatus(status: number, snippet: string): string {
  const tail = snippet.trim() === '' ? '' : `\n上游返回：${snippet.trim()}`;
  if (status === 400) return `请求被拒（400），参数可能不合法。${tail}`;
  if (status === 401 || status === 403) {
    return `无访问权限（${String(status)}）。该接口可能需要 API key 或该资源不对外开放。${tail}`;
  }
  if (status === 404) return `上游没有这条记录（404）。${tail}`;
  if (status === 410) return `资源已被上游永久移除（410）。${tail}`;
  if (status === 429) return `被上游限流（429）。${tail}`;
  if (status >= 500) return `上游服务异常（${String(status)}），稍后可重试。${tail}`;
  return `上游返回 ${String(status)}。${tail}`;
}

/** JSON 便捷入口。 */
export async function httpJson(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  return httpRequest(url, { ...options, accept: 'json' });
}

/** 文本便捷入口（XML、FASTA、TSV）。 */
export async function httpText(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  return httpRequest(url, { ...options, accept: 'text' });
}

/** 二进制便捷入口（PDF、图片）。 */
export async function httpBytes(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  return httpRequest(url, { ...options, accept: 'binary' });
}

/* ------------------------------------------------------------------ *
 * 取值助手
 * ------------------------------------------------------------------ */

/** 安全取对象属性。上游 JSON 的形状不可信，每一层都要判。 */
export function pick(value: unknown, ...path: readonly (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

/** 取数组，非数组时返回空数组。 */
export function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
