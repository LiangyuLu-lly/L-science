/**
 * 控制平面后端进程入口。
 *
 * stdout 被 NDJSON 协议通道独占，因此**所有日志都必须走 stderr**。往 stdout
 * 写一行普通文本就会让对端解析失败，而且症状是「偶发的协议错误」，极难定位。
 *
 * 刻意不开监听端口：M1 没有跨机需求，而 localhost 在多用户 Windows 上并不等于
 * 可信，开端口就得同时解决鉴权。stdio 的可达性天然等于「持有这个子进程句柄」。
 */

import { makeError } from '@l-science/shared';

import { DispatchError } from './dispatcher.js';
import { schemaVersion, sqliteVersion } from './db.js';
import { AppStore, type ProjectStore } from './store.js';
import { StdioTransport } from './transport.js';

/** 日志一律走 stderr，见文件头说明。 */
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

function notFound(message: string, remediation?: string): DispatchError {
  return new DispatchError(
    makeError('not_found', message, remediation === undefined ? {} : { remediation }),
  );
}

function badRequest(message: string): DispatchError {
  return new DispatchError(makeError('bad_request', message));
}

/**
 * 打开项目库，把「项目不存在」翻译成 not_found 而不是 internal。
 * 区分这两者对 UI 有意义：前者该提示用户，后者该报 bug。
 */
function openProject(store: AppStore, projectId: string): ProjectStore {
  if (store.projects.get(projectId) === null) {
    throw notFound(`项目不存在：${projectId}`);
  }
  try {
    return store.openProject(projectId);
  } catch (err) {
    throw notFound(`项目库无法打开：${projectId}`, err instanceof Error ? err.message : undefined);
  }
}

function main(): void {
  const startedAt = Date.now();
  const store = AppStore.open();

  log(`数据目录 ${store.paths.root}`);
  log(`应用库 SQLite ${sqliteVersion(store.db)} schema v${String(schemaVersion(store.db))}`);

  const dangling = store.danglingProjects();
  if (dangling.length > 0) {
    // 不静默修复：注册表与磁盘不一致是需要人知道的事实。
    log(`警告：${String(dangling.length)} 个项目在注册表中但目录缺失 -> ${dangling.join(', ')}`);
  }

  // 首次运行给一个默认项目，避免打开就是空白。
  if (store.projects.count({ includeArchived: true }) === 0) {
    const created = store.createProject({ name: '未命名项目' });
    log(`已创建默认项目 ${created.id}`);
  }

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

  const d = transport.dispatcher;

  d.register('app.status', async () => ({
    ready: true,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
    dataDir: store.paths.root,
    sqlite: sqliteVersion(store.db),
    schema: schemaVersion(store.db),
    projectCount: store.projects.count(),
    danglingProjects: dangling.length,
  }));

  d.register('env.doctor', async () => {
    throw notFound('环境自检尚未接入控制平面', '暂时使用命令行 npm run doctor');
  });

  /* --- 项目 ------------------------------------------------------------ */

  d.register('project.list', async (req) => ({
    projects: store.projects.list({ includeArchived: req.includeArchived }),
  }));

  d.register('project.create', async (req) => {
    const input =
      req.description === undefined
        ? { name: req.name }
        : { name: req.name, description: req.description };
    return { project: store.createProject(input) };
  });

  d.register('project.archive', async (req) => ({
    project: store.projects.archive(req.projectId),
  }));

  /* --- 会话 ------------------------------------------------------------ */

  d.register('conversation.list', async (req) => {
    const project = openProject(store, req.projectId);
    return { conversations: project.conversations.list() };
  });

  d.register('conversation.create', async (req) => {
    const project = openProject(store, req.projectId);
    const conversation = project.conversations.create(
      req.title === undefined ? {} : { title: req.title },
    );
    store.projects.touch(req.projectId);
    return { conversation };
  });

  d.register('conversation.history', async (req) => {
    // 会话 id 全局唯一但库是按项目分的，因此需要遍历项目来定位。
    // 项目数量是个位数到几十的量级，这个代价可以接受；等有需要再加索引表。
    for (const p of store.projects.list({ includeArchived: true })) {
      let project: ProjectStore;
      try {
        project = store.openProject(p.id);
      } catch {
        continue; // 目录缺失的项目已在启动日志里报过
      }
      if (project.conversations.get(req.conversationId) === null) continue;

      return {
        projectId: p.id,
        page: project.messages.page(req.conversationId, {
          ...(req.beforeSeq === undefined ? {} : { beforeSeq: req.beforeSeq }),
          limit: req.limit,
        }),
      };
    }
    throw notFound(`会话不存在：${req.conversationId}`);
  });

  d.register('conversation.send', async () => {
    // 真正的编排属于后续任务；此刻明确拒绝而不是假装接受了消息。
    throw badRequest('会话编排尚未实现（属于 M1 后续任务）');
  });

  d.register('conversation.interrupt', async () => {
    throw badRequest('会话编排尚未实现（属于 M1 后续任务）');
  });

  d.register('approval.decide', async () => {
    throw badRequest('审批服务尚未实现（属于任务 8.1）');
  });

  transport.start();
  log('控制平面就绪，等待请求');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，退出`);
    void transport.close().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // stdin 关闭意味着外壳已经走了，跟着退出，避免留下孤儿进程。
  process.stdin.on('end', () => shutdown('stdin EOF'));
}

main();
