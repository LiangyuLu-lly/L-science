/**
 * 工具面的类型定义（任务 6.1，需求 2.4、9.6）。
 */

import type { ToolOutput } from '@l-science/shared';

/**
 * 工具的运行时依赖。
 *
 * 声明式而不是让工具自己在执行时检查：注册表要在**暴露给模型之前**就知道
 * 哪些工具不可用。让不可用的工具出现在工具列表里，结果是模型调用它、拿到
 * 一个执行期错误、然后重试——而重试同样失败。模型没有办法从「这个环境
 * 没装 R」这个事实里学到教训，因为它看到的是一个失败的调用而不是一份
 * 不含该工具的清单。
 */
export interface ToolRequirement {
  /** 能力标识，例如 `kernel:python`、`kernel:r`、`shell:bash`。 */
  capability: string;
  /**
   * 缺失时给用户的安装指引。
   *
   * 必须可执行到「复制粘贴就能跑」的程度。「请安装 R」不算——用户不知道
   * 装哪个版本、装到哪、还要不要装 IRkernel。
   */
  remediation: string;
}

export interface ToolContext {
  projectId: string;
  conversationId: string;
  /** 会话的工作目录。工具的相对路径以此为基准。 */
  workspaceDir: string;
  /**
   * 内核池的取用键。省略时用 `conversationId`。
   *
   * 子 agent 需要它：内核按键复用，而一个内核**不允许并发执行**（会抛「该内核已有
   * 执行在途」）。若并行的子 agent 共用会话的键，第二个开始跑的必然失败——而失败
   * 原因看起来像是内核问题，不像是并行设计的问题。给每个子 agent 一个自己的键，
   * 它就有自己的内核与自己的工作目录。
   */
  kernelKey?: string;
  /** 中断信号。阻塞式工具必须响应它。 */
  signal?: AbortSignal;
  /** 流式输出回调。不提供时工具只在结束时返回完整结果。 */
  onPartial?: (chunk: ToolOutput) => void;
  /**
   * 发起这次调用的模型。
   *
   * 由编排层填，工具不能从入参里接受它。需求 13.4 要求 Claim Ledger 的每条核验
   * 结论记下执行核验的模型标识，而如果让模型自报，它可以写任何字符串——而这一列
   * 的全部用途正是事后判断结论的可信度（是一个强模型读了全文，还是一个小模型
   * 看了标题就说「支持」）。自报的值在这个问题上没有任何价值。
   *
   * 降级链走到第二个模型时这里是第二个模型的 id：它才是真正干活的那个。
   */
  modelId?: string;
}

/** 工具执行结果。 */
export interface ToolResult {
  output: ToolOutput;
  /**
   * 是否成功。
   *
   * 与 `output.kind === 'error'` 分开：一个命令以非零码退出时，stdout 上的
   * 内容仍然有诊断价值，因此 output 可能是 text 而 ok 是 false。把两者合成
   * 一个会迫使实现二选一，然后丢掉另一半信息。
   */
  ok: boolean;
  /** 后台任务的句柄。仅当以 background 模式启动时存在。 */
  backgroundTaskId?: string;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema。传给模型的就是这份，因此描述要写给模型看。 */
  inputSchema: Record<string, unknown>;
  /** 运行时依赖。全部满足才会注册。 */
  requirements?: readonly ToolRequirement[];
  /**
   * 是否需要用户审批才能执行。
   *
   * 这里只声明「需要」，具体的审批卡片内容由工具自己在执行时构造——只有它
   * 知道本次调用的实际影响范围。
   */
  needsApproval?: boolean;
  /** 校验并归一化入参。抛错即视为入参非法。 */
  parseInput: (raw: unknown) => Input;
  execute: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}

/** 某个能力当前是否可用。由环境探测填充。 */
export type CapabilityProbe = (capability: string) => boolean;

/** 工具因依赖缺失而未注册的记录。 */
export interface UnavailableTool {
  name: string;
  missing: readonly ToolRequirement[];
}
