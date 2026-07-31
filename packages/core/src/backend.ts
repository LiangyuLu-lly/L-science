/**
 * 控制平面后端进程入口。
 *
 * M0 阶段的职责：初始化数据目录、打开默认项目库、应用迁移、报告就绪状态。
 *
 * 刻意还没有开监听端口。渲染层与后端之间的传输通道属于 M1，届时会走
 * Electron IPC 转发或绑定在 127.0.0.1 的本地套接字，并且需要一并决定
 * 鉴权方式（本机多用户场景下 localhost 并不等于可信）。
 */

import { mkdirSync } from 'node:fs';

import { openDatabase, migrate, schemaVersion, sqliteVersion } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { appPaths, projectPaths } from './paths.js';

const DEFAULT_PROJECT_ID = 'default';

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

function main(): void {
  const paths = appPaths();
  for (const dir of [
    paths.config,
    paths.credentials,
    paths.projects,
    paths.runtimeKernels,
    paths.runtimeEnvs,
    paths.skillsBuiltin,
    paths.skillsUser,
    paths.logs,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  log(`数据目录 ${paths.root}`);

  const project = projectPaths(DEFAULT_PROJECT_ID);
  mkdirSync(project.blobs, { recursive: true });
  mkdirSync(project.workspace, { recursive: true });
  mkdirSync(project.logs, { recursive: true });

  const db = openDatabase(project.db);
  const appliedCount = migrate(db, MIGRATIONS);
  log(
    `SQLite ${sqliteVersion(db)} schema v${String(schemaVersion(db))}` +
      (appliedCount > 0 ? `（本次应用 ${String(appliedCount)} 条迁移）` : '（无待应用迁移）'),
  );
  db.close();

  log('控制平面就绪');

  // 保持进程存活，等待外壳的退出信号。
  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，退出`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  setInterval(() => {
    /* 心跳占位，M1 换成真正的事件循环 */
  }, 60_000);
}

main();
