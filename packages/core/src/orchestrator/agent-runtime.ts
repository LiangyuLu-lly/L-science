/**
 * agent 循环的共用件（任务 12.6）。
 *
 * 主编排器与子 agent 共用这两个函数，而不是各写一份。共用的理由很具体：
 * 「工具参数不是合法 JSON 时如实回灌而不是当工具坏了」「三类工具错误分别给不同的
 * 回灌文本」这类判断是踩出来的，两份实现迟早会分歧，而分歧的表现是子 agent 在
 * 某些失败上的行为与主 agent 不同——那种差异极难被注意到，因为两边都「能跑」。
 */

import type { AdapterContext, AdapterRegistry, ChatChunk, ChatMessage } from '@l-science/adapters';
import type { ModelDescriptor, ToolOutput, TurnEvent, Usage } from '@l-science/shared';

import type { ToolCallRepo } from '../repo/conversations.js';
import { ToolInputError, ToolUnavailableError, type ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

/** 输出上限的兜底。模型声明的上限可能极大，全用满没有意义且贵。 */
export function modelMaxOutput(model: ModelDescriptor): number {
  return model.maxOutputTokens > 0 ? model.maxOutputTokens : 4096;
}

/**
 * 消费适配器的增量流，收集文本、思考与工具调用。
 *
 * 输出上限要为思维模式留余量：thinking 模型先消耗配额做思考再产出答案，给太小会
 * 得到一堆思考而正文为空（实测把 max_tokens 设成 16 给 qwen3:4b，17 个分片全是
 * 思考、正文一个字都没有）。
 */
export async function streamModel(input: {
  adapter: ReturnType<AdapterRegistry['get']>;
  ctx: AdapterContext;
  model: ModelDescriptor;
  history: readonly ChatMessage[];
  toolSchemas: ReturnType<ToolRegistry['toolSchemas']>;
  signal: AbortSignal;
  /**
   * 覆盖输出上限。
   *
   * 需要它是因为默认值（thinking 模型 8192）对「必须产出完整结构化输出」的调用
   * 不够用：实测 qwen3:4b 审查一段内容时把 8192 全花在思考上，正文一个字都没有，
   * 于是审查结果是空的而且看起来像模型不肯按格式输出。对话回合不受影响——它可以
   * 只产出一句话就结束，而结构化输出不行。
   */
  maxOutputTokens?: number;
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

  const maxOutputTokens = Math.min(
    modelMaxOutput(input.model),
    input.maxOutputTokens ?? (input.model.features.thinking ? 8192 : 4096),
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

/**
 * 回灌给模型的工具输出上限。
 *
 * 一次 `pip install` 的输出能有几万字符，一个 DataFrame 的 repr 也能刷满几千行。
 * 不截断的话一次工具调用就能把上下文预算吃掉，后续几轮全在挤压历史。
 */
const MAX_TOOL_OUTPUT_CHARS = 40_000;

/**
 * 把工具输出转成回灌给模型的文本。
 *
 * 富输出降级为描述而不是原始数据：几百 KB 的 base64 图像会挤掉上下文，
 * 而模型读不出图里画了什么。图本身经制品通道保留给用户看。
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

/** 掐头去尾保留两端。中间被截掉的往往是重复的进度行，两端才有信息。 */
export function truncateForModel(text: string): string {
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
 * 执行一次工具调用并落库。
 *
 * `ctx` 由调用方构造：主 agent 与子 agent 的工作目录与内核不同（子 agent 各有一份，
 * 否则并行时会撞上「该内核已有执行在途」），但工具调用的归属必须落在真实的消息上。
 */
export async function executeToolCall(input: {
  tools: ToolRegistry;
  toolCalls: ToolCallRepo;
  messageId: string;
  call: { id: string; name: string; argumentsJson: string };
  ctx: ToolContext;
}): Promise<{ output: ToolOutput; forModel: string }> {
  const record = input.toolCalls.start({
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
    input.toolCalls.finish(record.id, { status: 'error', output: message });
    return {
      output: { kind: 'error', ename: 'InvalidToolArguments', evalue: message, traceback: [] },
      forModel: message,
    };
  }

  try {
    const result = await input.tools.invoke(input.call.name, parsed, input.ctx);
    input.toolCalls.finish(record.id, {
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

    input.toolCalls.finish(record.id, { status: 'error', output: message });
    return {
      output: { kind: 'error', ename, evalue: message, traceback: [] },
      forModel: message,
    };
  }
}
