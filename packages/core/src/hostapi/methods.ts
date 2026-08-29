/**
 * 控制面方法实现（任务 12.7，需求 10.8）。
 *
 * 只暴露**有真实后端**的表面。M4/M5 才落地的（`refs`、`claims`、`compute`、`mcp`）
 * 列进 pending，访问它们会抛出带说明的错误而不是返回空——空壳会让模型以为
 * 「查了但没有」，然后基于一个不存在的事实继续推理。
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

/** 尚未实现的表面。列在这里，访问时给出明确原因。 */
const PENDING: readonly ShimPending[] = [
  { name: 'refs', reason: '文献库属 M4（任务 13.1-13.3），尚未落地' },
  { name: 'claims', reason: 'Claim Ledger 属 M4（任务 13.4），尚未落地' },
  { name: 'manuscripts', reason: 'Manuscript Compiler 属 M4（任务 13.6），尚未落地' },
  { name: 'compute', reason: '远程算力属 M5（任务 14.2），尚未落地' },
];

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

    surface(
      'mcp',
      '外部连接器：列出可用工具、调用它们、查连接状态。工具调用可能触发用户审批。',
      {
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
          const outcome = await mcp.callTool(
            reqStr(p, 'connectorId'),
            reqStr(p, 'tool'),
            args,
            { conversationId: ctx.conversationId, projectId: deps.projectId },
          );
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
      },
    );
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
   * `mcp` 只在连接器管理缺席时才算未实现。
   *
   * 两种情况的原因不同，说法也必须不同：M4/M5 的表面是「还没做」，而 mcp 缺席是
   * 「这个部署里没启用连接器」。用同一句「尚未落地」会让用户去等一个已经做完的东西。
   */
  const pending =
    deps.mcp === undefined
      ? [
          ...PENDING,
          {
            name: 'mcp',
            reason: '连接器管理未启用（本次运行没有可用的连接器注册表）',
          },
        ]
      : PENDING;

  return { surfaces, pending };
}
