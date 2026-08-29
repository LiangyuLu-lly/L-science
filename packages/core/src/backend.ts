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

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultRegistry } from '@l-science/adapters';
import { KernelPool, detectKernels } from '@l-science/kernel';
import type { JupyterKernel, KernelLanguage, KernelOutput } from '@l-science/kernel';
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
  buildSystemPrompt,
  createAgentStatusTool,
  createDelegateTool,
  createGuideAgentTool,
  createStopAgentTool,
} from './orchestrator/index.js';
import {
  MEMORY_LIMITS,
  MemoryService,
  createRecallMemoryTool,
  createRememberTool,
} from './memory/index.js';
import { MemoryRepo, type MemoryKind, type MemoryScope } from './repo/memory.js';
import { ConnectorRepo } from './repo/connectors.js';
import { BRIDGE_SPECS, McpBridgeServer, McpManager, syncBuiltinConnectors } from './mcp/index.js';
import { RefLibrary, citeLine, createManageReferencesTool } from './refs/index.js';
import { RefsRepo } from './repo/refs.js';
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
import { FindingsRepo, type FindingStatus, type ReviewerTrigger } from './repo/findings.js';
import {
  ReviewerService,
  createCheckFindingsTool,
  createMarkFindingAddressedTool,
  createRequestReviewTool,
} from './reviewer/index.js';
import { RoutingRepo } from './repo/routing.js';
import { UsageRepo } from './repo/usage.js';
import { isolationStrength } from './sandbox/backend.js';
import { EgressProxy } from './sandbox/egress-proxy.js';
import { requestHostAccess } from './sandbox/host-access.js';
import { NativeBackend, nativeIsolationReport } from './sandbox/native.js';
import { PathGuard } from './sandbox/path-guard.js';
import { listWslDistros } from './sandbox/wsl2.js';
import {
  ControlRepl,
  HostRpcServer,
  createControlReplAdminTool,
  createControlReplTool,
  registerHostMethods,
} from './hostapi/index.js';
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
  /* 技能创建与导入（任务 12.15） */
  auditSkillContent,
  createCreateSkillTool,
  distillSkill,
  importSkillsFromArchive,
  importSkillsFromDirectory,
  importSkillsFromGitHub,
  readSkillOrigin,
  removeUserSkill,
  validateSkillFiles,
  writeUserSkill,
} from './skills/index.js';
import { createAskUserTool } from './tools/ask-user.js';
import { BackgroundRunner } from './tools/background.js';
import { capabilityProbe, detectCapabilities, REMEDIATION } from './tools/capabilities.js';
import { createEditFileTool, createReadFileTool } from './tools/files.js';
import { collectExecution, createKernelTool, formatExecution } from './tools/kernel-tools.js';
import { ToolRegistry } from './tools/registry.js';
import { createShellTool } from './tools/shell.js';
import { StdioTransport } from './transport.js';
import { InterruptEvent } from './win32/index.js';

/** 日志一律走 stderr，见文件头说明。 */
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

/**
 * 连接器带来的域名放行的标记。
 *
 * 用它区分「平台因为某个连接器启用而加的」与「用户自己批准的」。分不清的后果是：
 * 关掉一个连接器时把用户手工批准过的同一域名一起撤了，而他不会知道为什么。
 */
const CONNECTOR_DOMAIN_REASON = 'connector:auto';

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

async function main(): Promise<void> {
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
  const findingsRepos = new Map<string, FindingsRepo>();
  const reviewers = new Map<string, ReviewerService>();
  const memories = new Map<string, MemoryService>();
  const mcpManagers = new Map<string, McpManager>();
  const subAgentRunners = new Map<string, SubAgentRunner>();
  const refLibraries = new Map<string, RefLibrary>();

  /**
   * 每个项目的执行平面资源，退出时要逐个关掉。
   *
   * 内核是独立进程，控制面 RPC 是监听中的服务，出口代理也是。不显式关掉的话，
   * 后端退出后它们仍然活着——内核会占着几百 MB 内存，而两个监听端口会让下一次
   * 启动看起来「莫名其妙有个旧实例在」。
   */
  interface ComputePlane {
    /** 分析内核池。每会话、每子 agent 各一个内核。 */
    pool: KernelPool;
    /** 控制面内核池。独立实例，理由见构造处。 */
    controlPool: KernelPool;
    repl: ControlRepl;
    hostServer: HostRpcServer;
    proxy: EgressProxy;
    background: BackgroundRunner;
    sandbox: NativeBackend;
  }
  const computePlanes = new Map<string, ComputePlane>();

  const vault = new CredentialVault();
  const capabilities = detectCapabilities();
  const adapters = createDefaultRegistry();

  /*
   * WSL2 发行版是否存在。只影响 `bash` 工具能不能选 bash，**不**影响内核——
   * 内核跑在 Windows 上的 conda 环境里。
   *
   * 这里刻意不用 `selectBackend()`：它在有 WSL2 时会返回 wsl2 后端，于是隔离徽章
   * 显示「命名空间级隔离」，而实际上内核仍在 Windows 上裸跑。把弱隔离报成强隔离
   * 正是设计目标里明确要避免的事。要真用上 WSL2 的边界，整个执行平面（内核、
   * 工作目录、制品）都得搬进去，那是另一件工作。
   */
  let wslAvailable = false;
  try {
    wslAvailable = (await listWslDistros()).length > 0;
  } catch {
    wslAvailable = false;
  }

  /*
   * 宿主路径与域名授权。
   *
   * 声明位置提到这里是因为连接器的域名联动要用它，而那发生在启动路径上。
   */
  const grants = new GrantRepo(store.db);

  /* --- 连接器（任务 12.13、12.14，需求 14.1、14.2）------------------- */

  /*
   * 连接器注册表在**应用库**：一份连接器配置服务所有项目。与供应商注册表同理——
   * 放进项目库会让每个项目各有一份，改一处不影响其他项目。
   */
  const connectorRepo = new ConnectorRepo(store.db);

  /*
   * REST→MCP 桥。
   *
   * 五十个公共数据库都有现成的 REST 接口，桥把它们按声明式端点变成 MCP 工具。
   * 替代方案是为每个库装一个 MCP 服务端包，那在没有 C 工具链的机器上有很大概率
   * 因为某个传递依赖需要现场编译而整体安装失败。
   *
   * 必须在同步内置目录**之前**起来：目录里每个连接器的 url 指向桥的地址，而端口是
   * 监听之后才确定的。顺序反了会把 `http://127.0.0.1:0/...` 写进配置。
   */
  const bridge = new McpBridgeServer({
    specs: BRIDGE_SPECS,
    onLog: log,
  });
  await bridge.start();

  {
    const result = syncBuiltinConnectors({
      repo: connectorRepo,
      bridgeUrl: bridge.baseUrl,
      onLog: log,
    });
    log(
      `连接器：${String(connectorRepo.list({ includeDisabled: true }).length)} 个` +
        `（${String(result.groups)} 组，生效 ${String(connectorRepo.listEffective().length)}）`,
    );
  }

  /*
   * 连接器所需的域名进出口白名单。
   *
   * 不联动会出现两种半开状态，两种都没人能解释：连接器开着但域名没放行 → 每次调用都
   * 弹审批；连接器关了但域名还在白名单 → 用户以为断网了而内核里的代码照样能连。
   *
   * 用 `always` 作用域并标注来源，这样用户在授权列表里能看出这批是连接器带来的，
   * 而不是他自己批准过的。
   */
  const syncConnectorDomains = (): void => {
    const wanted = new Set(connectorRepo.effectiveDomains());
    const existing = new Map(
      grants
        .listDomains()
        .filter((d) => d.reason === CONNECTOR_DOMAIN_REASON)
        .map((d) => [d.domain, d.id]),
    );

    for (const domain of wanted) {
      if (existing.has(domain)) continue;
      try {
        grants.allowDomain({
          domain,
          mode: 'ro',
          scope: 'always',
          scopeId: null,
          reason: CONNECTOR_DOMAIN_REASON,
        });
      } catch (err) {
        log(`连接器域名放行失败 ${domain}：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 已关闭连接器留下的域名要撤回。只撤我们自己加的那些
    for (const [domain, id] of existing) {
      if (wanted.has(domain)) continue;
      grants.removeDomain(id);
    }
  };
  syncConnectorDomains();

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

  const buildOrchestrator = async (projectId: string): Promise<Orchestrator> => {
    const project = openProject(store, projectId);
    const artifactStore = new ArtifactStore(project.db, project.paths.blobs);
    // 用量与路由记录都在项目库里：成本要按项目汇总，而决策要与该项目的
    // 会话关联
    const usageRepo = new UsageRepo(project.db);
    const routingRepo = new RoutingRepo(project.db);
    usageRepos.set(projectId, usageRepo);
    routingRepos.set(projectId, routingRepo);

    const tools = new ToolRegistry({ probe: capabilityProbe(capabilities) });

    /* --- 出口代理（任务 5.6，需求 5.8、5.9）------------------------- */

    /*
     * 每个项目一个代理实例。
     *
     * 共用一个全局代理能省一个端口，代价是拿不到归属：`EgressAttempt` 里只有主机
     * 与端口，无从知道是哪个项目的内核发起的，于是审批既不知道该记进谁的审计，
     * 也无法在卡片上说明是哪个项目要连这个域名。域名授权本身仍是全局的
     * （批准一次到处有效），这也是刻意的——同一个用户对 pypi.org 的判断不会
     * 因项目而异。
     */
    const proxy = new EgressProxy({
      grants,
      projectId,
      requestApproval: async (attempt) => {
        const result = await approvalFor(projectId).request({
          kind: 'domain-allowlist',
          title: `允许访问 ${attempt.host}:${String(attempt.port)}？`,
          detail:
            '执行平面里的代码正在尝试' +
            (attempt.tunnel
              ? `建立 HTTPS 隧道到 ${attempt.host}:${String(attempt.port)}`
              : `向 ${attempt.host}:${String(attempt.port)} 发起 ${attempt.method} 请求`) +
            '。\n这个域名不在白名单里。常见原因是装包（pip/conda）、下载数据集，' +
            '或者某个库在上报统计。',
          impact:
            '批准后执行平面可以与该域名通信：既可能把工作区里的数据发出去，' +
            '也可能把外部代码拉进执行环境。',
          reversible: true,
          undoHint: '在设置的授权列表里撤销该域名。',
          scopeOptions: ['once', 'project', 'always'],
          payload: { host: attempt.host, port: attempt.port },
        });

        if (result.state !== 'approved') return false;

        // once 不落授权记录：它的意义正是「放行这一次但不建立长期授权」
        if (result.scope !== 'once') {
          try {
            grants.allowDomain({
              domain: attempt.host,
              mode: 'rw',
              scope: result.scope,
              scopeId: result.scope === 'project' ? projectId : null,
              reason: `用户在项目 ${projectId} 内批准`,
            });
          } catch (err) {
            // 写授权失败不该反过来否掉用户刚做的决定，但要留痕
            log(`域名授权写入失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return true;
      },
      onAttempt: (attempt, verdict) => {
        if (!verdict.allowed) {
          log(
            `出口拦截 ${attempt.host}:${String(attempt.port)}（${verdict.reason}）${verdict.detail}`,
          );
        }
      },
    });

    /*
     * 必须在内核池之前把代理起起来。
     *
     * `extraEnv` 在内核启动那一刻才被调用，但它是同步函数——代理还没监听时它返回
     * 空对象，于是那个内核的全部网络访问完全绕过管控，**而且不会有任何报错**。
     * 这类静默失效在这个代码库里反复出现过，所以这里用 await 把顺序变成结构性的，
     * 而不是靠「实际上内核启动要三秒，代理一毫秒就起来了」这种时序巧合。
     */
    await proxy.start();
    const proxyUrl = `http://127.0.0.1:${String(proxy.port)}`;

    /* --- 沙箱后端与路径边界（任务 5.2-5.4、6.3）--------------------- */

    const sandbox = new NativeBackend({
      wslAvailable,
      proxyUrl,
      noProxy: ['localhost', '127.0.0.1', '::1'],
    });

    /**
     * 构造本次调用的路径校验器。
     *
     * 每次重建而不是缓存一份：允许的根随会话工作目录与宿主授权变化，而授权是
     * 用户随时可以新增或撤销的。缓存下来的那份会在撤销之后继续放行——那正是
     * 「随时可撤销」这条承诺失效的地方。构造成本是几次 realpath，与一次文件
     * 读写相比可以忽略。
     */
    const guardFor = (ctx: { workspaceDir: string }): PathGuard => {
      const readWrite: string[] = [ctx.workspaceDir];
      const readOnly: string[] = [];
      for (const grant of grants.listHostGrants({ includeInactive: false })) {
        // project 作用域的授权只在它自己的项目里生效
        if (grant.scope === 'project' && grant.scopeId !== projectId) continue;
        if (grant.mode === 'rw') readWrite.push(grant.hostPath);
        else readOnly.push(grant.hostPath);
      }
      return new PathGuard({
        roots: [...readWrite, ...readOnly],
        readOnlyRoots: readOnly,
        // 平台自己的数据目录不能被执行平面改：制品库与凭据都在里面
        protectedPaths: [store.paths.root],
      });
    };

    const resolveForWrite = (raw: string, ctx: { workspaceDir: string }): string =>
      guardFor(ctx).assert(raw, 'write');

    /** 读取按只读模式校验：只读授权下的目录能读但不能写。 */
    const resolveForRead = (raw: string, ctx: { workspaceDir: string }): string =>
      guardFor(ctx).assert(raw, 'read');

    tools.register(
      createReadFileTool({
        resolvePath: resolveForRead,
        resolveVersion: (versionId) => artifactStore.versionPath(versionId),
      }),
    );
    tools.register(createEditFileTool({ resolvePath: resolveForWrite }));
    tools.register(
      createSaveArtifactsTool({
        store: artifactStore,
        resolvePath: resolveForRead,
        // 制品保存是审查触发点之一（需求 11.3）。带上版本 id，审查才知道该看哪些
        onSaved: ({ ctx, versionIds }) => {
          void reviewer.schedule({
            conversationId: ctx.conversationId,
            trigger: 'artifact-saved',
            versionIds,
          });
        },
      }),
    );
    tools.register(
      createDeleteArtifactsTool({ store: artifactStore, approvals: approvalFor(projectId) }),
    );

    /* --- 内核、shell 与后台任务（任务 6.2、6.3、6.5）---------------- */

    const background = new BackgroundRunner({
      deliver: (notice) => {
        // UI 要立刻看到；模型要在下一回合的历史里看到。两者都需要，缺一个的表现
        // 分别是「跑完了但界面上没动静」和「模型不知道它派出去的任务有结果了」
        d.broadcast({
          kind: 'background.notice',
          projectId,
          conversationId: notice.conversationId,
          taskId: notice.taskId,
          label: notice.label,
          state: notice.state,
          output: notice.output,
          durationMs: notice.durationMs,
        });

        const orchestrator = orchestrators.get(projectId);
        if (orchestrator === undefined) return;
        try {
          orchestrator.deliverNotification(notice.conversationId, {
            // 状态进标签：成功与失败的区别必须出现在模型能看到的那条消息里，
            // 否则它会把一个失败的后台任务当成有结果
            label: `${notice.label}（${notice.state}）`,
            output: notice.output,
            durationMs: notice.durationMs,
          });
        } catch (err) {
          log(`后台结果投递失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    const pool = new KernelPool({
      runtimeDir: joinPath(project.paths.root, 'runtime'),
      workspaceRoot: project.paths.workspace,
      onLog: (line) => {
        log(`[kernel ${projectId}] ${line}`);
      },
      // Windows 上真中断依赖 FFI 创建的可继承 Event 句柄。拿不到时内核层会如实
      // 退化成重启并说明状态已丢失
      interrupterFactory: () => InterruptEvent.create(),
      extraEnv: () => proxy.env(),
    });

    /*
     * 后台任务跑在**独立的一次性内核**上。
     *
     * 不能用会话内核：一个内核不允许并发执行，后台任务占住它之后用户的下一条消息
     * 会撞上「该内核已有执行在途」——那就不叫后台了。代价是后台代码看不到会话里的
     * 变量，这一点写进了工具描述，否则模型会理所当然地以为状态共享。
     *
     * 每个任务一个键并在结束时关掉：固定键会让两个并发后台任务撞在一起，不关掉则
     * 每个后台任务泄漏一个几百 MB 的 Python 进程。
     */
    let backgroundSeq = 0;
    const submitBackground = (
      run: (kernel: JupyterKernel) => AsyncIterable<KernelOutput>,
      meta: { language: KernelLanguage; code: string; conversationId: string; kernelKey: string },
    ): string => {
      backgroundSeq += 1;
      const key = `${meta.kernelKey}#bg${String(backgroundSeq)}`;

      return background.submit({
        conversationId: meta.conversationId,
        label: `${meta.language} 后台任务`,
        run: async (signal) => {
          const onAbort = (): void => {
            void pool.interrupt(key, meta.language).catch(() => undefined);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            const kernel = await pool.acquire(key, meta.language);
            const collected = await collectExecution(run(kernel));
            return formatExecution(collected).output;
          } finally {
            signal.removeEventListener('abort', onAbort);
            await pool.shutdown(key, meta.language).catch(() => undefined);
          }
        },
      });
    };

    tools.register(createKernelTool({ pool, language: 'python', submitBackground }));
    tools.register(createKernelTool({ pool, language: 'r', submitBackground }));
    tools.register(
      createShellTool({
        backend: sandbox,
        resolveCwd: (raw, ctx) =>
          raw === undefined || raw.trim() === '' ? ctx.workspaceDir : resolveForWrite(raw, ctx),
      }),
    );

    /* --- 向用户提问（任务 8.2，需求 17.4）--------------------------- */

    tools.register(createAskUserTool({ questions }));

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

    /*
     * 对话中创建技能（任务 12.15，路径 1）。
     *
     * 过审批。理由与其他工具不同：技能不是一次性动作，它会被注入到此后每一次
     * 相关对话里，因此「以后都按这个做」的决定权不能交给模型。
     */
    tools.register(
      createCreateSkillTool({
        manager: skills,
        userDir: store.paths.skillsUser,
        approvals: approvalFor(projectId),
        onCreated: ({ slug, replaced }) => {
          d.broadcast({ kind: 'skill.changed', slug, action: replaced ? 'updated' : 'created' });
        },
      }),
    );

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
      // 记忆同样注入子 agent：它看不到父会话历史，项目约定只可能从记忆里来
      memory: () => memory.injection(),
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

    /* --- 控制面 REPL 与 host 对象（任务 12.7，需求 10.8）------------ */

    const findingsRepo = new FindingsRepo(project.db);
    findingsRepos.set(projectId, findingsRepo);

    const hostServer = new HostRpcServer({
      onLog: (line) => {
        log(`[host ${projectId}] ${line}`);
      },
    });
    await hostServer.start();

    /*
     * 连接器管理按项目建实例。
     *
     * 注册表本身是全局的（应用库），但审批要落到发起它的项目的审计里，而 McpManager
     * 持有审批服务的引用。共用一个实例会让所有项目的连接器审批记进同一个项目库。
     */
    const mcpManager = new McpManager({
      repo: connectorRepo,
      resolveCredential: (ref) =>
        !vault.available || !vault.exists ? null : (vault.get(ref) ?? null),
      approvals: () => approvalFor(projectId),
      onLog: (line) => {
        log(`[mcp ${projectId}] ${line}`);
      },
    });
    mcpManagers.set(projectId, mcpManager);

    const host = registerHostMethods(hostServer, {
      projectId,
      db: project.db,
      artifacts: artifactStore,
      plans: planRepo,
      findings: findingsRepo,
      skills,
      skillAudit,
      usage: usageRepo,
      registry: modelRegistry,
      subAgents,
      // 需求 14.2：MCP 只从控制面暴露。这里是它唯一的注册点，
      // ToolRegistry 里刻意没有任何 mcp_* 工具
      mcp: mcpManager,
    });

    /*
     * 控制面用**独立的内核池实例**。
     *
     * 同一个池加「按 key 决定是否注入 token」也能做到，但那让特权边界取决于一处
     * 条件判断——漏掉一个分支就等于把控制面 token 注入了普通分析内核，于是模型在
     * 普通 cell 里就能拿到平台的全部管理能力。用池的边界表达这件事，结构上就不可能
     * 漏：这个池里的每个内核都有 token，那个池里的每个都没有。
     */
    const controlPool = new KernelPool({
      runtimeDir: joinPath(project.paths.root, 'runtime-control'),
      workspaceRoot: joinPath(project.paths.workspace, '.control'),
      onLog: (line) => {
        log(`[control-kernel ${projectId}] ${line}`);
      },
      interrupterFactory: () => InterruptEvent.create(),
      // 代理环境变量照样注入：控制面代码也可能联网，网络管控不该因为它是特权面而放松
      extraEnv: () => ({ ...proxy.env(), ...repl.env() }),
      extraInitCode: () => ControlRepl.initCode(),
    });

    const repl = new ControlRepl({
      pool: controlPool,
      server: hostServer,
      surfaces: host.surfaces,
      pending: host.pending,
      shimDir: joinPath(project.paths.root, 'runtime-control', 'shim'),
      onLog: log,
    });

    const replToolOptions = { repl, surfaces: host.surfaces, pending: host.pending };
    tools.register(createControlReplTool(replToolOptions));
    tools.register(createControlReplAdminTool(replToolOptions));

    /* --- Reviewer Service（任务 12.8，需求 11.1-11.8）--------------- */

    const reviewer = new ReviewerService({
      findings: findingsRepo,
      artifacts: artifactStore,
      messages: project.messages,
      adapters,
      adapterContext: adapterContextFor,
      routerView: routerViewNow,
      experience: () => routingRepo.experience(),
      usage: usageRepo,
      onFinding: (finding) => {
        d.broadcast({ kind: 'finding.raised', projectId, finding });
      },
      onRunFinished: ({ conversationId, runId, status, summary }) => {
        d.broadcast({
          kind: 'reviewer.finished',
          projectId,
          conversationId,
          runId,
          status,
          summary,
        });
        if (status === 'degraded') log(`审查降级（${conversationId}）：${summary}`);
      },
      /*
       * FAIL 打断主 agent（需求 11.5）。
       *
       * 「打断」在这里有两种落点，取决于会话此刻的状态：
       *
       * - 回合还在跑：中断它。继续跑下去的每一步都建立在一个已经站不住的结论上，
       *   越往后走要推翻的东西越多。
       * - 会话空闲：把发现写成一条系统消息，下一回合的历史里就带着它。
       *
       * 两种情况都要落一条消息——只中断不解释的话，用户看到的是「它自己停了」。
       * WARN 不走这条路径，它只出现在 findings 列表与 check_findings 的输出里。
       */
      onFail: async ({ conversationId, findings }) => {
        const lines = findings.map(
          (f) => `- [${f.category}] ${f.title}\n  ${(f.detail ?? '').split('\n')[0] ?? ''}`,
        );
        const orchestrator = orchestrators.get(projectId);
        const wasActive = orchestrator?.isActive(conversationId) ?? false;

        try {
          project.messages.append({
            conversationId,
            role: 'system',
            content: {
              kind: 'reviewer-block',
              text: [
                `独立审查提出了 ${String(findings.length)} 条阻断级发现：`,
                ...lines,
                '',
                wasActive
                  ? '当前回合已被中断：继续往下做只会让需要推翻的东西更多。'
                  : '这些发现会阻止「任务已完成」的结论。',
                '处理完请用 mark_finding_addressed 说明改了什么，由下一轮审查复核。',
              ].join('\n'),
            },
          });
        } catch (err) {
          log(`审查阻断消息落库失败：${err instanceof Error ? err.message : String(err)}`);
        }

        if (wasActive && orchestrator !== undefined) {
          await orchestrator.interrupt(conversationId).catch(() => undefined);
        }
      },
      onLog: (line) => {
        log(`[reviewer ${projectId}] ${line}`);
      },
    });
    reviewers.set(projectId, reviewer);

    const findingToolOptions = {
      repo: () => findingsRepo,
      schedule: (input: { conversationId: string; trigger: ReviewerTrigger }) => {
        void reviewer.schedule(input);
      },
    };
    tools.register(createCheckFindingsTool(findingToolOptions));
    tools.register(createMarkFindingAddressedTool(findingToolOptions));
    tools.register(createRequestReviewTool(findingToolOptions));

    /* --- 记忆（任务 12.9，需求 16.1-16.4）------------------------------ */

    /*
     * 全局与算力作用域在应用库，项目作用域在项目库。
     *
     * 前者与项目无关，放进项目库会让每个项目各存一份，改一处不影响其他项目；
     * 后者跟着项目一起删，不会留下指向已不存在项目的孤儿记忆。
     */
    const memory = new MemoryService({
      repo: new MemoryRepo({ appDb: store.db, projectDb: project.db, projectId }),
      // 算力目标要到 M5 才有登记入口，此刻任何 id 都不存在——如实拒绝而不是放行，
      // 否则会写出一批指向不存在目标的笔记
      computeTargetExists: (targetId) =>
        (store.db
          .prepare('SELECT 1 FROM compute_targets WHERE id = ?')
          .get(targetId) as unknown) !== undefined,
      onLog: (line) => {
        log(`[memory ${projectId}] ${line}`);
      },
    });
    memories.set(projectId, memory);

    const memoryToolOptions = { service: () => memory };
    tools.register(createRememberTool(memoryToolOptions));
    tools.register(createRecallMemoryTool(memoryToolOptions));

    /* --- 文献库（任务 13.1，需求 12.1、12.2）--------------------------- */

    /*
     * 文献库在项目库里：一份参考文献列表属于一篇论文，不该跨项目共享。
     *
     * `mailto` 从环境变量取。Crossref 与 NCBI 的礼节说明都要求标明联系方式，
     * 带上它的请求会被路由到限流更宽松的池子——这不是合规问题而是能不能用的问题。
     * 没配置时不编一个假地址：假地址比没有更糟，它会让上游把这个 UA 整体拉黑。
     */
    const refLibrary = new RefLibrary({
      repo: new RefsRepo(project.db),
      artifacts: artifactStore,
      /*
       * 域名批准门。
       *
       * 出口代理只管执行平面（内核经 HTTP_PROXY 出网），后端进程自己的 fetch
       * 完全不经过它。因此文献库要自己过一遍同一份白名单，否则会出现「授权列表里
       * 没有 api.crossref.org，但模型一调文献工具就连上了」——那正是这套两级
       * 管控要防的半开状态。
       *
       * 六家上游合成一张卡片：边发边问会在一次 DOI 解析里弹三张，用户看不出
       * 自己在批准什么。已被连接器带进白名单的域名不再询问。
       */
      authorizeHosts: async (hosts) => {
        const allowed = hosts.filter((h) => grants.isDomainAllowed({ domain: h, projectId }));
        const missing = hosts.filter((h) => !allowed.includes(h));
        if (missing.length === 0) return allowed;

        const result = await approvalFor(projectId).request({
          kind: 'domain-allowlist',
          title: `允许文献库访问 ${String(missing.length)} 个学术元数据服务？`,
          detail:
            '文献库要解析 DOI 与检索文献，需要访问以下服务：\n' +
            missing.map((h) => `· ${h}`).join('\n') +
            '\n\n发出去的内容是 DOI、PMID 或标题检索词。这些服务不接收工作区里的数据。',
          impact:
            '批准后文献库可以查询这些服务。它们返回的元数据（标题、作者、摘要）会存进项目库。',
          reversible: true,
          undoHint: '在设置的授权列表里撤销这些域名。',
          scopeOptions: ['once', 'project', 'always'],
          payload: { hosts: missing },
        });

        if (result.state !== 'approved') return allowed;

        if (result.scope !== 'once') {
          for (const host of missing) {
            try {
              grants.allowDomain({
                domain: host,
                mode: 'rw',
                scope: result.scope,
                scopeId: result.scope === 'project' ? projectId : null,
                reason: `用户为文献库在项目 ${projectId} 内批准`,
              });
            } catch (err) {
              log(`文献库域名授权写入失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        return [...allowed, ...missing];
      },
      http: {
        ...(process.env.LSCIENCE_CONTACT_EMAIL === undefined
          ? {}
          : { mailto: process.env.LSCIENCE_CONTACT_EMAIL }),
        ...(process.env.NCBI_API_KEY === undefined ? {} : { ncbiApiKey: process.env.NCBI_API_KEY }),
      },
      onLog: (line) => {
        log(`[refs ${projectId}] ${line}`);
      },
    });
    refLibraries.set(projectId, refLibrary);

    tools.register(
      createManageReferencesTool({
        library: () => refLibrary,
        onChanged: (info) => {
          d.broadcast({
            kind: 'refs.changed',
            projectId,
            action: info.action,
            refIds: info.refIds,
          });
        },
      }),
    );

    computePlanes.set(projectId, {
      pool,
      controlPool,
      repl,
      hostServer,
      proxy,
      background,
      sandbox,
    });

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
      /*
       * 系统提示词。
       *
       * 每次回合重新生成而不是构造时算一次：工具集会随环境变化（装了 R 之后 `r`
       * 工具才注册），记忆更是随时在变。缓存一份的后果是用户刚让 agent 记下一条
       * 约定，下一个回合它并不知道——而那正是记忆最该起作用的时刻。
       */
      systemPrompt: () =>
        buildSystemPrompt({
          // 项目名在应用库里，每次现读：用户改了项目名之后提示词里该跟着变
          ...(() => {
            const name = store.projects.get(projectId)?.name;
            return name === undefined ? {} : { projectName: name };
          })(),
          toolNames: tools.toolSchemas().map((s) => s.name),
          memory: memory.injection(),
          isolation: { backend: sandbox.id, network: sandbox.isolation.network },
          pythonEnv: capabilities.pythonEnv,
          rEnv: capabilities.rEnv,
        }),
      /*
       * 用户在输入框里用 `/` 显式插入的技能（任务 12.16，需求 9.5、9.8）。
       *
       * 找不到的 slug 要如实回报而不是过滤掉：用户点了一个技能，界面上它就在那儿，
       * 如果后端静默忽略，他会以为方法已经生效并据此判断结果。
       */
      explicitSkills: ({ conversationId, slugs }) => {
        const injections: Array<{ slug: string; name: string; content: string }> = [];
        const missing: string[] = [];
        for (const slug of slugs) {
          const injection = skills.inject(slug);
          if (injection === null) {
            missing.push(slug);
            continue;
          }
          injections.push({
            slug: injection.slug,
            name: injection.name,
            content: injection.content,
          });
          // 留痕（需求 9.8）：半年后回看结论时「当时按的是哪套方法」必须答得出来
          auditSkillLoad({
            conversationId,
            slug,
            reason: 'explicit',
            detail: '用户在输入框里显式插入',
            injectedChars: injection.content.length,
          });
        }
        return { injections, missing };
      },
      /*
       * 回合结束触发审查（需求 11.3）。
       *
       * 不 await：审查要跑一次模型调用，在这里等它等于让用户多等几十秒才看到
       * 回合结束。中断收场的回合也审查——中断之前产出的分析结果照样需要被看，
       * 用户中断的是等待而不是已经算出来的东西。
       */
      onTurnEnd: ({ conversationId }) => {
        void reviewer.schedule({ conversationId, trigger: 'turn-end' });
      },
    });

    orchestrators.set(projectId, orchestrator);
    toolRegistries.set(projectId, tools);
    return orchestrator;
  };

  /**
   * 取得（必要时构建）项目的编排器与整套执行平面。
   *
   * 构建是异步的（出口代理与控制面 RPC 都要先监听起来），因此缓存的必须是
   * **Promise** 而不是结果：缓存结果的话两个并发请求会各自走一遍构建，同一个项目
   * 就多出一整套内核池、代理与控制面服务，而先建好的那套被覆盖后再没人关得掉。
   */
  const building = new Map<string, Promise<Orchestrator>>();

  const orchestratorFor = async (projectId: string): Promise<Orchestrator> => {
    const existing = orchestrators.get(projectId);
    if (existing !== undefined) return existing;

    const inFlight = building.get(projectId);
    if (inFlight !== undefined) return inFlight;

    const promise = buildOrchestrator(projectId).finally(() => {
      building.delete(projectId);
    });
    building.set(projectId, promise);
    return promise;
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

    const orchestrator = await orchestratorFor(projectId);

    let events: AsyncIterable<TurnEvent>;
    try {
      events = orchestrator.startTurn(req.conversationId, req.text, req.routing ?? {}, req.skills);
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

  /*
   * 隔离报告必须描述**执行平面实际用的那个后端**。
   *
   * 早先这里调 `selectBackend()` 现场选一个，于是在装了 WSL2 的机器上返回 wsl2 的
   * 报告（命名空间级文件系统与网络边界），而内核实际上跑在 Windows 的 conda 环境里、
   * 只有工具层的路径校验和代理级出口管控。徽章因此比现实强两档——正好是「诚实降级」
   * 这条设计目标要防的事。
   *
   * 报告由 `nativeIsolationReport` 统一产出，与 NativeBackend 构造时用的是同一个
   * 函数，两处不可能分歧。
   */
  d.register('sandbox.isolation', async () => {
    const isolation = nativeIsolationReport({ proxyEnabled: true });
    return {
      backend: 'native' as const,
      isolation,
      strength: isolationStrength(isolation),
      skipped: wslAvailable
        ? [
            {
              id: 'wsl2' as const,
              reason:
                '已安装 WSL2 发行版，但执行平面（内核与工作目录）仍在 Windows 上运行，' +
                '因此不能声称拥有它的命名空间边界。把内核搬进 WSL2 是一项独立工作。' +
                'bash 工具仍可显式选择在 WSL2 里执行命令。',
            },
          ]
        : [
            {
              id: 'wsl2' as const,
              reason:
                'WSL2 无已安装发行版。执行 wsl --install -d Ubuntu（需管理员 + 重启）' +
                '后可获得内核级文件系统与网络边界。',
            },
          ],
    };
  });

  d.register('tool.list', async (req) => {
    // 复用编排器持有的注册表，避免两处注册出现分歧
    await orchestratorFor(req.projectId);
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
  const usageFor = async (projectId: string): Promise<UsageRepo> => {
    await orchestratorFor(projectId);
    const repo = usageRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  const routingFor = async (projectId: string): Promise<RoutingRepo> => {
    await orchestratorFor(projectId);
    const repo = routingRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  d.register('usage.summary', async (req) => {
    const usage = await usageFor(req.projectId);
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
    const usage = await usageFor(req.projectId);
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
    decisions: (await routingFor(req.projectId)).byConversation(req.conversationId, req.limit),
  }));

  d.register('routing.feedback', async (req) => {
    (await routingFor(req.projectId)).addSignal(req.routingDecisionId, req.signal, req.source);
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
      req.projectId === undefined ? undefined : (await routingFor(req.projectId)).experience();

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
    await orchestratorFor(req.projectId);
    const audit = skillAudits.get(req.projectId);
    if (audit === undefined) throw notFound(`项目不可用：${req.projectId}`);

    return {
      events: audit.byConversation(req.conversationId, req.limit),
      summary: audit.summary(),
    };
  });

  /* --- 技能创建与导入（任务 12.15，需求 9.6）--- */

  /** 写入或导入之后统一做的三件事：重扫、通知界面、返回结果摘要。 */
  const afterSkillChange = (slug: string, action: 'created' | 'updated' | 'deleted'): void => {
    skills.reload();
    d.broadcast({ kind: 'skill.changed', slug, action });
    /*
     * 向量层在后台补。
     *
     * 不 await 是刻意的：它要向本机推理服务发一次请求，可能触发模型加载。让保存
     * 一个技能卡住几秒，用户会以为保存失败又点一次。词法检索在这之前已经能命中它。
     */
    void skills.buildVectors().catch(() => undefined);
  };

  /** 内置技能的 slug 集合，用于提示「这次写入会遮蔽某个内置技能」。 */
  const builtinSlugsNow = (): ReadonlySet<string> =>
    new Set(
      skills
        .records()
        .filter((r) => r.scope === 'builtin')
        .map((r) => r.slug),
    );

  d.register('skill.source', async (req) => {
    const loaded = skills.get(req.slug);
    if (loaded === null) throw notFound(`技能不存在或未加载：${req.slug}`);

    const manifestPath = joinPath(loaded.path, 'skill.json');
    const skillMdPath = joinPath(loaded.path, 'SKILL.md');

    return {
      slug: req.slug,
      scope: loaded.scope,
      path: loaded.path,
      /** 原始文本而不是解析后的对象：编辑器编辑的就是文本。 */
      manifest: readFileSync(manifestPath, 'utf8'),
      skillMd: readFileSync(skillMdPath, 'utf8'),
      /*
       * 参考材料只给清单不给内容：一个技能可能带几百 KB 的参数表，打开设置页
       * 就全传一遍是浪费，而编辑器是按文件打开的。内容用 skill.reference 取。
       */
      references: loaded.references,
      scripts: loaded.scripts,
      provider: loaded.provider,
      hasProviderScript: loaded.providerScript !== null,
      warnings: loaded.warnings,
      origin: readSkillOrigin(loaded.path),
      /** 内置技能不能原地改：改动会在下次启动被同步覆盖。界面据此提示「另存为用户技能」。 */
      editable: loaded.scope === 'user',
    };
  });

  d.register('skill.reference', async (req) => {
    const result = skills.readReference(req.slug, req.name);
    if (!result.ok) throw notFound(result.reason);
    return { slug: req.slug, name: req.name, content: result.content };
  });

  d.register('skill.validate', async (req) => {
    const result = validateSkillFiles({
      'skill.json': req.manifest,
      'SKILL.md': req.instructions === '' ? '（正文待写）' : req.instructions,
    });
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: [...result.warnings, ...auditSkillContent(req.instructions)],
      slug: result.manifest?.slug ?? null,
      /** 已存在同名技能时界面要先问「是否覆盖」而不是直接保存。 */
      conflictsWith:
        result.manifest === null
          ? null
          : (skills.records().find((r) => r.slug === result.manifest?.slug) ?? null),
    };
  });

  d.register('skill.write', async (req) => {
    const files: Record<string, string> = {
      'skill.json': req.manifest,
      'SKILL.md': req.instructions,
    };
    for (const [name, content] of Object.entries(req.references)) {
      files[`references/${name}`] = content;
    }
    if (req.providerJson !== null) files['provider.json'] = req.providerJson;
    if (req.providerScript !== null) files['provider.py'] = req.providerScript;

    const result = writeUserSkill({
      userDir: store.paths.skillsUser,
      files,
      origin: { kind: 'authored', source: null, detail: '在设置页里编写' },
      overwrite: req.overwrite,
      builtinSlugs: builtinSlugsNow(),
    });

    if (result.ok && result.slug !== null) {
      afterSkillChange(result.slug, result.replaced ? 'updated' : 'created');
    }
    return result;
  });

  d.register('skill.delete', async (req) => {
    const record = skills.records().find((r) => r.slug === req.slug);
    if (record === undefined) throw notFound(`技能不在注册表中：${req.slug}`);
    if (record.scope !== 'user') {
      // 内置技能删掉下次启动会被同步回来，只会让状态看起来不一致
      throw new DispatchError(
        makeError('bad_request', `${req.slug} 是内置技能，不能删除。`, {
          remediation: '内置技能由平台维护，删掉会在下次启动时被同步回来。要停用它请改用禁用。',
        }),
      );
    }

    const result = removeUserSkill(store.paths.skillsUser, req.slug);
    if (!result.ok) throw notFound(result.reason ?? '删除失败');
    afterSkillChange(req.slug, 'deleted');
    return { slug: req.slug, deleted: true };
  });

  d.register('skill.importArchive', async (req) => {
    let data: Buffer;
    try {
      data = Buffer.from(req.contentBase64, 'base64');
    } catch {
      throw new DispatchError(makeError('bad_request', '内容不是合法的 base64'));
    }
    if (data.byteLength === 0) {
      throw new DispatchError(makeError('bad_request', '内容为空——base64 解码后没有字节'));
    }

    const outcome = importSkillsFromArchive({
      userDir: store.paths.skillsUser,
      data,
      fileName: req.fileName,
      overwrite: req.overwrite,
      builtinSlugs: builtinSlugsNow(),
    });

    for (const skill of outcome.skills) {
      if (skill.ok && skill.slug !== null) {
        afterSkillChange(skill.slug, skill.replaced ? 'updated' : 'created');
      }
    }
    return outcome;
  });

  d.register('skill.importDirectory', async (req) => {
    const outcome = importSkillsFromDirectory({
      userDir: store.paths.skillsUser,
      sourceDir: req.directory,
      overwrite: req.overwrite,
      builtinSlugs: builtinSlugsNow(),
    });

    for (const skill of outcome.skills) {
      if (skill.ok && skill.slug !== null) {
        afterSkillChange(skill.slug, skill.replaced ? 'updated' : 'created');
      }
    }
    return outcome;
  });

  d.register('skill.importGithub', async (req) => {
    /*
     * 令牌从凭据库取，用完即弃。
     *
     * 请求载荷里传的是引用名——密钥不进请求体是本文件（ipc.ts）里写明的不变量，
     * 有测试守着。
     */
    let token: string | null = null;
    if (req.credentialRef !== null && req.credentialRef !== '') {
      if (!vault.available || !vault.exists) {
        throw new DispatchError(
          makeError('bad_request', '这台机器上凭据库不可用，无法取出令牌。', {
            remediation: '公开仓库可以不填令牌直接导入。',
          }),
        );
      }
      token = vault.get(req.credentialRef);
      if (token === null) {
        throw notFound(`凭据不存在：${req.credentialRef}`, '先在设置里保存 GitHub 访问令牌。');
      }
    }

    const outcome = await importSkillsFromGitHub({
      userDir: store.paths.skillsUser,
      spec: req.spec,
      token,
      /*
       * 这条 IPC 只能由界面发起（模型没有 IPC 通道），因此**用户点下导入本身就是授权**，
       * 再弹一张审批卡片等于让他确认自己刚点的事。
       *
       * 它也刻意不往域名白名单里加 `api.github.com`：那份白名单管的是执行平面
       * （内核里的代码），因为用户导入过一个技能就给内核开通 GitHub 访问，
       * 是把两件不同的事混在一起。`authorizeHost` 这个钩子保留着，是为了将来若出现
       * agent 发起的导入路径，它必须显式给出一套策略而不是默认放行。
       */
      authorizeHost: async () => true,
      overwrite: req.overwrite,
      builtinSlugs: builtinSlugsNow(),
    });

    for (const skill of outcome.skills) {
      if (skill.ok && skill.slug !== null) {
        afterSkillChange(skill.slug, skill.replaced ? 'updated' : 'created');
      }
    }
    return outcome;
  });

  d.register('skill.distill', async (req) => {
    // 用量仓储随编排器懒加载；蒸馏要把这次调用记进成本
    await orchestratorFor(req.projectId);
    const project = openProject(store, req.projectId);
    const usageRepo = usageRepos.get(req.projectId);
    const routingRepo = routingRepos.get(req.projectId);
    const registry = toolRegistries.get(req.projectId);

    const result = await distillSkill(
      {
        messages: project.messages,
        toolCalls: project.toolCalls,
        adapters,
        adapterContext: adapterContextFor,
        routerView: routerViewNow,
        ...(routingRepo === undefined ? {} : { experience: () => routingRepo.experience() }),
        ...(usageRepo === undefined ? {} : { usage: usageRepo }),
        existingSlugs: () => skills.records().map((r) => r.slug),
        // 用编排器实际持有的注册表：另建一个会让技能声明的工具与真实可用的分歧
        availableTools: () =>
          registry === undefined ? [] : registry.toolSchemas().map((s) => s.name),
      },
      {
        conversationId: req.conversationId,
        focus: req.focus,
        modelId: req.modelId,
      },
    );

    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        insufficient: result.insufficient ?? false,
      };
    }

    /*
     * 只返回草稿。
     *
     * 蒸馏的输入是一次具体分析，它天然倾向于把一次性细节写成通用规则
     * （某台机器的路径、某次运行的数值）。那类错误的表现是「照着技能做但结果对不上」，
     * 比报错难查得多，因此必须让用户看过 contentWarnings 再决定存不存。
     * 确认后由界面调 skill.write 落盘。
     */
    return {
      ok: true,
      modelId: result.modelId,
      context: result.context,
      slug: result.draft.slug,
      manifest: String(result.draft.files['skill.json'] ?? ''),
      instructions: String(result.draft.files['SKILL.md'] ?? ''),
      contentWarnings: result.draft.contentWarnings,
      manifestWarnings: result.draft.manifestWarnings,
      conflictsWith: skills.records().find((r) => r.slug === result.draft.slug) ?? null,
    };
  });

  /* --- 计划（任务 12.5）--- */

  const planFor = async (projectId: string): Promise<PlanRepo> => {
    await orchestratorFor(projectId);
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
    const repo = await planFor(req.projectId);
    return {
      plans: repo.byConversation(req.conversationId, req.limit).map((plan) => planView(repo, plan)),
    };
  });

  d.register('plan.get', async (req) => {
    const repo = await planFor(req.projectId);
    const plan = repo.get(req.planId);
    if (plan === null) throw notFound(`计划不存在：${req.planId}`);
    return { plan: planView(repo, plan) };
  });

  d.register('plan.decide', async (req) => {
    const repo = await planFor(req.projectId);
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
    const repo = await planFor(req.projectId);
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

  /* --- 审查与 findings（任务 12.8，需求 11）--- */

  const findingsFor = async (projectId: string): Promise<FindingsRepo> => {
    await orchestratorFor(projectId);
    const repo = findingsRepos.get(projectId);
    if (repo === undefined) throw notFound(`项目不可用：${projectId}`);
    return repo;
  };

  d.register('finding.list', async (req) => {
    const repo = await findingsFor(req.projectId);
    return {
      findings: repo.list({
        conversationId: req.conversationId,
        ...(req.status === undefined ? {} : { status: req.status as FindingStatus | 'unresolved' }),
        limit: req.limit,
      }),
      summary: repo.summary(req.conversationId),
    };
  });

  d.register('finding.decide', async (req) => {
    const repo = await findingsFor(req.projectId);
    const finding = repo.get(req.findingId);
    if (finding === null) throw notFound(`发现不存在：${req.findingId}`);

    const note = req.note ?? '';
    const applied =
      req.decision === 'resolve'
        ? repo.resolve(req.findingId, note === '' ? undefined : note)
        : req.decision === 'dismiss'
          ? repo.dismiss(req.findingId, note === '' ? '用户判为误报' : note)
          : repo.reopen(req.findingId, note === '' ? '用户重新打开' : note);

    if (!applied) {
      // 明确报冲突而不是静默成功：当前状态不允许这个动作时，用户需要知道
      throw new DispatchError(
        makeError('conflict', `发现当前状态是 ${finding.status}，不能执行 ${req.decision}`, {
          remediation:
            req.decision === 'reopen'
              ? 'reopen 只对「已自报待复核」的发现有效。'
              : '它可能已经关闭或已被判为误报。',
        }),
      );
    }

    return { finding: repo.get(req.findingId) };
  });

  d.register('reviewer.run', async (req) => {
    await orchestratorFor(req.projectId);
    const reviewer = reviewers.get(req.projectId);
    if (reviewer === undefined) throw notFound(`项目不可用：${req.projectId}`);

    /*
     * 不 await 审查完成。
     *
     * 它要跑一次模型调用，几十秒到几分钟。挂在这个请求上会撞上 IPC 的超时，
     * 而超时的表现是「点了审查按钮转半天然后报错」——审查其实跑完了。
     * 结果经 reviewer.finished 事件与 finding.raised 通知 UI。
     */
    void reviewer.schedule({ conversationId: req.conversationId, trigger: 'user-request' });
    return { scheduled: true, merged: reviewer.busy };
  });

  d.register('reviewer.runs', async (req) => {
    const repo = await findingsFor(req.projectId);
    return { runs: repo.runs(req.conversationId, req.limit) };
  });

  /* --- 记忆（任务 12.9，需求 16.3）--- */

  const memoryFor = async (projectId: string): Promise<MemoryService> => {
    await orchestratorFor(projectId);
    const service = memories.get(projectId);
    if (service === undefined) throw notFound(`项目不可用：${projectId}`);
    return service;
  };

  d.register('memory.list', async (req) => {
    const service = await memoryFor(req.projectId);
    const notes = service.list({
      ...(req.scope === undefined ? {} : { scope: req.scope as MemoryScope }),
      ...(req.scopeId === undefined ? {} : { scopeId: req.scopeId }),
      ...(req.kind === undefined ? {} : { kind: req.kind as MemoryKind }),
    });
    return {
      notes,
      limits: MEMORY_LIMITS,
      counts: {
        global: service.repo.count('global'),
        project: service.repo.count('project'),
      },
    };
  });

  d.register('memory.upsert', async (req) => {
    const service = await memoryFor(req.projectId);
    const result = service.remember({
      scope: req.scope as MemoryScope,
      ...(req.scopeId === undefined ? {} : { scopeId: req.scopeId }),
      kind: req.kind as MemoryKind,
      content: req.content,
      reason: req.reason,
      ...(req.replaceId === undefined ? {} : { replaceId: req.replaceId }),
    });

    if (!result.ok) {
      /*
       * 用户手工写入也要过准入判定。
       *
       * 「这次的 p 值是 0.03」由用户写下来造成的膨胀与模型写的一样，而准入的理由
       * 与是谁写的无关。用 bad_request 而不是静默接受：静默接受等于把需求 16.4
       * 变成一句空话。
       */
      throw new DispatchError(
        makeError('bad_request', '这条内容不适合写进长期记忆', {
          detail: result.reason,
          ...(result.rule === null ? {} : { remediation: `命中规则：${result.rule}` }),
        }),
      );
    }

    return { note: result.note, created: result.created, deduped: result.deduped };
  });

  d.register('memory.delete', async (req) => {
    const service = await memoryFor(req.projectId);
    if (!service.delete(req.memoryId)) {
      throw notFound(`记忆不存在：${req.memoryId}`);
    }
    return { deleted: true };
  });

  /* --- 连接器（任务 12.13、12.14，需求 14.1、14.2）--- */

  /**
   * 取连接器管理实例。
   *
   * 没有项目上下文时（设置页可以在不打开项目的情况下看目录）返回 null，此时只能做
   * 不需要审批的操作——列目录、开关。真正的调用与握手需要项目，因为审批要落到项目审计里。
   */
  const mcpFor = async (projectId: string): Promise<McpManager> => {
    await orchestratorFor(projectId);
    const manager = mcpManagers.get(projectId);
    if (manager === undefined) throw notFound(`项目不可用：${projectId}`);
    return manager;
  };

  d.register('connector.list', async (req) => {
    // 有项目上下文时带上运行时状态（是否已连接、工具数）；没有就只给注册表内容
    const status = req.projectId === undefined ? null : (await mcpFor(req.projectId)).status();
    const byId = new Map((status ?? []).map((s) => [s.id, s]));

    return {
      groups: connectorRepo.listGroups(),
      connectors: connectorRepo.list({ includeDisabled: true }).map((c) => {
        const group = c.groupId === null ? null : connectorRepo.getGroup(c.groupId);
        const live = byId.get(c.id);
        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          groupId: c.groupId,
          builtin: c.builtin,
          // 两级开关都算进来：UI 上显示的「已启用」要与实际可用一致
          enabled: c.enabled && (group === null || group.enabled),
          selfEnabled: c.enabled,
          groupEnabled: group === null ? true : group.enabled,
          credentialRef: c.credentialRef,
          domains: c.domains,
          health: c.health,
          lastError: c.lastError,
          connected: live?.connected ?? false,
          toolCount: live?.toolCount ?? 0,
          serverInfo: live?.serverInfo ?? null,
          sources: Array.isArray(c.config.sources) ? (c.config.sources as string[]) : [],
          description: typeof c.config.description === 'string' ? c.config.description : null,
        };
      }),
      /*
       * 当前因连接器而进入出口白名单的域名（任务 12.16）。
       *
       * 单独给出来，是为了让「关掉一组之后网络是不是真的断了」可以被看见。
       * 界面上关了而内核里的代码照样能连，是这套两级开关最容易出现的半开状态，
       * 而它在没有这份清单时完全不可观测。
       */
      effectiveDomains: connectorRepo.effectiveDomains(),
    };
  });

  d.register('connector.setEnabled', async (req) => {
    if (req.groupId !== undefined) {
      if (!connectorRepo.setGroupEnabled(req.groupId, req.enabled)) {
        throw notFound(`连接器组不存在：${req.groupId}`);
      }
    } else if (req.connectorId !== undefined) {
      if (!connectorRepo.setEnabled(req.connectorId, req.enabled)) {
        throw notFound(`连接器不存在：${req.connectorId}`);
      }
    } else {
      throw new DispatchError(makeError('bad_request', '必须指定 connectorId 或 groupId'));
    }

    /*
     * 关掉之后必须做三件事，少一件就会留下半开状态：
     * 1. 断开已建立的连接——只改数据库标记的话缓存的客户端还在，模型仍然能调用
     * 2. 撤销工具授权——否则重新启用时它会带着旧授权直接放行
     * 3. 撤回域名白名单——否则用户以为断网了而内核里的代码照样能连
     */
    if (!req.enabled) {
      const affected =
        req.groupId === undefined
          ? req.connectorId === undefined
            ? []
            : [req.connectorId]
          : connectorRepo.list({ groupId: req.groupId, includeDisabled: true }).map((c) => c.id);

      for (const manager of mcpManagers.values()) {
        for (const id of affected) await manager.disconnect(id);
      }
      for (const id of affected) connectorRepo.revokeAllForConnector(id);
    }

    syncConnectorDomains();

    return {
      groups: connectorRepo.listGroups(),
      effective: connectorRepo.listEffective().length,
    };
  });

  d.register('connector.check', async (req) => {
    const manager = await mcpFor(req.projectId);
    return manager.check(req.connectorId);
  });

  d.register('connector.tools', async (req) => {
    const manager = await mcpFor(req.projectId);
    const client = await manager.client(req.connectorId).catch((err: unknown) => {
      throw new DispatchError(
        makeError(
          'unavailable',
          `连接器不可用：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
    return {
      tools: client.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        readOnly: t.annotations?.readOnlyHint === true,
        destructive: t.annotations?.destructiveHint === true,
      })),
      resources: client.resources.length,
      prompts: client.prompts.length,
    };
  });

  d.register('connector.upsert', async (req) => {
    const existing = connectorRepo.get(req.connectorId);
    if (existing !== null && existing.builtin) {
      throw new DispatchError(
        makeError('conflict', '不能覆盖内置连接器', {
          remediation: '内置连接器只能禁用。要自定义请用另一个 id 新建。',
        }),
      );
    }

    const record = connectorRepo.upsert({
      id: req.connectorId,
      kind: req.kind,
      name: req.name,
      builtin: false,
      config: req.config,
      ...(req.credentialRef === undefined ? {} : { credentialRef: req.credentialRef }),
      ...(req.domains === undefined ? {} : { domains: req.domains }),
    });

    // 改了配置就断开重连，否则还在用旧配置的连接
    for (const manager of mcpManagers.values()) await manager.disconnect(req.connectorId);
    syncConnectorDomains();

    return { connector: { id: record.id, name: record.name, kind: record.kind } };
  });

  d.register('connector.delete', async (req) => {
    const result = connectorRepo.delete(req.connectorId);
    if (!result.deleted) {
      throw new DispatchError(makeError('conflict', result.reason ?? '删除失败'));
    }
    for (const manager of mcpManagers.values()) await manager.disconnect(req.connectorId);
    syncConnectorDomains();
    return { deleted: true };
  });

  d.register('connector.grants', async (req) => ({
    grants: connectorRepo.listToolGrants({ includeRevoked: req.includeRevoked }),
  }));

  d.register('connector.revokeGrant', async (req) => {
    if (!connectorRepo.revokeToolGrant(req.grantId)) {
      throw notFound(`工具授权不存在或已撤销：${req.grantId}`);
    }
    return { revoked: true };
  });

  /* --- 文献库（任务 13.1，需求 12.1、12.2）--- */

  /**
   * 取文献库实例。
   *
   * 经 `orchestratorFor` 而不是现建一个：批准门要接到该项目的审批服务与域名授权上，
   * 现建的实例没有这些依赖，于是「界面上加文献不用批准、模型加文献要批准」——
   * 同一个动作两套规则。
   */
  const refsFor = async (projectId: string): Promise<RefLibrary> => {
    await orchestratorFor(projectId);
    const library = refLibraries.get(projectId);
    if (library === undefined) throw notFound(`项目不可用：${projectId}`);
    return library;
  };

  d.register('ref.list', async (req) => {
    const library = await refsFor(req.projectId);
    const refs = library.repo.list({
      ...(req.query === undefined ? {} : { query: req.query }),
      ...(req.year === undefined ? {} : { year: req.year }),
      ...(req.type === undefined ? {} : { type: req.type }),
      ...(req.hasFulltext === undefined ? {} : { hasFulltext: req.hasFulltext }),
      limit: req.limit,
      offset: req.offset,
    });

    return {
      refs: refs.map((r) => ({
        id: r.id,
        doi: r.doi,
        type: r.type,
        cite: citeLine(r.csl),
        title: r.csl.title ?? null,
        year: r.year,
        container: r.container,
        firstAuthor: r.firstAuthor,
        source: r.source,
        oaStatus: r.oaStatus,
        fulltextArtifactId: r.fulltextArtifactId,
        // 撤稿标记单独提出来：它埋在 csl.extra 里，UI 不该去猜结构
        retracted: r.csl.extra?.retracted === true,
        addedAt: r.addedAt,
      })),
      stats: library.repo.stats(),
    };
  });

  d.register('ref.get', async (req) => {
    const library = await refsFor(req.projectId);
    const ref = library.repo.get(req.refId);
    if (ref === null) throw notFound(`文献不存在：${req.refId}`);
    return {
      ref: { ...ref, cite: citeLine(ref.csl) },
      // BibTeX 顺手生成并缓存：文献详情页一定会显示它
      bibtex: library.bibtexFor(req.refId),
    };
  });

  d.register('ref.resolve', async (req) => {
    const library = await refsFor(req.projectId);
    const result = await library.addMany(req.identifiers, { refresh: req.refresh });

    return {
      created: result.created,
      duplicates: result.duplicates,
      failed: result.failed,
      outcomes: result.outcomes.map((o) => ({
        input: o.input,
        ok: o.ok,
        refId: o.ref?.id ?? null,
        cite: o.ref === null ? null : citeLine(o.ref.csl),
        created: o.created,
        enriched: o.enriched,
        reason: o.reason,
        suspects: o.suspects,
        // 逐源结果原样给出：失败时用户要能区分「这条不存在」与「网络不通」
        attempts: o.attempts.map((a) => ({
          source: a.source,
          ok: a.ok,
          reason: a.reason,
        })),
      })),
    };
  });

  d.register('ref.search', async (req) => {
    const library = await refsFor(req.projectId);
    const result = await library.search({
      text: req.query,
      ...(req.author === undefined ? {} : { author: req.author }),
      ...(req.year === undefined ? {} : { year: req.year }),
      rows: req.limit,
    });

    return {
      ok: result.ok,
      reason: result.reason,
      candidates: result.candidates.map((c) => ({
        source: c.source,
        cite: c.cite,
        title: c.item.title ?? null,
        doi: c.item.DOI ?? null,
        year: c.item.issued?.['date-parts']?.[0]?.[0] ?? null,
        container: c.item['container-title'] ?? null,
        abstract: c.item.abstract ?? null,
        retracted: c.item.extra?.retracted === true,
        inLibraryRefId: c.inLibraryRefId,
      })),
      attempts: result.attempts.map((a) => ({
        source: a.source,
        ok: a.ok,
        reason: a.reason,
        total: a.total,
      })),
    };
  });

  d.register('ref.delete', async (req) => {
    const library = await refsFor(req.projectId);
    if (library.repo.get(req.refId) === null) throw notFound(`文献不存在：${req.refId}`);
    const deleted = library.repo.delete(req.refId);
    if (deleted) {
      d.broadcast({
        kind: 'refs.changed',
        projectId: req.projectId,
        action: 'remove',
        refIds: [req.refId],
      });
    }
    return { deleted };
  });

  d.register('ref.merge', async (req) => {
    const library = await refsFor(req.projectId);
    const result = library.merge(req.keepId, req.dropId);
    if (!result.ok || result.ref === null) {
      throw new DispatchError(
        makeError('conflict', result.reason ?? '合并失败', {
          remediation: '确认两个 id 都存在且不相同。',
        }),
      );
    }
    d.broadcast({
      kind: 'refs.changed',
      projectId: req.projectId,
      action: 'merge',
      refIds: [req.keepId],
    });
    return { ref: { ...result.ref, cite: citeLine(result.ref.csl) } };
  });

  d.register('ref.duplicates', async (req) => {
    const library = await refsFor(req.projectId);
    return library.scanDuplicates({ limit: req.limit });
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

    const interrupted = await (await orchestratorFor(projectId)).interrupt(req.conversationId);
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

    /*
     * 执行平面要显式收掉。
     *
     * 内核是独立进程，控制面 RPC 与出口代理是监听中的服务。不关的话：Job Object
     * 支持时内核会随本进程一起死（KILL_ON_JOB_CLOSE），不支持时它们变成孤儿并占着
     * 内存；而两个监听端口会让下一次启动看起来「莫名有个旧实例在」。
     *
     * 整体设 5 秒上限：某个内核卡在不可中断的系统调用里时，等它等到天亮不如
     * 直接退出——进程退出会连带收掉 Job Object 里的一切。
     */
    const closers: Array<Promise<unknown>> = [];
    // 审查服务先关：它持有在途的模型调用，不中止的话进程要等它跑完才退
    for (const reviewer of reviewers.values()) reviewer.close();

    /*
     * 连接器与桥要收掉。
     *
     * stdio 传输的连接器是我们 spawn 的子进程，不关就变成孤儿；HTTP 的会话不显式结束
     * 会让服务端一直留着资源。桥自己也是一个监听中的服务，不关会让下一次启动看起来
     * 「莫名有个旧实例在」。
     */
    for (const manager of mcpManagers.values()) closers.push(manager.close());
    closers.push(bridge.stop());

    for (const plane of computePlanes.values()) {
      plane.background.close();
      closers.push(plane.repl.close());
      closers.push(plane.pool.close());
      closers.push(plane.controlPool.close());
      closers.push(plane.hostServer.stop());
      closers.push(plane.proxy.stop());
      closers.push(plane.sandbox.dispose());
    }

    const cleanup = Promise.allSettled(closers);
    const deadline = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      t.unref();
    });

    void Promise.race([cleanup, deadline])
      .then(() => transport.close())
      .then(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // stdin 关闭意味着外壳已经走了，跟着退出，避免留下孤儿进程。
  process.stdin.on('end', () => shutdown('stdin EOF'));
}

main().catch((err: unknown) => {
  // 启动阶段抛错必须能被看见并让进程真的退出。吞掉它的结果是一个「起来了但什么
  // 请求都不响应」的后端，而外壳侧只能看到超时
  log(`后端启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
