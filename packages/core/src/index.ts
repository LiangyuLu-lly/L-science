/**
 * @l-science/core — 控制平面。
 *
 * 按 AD-1，这个包跑在一个独立的系统 Node 24 进程里（不是 Electron 内置 Node），
 * 因此可以自由使用 Node-API 原生模块，且 UI 崩溃不会带走正在运行的长任务。
 */

export { openDatabase, migrate, schemaVersion, sqliteVersion } from './db.js';
export type { Db, Migration } from './db.js';

export { MIGRATIONS } from './migrations.js';

export { appPaths, projectPaths, dataDir, blobRelPath, APP_DIR_NAME } from './paths.js';
export type { AppPaths, ProjectPaths } from './paths.js';
