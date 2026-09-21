/**
 * 子 agent 委派（任务 12.6，需求 10.5、10.6、10.7）。
 *
 * 三条决定形态的判断：
 *
 * 1. **每个子 agent 有自己的会话行、自己的工作目录、自己的内核。** 共用会话的内核
 *    在并行时必然失败（一个内核不允许并发执行），而共用工作目录是竞态工厂——两个
 *    子 agent 各写一份 `data.csv` 时后写的赢，且没有任何地方会报。
 * 2. **产物经制品或文件交接，不靠共享内存**（需求 10.6）。因此子 agent 的输入是
 *    制品版本 id（`{{artifact:...}}` 解析成项目级的 blob 路径，与 cwd 无关），
 *    输出要求它 `save_artifacts`。协调方拿到的是版本 id 列表，不是内存里的对象。
 * 3. **阻塞与非阻塞的中断语义不同**（需求 10.7）。用户中断时只取消阻塞式子 agent；
 *    非阻塞的继续跑。默认阻塞——「转后台」必须是显式选择，否则用户按了停止之后
 *    还有东西在跑，而他以为停了。
 *
 * 引导消息（需求 10.5）在**回合之间**注入，不是回合中间。流式模型调用一旦开始就
 * 无法插话；假装能插只会让「我发的引导什么时候生效」变成一个不可预期的问题。
 */

import type { AdapterContext, AdapterRegistry, ChatMessage } from '@l-science/adapters';
import type { ModelDescriptor, TaskType, Usage } from '@l-science/shared';

import type { MessageRepo, ConversationRepo, ToolCallRepo } from '../repo/conversations.js';
import type { RoutingRepo } from '../repo/routing.js';
import type { UsageRepo } from '../repo/usage.js';
import {
  buildTaskProfile,
  route,
  type ExperienceAdjustment,
  type ModelRuntimeState,
} from '../router/index.js';
import type { SkillManager } from '../skills/manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import { executeToolCall, streamModel } from './agent-runtime.js';

export type SubAgentStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface SubAgentSpec {
  /** 任务描述。写到子 agent 能独立执行的程度——它看不到父会话的历史。 */
  task: string;
  /** 绑定的技能 slug。会被注入进子 agent 的提示。 */
  skillSlug?: string | null;
  /** 期望产出。写进提示，也是完成判定的依据。 */
  produces?: readonly string[];
  /**
   * 输入制品版本 id。
   *
   * 子 agent 用 `{{artifact:<id>}}` 引用它们——那会解析成项目级的 blob 路径，
   * 与工作目录无关，因此跨 agent 传数据不需要共享目录。
   */
  inputVersionIds?: readonly string[];
  /** 阻塞式子 agent 在用户中断时被一并取消。默认 true。 */
  blocking?: boolean;
  /** 任务类型，用于路由。省略时按 analysis.codegen 处理。 */
  taskType?: TaskType;
  maxTurns?: number;
  /** 关联的计划步骤 ref，用于把状态写回计划。 */
  planStepRef?: string;
}

export interface SubAgentResult {
  agentId: string;
  status: SubAgentStatus;
  /** 子 agent 的最终陈述。 */
  summary: string;
  /** 它产出的制品版本 id。从 save_artifacts 的调用里收集。 */
  producedVersionIds: readonly string[];
  turns: number;
  usage: Usage;
  /** 失败或被停止时的原因。 */
  detail: string | null;
  /** 子 agent 的会话 id，可用于翻看完整过程。 */
  conversationId: string;
}

export interface SubAgentHandle {
  agentId: string;
  conversationId: string;
  blocking: boolean;
  readonly status: SubAgentStatus;
  /** 向运行中的子 agent 发引导消息（需求 10.5）。下一个回合开始前生效。 */
  guide(message: string): boolean;
  /** 停止它（需求 10.5）。 */
  stop(reason: string): boolean;
  result: Promise<SubAgentResult>;
}

export interface SubAgentRunnerDeps {
  conversations: ConversationRepo;
  messages: MessageRepo;
  toolCalls: ToolCallRepo;
  tools: ToolRegistry;
  adapters: AdapterRegistry;
  routerView: () => {
    models: readonly ModelDescriptor[];
    runtime: ReadonlyMap<string, ModelRuntimeState>;
  };
  adapterContext: (providerId: string) => AdapterContext | null;
  experience?: () => ReadonlyMap<string, ExperienceAdjustment>;
  usage?: UsageRepo;
  routing?: RoutingRepo;
  skills?: SkillManager;
  /**
   * 记忆注入段落（需求 16.1）。
   *
   * 每次派子 agent 时现取而不是构造时算一次：主 agent 可能刚在这一轮里记下一条
   * 约定，紧接着就派出子 agent 去执行——那正是这条约定最该生效的时刻。
   */
  memory?: () => string;
  /** 子 agent 的工作目录。按 agentId 隔离。 */
  workspaceDir: (agentId: string) => string;
  projectId?: string;
  /** 同时在跑的子 agent 上限。 */
  maxConcurrent?: number;
  defaultMaxTurns?: number;
  onLog?: (line: string) => void;
}

/**
 * 并发上限。
 *
 * 每个子 agent 会起自己的 Python 内核（几百 MB 常驻），四个已经是一台开发机的
 * 合理上限。超了排队而不是拒绝——拒绝会让计划里的并行步骤直接失败。
 */
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TURNS = 12;

interface Running {
  handle: SubAgentHandle;
  controller: AbortController;
  /** 待注入的引导消息。在回合之间取出。 */
  mailbox: string[];
  spec: SubAgentSpec;
  stopReason: string | null;
  /**
   * 是否已出结果。
   *
   * 不能只靠「是否还在 #running 里」判断：清理发生在 promise 链的 finally 里，
   * 而调用方 `await result` 之后的续段可能先于它执行。那个窗口里 `guide()` 会返回
   * true，消息进了一个再也不会被读的信箱——调用方以为发出去了。
   */
  finished: boolean;
}

let agentCounter = 0;

export class SubAgentRunner {
  readonly #deps: SubAgentRunnerDeps;
  readonly #running = new Map<string, Running>();
  readonly #maxConcurrent: number;
  readonly #maxTurns: number;
  readonly #onLog: (line: string) => void;
  /** 排队等并发额度的启动函数。 */
  readonly #queue: Array<() => void> = [];
  #active = 0;

  constructor(deps: SubAgentRunnerDeps) {
    this.#deps = deps;
    this.#maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#maxTurns = deps.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
    this.#onLog = deps.onLog ?? ((): void => {});
  }

  /** 当前在跑的子 agent。已出结果的不算，即便清理还没执行到。 */
  list(parentConversationId?: string): readonly SubAgentHandle[] {
    const all = [...this.#running.values()].filter((r) => !r.finished).map((r) => r.handle);
    if (parentConversationId === undefined) return all;
    return all.filter((h) => this.#parentOf.get(h.agentId) === parentConversationId);
  }

  readonly #parentOf = new Map<string, string>();

  get(agentId: string): SubAgentHandle | null {
    const entry = this.#running.get(agentId);
    return entry === undefined || entry.finished ? null : entry.handle;
  }

  /** 发起一个子 agent。返回句柄，`result` 是它的最终结果。 */
  spawn(input: { parentConversationId: string; spec: SubAgentSpec }): SubAgentHandle {
    agentCounter += 1;
    const agentId = `ag${String(agentCounter).padStart(3, '0')}_${Date.now().toString(36)}`;
    const blocking = input.spec.blocking !== false;

    const conversation = this.#deps.conversations.create({
      title: `[子任务] ${input.spec.task.slice(0, 60)}`,
      agentId,
      parentConversationId: input.parentConversationId,
    });

    const controller = new AbortController();
    let status: SubAgentStatus = 'running';

    const running: Running = {
      // handle 先占位，下面补上
      handle: null as unknown as SubAgentHandle,
      controller,
      mailbox: [],
      spec: input.spec,
      stopReason: null,
      finished: false,
    };

    const result = new Promise<SubAgentResult>((resolve) => {
      /** 出结果。`finished` 必须在 resolve **之前**置上，见它的说明。 */
      const settle = (r: SubAgentResult): void => {
        running.finished = true;
        status = r.status;
        resolve(r);
      };

      const start = (): void => {
        this.#active += 1;
        void this.#run({ agentId, conversationId: conversation.id, spec: input.spec, running })
          .then(settle)
          .catch((err: unknown) => {
            settle({
              agentId,
              status: 'failed',
              summary: '',
              producedVersionIds: [],
              turns: 0,
              usage: { tokensIn: 0, tokensOut: 0, cost: 0, currency: 'USD' },
              detail: err instanceof Error ? err.message : String(err),
              conversationId: conversation.id,
            });
          })
          .finally(() => {
            this.#active -= 1;
            this.#running.delete(agentId);
            this.#parentOf.delete(agentId);
            const next = this.#queue.shift();
            next?.();
          });
      };

      // 超过并发上限就排队。拒绝会让计划里的并行步骤直接失败
      if (this.#active < this.#maxConcurrent) start();
      else this.#queue.push(start);
    });

    const handle: SubAgentHandle = {
      agentId,
      conversationId: conversation.id,
      blocking,
      get status() {
        return status;
      },
      guide: (message: string): boolean => {
        const entry = this.#running.get(agentId);
        // finished 与「还在 #running 里」都要查：清理在 finally 里，调用方
        // await 结果之后的续段可能先跑，那个窗口里消息会进一个没人读的信箱
        if (entry === undefined || entry.finished) return false;
        // 回合之间注入。流式调用一旦开始就无法插话，假装能插会让
        // 「我发的引导什么时候生效」变成不可预期的问题
        entry.mailbox.push(message);
        this.#onLog(`子 agent ${agentId} 收到引导消息`);
        return true;
      },
      stop: (reason: string): boolean => {
        const entry = this.#running.get(agentId);
        if (entry === undefined || entry.finished) return false;
        entry.stopReason = reason;
        entry.controller.abort();
        return true;
      },
      result,
    };

    running.handle = handle;
    this.#running.set(agentId, running);
    this.#parentOf.set(agentId, input.parentConversationId);
    return handle;
  }

  /**
   * 取消某个父会话下的**阻塞式**子 agent（需求 10.7）。
   *
   * 非阻塞的刻意不动：它们是用户显式转后台的，一次闲聊式的中断不该把两小时的
   * 作业杀掉。这与「会话中断不取消后台任务」是同一条取舍。
   */
  cancelBlocking(parentConversationId: string, reason: string): number {
    let cancelled = 0;
    for (const [agentId, entry] of this.#running) {
      if (entry.finished) continue;
      if (this.#parentOf.get(agentId) !== parentConversationId) continue;
      if (!entry.handle.blocking) continue;
      entry.stopReason = reason;
      entry.controller.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  /** 停止全部子 agent。后端关闭时用。 */
  stopAll(reason: string): number {
    let n = 0;
    for (const entry of this.#running.values()) {
      if (entry.finished) continue;
      entry.stopReason = reason;
      entry.controller.abort();
      n += 1;
    }
    return n;
  }

  /* ---------------- 执行 ---------------- */

  #systemPrompt(spec: SubAgentSpec): string {
    const parts = [
      '你是一个子 agent，负责独立完成一件被委派的具体任务。',
      '',
      '**你看不到父会话的历史，也不能与用户对话。** 需要的信息全在下面的任务描述里；',
      '缺信息时不要猜，在最终陈述里明确说缺什么。',
      '',
      '产物交接规则：',
      '- 输入数据用 `{{artifact:<版本 id>}}` 引用，它会被解析成真实文件路径。',
      '- 产出必须用 `save_artifacts` 保存并带上生成代码，否则协调方拿不到它。',
      '- 你有独立的工作目录与独立的内核，不要假设别的 agent 的文件在你这里。',
      '',
      '完成时给一段简短陈述：做了什么、产出了哪些制品、有什么需要协调方注意的问题。',
      '做不到时如实说做不到并说明原因，不要产出一个看起来完成了的结果。',
    ];

    /*
     * 记忆同样要注入子 agent（需求 16.1）。
     *
     * 术语约定与既定的方法选择对子 agent 更重要：它看不到父会话的历史，因此
     * 「本项目被试编号是 S01-S24」这类约定只可能从记忆里来。不注入的结果是
     * 主 agent 遵守约定而子 agent 不遵守，而两边的产物要拼在同一篇论文里。
     */
    const memory = this.#deps.memory?.() ?? '';
    if (memory.trim() !== '') {
      parts.push(
        '',
        '---',
        '',
        '本项目已经记住的约定与背景（它们是既定选择，按它们做）：',
        '',
        memory.trim(),
      );
    }

    if (spec.skillSlug !== undefined && spec.skillSlug !== null) {
      const injection = this.#deps.skills?.inject(spec.skillSlug);
      if (injection !== null && injection !== undefined) {
        if (injection.blocked) {
          const missingLine =
            injection.missing.length === 0 ? '' : `缺少：${injection.missing.join('、')}。`;
          parts.push(
            '',
            '---',
            '',
            `绑定的技能在本机不能运行。${missingLine}不要声称已经跑过它。`,
            '',
            injection.content,
          );
        } else {
          parts.push('', '---', '', '本任务应遵循下面的方法学文档：', '', injection.content);
        }
      }
    }

    return parts.join('\n');
  }

  #taskMessage(spec: SubAgentSpec): string {
    const parts = [`任务：${spec.task}`];

    if (spec.inputVersionIds !== undefined && spec.inputVersionIds.length > 0) {
      parts.push(
        '',
        '可用的输入制品（用 {{artifact:id}} 引用）：',
        ...spec.inputVersionIds.map((id) => `- {{artifact:${id}}}`),
      );
    }
    if (spec.produces !== undefined && spec.produces.length > 0) {
      parts.push('', `期望产出：${spec.produces.join('、')}`);
    }

    return parts.join('\n');
  }

  async #run(input: {
    agentId: string;
    conversationId: string;
    spec: SubAgentSpec;
    running: Running;
  }): Promise<SubAgentResult> {
    const { agentId, conversationId, spec, running } = input;
    const maxTurns = spec.maxTurns ?? this.#maxTurns;
    const totals: Usage = { tokensIn: 0, tokensOut: 0, cost: 0, currency: 'USD' };
    const produced = new Set<string>();

    const history: ChatMessage[] = [
      { role: 'system', content: this.#systemPrompt(spec) },
      { role: 'user', content: this.#taskMessage(spec) },
    ];

    // 任务消息落库，子 agent 的过程要可翻看
    this.#deps.messages.append({
      conversationId,
      role: 'user',
      content: { kind: 'text', text: this.#taskMessage(spec) },
    });

    const view = this.#deps.routerView();
    const toolSchemas = this.#deps.tools.toolSchemas();

    let summary = '';
    let turns = 0;
    let detail: string | null = null;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (running.controller.signal.aborted) {
        return {
          agentId,
          status: 'stopped',
          summary,
          producedVersionIds: [...produced],
          turns,
          usage: totals,
          detail: running.stopReason ?? '已被停止',
          conversationId,
        };
      }

      // 引导消息在回合之间注入
      while (running.mailbox.length > 0) {
        const message = running.mailbox.shift();
        if (message === undefined) break;
        const text = `协调方的补充说明：${message}`;
        history.push({ role: 'user', content: text });
        this.#deps.messages.append({
          conversationId,
          role: 'user',
          content: { kind: 'text', text },
        });
      }

      turns = turn + 1;

      /* --- 选模型 --- */
      const historyChars = history.reduce((n, m) => n + m.content.length, 0);
      const profile = buildTaskProfile(spec.taskType ?? 'analysis.codegen', {
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

      if (routed.decision.chosenModelId === null) {
        return {
          agentId,
          status: 'failed',
          summary,
          producedVersionIds: [...produced],
          turns,
          usage: totals,
          detail: routed.emptyReport ?? '没有可用模型',
          conversationId,
        };
      }

      const model = routed.ranked[0];
      const ctx = model === undefined ? null : this.#deps.adapterContext(model.providerId);
      if (model === undefined || ctx === null) {
        return {
          agentId,
          status: 'failed',
          summary,
          producedVersionIds: [...produced],
          turns,
          usage: totals,
          detail: `供应商 ${model?.providerId ?? '?'} 的适配器上下文不可用`,
          conversationId,
        };
      }

      /* --- 调模型 --- */
      const startedAt = Date.now();
      let step;
      try {
        step = await streamModel({
          adapter: this.#deps.adapters.get(ctx.adapterId ?? model.providerId),
          ctx: {
            ...ctx,
            pricing: {
              inputPer1k: model.pricing.inputPer1k,
              outputPer1k: model.pricing.outputPer1k,
              currency: model.pricing.currency,
            },
          },
          model,
          history,
          toolSchemas,
          signal: running.controller.signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 用量也记失败：降级链分析需要失败类别
        this.#deps.usage?.record({
          conversationId,
          providerId: model.providerId,
          modelId: model.id,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          latencyMs: Date.now() - startedAt,
          status: running.controller.signal.aborted ? 'aborted' : 'unknown-error',
          error: message,
        });

        if (running.controller.signal.aborted) {
          return {
            agentId,
            status: 'stopped',
            summary,
            producedVersionIds: [...produced],
            turns,
            usage: totals,
            detail: running.stopReason ?? '已被停止',
            conversationId,
          };
        }
        return {
          agentId,
          status: 'failed',
          summary,
          producedVersionIds: [...produced],
          turns,
          usage: totals,
          detail: message,
          conversationId,
        };
      }

      totals.tokensIn += step.usage.tokensIn;
      totals.tokensOut += step.usage.tokensOut;
      totals.cost += step.usage.cost;
      totals.currency = step.usage.currency;

      this.#deps.usage?.record({
        conversationId,
        providerId: model.providerId,
        modelId: model.id,
        tokensIn: step.usage.tokensIn,
        tokensOut: step.usage.tokensOut,
        cost: step.usage.cost,
        latencyMs: Date.now() - startedAt,
        status: 'ok',
        error: null,
      });

      const assistantMessage = this.#deps.messages.append({
        conversationId,
        role: 'assistant',
        content: { kind: 'text', text: step.text, thinking: step.thinking },
        modelId: model.id,
        providerId: model.providerId,
        usage: step.usage,
      });

      if (step.text.trim() !== '') summary = step.text.trim();

      if (step.toolCalls.length === 0) {
        // 没有工具调用即为收尾
        return {
          agentId,
          status: 'done',
          summary,
          producedVersionIds: [...produced],
          turns,
          usage: totals,
          detail: null,
          conversationId,
        };
      }

      /*
       * OpenAI 协议要求 role:'tool' 紧跟一条带 tool_calls 的 assistant 消息。
       * 缺了它服务端会 400 拒收，症状是「第一轮工具调用正常、回灌后第二轮无正文」。
       */
      history.push({
        role: 'assistant',
        content: step.text,
        toolCalls: step.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          argumentsJson: c.argumentsJson,
        })),
      });

      for (const call of step.toolCalls) {
        const outcome = await executeToolCall({
          tools: this.#deps.tools,
          toolCalls: this.#deps.toolCalls,
          messageId: assistantMessage.id,
          call,
          ctx: {
            projectId: this.#deps.projectId ?? '',
            conversationId,
            workspaceDir: this.#deps.workspaceDir(agentId),
            // 自己的内核。共用会话的键会让并行的第二个 agent 撞上
            // 「该内核已有执行在途」
            kernelKey: `sub_${agentId}`,
            signal: running.controller.signal,
          },
        });

        // 收集产出的制品版本 id：协调方拿到的是 id，不是内存里的对象（需求 10.6）
        if (call.name === 'save_artifacts') {
          for (const id of extractVersionIds(outcome.forModel)) produced.add(id);
        }

        history.push({ role: 'tool', content: outcome.forModel, toolCallId: call.id });
      }
    }

    detail = `达到回合上限（${String(maxTurns)}），任务未完成`;
    this.#onLog(`子 agent ${agentId} ${detail}`);
    return {
      agentId,
      status: 'failed',
      summary,
      producedVersionIds: [...produced],
      turns,
      usage: totals,
      detail,
      conversationId,
    };
  }
}

/**
 * 从 save_artifacts 的输出里抓出版本 id。
 *
 * 用文本抽取而不是让工具返回结构化结果：`ToolResult.output` 是给模型看的通道，
 * 给它加一个只有子 agent 用的旁路字段会让工具契约多一个分支。版本 id 的格式
 * （`av_` + UUID）足够特征化，误抓的风险可以忽略。
 */
export function extractVersionIds(text: string): readonly string[] {
  return [
    ...new Set(
      [
        ...text.matchAll(/\bav_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi),
      ].map((m) => m[0]),
    ),
  ];
}
