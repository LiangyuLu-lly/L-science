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

import type { ModelDescriptor, TaskType, ToolOutput, TurnEvent, Usage } from '@l-science/shared';
import type { AdapterContext, AdapterRegistry, ChatMessage, ChatChunk } from '@l-science/adapters';

import type { ConversationRepo, MessageRepo, ToolCallRepo } from '../repo/conversations.js';
import type { ConversationStatus } from '../repo/conversations.js';
import { buildTaskProfile, route, type ModelRuntimeState } from '../router/index.js';
import type { ExperienceAdjustment } from '../router/index.js';
import { ToolInputError, ToolRegistry, ToolUnavailableError } from '../tools/index.js';
import type { ToolContext } from '../tools/index.js';
import {
  ConversationBusyError,
  IllegalTransitionError,
  canTransition,
  type TurnSummary,
} from './types.js';

/** 默认回合上限。见文件头对「必须存在」的说明。 */
const DEFAULT_MAX_TURNS = 24;

/** 单个工具输出回灌给模型时的字符上限。 */
const MAX_TOOL_OUTPUT_CHARS = 40_000;

export interface OrchestratorDeps {
  conversations: ConversationRepo;
  messages: MessageRepo;
  toolCalls: ToolCallRepo;
  tools: ToolRegistry;
  adapters: AdapterRegistry;
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
  maxTurns?: number;
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
  startTurn(conversationId: string, userText: string): AsyncIterable<TurnEvent> {
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

    return this.#runTurn(conversationId, userText, controller, userMessage.id);
  }

  /**
   * 中断会话。
   *
   * 只 abort 信号，不做清理——清理由 `#runTurn` 的 finally 负责。在这里同时
   * 清理会造成双份收尾：状态被设两次、事件被推两次，而第二次的状态迁移
   * 必然非法（idle → idle 虽然允许，但如果第一次设成了别的就会抛错）。
   */
  async interrupt(conversationId: string): Promise<boolean> {
    const active = this.#active.get(conversationId);
    if (active === undefined) return false;
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

    // 对话历史。工具结果以 role='tool' 回灌，模型据此继续
    const history: ChatMessage[] = [
      ...(this.#deps.systemPrompt === undefined
        ? []
        : [{ role: 'system' as const, content: this.#deps.systemPrompt(conversationId) }]),
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
      }
  > {
    const emptyUsage: Usage = { tokensIn: 0, tokensOut: 0, cost: 0, currency: 'USD' };
    const view = this.#deps.routerView();
    const toolSchemas = this.#deps.tools.toolSchemas();

    // 估算 token 用于硬过滤的上下文检查。按 4 字符 1 token 粗估——
    // 中文实际更接近 1.5 字符 1 token，因此这个估算对中文偏低。
    // 偏低的方向是安全的：它只会让路由选一个窗口更大的模型
    const historyChars = input.history.reduce((n, m) => n + m.content.length, 0);
    const profile = buildTaskProfile(inferTaskType(input.history), {
      estimatedInputTokens: Math.ceil(historyChars / 3),
      expectedOutputTokens: 4096,
      needToolUse: toolSchemas.length > 0,
    });

    const routed = route({
      models: view.models,
      profile,
      runtime: view.runtime,
      ...(this.#deps.experience === undefined ? {} : { experience: this.#deps.experience() }),
    });

    const decisionEvent: TurnEvent = { kind: 'routing.decision', decision: routed.decision };

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

      try {
        const collected = await this.#streamModel({
          adapter,
          ctx: { ...ctx, pricing: model.pricing },
          model,
          history: input.history,
          toolSchemas,
          signal: input.signal,
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
        };
        lastError = providerError.message ?? String(err);

        // 内容安全拒答绝不换模型绕过（需求 7.8）
        if (providerError.isContentFilter === true) {
          return {
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
    const events: TurnEvent[] = [];
    const toolCalls: Array<{ id: string; name: string; argumentsJson: string }> = [];
    let text = '';
    let thinking = '';
    let usage: Usage = { tokensIn: 0, tokensOut: 0, cost: 0, currency: 'USD' };
    let stopReason = 'end_turn';

    // 输出上限要为思维模式留余量。thinking 模型先消耗配额做思考再产出答案，
    // 给太小会得到一堆思考而正文为空
    const maxOutputTokens = Math.min(
      model_maxOutput(input.model),
      input.model.features.thinking ? 8192 : 4096,
    );

    const stream = input.adapter.chat(input.ctx, {
      modelName: input.model.id,
      messages: input.history,
      ...(input.toolSchemas.length > 0
        ? {
            tools: input.toolSchemas.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      maxOutputTokens,
      stream: true,
      signal: input.signal,
    });

    for await (const chunk of stream as AsyncIterable<ChatChunk>) {
      switch (chunk.kind) {
        case 'text': {
          text += chunk.text;
          events.push({ kind: 'text.delta', text: chunk.text });
          break;
        }
        case 'thinking': {
          thinking += chunk.text;
          events.push({ kind: 'thinking.delta', text: chunk.text });
          break;
        }
        case 'tool_call': {
          toolCalls.push({ id: chunk.id, name: chunk.name, argumentsJson: chunk.argumentsJson });
          break;
        }
        case 'done': {
          usage = chunk.usage;
          stopReason = chunk.stopReason;
          break;
        }
      }
    }

    return { text, thinking, toolCalls, usage, stopReason, events };
  }

  /* ---------------- 工具执行 ---------------- */

  async #executeTool(input: {
    conversationId: string;
    messageId: string;
    call: { id: string; name: string; argumentsJson: string };
    signal: AbortSignal;
  }): Promise<{ output: ToolOutput; forModel: string }> {
    const record = this.#deps.toolCalls.start({
      messageId: input.messageId,
      toolName: input.call.name,
      input: input.call.argumentsJson,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.call.argumentsJson);
    } catch {
      // 参数不是合法 JSON 说明适配器的分片累积出了问题，或模型产出了畸形参数。
      // 这个错误要如实回灌，让模型知道是它的参数格式问题而不是工具坏了
      const message =
        `工具参数不是合法的 JSON：${input.call.argumentsJson.slice(0, 200)}。` +
        '请重新生成完整、合法的 JSON 参数。';
      this.#deps.toolCalls.finish(record.id, { status: 'error', output: message });
      return {
        output: { kind: 'error', ename: 'InvalidToolArguments', evalue: message, traceback: [] },
        forModel: message,
      };
    }

    const ctx: ToolContext = {
      projectId: '',
      conversationId: input.conversationId,
      workspaceDir: this.#deps.workspaceDir(input.conversationId),
      signal: input.signal,
    };

    try {
      const result = await this.#deps.tools.invoke(input.call.name, parsed, ctx);
      this.#deps.toolCalls.finish(record.id, {
        status: result.ok ? 'ok' : 'error',
        output: result.output,
      });
      return { output: result.output, forModel: toolOutputForModel(result.output) };
    } catch (err) {
      // 三类错误分别给不同的回灌文本：模型需要知道该改参数、该换工具，
      // 还是该报告环境问题
      let message: string;
      let ename: string;

      if (err instanceof ToolInputError) {
        ename = 'InvalidToolArguments';
        message = `${err.message}\n请按工具的 JSON Schema 修正参数后重试。`;
      } else if (err instanceof ToolUnavailableError) {
        ename = 'ToolUnavailable';
        message = `${err.message}\n这个工具在当前环境不可用，请改用其他方式，或告知用户需要先配置环境。`;
      } else {
        ename = 'ToolExecutionFailed';
        message = err instanceof Error ? err.message : String(err);
      }

      this.#deps.toolCalls.finish(record.id, { status: 'error', output: message });
      return {
        output: { kind: 'error', ename, evalue: message, traceback: [] },
        forModel: message,
      };
    }
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

function model_maxOutput(model: ModelDescriptor): number {
  return model.maxOutputTokens;
}

/**
 * 把工具输出转成回灌给模型的文本。
 *
 * 富输出降级为描述而不是原始数据：几百 KB 的 base64 图像会挤掉上下文，
 * 而模型读不出图里画了什么。
 */
export function toolOutputForModel(output: ToolOutput): string {
  switch (output.kind) {
    case 'text':
      return truncateForModel(output.text);
    case 'error':
      return truncateForModel(
        [
          `${output.ename}: ${output.evalue}`,
          ...(output.traceback.length > 0 ? ['', ...output.traceback] : []),
        ].join('\n'),
      );
    case 'rich': {
      const plain = output.data['text/plain'];
      if (typeof plain === 'string') return truncateForModel(plain);
      const keys = Object.keys(output.data);
      return `[富输出：${keys.join('、')}]`;
    }
  }
}

function truncateForModel(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const head = Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.4);
  const tail = MAX_TOOL_OUTPUT_CHARS - head;
  return [
    text.slice(0, head),
    `\n\n[... 省略 ${String(text.length - MAX_TOOL_OUTPUT_CHARS)} 字符 ...]\n\n`,
    text.slice(text.length - tail),
  ].join('');
}

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
