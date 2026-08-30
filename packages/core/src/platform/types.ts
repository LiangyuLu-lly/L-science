/**
 * 平台抽象层的类型（任务 15.1，需求 20.4.1）。
 *
 * 需求 20.4.1 要求「路径、shell 与环境处理集中在可替换的抽象层，为后续支持 Linux 与
 * macOS 留出空间」。这一层的价值不在于「现在就能跑在 Linux 上」——它不能，见
 * `PlatformGap`——而在于**让平台差异变成可枚举的清单**。
 *
 * 在这之前，`process.platform === 'win32'` 散在十几个文件里：内核启动、进程树终止、
 * 路径大小写、`where`/`which`、PowerShell 定位、conda 环境布局。要判断「移植到 Linux
 * 还差什么」，唯一的办法是把这十几处逐个读一遍并自己在脑子里合并——而漏掉一处的表现
 * 不是编译失败，是在那个平台上某个功能静默走错分支。
 *
 * 集中之后，「还差什么」这个问题有了一个可以读的答案：`PlatformAdapter` 的实现列表，
 * 加上每个实现自己声明的 `gaps`。
 */

export type PlatformId = 'win32' | 'linux' | 'darwin';

/** 平台无关的 shell 种类。 */
export type ShellFamily = 'powershell' | 'posix';

/**
 * 这个平台上**做不到**的事。
 *
 * 刻意做成数据而不是注释：一份「Linux 上还缺什么」的清单如果只存在于注释里，它会
 * 在第一次重构后失效，而失效不会有任何信号。做成数据之后 `doctor` 能打印它、UI 能
 * 显示它、测试能断言它非空——也就是说它有机会被维护。
 *
 * 每条都要说清**降级之后的实际行为**，而不只是「不支持」。用户需要知道的是
 * 「那我现在得到的是什么」。
 */
export interface PlatformGap {
  /** 能力标识，例如 `resource-limits`。 */
  id: string;
  /** 一句话说明缺的是什么。 */
  what: string;
  /** 缺失之后实际发生什么。必须具体。 */
  consequence: string;
  /** 在这个平台上该怎么补。没有已知方案时为 null。 */
  plan: string | null;
}

/** 进程树终止的方式。 */
export interface KillTreeSpec {
  command: string;
  args: readonly string[];
  /**
   * 命令不可用时的兜底：直接向进程组发信号。
   *
   * Windows 上为 null（没有进程组概念，只有 Job Object 与 `taskkill /T`）。
   */
  signalFallback: { negatePid: boolean; signal: NodeJS.Signals } | null;
}

/** 一次 shell 调用的参数化。 */
export interface ShellInvocation {
  command: string;
  args: readonly string[];
  /**
   * 是不是把命令文本编码进了参数（而不是原样传）。
   *
   * PowerShell 走 `-EncodedCommand`（base64 的 UTF-16LE），因为命令文本经多层传参时
   * 引号会被剥掉——这是实测反复踩到的问题。调用方需要知道这一点：编码过的命令不能
   * 再被拼接。
   */
  encoded: boolean;
}

/**
 * 平台适配器。
 *
 * 分成四组：**路径**、**shell**、**进程**、**环境**。分组不是为了整齐，而是因为
 * 移植时这四组的难度差着量级：路径与 shell 是纯映射，进程管控牵扯 Job Object 与
 * cgroups 这类平台独有机制，环境（凭据加密）在每个平台是完全不同的一套 API。
 */
export interface PlatformAdapter {
  readonly id: PlatformId;
  /** 给人看的名字。 */
  readonly label: string;
  /** 这个平台上做不到的事。空数组表示功能完整。 */
  readonly gaps: readonly PlatformGap[];

  /* ---------------- 路径 ---------------- */

  /**
   * 应用数据目录的默认位置（未被 `L_SCIENCE_DATA_DIR` 覆盖时）。
   *
   * 各平台的约定不同：Windows 是 `%LOCALAPPDATA%`，Linux 是 `$XDG_DATA_HOME` 或
   * `~/.local/share`，macOS 是 `~/Library/Application Support`。把它们混成一个
   * `~/.l-science` 能跑，但在 macOS 上那个目录不会被 Time Machine 按应用数据处理，
   * 而用户以为它被备份了。
   */
  defaultDataDir(appName: string): string;

  /**
   * 路径比较是否区分大小写。
   *
   * 这一条错了的后果很具体：不区分大小写的平台上，`D:/Data` 与 `d:/data` 是同一个
   * 目录，而按区分大小写比较会让路径授权检查放过一个已经被拒绝的路径。
   */
  readonly pathsCaseSensitive: boolean;

  /** 归一化路径用于**比较**（不用于访问）。 */
  normalizeForCompare(path: string): string;

  /**
   * conda / venv 里可执行文件所在的子目录，按优先顺序。
   *
   * Windows 是 `['', 'Scripts']`（conda 环境的 python 直接在根上），POSIX 是 `['bin']`。
   */
  readonly binDirs: readonly string[];

  /** 可执行文件的扩展名，按优先顺序。POSIX 为 `['']`。 */
  readonly executableExtensions: readonly string[];

  /* ---------------- shell ---------------- */

  /** 这个平台上默认用哪种 shell。 */
  readonly defaultShell: ShellFamily;

  /** 支持哪些 shell。Windows 上 posix 需要 WSL2，因此由调用方按能力探测再确认。 */
  supportsShell(family: ShellFamily): boolean;

  /**
   * 构造一次 shell 调用。
   *
   * 返回 null 表示这个平台起不了这种 shell——调用方必须处理，而不是拼一条注定失败的
   * 命令。
   */
  shellInvocation(input: { family: ShellFamily; command: string }): ShellInvocation | null;

  /** 查一个可执行文件在不在 PATH 里的命令（Windows `where`，POSIX `which`）。 */
  whichCommand(name: string): { command: string; args: readonly string[] };

  /* ---------------- 进程 ---------------- */

  /**
   * spawn 时是否要建独立进程组。
   *
   * POSIX 上建组才能整组终止；Windows 上由 Job Object 兜住，建组反而会让
   * `taskkill /T` 找不到父子关系。
   */
  readonly detachChildren: boolean;

  killTree(pid: number): KillTreeSpec;

  /**
   * 读进程内存占用的命令。返回 null 表示这个平台没有轻量的做法。
   *
   * `parse` 与命令绑在一起返回，因为两者必须匹配——分开放会让改了输出格式而忘了改
   * 解析，而那种错误的表现是内存限额静默失效。
   */
  memoryProbe(pid: number): {
    command: string;
    args: readonly string[];
    parse: (stdout: string) => number | null;
  } | null;

  /* ---------------- 环境 ---------------- */

  /** PATH 环境变量的名字。Windows 上大小写不敏感但取值时要用实际的键名。 */
  readonly pathEnvVar: string;

  /** PATH 的分隔符。 */
  readonly pathSeparator: string;

  /**
   * 用户主目录环境变量名，按优先顺序。
   *
   * MCP 的 stdio 传输按白名单放行环境变量（不继承 `process.env`），而白名单里
   * 「主目录」这一项在各平台名字不同。少放一个的表现是子进程找不到用户配置。
   */
  readonly homeEnvVars: readonly string[];
}
