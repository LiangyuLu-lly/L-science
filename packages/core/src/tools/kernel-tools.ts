/**
 * `python` 与 `r` 工具（任务 6.2，需求 3.1、3.7、3.11）。
 *
 * 接内核池。两个工具共用一套实现，只在语言与文案上不同——差异全在内核侧，
 * 工具层没有理由为两种语言写两份归一化逻辑。
 *
 * 关键设计：**富输出不被压成纯文本**。Jupyter 协议会返回 image/png、
 * text/html、application/json 等多种表示，把它们统一 toString 掉是最省事的
 * 做法，但那样图就没了——而出图是这个平台的核心用途之一。因此保留 MIME bundle，
 * 只在需要给模型看时才降级为文本描述。
 */

import type { JupyterKernel, KernelLanguage, KernelOutput, KernelPool } from '@l-science/kernel';
import type { MimeBundle, ToolOutput } from '@l-science/shared';

import { CAPABILITY, REMEDIATION } from './capabilities.js';
import type { ToolDefinition, ToolResult } from './types.js';

export interface CodeInput {
  code: string;
  /** 是否转后台执行。长任务不该阻塞会话。 */
  background?: boolean;
  timeoutMs?: number;
}

/** 单次执行收集到的输出。 */
export interface ExecutionCollected {
  /** stdout 与 stderr 按到达顺序拼接。 */
  text: string;
  /** 富输出，按产生顺序。 */
  rich: MimeBundle[];
  error: { ename: string; evalue: string; traceback: readonly string[] } | null;
}

/**
 * 从 MIME bundle 里挑一个给模型看的文本表示。
 *
 * 优先纯文本，其次 HTML 剥标签。图像返回一句说明而不是 base64——把几百 KB 的
 * base64 塞进上下文既挤掉真正的内容，模型也读不出图里画了什么。图本身通过
 * artifact 通道保留给用户看。
 */
export function describeMimeBundle(bundle: MimeBundle): string {
  const plain = bundle['text/plain'];
  if (typeof plain === 'string' && plain !== '') return plain;

  const html = bundle['text/html'];
  if (typeof html === 'string' && html !== '') {
    // 粗剥标签。目的只是让模型看到大致内容（比如 DataFrame 的表格文字），
    // 不追求正确的 HTML 解析
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const imageKey = Object.keys(bundle).find((k) => k.startsWith('image/'));
  if (imageKey !== undefined) {
    const payload = bundle[imageKey];
    // base64 长度乘 3/4 得到原始字节数
    const kb = typeof payload === 'string' ? Math.round((payload.length * 3) / 4 / 1024) : 0;
    return `[${imageKey} 图像，${String(kb)} KB。已作为制品保存，用户可以看到它。]`;
  }

  const json = bundle['application/json'];
  if (json !== undefined) {
    // JSON 表示是对象，不是字符串——这正是 MimeBundle 的值类型必须是
    // unknown 的原因
    return typeof json === 'string' ? json : JSON.stringify(json).slice(0, 2000);
  }

  const keys = Object.keys(bundle);
  return keys.length === 0 ? '' : `[输出类型：${keys.join('、')}]`;
}

/** 收集内核输出流。 */
export async function collectExecution(
  outputs: AsyncIterable<KernelOutput>,
  onPartial?: (chunk: ToolOutput) => void,
): Promise<ExecutionCollected> {
  const chunks: string[] = [];
  const rich: MimeBundle[] = [];
  let error: ExecutionCollected['error'] = null;

  for await (const out of outputs) {
    switch (out.type) {
      case 'stream': {
        chunks.push(out.text);
        onPartial?.({ kind: 'text', text: out.text });
        break;
      }
      case 'execute_result':
      case 'display_data':
      case 'update_display_data': {
        rich.push(out.data);
        onPartial?.({ kind: 'rich', data: out.data });
        break;
      }
      case 'error': {
        // 只保留第一个错误：后续错误通常是同一个问题的连带反应，
        // 全部返回会把真正的原因埋在噪声里
        error ??= { ename: out.ename, evalue: out.evalue, traceback: out.traceback };
        onPartial?.({
          kind: 'error',
          ename: out.ename,
          evalue: out.evalue,
          traceback: out.traceback,
        });
        break;
      }
      default:
        // status / clear_output / execute_input 不进结果：
        // 它们是协议层的状态而不是用户代码的输出
        break;
    }
  }

  return { text: chunks.join(''), rich, error };
}

/** 把收集到的输出整理成给模型看的结果。 */
export function formatExecution(collected: ExecutionCollected): ToolResult {
  const parts: string[] = [];

  if (collected.text !== '') parts.push(collected.text.trimEnd());

  for (const bundle of collected.rich) {
    const described = describeMimeBundle(bundle);
    if (described !== '') parts.push(described);
  }

  if (collected.error !== null) {
    // traceback 是诊断的关键，但可能很长。保留末尾几行——异常类型与
    // 出错位置在那里，而顶部的调用栈通常是框架代码
    const tb = collected.error.traceback;
    const tail = tb.length > 20 ? ['...（已省略上层调用栈）', ...tb.slice(-20)] : [...tb];
    return {
      ok: false,
      output: {
        kind: 'error',
        ename: collected.error.ename,
        evalue: collected.error.evalue,
        traceback: tail,
      },
    };
  }

  return {
    ok: true,
    // 无输出时明确说明。返回空串会让模型无法区分「代码跑完没输出」
    // 与「输出丢了」
    output: { kind: 'text', text: parts.length === 0 ? '(执行完成，没有输出)' : parts.join('\n') },
  };
}

export interface KernelToolOptions {
  pool: KernelPool;
  language: KernelLanguage;
  /**
   * 提交后台任务。返回任务 id。缺省时 background 参数不可用。
   *
   * `run` 收到的内核由**调用方**提供，不是本会话的那个：后台任务若占住会话内核，
   * 用户的下一条消息就会撞上「该内核已有执行在途」，那就不叫后台了。代价是后台
   * 代码看不到会话里的变量，这一点必须写进工具描述——模型默认会以为状态是共享的。
   */
  submitBackground?: (
    run: (kernel: JupyterKernel) => AsyncIterable<KernelOutput>,
    meta: {
      language: KernelLanguage;
      code: string;
      conversationId: string;
      /** 会话（或子 agent）的内核取用键，供调用方派生后台内核的键。 */
      kernelKey: string;
    },
  ) => string;
}

const LANGUAGE_META: Readonly<
  Record<KernelLanguage, { name: string; capability: string; blurb: string }>
> = {
  python: {
    name: 'python',
    capability: CAPABILITY.kernelPython,
    blurb:
      '在持久的 Python 内核里执行代码。内核在同一会话内保持状态，因此变量、' +
      '导入的模块、加载的数据在多次调用之间都保留。已装 numpy、pandas、scipy、' +
      'matplotlib、statsmodels、scikit-learn、mne、yasa、neurokit2 等。',
  },
  r: {
    name: 'r',
    capability: CAPABILITY.kernelR,
    blurb:
      '在持久的 R 内核里执行代码。内核在同一会话内保持状态。' +
      '注意 R 与 Python 是两个独立的内核，变量不共享——需要传数据请写文件。',
  },
};

export function createKernelTool(options: KernelToolOptions): ToolDefinition<CodeInput> {
  const meta = LANGUAGE_META[options.language];

  return {
    name: meta.name,
    description:
      `${meta.blurb}` +
      '返回 stdout、stderr 与执行结果。出错时返回异常类型、消息与调用栈。' +
      '图表会作为制品保存，用户能看到它们。' +
      (options.submitBackground === undefined
        ? ''
        : '预计跑很久的任务请设 background=true，它会转入后台，完成后结果自动回到会话里。' +
          '**后台任务跑在一个干净的新内核里，看不到本会话的变量**——' +
          '它必须自己从文件或制品重新读入需要的数据，也要自己把结果写成文件。' +
          '这是「后台」的代价：占住会话内核的话你的下一条消息就得排队等它。'),
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: `要执行的 ${meta.name === 'r' ? 'R' : 'Python'} 代码`,
        },
        ...(options.submitBackground === undefined
          ? {}
          : {
              background: {
                type: 'boolean',
                description:
                  '转后台执行。适用于预计超过一两分钟的任务。设为 true 时立即返回任务 id，' +
                  '不阻塞会话；完成后结果会自动投递回来。',
              },
            }),
        timeoutMs: { type: 'number', description: '墙钟超时，毫秒' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    requirements: [
      { capability: meta.capability, remediation: REMEDIATION[meta.capability] ?? '' },
    ],

    parseInput(raw): CodeInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.code !== 'string' || obj.code.trim() === '') {
        throw new Error('code 必须是非空字符串');
      }
      if (obj.background !== undefined && typeof obj.background !== 'boolean') {
        throw new Error('background 必须是布尔值');
      }
      if (obj.background === true && options.submitBackground === undefined) {
        throw new Error('当前环境不支持后台执行');
      }
      if (
        obj.timeoutMs !== undefined &&
        (typeof obj.timeoutMs !== 'number' || obj.timeoutMs <= 0)
      ) {
        throw new Error('timeoutMs 必须是正数');
      }

      return {
        code: obj.code,
        ...(typeof obj.background === 'boolean' ? { background: obj.background } : {}),
        ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      let kernel: JupyterKernel;
      // 内核按 kernelKey 复用。子 agent 各有自己的键，否则并行时第二个必然撞上
      // 「该内核已有执行在途」
      const kernelKey = ctx.kernelKey ?? ctx.conversationId;
      try {
        kernel = await options.pool.acquire(kernelKey, options.language);
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'KernelUnavailable',
            evalue:
              `无法启动 ${meta.name} 内核：${err instanceof Error ? err.message : String(err)}\n` +
              (REMEDIATION[meta.capability] ?? ''),
            traceback: [],
          },
        };
      }

      if (input.background === true && options.submitBackground !== undefined) {
        let taskId: string;
        try {
          taskId = options.submitBackground(
            (k) =>
              k.execute(
                input.code,
                input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
              ),
            {
              language: options.language,
              code: input.code,
              conversationId: ctx.conversationId,
              kernelKey,
            },
          );
        } catch (err) {
          // 达到并发上限是正常结果（不是 bug），要如实回给模型让它等或改前台跑
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'BackgroundRejected',
              evalue: err instanceof Error ? err.message : String(err),
              traceback: [],
            },
          };
        }
        return {
          ok: true,
          backgroundTaskId: taskId,
          output: {
            kind: 'text',
            text:
              `已转入后台执行，任务 id ${taskId}。` +
              '完成后结果会自动回到会话里，期间可以继续做别的事。' +
              '注意它跑在新内核里，本会话的变量在那边不存在。',
          },
        };
      }

      /*
       * 会话中断要传到内核。
       *
       * 没有这一步的话，用户点「中断」只会 abort 编排器的控制器，而正在跑的
       * Python cell 完全不受影响——它会继续跑到结束，期间内核被占住，
       * 用户的下一条消息还会撞上「该内核已有执行在途」。表现是「点了停止没反应」。
       *
       * 必须等 interrupt 的真实结果：`restarted` 会清空变量，不能当成
       * KeyboardInterrupt 成功。真中断（`interrupted`）仍走原来的执行输出。
       */
      let interruptDone: Promise<'idle' | 'interrupted' | 'restarted' | false> | null = null;
      const onAbort = (): void => {
        interruptDone = options.pool
          .interrupt(kernelKey, options.language)
          .catch(() => false as const);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      const afterInterrupt = async (fallback: ToolResult): Promise<ToolResult> => {
        if (interruptDone === null) return fallback;
        const outcome = await interruptDone;
        if (outcome === 'restarted') {
          return {
            ok: false,
            output: { kind: 'text', text: '已中断并重启内核，变量已清空' },
          };
        }
        return fallback;
      };

      try {
        const outputs = kernel.execute(
          input.code,
          input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
        );
        const collected = await collectExecution(outputs, ctx.onPartial);
        return await afterInterrupt(formatExecution(collected));
      } catch (err) {
        // 执行期抛错（内核崩溃、超时中断失败退化为重启）与代码本身报错不同：
        // 后者由 collected.error 表达，这里是基础设施层面的失败
        return await afterInterrupt({
          ok: false,
          output: {
            kind: 'error',
            ename: 'KernelExecutionFailed',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        });
      } finally {
        // 摘掉监听器。不摘的话一个长会话里的每次执行都会往同一个 signal 上挂一个，
        // 而它们全都指向已经结束的执行
        ctx.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
