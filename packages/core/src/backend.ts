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
import { KernelPool, detectKernels, rEnvAt } from '@l-science/kernel';
import type {
  JupyterKernel,
  KernelLanguage,
  KernelOutput,
  PythonEnv,
  REnv,
} from '@l-science/kernel';
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
import {
  RefLibrary,
  citeLine,
  createManageReferencesTool,
  renderExportWarnings,
} from './refs/index.js';
import { RefsRepo } from './repo/refs.js';
import {
  BUILTIN_JOURNAL_PROFILES,
  CitationVerifier,
  ClaimLedger,
  ManuscriptCompiler,
  createCompileManuscriptTool,
  createManageClaimsTool,
  createVerifyCitationsTool,
  describeCheck,
  describeCitation,
  parseCitation,
  parseReferenceList,
  renderVerifyResults,
} from './manuscript/index.js';
import { ClaimsRepo, type ClaimRecord } from './repo/claims.js';
import { ManuscriptRepo } from './repo/manuscripts.js';
import {
  ComputeGate,
  ComputeService,
  RISK_LABEL,
  createManageComputeTool,
  createRunRemoteCommandTool,
  createSubmitJobTool,
  detectSshClient,
  isTerminalJobState,
  scanHostKey,
  sshClientRemediation,
  suggestLocalTarget,
  validateConfig as validateComputeConfig,
  type ComputeTargetConfig,
  type JobState,
} from './compute/index.js';
import {
  ComputeGrantsRepo,
  ComputeJobsRepo,
  ComputeTargetsRepo,
  grantScopeOptions,
} from './repo/compute.js';
import { EnvsRepo, type EnvRecord } from './repo/envs.js';
import {
  EnvService,
  createManageEnvironmentsTool,
  detectInstallers,
  commonVenvLocations,
  condaAvailable,
  listCondaEnvironments,
  MemoryEnvGrantStore,
  resetInstallerCache,
  restartNotice,
  type EnvLanguage,
  type InstallerFamily,
  type PackageSource,
} from './envs/index.js';
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
import { provisionKnownProviders } from './providers/provision.js';
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
import {
  INSTANCE_LOCK_EXIT_CODE,
  acquireInstanceLock,
  describeLockConflict,
} from './instance-lock.js';
import { dataDir, dataDirSource, describeDataDir } from './paths.js';
import { describePlatform, platform, platformGaps, unknownPlatform } from './platform/index.js';
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
import {
  capabilityProbe,
  describeCapabilities,
  detectCapabilities,
  REMEDIATION,
  resetCapabilityCache,
} from './tools/capabilities.js';
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

  /*
   * 实例锁必须在打开任何库**之前**取（任务 15.2，需求 20.4.2）。
   *
   * 顺序反了的话，被拒绝的那个实例已经跑过一次迁移、已经把内置技能装了一遍、也已经
   * 把 MCP 桥的临时端口写进了连接器行——而那些写入正是要防的东西。
   */
  const root = dataDir();
  const lockResult = acquireInstanceLock({ root, onLog: log });
  if (!lockResult.ok) {
    /*
     * 走 stderr 而不是抛异常：stdout 被 NDJSON 协议独占，而这条消息的读者是人。
     * 退出码用一个专属值，让外壳能把它与「后端崩了」区分开并弹出具体说明——
     * 否则用户看到的只是一句「后端未就绪」。
     */
    process.stderr.write(`${describeLockConflict(lockResult)}\n`);
    process.exitCode = INSTANCE_LOCK_EXIT_CODE;
    return;
  }
  const lock = lockResult.lock;
  // 退出路径统一在这里释放：正常退出、stdin EOF、未捕获异常都会经过 'exit'
  process.on('exit', () => {
    lock.release();
  });

  const store = AppStore.open(root);

  log(`数据目录 ${describeDataDir()}`);
  if (lock.tookOverStale !== null) {
    /*
     * 崩溃退出要报出来。
     *
     * 上一次没有走正常退出路径，意味着可能留下了没跑完的迁移或半个内核目录。这是
     * 用户排查「上次为什么不对」时唯一的线索，静默接管等于把它丢掉。
     */
    log(
      `上一个实例（pid ${String(lock.tookOverStale.pid)}）没有正常退出，已接管数据目录。` +
        '若上次运行中断在导入或编译过程中，建议检查一下相关制品是否完整。',
    );
  }
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
    /*
     * 数据目录的来源与锁状态一起报（需求 20.4.2）。
     *
     * 「我的项目怎么不见了」最常见的原因是这次启动的数据目录与上次不同。只报路径的话
     * 用户看到一个陌生路径也不知道该去改哪里，因此要说清它是环境变量给的还是默认的。
     */
    dataDirSource: dataDirSource(),
    instanceLock: {
      path: lock.path,
      pid: lock.info.pid,
      tookOverStale: lock.tookOverStale === null ? null : lock.tookOverStale.pid,
    },
    sqlite: sqliteVersion(store.db),
    schema: schemaVersion(store.db),
    projectCount: store.projects.count(),
    danglingProjects: dangling.length,
  }));

  d.register('env.doctor', async (req) => {
    if (req.refresh) resetCapabilityCache();
    const caps = detectCapabilities();
    return {
      dataDir: store.paths.root,
      dataDirSource: dataDirSource(),
      dataDirLabel: describeDataDir(),
      platform: describePlatform(),
      gaps: platformGaps(),
      capabilities: describeCapabilities(caps),
    };
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
  const claimLedgers = new Map<string, ClaimLedger>();
  const citationVerifiers = new Map<string, CitationVerifier>();
  const manuscriptCompilers = new Map<string, ManuscriptCompiler>();
  const computeServices = new Map<string, ComputeService>();
  const envServices = new Map<string, EnvService>();

  /**
   * 路径比较的归一化。
   *
   * Windows 上同一个目录会以不同写法出现（大小写、正反斜杠、末尾斜杠），而内核记下的
   * 路径来自 conda 的输出、登记表里的来自用户输入。不归一化的话「这个内核跑在这个
   * 环境上吗」在同一台机器上都会答错。
   */
  const normalizePath = (path: string): string =>
    path
      .replace(/[\\/]+$/u, '')
      .replace(/\\/gu, '/')
      .toLowerCase();

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

  /* --- 算力目标（任务 14.2，需求 14.3、14.6）------------------------- */

  /*
   * 算力目标与算力授权都在**应用库**，全局一份。
   *
   * 一台集群是研究者的基础设施，不属于某个项目。放进项目库会让「新建项目后要把三台
   * 机器重新登记一遍」，而重新登记意味着 host key 要重新确认、环境笔记要重写——那些
   * 恰恰是最不该重复的东西。项目隔离由 compute_grants 的 scope 负责。
   *
   * 声明位置提到这里是因为记忆服务的 `computeTargetExists` 要用它，而那在每个项目的
   * 初始化路径上。
   */
  const computeTargets = new ComputeTargetsRepo(store.db);
  const computeGrants = new ComputeGrantsRepo(store.db);

  /* --- 环境与包（任务 14.4，需求 15.1-15.7）------------------------- */

  /*
   * 环境登记表在**应用库**：一个 conda 环境或一个 venv 是这台机器上的资源，不属于
   * 某个项目。放进项目库会让「新建项目后要把环境重新登记一遍」，而登记一个 venv
   * 需要用户自己去找路径。
   *
   * 声明位置提到这里是因为内核池要用 `defaultKernelEnv`（需求 15.2 的内核直启），
   * 而内核池在每个项目的初始化路径上。
   */
  const envsRepo = new EnvsRepo(store.db);

  /*
   * 装包授权（需求 17.5）。
   *
   * 内存实现，全局一份。不落库的理由见 `MemoryEnvGrantStore` 的注释：装包授权最宽只到
   * project，而一条跨重启的「这个环境随便装」授权会在半年后仍然生效，那时用户早就
   * 不记得自己给过。
   */
  const envGrants = new MemoryEnvGrantStore();

  /**
   * 用户选定的默认 Python 环境。null 表示用探测到的托管环境。
   *
   * 状态不是 `ready` 的环境**不返回**：一个缺 ipykernel 或目录已被删掉的环境会让
   * 内核起不来，而那时用户看到的是「内核启动失败」而不是「你选的环境有问题」。
   * 退回托管环境至少让他还能干活，而环境本身的问题在环境页上是可见的。
   */
  const defaultPythonEnv = (): PythonEnv | null => {
    const env = envsRepo.defaultFor('python');
    if (env === null || env.status !== 'ready' || env.interpreter === null) return null;
    return { prefix: env.path, executable: env.interpreter };
  };

  /** 用户选定的默认 R 环境（需求 15.7 的独立 R 环境仍然可以被换掉）。 */
  const defaultREnv = (): REnv | null => {
    const env = envsRepo.defaultFor('r');
    if (env === null || env.status !== 'ready') return null;
    // 走 kernel 包里那段路径推断，不在这里复制一份：它在 Windows 上有几个非显然的
    // 地方，分叉的表现是 R 内核以 0xC0000135 退出且 stdout/stderr 全空
    return rEnvAt(env.path);
  };

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
      connectors: () => new Set(connectorRepo.listEffective().map((c) => c.id)),
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
      /*
       * 用户选定的默认环境优先于探测（任务 14.4，需求 15.2）。
       *
       * 每次启动现读：用户可以在运行中把默认环境切到另一个 venv，缓存下来的那个会让
       * 新内核仍然起在旧环境上，而两者的区别只在 `sys.executable` 里看得出来。
       */
      pythonEnv: defaultPythonEnv,
      rEnv: defaultREnv,
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
      /*
       * M4 三层（任务 13.1-13.6）用惰性取。
       *
       * 控制面必须在这里就注册好——内核池、shim 与 RPC 都依赖它的表面清单，而那三层
       * 要接审批服务、域名授权与制品库，只能在下面才建得起来。这些回调只在模型真的
       * 调用对应方法时执行，那时它们一定已经就绪；就绪之前调用会拿到一句明确的
       * 「尚未就绪」而不是一个空壳。
       */
      refs: () => {
        const library = refLibraries.get(projectId);
        if (library === undefined) throw new Error(`项目 ${projectId} 的文献库尚未就绪`);
        return library;
      },
      claims: () => {
        const ledger = claimLedgers.get(projectId);
        if (ledger === undefined) throw new Error(`项目 ${projectId} 的断言台账尚未就绪`);
        return ledger;
      },
      citations: () => citationVerifierFor(),
      manuscripts: () => {
        const compiler = manuscriptCompilers.get(projectId);
        if (compiler === undefined) throw new Error(`项目 ${projectId} 的手稿编译器尚未就绪`);
        return compiler;
      },
      compute: () => {
        const service = computeServices.get(projectId);
        if (service === undefined) throw new Error(`项目 ${projectId} 的算力服务尚未就绪`);
        return service;
      },
      envs: () => {
        const service = envServices.get(projectId);
        if (service === undefined) throw new Error(`项目 ${projectId} 的环境管理服务尚未就绪`);
        return service;
      },
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

    /* --- Claim Ledger（任务 13.4，需求 13.1-13.4）-------------------- */

    /*
     * 建在 Reviewer 之前：Reviewer 要用它取未关闭断言的快照（需求 13.3）。
     *
     * `refExists` 用惰性查表而不是直接持有 refLibrary——文献库在下面才建，而这个
     * 回调只在模型绑定证据时被调用，那时它一定已经存在。反过来（把文献库挪到这里
     * 建）要连带挪动它依赖的几段接线，改动面大得多。
     */
    const claimLedger = new ClaimLedger({
      repo: new ClaimsRepo(project.db),
      artifactExists: (versionId) => artifactStore.getVersion(versionId) !== null,
      refExists: (refId) => (refLibraries.get(projectId)?.repo.get(refId) ?? null) !== null,
      refIdByDoi: (doi) => refLibraries.get(projectId)?.repo.getByDoi(doi)?.id ?? null,
      // 计算单元用工具调用 id 或带代码的制品版本，两种都要认
      computeExists: (id) =>
        artifactStore.getVersion(id) !== null ||
        (project.db.prepare('SELECT 1 FROM tool_calls WHERE id = ?').get(id) as unknown) !==
          undefined,
      onLog: (line) => {
        log(`[claims ${projectId}] ${line}`);
      },
    });
    claimLedgers.set(projectId, claimLedger);

    /*
     * 引文核实器（任务 13.5，需求 13.9）。
     *
     * 惰性建：它要用文献库（检索由文献库的 `search` / `addByIdentifier` 完成），
     * 而文献库在下面才建。核实只在模型或界面发起时才跑，那时它一定已经存在。
     */
    const citationVerifierFor = (): CitationVerifier => {
      const library = refLibraries.get(projectId);
      if (library === undefined) {
        throw new Error(`项目 ${projectId} 的文献库尚未就绪`);
      }
      const existing = citationVerifiers.get(projectId);
      if (existing !== undefined) return existing;
      const verifier = new CitationVerifier({
        library,
        claims: claimLedger.repo,
        onLog: (line) => {
          log(`[citations ${projectId}] ${line}`);
        },
      });
      citationVerifiers.set(projectId, verifier);
      return verifier;
    };

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
      /*
       * 未关闭断言的快照（需求 13.3）。
       *
       * 按会话筛：findings 必须挂在一个会话上，而把全项目的断言都报进每个会话的
       * 审查会让同一条无证据断言在五个会话里各出现一次。
       */
      claims: (conversationId) => {
        /*
         * 未关闭的断言 + 已支持的引文支撑陈述。
         *
         * 后者不在「未关闭」里，但需求 13.9 的兜底检查正是要看它们：一条被标成
         * 「已支持」却没有检索记录的引文断言，只有把它带进快照才能被发现。
         */
        const unresolved = claimLedger.repo.list({
          conversationId,
          status: 'unresolved',
          limit: 200,
        });
        const supportedCitations = claimLedger.repo
          .list({ conversationId, status: 'supported', limit: 200 })
          .filter((claim) => claim.kinds.includes('citation'));

        return [...unresolved, ...supportedCitations].map((claim) => ({
          id: claim.id,
          text: claim.text,
          locator: claim.locator,
          status: claim.status,
          origin: claim.origin,
          numbers: claim.numbers,
          isCitation: claim.kinds.includes('citation'),
          retrievalBacked: claimLedger.repo.hasRetrievalBackedCheck(claim.id),
          evidence: claim.evidence.map((e) => ({
            kind: e.kind,
            ref: e.ref,
            verdict: e.verdict,
            quote: e.quote,
          })),
        }));
      },
      citationChecks: () =>
        claimLedger.repo.citationChecks({ limit: 200 }).map((check) => ({
          id: check.id,
          claimId: check.claimId,
          raw: check.raw,
          verdict: check.verdict,
          queryCount: check.queries.length,
          detail: check.detail,
          matchedRefId: check.matchedRefId,
        })),
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
      /*
       * 只给已登记的目标写笔记（需求 14.5）。
       *
       * 走仓储而不是裸 SQL：仓储是这张表的唯一写入口，两处各自拼 SQL 迟早在列名上
       * 分叉。放行不存在的 id 会写出一批指向已删除目标的孤儿笔记，而它们会一直被
       * 注入 compute 作用域的检索结果里。
       */
      computeTargetExists: (targetId) => computeTargets.exists(targetId),
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
        // `isDomainAllowed` 返回的是对象而不是布尔（它要带上命中的那条授权）。
        // 直接当条件用会恒为真，于是这道门形同不存在——「授权列表里没有
        // api.crossref.org，但一调文献工具就连上了」正是这套两级管控要防的半开状态
        const allowed = hosts.filter(
          (h) => grants.isDomainAllowed({ domain: h, projectId }).allowed,
        );
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
      /*
       * 全文抓取的单主机批准（任务 13.2）。
       *
       * 与元数据那道门分开，因为这里的主机运行时才知道：Unpaywall 会返回任意
       * 出版商或机构仓储的地址。合成一张卡片在这里做不到，也不该做——把外部 PDF
       * 拉进工作区的影响与查一次元数据不是一个量级，用户有权逐个主机决定。
       */
      authorizeFulltextHost: async (host, why) => {
        // 同上：取 `.allowed`，不能把返回的对象当布尔
        if (grants.isDomainAllowed({ domain: host, projectId }).allowed) return true;

        const result = await approvalFor(projectId).request({
          kind: 'domain-allowlist',
          title: `允许从 ${host} 下载全文？`,
          detail:
            `${why}\n\n这个地址来自开放获取索引（Unpaywall / OpenAlex）或预印本服务器，` +
            '不是本平台内置的名单。',
          impact:
            '批准后会把该地址的文件下载进项目的制品库。下载的是文档，不会执行；' +
            '但内容来自外部，引用前应当核对它确实是你要的那篇。',
          reversible: true,
          undoHint: '在设置的授权列表里撤销该域名，并删除已下载的制品。',
          scopeOptions: ['once', 'project', 'always'],
          payload: { host, reason: why },
        });

        if (result.state !== 'approved') return false;
        if (result.scope !== 'once') {
          try {
            grants.allowDomain({
              domain: host,
              mode: 'rw',
              scope: result.scope,
              scopeId: result.scope === 'project' ? projectId : null,
              reason: `用户为全文抓取在项目 ${projectId} 内批准`,
            });
          } catch (err) {
            log(`全文抓取域名授权写入失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return true;
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

    /* --- Claim Ledger 工具（任务 13.4，需求 13.1-13.4）---------------- */

    tools.register(
      createManageClaimsTool({
        ledger: () => claimLedger,
        // 让 extract 能直接吃手稿制品，而不是要求模型把整篇正文贴进参数里
        readVersion: (versionId) => {
          const bytes = artifactStore.readVersion(versionId);
          return bytes === null ? null : bytes.toString('utf8');
        },
        onChanged: (info) => {
          d.broadcast({
            kind: 'claims.changed',
            projectId,
            action: info.action,
            claimIds: info.claimIds,
            conversationId: info.conversationId,
          });

          /*
           * 确认与核验是审查触发点（需求 11.3 的同类）。
           *
           * 确认一条断言之后立刻审查，才能在模型还在这个话题上时就把「这条没有证据」
           * 提出来；等到下一轮 turn 结束再报，模型已经转到别的事情上了。
           *
           * `extract` 与 `register` 刻意不触发：一次抽取会登记几十条，紧接着跑审查
           * 只会产出一条「这批需要分类」的 WARN，而那条信息抽取工具自己的输出里
           * 已经说了。
           */
          if (info.action === 'confirm' || info.action === 'verify') {
            void reviewer.schedule({
              conversationId: info.conversationId,
              trigger: 'artifact-saved',
            });
          }
        },
      }),
    );

    /* --- 手稿编译（任务 13.6，需求 13.5-13.8）------------------------ */

    const manuscriptCompiler = new ManuscriptCompiler({
      repo: new ManuscriptRepo(project.db),
      artifacts: artifactStore,
      // 文献库在下面才建，用惰性取。编译只在用户或模型发起时跑
      refs: () => refLibraries.get(projectId)?.repo.list({ limit: 1000 }) ?? [],
      /*
       * 编译前触发审查（需求 11.3 把「手稿编译前」列为触发点）。
       *
       * 编译是投稿前最后一道工序，而无证据断言与编造引文在这之后就没有机会被
       * 发现了。不触发的话用户会在「编译成功」的报告上直接投稿。
       */
      onBeforeCompile: ({ conversationId }) => {
        if (conversationId === null) return;
        void reviewer.schedule({ conversationId, trigger: 'pre-compile' });
      },
      onLog: (line) => {
        log(`[manuscript ${projectId}] ${line}`);
      },
    });
    manuscriptCompilers.set(projectId, manuscriptCompiler);

    tools.register(
      createCompileManuscriptTool({
        compiler: () => manuscriptCompiler,
        onCompiled: (info) => {
          d.broadcast({
            kind: 'manuscript.compiled',
            projectId,
            conversationId: info.conversationId,
            manuscriptId: info.manuscriptId,
            errors: info.errors,
            warnings: info.warnings,
            selfCitationLeaks: info.leaks,
          });
        },
      }),
    );

    /* --- 引文核实（任务 13.5，需求 13.9）----------------------------- */

    tools.register(
      createVerifyCitationsTool({
        verifier: citationVerifierFor,
        ledger: () => claimLedger,
        readVersion: (versionId) => {
          const bytes = artifactStore.readVersion(versionId);
          return bytes === null ? null : bytes.toString('utf8');
        },
        onChecked: (info) => {
          d.broadcast({
            kind: 'citations.checked',
            projectId,
            conversationId: info.conversationId,
            checked: info.checked,
            notFound: info.notFound,
            mismatched: info.mismatched,
          });

          /*
           * 查出编造或错写的引文之后立刻审查。
           *
           * 这两类是需求 13.9 真正要防的东西，而它们的确定性检查在
           * `checkCitationIntegrity` 里——不主动触发的话要等到下一轮 turn 结束，
           * 那时模型已经基于「核实过了」继续往下写了。
           */
          if (info.notFound > 0 || info.mismatched > 0) {
            void reviewer.schedule({
              conversationId: info.conversationId,
              trigger: 'artifact-saved',
            });
          }
        },
      }),
    );

    /* --- 环境与包管理（任务 14.4，需求 15.1-15.7）-------------------- */

    /*
     * 登记表在应用库（全局一份），而后台执行器与内核池按项目。因此服务本体按项目建，
     * 共用同一个 repo。
     */
    const envService = new EnvService({
      repo: envsRepo,
      projectId,
      /*
       * 装包过审批（任务 14.5，需求 17.1）。
       *
       * `pip install` 会执行包自带的构建脚本——那是任意代码执行，在用户自己的机器上、
       * 用他的权限。这与「远程命令执行」在性质上没有区别，只是它长得像一次无害的
       * 依赖管理。而且装进去的东西被此后所有会话的内核共用。
       */
      approvals: () => approvalFor(projectId),
      grants: () => envGrants,
      // 需求 15.6：创建环境与装包是耗时操作，走后台任务。它不受会话中断影响——
      // 否则用户随口打断一句就把装了三分钟的环境毁了一半
      background: () => background,
      /*
       * 哪些会话的内核跑在这个环境上（需求 15.5）。
       *
       * 按内核**启动时**记下的环境目录比对，不按「当前默认环境」推断：用户切换默认
       * 之后已经跑着的内核仍在旧环境上，按当前默认推断会把它们算到新环境头上，
       * 于是「装包要不要重启」的答案是错的——而错的方向是清掉一批本来不受影响的内存状态。
       */
      liveKernels: (env: EnvRecord) =>
        pool
          .list()
          .filter(
            (entry) =>
              entry.language === env.language &&
              normalizePath(entry.envPrefix) === normalizePath(env.path),
          )
          .map((entry) => entry.conversationId),
      restartKernels: async (env: EnvRecord) => {
        const targets = pool
          .list()
          .filter(
            (entry) =>
              entry.language === env.language &&
              normalizePath(entry.envPrefix) === normalizePath(env.path),
          );
        let restarted = 0;
        for (const entry of targets) {
          if (await pool.restart(entry.conversationId, entry.language)) restarted += 1;
        }
        return restarted;
      },
      onChanged: (info) => {
        d.broadcast({ kind: 'env.changed', projectId, action: info.action, envId: info.envId });
      },
      onLog: (line) => {
        log(`[env ${projectId}] ${line}`);
      },
    });
    envServices.set(projectId, envService);

    tools.register(
      createManageEnvironmentsTool({
        service: () => envService,
        onChanged: (info) => {
          d.broadcast({ kind: 'env.changed', projectId, action: info.action, envId: info.envId });
        },
      }),
    );

    /* --- 算力服务（任务 14.2，需求 14.3、14.4、14.6、14.7）----------- */

    /*
     * 目标与授权在应用库（全局），作业与命令审计在项目库。
     *
     * 门控用惰性取审批服务：`approvalFor(projectId)` 自己是惰性的，而在这里立刻调用
     * 会在每个项目初始化时白建一个审批服务实例。
     */
    const computeService = new ComputeService({
      projectId,
      targets: computeTargets,
      jobs: new ComputeJobsRepo(project.db),
      grants: computeGrants,
      gate: new ComputeGate({
        approvals: () => approvalFor(projectId),
        grants: computeGrants,
        vault,
        projectId,
      }),
      artifacts: artifactStore,
      vault,
      // 环境笔记走记忆服务的 compute 作用域（任务 14.3，需求 14.5）：那一层已经有
      // 跨项目存储、准入规则、条数上限与「必须给理由」，自己开表等于把它们重写一遍
      memory: () => memory,
      onJobEvent: (event) => {
        d.broadcast({
          kind: 'compute.job',
          projectId,
          event: event.kind,
          jobId: event.jobId,
          targetId: event.targetId,
          conversationId: event.conversationId,
          state: event.state,
          detail: event.detail,
          terminalSource: event.terminalSource,
        });

        /*
         * 终止时往会话里写一条系统消息（需求 14.7 的「结果关联回发起会话」）。
         *
         * 只广播是不够的：用户可能在作业跑的两小时里关过窗口，而广播是瞬时的。
         * 写进历史之后，下一回合模型也看得到「那个作业结束了」——否则它会一直以为
         * 作业还在跑，或者更糟，假定它成功了。
         */
        if (event.kind !== 'finished' || event.conversationId === null) return;
        const job = computeService.jobs.get(event.jobId);
        try {
          project.messages.append({
            conversationId: event.conversationId,
            role: 'system',
            content: {
              kind: 'compute-job-finished',
              text:
                job === null
                  ? `算力作业 ${event.jobId} 结束：${event.state}`
                  : computeService.renderJob(job),
            },
          });
        } catch (err) {
          log(`作业结束消息落库失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onTargetsChanged: (info) => {
        d.broadcast({
          kind: 'compute.targets',
          projectId,
          action: info.action,
          targetId: info.targetId,
        });
      },
      onLog: (line) => {
        log(`[compute ${projectId}] ${line}`);
      },
    });
    computeServices.set(projectId, computeService);

    /*
     * 恢复跟踪未结束的作业（需求 14.7）。
     *
     * 「跟踪到终止态」不能因为用户关过一次窗口就作废，而那正是长作业期间最常发生的事。
     */
    computeService.resume();

    const computeToolOptions = {
      service: () => computeService,
      onJobsChanged: (info: { action: string; jobId: string | null }) => {
        d.broadcast({ kind: 'compute.jobs', projectId, action: info.action, jobId: info.jobId });
      },
    };
    tools.register(createManageComputeTool(computeToolOptions));
    tools.register(createRunRemoteCommandTool(computeToolOptions));
    tools.register(createSubmitJobTool(computeToolOptions));

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
      systemPrompt: (conversationId) =>
        buildSystemPrompt({
          // 项目名在应用库里，每次现读：用户改了项目名之后提示词里该跟着变
          ...(() => {
            const name = store.projects.get(projectId)?.name;
            return name === undefined ? {} : { projectName: name };
          })(),
          toolNames: tools.toolSchemas().map((s) => s.name),
          /*
           * 算力环境笔记只带**本会话碰过的目标**（任务 14.3，需求 14.5）。
           *
           * 全部带上是纯噪声：一个只做数据整理的会话不需要知道三台集群各自的分区，
           * 而记忆注入有字符预算——噪声会把真正相关的内容挤出去。碰过的目标由
           * 作业与命令记录判定，因此只跑过一条 squeue 也算，那时「这个集群的
           * sacct 没开」这类笔记恰恰最该在场。
           */
          memory: memory.injection({
            computeTargetIds: computeService.activeTargetIds(conversationId),
          }),
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
    const adapter = platform();
    return {
      backend: 'native' as const,
      isolation,
      strength: isolationStrength(isolation),
      /*
       * 平台缺口一起返回（任务 15.1，需求 20.4.1）。
       *
       * 放在这个方法里而不是单开一个：用户问「我现在受什么保护」时，「沙箱能做到什么」
       * 与「这个平台上哪几项能力是降级的」是同一个问题的两半。分成两个接口的话 UI 会
       * 只显示前一半——而在 Linux 上后一半恰好包含「凭据库不可用」这种必须知道的事。
       *
       * 在 Windows 上 gaps 为空数组，UI 不显示这一段。
       */
      platform: {
        id: adapter.id,
        label: adapter.label,
        unknown: unknownPlatform(),
        gaps: platformGaps().map((gap) => ({
          id: gap.id,
          what: gap.what,
          consequence: gap.consequence,
          plan: gap.plan,
        })),
      },
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

  d.register('provider.provision', async (req) => {
    if (req.deepseekKey !== undefined) requireVault();
    return provisionKnownProviders(
      { vault, registry: modelRegistry, sync: modelSync, adapters },
      {
        ...(req.deepseekKey === undefined ? {} : { deepseekKey: req.deepseekKey }),
        detectOllama: req.detectOllama,
      },
    );
  });

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
    skills.reload();
    void skills.buildVectors();

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

  /* --- 全文抓取（任务 13.2，需求 12.3、12.4、12.6）--- */

  d.register('ref.fetchFulltext', async (req) => {
    const library = await refsFor(req.projectId);
    const result = await library.fetchFulltext(req.refId, {
      ...(req.sources === undefined ? {} : { sources: req.sources }),
      force: req.force,
    });

    if (result.ok) {
      d.broadcast({
        kind: 'refs.changed',
        projectId: req.projectId,
        action: 'fulltext',
        refIds: [req.refId],
      });
    }

    return {
      ok: result.ok,
      source: result.source,
      summary: result.summary,
      fulltextArtifactId: result.fulltextArtifactId,
      fulltextVersionId: result.fulltextVersionId,
      assets: result.assets,
      // 逐次尝试原样给出：失败时用户要看到试过谁、各自为什么不行
      attempts: result.attempts,
      article:
        result.article === null
          ? null
          : {
              title: result.article.title,
              figures: result.article.figures.length,
              tables: result.article.tables.length,
              references: result.article.references.length,
              license: result.article.license,
            },
    };
  });

  d.register('ref.assets', async (req) => {
    const library = await refsFor(req.projectId);
    const ref = library.repo.get(req.refId);
    if (ref === null) throw notFound(`文献不存在：${req.refId}`);
    return {
      assets: library.repo.assets(req.refId),
      attempts: library.repo.fetchAttempts(req.refId),
      fulltextArtifactId: ref.fulltextArtifactId,
      oaStatus: ref.oaStatus,
    };
  });

  d.register('ref.attachFulltext', async (req) => {
    const library = await refsFor(req.projectId);

    let content: Buffer;
    try {
      content = Buffer.from(req.contentBase64, 'base64');
    } catch {
      throw new DispatchError(makeError('bad_request', '内容不是合法的 base64'));
    }
    if (content.byteLength === 0) {
      throw new DispatchError(
        makeError('bad_request', '解出来是空内容', {
          remediation: 'base64 可能被截断了。确认整份内容都传上来了。',
        }),
      );
    }

    const result = library.attachFulltext({
      refId: req.refId,
      filename: req.fileName,
      content,
      ...(req.note === undefined ? {} : { note: req.note }),
    });

    if (!result.ok) {
      throw new DispatchError(
        makeError('bad_request', result.reason ?? '绑定失败', {
          remediation: '确认下载到的是文档本身而不是出版商的落地页。',
        }),
      );
    }

    d.broadcast({
      kind: 'refs.changed',
      projectId: req.projectId,
      action: 'fulltext',
      refIds: [req.refId],
    });
    return { artifactId: result.artifactId, versionId: result.versionId };
  });

  /* --- Claim Ledger（任务 13.4，需求 13.1-13.4）--- */

  const claimsFor = async (projectId: string): Promise<ClaimLedger> => {
    await orchestratorFor(projectId);
    const ledger = claimLedgers.get(projectId);
    if (ledger === undefined) throw notFound(`项目不可用：${projectId}`);
    return ledger;
  };

  /** 断言的 IPC 视图。把 extra 里的东西提到平面上，UI 不该去猜结构。 */
  const claimView = (claim: ClaimRecord): Record<string, unknown> => ({
    ...claim,
    unsupported: claim.evidence.length === 0,
    verifiedCount: claim.evidence.filter((e) => e.verdict !== null).length,
  });

  d.register('claim.list', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const claims = ledger.repo.list({
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      ...(req.manuscriptId === undefined ? {} : { manuscriptId: req.manuscriptId }),
      status: req.status,
      ...(req.kind === undefined ? {} : { kind: req.kind }),
      unsupportedOnly: req.unsupportedOnly,
      limit: req.limit,
    });

    const scope = {
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      ...(req.manuscriptId === undefined ? {} : { manuscriptId: req.manuscriptId }),
    };

    return {
      claims: claims.map(claimView),
      summary: ledger.summary(scope),
      gate: ledger.gateSummary(scope),
    };
  });

  d.register('claim.get', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const claim = ledger.repo.get(req.claimId);
    if (claim === null) throw notFound(`断言不存在：${req.claimId}`);
    return { claim: claimView(claim) };
  });

  d.register('claim.extract', async (req) => {
    const ledger = await claimsFor(req.projectId);

    let markdown = req.markdown;
    if (markdown === undefined && req.artifactVersionId !== undefined) {
      const artifacts = artifactStoreFor(req.projectId);
      const bytes = artifacts.readVersion(req.artifactVersionId);
      if (bytes === null) throw notFound(`制品版本不存在：${req.artifactVersionId}`);
      markdown = bytes.toString('utf8');
    }
    if (markdown === undefined) {
      throw new DispatchError(
        makeError('bad_request', '需要 markdown 或 artifactVersionId', {
          remediation: '把手稿正文放在 markdown 里，或给出一个手稿制品的版本 id。',
        }),
      );
    }

    const result = ledger.extractAndRegister({
      markdown,
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      ...(req.manuscriptId === undefined ? {} : { manuscriptId: req.manuscriptId }),
      options: { limit: req.limit },
    });

    if (result.created.length > 0) {
      d.broadcast({
        kind: 'claims.changed',
        projectId: req.projectId,
        action: 'extract',
        claimIds: result.created.map((c) => c.id),
        conversationId: req.conversationId ?? null,
      });
    }

    return {
      summary: result.summary,
      created: result.created.map(claimView),
      skippedExisting: result.skippedExisting,
      sentencesScanned: result.extraction.sentencesScanned,
      truncated: result.extraction.truncated,
      // 被规则排除的句子一并给出：「为什么这句没抽到」只能靠它回答
      skipped: result.extraction.skipped,
    };
  });

  d.register('claim.register', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.register({
      text: req.text,
      // 界面登记的断言一开始就是确认状态：用户是主动写下它的
      origin: 'user',
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      ...(req.manuscriptId === undefined ? {} : { manuscriptId: req.manuscriptId }),
      ...(req.locator === undefined ? {} : { locator: req.locator }),
      ...(req.note === undefined ? {} : { note: req.note }),
    });

    if (!result.ok || result.claim === null) {
      throw new DispatchError(makeError('bad_request', result.reason ?? '登记失败'));
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'register',
      claimIds: [result.claim.id],
      conversationId: req.conversationId ?? null,
    });
    return { claim: claimView(result.claim), existing: result.existing, reason: result.reason };
  });

  d.register('claim.bind', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.bind({
      claimId: req.claimId,
      kind: req.evidenceKind,
      ref: req.evidenceRef,
      ...(req.locator === undefined ? {} : { locator: req.locator }),
      ...(req.quote === undefined ? {} : { quote: req.quote }),
      ...(req.note === undefined ? {} : { note: req.note }),
    });

    if (!result.ok) {
      throw new DispatchError(
        makeError('bad_request', result.reason ?? '绑定失败', {
          remediation: '确认引用的 id 真实存在。制品版本用 av_ 开头，文献条目用 rf_ 开头。',
        }),
      );
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'bind',
      claimIds: [req.claimId],
      conversationId: result.claim?.conversationId ?? null,
    });
    return { claim: result.claim === null ? null : claimView(result.claim), advice: result.advice };
  });

  d.register('claim.unbind', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.unbind(req.claimId, req.evidenceKind, req.evidenceRef);
    if (!result.ok) throw notFound(result.reason ?? '这条证据不存在');
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'unbind',
      claimIds: [req.claimId],
      conversationId: null,
    });
    return { claim: claimView(ledger.repo.get(req.claimId) as ClaimRecord) };
  });

  d.register('claim.verify', async (req) => {
    const ledger = await claimsFor(req.projectId);
    /*
     * 界面发起的核验一律记成 `user:manual`。
     *
     * 不让前端传模型标识：那等于让它冒充任何模型，而这一列的用途正是判断结论的
     * 可信度（需求 13.4）。留空更糟——留空与「一个未知的模型说的」在库里长得一样。
     */
    const result = ledger.verify({
      claimId: req.claimId,
      kind: req.evidenceKind,
      ref: req.evidenceRef,
      verdict: req.verdict,
      modelId: 'user:manual',
      ...(req.note === undefined ? {} : { note: req.note }),
    });

    if (!result.ok || result.claim === null) {
      throw new DispatchError(makeError('bad_request', result.reason ?? '核验失败'));
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'verify',
      claimIds: [req.claimId],
      conversationId: result.claim.conversationId,
    });
    return { claim: claimView(result.claim) };
  });

  d.register('claim.confirm', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.confirm(req.claimId, req.note);
    if (!result.ok || result.claim === null) {
      throw notFound(result.reason ?? `断言不存在：${req.claimId}`);
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'confirm',
      claimIds: [req.claimId],
      conversationId: result.claim.conversationId,
    });
    return { claim: claimView(result.claim), reason: result.reason };
  });

  d.register('claim.close', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.close(req.claimId, req.status, req.note);
    if (!result.ok || result.claim === null) {
      throw new DispatchError(makeError('bad_request', result.reason ?? '关闭失败'));
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'close',
      claimIds: [req.claimId],
      conversationId: result.claim.conversationId,
    });
    return { claim: claimView(result.claim) };
  });

  d.register('claim.reopen', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const result = ledger.reopen(req.claimId, req.note ?? '');
    if (!result.ok || result.claim === null) {
      throw notFound(result.reason ?? `断言不存在：${req.claimId}`);
    }
    d.broadcast({
      kind: 'claims.changed',
      projectId: req.projectId,
      action: 'reopen',
      claimIds: [req.claimId],
      conversationId: result.claim.conversationId,
    });
    return { claim: claimView(result.claim) };
  });

  d.register('claim.delete', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const claim = ledger.repo.get(req.claimId);
    if (claim === null) throw notFound(`断言不存在：${req.claimId}`);
    const deleted = ledger.repo.delete(req.claimId);
    if (deleted) {
      d.broadcast({
        kind: 'claims.changed',
        projectId: req.projectId,
        action: 'delete',
        claimIds: [req.claimId],
        conversationId: claim.conversationId,
      });
    }
    return { deleted };
  });

  /* --- 引文核实（任务 13.5，需求 13.9）--- */

  const verifierFor = async (projectId: string): Promise<CitationVerifier> => {
    await orchestratorFor(projectId);
    const verifier = citationVerifiers.get(projectId);
    if (verifier !== undefined) return verifier;

    // buildOrchestrator 里的工厂是惰性的，界面先发起时它还没被调过。
    // 这里补建一次，依赖此时都已就绪
    const library = refLibraries.get(projectId);
    const ledger = claimLedgers.get(projectId);
    if (library === undefined || ledger === undefined) {
      throw notFound(`项目不可用：${projectId}`);
    }
    const created = new CitationVerifier({
      library,
      claims: ledger.repo,
      onLog: (line) => {
        log(`[citations ${projectId}] ${line}`);
      },
    });
    citationVerifiers.set(projectId, created);
    return created;
  };

  /** 把 referenceList / artifactVersionId / citations 合成待核实清单。 */
  const collectCitations = (
    projectId: string,
    req: { citations?: readonly string[]; referenceList?: string; artifactVersionId?: string },
  ): { targets: readonly string[]; notes: readonly string[] } => {
    const targets: string[] = [...(req.citations ?? [])];
    const notes: string[] = [];

    if (req.artifactVersionId !== undefined) {
      const artifacts = artifactStoreFor(projectId);
      const bytes = artifacts.readVersion(req.artifactVersionId);
      if (bytes === null) throw notFound(`制品版本不存在：${req.artifactVersionId}`);
      const parsed = parseReferenceList(bytes.toString('utf8'));
      targets.push(...parsed.map((p) => p.raw));
      notes.push(`从制品解析出 ${String(parsed.length)} 条`);
    }
    if (req.referenceList !== undefined) {
      const parsed = parseReferenceList(req.referenceList);
      targets.push(...parsed.map((p) => p.raw));
      notes.push(`从列表解析出 ${String(parsed.length)} 条`);
    }

    const unique = [...new Set(targets.map((t) => t.replace(/\s+/gu, ' ').trim()))].filter(
      (t) => t !== '',
    );
    return { targets: unique, notes };
  };

  d.register('citation.parse', async (req) => {
    // 只解析不检索：让用户先确认解析对不对，再决定要不要花几十次上游请求
    const { targets } = collectCitations(req.projectId, req);
    if (targets.length === 0) {
      throw new DispatchError(
        makeError('bad_request', '没有可解析的内容', {
          remediation: '传 referenceList 或 artifactVersionId。',
        }),
      );
    }
    return {
      citations: targets.map((raw) => {
        const parsed = parseCitation(raw);
        return {
          raw,
          shape: parsed.shape,
          searchable: parsed.searchable,
          doi: parsed.doi,
          pmid: parsed.pmid,
          firstAuthorSurname: parsed.firstAuthorSurname,
          year: parsed.year,
          title: parsed.title,
          container: parsed.container,
          reason: parsed.reason,
          summary: describeCitation(parsed),
        };
      }),
    };
  });

  d.register('citation.verify', async (req) => {
    const verifier = await verifierFor(req.projectId);
    const { targets, notes } = collectCitations(req.projectId, req);

    if (targets.length === 0) {
      throw new DispatchError(
        makeError('bad_request', '没有要核实的引文', {
          remediation: '传 citations、referenceList 或 artifactVersionId。',
        }),
      );
    }

    const outcome = await verifier.verifyMany(targets, {
      ...(req.claimId === undefined ? {} : { claimId: req.claimId }),
      // 界面发起的核实记成 user:manual。判定由后端做，这一列记的是发起者
      modelId: 'user:manual',
    });

    if (outcome.counts['not-found'] > 0 || outcome.counts['metadata-mismatch'] > 0) {
      d.broadcast({
        kind: 'citations.checked',
        projectId: req.projectId,
        conversationId: null,
        checked: outcome.results.length,
        notFound: outcome.counts['not-found'],
        mismatched: outcome.counts['metadata-mismatch'],
      });
    }

    return {
      notes,
      counts: outcome.counts,
      summary: renderVerifyResults(outcome.results, outcome.counts),
      results: outcome.results.map((r) => ({
        raw: r.raw,
        verdict: r.verdict,
        shape: r.parsed.shape,
        matchedRefId: r.matchedRefId,
        matchedDoi: r.matchedDoi,
        matchedCite: r.matchedCite,
        similarity: r.similarity,
        mismatches: r.mismatches,
        // 实际检索记录一并返回：需求 13.9 的可核查性靠它
        queries: r.queries,
        attempts: r.attempts,
        detail: r.detail,
        checkId: r.checkId,
      })),
    };
  });

  d.register('citation.checks', async (req) => {
    const ledger = await claimsFor(req.projectId);
    const checks = ledger.repo.citationChecks({
      ...(req.claimId === undefined ? {} : { claimId: req.claimId }),
      ...(req.verdict === undefined ? {} : { verdict: req.verdict }),
      limit: req.limit,
    });
    return {
      checks: checks.map((check) => ({
        ...check,
        // 「有没有真的查过」是这份记录的核心判据，提到平面上让 UI 不必去数数组
        retrievalBacked: check.queries.length > 0 && check.verdict !== 'unverifiable',
        summary: describeCheck(check),
      })),
      suspects: ledger.repo.fabricationSuspects(50).length,
    };
  });

  /* --- 手稿编译（任务 13.6，需求 13.5-13.8）--- */

  const compilerFor = async (projectId: string): Promise<ManuscriptCompiler> => {
    await orchestratorFor(projectId);
    const compiler = manuscriptCompilers.get(projectId);
    if (compiler === undefined) throw notFound(`项目不可用：${projectId}`);
    return compiler;
  };

  d.register('manuscript.profiles', async () => ({
    profiles: BUILTIN_JOURNAL_PROFILES,
    /*
     * 免责说明随档案一起返回。
     *
     * 界面上显示「摘要上限 150 词」而不说这个数字的来源，用户会按它删稿——
     * 而档案里的数值是内置的近似值，会随期刊改版过期。
     */
    disclaimer:
      '档案里的字数与条数是各刊作者指南的近似值，会随期刊改版而过期。' +
      '编译报告里的提示是「按该档案的上限」，不是对该刊当前规则的断言。改稿前请核对官方要求。',
  }));

  d.register('manuscript.list', async (req) => {
    const compiler = await compilerFor(req.projectId);
    return {
      manuscripts: compiler.repo
        .list({
          ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
          limit: req.limit,
        })
        .map((manuscript) => ({
          ...manuscript,
          latestRun: compiler.repo.compileRuns(manuscript.id, 1)[0] ?? null,
        })),
    };
  });

  d.register('manuscript.get', async (req) => {
    const compiler = await compilerFor(req.projectId);
    const manuscript = compiler.repo.get(req.manuscriptId);
    if (manuscript === null) throw notFound(`手稿不存在：${req.manuscriptId}`);
    return {
      manuscript,
      runs: compiler.repo.compileRuns(req.manuscriptId, 20),
      trend: compiler.repo.trend(req.manuscriptId, 20),
    };
  });

  d.register('manuscript.parse', async (req) => {
    const compiler = await compilerFor(req.projectId);
    const parsed = compiler.parse({
      ...(req.markdown === undefined ? {} : { markdown: req.markdown }),
      ...(req.sourceVersionId === undefined ? {} : { sourceVersionId: req.sourceVersionId }),
    });

    if (!parsed.ok || parsed.doc === null) {
      throw new DispatchError(
        makeError('bad_request', parsed.reason ?? '解析失败', {
          remediation:
            'front matter 只支持受限的 YAML 子集（标量、列表、嵌套映射、块标量），' +
            '不支持锚点、别名与流式映射 {}。',
        }),
      );
    }

    const doc = parsed.doc;
    return {
      meta: doc.meta,
      counts: doc.counts,
      hasFrontMatter: doc.hasFrontMatter,
      warnings: doc.warnings,
      sections: doc.sections.map((s) => ({
        title: s.title,
        level: s.level,
        line: s.line,
        words: s.words,
      })),
      figures: doc.figures,
      tables: doc.tables,
      citationCount: doc.citations.length,
    };
  });

  d.register('manuscript.compile', async (req) => {
    const compiler = await compilerFor(req.projectId);
    const outcome = await compiler.compile({
      ...(req.markdown === undefined ? {} : { markdown: req.markdown }),
      ...(req.sourceVersionId === undefined ? {} : { sourceVersionId: req.sourceVersionId }),
      ...(req.manuscriptId === undefined ? {} : { manuscriptId: req.manuscriptId }),
      ...(req.targetJournal === undefined ? {} : { targetJournal: req.targetJournal }),
      ...(req.customProfile === undefined ? {} : { customProfile: req.customProfile }),
      ...(req.blinded === undefined ? {} : { blinded: req.blinded }),
      both: req.both,
      ...(req.stem === undefined ? {} : { stem: req.stem }),
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      // 界面发起的编译记成 user:manual，与模型发起的区分开
      modelId: 'user:manual',
    });

    if (!outcome.ok || outcome.manuscript === null) {
      throw new DispatchError(makeError('bad_request', outcome.reason ?? '编译失败'));
    }

    const totalErrors = outcome.outputs.reduce(
      (sum, o) => sum + o.result.issues.filter((i) => i.severity === 'error').length,
      0,
    );

    d.broadcast({
      kind: 'manuscript.compiled',
      projectId: req.projectId,
      conversationId: req.conversationId ?? null,
      manuscriptId: outcome.manuscript.id,
      errors: totalErrors,
      warnings: outcome.outputs.reduce(
        (sum, o) => sum + o.result.issues.filter((i) => i.severity === 'warn').length,
        0,
      ),
      selfCitationLeaks: Math.max(
        0,
        ...outcome.outputs.map((o) => o.result.selfCitationLeaks.length),
      ),
    });

    return {
      manuscript: outcome.manuscript,
      outputs: outcome.outputs.map((output) => ({
        blinded: output.blinded,
        filename: output.filename,
        artifactId: output.artifactId,
        versionId: output.versionId,
        bibArtifactId: output.bibArtifactId,
        bibVersionId: output.bibVersionId,
        // 内容一并返回：界面要能直接预览，不必再读一次制品
        content: output.result.content,
        bibliography: output.result.bibliography,
        report: output.result.report,
        issues: output.result.issues,
        selfCitationLeaks: output.result.selfCitationLeaks,
        removedFields: output.result.removedFields,
        profileId: output.result.profile.id,
        profileMatched: output.result.profileMatched,
        counts: output.result.counts,
      })),
    };
  });

  d.register('manuscript.history', async (req) => {
    const compiler = await compilerFor(req.projectId);
    if (compiler.repo.get(req.manuscriptId) === null) {
      throw notFound(`手稿不存在：${req.manuscriptId}`);
    }
    return {
      runs: compiler.repo.compileRuns(req.manuscriptId, req.limit),
      trend: compiler.repo.trend(req.manuscriptId, req.limit),
    };
  });

  d.register('manuscript.delete', async (req) => {
    const compiler = await compilerFor(req.projectId);
    if (compiler.repo.get(req.manuscriptId) === null) {
      throw notFound(`手稿不存在：${req.manuscriptId}`);
    }
    return { deleted: compiler.repo.delete(req.manuscriptId) };
  });

  /* --- 引用导出（任务 13.3，需求 12.5）--- */

  d.register('ref.export', async (req) => {
    const library = await refsFor(req.projectId);
    const outcome = library.exportRefs({
      format: req.format,
      ...(req.refIds === undefined ? {} : { refIds: req.refIds }),
      ...(req.refIds !== undefined
        ? {}
        : {
            filter: {
              ...(req.query === undefined ? {} : { query: req.query }),
              ...(req.year === undefined ? {} : { year: req.year }),
              ...(req.type === undefined ? {} : { type: req.type }),
            },
          }),
      ...(req.stem === undefined ? {} : { stem: req.stem }),
      asciiOnly: req.asciiOnly,
      includeAbstract: req.includeAbstract,
      sort: req.sort,
    });

    if (!outcome.ok || outcome.result === null) {
      throw new DispatchError(
        makeError('conflict', outcome.reason ?? '导出失败', {
          remediation: '确认库里有符合条件的文献，或去掉筛选条件再试。',
        }),
      );
    }

    if (outcome.artifactId !== null) {
      d.broadcast({
        kind: 'refs.changed',
        projectId: req.projectId,
        action: 'export',
        refIds: [],
      });
    }

    return {
      filename: outcome.result.filename,
      mime: outcome.result.mime,
      entryCount: outcome.result.entryCount,
      keys: outcome.result.keys,
      // 内容一并返回：UI 要能直接预览与「另存为」，不必再去读一次制品
      content: outcome.result.content,
      warnings: outcome.result.warnings,
      warningText: renderExportWarnings(outcome.result.warnings),
      artifactId: outcome.artifactId,
      versionId: outcome.versionId,
      missingIds: outcome.missingIds,
    };
  });

  /* --- 算力目标与作业（任务 14.2，需求 14.3、14.4、14.6、14.7）--- */

  /**
   * 取算力服务。
   *
   * 经 `orchestratorFor` 而不是现建：门控要接到该项目的审批服务上，现建的实例没有
   * 这个依赖，于是「界面上提交作业不用批准、模型提交作业要批准」——同一个动作两套规则。
   */
  const computeFor = async (projectId: string): Promise<ComputeService> => {
    await orchestratorFor(projectId);
    const service = computeServices.get(projectId);
    if (service === undefined) throw notFound(`项目不可用：${projectId}`);
    return service;
  };

  /** 目标的 IPC 视图。指纹从列上取（那是权威值），不从 config_json 里翻。 */
  const targetView = (target: ReturnType<ComputeTargetsRepo['get']>): Record<string, unknown> => {
    if (target === null) return {};
    return {
      id: target.id,
      name: target.name,
      family: target.family,
      config: target.config,
      notesMd: target.notesMd,
      credentialRef: target.credentialRef,
      enabled: target.enabled,
      disabledReason: target.disabledReason,
      hostKeyFingerprint: target.hostKeyFingerprint,
      lastProbe: target.lastProbe,
      lastProbeAt: target.lastProbeAt,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
      // 需求 14.3：ssh 目标在公钥未确认前不能用。提到平面上让 UI 不必去猜
      needsHostKeyConfirmation: target.family === 'ssh' && target.hostKeyFingerprint === null,
    };
  };

  d.register('compute.targets', async (req) => ({
    targets: computeTargets.list({ includeDisabled: req.includeDisabled }).map(targetView),
    // 需求 14.6 的「无需重启即可发现」：UI 拿这个版本号做廉价轮询
    revision: computeTargets.revision(),
    grantScopes: {
      read: grantScopeOptions('read'),
      write: grantScopeOptions('write'),
      job: grantScopeOptions('job'),
      credential: grantScopeOptions('credential'),
    },
  }));

  d.register('compute.target', async (req) => {
    const target = computeTargets.get(req.targetId);
    if (target === null) throw notFound(`算力目标不存在：${req.targetId}`);
    return {
      target: targetView(target),
      grants: computeGrants.list({ targetId: req.targetId }),
    };
  });

  d.register('compute.localCapabilities', async () => {
    const [ssh, local] = await Promise.all([detectSshClient(), suggestLocalTarget()]);
    return {
      ssh,
      // 缺客户端时给出可以直接照做的步骤，而不是等第一次连接报 ENOENT ssh
      sshRemediation: ssh.available ? null : sshClientRemediation(),
      gpus: local.gpus,
      gpuDetail: local.detail,
      suggestedLocalConfig: local.config,
    };
  });

  d.register('compute.register', async (req) => {
    const service = await computeFor(req.projectId);
    const config = req.config as unknown as ComputeTargetConfig;

    const validation = validateComputeConfig(config);
    if (!validation.ok) {
      throw new DispatchError(
        makeError('bad_request', validation.reason, {
          remediation: '按上面的说明改配置后重试。',
        }),
      );
    }

    const result = await service.register({
      name: req.name,
      config,
      ...(req.notesMd === undefined ? {} : { notesMd: req.notesMd }),
      ...(req.credentialRef === undefined ? {} : { credentialRef: req.credentialRef }),
      conversationId: req.conversationId ?? null,
    });

    if (!result.ok || result.target === null) {
      throw new DispatchError(
        makeError('conflict', result.reason ?? '登记失败', {
          remediation: 'ssh 目标登记成功后还要确认主机公钥才能连接——那一步在目标详情里。',
        }),
      );
    }

    return { target: targetView(result.target), probe: result.probe };
  });

  d.register('compute.update', async (req) => {
    const existing = computeTargets.get(req.targetId);
    if (existing === null) throw notFound(`算力目标不存在：${req.targetId}`);

    if (req.config !== undefined) {
      const validation = validateComputeConfig(req.config as unknown as ComputeTargetConfig);
      if (!validation.ok) {
        throw new DispatchError(makeError('bad_request', validation.reason));
      }
    }

    let updated;
    try {
      updated = computeTargets.update(req.targetId, {
        ...(req.name === undefined ? {} : { name: req.name }),
        ...(req.config === undefined
          ? {}
          : { config: req.config as unknown as ComputeTargetConfig }),
        ...(req.notesMd === undefined ? {} : { notesMd: req.notesMd }),
        ...(req.credentialRef === undefined ? {} : { credentialRef: req.credentialRef }),
      });
    } catch (err) {
      throw new DispatchError(
        makeError('conflict', err instanceof Error ? err.message : String(err)),
      );
    }
    if (updated === null) throw notFound(`算力目标不存在：${req.targetId}`);

    d.broadcast({
      kind: 'compute.targets',
      projectId: null,
      action: 'update',
      targetId: req.targetId,
    });
    return { target: targetView(updated) };
  });

  d.register('compute.setEnabled', async (req) => {
    if (computeTargets.get(req.targetId) === null) {
      throw notFound(`算力目标不存在：${req.targetId}`);
    }
    if (!req.enabled && (req.reason ?? '').trim() === '') {
      throw new DispatchError(
        makeError('bad_request', '停用算力目标必须说明原因', {
          remediation:
            '一个灰掉的目标而没有原因，用户唯一能做的是把它重新打开试试——' +
            '而那可能正是探测判定它不可用的原因。',
        }),
      );
    }

    const changed = computeTargets.setEnabled(req.targetId, req.enabled, req.reason ?? null);
    /*
     * 停用时同时撤销它的授权。
     *
     * 不撤的话，用户「关掉」这台机器之后那些 always 级授权还在库里；他日后重新启用时
     * 会发现命令直接放行——而他记得的是自己关掉过它。
     */
    const revoked = req.enabled ? 0 : computeGrants.revokeForTarget(req.targetId);

    d.broadcast({
      kind: 'compute.targets',
      projectId: null,
      action: 'update',
      targetId: req.targetId,
    });
    return { changed, revokedGrants: revoked };
  });

  d.register('compute.remove', async (req) => {
    const service = await computeFor(req.projectId);
    const result = service.remove(req.targetId);
    if (!result.ok) {
      throw new DispatchError(
        makeError('conflict', result.reason ?? '删除失败', {
          remediation: '先取消或等待未结束的作业。',
        }),
      );
    }
    return { deleted: true, revokedGrants: result.revokedGrants };
  });

  d.register('compute.probe', async (req) => {
    const service = await computeFor(req.projectId);
    const report = await service.probe(req.targetId);
    if (report === null) throw notFound(`算力目标不存在：${req.targetId}`);
    return { probe: report };
  });

  d.register('compute.ping', async (req) => {
    const service = await computeFor(req.projectId);
    return service.ping(req.targetId);
  });

  d.register('compute.scanHostKey', async (req) => {
    const target = computeTargets.get(req.targetId);
    if (target === null) throw notFound(`算力目标不存在：${req.targetId}`);
    if (target.config.family !== 'ssh') {
      throw new DispatchError(makeError('bad_request', '只有 ssh 目标有主机公钥'));
    }

    const scan = await scanHostKey(target.config);
    return {
      ...scan,
      current: target.hostKeyFingerprint,
      /*
       * 指纹变了要显式标出来。
       *
       * 「取到了一个指纹」与「取到的指纹和上次不一样」在界面上必须长得不一样：
       * 后者要么是主机重装了系统，要么是中间人，而这两者只能由人分辨。
       */
      changed:
        target.hostKeyFingerprint !== null &&
        scan.fingerprint !== null &&
        target.hostKeyFingerprint !== scan.fingerprint,
    };
  });

  d.register('compute.confirmHostKey', async (req) => {
    const service = await computeFor(req.projectId);
    const result = await service.confirmHostKey({
      targetId: req.targetId,
      conversationId: req.conversationId ?? null,
      ...(req.expectedFingerprint === undefined
        ? {}
        : { expectedFingerprint: req.expectedFingerprint }),
    });
    if (!result.ok) {
      throw new DispatchError(
        makeError('conflict', result.reason ?? '确认失败', {
          remediation:
            '指纹必须由人去和管理员公布的值核对。「再连一次看看」核实不了任何东西——' +
            '中间人每次都会给出同一个（它自己的）指纹。',
        }),
      );
    }
    return {
      fingerprint: result.fingerprint,
      target: targetView(computeTargets.get(req.targetId)),
    };
  });

  /* --- 环境笔记（任务 14.3，需求 14.5）--- */

  d.register('compute.notes', async (req) => {
    const service = await computeFor(req.projectId);
    if (computeTargets.get(req.targetId) === null) {
      throw notFound(`算力目标不存在：${req.targetId}`);
    }
    const notes = service.notes(req.targetId);
    return {
      ...notes,
      rendered: service.renderNotes(req.targetId),
      /*
       * 把两组的规则差异说出来。
       *
       * 界面上是两个输入框，而它们一个会被拒一个不会——不说明的话用户会以为是 bug。
       */
      note:
        '「登记说明」是你自己写的，平台不做检查，也不注入模型的系统提示词。\n' +
        '「环境笔记」逐条累积，会在本会话用到这台机器时注入系统提示词，因此过准入规则：' +
        '只收这台机器自身的知识，项目内容与分析结果会被拒。它跨项目共享。',
    };
  });

  d.register('compute.setDescription', async (req) => {
    const service = await computeFor(req.projectId);
    if (!service.setDescription(req.targetId, req.description)) {
      throw notFound(`算力目标不存在：${req.targetId}`);
    }
    d.broadcast({
      kind: 'compute.targets',
      projectId: req.projectId,
      action: 'update',
      targetId: req.targetId,
    });
    return { saved: true };
  });

  d.register('compute.addNote', async (req) => {
    const service = await computeFor(req.projectId);
    if (computeTargets.get(req.targetId) === null) {
      throw notFound(`算力目标不存在：${req.targetId}`);
    }

    const result = service.addNote({
      targetId: req.targetId,
      content: req.content,
      reason: req.reason,
      ...(req.replaceId === undefined ? {} : { replaceId: req.replaceId }),
    });
    if (!result.ok) {
      /*
       * 拒绝理由原样透出，不压成「保存失败」。
       *
       * 那段理由里带的是「该改写成什么」——压掉之后用户只能猜，而猜的结果通常是
       * 放弃使用这个功能。
       */
      throw new DispatchError(
        makeError('bad_request', result.reason, {
          ...(result.rule === null ? {} : { detail: `规则：${result.rule}` }),
          remediation: '按上面的说明改写内容，或者把这条改成项目作用域的记忆。',
        }),
      );
    }

    d.broadcast({
      kind: 'compute.targets',
      projectId: req.projectId,
      action: 'update',
      targetId: req.targetId,
    });
    return { note: result.note, created: result.created, deduped: result.deduped };
  });

  d.register('compute.deleteNote', async (req) => {
    const service = await computeFor(req.projectId);
    if (!service.deleteNote(req.noteId)) throw notFound(`环境笔记不存在：${req.noteId}`);
    return { deleted: true };
  });

  /* --- 作业 --- */

  d.register('compute.jobs', async (req) => {
    const service = await computeFor(req.projectId);
    const jobs = service.jobs.list({
      ...(req.targetId === undefined ? {} : { targetId: req.targetId }),
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      state: req.state as JobState | 'active' | 'all',
      limit: req.limit,
    });

    return {
      jobs: jobs.map((job) => ({
        ...job,
        targetName: computeTargets.get(job.targetId)?.name ?? null,
        terminal: isTerminalJobState(job.state),
      })),
      summary: service.jobs.summary(
        req.conversationId === undefined ? {} : { conversationId: req.conversationId },
      ),
    };
  });

  d.register('compute.job', async (req) => {
    const service = await computeFor(req.projectId);
    if (service.jobs.get(req.jobId) === null) throw notFound(`作业不存在：${req.jobId}`);

    // 主动问一次：用户点开详情时想知道的是现在的状态，不是上次轮询时的
    await service.pollOnce(req.jobId);
    const job = service.jobs.get(req.jobId);
    if (job === null) throw notFound(`作业不存在：${req.jobId}`);

    return {
      job: {
        ...job,
        targetName: computeTargets.get(job.targetId)?.name ?? null,
        terminal: isTerminalJobState(job.state),
      },
      summary: service.renderJob(job),
    };
  });

  d.register('compute.jobOutputs', async (req) => {
    const service = await computeFor(req.projectId);
    if (service.jobs.get(req.jobId) === null) throw notFound(`作业不存在：${req.jobId}`);
    const outputs = await service.collectOutputs(req.jobId, {
      ...(req.tailLines === undefined ? {} : { tailLines: req.tailLines }),
    });
    return outputs;
  });

  d.register('compute.cancelJob', async (req) => {
    const service = await computeFor(req.projectId);
    const result = await service.cancelJob(req.jobId);
    if (!result.ok) {
      throw new DispatchError(makeError('conflict', result.reason ?? '取消失败'));
    }
    d.broadcast({
      kind: 'compute.jobs',
      projectId: req.projectId,
      action: 'cancel',
      jobId: req.jobId,
    });
    return { cancelled: true };
  });

  d.register('compute.commands', async (req) => {
    const service = await computeFor(req.projectId);
    const commands = service.jobs.commands({
      ...(req.targetId === undefined ? {} : { targetId: req.targetId }),
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      limit: req.limit,
    });
    return {
      commands: commands.map((c) => ({
        ...c,
        targetName: computeTargets.get(c.targetId)?.name ?? null,
        riskLabel: RISK_LABEL[c.risk as keyof typeof RISK_LABEL] ?? c.risk,
      })),
    };
  });

  /* --- 算力授权 --- */

  d.register('compute.grants', async (req) => ({
    grants: computeGrants
      .list({
        ...(req.targetId === undefined ? {} : { targetId: req.targetId }),
        includeRevoked: req.includeRevoked,
      })
      .map((grant) => ({
        ...grant,
        targetName: computeTargets.get(grant.targetId)?.name ?? null,
      })),
    /*
     * 把「破坏性命令不受持久授权约束」这件事随授权列表一起说明。
     *
     * 用户在这个页面上看到一条 always 级的读授权时，最自然的疑问是「那 rm -rf 呢」。
     * 答案不在任何一条记录里，因此必须由这个字段说出来。
     */
    note:
      '破坏性命令（rm -r、scancel、sudo、kill -9 这类）不受这些授权约束——' +
      '它们每次都会单独询问。这是「不被 ls 烦到」与「rm -rf 要经过我」能同时成立的办法。',
  }));

  d.register('compute.revokeGrant', async (req) => {
    if (!computeGrants.revoke(req.grantId)) {
      throw notFound(`算力授权不存在或已撤销：${req.grantId}`);
    }
    return { revoked: true };
  });

  /* --- 环境与包管理（任务 14.4，需求 15.1-15.7）--- */

  const envsFor = async (projectId: string): Promise<EnvService> => {
    await orchestratorFor(projectId);
    const service = envServices.get(projectId);
    if (service === undefined) throw notFound(`项目不可用：${projectId}`);
    return service;
  };

  /** 环境的 IPC 视图。把包统计与「跑着几个内核」提到平面上。 */
  const envView = (service: EnvService, env: EnvRecord): Record<string, unknown> => ({
    ...env,
    packageStats: envsRepo.packageStats(env.id),
    /*
     * 「能不能删目录」由后端算，不让 UI 按 mode 自己推。
     *
     * 推错的方向很具体：把用户自己的环境显示成可删，他点了「删除」，以为删的是一条
     * 登记记录。
     */
    canDeleteFiles: env.mode === 'managed',
    isManagedByPlatform: env.mode === 'managed',
    // 「这个环境有几个内核在跑」是删除与切换默认之前必须看到的信息
    liveKernels: service.liveKernels(env.id),
  });

  d.register('env.list', async (req) => {
    const service = await envsFor(req.projectId);
    const [installers] = await Promise.all([service.installers()]);
    return {
      envs: service
        .list(req.language === undefined ? {} : { language: req.language as EnvLanguage })
        .map((env) => envView(service, env)),
      installers,
      // 需求 15.7 做成可查而不是只在文档里声明：这条约束一旦被破坏不会以报错的形式出现
      separation: service.separationCheck(),
      condaAvailable: condaAvailable(),
      rendered: service.render(),
    };
  });

  d.register('env.get', async (req) => {
    const service = await envsFor(req.projectId);
    const env = service.repo.get(req.envId);
    if (env === null) throw notFound(`环境不存在：${req.envId}`);
    return {
      env: envView(service, env),
      mixups: service.mixups(req.envId),
      packages: service.packages(req.envId, { limit: 200 }),
    };
  });

  d.register('env.sync', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.sync();
    return { ...result, envs: service.list().map((env) => envView(service, env)) };
  });

  d.register('env.probe', async (req) => {
    const service = await envsFor(req.projectId);
    const env = await service.probe(req.envId);
    if (env === null) throw notFound(`环境不存在：${req.envId}`);
    return { env: envView(service, env) };
  });

  d.register('env.create', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.create({
      name: req.name,
      language: req.language as EnvLanguage,
      ...(req.pythonVersion === undefined ? {} : { pythonVersion: req.pythonVersion }),
      ...(req.rVersion === undefined ? {} : { rVersion: req.rVersion }),
      ...(req.packages === undefined ? {} : { packages: req.packages }),
      ...(req.channel === undefined ? {} : { channel: req.channel }),
      ...(req.notes === undefined ? {} : { notes: req.notes }),
      conversationId: req.conversationId,
    });

    if (!result.ok || result.env === null) {
      throw new DispatchError(
        makeError('bad_request', result.reason ?? '创建失败', {
          remediation: '按上面的说明改参数后重试。',
        }),
      );
    }
    return {
      env: envView(service, result.env),
      // 需求 15.6：创建是后台任务，结果会通过后台通知回到会话里
      taskId: result.taskId,
      note:
        '创建带编译依赖的环境要几分钟。这是后台任务，不受会话中断影响；' +
        '完成后会有一条通知，届时环境状态会变成「可用」。',
    };
  });

  d.register('env.register', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.register({
      name: req.name,
      path: req.path,
      ...(req.language === undefined ? {} : { language: req.language as EnvLanguage }),
      ...(req.notes === undefined ? {} : { notes: req.notes }),
      setDefault: req.setDefault,
    });
    if (!result.ok || result.env === null) {
      throw new DispatchError(makeError('bad_request', result.reason ?? '登记失败'));
    }
    return {
      env: envView(service, result.env),
      note:
        '内核会**直接从这个环境启动**（需求 15.2），因此 pip install -e 装的可编辑包与' +
        '你直接改的源码都会立刻生效。平台不会复制这个环境的任何内容。' +
        (result.env.status === 'ready'
          ? ''
          : '\n注意：这个环境当前缺 ipykernel，起不了内核。' +
            '登记已完成，装上 ipykernel 之后重新探测即可。'),
    };
  });

  d.register('env.remove', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.remove(req.envId, { deleteFiles: req.deleteFiles });
    if (!result.ok) {
      throw new DispatchError(
        makeError('conflict', result.reason ?? '删除失败', {
          remediation:
            '用户自己的环境只能取消登记（deleteFiles=false）；' +
            '还有内核在跑的环境要先关掉那些会话的内核。',
        }),
      );
    }
    return { deleted: true, deletedFiles: result.deletedFiles };
  });

  d.register('env.setDefault', async (req) => {
    const service = await envsFor(req.projectId);
    const result = service.setDefault(req.envId);
    if (!result.ok) {
      throw new DispatchError(makeError('conflict', result.reason ?? '设置失败'));
    }
    return {
      ok: true,
      env: envView(service, service.repo.get(req.envId) as EnvRecord),
      /*
       * 切换默认**不会**动已有内核，这一点必须说出来。
       *
       * 不说的话用户会以为切换立刻全局生效，然后在一个仍然跑在旧环境上的内核里
       * 找不到刚装的包——而那看起来像是安装失败。
       */
      note:
        '新起的内核会用这个环境。**已经在跑的内核不受影响**——它们仍在原来的环境上，' +
        '因为强行重启会清掉你的变量。' +
        (result.liveOnOthers.length === 0
          ? ''
          : `\n当前有 ${String(result.liveOnOthers.length)} 个内核跑在其它环境上。` +
            '需要它们也切过来的话，用 env.restartKernels 或在会话里重启内核。'),
      liveOnOthers: result.liveOnOthers,
    };
  });

  d.register('env.clearDefault', async (req) => {
    const service = await envsFor(req.projectId);
    return {
      cleared: service.repo.clearDefault(req.language as EnvLanguage),
      note: '新内核会回到平台探测到的托管环境。',
    };
  });

  d.register('env.packages', async (req) => {
    const service = await envsFor(req.projectId);
    if (service.repo.get(req.envId) === null) throw notFound(`环境不存在：${req.envId}`);
    return service.packages(req.envId, {
      ...(req.source === undefined ? {} : { source: req.source as PackageSource }),
      ...(req.query === undefined ? {} : { query: req.query }),
      limit: req.limit,
    });
  });

  d.register('env.plan', async (req) => {
    const service = await envsFor(req.projectId);
    const plan = await service.plan({
      envId: req.envId,
      request: {
        specs: req.specs,
        ...(req.family === undefined ? {} : { family: req.family as InstallerFamily }),
        ...(req.channel === undefined ? {} : { channel: req.channel }),
      },
      uninstall: req.uninstall,
    });
    /*
     * 计划**不抛错**，哪怕它不 ok。
     *
     * 这个方法的全部意义是让 UI 在动手之前看到问题，而抛错会让「有冲突」与「参数写错」
     * 在前端走同一条 catch 分支，于是冲突详情显示不出来。
     */
    return {
      plan,
      restartNotice: restartNotice({
        required: plan.restartRequired,
        why: plan.restartRequired
          ? '装完之后内核里的模块缓存不会自动失效。'
          : '这个环境当前没有活着的内核。',
      }),
    };
  });

  d.register('env.install', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.install({
      envId: req.envId,
      request: {
        specs: req.specs,
        ...(req.family === undefined ? {} : { family: req.family as InstallerFamily }),
        ...(req.channel === undefined ? {} : { channel: req.channel }),
      },
      uninstall: req.uninstall,
      conversationId: req.conversationId,
      force: req.force,
      // 界面发起的记成 user:manual，与模型发起的在审批卡片上区分开
      modelId: 'user:manual',
    });

    /*
     * 审批被拒与参数错误分开报（需求 17.3）。
     *
     * 混在一起会让前端把「用户拒绝了」也显示成「参数有问题」，于是他看到一条建议他
     * 改参数的提示——而他刚刚做的正是拒绝。
     */
    if (!result.ok && result.approval.source === 'denied') {
      throw new DispatchError(
        makeError('policy_denied', result.reason ?? '未获批准', {
          remediation: result.approval.retryable
            ? '超时或取消导致，可以稍后重新发起。'
            : '这是明确的拒绝，不要重发同一请求。改主意可以在审批历史里撤销这条拒绝记忆。',
        }),
      );
    }

    if (!result.ok) {
      throw new DispatchError(
        makeError(
          result.plan.conflicts.length > 0 ? 'conflict' : 'bad_request',
          result.reason ?? '失败',
          {
            ...(result.plan.conflicts.length === 0
              ? {}
              : {
                  detail: JSON.stringify(result.plan.conflicts),
                  remediation:
                    '三种办法：改用已装的那个来源、把整组换成同一来源、或者新建一个干净的环境。' +
                    '强行继续（force）会造出一个「能导入但数值可能是错的」环境，而那种问题不报错。',
                }),
          },
        ),
      );
    }

    return {
      taskId: result.taskId,
      plan: result.plan,
      note: restartNotice({
        required: result.plan.restartRequired,
        why: result.plan.restartRequired
          ? '装完之后内核里的模块缓存不会自动失效。'
          : '这个环境当前没有活着的内核。',
      }),
    };
  });

  d.register('env.restartKernels', async (req) => {
    const service = await envsFor(req.projectId);
    const result = await service.restart(req.envId);
    if (!result.ok) {
      throw new DispatchError(makeError('conflict', result.reason ?? '重启失败'));
    }
    return {
      restarted: result.restarted,
      note: '内存里的变量与已导入的模块已经清掉；工作区文件与已保存的制品不受影响。',
    };
  });

  d.register('env.mixups', async (req) => {
    const service = await envsFor(req.projectId);
    if (service.repo.get(req.envId) === null) throw notFound(`环境不存在：${req.envId}`);
    return service.mixups(req.envId);
  });

  d.register('env.installers', async (req) => {
    if (req.refresh) resetInstallerCache();
    const all = await detectInstallers();
    const service = envServices.values().next().value;
    return {
      installers: all,
      chosen: service === undefined ? null : (await service.installers()).chosen,
    };
  });

  d.register('env.discover', async () => {
    const [conda] = await Promise.all([listCondaEnvironments()]);
    return {
      conda: conda.map((info) => ({
        ...info,
        registered: envsRepo.getByPath(info.prefix) !== null,
      })),
      venvHints: commonVenvLocations(),
      condaAvailable: condaAvailable(),
      note:
        '登记你自己的 venv 时，给环境根目录（含 pyvenv.cfg 的那一层）或者解释器本身都可以。' +
        '平台不会复制它的内容——内核直接从那里启动，因此可编辑安装与源码改动都立刻生效。',
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
          ...(req.expiresInMs === undefined ? {} : { expiresInMs: req.expiresInMs }),
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

  /**
   * 待决议的审批（需求 17.1）。
   *
   * 不限项目时汇总全部：审批卡片是全局的用户交互，而「这条审批属于哪个项目」对
   * 「现在要不要点同意」没有影响。给了 projectId 就只看那一个——设置页按项目查审计时用。
   */
  d.register('approval.pending', async (req) => {
    const services =
      req.projectId === undefined
        ? [...approvalsByProject.entries()]
        : [[req.projectId, approvalFor(req.projectId)] as const];

    return {
      pending: services.flatMap(([projectId, service]) =>
        service.pending().map((entry) => ({ ...entry, projectId })),
      ),
    };
  });

  d.register('approval.history', async (req) => {
    const service = approvalFor(req.projectId);
    const rows = service.history({
      ...(req.conversationId === undefined ? {} : { conversationId: req.conversationId }),
      ...(req.state === undefined ? {} : { state: req.state }),
      limit: req.limit,
    });

    return {
      approvals: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        kind: row.kind,
        state: row.state,
        note: row.note,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        /*
         * 把当时给用户看的内容原样带出来。
         *
         * 审计的价值在于「当时他看到的是什么」——只记 kind 与 state 的话，事后无法判断
         * 那次同意是基于一份完整的说明还是一句含糊的提示。
         */
        title: row.request.title,
        detail: row.request.detail,
        impact: row.request.impact,
        reversible: row.request.reversible,
        payload: row.request.payload,
        /*
         * 数据库里的 denied 行是历史，拒绝记忆是进程内的、决定「现在还会不会被自动
         * 拒绝」的那份。两者在界面上必须分开——用户看到一条三天前的拒绝记录时，
         * 他想知道的是「现在还挡着吗」。
         */
        stillDenied: row.stillDenied,
      })),
      note:
        '「仍在拦截」表示这条拒绝还在本次运行的拒绝记忆里，同一请求会被自动拒绝而不再询问。' +
        '拒绝记忆不跨进程重启保留——它要解决的是「agent 在一个循环里反复问同一件事」，' +
        '而那个问题只存在于进程生命周期内。',
    };
  });

  d.register('approval.forgetDenial', async (req) => {
    for (const service of approvalsByProject.values()) {
      if (service.forgetDenialById(req.approvalId)) return { forgotten: true };
    }
    throw notFound(
      `没有找到可撤销的拒绝记录：${req.approvalId}`,
      '这条记录可能不是被拒绝的，或者它的拒绝记忆已经因为后端重启而消失（那种情况下同一请求已经可以重新发起）。',
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

    /*
     * 算力服务只收轮询定时器，**不动远端作业**。
     *
     * 这是刻意的：作业在集群上跑，平台退出与它无关。退出时顺手取消远端作业会让
     * 「关一下窗口」变成「几小时的计算白跑了」。下次启动 `resume()` 会把跟踪接上。
     */
    for (const service of computeServices.values()) service.close();

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
