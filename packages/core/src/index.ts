/**
 * @l-science/core — 控制平面。
 *
 * 按 AD-1，这个包跑在一个独立的系统 Node 24 进程里（不是 Electron 内置 Node），
 * 因此可以自由使用 Node-API 原生模块，且 UI 崩溃不会带走正在运行的长任务。
 */

export { openDatabase, migrate, schemaVersion, sqliteVersion } from './db.js';
export type { Db, Migration } from './db.js';

export { APP_MIGRATIONS } from './migrations/app.js';
export { PROJECT_MIGRATIONS } from './migrations/project.js';

export { appPaths, projectPaths, dataDir, blobRelPath, APP_DIR_NAME } from './paths.js';
export type { AppPaths, ProjectPaths } from './paths.js';

export { AppStore, ProjectStore } from './store.js';

export { ProjectRepo } from './repo/projects.js';
export type { Project, CreateProjectInput } from './repo/projects.js';

export { ConversationRepo, MessageRepo, ToolCallRepo } from './repo/conversations.js';
export type {
  Conversation,
  ConversationStatus,
  Message,
  MessageRole,
  MessagePage,
  AppendMessageInput,
  ToolCall,
  ToolCallStatus,
  Usage,
} from './repo/conversations.js';

export * from './sandbox/index.js';

export {
  JobObject,
  InterruptEvent,
  nativeCapabilities,
  win32,
  win32Available,
} from './win32/index.js';
export type { JobLimits, NativeCapabilities, Win32Api } from './win32/index.js';

export { Dispatcher, DispatchError } from './dispatcher.js';
export type { HandlerContext, RequestHandler, EventSink } from './dispatcher.js';

export { LineDecoder, StdioTransport, DEFAULT_MAX_FRAME_BYTES } from './transport.js';
export type { TransportOptions, DecodeResult } from './transport.js';
