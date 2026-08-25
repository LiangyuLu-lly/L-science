/**
 * `bash` 工具（任务 6.3，需求 4.1-4.5）。
 *
 * 执行本身交给沙箱后端的 `runShell`，本模块只做三件后端不该管的事：入参校验、
 * shell 可用性判断、以及把结果整理成给模型看的文本。
 *
 * 刻意不自己拼进程：后端已经处理了 WSL 路径转换、UTF-8 编码前导、进程树终止
 * 这些平台细节。绕过它去直接 spawn 会让 wsl2 后端下的路径全错——宿主的
 * `D:\proj` 在发行版内是 `/mnt/d/proj`，而这个转换只有后端知道怎么做。
 *
 * 三条与需求直接对应的行为：
 *
 * - **输出有上限且截断必须标注**（需求 4.3）。一次 `pip install` 能刷出几万行，
 *   全塞进上下文会挤掉真正重要的内容。但静默截断更糟：模型会基于半截输出
 *   下结论，而它无从知道后面还有东西。
 * - **非零退出返回完整三元组**（需求 4.4）。尤其不能因为退出码非零就丢掉
 *   stdout——很多工具把有用的信息写在那里。
 * - **不吞退出码**（需求 4.5）。成功时也标注，否则模型无法区分
 *   「命令成功且无输出」与「输出被吞了」。
 */

import type { SandboxBackend, ShellKind, ShellResult } from '../sandbox/backend.js';
import { CAPABILITY, REMEDIATION } from './capabilities.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

export type { ShellKind } from '../sandbox/backend.js';

/** 单个流的字符上限。超过后截断并标注。 */
const MAX_STREAM_CHARS = 60_000;

/** 默认墙钟超时。命令跑不完不该无限占着会话。 */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellInput {
  command: string;
  shell: ShellKind;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * 截断长输出并标注。
 *
 * 保留头尾而不是只保留头部：命令的失败原因通常在末尾（错误摘要、栈顶），
 * 上下文通常在开头。只留头部会把最重要的那部分丢掉。
 */
export function truncateStream(text: string, limit = MAX_STREAM_CHARS): string {
  if (text.length <= limit) return text;

  const headSize = Math.floor(limit * 0.4);
  const tailSize = limit - headSize;
  const omitted = text.length - limit;

  return [
    text.slice(0, headSize),
    `\n\n[... 已省略 ${String(omitted)} 个字符（共 ${String(text.length)} 字符，超出 ${String(limit)} 上限）...]\n\n`,
    text.slice(text.length - tailSize),
  ].join('');
}

/** 把执行结果组装成给模型看的文本。 */
export function formatShellResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated?: boolean;
}): string {
  const parts: string[] = [];

  const stdout = truncateStream(result.stdout);
  const stderr = truncateStream(result.stderr);

  if (stdout !== '') parts.push(`<stdout>\n${stdout}\n</stdout>`);
  if (stderr !== '') parts.push(`<stderr>\n${stderr}\n</stderr>`);
  if (stdout === '' && stderr === '') parts.push('(没有输出)');

  // 后端层面的截断与本模块的截断都要标注：前者是字节上限，后者是字符上限，
  // 两道都可能触发，只报一道会让用户以为输出是完整的
  if (result.truncated === true) {
    parts.push('<note>输出在采集阶段已被后端截断（超出字节上限）</note>');
  }

  parts.push(
    result.timedOut
      ? '<exit>超时被终止</exit>'
      : `<exit>退出码 ${result.exitCode === null ? '未知' : String(result.exitCode)}</exit>`,
  );

  return parts.join('\n');
}

export interface ShellToolOptions {
  /** 沙箱后端。执行与路径转换都由它负责。 */
  backend: SandboxBackend;
  /** 解析并校验工作目录。通常接 PathGuard。 */
  resolveCwd: (raw: string | undefined, ctx: ToolContext) => string;
}

export function createShellTool(options: ShellToolOptions): ToolDefinition<ShellInput> {
  const { backend } = options;

  // 可用的 shell 由后端回答，而不是靠探测 PATH。Git for Windows 也提供
  // bash.exe，但它跑在 Windows 上，与 WSL2 里的 bash 在路径语义、权限模型、
  // 可用工具链上都不同。把两者混为一谈会让脚本在开发机上能跑、在别处莫名失败
  const allowed: ShellKind[] = (['powershell', 'bash'] as const).filter((k) =>
    backend.supportsShell(k),
  );
  const preferred: ShellKind = allowed.includes('powershell') ? 'powershell' : 'bash';

  return {
    name: 'bash',
    description:
      '在会话工作目录里执行 shell 命令，返回 stdout、stderr 与退出码三者。' +
      `当前可用的 shell：${allowed.join('、')}。` +
      '超长输出会被截断并明确标注截断位置。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        shell: {
          type: 'string',
          enum: allowed,
          description:
            'powershell 跑在 Windows 上，bash 跑在 WSL2 里。两者的路径写法与可用工具不同，' +
            `不要假设同一条命令在两边都能跑。默认 ${preferred}。`,
        },
        cwd: { type: 'string', description: '工作目录，相对会话工作目录。省略则用会话工作目录。' },
        timeoutMs: {
          type: 'number',
          description: `墙钟超时，默认 ${String(DEFAULT_TIMEOUT_MS)} 毫秒`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    requirements: [
      {
        capability: preferred === 'powershell' ? CAPABILITY.shellPowershell : CAPABILITY.shellBash,
        remediation:
          REMEDIATION[
            preferred === 'powershell' ? CAPABILITY.shellPowershell : CAPABILITY.shellBash
          ] ?? '',
      },
    ],

    parseInput(raw): ShellInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      const command = obj.command;
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('command 必须是非空字符串');
      }

      const requested = obj.shell;
      const shell = requested === undefined ? preferred : (requested as ShellKind);
      if (!allowed.includes(shell)) {
        throw new Error(
          `shell="${String(requested)}" 在当前后端（${backend.id}）不可用。可用：${allowed.join('、')}。` +
            (shell === 'bash' ? ` ${REMEDIATION[CAPABILITY.shellBash] ?? ''}` : ''),
        );
      }

      const timeoutMs = obj.timeoutMs;
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
        throw new Error('timeoutMs 必须是正数');
      }

      return {
        command,
        shell,
        ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      let cwd: string;
      try {
        cwd = options.resolveCwd(input.cwd, ctx);
      } catch (err) {
        // 路径越界是入参问题而不是执行失败，但发生在执行阶段（需要 ctx），
        // 因此作为 error 输出返回而不是抛 ToolInputError
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'PathDenied',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        };
      }

      let result: ShellResult;
      try {
        result = await backend.runShell({
          command: input.command,
          cwd,
          shell: input.shell,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'ShellSpawnError',
            evalue: `无法执行命令：${err instanceof Error ? err.message : String(err)}`,
            traceback: [],
          },
        };
      }

      // 非零退出仍返回 text 而不是 error：stdout 上的内容有诊断价值。
      // ok 标记失败，输出保留完整三元组
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        output: {
          kind: 'text',
          text: formatShellResult({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
          }),
        },
      };
    },
  };
}
