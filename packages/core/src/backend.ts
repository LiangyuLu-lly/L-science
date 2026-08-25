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

import { mkdirSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, sep } from 'node:path';

import { createDefaultRegistry } from '@l-science/adapters';
import type { TurnEvent } from '@l-science/shared';

import { ApprovalService } from './approval/service.js';
import { QuestionService } from './approval/questions.js';
import { ArtifactStore } from './artifact/store.js';
import { createDeleteArtifactsTool, createSaveArtifactsTool } from './artifact/tools.js';
import { CredentialVault } from './credentials/vault.js';
import { DispatchError } from './dispatcher.js';
import { schemaVersion, sqliteVersion } from './db.js';
import { ConversationBusyError, Orchestrator } from './orchestrator/index.js';
import { ApprovalRepo } from './repo/approvals.js';
import { GrantRepo } from './repo/grants.js';
import { RegistryRepo, buildRouterView } from './repo/registry.js';
import { isolationStrength } from './sandbox/backend.js';
import { requestHostAccess } from './sandbox/host-access.js';
import { selectBackend } from './sandbox/index.js';
import { AppStore, type ProjectStore } from './store.js';
import { capabilityProbe, detectCapabilities } from './tools/capabilities.js';
import { createEditFileTool, createReadFileTool } from './tools/files.js';
import { ToolRegistry } from './tools/registry.js';
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

  /*
   * 会话编排（任务 8.5.4）。
   *
   * 按项目懒加载编排器：工具注册表要绑定该项目的制品存储与工作目录，
   * 共用一个会让 A 项目的会话把制品写进 B 项目的库。
   */
  const orchestrators = new Map<string, Orchestrator>();
  /**
   * 与编排器同源的工具注册表。
   *
   * `tool.list` 必须报告**编排器实际持有的那一份**，而不是另建一个。另建的话
   * 两处的条件注册结果可能分歧（比如探测缓存在两次调用之间失效），于是 UI 显示
   * 有 `r` 工具而模型那边没有——用户会以为是模型不肯用它。
   */
  const toolRegistries = new Map<string, ToolRegistry>();
  const vault = new CredentialVault();
  const capabilities = detectCapabilities();
  const adapters = createDefaultRegistry();

  const orchestratorFor = (projectId: string): Orchestrator => {
    const existing = orchestrators.get(projectId);
    if (existing !== undefined) return existing;

    const project = openProject(store, projectId);
    const registryRepo = new RegistryRepo(store.db);
    const artifactStore = new ArtifactStore(project.db, project.paths.blobs);

    const tools = new ToolRegistry({ probe: capabilityProbe(capabilities) });

    // 工具的路径解析统一走会话工作目录。PathGuard 的接入属于后续任务，
    // 这里先做最基本的边界检查，避免 `..` 逃出工作目录
    const resolveWithin = (raw: string, ctx: { workspaceDir: string }): string => {
      const resolved = resolvePath(ctx.workspaceDir, raw);
      const base = resolvePath(ctx.workspaceDir);
      if (resolved !== base && !resolved.startsWith(base + sep)) {
        throw new Error(`路径超出会话工作目录：${raw}`);
      }
      return resolved;
    };

    tools.register(
      createReadFileTool({
        resolvePath: resolveWithin,
        resolveVersion: (versionId) => artifactStore.versionPath(versionId),
      }),
    );
    tools.register(createEditFileTool({ resolvePath: resolveWithin }));
    tools.register(createSaveArtifactsTool({ store: artifactStore, resolvePath: resolveWithin }));
    tools.register(
      createDeleteArtifactsTool({ store: artifactStore, approvals: approvalFor(projectId) }),
    );

    const orchestrator = new Orchestrator({
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools,
      adapters,
      routerView: () =>
        buildRouterView({
          repo: registryRepo,
          hasCredential: (ref) => ref !== null && vault.exists && vault.has(ref),
        }),
      adapterContext: (providerId) => {
        const provider = registryRepo.getProvider(providerId);
        if (provider === null || provider.baseUrl === null) return null;
        const apiKey =
          provider.credentialRef === null || !vault.exists
            ? undefined
            : (vault.get(provider.credentialRef) ?? undefined);
        return { baseUrl: provider.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };
      },
      workspaceDir: (conversationId) => {
        // 每个会话一个子目录，避免两个会话互相覆盖同名文件
        const dir = joinPath(project.paths.workspace, conversationId);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
    });

    orchestrators.set(projectId, orchestrator);
    toolRegistries.set(projectId, tools);
    return orchestrator;
  };

  /** 会话 id 全局唯一但库按项目分，因此需要定位它属于哪个项目。 */
  const findProjectOf = (conversationId: string): string | null => {
    for (const p of store.projects.list({ includeArchived: true })) {
      try {
        if (store.openProject(p.id).conversations.get(conversationId) !== null) return p.id;
      } catch {
        continue;
      }
    }
    return null;
  };

  d.register('conversation.send', async (req, helpers) => {
    const projectId = findProjectOf(req.conversationId);
    if (projectId === null) throw notFound(`会话不存在：${req.conversationId}`);

    const orchestrator = orchestratorFor(projectId);

    let events: AsyncIterable<TurnEvent>;
    try {
      events = orchestrator.startTurn(req.conversationId, req.text);
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        throw new DispatchError(
          makeError('conflict', err.message, {
            remediation: '等当前回合结束，或调用 conversation.interrupt 中断它。',
          }),
        );
      }
      throw err;
    }

    // 事件挂在这次请求上（helpers.emit），而不是广播：渲染层需要知道
    // 这些增量属于哪一次发送，否则多个会话同时跑时无法区分
    let eventCount = 0;
    for await (const event of events) {
      eventCount += 1;
      helpers.emit(event);
    }

    store.projects.touch(projectId);
    return { delivered: true, events: eventCount };
  });

  /* --- Artifacts 视图（任务 9.3）--- */

  const artifactStoreFor = (projectId: string): ArtifactStore => {
    const project = openProject(store, projectId);
    return new ArtifactStore(project.db, project.paths.blobs);
  };

  d.register('artifact.list', async (req) => {
    const artifacts = artifactStoreFor(req.projectId);
    const records = artifacts.listArtifacts(
      req.includeDeleted === undefined ? {} : { includeDeleted: req.includeDeleted },
    );

    // 顺带带上每个制品的版本数与最新版本的血缘完整性：UI 要在列表上直接标出
    // 「这张图没有可复现血缘」，而不是让用户逐个点进去才发现
    const irreproducibleIds = new Set(artifacts.irreproducible().map((v) => v.artifactId));

    return {
      artifacts: records.map((a) => ({
        ...a,
        versionCount: artifacts.listVersions(a.id).length,
        reproducible: !irreproducibleIds.has(a.id),
      })),
    };
  });

  d.register('artifact.versions', async (req) => ({
    versions: artifactStoreFor(req.projectId).listVersions(req.artifactId),
  }));

  d.register('artifact.lineage', async (req) => {
    const artifacts = artifactStoreFor(req.projectId);
    return {
      ancestors: artifacts.ancestors(req.versionId),
      descendants: artifacts.descendants(req.versionId),
    };
  });

  d.register('artifact.describeDeletion', async (req) => ({
    candidates: artifactStoreFor(req.projectId).describeDeletion(req.artifactIds),
  }));

  d.register('artifact.restore', async (req) => ({
    restored: artifactStoreFor(req.projectId).restore(req.artifactId),
  }));

  /* --- 环境与能力（任务 9.4）--- */

  d.register('sandbox.isolation', async () => {
    const selection = await selectBackend();
    try {
      return {
        backend: selection.backend.id,
        isolation: selection.backend.isolation,
        strength: isolationStrength(selection.backend.isolation),
        skipped: selection.skipped,
      };
    } finally {
      // 只是查询隔离强度，不需要留着后端实例
      await selection.backend.dispose();
    }
  });

  d.register('tool.list', async (req) => {
    // 复用编排器持有的注册表，避免两处注册出现分歧
    orchestratorFor(req.projectId);
    const registry = toolRegistries.get(req.projectId);
    return {
      available: registry?.toolSchemas() ?? [],
      unavailable: (registry?.unavailable() ?? []).map((u) => ({
        name: u.name,
        missing: u.missing,
        explanation: registry?.explainUnavailable(u.name) ?? '',
      })),
      capabilities: [...capabilities.available].sort(),
      pythonEnv: capabilities.pythonEnv,
      rEnv: capabilities.rEnv,
    };
  });

  d.register('conversation.interrupt', async (req) => {
    const projectId = findProjectOf(req.conversationId);
    if (projectId === null) throw notFound(`会话不存在：${req.conversationId}`);

    const interrupted = await orchestratorFor(projectId).interrupt(req.conversationId);
    // 没在跑也返回成功：中断一个已经停下的东西不该报错，
    // 用户点停止时并不知道它是不是刚好结束了
    return { interrupted };
  });

  /*
   * 审批与提问（任务 8.1、8.2）。
   *
   * 审批服务需要一个项目库来落审计记录，但审批可以在任何项目的会话里发起。
   * 这里按项目 id 懒加载各自的服务实例，而不是共用一个——共用会让审计记录
   * 落到错误的项目库里，事后回查时找不到。
   */
  const approvalsByProject = new Map<string, ApprovalService>();

  const approvalFor = (projectId: string): ApprovalService => {
    const existing = approvalsByProject.get(projectId);
    if (existing !== undefined) return existing;

    const project = openProject(store, projectId);
    const service = new ApprovalService({
      repo: new ApprovalRepo(project.db),
      publish: (approval, conversationId) => {
        // 广播而不是定向到某个请求：审批是后端主动发起的，
        // 没有一个「正在等待响应的请求」可以挂靠
        d.broadcast({ kind: 'approval.request', approval, conversationId, projectId });
      },
    });
    approvalsByProject.set(projectId, service);
    return service;
  };

  const questions = new QuestionService({
    publish: (question, conversationId) => {
      d.broadcast({ kind: 'question.request', question, conversationId });
    },
  });

  d.register('approval.decide', async (req) => {
    // 审批 id 不带项目信息，因此逐个服务试。数量等于本次运行中被触碰过的
    // 项目数，是个位数量级
    for (const service of approvalsByProject.values()) {
      if (
        service.decide({
          approvalId: req.approvalId,
          decision: req.decision,
          ...(req.note === undefined ? {} : { note: req.note }),
          ...(req.scope === undefined ? {} : { scope: req.scope }),
        })
      ) {
        return { settled: true };
      }
    }
    // 明确报错而不是静默成功：静默成功会让「点了没反应」无从排查
    throw notFound(
      `审批不存在或已决议：${req.approvalId}`,
      '该审批可能已超时、已被取消，或后端在此期间重启过。',
    );
  });

  d.register('question.answer', async (req) => {
    if (!questions.answer(req.questionId, req.answer)) {
      throw notFound(
        `提问不存在或已作答：${req.questionId}`,
        '该提问可能已超时，或所属会话已被中止。',
      );
    }
    return { answered: true };
  });

  const grants = new GrantRepo(store.db);

  d.register('grant.revoke', async (req) => {
    if (grants.revokeHostPath(req.grantId)) return { revoked: true, kind: 'host-path' };
    if (grants.removeDomain(req.grantId)) return { revoked: true, kind: 'domain' };
    throw notFound(`授权不存在或已撤销：${req.grantId}`);
  });

  d.register('grant.list', async (req) => ({
    hostPaths: grants.listHostGrants(
      req.includeInactive === undefined ? {} : { includeInactive: req.includeInactive },
    ),
    domains: grants.listDomains(),
  }));

  d.register('host.requestAccess', async (req) => {
    const decision = await requestHostAccess({
      grants,
      approvals: approvalFor(req.projectId),
      hostPath: req.hostPath,
      mode: req.mode,
      purpose: req.purpose,
      projectId: req.projectId,
      conversationId: req.conversationId ?? null,
    });

    // 被拒绝时也返回 200 而不是抛错：拒绝是正常结果，用错误表达会让
    // 调用方倾向于 catch 后继续
    return decision;
  });

  transport.start();
  log('控制平面就绪，等待请求');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，退出`);

    // 必须先关审批与提问服务：它们持有 Promise 等待者，不 resolve 掉的话
    // await 它们的编排逻辑永久挂起，进程也就关不掉
    for (const service of approvalsByProject.values()) service.close();
    questions.close();

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
