/**
 * MCP 协议的线格式（任务 12.13，需求 14.1）。
 *
 * MCP 是 JSON-RPC 2.0 之上的一层约定。这里刻意不引官方 SDK，自己实现这一层，理由具体：
 *
 * 1. **依赖约束。** 本项目的硬约束是「所有原生依赖必须有 prebuilt」，而通用 SDK 会带进
 *    一串传递依赖，其中任何一个引入需现场编译的包都会让整个安装在没有 C 工具链的机器上
 *    失败。JSON-RPC over stdio/SSE 的实现量不大，自己写换来的是依赖面可控。
 * 2. **错误语义要能透出。** 平台在协议错误上有明确要求（错误码 + 用户可读消息 + 可否重试），
 *    而 SDK 抛出的异常形状与这套信封对不上，包一层反而更绕。
 * 3. **审批要插在调用路径中间。** 每次 `tools/call` 之前可能需要用户批准，这要求调用路径
 *    是我们自己的代码，而不是 SDK 内部的一次 await。
 *
 * 只实现平台真正用到的方法。刻意不做 sampling（让服务端反过来调模型）——那会让一个外部
 * 连接器能消耗用户的 token 预算，而这个决定权应该始终在平台侧。
 */

/** JSON-RPC 请求。`id` 省略即通知（不期待响应）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** 平台声明的协议版本。服务端不支持时按它返回的版本降级或拒绝。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * 我们声明的客户端能力。
 *
 * `roots` 与 `sampling` 都不声明：
 * - `roots` 会把本机目录结构告诉服务端，而连接器不需要知道用户的文件布局。
 * - `sampling` 会让服务端能请求模型推理，等于把 token 预算的决定权交出去。
 *
 * 声明得少不会让任何合规的服务端不可用——MCP 要求服务端在客户端不声明某能力时不使用它。
 */
export const CLIENT_CAPABILITIES = Object.freeze({});

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, unknown>;
  };
  serverInfo: McpServerInfo;
  instructions?: string;
}

/** 服务端暴露的一个工具。`inputSchema` 是 JSON Schema。 */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /**
   * 服务端声明的行为提示。
   *
   * **这只是提示，不是保证。** 一个声称 `readOnlyHint: true` 的工具完全可以写数据——
   * 提示由服务端自己填，没有任何强制机制。因此它只能用来决定「默认要不要问用户」，
   * 不能用来跳过授权检查。
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
}

/** 工具调用的返回内容块。 */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

export interface McpToolResult {
  content: readonly McpContent[];
  /**
   * 工具层面的失败（区别于协议层面的错误）。
   *
   * 这个区分很重要：`isError: true` 表示工具执行了但结果是失败（查询没命中、参数不合业务
   * 规则），模型应当读到这个失败并调整；JSON-RPC 的 `error` 表示调用根本没走通（方法不存在、
   * 服务端崩了），那是需要用户或运维介入的问题。混为一谈会让模型对着一个环境故障反复重试。
   */
  isError?: boolean;
  structuredContent?: unknown;
}

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

/** JSON-RPC 保留错误码。 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export class McpError extends Error {
  readonly code: number;
  readonly data: unknown;
  /** 是否值得重试。传输层与 5xx 可重试，方法不存在与参数错不可重试。 */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: number; data?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'McpError';
    this.code = options.code ?? RPC_INTERNAL_ERROR;
    this.data = options.data;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * 把服务端返回的错误翻成 McpError。
 *
 * 可重试性按错误码判定：`-32601`（方法不存在）与 `-32602`（参数错）重试一万次也一样，
 * 而重试它们会让模型在一个死路上耗完回合预算。
 */
export function toMcpError(error: JsonRpcError): McpError {
  const permanent = [RPC_METHOD_NOT_FOUND, RPC_INVALID_PARAMS, RPC_INVALID_REQUEST];
  return new McpError(error.message, {
    code: error.code,
    data: error.data,
    retryable: !permanent.includes(error.code),
  });
}

/** 把工具返回的内容块压成给模型看的文本。 */
export function contentToText(content: readonly McpContent[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'audio': {
        // 不把 base64 塞进上下文：几百 KB 的 base64 会挤掉真正的内容，而模型读不出图里画了什么
        const kb = Math.round((block.data.length * 3) / 4 / 1024);
        parts.push(`[${block.type} ${block.mimeType}，${String(kb)} KB]`);
        break;
      }
      case 'resource_link':
        parts.push(`[资源链接 ${block.uri}${block.name === undefined ? '' : ` (${block.name})`}]`);
        break;
      case 'resource': {
        const r = block.resource;
        if (typeof r.text === 'string') parts.push(r.text);
        else parts.push(`[资源 ${r.uri}${r.mimeType === undefined ? '' : ` ${r.mimeType}`}]`);
        break;
      }
    }
  }
  return parts.join('\n');
}
