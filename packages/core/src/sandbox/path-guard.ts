/**
 * 路径守卫。
 *
 * 所有来自 agent 的路径参数都必须先过这里。它是 `native` 后端下**唯一真正起作用**
 * 的文件系统边界——没有内核命名空间可依赖，越界与否完全取决于这里判得准不准。
 *
 * Windows 的路径语义有一批容易被忽略的等价写法，每一条都能绕过朴素的前缀比较：
 *
 * - `..` 穿越；大小写差异（NTFS 默认不区分大小写）
 * - 短名（8.3）别名：`PROGRA~1` 等价于 `Program Files`
 * - 长路径前缀 `\\?\`：绕过规范化，`\\?\C:\a\..\b` 不会被系统折叠
 * - UNC 路径 `\\server\share`：完全在允许根之外
 * - 备用数据流 `file.txt:hidden`：写入的是同一文件的另一条流
 * - 保留设备名 `CON`/`NUL`/`COM1`：打开的是设备而非文件
 * - 尾随点与空格：`C:\a\b.` 与 `C:\a\b ` 被系统解析为 `C:\a\b`
 * - 符号链接与 junction：路径字符串合法但实际指向别处
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

export type PathDenyReason =
  | 'not-absolute'
  | 'nul-byte'
  | 'unc-path'
  | 'long-path-prefix'
  | 'alternate-data-stream'
  | 'reserved-device-name'
  | 'trailing-dot-or-space'
  | 'short-name-alias'
  | 'outside-allowed-roots'
  | 'symlink-escape'
  | 'protected-path'
  | 'read-only-grant';

export interface PathDecision {
  allowed: boolean;
  /** 规范化后的绝对路径。拒绝时仍尽量给出，便于错误信息定位。 */
  resolved: string;
  reason?: PathDenyReason;
  detail?: string;
}

export type AccessMode = 'read' | 'write';

/** Windows 保留设备名。带任意扩展名同样生效（`NUL.txt` 仍是设备）。 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * 受保护路径的片段模式。命中即拒写。
 *
 * 覆盖凭据、可被用来实现代码执行的配置（git hooks、编辑器任务、shell 启动脚本），
 * 以及平台自身的数据目录——后者若可写，agent 就能改自己的数据库与设置。
 */
const PROTECTED_SEGMENTS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /(^|[\\/])\.ssh([\\/]|$)/i, what: 'SSH 密钥目录' },
  { pattern: /(^|[\\/])\.gnupg([\\/]|$)/i, what: 'GnuPG 目录' },
  { pattern: /(^|[\\/])\.aws([\\/]|$)/i, what: 'AWS 凭据目录' },
  { pattern: /(^|[\\/])\.git[\\/]config$/i, what: 'git 仓库配置' },
  { pattern: /(^|[\\/])\.git[\\/]hooks([\\/]|$)/i, what: 'git 钩子（可执行）' },
  { pattern: /(^|[\\/])\.git[\\/]modules([\\/]|$)/i, what: 'git 子模块元数据' },
  { pattern: /(^|[\\/])\.vscode([\\/]|$)/i, what: 'VS Code 配置（tasks.json 可执行）' },
  { pattern: /(^|[\\/])\.idea([\\/]|$)/i, what: 'JetBrains 配置' },
  { pattern: /(^|[\\/])\.npmrc$/i, what: 'npm 配置（可含 token）' },
  { pattern: /(^|[\\/])\.netrc$/i, what: 'netrc 凭据' },
  { pattern: /(^|[\\/])\.bashrc$/i, what: 'shell 启动脚本' },
  { pattern: /(^|[\\/])\.zshrc$/i, what: 'shell 启动脚本' },
  { pattern: /(^|[\\/])\.profile$/i, what: 'shell 启动脚本' },
  { pattern: /Microsoft\.PowerShell_profile\.ps1$/i, what: 'PowerShell 启动脚本' },
  { pattern: /Microsoft\.VSCode_profile\.ps1$/i, what: 'PowerShell 启动脚本' },
  { pattern: /(^|[\\/])profile\.ps1$/i, what: 'PowerShell 启动脚本' },
  { pattern: /(^|[\\/])Startup([\\/]|$)/i, what: '开机启动目录' },
  { pattern: /(^|[\\/])LaunchAgents([\\/]|$)/i, what: 'launchd 配置' },
];

export interface PathGuardOptions {
  /** 允许访问的根目录。空数组表示一律拒绝。 */
  roots: readonly string[];
  /** 只读根目录。命中这些根的写入会被拒。 */
  readOnlyRoots?: readonly string[];
  /** 额外的受保护路径（例如平台自身的数据目录）。 */
  protectedPaths?: readonly string[];
  /** 平台在非 Windows 上跑时区分大小写。 */
  caseSensitive?: boolean;
}

function canonical(p: string, caseSensitive: boolean): string {
  return caseSensitive ? p : p.toLowerCase();
}

/** 判断 child 是否在 parent 之内（或等于 parent）。 */
function isWithin(child: string, parent: string, caseSensitive: boolean): boolean {
  const c = canonical(child, caseSensitive);
  const p = canonical(parent, caseSensitive).replace(/[\\/]+$/, '');
  if (c === p) return true;
  return c.startsWith(p + sep) || c.startsWith(`${p}/`);
}

/**
 * 找到路径中最近的已存在祖先。
 *
 * 用于对尚不存在的目标路径做符号链接检查：`realpathSync` 对不存在的路径会抛错，
 * 但我们仍需确认它的父链没有被链接指向别处——否则「在允许根下创建新文件」就能
 * 通过一个指向外部的目录链接落到根外。
 */
function nearestExisting(p: string): string | null {
  let current = p;
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return null;
      current = parent;
    }
  }
}

export class PathGuard {
  readonly #roots: string[];
  readonly #readOnlyRoots: string[];
  readonly #protectedPaths: string[];
  readonly #caseSensitive: boolean;

  constructor(opts: PathGuardOptions) {
    this.#caseSensitive = opts.caseSensitive ?? process.platform !== 'win32';
    // 根目录本身也要真实化：若 workspace 自己就在一个 junction 下，
    // 后续对 realpath 的比较会全部落空。
    this.#roots = opts.roots.map((r) => PathGuard.#realOrSelf(resolve(r)));
    this.#readOnlyRoots = (opts.readOnlyRoots ?? []).map((r) => PathGuard.#realOrSelf(resolve(r)));
    this.#protectedPaths = (opts.protectedPaths ?? []).map((r) =>
      PathGuard.#realOrSelf(resolve(r)),
    );
  }

  static #realOrSelf(p: string): string {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  }

  get roots(): readonly string[] {
    return this.#roots;
  }

  /** 校验并返回可安全使用的绝对路径；越界时抛出带原因的错误。 */
  assert(input: string, mode: AccessMode): string {
    const decision = this.check(input, mode);
    if (!decision.allowed) {
      throw new PathDeniedError(decision);
    }
    return decision.resolved;
  }

  check(input: string, mode: AccessMode): PathDecision {
    // 1. NUL 字节：能在部分系统调用里截断字符串，让校验与实际打开的路径不一致
    if (input.includes('\0')) {
      return { allowed: false, resolved: input, reason: 'nul-byte' };
    }

    // 2. 长路径前缀绕过规范化，一律拒绝而不是尝试处理
    if (/^\\\\[?.]\\/.test(input)) {
      return {
        allowed: false,
        resolved: input,
        reason: 'long-path-prefix',
        detail: '\\\\?\\ 与 \\\\.\\ 前缀会绕过路径规范化',
      };
    }

    // 3. UNC 路径整体在允许根之外
    if (/^\\\\/.test(input) || /^\/\//.test(input)) {
      return { allowed: false, resolved: input, reason: 'unc-path' };
    }

    if (!isAbsolute(input)) {
      return { allowed: false, resolved: input, reason: 'not-absolute' };
    }

    const normalized = normalize(input);

    // 4. 备用数据流：冒号只允许出现在盘符位置
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, '');
    if (withoutDrive.includes(':')) {
      return {
        allowed: false,
        resolved: normalized,
        reason: 'alternate-data-stream',
        detail: '路径中出现额外的冒号',
      };
    }

    const segments = withoutDrive.split(/[\\/]/).filter((s) => s !== '');

    for (const segment of segments) {
      // 5. 保留设备名（含带扩展名的形式）
      const base = (segment.split('.')[0] ?? '').toLowerCase();
      if (RESERVED_DEVICE_NAMES.has(base)) {
        return {
          allowed: false,
          resolved: normalized,
          reason: 'reserved-device-name',
          detail: segment,
        };
      }
      // 6. 尾随点或空格会被系统静默剥掉，造成校验与实际不一致
      if (/[. ]$/.test(segment)) {
        return {
          allowed: false,
          resolved: normalized,
          reason: 'trailing-dot-or-space',
          detail: segment,
        };
      }
      // 7. 8.3 短名别名
      if (/~\d+$/.test(segment)) {
        return {
          allowed: false,
          resolved: normalized,
          reason: 'short-name-alias',
          detail: segment,
        };
      }
    }

    // 8. 规范化后仍须落在允许根内（这一步挡掉 .. 穿越）
    if (!this.#roots.some((root) => isWithin(normalized, root, this.#caseSensitive))) {
      return { allowed: false, resolved: normalized, reason: 'outside-allowed-roots' };
    }

    // 9. 真实化后再查一次，挡掉符号链接与 junction 指向根外的情况。
    //    对尚不存在的路径，检查最近的已存在祖先。
    const probe = nearestExisting(normalized);
    if (probe !== null) {
      const real = PathGuard.#realOrSelf(probe);
      if (
        real !== probe &&
        !this.#roots.some((root) => isWithin(real, root, this.#caseSensitive))
      ) {
        return {
          allowed: false,
          resolved: normalized,
          reason: 'symlink-escape',
          detail: `${probe} 实际指向 ${real}`,
        };
      }
    }

    // 10. 受保护路径：仅拦写，读取无害且有诊断价值
    if (mode === 'write') {
      for (const { pattern, what } of PROTECTED_SEGMENTS) {
        if (pattern.test(normalized)) {
          return { allowed: false, resolved: normalized, reason: 'protected-path', detail: what };
        }
      }
      for (const p of this.#protectedPaths) {
        if (isWithin(normalized, p, this.#caseSensitive)) {
          return {
            allowed: false,
            resolved: normalized,
            reason: 'protected-path',
            detail: `位于受保护目录 ${p}`,
          };
        }
      }
      if (this.#readOnlyRoots.some((r) => isWithin(normalized, r, this.#caseSensitive))) {
        return { allowed: false, resolved: normalized, reason: 'read-only-grant' };
      }
    }

    return { allowed: true, resolved: normalized };
  }
}

export class PathDeniedError extends Error {
  readonly reason: PathDenyReason;
  readonly resolved: string;
  readonly detail?: string;

  constructor(decision: PathDecision) {
    super(PathDeniedError.#message(decision));
    this.name = 'PathDeniedError';
    this.reason = decision.reason ?? 'outside-allowed-roots';
    this.resolved = decision.resolved;
    if (decision.detail !== undefined) this.detail = decision.detail;
  }

  static #message(d: PathDecision): string {
    const detail = d.detail === undefined ? '' : `（${d.detail}）`;
    switch (d.reason) {
      case 'not-absolute':
        return `路径必须是绝对路径：${d.resolved}`;
      case 'nul-byte':
        return '路径含 NUL 字节';
      case 'unc-path':
        return `不允许访问 UNC 网络路径：${d.resolved}`;
      case 'long-path-prefix':
        return `不允许使用长路径前缀：${d.resolved}${detail}`;
      case 'alternate-data-stream':
        return `不允许访问备用数据流：${d.resolved}${detail}`;
      case 'reserved-device-name':
        return `不允许访问保留设备名：${d.resolved}${detail}`;
      case 'trailing-dot-or-space':
        return `路径片段不得以点或空格结尾：${d.resolved}${detail}`;
      case 'short-name-alias':
        return `不允许使用 8.3 短名：${d.resolved}${detail}`;
      case 'symlink-escape':
        return `路径经链接指向了允许范围之外：${d.resolved}${detail}`;
      case 'protected-path':
        return `该路径受保护，禁止写入：${d.resolved}${detail}`;
      case 'read-only-grant':
        return `该路径为只读授权，禁止写入：${d.resolved}`;
      default:
        return `路径不在允许范围内：${d.resolved}`;
    }
  }
}
