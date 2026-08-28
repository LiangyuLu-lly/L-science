/**
 * 控制面（需求 10.8）。
 *
 * 四层：回环 RPC 服务、方法实现、Python 侧 shim、单例 REPL 与旁路内核。
 *
 * 一条贯穿的边界：**控制面是特权面。** 只有控制面 REPL 的内核拿到 token，
 * 普通 `python` 工具的内核调不到这里。这个边界靠「独立的内核池实例」在结构上
 * 保证，而不是靠一处条件判断——后者漏一个分支就等于把特权 token 注入了普通
 * 分析内核。
 */

export { HostRpcServer } from './server.js';
export type { HostCallContext, HostRpcHandler, HostRpcServerOptions } from './server.js';

export { assertReadOnlySql, registerHostMethods } from './methods.js';
export type { HostMethodDeps, RegisteredHost } from './methods.js';

export { buildHostShim, hostInitCode } from './shim.js';
export type { BuildShimInput, ShimPending, ShimSurface } from './shim.js';

export { ControlRepl } from './repl.js';
export type { ControlReplOptions, ReplMode, ReplRunResult } from './repl.js';

export { createControlReplAdminTool, createControlReplTool } from './tools.js';
export type { ControlReplInput, ControlReplStatusInput, ControlReplToolOptions } from './tools.js';
