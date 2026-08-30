/**
 * POSIX 适配器（Linux / macOS）（任务 15.1，需求 20.4.1）。
 *
 * ## 这个文件的定位
 *
 * 需求 20.4.1 要的是「为后续支持 Linux 与 macOS **留出空间**」，不是现在就支持。
 * 因此这个适配器**不声称可用**：路径与 shell 那两组是完整且正确的（它们是纯映射），
 * 而进程管控与凭据加密这两块在这些平台上是完全不同的一套机制，那部分由 `gaps`
 * 如实列出。
 *
 * 把它写出来而不是留个 TODO，有两个具体作用：
 *
 * 1. **让平台差异变成可枚举的清单。** 在这之前，「移植到 Linux 还差什么」只能靠把
 *    十几处 `process.platform === 'win32'` 逐个读一遍来回答，而漏掉一处的表现不是
 *    编译失败，是在那个平台上某个功能静默走错分支。
 * 2. **让抽象层真的被约束住。** 只有一个实现的接口会慢慢长出 Windows 专属的形状
 *    （比如某个方法返回一个 `taskkill` 命令串），而第二个实现的存在会让那种泄漏
 *    立刻变成编译错误。
 *
 * `gaps` 里每一条都说清**降级之后的实际行为**，不只是「不支持」。用户需要知道的是
 * 「那我现在得到的是什么」。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { KillTreeSpec, PlatformAdapter, PlatformId, ShellInvocation } from './types.js';

/**
 * 两个平台共有的缺口。
 *
 * 都源自同一件事：现有实现依赖三个 Windows 独有的机制（Job Object、DPAPI、
 * 可继承 Event 句柄），而它们在 POSIX 上各有对应物但都还没实现。
 */
const COMMON_GAPS = [
  {
    id: 'resource-limits',
    what: '没有 Job Object 那样的内核级内存限额',
    consequence:
      '资源限额退化成轮询检查（每 3 秒读一次内存）。进程可以在两次轮询之间冲到任意' +
      '大小，因此「限 4 GB」实际上是「超过 4 GB 后最多 3 秒内被杀」。墙钟上限不受影响。',
    plan: 'cgroups v2（Linux）或 `setrlimit` + `posix_spawn`（macOS）。前者要写 cgroup 文件、需要权限；后者只能限虚拟内存，与实际占用差得远。',
  },
  {
    id: 'credential-vault',
    what: '没有 DPAPI，凭据库无法加密落盘',
    consequence:
      '凭据库整体不可用——不是「明文存」，是**拒绝存**。API key 只能每次从环境变量读，' +
      '供应商配置里的 credentialRef 会一直报「凭据不存在」。这是刻意的：明文落盘比' +
      '不落盘更糟，因为用户会以为它被保护着。',
    plan: 'libsecret / gnome-keyring（Linux）或 Keychain Services（macOS）。两者都需要一个原生绑定，而那与需求 20.1 的零编译约束冲突——要么找到提供预编译产物的绑定，要么走各自的命令行工具（`secret-tool` / `security`）。',
  },
  {
    id: 'kernel-interrupt',
    what: '没有可继承的 Event 句柄',
    consequence:
      '这一条在 POSIX 上**反而更好**：ipykernel 在非 Windows 上支持标准的 SIGINT，' +
      '因此中断不需要 Windows 那套 Event 机制。但当前代码里中断路径是围绕 Event 写的，' +
      '未经改造时会退化成重启内核（丢掉内存状态）。',
    plan: '给内核层加一条 POSIX 分支：直接向内核进程发 SIGINT。工作量小，但要改的是 `packages/kernel` 而不是这一层。',
  },
  {
    id: 'sandbox-backend',
    what: 'wsl2 后端不适用，且没有替代的强隔离后端',
    consequence:
      '只有 native 后端可用，即文件系统边界靠工具层路径校验、网络出口靠代理环境变量' +
      '——两者都能被有意为之的代码绕过。隔离徽章会如实显示为 weak。',
    plan: 'Linux 上可以做 namespace 后端（unshare + bind mount），那是比 WSL2 更强的隔离。macOS 上没有等价物，只能靠 sandbox-exec（已被 Apple 标为废弃）。',
  },
] as const;

const MACOS_GAPS = [
  {
    id: 'data-dir-convention',
    what: '数据目录放在 `~/Library/Application Support` 下',
    consequence:
      '这不是缺陷，是约定差异。但它意味着 Time Machine 会把数据目录按应用数据处理，' +
      '而项目库里可能有几十 GB 的制品——用户的备份体积会因此变化，而他不会预期到。',
    plan: '在设置页说明数据目录位置，并提示 blob 目录可以排除出备份。',
  },
] as const;

function posixDataDir(appName: string, id: PlatformId): string {
  if (id === 'darwin') {
    // macOS 的约定位置。混成 `~/.l-science` 能跑，但那个目录不会被 Time Machine
    // 按应用数据处理，而用户以为它被备份了
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  // Linux 走 XDG。`$XDG_DATA_HOME` 未设时的默认值由规范给定
  const xdg = process.env['XDG_DATA_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
  return join(base, appName);
}

function posixAdapter(id: 'linux' | 'darwin'): PlatformAdapter {
  return {
    id,
    label: id === 'darwin' ? 'macOS' : 'Linux',
    gaps: id === 'darwin' ? [...COMMON_GAPS, ...MACOS_GAPS] : [...COMMON_GAPS],

    /* ---------------- 路径 ---------------- */

    defaultDataDir(appName) {
      return posixDataDir(appName, id);
    },

    /*
     * 区分大小写。
     *
     * 严格说 macOS 的默认 APFS 卷是**不**区分大小写的，而 Linux 的 ext4 区分。
     * 这里对 macOS 也报「区分」是刻意的保守选择：按区分处理时，`/Data` 与 `/data`
     * 被当成两个路径，于是路径授权要各自授权一次——多问一次。反过来（按不区分处理
     * 而文件系统区分）会让一条对 `/data` 的授权放过 `/Data`，而那是两个不同的目录。
     * 两个方向的错误代价不对称。
     */
    pathsCaseSensitive: true,

    normalizeForCompare(path) {
      // 只去末尾斜杠，不动大小写
      return path.replace(/\/+$/u, '');
    },

    binDirs: ['bin'],
    executableExtensions: [''],

    /* ---------------- shell ---------------- */

    defaultShell: 'posix',

    supportsShell(family) {
      // PowerShell Core 在 POSIX 上装得上，但平台的 PowerShell 代码路径依赖
      // Windows 专属的编码前导与路径形式，因此如实报不支持
      return family === 'posix';
    },

    shellInvocation({ family, command }): ShellInvocation | null {
      if (family !== 'posix') return null;
      /*
       * 用 `/bin/sh -lc` 而不是 bash。
       *
       * `/bin/sh` 一定存在；bash 在 Alpine 这类发行版上默认没有。`-l` 让 PATH 与
       * conda 的初始化生效——不加的话 `conda activate` 在非交互 shell 里不可用，
       * 而那是环境管理的主要路径。
       */
      return { command: '/bin/sh', args: ['-lc', command], encoded: false };
    },

    whichCommand(name) {
      // `command -v` 比 `which` 可移植（POSIX 规定了它，which 没有），但它是 shell
      // 内建而不是可执行文件，不能直接 spawn。因此仍用 which——它在 Linux 与 macOS
      // 上都存在
      return { command: 'which', args: [name] };
    },

    /* ---------------- 进程 ---------------- */

    // POSIX 上建独立进程组才能整组终止
    detachChildren: true,

    killTree(pid): KillTreeSpec {
      return {
        // pkill -g 按进程组杀。不用 `kill -- -pid` 是因为它要求调用方自己处理
        // 「进程组不存在」的错误，而那在进程已自行退出时是正常情况
        command: 'pkill',
        args: ['-KILL', '-g', String(pid)],
        // pkill 不存在时（极简容器）退回向进程组发信号
        signalFallback: { negatePid: true, signal: 'SIGKILL' },
      };
    },

    memoryProbe(pid) {
      return {
        // `ps -o rss=` 输出单列 KB，不带表头，最容易解析
        command: 'ps',
        args: ['-o', 'rss=', '-p', String(pid)],
        parse: (stdout) => {
          const first = stdout.trim().split('\n')[0]?.trim() ?? '';
          /*
           * 必须显式匹配数字，不能只靠 `Number()`。
           *
           * 进程已退出时 `ps` 什么都不输出，而 `Number('')` 是 **0** 而不是 NaN——
           * 于是「读不到」会被当成「占用 0 MB」。方向上这是把未知说成正常，正是
           * 资源限额检查最不该出现的那种错。
           */
          if (!/^\d+$/u.test(first)) return null;
          return Math.round(Number(first) / 1024);
        },
      };
    },

    /* ---------------- 环境 ---------------- */

    pathEnvVar: 'PATH',
    pathSeparator: ':',
    homeEnvVars: ['HOME'],
  };
}

export const linuxAdapter: PlatformAdapter = posixAdapter('linux');
export const darwinAdapter: PlatformAdapter = posixAdapter('darwin');
