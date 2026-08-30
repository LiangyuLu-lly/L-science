/**
 * Windows 适配器（任务 15.1，需求 20.4.1）。
 *
 * 这是**权威实现**：平台的全部功能都在 Windows 上验证过，其它适配器的定位是
 * 「让移植的工作量可见」，不是「已经支持」。
 *
 * 里面几条非显然的取值都是实测踩出来的，注释写明理由——它们看起来像可以简化的
 * 地方，而简化会让某个功能静默走错分支。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { KillTreeSpec, PlatformAdapter, ShellInvocation } from './types.js';

/**
 * 给 PowerShell 命令加编码前导。
 *
 * 命令文本经 `-EncodedCommand`（UTF-16LE）传入不会有问题，但 PowerShell 的**输出**
 * 默认用控制台的 OEM 代码页（简体中文机器上是 936/GBK）。我们按 UTF-8 解码 stdout，
 * 于是任何非 ASCII 输出都会变成乱码——对一个中文平台来说这是必然会撞上的问题。
 *
 * `$OutputEncoding` 管 PowerShell 传给原生命令的编码，`[Console]::OutputEncoding`
 * 管读取原生命令输出与写自身输出的编码，两者都要设。
 */
export function withUtf8Preamble(command: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    command,
  ].join('\n');
}

/**
 * 定位 PowerShell。
 *
 * 优先系统自带的 5.1（路径固定、一定存在），其次 PATH 里的 `pwsh.exe`。顺序刻意
 * 如此：`pwsh` 是可选安装的，而按 PATH 找的话在没装 PowerShell 7 的机器上会得到
 * ENOENT，而那条错误看起来像「shell 不可用」而不是「PowerShell 7 没装」。
 */
export function findPowerShell(): string {
  const legacy = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return existsSync(legacy) ? legacy : 'pwsh.exe';
}

export const windowsAdapter: PlatformAdapter = {
  id: 'win32',
  label: 'Windows',
  // 平台的全部功能都在这里验证过
  gaps: [],

  /* ---------------- 路径 ---------------- */

  defaultDataDir(appName) {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData !== '') return join(localAppData, appName);
    /*
     * `%LOCALAPPDATA%` 缺失的兜底。
     *
     * 它在正常的 Windows 会话里一定存在，但服务账户与某些 CI 容器里不设。落到
     * `~/AppData/Local` 而不是 `~/.l-science`：前者仍然是 Windows 的约定位置，
     * 而后者会让同一台机器上两种启动方式用两个不同的数据目录——那时用户看到的是
     * 「我的项目不见了」。
     */
    return join(homedir(), 'AppData', 'Local', appName);
  },

  // NTFS 默认不区分大小写。按区分处理会让路径授权检查放过一个已经被拒绝的路径
  pathsCaseSensitive: false,

  normalizeForCompare(path) {
    // 反斜杠与正斜杠在 Windows 上等价；末尾斜杠不影响指向
    return path
      .replace(/[\\/]+$/u, '')
      .replace(/\\/gu, '/')
      .toLowerCase();
  },

  // conda 环境的 python 直接在 prefix 根上，venv 的在 Scripts 下
  binDirs: ['', 'Scripts'],
  executableExtensions: ['.exe', '.cmd', '.bat', ''],

  /* ---------------- shell ---------------- */

  defaultShell: 'powershell',

  supportsShell(family) {
    // posix shell 在 Windows 上要靠 WSL2。这里只说「有可能」，真实可用性由能力探测确认
    return family === 'powershell' || family === 'posix';
  },

  shellInvocation({ family, command }): ShellInvocation | null {
    if (family === 'powershell') {
      return {
        command: findPowerShell(),
        args: [
          '-NoProfile',
          '-NonInteractive',
          // 用 Base64 传命令：命令文本经多层传参时引号会被剥掉，
          // 这是实测反复踩到的问题（IRkernel 启动、conda run 都撞过）
          '-EncodedCommand',
          Buffer.from(withUtf8Preamble(command), 'utf16le').toString('base64'),
        ],
        encoded: true,
      };
    }
    // 经 WSL2 起 bash。`-e` 避免走登录 shell 的初始化脚本
    return { command: 'wsl.exe', args: ['-e', 'bash', '-lc', command], encoded: false };
  },

  whichCommand(name) {
    return { command: 'where', args: [name] };
  },

  /* ---------------- 进程 ---------------- */

  /*
   * 不建独立进程组。
   *
   * Windows 上整组终止由 Job Object 负责（`KILL_ON_JOB_CLOSE` 是内核级保证）。
   * 建组反而会让 `taskkill /T` 的父子关系记录失效——而那是 Job Object 不可用时的
   * 唯一兜底。
   */
  detachChildren: false,

  killTree(pid): KillTreeSpec {
    return {
      command: 'taskkill',
      args: ['/PID', String(pid), '/T', '/F'],
      // Windows 没有进程组信号
      signalFallback: null,
    };
  },

  memoryProbe(pid) {
    return {
      command: 'tasklist',
      args: ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
      parse: (stdout) => {
        // CSV 的最后一列是 `"12,345 K"`
        const match = /"([\d,]+) K"\s*$/.exec(stdout.trim());
        if (match === null) return null;
        const kb = Number((match[1] ?? '').replace(/,/gu, ''));
        return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
      },
    };
  },

  /* ---------------- 环境 ---------------- */

  pathEnvVar: 'PATH',
  pathSeparator: ';',
  homeEnvVars: ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'],
};
