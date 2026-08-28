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
import { dirname, join as joinPath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultRegistry } from '@l-science/adapters';
import { detectKernels } from '@l-science/kernel';
import type { TurnEvent } from '@l-science/shared';

import { ApprovalService } from './approval/service.js';
import { QuestionService } from './approval/questions.js';
import { ArtifactStore } from './artifact/store.js';
import { createDeleteArtifactsTool, createSaveArtifactsTool } from './artifact/tools.js';
import { CredentialVault } from './credentials/vault.js';
import { DispatchError } from './dispatcher.js';
import { schemaVersion, sqliteVersion } from './db.js';
import {
  ConversationBusyError,
  Orchestrator,
  SubAgentRunner,
  createAgentStatusTool,
  createDelegateTool,
  createGuideAgentTool,
  createStopAgentTool,
} from './orchestrator/index.js';
import {
  createGeneratePlanTool,
  createPlanStatusTool,
  parsePlanSpec,
  PlanSpecError,
  validatePlan,
  describeIssues as describePlanIssues,
  planExecutable,
} from './plan/index.js';
import { ApprovalRepo } from './repo/approvals.js';
import { PlanRepo } from './repo/plans.js';
import { GrantRepo } from './repo/grants.js';
import {
  RegistryRepo,
  RegistrySync,
  buildRouterView,
  type ModelHealth,
  type ProviderRecord,
} from './repo/registry.js';
import { buildTaskProfile, route } from './router/index.js';
import { RoutingRepo } from './repo/routing.js';
import { UsageRepo } from './repo/usage.js';
import { isolationStrength } from './sandbox/backend.js';
import { requestHostAccess } from './sandbox/host-access.js';
import { selectBackend } from './sandbox/index.js';
import { AppStore, type ProjectStore } from './store.js';
import { SkillAuditRepo } from './repo/skills.js';
import {
  createLoadSkillReferenceTool,
  createOllamaEmbedder,
  createSearchSkillsTool,
  describeMissing,
  installBuiltinSkills,
  probeCommands,
  probePythonModules,
  probeRPackages,
  SkillManager,
  type Embedder,
} from './skills/index.js';
import { capabilityProbe, detectCapabilities, REMEDIATION } from './tools/capabilities.js';
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

  d.register('conversation.children', async (req) => {
    const project = openProject(store, req.projectId);
    const children = project.conversations.children(req.conversationId);
    // 在跑的子 agent 附上运行状态：库里只有会话行，不知道它此刻是否还活着
    const runner = subAgentRunners.get(req.projectId);
    const live = new Map(
      (runner?.list(req.conversationId) ?? []).map((h) => [h.conversationId, h]),
    );

    return {
      children: children.map((c) => {
        const handle = live.get(c.id);
        return {
          ...c,
          running: handle !== undefined,
          agentStatus: handle?.status ?? null,
          blocking: handle?.blocking ?? null,
        };
      }),
    };
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
  const usageRepos = new Map<string, UsageRepo>();
  const routingRepos = new Map<string, RoutingRepo>();
  const skillAudits = new Map<string, SkillAuditRepo>();
  const planRepos = new Map<string, PlanRepo>();
  const subAgentRunners = new Map<string, SubAgentRunner>();
  const vault = new CredentialVault();
  const capabilities = detectCapabilities();
  const adapters = createDefaultRegistry();

  /*
   * 供应商与模型注册表在**应用库**里，与项目无关：一份凭据配置服务所有项目。
   * 因此只需要一个实例，不像用量与路由记录那样按项目分。
   */
  const modelRegistry = new RegistryRepo(store.db);
  const modelSync = new RegistrySync(store.db, modelRegistry);

  /**
   * 组装某个供应商的适配器上下文。
   *
   * 编排器（发起对话）与设置页（同步模型、健康检查）都需要它。写成一处共享而
   * 不是各写一份：两份实现分歧的表现是「聊天能用但设置页里健康检查一直失败」，
   * 而这种不一致会被当成供应商侧的问题去排查。
   *
   * 返回 null 表示这家供应商还不能用（未登记或没有基地址）。
   */
  const adapterContextFor = (providerId: string): { baseUrl: string; apiKey?: string } | null => {
    const provider = modelRegistry.getProvider(providerId);
    if (provider === null || provider.baseUrl === null) return null;
    // 两个条件都要查：库文件不存在时没什么可读，DPAPI 不可用时读会抛错，
    // 而这里抛出去会变成一句「internal」，掩盖掉「这台机器存不了凭据」这个事实
    const apiKey =
      provider.credentialRef === null || !vault.available || !vault.exists
        ? undefined
        : (vault.get(provider.credentialRef) ?? undefined);
    return { baseUrl: provider.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };
  };

  /** 路由视图。设置页与试算都要用，凭据存在性的判定必须与编排器一致。 */
  const routerViewNow = (): ReturnType<typeof buildRouterView> =>
    buildRouterView({
      repo: modelRegistry,
      hasCredential: (ref) => ref !== null && vault.available && vault.exists && vault.has(ref),
    });

  /* --- 技能系统（任务 12.1-12.4）------------------------------------- */

  // 内置技能由平台拥有，每次启动同步一次。幂等：内容未变时不写文件
  installBuiltinSkills({
    targetDir: store.paths.skillsBuiltin,
    fromDir: dirname(fileURLToPath(import.meta.url)),
    onLog: log,
  });

  const kernelEnvs = detectKernels();

  /**
   * 嵌入层。
   *
   * 用注册表里已启用的本地供应商（Ollama）做嵌入，而不是另外配一份地址：用户
   * 已经登记过一次本机推理服务，再要他配第二遍是多余的。没有本地供应商时
   * `embedder` 为 null，检索退回纯词法层——那条路必须始终可用，否则「装好平台后
   * 要先做两步配置才能检索技能」会让绝大多数人从没用过技能系统。
   */
  const embedderNow = (): Embedder | null => {
    const local = modelRegistry
      .listProviders({ includeDisabled: false })
      .find((p) => p.adapter === 'ollama' && p.baseUrl !== null);
    if (local?.baseUrl === undefined || local.baseUrl === null) return null;

    const model = process.env['L_SCIENCE_EMBED_MODEL'];
    return createOllamaEmbedder({
      baseUrl: local.baseUrl,
      ...(model === undefined || model === '' ? {} : { model }),
    });
  };

  const skills = new SkillManager({
    builtinDir: store.paths.skillsBuiltin,
    userDir: store.paths.skillsUser,
    db: store.db,
    probes: {
      python: probePythonModules(kernelEnvs.python?.executable ?? null),
      r: probeRPackages(kernelEnvs.r?.rscript ?? null),
      commands: probeCommands(),
      // 连接器要到 M5 才有，此刻恒为空集：声明了连接器依赖的技能会如实报「缺失」，
      // 而不是假装满足
      connectors: () => new Set<string>(),
      capabilities: () => capabilities.available,
    },
    ...(capabilities.pythonEnv === null ? {} : { pythonEnv: capabilities.pythonEnv }),
    ...(capabilities.rEnv === null ? {} : { rEnv: capabilities.rEnv }),
    capabilityRemediation: REMEDIATION,
    embedder: embedderNow(),
    onLog: log,
  });

  {
    const catalog = skills.reload();
    log(
      `技能：生效 ${String(catalog.skills.size)} 个` +
        `（用户覆盖 ${String(catalog.shadowed.length)}，加载失败 ${String(catalog.broken.length)}）`,
    );
    /*
     * 向量层在后台构建，不阻塞启动。
     *
     * 它要向 Ollama 发三十几段文本，本机首次调用还可能触发模型加载——把它放在
     * 启动路径上会让后端「就绪」延后好几秒，而这期间用户什么都做不了。检索在
     * 向量就绪之前照常工作（纯词法），就绪后自动增强。
     */
    void skills
      .buildVectors()
      .then((r) => {
        if (r.built + r.cached > 0) {
          log(`技能嵌入：新建 ${String(r.built)}，命中缓存 ${String(r.cached)}`);
        }
      })
      .catch(() => undefined);
  }

  const orchestratorFor = (projectId: string): Orchestrator => {
    const existing = orchestrators.get(projectId);
    if (existing !== undefined) return existing;

    const project = openProject(store, projectId);
    const artifactStore = new ArtifactStore(project.db, project.paths.blobs);
    // 用量与路由记录都在项目库里：成本要按项目汇总，而决策要与该项目的
    // 会话关联
    const usageRepo = new UsageRepo(project.db);
    const routingRepo = new RoutingRepo(project.db);
    usageRepos.set(projectId, usageRepo);
    routingRepos.set(projectId, routingRepo);

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

    /*
     * 技能工具（任务 12.2、12.3）。
     *
     * 审计记在项目库：「这次会话为什么用了睡眠分期技能」是项目内的追溯问题。
     * 审计写入失败不能让工具调用失败——记不下来是遗憾，因此把整次分析中断是荒谬的。
     */
    const skillAudit = new SkillAuditRepo(project.db);
    skillAudits.set(projectId, skillAudit);

    const auditSkillLoad = (input: Parameters<SkillAuditRepo['record']>[0]): void => {
      try {
        skillAudit.record(input);
      } catch (err) {
        log(`技能加载审计写入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    tools.register(createSearchSkillsTool({ manager: skills, audit: auditSkillLoad }));
    tools.register(createLoadSkillReferenceTool({ manager: skills, audit: auditSkillLoad }));

    /* --- 计划（任务 12.5）------------------------------------------- */

    const planRepo = new PlanRepo(project.db);
    planRepos.set(projectId, planRepo);

    const planToolOptions = {
      repo: () => planRepo,
      availableSkills: () =>
        new Set(
          skills
            .records()
            .filter((r) => r.enabled)
            .map((r) => r.slug),
        ),
      disabledSkills: () =>
        new Set(
          skills
            .records()
            .filter((r) => !r.enabled)
            .map((r) => r.slug),
        ),
      // 用编排器实际持有的那份工具注册表，而不是另建一个：两处分歧会让计划校验
      // 说某个工具可用而执行时它并不存在
      availableTools: () => new Set(tools.toolSchemas().map((s) => s.name)),
      skillsWithMissingRequirements: (): ReadonlyMap<string, string> => {
        const out = new Map<string, string>();
        for (const record of skills.records()) {
          const report = skills.requirementsOf(record.slug);
          if (report === null || report.satisfied) continue;
          out.set(record.slug, describeMissing(report));
        }
        return out;
      },
      onPlanCreated: (planId: string, conversationId: string) => {
        // 广播而不是挂请求：计划生成发生在工具执行里，而 UI 需要立刻显示它
        d.broadcast({ kind: 'plan.created', planId, conversationId, projectId });
      },
    };

    tools.register(createGeneratePlanTool(planToolOptions));
    tools.register(createPlanStatusTool(planToolOptions));

    /* --- 子 agent 委派（任务 12.6）---------------------------------- */

    /*
     * 子 agent 与主 agent 共用同一份工具注册表。共用是刻意的：子 agent 能做的事
     * 不该比主 agent 多也不该少，而两份注册表的条件注册结果可能分歧
     * （比如探测缓存在两次构造之间失效）。
     *
     * 委派工具本身在下面注册进同一份注册表——因此子 agent 也能再委派。深度不设限
     * 但并发有上限，实际上限由并发额度自然形成。
     */
    const subAgents = new SubAgentRunner({
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools,
      adapters,
      usage: usageRepo,
      routing: routingRepo,
      skills,
      routerView: routerViewNow,
      adapterContext: adapterContextFor,
      experience: () => routingRepo.experience(),
      // 子 agent 各有自己的工作目录：共用目录时两个并行 agent 各写一份同名文件，
      // 后写的赢，且没有任何地方会报
      workspaceDir: (agentId) => {
        const dir = joinPath(project.paths.workspace, `sub_${agentId}`);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      projectId,
      onLog: log,
    });
    subAgentRunners.set(projectId, subAgents);

    const delegateOptions = {
      runner: subAgents,
      availableSkills: () =>
        new Set(
          skills
            .records()
            .filter((r) => r.enabled)
            .map((r) => r.slug),
        ),
      onEvent: (event: {
        kind: 'agent.started' | 'agent.finished';
        agentId: string;
        conversationId: string;
        parentConversationId: string;
        detail?: string;
      }) => {
        d.broadcast({ ...event, projectId });
      },
    };

    tools.register(createDelegateTool(delegateOptions));
    tools.register(createAgentStatusTool(delegateOptions));
    tools.register(createGuideAgentTool(delegateOptions));
    tools.register(createStopAgentTool(delegateOptions));

    const orchestrator = new Orchestrator({
      projectId,
      subAgents,
      conversations: project.conversations,
      messages: project.messages,
      toolCalls: project.toolCalls,
      tools,
      adapters,
      usage: usageRepo,
      routing: routingRepo,
      // 每次路由都重新汇总反馈：缓存它会让刚刚产生的信号在下一次决策时
      // 不生效，而「用户重试后立刻换个模型」正是反馈闭环最该起作用的时刻
      experience: () => routingRepo.experience(),
      routerView: routerViewNow,
      adapterContext: adapterContextFor,
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
      events = orchestrator.startTurn(req.conversationId, req.text, req.routing ?? {});
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

  /* --- 用量与成本（任务 11.10）--- */

  /** 确保项目的仓储已建好。它们随编排器一起懒加载。 */
  const usageFor = (projectId: string): UsageRepo => {
    orchestratorFor(projectId);
    const repo = usageRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  const routingFor = (projectId: string): RoutingRepo => {
    orchestratorFor(projectId);
    const repo = routingRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  d.register('usage.summary', async (req) => {
    const usage = usageFor(req.projectId);
    const range = {
      ...(req.from === undefined ? {} : { from: req.from }),
      ...(req.to === undefined ? {} : { to: req.to }),
    };

    return {
      scope: req.conversationId === undefined ? 'project' : 'conversation',
      summary:
        req.conversationId === undefined
          ? usage.byProject(range)
          : usage.byConversation(req.conversationId, range),
    };
  });

  d.register('usage.breakdown', async (req) => {
    const usage = usageFor(req.projectId);
    const range = {
      ...(req.from === undefined ? {} : { from: req.from }),
      ...(req.to === undefined ? {} : { to: req.to }),
    };

    return {
      byModel: usage.byModel(range),
      failures: usage.failures(range),
      daily: usage.daily(range),
      recent: usage.recent(30),
    };
  });

  d.register('routing.history', async (req) => ({
    decisions: routingFor(req.projectId).byConversation(req.conversationId, req.limit),
  }));

  d.register('routing.feedback', async (req) => {
    routingFor(req.projectId).addSignal(req.routingDecisionId, req.signal, req.source);
    return { recorded: true };
  });

  /* --- 路由试算（任务 11.11，需求 7.6、7.14）--- */

  d.register('routing.preview', async (req) => {
    const view = routerViewNow();
    const override = req.routing ?? {};

    const profile = buildTaskProfile(override.taskType ?? req.taskType, {
      estimatedInputTokens: req.estimatedInputTokens,
      expectedOutputTokens: req.expectedOutputTokens,
      needToolUse: req.needToolUse,
      requiredModalities: req.requiredModalities,
      ...(override.weightOverrides === undefined
        ? {}
        : { weightOverrides: override.weightOverrides }),
      ...(override.preferLocal === undefined ? {} : { preferLocal: override.preferLocal }),
      ...(override.requireTrainingOptOut === undefined
        ? {}
        : { requireTrainingOptOut: override.requireTrainingOptOut }),
      ...(override.costBudget === undefined ? {} : { costBudget: override.costBudget }),
      ...(override.latencyBudgetMs === undefined
        ? {}
        : { latencyBudgetMs: override.latencyBudgetMs }),
    });

    /*
     * 试算把经验修正也算进去，否则它给出的排序会与真发出去时不一致——
     * 而一个「预览与实际不符」的预览比没有预览更糟。
     *
     * 探索加成刻意排除（explorationRate 传 0）：它含随机性，会让同样的输入
     * 每次预览给出不同结果，用户无法据此判断自己调的权重起了什么作用。
     */
    const experience =
      req.projectId === undefined ? undefined : routingFor(req.projectId).experience();

    const result = route({
      models: view.models,
      profile,
      runtime: view.runtime,
      explorationRate: 0,
      ...(experience === undefined ? {} : { experience }),
      ...(override.forcedModelId === undefined ? {} : { forcedModelId: override.forcedModelId }),
    });

    return {
      decision: result.decision,
      // 候选的显示信息一并返回：UI 要在得分表旁边显示模型名、是否本地、价格，
      // 而 decision.scores 里只有 id
      candidates: result.ranked.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        displayName: m.displayName,
        local: m.local,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        pricing: m.pricing,
      })),
      emptyReport: result.emptyReport,
      // 把生效的权重回传，用户才能看清「我没覆盖的维度默认是多少」
      weights: profile.weights,
    };
  });

  /* --- 供应商与模型注册表（任务 11.1b，需求 8.5、8.6）--- */

  const providerOr404 = (providerId: string): ProviderRecord => {
    const provider = modelRegistry.getProvider(providerId);
    if (provider === null) {
      throw notFound(
        `供应商未登记：${providerId}`,
        '用 node scripts/provision.mjs 登记供应商，或检查 id 是否拼错。',
      );
    }
    return provider;
  };

  d.register('provider.list', async () => {
    const providers = modelRegistry.listProviders({ includeDisabled: true });
    const refs = vault.available && vault.exists ? new Set(vault.list()) : new Set<string>();

    return {
      // 凭据库不可用（非 Windows 或 DPAPI 缺失）时明确说出来，否则界面上
      // 「未绑定凭据」会被当成用户忘了配，而实际是这台机器存不了凭据
      vaultAvailable: vault.available,
      providers: providers.map((p) => {
        const models = modelRegistry.listModels({
          providerId: p.id,
          includeDisabled: true,
        });
        return {
          ...p,
          adapterRegistered: adapters.has(p.adapter),
          credentialPresent: p.credentialRef !== null && refs.has(p.credentialRef),
          modelCount: models.length,
          enabledModelCount: models.filter((m) => m.enabled).length,
        };
      }),
    };
  });

  d.register('provider.setEnabled', async (req) => {
    providerOr404(req.providerId);
    modelRegistry.setProviderEnabled(req.providerId, req.enabled);
    return { providerId: req.providerId, enabled: req.enabled };
  });

  d.register('provider.setCredentialRef', async (req) => {
    providerOr404(req.providerId);

    // 绑定一个不存在的引用名会让该供应商的模型全部因「缺少凭据」被排除，
    // 而界面上看起来是已配置的。当场拒绝比事后困惑好
    if (
      req.credentialRef !== null &&
      !(vault.available && vault.exists && vault.has(req.credentialRef))
    ) {
      throw new DispatchError(
        makeError('bad_request', `凭据库里没有 ${req.credentialRef}`, {
          remediation: '先用 credential.set 写入该引用名，再绑定到供应商。',
        }),
      );
    }

    modelRegistry.setProviderCredentialRef(req.providerId, req.credentialRef);
    return { providerId: req.providerId, credentialRef: req.credentialRef };
  });

  d.register('provider.sync', async (req) => {
    const provider = providerOr404(req.providerId);
    const ctx = adapterContextFor(req.providerId);
    if (ctx === null) {
      throw new DispatchError(
        makeError('bad_request', `供应商 ${req.providerId} 缺少基地址`, {
          remediation: '在供应商记录里填写 baseUrl。',
        }),
      );
    }

    let discovered;
    try {
      discovered = await adapters.get(provider.adapter).listModels(ctx);
    } catch (err) {
      // 同步失败的原因几乎总是可执行的（密钥过期、服务没起、网络不通），
      // 因此原文透出而不是包成一句「同步失败」
      // provider_error 而不是 internal：这不是本平台的 bug，而且它可重试——
      // UI 据此给出「重试」而不是「请报告问题」
      throw new DispatchError(
        makeError('provider_error', `向 ${provider.name} 查询模型失败`, {
          detail: err instanceof Error ? err.message : String(err),
          remediation:
            provider.baseUrl?.includes('127.0.0.1') === true
              ? '本地服务可能没启动。确认 Ollama 正在运行（ollama list）。'
              : '检查凭据是否有效、基地址是否正确、网络是否可达。',
        }),
      );
    }

    const result = modelSync.sync(req.providerId, discovered);
    return {
      ...result,
      // 同步后的完整列表一并返回，省掉界面再发一次 model.list
      models: modelRegistry.listModels({ providerId: req.providerId, includeDisabled: true }),
    };
  });

  d.register('provider.checkHealth', async (req) => {
    const provider = providerOr404(req.providerId);
    const ctx = adapterContextFor(req.providerId);
    if (ctx === null) {
      throw new DispatchError(makeError('bad_request', `供应商 ${req.providerId} 缺少基地址`));
    }

    let health: ModelHealth;
    try {
      const probed = await adapters.get(provider.adapter).health(ctx);
      health = {
        ok: probed.ok,
        latencyMs: probed.latencyMs,
        checkedAt: Date.now(),
        ...(probed.detail === undefined ? {} : { detail: probed.detail }),
      };
    } catch (err) {
      // 探测本身抛错也是一个健康结论（不健康），要落库——否则路由会继续
      // 按「未检查过即视为健康」去选它，然后在真实调用上失败
      health = {
        ok: false,
        latencyMs: 0,
        checkedAt: Date.now(),
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    /*
     * 健康结果记在该供应商的**每个模型**上。
     *
     * 供应商级的探测无法区分「整站故障」与「某个型号下线」，但前者远更常见，
     * 而把结果只记在一个代表模型上会让其余模型带着过期信息参与路由。宁可
     * 一起标记，代价是某个型号单独出问题时会误伤同厂其他型号——那种情况会在
     * 真实调用失败后由用量记录暴露出来。
     */
    const models = modelRegistry.listModels({
      providerId: req.providerId,
      includeDisabled: true,
    });
    for (const model of models) modelRegistry.recordHealth(model.id, health);

    return { providerId: req.providerId, health, appliedTo: models.length };
  });

  d.register('model.list', async (req) => ({
    models: modelRegistry.listModels({
      ...(req.providerId === undefined ? {} : { providerId: req.providerId }),
      includeDisabled: req.includeDisabled,
    }),
  }));

  d.register('model.setEnabled', async (req) => {
    if (modelRegistry.getModel(req.modelId) === null) {
      throw notFound(`模型不在注册表中：${req.modelId}`, '先同步该供应商的模型列表。');
    }
    modelRegistry.setModelEnabled(req.modelId, req.enabled);
    return { modelId: req.modelId, enabled: req.enabled };
  });

  /* --- 凭据（任务 11.1b，需求 8.5、8.6、18.5）--- */

  /**
   * 凭据库不可用时统一的报错。不可用不是 bug，是平台限制，要说清楚。
   *
   * 判据是 `available`（DPAPI 能不能用）而**不是** `exists`（库文件在不在）。
   * 两者混用会让全新安装的机器无法录入第一条凭据——那时候库文件当然还不存在，
   * 而这恰好是最需要能写入的时刻。
   */
  const requireVault = (): void => {
    if (vault.available) return;
    throw new DispatchError(
      makeError('unavailable', '凭据库不可用', {
        detail: '凭据加密依赖 Windows DPAPI。',
        remediation: '在 Windows 上运行，或改用无需凭据的本地模型（Ollama）。',
      }),
    );
  };

  d.register('credential.list', async () => {
    // available 表示「这台机器能不能存凭据」，exists 表示「已经存过没有」。
    // 界面需要区分这两件事：前者不满足时该说平台限制，后者只是还没配
    if (!vault.available) return { available: false, credentials: [] };
    if (!vault.exists) return { available: true, credentials: [] };

    return {
      available: true,
      // 只出键名与指纹。指纹是长度加末四位——足够用户确认存进去的是哪一个，
      // 不足以重建它
      credentials: vault.list().map((ref) => ({ ref, fingerprint: vault.fingerprint(ref) })),
    };
  });

  d.register('credential.set', async (req) => {
    requireVault();
    vault.set(req.ref, req.secret);
    // 回执里不带任何密钥内容，只带指纹
    return { ref: req.ref, fingerprint: vault.fingerprint(req.ref) };
  });

  /* --- 技能（任务 12.1-12.3）--- */

  d.register('skill.list', async () => {
    const catalog = skills.catalog;
    const records = skills.records();

    return {
      /** 词法检索永远可用；向量层可选。界面要能说出当前是哪种状态。 */
      vectorsReady: skills.vectorsReady,
      embedFailure: skills.embedFailure,
      builtinDir: store.paths.skillsBuiltin,
      userDir: store.paths.skillsUser,
      skills: records.map((record) => {
        const loaded = catalog.skills.get(record.slug);
        const requirements = skills.requirementsOf(record.slug);
        return {
          slug: record.slug,
          name: record.name,
          version: record.version,
          scope: record.scope,
          domain: record.domain,
          description: record.manifest.description,
          triggers: record.manifest.triggers,
          tools: record.manifest.tools,
          requires: record.manifest.requires,
          enabled: record.enabled,
          path: record.path,
          /** 文件系统上是否还在。同步只禁用不删行，这一项让界面能区分两者。 */
          present: loaded !== undefined,
          references: loaded?.references ?? [],
          scripts: loaded?.scripts ?? [],
          warnings: loaded?.warnings ?? [],
          requirementsSatisfied: requirements?.satisfied ?? null,
          missing: requirements?.missing ?? [],
          probeFailures: requirements?.probeFailures ?? [],
        };
      }),
      // 被用户技能遮蔽的内置技能。查不到它，「我的改动生效了吗」无从确认
      shadowed: catalog.shadowed.map((s) => ({
        slug: s.manifest.slug,
        name: s.manifest.name,
        version: s.manifest.version,
        path: s.path,
      })),
      broken: catalog.broken,
    };
  });

  d.register('skill.reload', async (req) => {
    const catalog = skills.reload();
    const result = req.rebuildVectors
      ? await skills.buildVectors()
      : { built: 0, cached: 0, failed: skills.embedFailure };

    return {
      active: catalog.skills.size,
      shadowed: catalog.shadowed.length,
      broken: catalog.broken.length,
      vectors: result,
    };
  });

  d.register('skill.setEnabled', async (req) => {
    if (!skills.setEnabled(req.slug, req.enabled)) {
      throw notFound(`技能不在注册表中：${req.slug}`, '先重新扫描技能目录。');
    }
    return { slug: req.slug, enabled: req.enabled };
  });

  d.register('skill.search', async (req) => {
    const hits = await skills.search(req.query, req.limit);
    return {
      vectorsReady: skills.vectorsReady,
      hits: hits.map((hit) => ({
        slug: hit.slug,
        name: hit.manifest.name,
        domain: hit.manifest.domain,
        description: hit.manifest.description,
        scope: hit.scope,
        score: hit.score,
        lexicalScore: hit.lexicalScore,
        vectorScore: hit.vectorScore,
        matchedTerms: hit.matchedTerms,
        requirementsSatisfied: hit.requirementsSatisfied,
        missingSummary: hit.missingSummary,
        references: hit.references,
      })),
    };
  });

  d.register('skill.audit', async (req) => {
    // 审计仓储随编排器一起懒加载
    orchestratorFor(req.projectId);
    const audit = skillAudits.get(req.projectId);
    if (audit === undefined) throw notFound(`项目不可用：${req.projectId}`);

    return {
      events: audit.byConversation(req.conversationId, req.limit),
      summary: audit.summary(),
    };
  });

  /* --- 计划（任务 12.5）--- */

  const planFor = (projectId: string): PlanRepo => {
    orchestratorFor(projectId);
    const repo = planRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  /** 计划 + 各步状态 + 进度。UI 要的是这三者的组合，分三次请求没有意义。 */
  const planView = (
    repo: PlanRepo,
    plan: NonNullable<ReturnType<PlanRepo['get']>>,
  ): Record<string, unknown> => ({
    id: plan.id,
    conversationId: plan.conversationId,
    status: plan.status,
    createdAt: plan.createdAt,
    spec: plan.spec,
    steps: repo.steps(plan.id),
    progress: repo.progress(plan.id),
  });

  d.register('plan.list', async (req) => {
    const repo = planFor(req.projectId);
    return {
      plans: repo.byConversation(req.conversationId, req.limit).map((plan) => planView(repo, plan)),
    };
  });

  d.register('plan.get', async (req) => {
    const repo = planFor(req.projectId);
    const plan = repo.get(req.planId);
    if (plan === null) throw notFound(`计划不存在：${req.planId}`);
    return { plan: planView(repo, plan) };
  });

  d.register('plan.decide', async (req) => {
    const repo = planFor(req.projectId);
    const plan = repo.get(req.planId);
    if (plan === null) throw notFound(`计划不存在：${req.planId}`);

    if (plan.status !== 'draft') {
      // 已经批准过的计划再批准一次是无操作，但静默成功会掩盖「UI 显示的状态是旧的」
      throw new DispatchError(
        makeError('conflict', `计划已是 ${plan.status} 状态，不能再次决议`, {
          remediation: '刷新后查看当前状态。需要改动请重新生成一份计划。',
        }),
      );
    }

    repo.setStatus(req.planId, req.decision === 'approve' ? 'approved' : 'rejected');

    // 决议推给会话：模型需要知道用户批准了没有，以及拒绝的理由
    d.broadcast({
      kind: 'plan.decided',
      planId: req.planId,
      conversationId: plan.conversationId,
      projectId: req.projectId,
      decision: req.decision,
      note: req.note ?? null,
    });

    return { planId: req.planId, status: req.decision === 'approve' ? 'approved' : 'rejected' };
  });

  d.register('plan.replace', async (req) => {
    const repo = planFor(req.projectId);
    const plan = repo.get(req.planId);
    if (plan === null) throw notFound(`计划不存在：${req.planId}`);

    let spec;
    try {
      spec = parsePlanSpec(req.spec);
    } catch (err) {
      throw new DispatchError(
        makeError(
          'bad_request',
          err instanceof PlanSpecError ? `计划结构不合法：${err.message}` : '计划解析失败',
        ),
      );
    }

    // 用户改的计划同样要过校验：手改很容易把某个 dependsOn 指向已删掉的步骤
    const tools = toolRegistries.get(req.projectId);
    const issues = validatePlan({
      spec,
      availableSkills: new Set(
        skills
          .records()
          .filter((r) => r.enabled)
          .map((r) => r.slug),
      ),
      disabledSkills: new Set(
        skills
          .records()
          .filter((r) => !r.enabled)
          .map((r) => r.slug),
      ),
      availableTools: new Set((tools?.toolSchemas() ?? []).map((s) => s.name)),
    });

    if (!planExecutable(issues)) {
      throw new DispatchError(
        makeError('bad_request', '修改后的计划无法执行', {
          detail: describePlanIssues(issues),
        }),
      );
    }

    const result = repo.replaceSpec(req.planId, spec);
    if (!result.ok) {
      throw new DispatchError(makeError('conflict', result.reason));
    }

    const updated = repo.get(req.planId);
    return {
      plan: updated === null ? null : planView(repo, updated),
      issues,
    };
  });

  d.register('credential.delete', async (req) => {
    requireVault();

    // 仍被供应商引用的凭据不许直接删：删掉之后该供应商的模型会全部因
    // 「缺少凭据」被排除，而界面上供应商看起来还是配好的
    const users = modelRegistry
      .listProviders({ includeDisabled: true })
      .filter((p) => p.credentialRef === req.ref);
    if (users.length > 0) {
      throw new DispatchError(
        makeError('conflict', `凭据 ${req.ref} 仍被 ${String(users.length)} 家供应商引用`, {
          detail: users.map((p) => p.name).join('、'),
          remediation: '先解除这些供应商的凭据绑定，再删除。',
        }),
      );
    }

    return { deleted: vault.delete(req.ref) };
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

    /*
     * 子 agent 全部停掉，含非阻塞的。
     *
     * 这里与「用户中断不取消非阻塞子 agent」不冲突：那条保护的是「一次闲聊式的
     * 中断不该杀掉长作业」，而这里进程本身要退了，留着它们只会变成孤儿——它们的
     * 内核进程还在，但没有任何东西会去收结果。
     */
    for (const runner of subAgentRunners.values()) runner.stopAll('后端正在关闭');

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
