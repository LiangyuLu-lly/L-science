/**
 * Reviewer Service（任务 12.8，需求 11.1-11.8）。
 *
 * 一个在后台独立运行的审查者。它不参与主对话，只往 findings 表里写东西。
 *
 * ## 为什么它必须是异厂商（AD-4、需求 11.2）
 *
 * 同一模型家族的系统性偏差与幻觉模式高度相关。让 DeepSeek 审 DeepSeek 写的统计
 * 推理，它会漏掉与自己同源的那类错误——「审查通过」因此不构成任何额外保证，
 * 只是把同一个盲区又走了一遍。只有一家可用时**明确告知降级**，不静默用同厂商顶上。
 *
 * ## 两层检查
 *
 * 确定性层（`checks.ts`）不用模型，结论可以指到具体的库行；模型层读内容，
 * 能发现统计与一致性问题但可能编造。两层的产出都进同一张表，但可信度不同：
 * 模型层的每条发现都要经过证据清单校验（`parse.ts`），引不到真实对象的整条丢弃。
 *
 * ## 不阻塞主对话（需求 11.1）
 *
 * `schedule()` 立即返回，审查在后台跑。同一会话已经在审查时不排队而是**合并**：
 * 记一个 pending 标记，当前这轮结束后再跑一次。排队会让连续几个回合各排一次审查，
 * 而后面那次的输入已经包含了前面所有内容——前几次纯属浪费。
 */

import type { AdapterContext, AdapterRegistry, ChatMessage } from '@l-science/adapters';
import type { ModelDescriptor } from '@l-science/shared';

import type { ArtifactStore } from '../artifact/store.js';
import type { Finding, FindingsRepo, ReviewerTrigger } from '../repo/findings.js';
import type { MessageRepo } from '../repo/conversations.js';
import { classifyFailure, type UsageRepo } from '../repo/usage.js';
import { buildTaskProfile, pickCrossVendor, route } from '../router/index.js';
import type { ExperienceAdjustment, ModelRuntimeState } from '../router/index.js';
import { streamModel } from '../orchestrator/agent-runtime.js';
import { runDeterministicChecks, type ClaimSnapshot, type DraftFinding } from './checks.js';
import { parseReviewOutput } from './parse.js';
import { buildReviewContext, reviewerSystemPrompt, reviewerUserPrompt } from './prompt.js';

export interface ReviewerServiceDeps {
  findings: FindingsRepo;
  artifacts: ArtifactStore;
  messages: MessageRepo;
  adapters: AdapterRegistry;
  adapterContext: (providerId: string) => AdapterContext | null;
  routerView: () => {
    models: readonly ModelDescriptor[];
    runtime: ReadonlyMap<string, ModelRuntimeState>;
  };
  experience?: () => ReadonlyMap<string, ExperienceAdjustment>;
  usage?: UsageRepo;
  /**
   * 未关闭断言的快照（任务 13.4，需求 13.3）。
   *
   * 用回调注入而不是直接吃 `ClaimsRepo`：审查服务在 M3 就定型了，让它依赖 M4 的
   * 仓储会把「审查」与「手稿」两个模块绑在一起，而只有前者是每个部署都需要的。
   * 不提供时跳过断言类检查。
   */
  claims?: (conversationId: string) => readonly ClaimSnapshot[];
  /**
   * 有 FAIL 级发现时调用（需求 11.5）。
   *
   * 服务本身不去中断主 agent：它不持有编排器，而且「打断」的具体动作
   * （中断在跑的回合、还是往下一回合注入）取决于会话此刻的状态，那是上层的事。
   */
  onFail?: (input: {
    conversationId: string;
    findings: readonly Finding[];
  }) => void | Promise<void>;
  /** 每条新发现都通知一次，供 UI 即时显示。 */
  onFinding?: (finding: Finding) => void;
  /** 一次审查结束。degraded 时 detail 里有降级原因。 */
  onRunFinished?: (input: {
    conversationId: string;
    runId: string;
    status: 'done' | 'failed' | 'degraded';
    summary: string;
  }) => void;
  onLog?: (line: string) => void;
  /** 单次审查的墙钟上限。 */
  timeoutMs?: number;
  /** 每次审查最多读多少条消息。 */
  messageLimit?: number;
}

/** 默认单次审查上限。审查是后台任务，但挂住不结束会让 pending 永远不被消费。 */
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MESSAGE_LIMIT = 40;

interface Queued {
  trigger: ReviewerTrigger;
  versionIds: Set<string>;
}

export interface ReviewOutcome {
  runId: string | null;
  status: 'done' | 'failed' | 'degraded' | 'skipped';
  summary: string;
  findings: readonly Finding[];
  /** 模型层被跳过时的原因。确定性层始终会跑。 */
  degradedReason: string | null;
}

export class ReviewerService {
  readonly #deps: ReviewerServiceDeps;
  readonly #timeoutMs: number;
  readonly #messageLimit: number;

  /** 正在跑的审查，按会话。 */
  readonly #running = new Map<string, Promise<ReviewOutcome>>();
  /** 跑完之后要补跑的，按会话合并。 */
  readonly #pending = new Map<string, Queued>();
  /** 已发出中止的会话。用于关闭时收尾。 */
  readonly #controllers = new Map<string, AbortController>();

  #closed = false;

  constructor(deps: ReviewerServiceDeps) {
    this.#deps = deps;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#messageLimit = deps.messageLimit ?? DEFAULT_MESSAGE_LIMIT;

    // 上一次进程留下的 running 记录没人在跑，标掉而不是让它们永远显示「审查中」
    const stale = deps.findings.abandonStaleRuns();
    if (stale > 0) deps.onLog?.(`标记了 ${String(stale)} 条上次未完成的审查记录`);
  }

  get busy(): boolean {
    return this.#running.size > 0;
  }

  /**
   * 排一次审查，立即返回（需求 11.1）。
   *
   * 返回正在跑或刚起的那个 Promise，调用方**可以**await 它（测试与 `user-request`
   * 触发需要），但主对话路径不 await。
   */
  schedule(input: {
    conversationId: string;
    trigger: ReviewerTrigger;
    /** 本轮新增的制品版本。 */
    versionIds?: readonly string[];
  }): Promise<ReviewOutcome> {
    if (this.#closed) {
      return Promise.resolve({
        runId: null,
        status: 'skipped',
        summary: '审查服务已关闭',
        findings: [],
        degradedReason: null,
      });
    }

    const inFlight = this.#running.get(input.conversationId);
    if (inFlight !== undefined) {
      /*
       * 合并而不是排队。
       *
       * 连续三个回合各触发一次审查时，第三次的输入已经包含前两次的全部内容，
       * 前两次纯属重复花钱。合并成一次补跑既省钱，产出也一样完整。
       */
      const queued = this.#pending.get(input.conversationId) ?? {
        trigger: input.trigger,
        versionIds: new Set<string>(),
      };
      // 触发原因取更"重"的那个：user-request 最重，它要求全类别过一遍
      if (input.trigger === 'user-request' || queued.trigger !== 'user-request') {
        queued.trigger = input.trigger;
      }
      for (const id of input.versionIds ?? []) queued.versionIds.add(id);
      this.#pending.set(input.conversationId, queued);
      return inFlight;
    }

    const promise = this.#runAndDrain(input.conversationId, {
      trigger: input.trigger,
      versionIds: new Set(input.versionIds ?? []),
    });
    this.#running.set(input.conversationId, promise);
    return promise;
  }

  /** 跑一次，然后把期间攒下的 pending 消费掉。 */
  async #runAndDrain(conversationId: string, first: Queued): Promise<ReviewOutcome> {
    let outcome: ReviewOutcome;
    let current = first;

    for (;;) {
      try {
        outcome = await this.#runOnce(conversationId, current);
      } catch (err) {
        // 审查失败绝不能把主流程带下去：它是旁路，坏了就记一笔
        const message = err instanceof Error ? err.message : String(err);
        this.#deps.onLog?.(`审查异常（${conversationId}）：${message}`);
        outcome = {
          runId: null,
          status: 'failed',
          summary: `审查执行异常：${message}`,
          findings: [],
          degradedReason: null,
        };
      }

      const next = this.#pending.get(conversationId);
      if (next === undefined || this.#closed) break;
      this.#pending.delete(conversationId);
      current = next;
    }

    this.#running.delete(conversationId);
    return outcome;
  }

  async #runOnce(conversationId: string, queued: Queued): Promise<ReviewOutcome> {
    const messages = this.#deps.messages.page(conversationId, {
      limit: this.#messageLimit,
    }).messages;

    if (messages.length === 0) {
      return {
        runId: null,
        status: 'skipped',
        summary: '会话里还没有内容可审查',
        findings: [],
        degradedReason: null,
      };
    }

    /*
     * 被审查内容是谁生成的。
     *
     * 从最近一条带 providerId 的助手消息取。取不到时异厂商约束无从执行——那说明
     * 这轮没有模型产出（比如纯工具执行），此时也就没有需要异源审查的推理。
     */
    const generator = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.providerId !== null);
    const generatorProviderId = generator?.providerId ?? null;

    /* ---------------- 选模型（需求 11.2）---------------- */

    const view = this.#deps.routerView();
    const routed = route({
      models: view.models,
      profile: buildTaskProfile('reviewer.audit', {
        estimatedInputTokens: 16_000,
        expectedOutputTokens: 2_048,
        needToolUse: false,
      }),
      runtime: view.runtime,
      ...(this.#deps.experience === undefined ? {} : { experience: this.#deps.experience() }),
    });

    const picked =
      generatorProviderId === null
        ? { model: routed.ranked[0] ?? null, degradedReason: null }
        : pickCrossVendor(routed.ranked, generatorProviderId);

    /* ---------------- 确定性层 ---------------- */

    /*
     * 断言快照取一次，确定性层与模型层共用。
     *
     * 取两次的风险是两层看到的断言集合不同：确定性层报了一条无证据断言，而模型层
     * 那份快照里它已经绑上证据了——于是同一次审查里出现自相矛盾的两条结论。
     */
    const claimSnapshots = this.#deps.claims?.(conversationId);

    const deterministic = runDeterministicChecks({
      artifacts: this.#deps.artifacts,
      messages,
      ...(queued.versionIds.size > 0 ? { versionIds: [...queued.versionIds] } : {}),
      ...(claimSnapshots === undefined ? {} : { claims: claimSnapshots }),
    });

    /*
     * 没有模型也要开审查记录。
     *
     * 确定性层的发现同样需要挂在一次运行上，否则它们的 reviewer_run_id 为空，
     * UI 上「本次审查发现了什么」就无从组织。模型 id 用一个显式的占位值而不是
     * 空串——空串会被当成「忘了填」，而这里是「确实没有模型」。
     */
    const run = this.#deps.findings.startRun({
      conversationId,
      trigger: queued.trigger,
      modelId: picked.model?.id ?? 'none:deterministic-only',
    });

    const created: Finding[] = [];
    const notes: string[] = [];

    const record = (draft: DraftFinding): void => {
      try {
        const finding = this.#deps.findings.add({
          conversationId,
          reviewerRunId: run.id,
          severity: draft.severity,
          category: draft.category,
          title: draft.title,
          detail: draft.detail,
          evidence: draft.evidence,
        });
        created.push(finding);
        this.#deps.onFinding?.(finding);
      } catch (err) {
        // evidence 校验失败等于这条发现不该存在，记下原因即可
        notes.push(
          `一条发现写入失败：${err instanceof Error ? err.message : String(err)}（${draft.title}）`,
        );
      }
    };

    // 已有的 open 发现，用于去重：确定性层每轮都会重新算出同样的结论
    const existingTitles = new Set(
      this.#deps.findings.list({ conversationId, status: 'open', limit: 500 }).map((f) => f.title),
    );

    for (const draft of deterministic) {
      if (existingTitles.has(draft.title)) continue;
      record(draft);
      existingTitles.add(draft.title);
    }

    /* ---------------- 模型层 ---------------- */

    if (picked.model === null) {
      const summary = [
        `确定性检查完成，新增 ${String(created.length)} 条发现。`,
        '模型层未执行：' + (picked.degradedReason ?? '没有可用模型。'),
        ...notes,
      ].join('\n');
      this.#deps.findings.finishRun(run.id, { status: 'degraded', summary });
      await this.#announce(conversationId, run.id, 'degraded', summary, created);
      return {
        runId: run.id,
        status: 'degraded',
        summary,
        findings: created,
        degradedReason: picked.degradedReason ?? '没有可用模型',
      };
    }

    const pendingRecheck = this.#deps.findings.list({
      conversationId,
      status: 'claimed-fixed',
      limit: 50,
    });

    const context = buildReviewContext({
      conversationId,
      messages,
      artifacts: this.#deps.artifacts,
      versionIds: [...queued.versionIds],
      pendingRecheck,
      openFindings: this.#deps.findings.list({ conversationId, status: 'open', limit: 100 }),
      ...(claimSnapshots === undefined
        ? {}
        : {
            claims: claimSnapshots.map((c) => ({
              id: c.id,
              text: c.text,
              locator: c.locator,
              status: c.status,
              numbers: c.numbers,
              evidence: c.evidence,
            })),
          }),
    });

    const history: readonly ChatMessage[] = [
      { role: 'system', content: reviewerSystemPrompt() },
      {
        role: 'user',
        content: reviewerUserPrompt({
          trigger: queued.trigger,
          context: context.text,
          deterministic: deterministic.map((d) => d.title),
        }),
      },
    ];

    const controller = new AbortController();
    this.#controllers.set(conversationId, controller);
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();

    const startedAt = Date.now();
    let modelText = '';
    let modelThinking = '';
    let failure: string | null = null;
    let providerStatus: number | undefined;

    try {
      const ctx = this.#deps.adapterContext(picked.model.providerId);
      if (ctx === null) throw new Error(`供应商 ${picked.model.providerId} 未配置`);

      const collected = await streamModel({
        adapter: this.#deps.adapters.get(picked.model.providerId),
        ctx: { ...ctx, pricing: picked.model.pricing },
        model: picked.model,
        history,
        // 审查者不用工具：它读的是已经产出的内容，给它工具只会让它去重跑分析，
        // 那既慢又把「独立审查」变成了「再做一遍」
        toolSchemas: [],
        signal: controller.signal,
        /*
         * 思维模型要给足预算。
         *
         * 实测 qwen3:4b 在默认的 8192 下把全部配额花在思考上，正文一个字都没有——
         * 于是审查结果是空的，而症状看起来像「模型不肯按 JSON 输出」，会把人引去
         * 改提示词。对话回合不需要这么大是因为它可以只说一句话就结束，而结构化
         * 输出必须完整才有用。
         */
        maxOutputTokens: picked.model.features.thinking ? 24_576 : 4_096,
      });

      modelText = collected.text;
      modelThinking = collected.thinking;

      this.#deps.usage?.record({
        conversationId,
        providerId: picked.model.providerId,
        modelId: picked.model.id,
        tokensIn: collected.usage.tokensIn,
        tokensOut: collected.usage.tokensOut,
        cost: collected.usage.cost,
        latencyMs: Date.now() - startedAt,
        status: 'ok',
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number') providerStatus = status;
      this.#deps.usage?.record({
        conversationId,
        providerId: picked.model.providerId,
        modelId: picked.model.id,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - startedAt,
        // 用与主链路相同的分类器，降级链分析里审查调用与对话调用才可比
        status: classifyFailure({
          ...(typeof providerStatus === 'number' ? { status: providerStatus } : {}),
          aborted: controller.signal.aborted,
          message: failure,
        }),
        error: failure,
      });
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(conversationId);
    }

    if (failure !== null) {
      /*
       * 模型层失败但确定性层的发现仍然有效，因此状态是 degraded 而不是 failed——
       * failed 会让 UI 显示「审查没跑」，而实际上跑了一半并且那一半的结论可信。
       */
      const summary = [
        `确定性检查完成，新增 ${String(created.length)} 条发现。`,
        `模型层失败（${picked.model.id}）：${failure}`,
        ...notes,
      ].join('\n');
      this.#deps.findings.finishRun(run.id, { status: 'degraded', summary });
      await this.#announce(conversationId, run.id, 'degraded', summary, created);
      return {
        runId: run.id,
        status: 'degraded',
        summary,
        findings: created,
        degradedReason: failure,
      };
    }

    const parseOptions = {
      allowedMessageIds: context.allowedEvidence.messages,
      allowedVersionIds: context.allowedEvidence.versions,
      allowedClaimIds: context.allowedEvidence.claims,
      recheckableIds: new Set(pendingRecheck.map((f) => f.id)),
    };

    let parsed = parseReviewOutput(modelText, parseOptions);

    /*
     * 正文里没有 JSON 时到思考里再找一遍。
     *
     * 思维模型常常在思考段落里就把结构化答案写完了，然后正文被输出预算截断或干脆
     * 是一句总结。这不是纵容——若答案确实在那里，因为它出现的位置不对而丢掉一整轮
     * 审查是把可用的结论扔了。
     */
    if (parsed.findings.length === 0 && parsed.rechecks.length === 0 && modelThinking !== '') {
      const fromThinking = parseReviewOutput(modelThinking, parseOptions);
      if (fromThinking.findings.length > 0 || fromThinking.rechecks.length > 0) {
        parsed = {
          ...fromThinking,
          rejected: [...parsed.rejected, '（正文里没有可用 JSON，结果取自思考段落）'],
        };
      } else if (modelText.trim() === '') {
        // 两处都没有且正文为空：几乎肯定是输出预算被思考吃光了
        parsed = {
          ...parsed,
          rejected: [
            ...parsed.rejected,
            `模型只产出了思考（${String(modelThinking.length)} 字）没有正文，` +
              '输出预算可能仍然不足',
          ],
        };
      }
    }

    for (const draft of parsed.findings) {
      if (existingTitles.has(draft.title)) continue;
      record(draft);
      existingTitles.add(draft.title);
    }

    /* ---------------- 复核自报已修（需求 11.7）---------------- */

    let resolved = 0;
    let reopened = 0;
    for (const recheck of parsed.rechecks) {
      const note = `复核（${picked.model.id}）：${recheck.note}`;
      if (recheck.verdict === 'resolve') {
        if (this.#deps.findings.resolve(recheck.findingId, note)) resolved += 1;
      } else if (this.#deps.findings.reopen(recheck.findingId, note)) {
        reopened += 1;
      }
    }

    /*
     * 没被判定的待复核项保持 claimed-fixed。
     *
     * 不默认 reopen 也不默认 resolve：前者会让一条真的修好了的发现反复回来，
     * 后者会让审查者的沉默变成放行。保持原状意味着它下一轮还会被送去复核，
     * 而那正是「待复核」这个状态的含义。
     */
    const unjudged = pendingRecheck.length - parsed.rechecks.length;

    const summaryLines = [
      `新增发现 ${String(created.length)} 条` +
        `（阻断 ${String(created.filter((f) => f.severity === 'fail').length)}）。`,
      pendingRecheck.length === 0
        ? ''
        : `复核 ${String(pendingRecheck.length)} 条自报已修：确认 ${String(resolved)}，打回 ${String(reopened)}` +
          (unjudged > 0 ? `，${String(unjudged)} 条审查者未表态，仍待复核。` : '。'),
      picked.degradedReason === null ? '' : `降级：${picked.degradedReason}`,
      parsed.rejected.length === 0
        ? ''
        : `模型给出但被丢弃 ${String(parsed.rejected.length)} 条：${parsed.rejected.join('；')}`,
      ...notes,
    ].filter((s) => s !== '');

    const summary = summaryLines.join('\n');
    const status = picked.degradedReason === null ? 'done' : 'degraded';
    this.#deps.findings.finishRun(run.id, { status, summary });
    await this.#announce(conversationId, run.id, status, summary, created);

    return {
      runId: run.id,
      status,
      summary,
      findings: created,
      degradedReason: picked.degradedReason,
    };
  }

  /** 通知上层：运行结束，以及是否有 FAIL 需要打断（需求 11.5）。 */
  async #announce(
    conversationId: string,
    runId: string,
    status: 'done' | 'failed' | 'degraded',
    summary: string,
    created: readonly Finding[],
  ): Promise<void> {
    this.#deps.onRunFinished?.({ conversationId, runId, status, summary });

    const blocking = created.filter((f) => f.severity === 'fail');
    if (blocking.length === 0) return;

    try {
      await this.#deps.onFail?.({ conversationId, findings: blocking });
    } catch (err) {
      // 打断动作失败不该让审查记录变成失败：发现已经落库了，它们不会丢
      this.#deps.onLog?.(
        `FAIL 通知失败（${conversationId}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 关闭服务。在跑的审查被中止，pending 丢弃。 */
  close(): void {
    this.#closed = true;
    this.#pending.clear();
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }
}
