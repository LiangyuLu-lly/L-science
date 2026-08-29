/**
 * 会话编排器（任务 8.5.1-8.5.3）。
 *
 * agent 循环：模型产出工具调用 → 执行 → 结果回灌 → 继续，直到模型不再要求
 * 工具，或撞上回合上限。
 *
 * 三条贯穿的判断：
 *
 * 1. **回合上限必须存在且必须可解释。** 没有上限的循环在模型陷入「调用失败 →
 *    重试 → 同样失败」时会一直烧钱，而用户看到的只是界面在转。撞上限时如实
 *    报告「任务未完成，因为达到了回合上限」，而不是伪装成正常结束——后者会让
 *    用户以为 agent 认为做完了。
 * 2. **中断保留已产出的内容。** 用户中断是因为不想等了，不是因为要撤销。把
 *    已经跑出来的分析结果丢掉是在惩罚他行使中断权。
 * 3. **每一步都落库再推事件。** 反过来的话，UI 显示了某条消息但进程随后崩溃，
 *    重新打开时它消失了——用户会怀疑自己看到的东西是不是真的发生过。
 */

import type {
  ModelDescriptor,
  RoutingOverride,
  TaskType,
  ToolOutput,
  TurnEvent,
  Usage,
} from '@l-science/shared';
import type { AdapterContext, AdapterRegistry, ChatMessage } from '@l-science/adapters';

import type { ConversationRepo, MessageRepo, ToolCallRepo } from '../repo/conversations.js';
import type { ConversationStatus } from '../repo/conversations.js';
import type { RoutingRepo } from '../repo/routing.js';
import { classifyFailure, type UsageRepo } from '../repo/usage.js';
import { buildTaskProfile, route, type ModelRuntimeState } from '../router/index.js';
import type { ExperienceAdjustment } from '../router/index.js';
import { ToolRegistry } from '../tools/index.js';
import { executeToolCall, streamModel } from './agent-runtime.js';
import type { SubAgentRunner } from './subagent.js';
import {
  ConversationBusyError,
  IllegalTransitionError,
  canTransition,
  type TurnSummary,
} from './types.js';

/** 默认回合上限。见文件头对「必须存在」的说明。 */
const DEFAULT_MAX_TURNS = 24;

export interface OrchestratorDeps {
  conversations: ConversationRepo;
  messages: MessageRepo;
  toolCalls: ToolCallRepo;
  tools: ToolRegistry;
  adapters: AdapterRegistry;
  /**
   * 用量记录（需求 18.1）。可选是为了让单元测试不必都建一个库，
   * 但生产路径必须提供——不提供意味着成本无从核算。
   */
  usage?: UsageRepo;
  /** 路由决策落库（需求 7.6、18.3）。 */
  routing?: RoutingRepo;
  /** 取当前可用模型与运行时状态。通常接 buildRouterView。 */
  routerView: () => {
    models: readonly ModelDescriptor[];
    runtime: ReadonlyMap<string, ModelRuntimeState>;
  };
  /** 按供应商 id 取适配器上下文（含解密后的凭据）。 */
  adapterContext: (providerId: string) => AdapterContext | null;
  /** 经验修正表，供路由打分使用。 */
  experience?: () => ReadonlyMap<string, ExperienceAdjustment>;
  /** 会话工作目录。工具的相对路径以此为基准。 */
  workspaceDir: (conversationId: string) => string;
  /** 系统提示词。 */
  systemPrompt?: (conversationId: string) => string;
  /**
   * 用户在输入框里显式指定的技能，取其注入内容（任务 12.16，需求 9.5、9.8）。
   *
   * 存在的理由是「显式」这两个字：让模型自己去 `search_skills` 加载是**不保证**的，
   * 它可能判断用不上，于是用户点了技能却什么也没发生，而界面上看不出区别。
   * 这里在回合开始时直接把内容放进历史。
   *
   * 返回值里的 `missing` 是那些点了但找不到的 slug——静默忽略会让用户以为已经生效。
   */
  explicitSkills?: (input: { conversationId: string; slugs: readonly string[] }) => {
    injections: ReadonlyArray<{ slug: string; name: string; content: string }>;
    missing: readonly string[];
  };
  maxTurns?: number;
  /**
   * 项目 id，透传进 ToolContext。
   *
   * 此前这里恒为空串——没有工具用到它，所以没人发现。留着空串是个定时炸弹：
   * 第一个真的按项目分流的工具会拿到空串然后去找一个不存在的项目。
   */
  projectId?: string;
  /** 子 agent 委派（需求 10.5-10.7）。缺省时 delegate 工具不注册。 */
  subAgents?: SubAgentRunner;
  /**
   * 回合结束回调（需求 11.3 的「轮次结束」触发点）。
   *
   * 在摘要落库之后、`turn.end` 事件之前调用，且**必须立即返回**——审查是后台任务，
   * 在这里 await 它等于让用户多等几十秒看不到回合结束。
   *
   * 中断结束的回合也会回调：中断之前产出的分析结果照样需要被审查，用户中断的是
   * 等待而不是已经算出来的东西。
   */
  onTurnEnd?: (input: {
    conversationId: string;
    stopReason: TurnSummary['stopReason'];
    toolCalls: number;
  }) => void;
}

interface ActiveTurn {
  controller: AbortController;
  startedAt: number;
}

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #maxTurns: number;

  /** 正在进行的回合。一个会话同时只允许一个。 */
  readonly #active = new Map<string, ActiveTurn>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  /** 会话是否正在跑一个回合。 */
  isActive(conversationId: string): boolean {
    return this.#active.has(conversationId);
  }

  /**
   * 迁移会话状态。非法迁移抛错而不是静默修正。
   *
   * 静默修正会让状态机形同虚设：一个本该被发现的逻辑错误变成了一个状态值
   * 不符预期的运行时现象，而那个现象要等到某个依赖状态的判断出错时才暴露。
   */
  #setStatus(conversationId: string, to: ConversationStatus): void {
    const current = this.#deps.conversations.get(conversationId);
    if (current === null) throw new Error(`会话不存在：${conversationId}`);
    if (!canTransition(current.status, to)) {
      throw new IllegalTransitionError(current.status, to);
    }
    this.#deps.conversations.setStatus(conversationId, to);
  }

  /**
   * 开始一个回合，产出增量事件。
   *
   * 返回 AsyncIterable 而不是 Promise：调用方需要边跑边把事件推给渲染层，
   * 等整个回合结束再一次性返回会让流式输出这个核心体验消失。
   */
  startTurn(
    conversationId: string,
    userText: string,
    routing: RoutingOverride = {},
    explicitSkillSlugs: readonly string[] = [],
  ): AsyncIterable<TurnEvent> {
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation === null) throw new Error(`会话不存在：${conversationId}`);
    if (this.#active.has(conversationId)) {
      throw new ConversationBusyError(conversationId, conversation.status);
    }
    if (conversation.status !== 'idle') {
      throw new ConversationBusyError(conversationId, conversation.status);
    }

    /*
     * 副作用在这里同步做完，不放进 generator 体内。
     *
     * async generator 的函数体在首次 next() 之前不执行。把「登记活跃回合」与
     * 「用户消息落库」写在里面，两件事都会变成懒执行：
     *
     * - 忙检查形同虚设。调用方拿到迭代器还没开始消费时，#active 仍是空的，
     *   第二次 startTurn 会被放行，于是同一会话上跑起两个回合，状态机被两条
     *   路径同时改写。
     * - 用户消息在开始消费前不存在。若此刻进程崩溃或调用方忘了消费，
     *   用户说过的话就没了。
     */
    const controller = new AbortController();
    this.#active.set(conversationId, { controller, startedAt: Date.now() });

    const userMessage = this.#deps.messages.append({
      conversationId,
      role: 'user',
      content: { kind: 'text', text: userText },
    });

    return this.#runTurn(
      conversationId,
      userText,
      controller,
      userMessage.id,
      routing,
      explicitSkillSlugs,
    );
  }

  /**
   * 中断会话。
   *
   * 只 abort 信号，不做清理——清理由 `#runTurn` 的 finally 负责。在这里同时
   * 清理会造成双份收尾：状态被设两次、事件被推两次，而第二次的状态迁移
   * 必然非法（idle → idle 虽然允许，但如果第一次设成了别的就会抛错）。
   */
  async interrupt(conversationId: string): Promise<boolean> {
    /*
     * 阻塞式子 agent 随中断一起取消，非阻塞的不动（需求 10.7）。
     *
     * 这一步放在活跃回合检查**之前**：非阻塞子 agent 可能在主回合已经结束之后
     * 仍在跑，此时 `#active` 里没有条目，但用户点停止的意图显然包含「把还在等的
     * 那些停掉」。而非阻塞的刻意留着——它们是用户显式转后台的，一次中断不该把
     * 两小时的作业杀掉，这与「会话中断不取消后台任务」是同一条取舍。
     */
    const cancelled = this.#deps.subAgents?.cancelBlocking(conversationId, '用户中断了会话') ?? 0;

    const active = this.#active.get(conversationId);
    if (active === undefined) return cancelled > 0;
    active.controller.abort();
    return true;
  }

  /**
   * 后台任务完成后注入结果。
   *
   * 不直接开新回合：用户可能正在打字，突然插入一轮 agent 输出会打断他。
   * 这里只把结果作为一条消息落库并返回事件，由上层决定要不要触发后续处理。
   */
  deliverNotification(
    conversationId: string,
    note: { label: string; output: ToolOutput; durationMs: number },
  ): TurnEvent {
    const text =
      note.output.kind === 'text'
        ? note.output.text
        : note.output.kind === 'error'
          ? `${note.output.ename}: ${note.output.evalue}`
          : '（富输出）';

    this.#deps.messages.append({
      conversationId,
      role: 'system',
      content: {
        kind: 'background-notice',
        label: note.label,
        durationMs: note.durationMs,
        text,
      },
    });

    return {
      kind: 'tool.output',
      callId: `bg_${note.label}`,
      output: note.output,
    };
  }

  /* ---------------- agent 循环 ---------------- */

  async *#runTurn(
    conversationId: string,
    userText: string,
    controller: AbortController,
    userMessageId: string,
    routing: RoutingOverride,
    explicitSkillSlugs: readonly string[] = [],
  ): AsyncGenerator<TurnEvent> {
    const summary: TurnSummary = {
      stopReason: 'end-turn',
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      currency: 'USD',
      detail: null,
    };

    /*
     * 用户显式指定的技能（需求 9.5）。
     *
     * 放在 user 消息**之前**：技能是做这件事的方法，先给方法再给任务，与
     * 「先检索技能再动手」的次序一致。放在之后会让模型先看到任务、已经开始规划，
     * 再读到一份可能与它的规划冲突的方法学。
     */
    const explicit =
      explicitSkillSlugs.length === 0 || this.#deps.explicitSkills === undefined
        ? { injections: [], missing: [] as readonly string[] }
        : this.#deps.explicitSkills({ conversationId, slugs: explicitSkillSlugs });

    // 对话历史。工具结果以 role='tool' 回灌，模型据此继续
    const history: ChatMessage[] = [
      ...(this.#deps.systemPrompt === undefined
        ? []
        : [{ role: 'system' as const, content: this.#deps.systemPrompt(conversationId) }]),
      ...explicit.injections.map((injection) => ({
        role: 'system' as const,
        content:
          `用户在这条消息里显式指定了下面这个技能，**按它的方法做**。` +
          `如果它与你原本的打算冲突，以它为准，或者明确说出冲突在哪再问用户。\n\n${injection.content}`,
      })),
      ...(explicit.missing.length === 0
        ? []
        : [
            {
              role: 'system' as const,
              // 静默忽略会让用户以为技能已经生效
              content:
                `用户指定的这些技能没找到或已被禁用：${explicit.missing.join('、')}。` +
                '在回答里说明这一点，不要假装用了它们。',
            },
          ]),
      { role: 'user' as const, content: userText },
    ];

    try {
      this.#setStatus(conversationId, 'executing');

      for (let turn = 0; turn < this.#maxTurns; turn += 1) {
        if (controller.signal.aborted) {
          summary.stopReason = 'interrupted';
          break;
        }

        summary.turns = turn + 1;

        const step = await this.#runModelStep({
          conversationId,
          history,
          signal: controller.signal,
          userMessageId,
          routing,
        });

        // 路由决策也是事件：用户需要能看到为什么选了这个模型
        if (step.decisionEvent !== null) yield step.decisionEvent;

        if (step.kind === 'no-model') {
          summary.stopReason = 'no-model';
          summary.detail = step.detail;
          break;
        }

        for (const event of step.events) yield event;

        summary.tokensIn += step.usage.tokensIn;
        summary.tokensOut += step.usage.tokensOut;
        summary.cost += step.usage.cost;
        summary.currency = step.usage.currency;

        if (step.kind === 'error') {
          summary.stopReason = 'error';
          summary.detail = step.detail;
          break;
        }

        if (step.kind === 'content-filter') {
          // 安全边界，不重试不换模型（需求 7.8）
          summary.stopReason = 'content-filter';
          summary.detail = step.detail;
          break;
        }

        if (step.toolCalls.length === 0) {
          summary.stopReason = 'end-turn';
          break;
        }

        /*
         * 有工具调用：执行并把结果回灌，然后进入下一轮。
         *
         * assistant 消息必须带上 toolCalls。协议规定 role:'tool' 的消息必须紧跟
         * 在声明了 tool_calls 的 assistant 消息之后——缺了它，服务端以 400
         * 拒收，而症状是「第一轮工具调用正常、回灌后第二轮直接失败」，
         * 看起来像模型不愿继续而不是历史结构不对。
         */
        history.push({
          role: 'assistant',
          content: step.text,
          toolCalls: step.toolCalls,
        });

        for (const call of step.toolCalls) {
          if (controller.signal.aborted) {
            summary.stopReason = 'interrupted';
            break;
          }

          summary.toolCalls += 1;
          yield { kind: 'tool.start', callId: call.id, tool: call.name, input: call.argumentsJson };

          const outcome = await this.#executeTool({
            conversationId,
            messageId: userMessageId,
            call,
            signal: controller.signal,
            // 哪个模型发起的这次调用。需要记录「是谁做的判断」的工具靠它
            // （需求 13.4）。不能让工具从入参里接受，那等于让模型自报身份
            modelId: step.modelId,
          });

          yield { kind: 'tool.output', callId: call.id, output: outcome.output };

          history.push({
            role: 'tool',
            content: outcome.forModel,
            toolCallId: call.id,
          });
        }

        if (summary.stopReason === 'interrupted') break;

        // 撞上限时不静默停止
        if (turn === this.#maxTurns - 1) {
          summary.stopReason = 'max-turns';
          summary.detail =
            `已执行 ${String(this.#maxTurns)} 轮模型调用仍未完成，为避免无限循环而停止。` +
            '任务**没有完成**。可以看看上面的工具输出判断卡在哪一步，然后给出更具体的指示。';
        }
      }
    } catch (err) {
      summary.stopReason = 'error';
      summary.detail = err instanceof Error ? err.message : String(err);
    } finally {
      this.#active.delete(conversationId);
      // 无论怎么结束都回到 idle。不回的话会话永久卡在 executing，
      // 用户再也发不出消息，而且重启后状态仍然是错的
      try {
        this.#deps.conversations.setStatus(conversationId, 'idle');
      } catch {
        // 会话可能已被删除，此时无需处理
      }
    }

    // 中断时已产出的内容必须保留：用户中断是因为不想等了，不是要撤销
    this.#persistSummary(conversationId, summary);

    /*
     * 触发回合结束审查（需求 11.3）。
     *
     * 包在 try 里：审查是旁路，它的调度失败不该让一个已经跑完的回合以异常收场——
     * 那会让用户丢掉刚产出的结果，而原因只是一个通知没送出去。
     */
    try {
      this.#deps.onTurnEnd?.({
        conversationId,
        stopReason: summary.stopReason,
        toolCalls: summary.toolCalls,
      });
    } catch {
      // 上层自己记日志；这里不能让它影响回合收尾
    }

    yield {
      kind: 'turn.end',
      usage: {
        tokensIn: summary.tokensIn,
        tokensOut: summary.tokensOut,
        cost: summary.cost,
        currency: summary.currency,
      },
    };
  }

  /* ---------------- 单次模型调用 ---------------- */

  async #runModelStep(input: {
    conversationId: string;
    history: readonly ChatMessage[];
    signal: AbortSignal;
    userMessageId: string;
    routing: RoutingOverride;
  }): Promise<
    | { kind: 'no-model'; detail: string; decisionEvent: TurnEvent | null }
    | {
        kind: 'ok' | 'error' | 'content-filter';
        detail: string;
        text: string;
        toolCalls: ReadonlyArray<{ id: string; name: string; argumentsJson: string }>;
        events: readonly TurnEvent[];
        usage: Usage;
        decisionEvent: TurnEvent | null;
        /**
         * 实际执行本步的模型。
         *
         * 透传进 `ToolContext.modelId`，供需要记录「是谁做的判断」的工具使用
         * （需求 13.4 要求 Claim Ledger 的核验结论带模型标识）。不能让工具从
         * 入参里接受这个值——那等于让模型自报身份，而这一列的用途正是事后
         * 判断结论的可信度。降级链走到第二个模型时这里是第二个模型的 id，
         * 因为它才是真正干活的那个。
         */
        modelId: string | null;
      }
  > {
    const emptyUsage: Usage = { tokensIn: 0, tokensOut: 0, cost: 0, currency: 'USD' };
    const view = this.#deps.routerView();
    const toolSchemas = this.#deps.tools.toolSchemas();

    // 估算 token 用于硬过滤的上下文检查。按 4 字符 1 token 粗估——
    // 中文实际更接近 1.5 字符 1 token，因此这个估算对中文偏低。
    // 偏低的方向是安全的：它只会让路由选一个窗口更大的模型
    const historyChars = input.history.reduce((n, m) => n + m.content.length, 0);
    const override = input.routing;

    /*
     * 用户的覆盖优先于推断（需求 7.14）。
     *
     * 任务类型也允许覆盖：`inferTaskType` 是关键词匹配，覆盖率有限（它会漏掉
     * 「做个柱状图」这类说法）。用户明确说了这是什么任务时，猜测就不该再参与。
     */
    const profile = buildTaskProfile(override.taskType ?? inferTaskType(input.history), {
      estimatedInputTokens: Math.ceil(historyChars / 3),
      expectedOutputTokens: 4096,
      needToolUse: toolSchemas.length > 0,
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

    const routed = route({
      models: view.models,
      profile,
      runtime: view.runtime,
      ...(this.#deps.experience === undefined ? {} : { experience: this.#deps.experience() }),
      ...(override.forcedModelId === undefined ? {} : { forcedModelId: override.forcedModelId }),
    });

    const decisionEvent: TurnEvent = { kind: 'routing.decision', decision: routed.decision };

    // 决策先落库再执行。反过来的话，模型调用崩溃时决策记录就没了，
    // 而那恰恰是最需要事后追溯的情况
    this.#deps.routing?.record(routed.decision, {
      conversationId: input.conversationId,
      messageId: input.userMessageId,
    });

    if (routed.decision.chosenModelId === null) {
      return {
        kind: 'no-model',
        detail: routed.emptyReport ?? '没有可用模型',
        decisionEvent,
      };
    }

    // 降级链：按得分降序跨供应商重试（需求 7.7）
    const chain = routed.ranked;
    let lastError = '';

    for (const model of chain) {
      if (input.signal.aborted) {
        return {
          modelId: model.id,
          kind: 'error',
          detail: '已中断',
          text: '',
          toolCalls: [],
          events: [],
          usage: emptyUsage,
          decisionEvent,
        };
      }

      const ctx = this.#deps.adapterContext(model.providerId);
      if (ctx === null) {
        lastError = `供应商 ${model.providerId} 未配置`;
        continue;
      }

      let adapter;
      try {
        adapter = this.#deps.adapters.get(model.providerId);
      } catch {
        lastError = `供应商 ${model.providerId} 没有对应的适配器`;
        continue;
      }

      // 延迟要实测而不是取模型描述里的先验值：先验用于路由打分，
      // 而用量记录的价值恰恰在于反映真实表现
      const startedAt = Date.now();

      try {
        const collected = await this.#streamModel({
          adapter,
          ctx: { ...ctx, pricing: model.pricing },
          model,
          history: input.history,
          toolSchemas,
          signal: input.signal,
        });

        this.#deps.usage?.record({
          conversationId: input.conversationId,
          providerId: model.providerId,
          modelId: model.id,
          tokensIn: collected.usage.tokensIn,
          tokensOut: collected.usage.tokensOut,
          cost: collected.usage.cost,
          latencyMs: Date.now() - startedAt,
          status: collected.stopReason === 'content_filter' ? 'content-filtered' : 'ok',
        });

        // 落库：助手消息带上用了哪个模型，用量核算与事后追溯都要它
        this.#deps.messages.append({
          conversationId: input.conversationId,
          role: 'assistant',
          content: {
            kind: 'text',
            text: collected.text,
            thinking: collected.thinking === '' ? undefined : collected.thinking,
          },
          modelId: model.id,
          providerId: model.providerId,
          usage: collected.usage,
        });

        if (collected.stopReason === 'content_filter') {
          return {
            modelId: model.id,
            kind: 'content-filter',
            detail:
              '供应商以内容安全为由拒绝了这次请求。这是安全边界而不是故障，' +
              '因此没有更换模型或改写提示词重试。',
            text: collected.text,
            toolCalls: [],
            events: collected.events,
            usage: collected.usage,
            decisionEvent,
          };
        }

        return {
          modelId: model.id,
          kind: 'ok',
          detail: '',
          text: collected.text,
          toolCalls: collected.toolCalls,
          events: collected.events,
          usage: collected.usage,
          decisionEvent,
        };
      } catch (err) {
        const providerError = err as {
          retryable?: boolean;
          isContentFilter?: boolean;
          message?: string;
          status?: number;
        };
        lastError = providerError.message ?? String(err);

        /*
         * 失败也记一条（需求 18.3）。只记成功的调用会让降级链分析无从下手：
         * 「为什么这个供应商老是被降级掉」需要失败次数与失败类别，而那些数据
         * 在只记成功的表里根本不存在。
         *
         * token 与成本记 0：请求失败时供应商通常不计费，而记一个猜测值会让成本
         * 汇总失准——宁可少算也不要凭空加。
         */
        this.#deps.usage?.record({
          conversationId: input.conversationId,
          providerId: model.providerId,
          modelId: model.id,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          latencyMs: Date.now() - startedAt,
          status: classifyFailure({
            ...(providerError.status === undefined ? {} : { status: providerError.status }),
            ...(providerError.isContentFilter === undefined
              ? {}
              : { isContentFilter: providerError.isContentFilter }),
            aborted: input.signal.aborted,
            message: lastError,
          }),
          // 原文传进去，UsageRepo 在写入前脱敏——读取时脱敏意味着敏感内容
          // 已经落盘，而落盘的东西会被备份、导出、贴进 issue
          error: lastError,
        });

        // 内容安全拒答绝不换模型绕过（需求 7.8）
        if (providerError.isContentFilter === true) {
          return {
            modelId: model.id,
            kind: 'content-filter',
            detail: `供应商以内容安全为由拒绝：${lastError}。不会更换模型重试。`,
            text: '',
            toolCalls: [],
            events: [],
            usage: emptyUsage,
            decisionEvent,
          };
        }

        // 不可重试的失败换模型也一样错
        if (providerError.retryable === false) {
          return {
            modelId: model.id,
            kind: 'error',
            detail: lastError,
            text: '',
            toolCalls: [],
            events: [],
            usage: emptyUsage,
            decisionEvent,
          };
        }
        // 可重试：继续降级到下一个模型
      }
    }

    return {
      modelId: null,
      kind: 'error',
      detail: `全部 ${String(chain.length)} 个候选模型都失败了。最后一个错误：${lastError}`,
      text: '',
      toolCalls: [],
      events: [],
      usage: emptyUsage,
      decisionEvent,
    };
  }

  /** 消费适配器的增量流，收集文本、思考与工具调用。 */
  async #streamModel(input: {
    adapter: ReturnType<AdapterRegistry['get']>;
    ctx: AdapterContext;
    model: ModelDescriptor;
    history: readonly ChatMessage[];
    toolSchemas: ReturnType<ToolRegistry['toolSchemas']>;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    thinking: string;
    toolCalls: ReadonlyArray<{ id: string; name: string; argumentsJson: string }>;
    usage: Usage;
    stopReason: string;
    events: readonly TurnEvent[];
  }> {
    // 实现在 agent-runtime.ts，与子 agent 共用
    return streamModel(input);
  }

  /* ---------------- 工具执行 ---------------- */

  async #executeTool(input: {
    conversationId: string;
    messageId: string;
    call: { id: string; name: string; argumentsJson: string };
    signal: AbortSignal;
    modelId?: string | null;
  }): Promise<{ output: ToolOutput; forModel: string }> {
    // 实现在 agent-runtime.ts，与子 agent 共用
    return executeToolCall({
      tools: this.#deps.tools,
      toolCalls: this.#deps.toolCalls,
      messageId: input.messageId,
      call: input.call,
      ctx: {
        projectId: this.#deps.projectId ?? '',
        conversationId: input.conversationId,
        workspaceDir: this.#deps.workspaceDir(input.conversationId),
        signal: input.signal,
        ...(input.modelId === undefined || input.modelId === null
          ? {}
          : { modelId: input.modelId }),
      },
    });
  }

  /** 把回合摘要落库。撞上限或出错时的说明必须留下来。 */
  #persistSummary(conversationId: string, summary: TurnSummary): void {
    // 正常结束不额外写消息：助手消息本身就是结果，再加一条摘要是噪声
    if (summary.stopReason === 'end-turn') return;

    this.#deps.messages.append({
      conversationId,
      role: 'system',
      content: {
        kind: 'turn-summary',
        stopReason: summary.stopReason,
        turns: summary.turns,
        toolCalls: summary.toolCalls,
        detail: summary.detail,
      },
      usage: {
        tokensIn: summary.tokensIn,
        tokensOut: summary.tokensOut,
        cost: summary.cost,
        currency: summary.currency,
      },
    });
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/*
 * `toolOutputForModel` 与 `truncateForModel` 已移到 agent-runtime.ts，
 * 与子 agent 共用一份实现——两份的行为分歧会让子 agent 在某些失败上的表现与
 * 主 agent 不同，而那种差异极难被注意到，因为两边都「能跑」。
 */
export { toolOutputForModel, truncateForModel } from './agent-runtime.js';

/**
 * 从对话历史粗略推断任务类型。
 *
 * 这是 M1 的占位实现：真正的分类应该由一次 `route.classify` 的模型调用完成，
 * 但那会给每个回合多加一次调用与一次延迟。关键词匹配在明确表达意图的情况下
 * 够用，认不出时退到 `analysis.codegen`——它的权重形状（重代码与推理、
 * 对成本中等敏感）在通用场景下不会明显选错。
 *
 * 刻意不猜 `citation.verify` 或 `reviewer.audit`：这两个任务的权重极端
 * （前者压倒性看重引文可靠性），猜错的代价比退到通用档大。
 */
export function inferTaskType(history: readonly ChatMessage[]): TaskType {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const text = (lastUser?.content ?? '').toLowerCase();

  if (/润色|polish|改写|rewrite|语言|grammar/.test(text)) return 'manuscript.polish';
  if (/翻译|translate/.test(text)) return 'manuscript.translate';
  if (/写.*(引言|讨论|摘要|方法)|draft|起草|introduction|discussion/.test(text)) {
    return 'manuscript.draft';
  }
  if (/统计|显著|p 值|p-value|anova|回归|regression|检验|test/.test(text)) return 'stats.reason';

  // 中文的动宾常被量词隔开——「画一张箱线图」里「画」与「图」中间夹了三个字，
  // 写成 /画图/ 匹配不到，而这是最自然的说法。因此允许中间跨若干字，
  // 并直接认常见图种名。
  //
  // 这个模式的覆盖是有限的，补关键词是无底洞（调试时就漏了「做」和「柱状」）。
  // 真正的解法是 route.classify 那次模型调用，见函数头的说明
  if (
    /[画绘作做制].{0,6}图|绘制|plot|figure|可视化|visuali|箱线|散点|直方|热图|折线|柱状|小提琴|饼图/.test(
      text,
    )
  ) {
    return 'figure.compose';
  }

  if (/筛|screen|摘要.*文献|literature/.test(text)) return 'literature.screen';
  if (/审稿|review|评审/.test(text)) return 'review.simulate';

  return 'analysis.codegen';
}
