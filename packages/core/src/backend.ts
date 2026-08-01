/**
 * 控制平面后端进程入口。
 *
 * stdout 被 NDJSON 协议通道独占，因此**所有日志都必须走 stderr**。往 stdout
 * 写一行普通文本就会让对端解析失败，而且症状是「偶发的协议错误」，极难定位。
 *
 * 刻意不开监听端口：M1 没有跨机需求，而 localhost 在多用户 Windows 上并不等于
 * 可信，开端口就得同时解决鉴权。stdio 的可达性天然等于「持有这个子进程句柄」。
 */

import { mkdirSync } from 'node:fs';

import { makeError } from '@l-science/shared';

import { openDatabase, migrate, schemaVersion, sqliteVersion } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { appPaths, projectPaths, type AppPaths } from './paths.js';
import { StdioTransport } from './transport.js';

const DEFAULT_PROJECT_ID = 'default';

/** 日志一律走 stderr，见文件头说明。 */
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

interface BootResult {
  paths: AppPaths;
  sqlite: string;
  schema: number;
  migrationsApplied: number;
}

function boot(): BootResult {
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

  const project = projectPaths(DEFAULT_PROJECT_ID);
  mkdirSync(project.blobs, { recursive: true });
  mkdirSync(project.workspace, { recursive: true });
  mkdirSync(project.logs, { recursive: true });

  const db = openDatabase(project.db);
  try {
    const migrationsApplied = migrate(db, MIGRATIONS);
    return {
      paths,
      sqlite: sqliteVersion(db),
      schema: schemaVersion(db),
      migrationsApplied,
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const startedAt = Date.now();
  const info = boot();

  log(`数据目录 ${info.paths.root}`);
  log(
    `SQLite ${info.sqlite} schema v${String(info.schema)}` +
      (info.migrationsApplied > 0
        ? `（本次应用 ${String(info.migrationsApplied)} 条迁移）`
        : '（无待应用迁移）'),
  );

  const transport = new StdioTransport({
    input: process.stdin,
    output: process.stdout,
    onProtocolError: (error) => {
      // 协议错误不隐藏，但也不因此退出：单个坏帧不该让整个后端下线。
      log(
        `协议错误 ${error.code}: ${error.message}${error.detail === undefined ? '' : ` (${error.detail})`}`,
      );
    },
  });

  transport.dispatcher.register('app.status', async () => ({
    ready: true,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
    dataDir: info.paths.root,
    sqlite: info.sqlite,
    schema: info.schema,
  }));

  // env.doctor 的实现属于后续任务，这里先明确占位而不是假装成功。
  transport.dispatcher.register('env.doctor', async () => {
    throw new (await import('./dispatcher.js')).DispatchError(
      makeError('not_found', '环境自检尚未接入控制平面', {
        remediation: '暂时使用命令行 npm run doctor',
      }),
    );
  });

  transport.start();
  log('控制平面就绪，等待请求');

  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，退出`);
    void transport.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // stdin 关闭意味着外壳已经走了，跟着退出，避免留下孤儿进程。
  process.stdin.on('end', () => shutdown('stdin EOF'));
}

main();
