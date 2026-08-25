/**
 * Tool Registry（任务 6.1，需求 2.4、9.6）。
 *
 * 核心职责是**按运行时能力条件注册**。不可用的工具不进工具列表，但要记下它
 * 为什么不可用——用户问「为什么不能跑 R」时要能立刻给出安装指引，而不是让他
 * 自己去猜。
 */

import { makeError, type ErrorEnvelope, type ToolOutput } from '@l-science/shared';

import type {
  CapabilityProbe,
  ToolContext,
  ToolDefinition,
  ToolRequirement,
  ToolResult,
  UnavailableTool,
} from './types.js';

/** 入参校验失败。与执行期错误分开，因为它不该触发重试。 */
export class ToolInputError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(`工具 ${toolName} 的入参非法：${message}`);
    this.name = 'ToolInputError';
    this.toolName = toolName;
  }
}

/** 请求了一个未注册的工具。 */
export class ToolUnavailableError extends Error {
  readonly toolName: string;
  readonly missing: readonly ToolRequirement[];

  constructor(toolName: string, missing: readonly ToolRequirement[]) {
    const detail =
      missing.length === 0
        ? '该工具不存在。'
        : missing.map((m) => `缺少 ${m.capability}：${m.remediation}`).join('\n');
    super(`工具 ${toolName} 不可用。\n${detail}`);
    this.name = 'ToolUnavailableError';
    this.toolName = toolName;
    this.missing = missing;
  }
}

export interface ToolRegistryOptions {
  /** 判断某个能力是否可用。 */
  probe: CapabilityProbe;
}

export class ToolRegistry {
  readonly #probe: CapabilityProbe;
  readonly #available = new Map<string, ToolDefinition>();
  readonly #unavailable = new Map<string, UnavailableTool>();

  constructor(options: ToolRegistryOptions) {
    this.#probe = options.probe;
  }

  /**
   * 注册一个工具。依赖不满足时记入不可用清单而不是抛错。
   *
   * 不抛错是刻意的：R 没装是正常情况，不该让整个后端启动失败。返回值告知
   * 调用方是否真的注册上了，需要时可以据此打日志。
   */
  register<I>(definition: ToolDefinition<I>): boolean {
    const missing = (definition.requirements ?? []).filter((r) => !this.#probe(r.capability));

    if (missing.length > 0) {
      this.#unavailable.set(definition.name, { name: definition.name, missing });
      return false;
    }

    if (this.#available.has(definition.name)) {
      throw new Error(`工具名重复：${definition.name}`);
    }
    this.#available.set(definition.name, definition as ToolDefinition);
    return true;
  }

  has(name: string): boolean {
    return this.#available.has(name);
  }

  /** 已注册的工具，按名字排序保证列表稳定。 */
  list(): readonly ToolDefinition[] {
    return [...this.#available.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 因依赖缺失而未注册的工具及原因。 */
  unavailable(): readonly UnavailableTool[] {
    return [...this.#unavailable.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 供模型使用的工具声明。
   *
   * 只包含可用工具——这是整个条件注册机制的落点。
   */
  toolSchemas(): ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  /**
   * 解释某个工具为什么不能用（需求 9.6）。
   *
   * 与 `has()` 分开：前者回答能不能用，这个回答为什么不能用。用户看到
   * 「r 工具不可用」毫无帮助，看到具体的 conda 命令才能自己解决。
   */
  explainUnavailable(name: string): string | null {
    const record = this.#unavailable.get(name);
    if (record === undefined) {
      return this.#available.has(name) ? null : `没有名为 ${name} 的工具。`;
    }
    return [
      `工具 ${name} 当前不可用，因为缺少以下运行时依赖：`,
      ...record.missing.map((m) => `  · ${m.capability}\n    ${m.remediation}`),
    ].join('\n');
  }

  /**
   * 执行一次工具调用。
   *
   * 入参校验失败与执行失败被区分成不同的错误信封：前者是模型把调用写错了，
   * 重试同样的参数没有意义；后者可能是环境的临时问题。混成一种会让重试逻辑
   * 无法做出正确判断。
   */
  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const definition = this.#available.get(name);
    if (definition === undefined) {
      throw new ToolUnavailableError(name, this.#unavailable.get(name)?.missing ?? []);
    }

    let input: unknown;
    try {
      input = definition.parseInput(rawInput);
    } catch (err) {
      throw new ToolInputError(name, err instanceof Error ? err.message : String(err));
    }

    return definition.execute(input, ctx);
  }
}

/** 把工具错误翻译成 IPC 错误信封。 */
export function toolErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ToolInputError) {
    return makeError('bad_request', error.message, {
      remediation: '检查参数是否符合工具的 JSON Schema 声明。',
    });
  }
  if (error instanceof ToolUnavailableError) {
    return makeError('not_found', error.message, {
      remediation: error.missing.map((m) => m.remediation).join(' '),
    });
  }
  return makeError('internal', error instanceof Error ? error.message : String(error));
}

/** 构造纯文本输出。 */
export function textOutput(text: string): ToolOutput {
  return { kind: 'text', text };
}

/** 构造错误输出。 */
export function errorOutput(
  ename: string,
  evalue: string,
  traceback: readonly string[] = [],
): ToolOutput {
  return { kind: 'error', ename, evalue, traceback };
}
