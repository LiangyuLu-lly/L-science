/**
 * MCP 连接器（任务 12.13、12.14，需求 14.1、14.2）。
 *
 * **这里刻意没有导出任何 ToolDefinition。** 需求 14.2 规定 MCP 表面只在控制面 REPL 内核
 * 暴露，Python 与 R 内核不得具备 MCP 通道。注册一个 `mcp_call` 工具进 ToolRegistry 就等于
 * 把这个通道给了普通内核——而那比走 host 表面方便得多，因此是最容易不小心违反的一条。
 *
 * 要用 MCP 就写控制面代码（`host.mcp.*`）。
 */

export {
  CLIENT_CAPABILITIES,
  MCP_PROTOCOL_VERSION,
  McpError,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  contentToText,
  toMcpError,
} from './protocol.js';
export type {
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  McpContent,
  McpInitializeResult,
  McpPrompt,
  McpResource,
  McpServerInfo,
  McpTool,
  McpToolResult,
} from './protocol.js';

export { HttpMcpTransport, StdioMcpTransport, defaultStdioAllowList } from './transport.js';
export type { HttpTransportOptions, McpTransport, StdioTransportOptions } from './transport.js';

export { DEFAULT_CALL_TIMEOUT_MS, McpClient } from './client.js';
export type { McpCallContext, McpCallOutcome, McpClientOptions, ToolGrantStore } from './client.js';

export { McpManager, connectorFingerprint } from './manager.js';
export type { ConnectorStatus, ConnectorToolInfo, McpManagerOptions } from './manager.js';

export { BUILTIN_CONNECTOR_GROUPS, BUILTIN_CONNECTORS, syncBuiltinConnectors } from './builtin.js';
export type { BuiltinConnector, BuiltinConnectorGroup, SyncBuiltinResult } from './builtin.js';

export { McpBridgeServer, buildRequest, pickPath, toMcpTool } from './bridge.js';
export type { BridgeServerOptions, BridgeSpec, EndpointParam, EndpointSpec } from './bridge.js';

export { BRIDGE_SPECS, bridgeIds } from './bridge-catalog.js';
