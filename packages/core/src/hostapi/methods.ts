/**
 * 控制面方法实现（任务 12.7，需求 10.8）。
 *
 * 只暴露**有真实后端**的表面。还没落地的（M5 的 `compute`）列进 pending，访问它们
 * 会抛出带说明的错误而不是返回空——空壳会让模型以为「查了但没有」，然后基于一个
 * 不存在的事实继续推理。
 *
 * 所有返回值都是普通 JSON 结构，Python 侧拿到就是 dict/list，可以直接进 pandas。
 */

import type { ArtifactStore } from '../artifact/store.js';
import type { Db } from '../db.js';
import type { SubAgentRunner, SubAgentSpec } from '../orchestrator/subagent.js';
import type { PlanRepo } from '../repo/plans.js';
import type { FindingsRepo } from '../repo/findings.js';
import type { RegistryRepo } from '../repo/registry.js';
import type { SkillAuditRepo } from '../repo/skills.js';
import type { UsageRepo } from '../repo/usage.js';
import type { SkillManager } from '../skills/manager.js';
import type { McpManager } from '../mcp/manager.js';
import type { RefLibrary } from '../refs/library.js';
import type { ClaimEvidenceKind, ClaimVerdict } from '../repo/claims.js';
import type { ClaimLedger } from '../manuscript/ledger.js';
import type { CitationVerifier } from '../manuscript/verify.js';
import type { ManuscriptCompiler } from '../manuscript/compile-service.js';
import type { ComputeService } from '../compute/service.js';
import { describeTarget } from '../compute/gate.js';
import { isTerminalJobState, JOB_STATE_LABEL } from '../compute/types.js';
import { citeLine } from '../refs/csl.js';
import { describeCitation, parseCitation, parseReferenceList } from '../manuscript/citations.js';
import { renderVerifyResults } from '../manuscript/verify.js';
import { BUILTIN_JOURNAL_PROFILES, describeProfile } from '../manuscript/journals.js';
import { BLINDING_DISCLAIMER, compileSummary } from '../manuscript/compile.js';
import type { HostCallContext, HostRpcServer } from './server.js';
import type { ShimPending, ShimSurface } from './shim.js';

export interface HostMethodDeps {
  projectId: string;
  db: Db;
  artifacts: ArtifactStore;
  plans: PlanRepo;
  findings: FindingsRepo;
  skills: SkillManager;
  skillAudit: SkillAuditRepo;
  usage: UsageRepo;
  registry: RegistryRepo;
  subAgents: SubAgentRunner;
  /**
   * MCP 连接器（需求 14.2）。
   *
   * 只在这里出现，**不注册任何 `mcp_*` 工具**——需求 14.2 规定 Python 与 R 内核不得具备
   * MCP 通道，而注册一个工具进 ToolRegistry 就等于把通道给了普通内核。控制面 token 只注入
   * 控制面池，因此「MCP 只能从控制面调」这件事由池边界保证，不靠条件判断。
   */
  mcp?: McpManager;

  /*
   * M4 的三层（任务 13.1-13.6）都用**惰性取**而不是直接持有实例。
   *
   * 原因是接线顺序：控制面在会话初始化的早期就要注册好（内核池、shim、RPC 都依赖
   * 它的表面清单），而文献库要接审批服务与域名授权、Claim Ledger 要接制品库与文献库、
   * 手稿编译器要接前两者——它们都在更后面才建得起来。反过来把它们全提前，要连带
   * 挪动审批与授权那几段接线，改动面大得多。
   *
   * 这些回调只在模型真的调用对应方法时才执行，那时三层一定已经就绪。
   */

  /** 文献库（任务 13.1-13.3）。 */
  refs?: () => RefLibrary;
  /** 断言台账（任务 13.4）。 */
  claims?: () => ClaimLedger;
  /** 引文核实器（任务 13.5）。 */
  citations?: () => CitationVerifier;
  /** 手稿编译器（任务 13.6）。 */
  manuscripts?: () => ManuscriptCompiler;
  /** 算力服务（任务 14.2）。同样惰性——它要接审批服务与制品库。 */
  compute?: () => ComputeService;
}

/* ------------------------------------------------------------------ *
 * 参数取值
 * ------------------------------------------------------------------ */

function reqStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optStr(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optInt(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** 可选整数。与 `optInt` 的区别是没有默认值——「没传」要能与「传了 0」区分。 */
function optIntOpt(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function optBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === 'boolean' ? value : undefined;
}

function strList(params: Record<string, unknown>, key: string): readonly string[] {
  const value = params[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是数组`);
  return value.map((v) => String(v));
}

/**
 * 本次调用归属哪个会话。
 *
 * 优先取显式传入的，其次取调用上下文里的。两者都没有时**抛错而不是猜**：
 * 归属错的子 agent 会挂在别的会话下、归属错的 findings 会记到别的会话里，
 * 而这两件事都不会有任何报错，事后只能看到「东西不见了」。
 */
function conv(
  params: Record<string, unknown>,
  ctx: HostCallContext,
  key = 'conversationId',
): string {
  const explicit = optStr(params, key);
  if (explicit !== undefined) return explicit;
  if (ctx.conversationId !== null) return ctx.conversationId;
  throw new Error(
    '这次调用没有会话上下文。控制面 REPL 会自动带上当前会话，' +
      `直接从别处调用时请显式传 ${key}。`,
  );
}

/* ------------------------------------------------------------------ *
 * 只读 SQL 查询
 * ------------------------------------------------------------------ */

/**
 * 只允许单条 SELECT / WITH。
 *
 * 控制面 REPL 是特权面，但**写库仍然要走仓储**：仓储里有事务边界、外键顺序、
 * 血缘约束这些踩出来的东西，绕过它们直接 UPDATE 会造出仓储代码认为不可能的状态
 * （比如 refcount 与版本行脱节）。查询开放、写入收口，是这里唯一站得住的划法。
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, '');

  if (trimmed === '') throw new Error('SQL 为空');
  if (trimmed.includes(';')) {
    // 多语句是最常见的绕过手段：一条 SELECT 后面跟一条 UPDATE
    throw new Error('只允许单条语句，不要用分号拼接');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error(
      '只允许 SELECT / WITH 查询。写入请走对应的 host 方法或工具——' +
        '仓储里有事务边界与血缘约束，直接改表会造出它们认为不可能的状态。',
    );
  }
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum)\b/i.test(trimmed)) {
    throw new Error('查询里出现了写操作关键字，已拒绝');
  }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export interface RegisteredHost {
  surfaces: readonly ShimSurface[];
  pending: readonly ShimPending[];
}

/**
 * 尚未实现的表面。列在这里，访问时给出明确原因。
 *
 * 现在是空的——M4 与 M5 的表面都落地了。这个常量刻意留着而不是删掉：它是「未实现的
 * 表面必须抛带说明的错误、不能给空壳」这条约定的落点，删掉之后下一个加表面的人
 * 会先做一个返回空数组的占位。
 */
const PENDING: readonly ShimPending[] = [];

/**
 * 惰性依赖缺席时的说法。
 *
 * 与「尚未落地」分开：这几层已经做完了，缺席只可能是本次运行没给它们接上依赖
 * （比如一个只跑控制面的测试装置）。说成「尚未落地」会让用户去等一个已经存在的东西。
 */
const ABSENT: Readonly<Record<'refs' | 'claims' | 'manuscripts' | 'compute', string>> = {
  refs: '本次运行没有可用的文献库（项目未完成初始化）',
  claims: '本次运行没有可用的断言台账（项目未完成初始化）',
  manuscripts: '本次运行没有可用的手稿编译器（项目未完成初始化）',
  compute: '本次运行没有可用的算力服务（项目未完成初始化）',
};

/**
 * 把控制面方法注册到 RPC 服务上，并返回 shim 需要的表面描述。
 *
 * 表面描述与注册在同一处产出：分开写迟早会出现「shim 里有这个方法但服务端没注册」
 * ——那时 Python 侧的报错是 404，而 404 看起来像方法名写错了。
 */
export function registerHostMethods(server: HostRpcServer, deps: HostMethodDeps): RegisteredHost {
  const surfaces: ShimSurface[] = [];

  const surface = (
    name: string,
    doc: string,
    methods: Readonly<
      Record<string, (params: Record<string, unknown>, ctx: HostCallContext) => unknown>
    >,
  ): void => {
    const mapping: Record<string, string> = {};
    for (const [local, handler] of Object.entries(methods)) {
      const remote = `${name}.${local}`;
      server.register(remote, handler);
      mapping[local] = remote;
    }
    surfaces.push({ name, doc, methods: mapping });
  };

  /* ---------------- 制品 ---------------- */

  surface('artifacts', '制品与血缘：列出、读版本、上下追溯、找血缘不完整的产物。', {
    list: (p) => {
      const kind = optStr(p, 'kind');
      const includeDeleted = optBool(p, 'includeDeleted');
      const records = deps.artifacts.listArtifacts({
        ...(kind === undefined ? {} : { kind: kind as never }),
        ...(includeDeleted === undefined ? {} : { includeDeleted }),
      });
      return records.map((a) => ({
        ...a,
        versionCount: deps.artifacts.listVersions(a.id).length,
      }));
    },

    versions: (p) => deps.artifacts.listVersions(reqStr(p, 'artifactId')),

    /** 版本的物理路径。拿到它就能用 pandas/mne 直接读，不必再经工具。 */
    path: (p) => {
      const path = deps.artifacts.versionPath(reqStr(p, 'versionId'));
      if (path === null) throw new Error(`版本不存在：${String(p.versionId)}`);
      return path;
    },

    ancestors: (p) => deps.artifacts.ancestors(reqStr(p, 'versionId'), optInt(p, 'maxDepth', 32)),
    descendants: (p) =>
      deps.artifacts.descendants(reqStr(p, 'versionId'), optInt(p, 'maxDepth', 32)),

    /** 血缘不完整的产物（需求 6.6）。Reviewer 用它开发现，控制面用它自查。 */
    irreproducible: () => deps.artifacts.irreproducible(),

    describeDeletion: (p) => deps.artifacts.describeDeletion(strList(p, 'artifactIds')),

    stats: () => deps.artifacts.blobs.stats(),
  });

  /* ---------------- findings ---------------- */

  surface('findings', '审查发现：列出未关闭的、自报已修、查摘要。关闭只能由 Reviewer 做。', {
    list: (p, ctx) => {
      const status = optStr(p, 'status');
      const severity = optStr(p, 'severity');
      const category = optStr(p, 'category');
      return deps.findings.list({
        conversationId: conv(p, ctx),
        ...(status === undefined ? {} : { status: status as never }),
        ...(severity === undefined ? {} : { severity: severity as never }),
        ...(category === undefined ? {} : { category: category as never }),
        limit: optInt(p, 'limit', 100),
      });
    },

    get: (p) => deps.findings.get(reqStr(p, 'findingId')),

    /**
     * 自报已修（需求 11.7）。
     *
     * 只能推进到「待复核」，不能关闭。关闭权在 Reviewer——直接关闭会让一次错误的
     * 自我判断永久掩盖问题。
     */
    claimFixed: (p) => ({
      updated: deps.findings.claimFixed(reqStr(p, 'findingId'), reqStr(p, 'note')),
    }),

    summary: (p, ctx) => deps.findings.summary(conv(p, ctx)),

    runs: (p, ctx) => deps.findings.runs(conv(p, ctx), optInt(p, 'limit', 20)),
  });

  /* ---------------- 技能 ---------------- */

  surface('skills', '技能：检索、取指令文档、看依赖状态与加载审计。', {
    list: () =>
      deps.skills.records().map((r) => ({
        slug: r.slug,
        name: r.name,
        domain: r.domain,
        scope: r.scope,
        enabled: r.enabled,
        description: r.manifest.description,
        triggers: r.manifest.triggers,
        requires: r.manifest.requires,
      })),

    search: async (p) => {
      const hits = await deps.skills.search(reqStr(p, 'query'), optInt(p, 'limit', 5));
      return hits.map((h) => ({
        slug: h.slug,
        name: h.manifest.name,
        score: h.score,
        scope: h.scope,
        description: h.manifest.description,
        requirementsSatisfied: h.requirementsSatisfied,
        missing: h.missingSummary,
        references: h.references,
      }));
    },

    /** 取指令文档全文。控制面可以据此生成派给子 agent 的提示。 */
    instructions: (p) => {
      const injection = deps.skills.inject(reqStr(p, 'slug'));
      if (injection === null) throw new Error(`技能不存在或已禁用：${String(p.slug)}`);
      return { slug: injection.slug, name: injection.name, content: injection.content };
    },

    reference: (p) => {
      const result = deps.skills.readReference(reqStr(p, 'slug'), reqStr(p, 'name'));
      if (!result.ok) throw new Error(result.reason);
      return result.content;
    },

    requirements: (p) => deps.skills.requirementsOf(reqStr(p, 'slug')),

    /** 本会话加载过哪些技能及原因（需求 9.8）。 */
    audit: (p, ctx) => deps.skillAudit.byConversation(conv(p, ctx), optInt(p, 'limit', 200)),

    auditSummary: () => deps.skillAudit.summary(),
  });

  /* ---------------- 子 agent ---------------- */

  surface('agents', '子 agent：派出、查状态、发引导、停止。产物经制品交接。', {
    /**
     * 派出子 agent。
     *
     * 与 `delegate` 工具的区别只在调用方式：这里返回句柄信息立刻回来，
     * 由控制面代码自己决定要不要等。默认非阻塞——控制面代码通常是在编排，
     * 让它同步等在一个子 agent 上会浪费掉控制面的价值。
     */
    delegate: (p, ctx) => {
      const tasks = p.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('tasks 必须是非空数组');
      }
      if (tasks.length > 16) throw new Error('一次最多派 16 个任务');

      const parent = conv(p, ctx, 'parentConversationId');
      return tasks.map((raw) => {
        if (typeof raw !== 'object' || raw === null) throw new Error('每个任务必须是对象');
        const t = raw as Record<string, unknown>;

        const spec: SubAgentSpec = {
          task: reqStr(t, 'task'),
          ...(optStr(t, 'skillSlug') === undefined ? {} : { skillSlug: optStr(t, 'skillSlug') }),
          inputVersionIds: strList(t, 'inputVersionIds'),
          produces: strList(t, 'produces'),
          // 控制面里默认非阻塞：它的价值就是编排，同步等着等于退回顺序执行
          blocking: optBool(t, 'blocking') ?? false,
          ...(optStr(t, 'taskType') === undefined
            ? {}
            : { taskType: optStr(t, 'taskType') as never }),
          ...(typeof t.maxTurns === 'number' ? { maxTurns: Math.floor(t.maxTurns) } : {}),
        };

        const handle = deps.subAgents.spawn({ parentConversationId: parent, spec });
        return {
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          blocking: handle.blocking,
        };
      });
    },

    list: (p, ctx) =>
      deps.subAgents.list(conv(p, ctx, 'parentConversationId')).map((h) => ({
        agentId: h.agentId,
        conversationId: h.conversationId,
        status: h.status,
        blocking: h.blocking,
      })),

    /** 等一个子 agent 出结果。控制面代码需要它来汇总。 */
    wait: async (p) => {
      const handle = deps.subAgents.get(reqStr(p, 'agentId'));
      if (handle === null) {
        throw new Error(
          `子 agent ${String(p.agentId)} 不在运行中。已结束的子 agent 的结果只在它当时的返回值里，` +
            '控制面代码要在派出后自己保留句柄。',
        );
      }
      return handle.result;
    },

    guide: (p) => ({
      delivered: deps.subAgents.get(reqStr(p, 'agentId'))?.guide(reqStr(p, 'message')) ?? false,
    }),

    stop: (p) => ({
      stopped: deps.subAgents.get(reqStr(p, 'agentId'))?.stop(reqStr(p, 'reason')) ?? false,
    }),
  });

  /* ---------------- 计划 ---------------- */

  surface('plans', '执行计划：查当前计划、各步状态、更新步骤进度。', {
    active: (p, ctx) => {
      const plan = deps.plans.activeOf(conv(p, ctx));
      if (plan === null) return null;
      return {
        ...plan,
        steps: deps.plans.steps(plan.id),
        progress: deps.plans.progress(plan.id),
      };
    },

    get: (p) => {
      const plan = deps.plans.get(reqStr(p, 'planId'));
      if (plan === null) throw new Error(`计划不存在：${String(p.planId)}`);
      return { ...plan, steps: deps.plans.steps(plan.id), progress: deps.plans.progress(plan.id) };
    },

    list: (p, ctx) => deps.plans.byConversation(conv(p, ctx), optInt(p, 'limit', 20)),

    /**
     * 更新步骤状态。
     *
     * 控制面代码在自己驱动计划执行时用它。刻意不提供「改计划本体」——那是用户的
     * 审阅权（需求 10.4），执行中改本体会让已完成的步骤与新步骤集合对不上。
     */
    setStepStatus: (p) => ({
      updated: deps.plans.setStepStatus({
        planId: reqStr(p, 'planId'),
        ref: reqStr(p, 'ref'),
        status: reqStr(p, 'status') as never,
        ...(optStr(p, 'resultRef') === undefined ? {} : { resultRef: optStr(p, 'resultRef') }),
      }),
    }),
  });

  /* ---------------- 模型与用量 ---------------- */

  surface('models', '模型注册表与用量：看有哪些模型、各自的能力与花费。', {
    list: () =>
      deps.registry.listModels({ includeDisabled: true }).map((m) => ({
        id: m.id,
        providerId: m.providerId,
        enabled: m.enabled,
        local: m.descriptor.local,
        contextWindow: m.descriptor.contextWindow,
        maxOutputTokens: m.descriptor.maxOutputTokens,
        pricing: m.descriptor.pricing,
        strengths: m.descriptor.strengths,
        features: m.descriptor.features,
        health: m.health,
      })),

    providers: () => deps.registry.listProviders({ includeDisabled: true }),

    usage: (p) => {
      const conversationId = optStr(p, 'conversationId');
      return conversationId === undefined
        ? deps.usage.byProject({})
        : deps.usage.byConversation(conversationId, {});
    },

    usageByModel: () => deps.usage.byModel({}),
    failures: () => deps.usage.failures({}),
  });

  /* ---------------- 文献库（任务 13.1-13.3）---------------- */

  /*
   * 刻意**不暴露 delete**。
   *
   * 制品表面也只给 `describeDeletion` 不给删除，理由一样：删掉一条被引用的文献会让
   * 引它的断言指向一个不存在的 id，而那个后果在删除的那一刻看不出来。控制面是编排面，
   * 不该拥有让台账悄悄变得不自洽的能力——删除留在界面上，那里有确认与影响说明。
   *
   * `merge` 例外并且必要：查重之后合并 `same` 档是文献库的主要维护动作，而
   * `RefLibrary.merge` 自己会拒绝两个不同 DOI 的合并，坏结果被结构挡住了。
   */
  if (deps.refs !== undefined) {
    const refsOf = deps.refs;

    surface(
      'refs',
      '文献库：查库、解析标识符、检索上游、查重合并、抓全文、导出引用。检索与抓取会触发域名审批。',
      {
        list: (p) => {
          const library = refsOf();
          const refs = library.repo.list({
            ...(optStr(p, 'query') === undefined ? {} : { query: optStr(p, 'query') }),
            ...(optIntOpt(p, 'year') === undefined ? {} : { year: optIntOpt(p, 'year') }),
            ...(optStr(p, 'type') === undefined ? {} : { type: optStr(p, 'type') }),
            ...(optBool(p, 'hasFulltext') === undefined
              ? {}
              : { hasFulltext: optBool(p, 'hasFulltext') }),
            limit: optInt(p, 'limit', 100),
            offset: optInt(p, 'offset', 0),
          });
          return refs.map((r) => ({
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
            // 撤稿标记埋在 csl.extra 里，提到平面上：引一篇已撤稿的论文是硬错误
            retracted: r.csl.extra?.retracted === true,
            addedAt: r.addedAt,
          }));
        },

        get: (p) => {
          const library = refsOf();
          const ref = library.repo.get(reqStr(p, 'refId'));
          if (ref === null) throw new Error(`文献不存在：${String(p.refId)}`);
          return {
            ...ref,
            cite: citeLine(ref.csl),
            bibtex: library.bibtexFor(ref.id),
            aliases: library.repo.aliases(ref.id),
          };
        },

        stats: () => refsOf().repo.stats(),

        /**
         * 解析标识符并入库（DOI / PMID / PMCID / arXiv）。
         *
         * 六家上游并行查完按完备度合并。**不接受纯标题**——模型「记得」的标题若能
         * 直接建记录，就会以真实文献的身份进参考文献列表。要按标题找请用 `search`，
         * 它返回候选而不入库。
         */
        resolve: async (p) => {
          const identifiers = strList(p, 'identifiers');
          if (identifiers.length === 0) throw new Error('identifiers 不能为空');
          if (identifiers.length > 200) throw new Error('一次最多解析 200 个标识符');

          const result = await refsOf().addMany(identifiers, {
            ...(optBool(p, 'refresh') === undefined ? {} : { refresh: optBool(p, 'refresh') }),
          });
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
              // 逐源结果原样给出：失败时要能区分「这条不存在」与「网络不通」
              attempts: o.attempts.map((a) => ({
                source: a.source,
                ok: a.ok,
                reason: a.reason,
              })),
            })),
          };
        },

        /** 检索上游。返回候选，**不入库**。`inLibraryRefId` 非空表示库里已有。 */
        search: async (p) => {
          const result = await refsOf().search({
            text: reqStr(p, 'query'),
            ...(optStr(p, 'author') === undefined ? {} : { author: optStr(p, 'author') }),
            ...(optIntOpt(p, 'year') === undefined ? {} : { year: optIntOpt(p, 'year') }),
            rows: optInt(p, 'limit', 10),
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
            attempts: result.attempts,
          };
        },

        duplicates: (p) => refsOf().scanDuplicates({ limit: optInt(p, 'limit', 50) }),

        merge: (p) => {
          const result = refsOf().merge(reqStr(p, 'keepId'), reqStr(p, 'dropId'));
          if (!result.ok || result.ref === null) {
            throw new Error(result.reason ?? '合并失败');
          }
          return { ...result.ref, cite: citeLine(result.ref.csl) };
        },

        /**
         * 抓全文（需求 12.3、12.4、12.6）。
         *
         * 按开放获取优先链依次试；每个来源的成败都记进 `attempts`，失败时那份记录
         * 就是「试过谁、各自为什么不行」的答案。抓到的正文与随文图像落成制品，
         * 用 `host.artifacts.path` 读。
         */
        fetchFulltext: async (p) => {
          const result = await refsOf().fetchFulltext(reqStr(p, 'refId'), {
            ...(p.sources === undefined ? {} : { sources: strList(p, 'sources') as never }),
            ...(optBool(p, 'force') === undefined ? {} : { force: optBool(p, 'force') }),
          });
          return {
            ok: result.ok,
            source: result.source,
            summary: result.summary,
            fulltextArtifactId: result.fulltextArtifactId,
            fulltextVersionId: result.fulltextVersionId,
            assets: result.assets,
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
        },

        assets: (p) => {
          const library = refsOf();
          const refId = reqStr(p, 'refId');
          const ref = library.repo.get(refId);
          if (ref === null) throw new Error(`文献不存在：${refId}`);
          return {
            assets: library.repo.assets(refId),
            attempts: library.repo.fetchAttempts(refId),
            fulltextArtifactId: ref.fulltextArtifactId,
            oaStatus: ref.oaStatus,
          };
        },

        /**
         * 导出引用（BibTeX / CSL-JSON / RIS）。
         *
         * 三种格式共用同一套引用键，因此手稿在 pandoc 与 LaTeX 之间切换时引用不会失效。
         * 结果落成制品；内容超过 2 MB 时不再内联返回（读制品即可），否则一次控制面
         * 调用的返回值就能把上下文占满。
         */
        export: (p) => {
          const format = reqStr(p, 'format');
          if (format !== 'bibtex' && format !== 'csl-json' && format !== 'ris') {
            throw new Error('format 必须是 bibtex / csl-json / ris 之一');
          }
          const refIds = strList(p, 'refIds');
          const outcome = refsOf().exportRefs({
            format,
            ...(refIds.length === 0 ? {} : { refIds }),
            ...(optStr(p, 'stem') === undefined ? {} : { stem: optStr(p, 'stem') }),
            ...(optBool(p, 'asciiOnly') === undefined
              ? {}
              : { asciiOnly: optBool(p, 'asciiOnly') }),
            ...(optBool(p, 'includeAbstract') === undefined
              ? {}
              : { includeAbstract: optBool(p, 'includeAbstract') }),
          });
          if (!outcome.ok || outcome.result === null) {
            throw new Error(outcome.reason ?? '导出失败');
          }
          const inline = outcome.result.content.length <= 2 * 1024 * 1024;
          return {
            format: outcome.result.format,
            filename: outcome.result.filename,
            entryCount: outcome.result.entryCount,
            keys: outcome.result.keys,
            // 缺字段的条目照样导出，但要报出来：这是投稿前最后一次能看见它们的机会
            warnings: outcome.result.warnings,
            artifactId: outcome.artifactId,
            versionId: outcome.versionId,
            missingIds: outcome.missingIds,
            content: inline ? outcome.result.content : null,
            contentOmitted: !inline,
          };
        },
      },
    );
  }

  /* ---------------- 断言台账与引文核实（任务 13.4、13.5）---------------- */

  if (deps.claims !== undefined) {
    const claimsOf = deps.claims;
    const verifierOf = deps.citations;

    surface(
      'claims',
      '断言台账与引文核实：登记、绑定证据、记核验结论、查无证据项。状态由证据推导，不能直接写。',
      {
        list: (p) => {
          const status = optStr(p, 'status');
          const claims = claimsOf().repo.list({
            ...(optStr(p, 'conversationId') === undefined
              ? {}
              : { conversationId: optStr(p, 'conversationId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
            ...(status === undefined ? {} : { status: status as never }),
            ...(optStr(p, 'kind') === undefined ? {} : { kind: optStr(p, 'kind') as never }),
            ...(optBool(p, 'unsupportedOnly') === undefined
              ? {}
              : { unsupportedOnly: optBool(p, 'unsupportedOnly') }),
            limit: optInt(p, 'limit', 100),
          });
          return claims.map((c) => ({
            ...c,
            unsupported: c.evidence.length === 0,
            verifiedCount: c.evidence.filter((e) => e.verdict !== null).length,
          }));
        },

        get: (p) => {
          const ledger = claimsOf();
          const claim = ledger.repo.get(reqStr(p, 'claimId'));
          if (claim === null) throw new Error(`断言不存在：${String(p.claimId)}`);
          return {
            ...claim,
            retrievalBacked: ledger.repo.hasRetrievalBackedCheck(claim.id),
            checks: ledger.repo.citationChecks({ claimId: claim.id, limit: 20 }),
          };
        },

        summary: (p) => {
          const scope = {
            ...(optStr(p, 'conversationId') === undefined
              ? {}
              : { conversationId: optStr(p, 'conversationId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
          };
          const ledger = claimsOf();
          return { ...ledger.summary(scope), gate: ledger.gateSummary(scope) };
        },

        /** 无证据的断言。`confirmed` 会开 FAIL，`extracted` 只是 WARN。 */
        unsupported: (p) =>
          claimsOf().unsupported({
            ...(optStr(p, 'conversationId') === undefined
              ? {}
              : { conversationId: optStr(p, 'conversationId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
          }),

        /** 证据矛盾的断言。比无证据更严重：手稿里有一句已知错误的陈述。 */
        refuted: (p) =>
          claimsOf().refuted({
            ...(optStr(p, 'conversationId') === undefined
              ? {}
              : { conversationId: optStr(p, 'conversationId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
          }),

        /**
         * 从手稿抽取并批量登记。
         *
         * 抽取是**确定性规则**，不经模型：模型会漏，而漏掉的可能正是编造的那个数字。
         * 已登记的同一条文本跳过，因此改一个错别字重跑不会让核验过的断言退回未核验。
         */
        extract: (p, ctx) => {
          const markdown = optStr(p, 'markdown');
          const versionId = optStr(p, 'sourceVersionId');
          let text = markdown;
          if (text === undefined && versionId !== undefined) {
            const bytes = deps.artifacts.readVersion(versionId);
            if (bytes === null) throw new Error(`制品版本不存在：${versionId}`);
            text = bytes.toString('utf8');
          }
          if (text === undefined) throw new Error('传 markdown 或 sourceVersionId');

          const result = claimsOf().extractAndRegister({
            markdown: text,
            conversationId: conv(p, ctx),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
            options: {
              ...(optIntOpt(p, 'limit') === undefined ? {} : { limit: optIntOpt(p, 'limit') }),
              ...(strList(p, 'sections').length === 0 ? {} : { sections: strList(p, 'sections') }),
            },
          });
          return {
            created: result.created.length,
            skippedExisting: result.skippedExisting,
            extraction: result.extraction,
            claims: result.created.map((c) => ({
              id: c.id,
              text: c.text,
              kinds: c.kinds,
              locator: c.locator,
              section: c.section,
            })),
          };
        },

        register: (p, ctx) => {
          const result = claimsOf().register({
            text: reqStr(p, 'text'),
            conversationId: conv(p, ctx),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
            ...(optStr(p, 'locator') === undefined ? {} : { locator: optStr(p, 'locator') }),
            ...(optStr(p, 'section') === undefined ? {} : { section: optStr(p, 'section') }),
            ...(optStr(p, 'note') === undefined ? {} : { note: optStr(p, 'note') }),
          });
          if (!result.ok || result.claim === null) throw new Error(result.reason ?? '登记失败');
          return { claim: result.claim, existing: result.existing, note: result.reason };
        },

        /** 确认一条自动抽取的断言。确认后它无证据时会开 FAIL 级发现。 */
        confirm: (p) => {
          const result = claimsOf().confirm(
            reqStr(p, 'claimId'),
            optStr(p, 'note') ?? '控制面确认',
          );
          if (!result.ok) throw new Error(result.reason ?? '确认失败');
          return result.claim;
        },

        /**
         * 绑定证据（需求 13.2）。
         *
         * 被指向的对象要**真的存在**才绑得上。放行的话断言在计数上「有证据」、
         * 检查放过它、用户点开是空的——那是最坏的失败形态。
         */
        bind: (p) => {
          const result = claimsOf().bind({
            claimId: reqStr(p, 'claimId'),
            kind: reqStr(p, 'kind') as ClaimEvidenceKind,
            ref: reqStr(p, 'ref'),
            ...(optStr(p, 'locator') === undefined ? {} : { locator: optStr(p, 'locator') }),
            ...(optStr(p, 'quote') === undefined ? {} : { quote: optStr(p, 'quote') }),
            ...(optStr(p, 'note') === undefined ? {} : { note: optStr(p, 'note') }),
          });
          if (!result.ok) {
            throw new Error(
              result.advice === null
                ? (result.reason ?? '绑定失败')
                : `${result.reason ?? '绑定失败'}\n${result.advice}`,
            );
          }
          return { evidence: result.evidence, claim: result.claim };
        },

        unbind: (p) => {
          const ledger = claimsOf();
          const claimId = reqStr(p, 'claimId');
          const result = ledger.unbind(
            claimId,
            reqStr(p, 'kind') as ClaimEvidenceKind,
            reqStr(p, 'ref'),
          );
          if (!result.ok) throw new Error(result.reason ?? '解绑失败');
          // 解绑会重新推导状态，回显新状态而不是只说「删了」
          return ledger.repo.get(claimId);
        },

        /**
         * 记一条核验结论（需求 13.3）。
         *
         * `modelId` 不接受参数，由平台从本次控制面执行的上下文注入——自报的执行者
         * 标识在「这个结论有多可信」上没有任何价值。控制面之外的调用者拿不到它，
         * 这里就拒绝。
         *
         * 断言状态由这些结论推导，不能直接写：让调用方设状态等于取消核验。
         * 一条 `contradicts` 压倒任意多条 `supports`。
         */
        verify: (p, ctx) => {
          if (ctx.modelId === null) {
            throw new Error(
              '这次调用没有执行者身份，核验结论无法记录。\n' +
                '需求 13.3 要求每条核验都记下是谁判的——一个没有执行者的结论在半年后' +
                '无法判断可信度。控制面 REPL 会自动带上当前模型；' +
                '从别处调用请改走 manage_claims 工具或界面。',
            );
          }
          const result = claimsOf().verify({
            claimId: reqStr(p, 'claimId'),
            kind: reqStr(p, 'kind') as ClaimEvidenceKind,
            ref: reqStr(p, 'ref'),
            verdict: reqStr(p, 'verdict') as ClaimVerdict,
            modelId: ctx.modelId,
            ...(optStr(p, 'note') === undefined ? {} : { note: optStr(p, 'note') }),
          });
          if (!result.ok) throw new Error(result.reason ?? '核验记录失败');
          return result.claim;
        },

        close: (p) => {
          const status = reqStr(p, 'status');
          if (status !== 'retracted' && status !== 'dismissed') {
            throw new Error('status 必须是 retracted（已从稿中删除）或 dismissed（不是断言）');
          }
          const result = claimsOf().close(reqStr(p, 'claimId'), status, reqStr(p, 'reason'));
          if (!result.ok) throw new Error(result.reason ?? '关闭失败');
          return result.claim;
        },

        reopen: (p) => {
          const result = claimsOf().reopen(reqStr(p, 'claimId'), reqStr(p, 'reason'));
          if (!result.ok) throw new Error(result.reason ?? '重开失败');
          return result.claim;
        },

        /** 渲染成文本。写「还剩哪些事」的小结时比自己拼字符串省事。 */
        render: (p) => {
          const ledger = claimsOf();
          const scope = {
            ...(optStr(p, 'conversationId') === undefined
              ? {}
              : { conversationId: optStr(p, 'conversationId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
          };
          const status = optStr(p, 'status');
          return ledger.render(
            ledger.repo.list({
              ...scope,
              ...(status === undefined ? {} : { status: status as never }),
              limit: optInt(p, 'limit', 50),
            }),
            { showEvidence: optBool(p, 'showEvidence') ?? true },
          );
        },

        /**
         * 解析引文但**不检索**（需求 13.9）。
         *
         * 先看解析对不对，再决定要不要花几十次上游请求。纯引用标记（`[12]`）会被
         * 标成不可检索——拿它当标题去查会返回一堆无关文献，其中最相似的被判成命中，
         * 于是编造的引文「核实通过」。
         */
        parseCitations: (p) => {
          const raw = optStr(p, 'referenceList');
          const listed = strList(p, 'citations');
          const targets =
            raw === undefined
              ? [...listed]
              : [...listed, ...parseReferenceList(raw).map((c) => c.raw)];
          if (targets.length === 0) throw new Error('传 citations 或 referenceList');
          return targets.map((text) => {
            const parsed = parseCitation(text);
            return {
              raw: text,
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
          });
        },

        /**
         * 核实引文（需求 13.9）。
         *
         * 检索由这一层做，**结论也由这一层算**——控制面代码给不了 verdict。
         * 这是「禁止凭记忆作答」在接口形状上的实现：没有可以写结论的参数，
         * 因此没有绕过检索的路径。
         */
        verifyCitations: async (p, ctx) => {
          if (verifierOf === undefined) {
            throw new Error('引文核实需要文献库，本次运行没有可用的文献库');
          }
          const raw = optStr(p, 'referenceList');
          const listed = strList(p, 'citations');
          const targets = [
            ...new Set(
              (raw === undefined
                ? listed
                : [...listed, ...parseReferenceList(raw).map((c) => c.raw)]
              )
                .map((t) => t.replace(/\s+/gu, ' ').trim())
                .filter((t) => t !== ''),
            ),
          ];
          if (targets.length === 0) throw new Error('传 citations 或 referenceList');
          if (targets.length > 100) throw new Error('一次最多核实 100 条');

          const outcome = await verifierOf().verifyMany(targets, {
            ...(optStr(p, 'claimId') === undefined ? {} : { claimId: optStr(p, 'claimId') }),
            // 执行者由平台注入。没有时也照样核实（判定不依赖它），但记录里会是空
            modelId: ctx.modelId,
          });
          return {
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
              // 实际发出的查询一并返回：需求 13.9 的可核查性靠它
              queries: r.queries,
              attempts: r.attempts,
              detail: r.detail,
              checkId: r.checkId,
            })),
          };
        },

        /** 核实记录（需求 13.9 的审计面）。`not-found` 那些是「可能编造」的凭据。 */
        checks: (p) => {
          const ledger = claimsOf();
          const verdict = optStr(p, 'verdict');
          const checks = ledger.repo.citationChecks({
            ...(optStr(p, 'claimId') === undefined ? {} : { claimId: optStr(p, 'claimId') }),
            ...(verdict === undefined ? {} : { verdict: verdict as never }),
            limit: optInt(p, 'limit', 100),
          });
          return {
            checks: checks.map((check) => ({
              ...check,
              retrievalBacked: check.queries.length > 0 && check.verdict !== 'unverifiable',
            })),
            suspectCount: ledger.repo.fabricationSuspects(200).length,
          };
        },
      },
    );
  }

  /* ---------------- 手稿编译（任务 13.6）---------------- */

  if (deps.manuscripts !== undefined) {
    const compilerOf = deps.manuscripts;

    surface(
      'manuscripts',
      '手稿编译：按目标期刊档案检查与渲染、生成双盲送审版、查编译历史与问题数趋势。',
      {
        /**
         * 内置期刊档案。
         *
         * 免责说明随档案一起返回：显示「摘要上限 150 词」而不说这个数字的来源，
         * 用户会照它删稿——而档案里的数值是内置近似值，会随期刊改版过期。
         */
        profiles: () => ({
          profiles: BUILTIN_JOURNAL_PROFILES.map((profile) => ({
            ...profile,
            summary: describeProfile(profile, true),
          })),
          disclaimer:
            '档案里的字数与条数是各刊作者指南的近似值，会随期刊改版而过期。' +
            '编译报告里的提示是「按该档案的上限」，不是对该刊当前规则的断言。改稿前请核对官方要求。',
        }),

        list: (p) =>
          compilerOf()
            .repo.list({
              ...(optStr(p, 'conversationId') === undefined
                ? {}
                : { conversationId: optStr(p, 'conversationId') }),
              limit: optInt(p, 'limit', 50),
            })
            .map((m) => ({
              ...m,
              latestRun: compilerOf().repo.compileRuns(m.id, 1)[0] ?? null,
            })),

        get: (p) => {
          const compiler = compilerOf();
          const manuscriptId = reqStr(p, 'manuscriptId');
          const manuscript = compiler.repo.get(manuscriptId);
          if (manuscript === null) throw new Error(`手稿不存在：${manuscriptId}`);
          return {
            manuscript,
            runs: compiler.repo.compileRuns(manuscriptId, 20),
            // 趋势与「上次报告」是两个问题：12 个问题可能是从 40 降下来的
            trend: compiler.repo.trend(manuscriptId, 20),
          };
        },

        /** 只解析不编译。先确认作者、机构、图表都解析对了再编译。 */
        parse: (p) => {
          const parsed = compilerOf().parse({
            ...(optStr(p, 'markdown') === undefined ? {} : { markdown: optStr(p, 'markdown') }),
            ...(optStr(p, 'sourceVersionId') === undefined
              ? {}
              : { sourceVersionId: optStr(p, 'sourceVersionId') }),
          });
          if (!parsed.ok || parsed.doc === null) throw new Error(parsed.reason ?? '解析失败');
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
        },

        /**
         * 编译（需求 13.5-13.8）。
         *
         * **只检查不自动改**，唯一例外是引用重编号：自动删字毁论证，自动重排打乱
         * 交叉引用。双盲版只删结构化字段、正文一个字不改，移除项逐条列出——
         * 因此对正文里的隐式身份线索无保证，这句话同时进输出文件与报告。
         */
        compile: async (p, ctx) => {
          const outcome = await compilerOf().compile({
            ...(optStr(p, 'markdown') === undefined ? {} : { markdown: optStr(p, 'markdown') }),
            ...(optStr(p, 'sourceVersionId') === undefined
              ? {}
              : { sourceVersionId: optStr(p, 'sourceVersionId') }),
            ...(optStr(p, 'manuscriptId') === undefined
              ? {}
              : { manuscriptId: optStr(p, 'manuscriptId') }),
            ...(optStr(p, 'targetJournal') === undefined
              ? {}
              : { targetJournal: optStr(p, 'targetJournal') }),
            ...(p.customProfile === undefined ? {} : { customProfile: p.customProfile }),
            ...(optBool(p, 'blinded') === undefined ? {} : { blinded: optBool(p, 'blinded') }),
            ...(optBool(p, 'both') === undefined ? {} : { both: optBool(p, 'both') }),
            ...(optStr(p, 'stem') === undefined ? {} : { stem: optStr(p, 'stem') }),
            conversationId: ctx.conversationId,
            modelId: ctx.modelId,
          });
          if (!outcome.ok || outcome.manuscript === null) {
            throw new Error(outcome.reason ?? '编译失败');
          }
          return {
            manuscript: outcome.manuscript,
            outputs: outcome.outputs.map((o) => ({
              blinded: o.blinded,
              artifactId: o.artifactId,
              versionId: o.versionId,
              filename: o.filename,
              bibArtifactId: o.bibArtifactId,
              bibVersionId: o.bibVersionId,
              summary: compileSummary(o.result),
              profile: o.result.profile.id,
              profileMatched: o.result.profileMatched,
              counts: o.result.counts,
              issues: o.result.issues,
              // 移除项逐条列出：「已移除作者信息」核对不了任何东西
              removedFields: o.result.removedFields,
              selfCitationLeaks: o.result.selfCitationLeaks,
              citationMap: o.result.citationMap,
              report: o.result.report,
              // 需求 13.8：双盲处理只覆盖结构化字段，这句话必须跟着结果走
              disclaimer: o.blinded ? BLINDING_DISCLAIMER : null,
            })),
          };
        },

        history: (p) => {
          const compiler = compilerOf();
          const manuscriptId = reqStr(p, 'manuscriptId');
          if (compiler.repo.get(manuscriptId) === null) {
            throw new Error(`手稿不存在：${manuscriptId}`);
          }
          return {
            runs: compiler.repo.compileRuns(manuscriptId, optInt(p, 'limit', 20)),
            trend: compiler.repo.trend(manuscriptId, optInt(p, 'limit', 20)),
          };
        },
      },
    );
  }

  /* ---------------- 算力（任务 14.2）---------------- */

  /*
   * 控制面能查、能提交、能取消，**不能登记目标**。
   *
   * 与模型面工具同一条理由：登记需要主机名、跳板机配置、远端工作目录与分区名这些
   * 只有用户知道的事实。控制面代码是模型写的，它填出来的会是看起来合理的值，而
   * 失败要等到探测时才出现——那时用户看到的是「连不上一个他从没提过的主机」。
   *
   * 提交与执行仍然过审批门：控制面是特权面，但特权针对的是**平台自身的管理能力**，
   * 不包括「把命令发到用户的集群上而不问他」。
   */
  if (deps.compute !== undefined) {
    const computeOf = deps.compute;

    surface(
      'compute',
      '算力目标与作业：列出目标、探测、提交作业、查状态、取输出、取消。执行与提交仍要经用户审批。',
      {
        /** 列出目标。每次读库，因此用户中途新增的会立刻出现（需求 14.6）。 */
        targets: (p) =>
          computeOf()
            .list({
              ...(optBool(p, 'includeDisabled') === undefined
                ? {}
                : { includeDisabled: optBool(p, 'includeDisabled') }),
            })
            .map((target) => ({
              id: target.id,
              name: target.name,
              family: target.family,
              label: describeTarget(target),
              enabled: target.enabled,
              disabledReason: target.disabledReason,
              config: target.config,
              // ssh 目标在公钥未确认前不能用。提到平面上，不让调用方去猜
              needsHostKeyConfirmation:
                target.family === 'ssh' && target.hostKeyFingerprint === null,
              lastProbe: target.lastProbe,
              notesMd: target.notesMd,
            })),

        /** 目标列表的版本号。轮询「有没有新目标」时用它，比拉全量便宜。 */
        revision: () => computeOf().revision(),

        /** 探测一个目标。会连接远端，慢。 */
        probe: async (p) => {
          const service = computeOf();
          const target = service.targets.resolve(reqStr(p, 'target'));
          if (target === null) throw new Error(`找不到算力目标：${String(p.target)}`);
          return service.probe(target.id);
        },

        ping: async (p) => {
          const service = computeOf();
          const target = service.targets.resolve(reqStr(p, 'target'));
          if (target === null) throw new Error(`找不到算力目标：${String(p.target)}`);
          return service.ping(target.id);
        },

        /**
         * 执行一条远程命令。**每次都过审批**（需求 14.4）。
         *
         * `purpose` 是必填的：它原样出现在用户的审批卡片上，是他判断要不要同意的依据。
         */
        runCommand: async (p, ctx) => {
          const result = await computeOf().runCommand({
            targetRef: reqStr(p, 'target'),
            command: reqStr(p, 'command'),
            purpose: reqStr(p, 'purpose'),
            conversationId: ctx.conversationId,
            ...(optIntOpt(p, 'timeoutMs') === undefined
              ? {}
              : { timeoutMs: optIntOpt(p, 'timeoutMs') }),
            modelId: ctx.modelId,
          });
          return {
            ok: result.ok,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            risk: result.risk.risk,
            riskReason: result.risk.reason,
            denied: result.gate.source === 'denied',
            // 需求 17.3：显式拒绝不可重试，超时与取消可以。合成一个布尔会让
            // 调用方在用户明确说「不行」之后再问一次
            retryable: result.gate.retryable,
            reason: result.reason,
          };
        },

        /** 提交作业。**每次都过审批**，卡片上会列出资源请求。 */
        submitJob: async (p, ctx) => {
          const env: Record<string, string> = {};
          if (typeof p.env === 'object' && p.env !== null && !Array.isArray(p.env)) {
            for (const [key, value] of Object.entries(p.env as Record<string, unknown>)) {
              env[key] = String(value);
            }
          }

          const result = await computeOf().submitJob({
            targetRef: reqStr(p, 'target'),
            spec: {
              name: reqStr(p, 'name'),
              script: reqStr(p, 'script'),
              ...(optIntOpt(p, 'cpus') === undefined ? {} : { cpus: optIntOpt(p, 'cpus') }),
              ...(optIntOpt(p, 'gpus') === undefined ? {} : { gpus: optIntOpt(p, 'gpus') }),
              ...(optIntOpt(p, 'memoryMb') === undefined
                ? {}
                : { memoryMb: optIntOpt(p, 'memoryMb') }),
              ...(optIntOpt(p, 'minutes') === undefined
                ? {}
                : { minutes: optIntOpt(p, 'minutes') }),
              ...(optStr(p, 'partition') === undefined
                ? {}
                : { partition: optStr(p, 'partition') }),
              ...(optStr(p, 'account') === undefined ? {} : { account: optStr(p, 'account') }),
              ...(Object.keys(env).length === 0 ? {} : { env }),
              extraDirectives: strList(p, 'extraDirectives'),
            },
            conversationId: ctx.conversationId,
          });

          if (!result.ok || result.job === null) {
            throw new Error(
              `${result.reason ?? '提交失败'}` +
                (result.gate?.source === 'denied' && !result.gate.retryable
                  ? '\n（用户明确拒绝，不要重新发起同一请求。）'
                  : ''),
            );
          }
          return { ...result.job, terminal: isTerminalJobState(result.job.state) };
        },

        jobs: (p, ctx) => {
          const service = computeOf();
          const state = optStr(p, 'state');
          return service.jobs
            .list({
              ...(optStr(p, 'target') === undefined
                ? {}
                : {
                    targetId:
                      service.targets.resolve(optStr(p, 'target') as string)?.id ??
                      (optStr(p, 'target') as string),
                  }),
              // 默认只看本会话的：全项目的作业列表里模型分不出哪些与当前任务有关
              conversationId: optStr(p, 'conversationId') ?? ctx.conversationId ?? undefined,
              state: (state ?? 'all') as never,
              limit: optInt(p, 'limit', 50),
            })
            .map((job) => ({
              ...job,
              targetName: service.targets.get(job.targetId)?.name ?? null,
              stateLabel: JOB_STATE_LABEL[job.state],
              terminal: isTerminalJobState(job.state),
            }));
        },

        /** 单个作业。会主动问一次调度器——调用方想知道的是现在的状态。 */
        job: async (p) => {
          const service = computeOf();
          const jobId = reqStr(p, 'jobId');
          if (service.jobs.get(jobId) === null) throw new Error(`作业不存在：${jobId}`);
          await service.pollOnce(jobId);
          const job = service.jobs.get(jobId);
          if (job === null) throw new Error(`作业不存在：${jobId}`);
          return {
            ...job,
            stateLabel: JOB_STATE_LABEL[job.state],
            terminal: isTerminalJobState(job.state),
            summary: service.renderJob(job),
          };
        },

        /** 取输出。落成的制品 id 一并返回，可以用 `host.artifacts.path` 读原文。 */
        outputs: async (p) => {
          const service = computeOf();
          const jobId = reqStr(p, 'jobId');
          if (service.jobs.get(jobId) === null) throw new Error(`作业不存在：${jobId}`);
          return service.collectOutputs(jobId, {
            ...(optIntOpt(p, 'tailLines') === undefined
              ? {}
              : { tailLines: optIntOpt(p, 'tailLines') }),
          });
        },

        cancelJob: async (p) => {
          const result = await computeOf().cancelJob(reqStr(p, 'jobId'));
          if (!result.ok) throw new Error(result.reason ?? '取消失败');
          return { cancelled: true };
        },

        /** 远程命令审计（需求 14.4）。被拒绝的那些也在里面。 */
        commands: (p) =>
          computeOf().jobs.commands({
            ...(optStr(p, 'target') === undefined ? {} : { targetId: optStr(p, 'target') }),
            limit: optInt(p, 'limit', 50),
          }),

        /** 当前的算力授权。哪些命令被持久放行了，在这里能查。 */
        grants: (p) =>
          computeOf().grants.list({
            ...(optStr(p, 'target') === undefined ? {} : { targetId: optStr(p, 'target') }),
          }),
      },
    );
  }

  /* ---------------- MCP 连接器 ---------------- */

  /*
   * 需求 14.2：MCP 表面只在控制面暴露。
   *
   * 这个表面只有在 `deps.mcp` 存在时才注册。它不存在时 `host.mcp` 会走 pending 分支
   * 抛出带说明的错误，而不是返回空——空壳会让模型以为「查了但没有连接器」，然后基于
   * 一个不存在的事实继续推理。
   */
  if (deps.mcp !== undefined) {
    const mcp = deps.mcp;

    surface('mcp', '外部连接器：列出可用工具、调用它们、查连接状态。工具调用可能触发用户审批。', {
      /** 连接器状态总览。不触发连接，能在什么都没连时回答。 */
      connectors: () => mcp.status(),

      /**
       * 列出全部生效连接器的工具。
       *
       * 会逐个建立连接，第一次调用可能慢。某个连接器连不上不影响其余——五十个内置
       * 连接器里有一个的服务临时挂了，不该让整个清单报错。
       */
      tools: async () => {
        const tools = await mcp.tools();
        return tools.map((t) => ({
          connectorId: t.connectorId,
          connectorName: t.connectorName,
          name: t.tool.name,
          description: t.tool.description ?? '',
          inputSchema: t.tool.inputSchema,
          readOnly: t.tool.annotations?.readOnlyHint === true,
        }));
      },

      /** 只列某个连接器的工具。比 `tools()` 快得多，知道要用哪个时用它。 */
      toolsOf: async (p) => {
        const client = await mcp.client(reqStr(p, 'connectorId'));
        return client.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
          readOnly: t.annotations?.readOnlyHint === true,
        }));
      },

      /**
       * 调用一个工具。
       *
       * 非只读工具会触发审批并阻塞等待。被拒绝时返回 `denied: true` 而不是抛错——
       * 拒绝是正常结果，而且需求 17.3 要求拒绝后不得重试同一请求。
       */
      call: async (p, ctx) => {
        const args =
          typeof p.arguments === 'object' && p.arguments !== null && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        const outcome = await mcp.callTool(reqStr(p, 'connectorId'), reqStr(p, 'tool'), args, {
          conversationId: ctx.conversationId,
          projectId: deps.projectId,
        });
        return {
          ok: outcome.ok,
          denied: outcome.denied,
          text: outcome.text,
          data: outcome.structured,
        };
      },

      /** 读一个资源。 */
      readResource: async (p) => {
        const client = await mcp.client(reqStr(p, 'connectorId'));
        return client.readResource(reqStr(p, 'uri'));
      },

      /** 取一个提示模板。 */
      prompt: async (p) => {
        const client = await mcp.client(reqStr(p, 'connectorId'));
        const args =
          typeof p.arguments === 'object' && p.arguments !== null && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        return client.getPrompt(reqStr(p, 'name'), args);
      },

      /** 测试连接。设置页与排查时用。 */
      check: async (p) => mcp.check(reqStr(p, 'connectorId')),
    });
  }

  /* ---------------- 只读查询 ---------------- */

  surface(
    'query',
    '对项目库做只读 SQL 查询。只允许单条 SELECT / WITH；写入请走对应的 host 方法。',
    {
      sql: (p) => {
        const sql = reqStr(p, 'sql');
        assertReadOnlySql(sql);
        const params = Array.isArray(p.params) ? (p.params as unknown[]) : [];
        const limit = optInt(p, 'limit', 1000);

        const rows = deps.db.prepare(sql).all(...params) as unknown[];
        // 截断而不是报错：探索性查询常常忘了加 LIMIT，而返回十万行会把上下文打爆
        return {
          rows: rows.slice(0, limit),
          truncated: rows.length > limit,
          total: rows.length,
        };
      },

      /** 表名与列名，省得每次去翻 schema。 */
      schema: () => {
        const tables = deps.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>;

        return tables.map((t) => ({
          table: t.name,
          columns: (
            deps.db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as Array<{
              name: string;
              type: string;
              notnull: number;
            }>
          ).map((c) => ({ name: c.name, type: c.type, notNull: c.notnull === 1 })),
        }));
      },
    },
  );

  /*
   * 缺席与未实现是两回事，说法必须不同。
   *
   * `compute` 是「还没做」；`mcp` 缺席是「这个部署里没启用连接器」；M4 三层缺席是
   * 「这次运行没接上」。用同一句「尚未落地」会让用户去等一个已经做完的东西。
   */
  const pending: ShimPending[] = [...PENDING];
  if (deps.mcp === undefined) {
    pending.push({
      name: 'mcp',
      reason: '连接器管理未启用（本次运行没有可用的连接器注册表）',
    });
  }
  if (deps.refs === undefined) pending.push({ name: 'refs', reason: ABSENT.refs });
  if (deps.claims === undefined) pending.push({ name: 'claims', reason: ABSENT.claims });
  if (deps.manuscripts === undefined) {
    pending.push({ name: 'manuscripts', reason: ABSENT.manuscripts });
  }
  if (deps.compute === undefined) pending.push({ name: 'compute', reason: ABSENT.compute });

  return { surfaces, pending };
}
