/**
 * 远程命令的危险度判定（任务 14.2、14.5，需求 14.4、17.1）。
 *
 * ## 为什么需要这一层
 *
 * 需求 14.4 要求远程命令执行有审批门控。但**每条命令都弹卡片是行不通的**：一次
 * 排查会跑十几条 `ls` / `squeue` / `cat`，弹十几张卡片的结果是用户点到麻木，
 * 于是他给出一个 `always` 级授权——而那个授权同时也放行了 `rm -rf`。
 *
 * 因此分档：只读命令在有持久授权时直接放行；**破坏性命令即使有持久授权也单独问**。
 * 这样「不被 ls 烦到」与「rm -rf 要经过我」可以同时成立。
 *
 * ## 判定是保守的
 *
 * 判不出来的一律算 `write`（要问），而不是算 `read`。理由是两个方向的错误代价不对
 * 称：把只读命令判成要问，代价是多一次点击；把破坏性命令判成只读，代价是数据没了。
 *
 * 这里刻意**不做**「解析 shell 语法」这件事。一条命令可以用 `$(...)`、`eval`、变量
 * 展开把任意内容藏起来，任何基于文本的判定都能被绕过。所以这一层的定位要说清：
 * 它是**给诚实调用者的分档**，不是安全边界。真正的边界是「这个目标上的授权是谁给的」
 * ——而那是审批与授权层的事。
 */

/** 危险度。`destructive` 即使有持久授权也要单独问。 */
export type CommandRisk = 'read' | 'write' | 'destructive';

export const RISK_LABEL: Readonly<Record<CommandRisk, string>> = {
  read: '只读',
  write: '有写入',
  destructive: '破坏性',
};

export interface RiskVerdict {
  risk: CommandRisk;
  /** 命中的规则，进审批卡片与审计。 */
  reason: string;
  /** 判定依据的那一小段命令文本，便于用户核对。 */
  matched: string | null;
}

/**
 * 明确破坏性的模式。
 *
 * 每一条都能说出「为什么它属于这一档」：
 */
const DESTRUCTIVE: readonly { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-\w*\s+)*-\w*[rf]/iu, why: 'rm 带 -r 或 -f：递归或强制删除，没有回收站' },
  {
    re: /\brm\s+-{1,2}(recursive|force)/iu,
    why: 'rm 的长选项形式（--recursive / --force）：递归或强制删除，没有回收站',
  },
  { re: /\bshred\b/iu, why: 'shred 覆写文件内容，不可恢复' },
  { re: /\bmkfs(\.\w+)?\b/iu, why: 'mkfs 格式化文件系统' },
  { re: /\bdd\b[^|;]*\bof=/iu, why: 'dd 带 of=：直接写块设备或覆盖文件' },
  { re: />\s*\/dev\/(sd|nvme|hd)/iu, why: '重定向到块设备' },
  { re: /\bchmod\s+(-\w+\s+)*-R\b/iu, why: 'chmod -R：递归改权限，改错整棵目录树都要重来' },
  { re: /\bchown\s+(-\w+\s+)*-R\b/iu, why: 'chown -R：递归改所有者' },
  { re: /\bscancel\b(?![^|;]*--me\b)/iu, why: 'scancel：取消作业。不带 --me 时可能命中别人的作业' },
  { re: /\bqdel\b/iu, why: 'qdel：取消作业' },
  { re: /\bkill(all)?\s+-9\b/iu, why: 'kill -9：强杀，进程没有机会保存状态' },
  { re: /\bpkill\b/iu, why: 'pkill 按名字匹配，容易命中同名的其它进程' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/iu, why: '关机或重启' },
  { re: /\bsudo\b/iu, why: 'sudo：以特权执行。影响范围超出这个账户' },
  { re: /\bsu\s+-/iu, why: '切换到其它账户' },
  { re: /\btruncate\s+(-\w+\s+)*-s\s*0/iu, why: 'truncate -s 0：清空文件' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/su, why: 'fork bomb 的经典写法' },
  {
    re: /\bgit\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-\w*[fd])/iu,
    why: 'git 的破坏性操作',
  },
  { re: /\b(userdel|groupdel|passwd)\b/iu, why: '改动账户' },
  { re: /\bcrontab\s+-r\b/iu, why: 'crontab -r：删除全部定时任务' },
  { re: /\brmdir\s+(-\w+\s+)*-p\b/iu, why: 'rmdir -p：往上递归删空目录' },
  { re: /\bfind\b[^|;]*-delete\b/iu, why: 'find -delete：按条件批量删除' },
  { re: /\bfind\b[^|;]*-exec\s+rm\b/iu, why: 'find -exec rm：同上' },
];

/**
 * 明确只读的命令。
 *
 * 白名单而不是黑名单：只读的命令是可枚举的一小组，而「不属于破坏性」的命令是无穷
 * 多的。用黑名单的话，一个没被列进去的写命令会被判成只读。
 *
 * 表里的每一条都必须是「单独执行不改变远端任何状态」的。`tail -f` 不在表里——它会
 * 一直挂住，而挂住的命令会占满超时预算；那是另一个问题，但同样不该被当成安全的
 * 顺手放行。
 */
const READ_ONLY_COMMANDS: readonly string[] = [
  // 文件系统查看
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'md5sum',
  'sha256sum',
  'cksum',
  // 文本处理（只读输入，输出到 stdout）
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
  'nl',
  'diff',
  'comm',
  'join',
  'column',
  'jq',
  'zcat',
  // 系统与环境
  'echo',
  'printf',
  'date',
  'uname',
  'hostname',
  'whoami',
  'id',
  'groups',
  'uptime',
  'free',
  'nproc',
  'lscpu',
  'lsblk',
  'lsb_release',
  'env',
  'printenv',
  'which',
  'command',
  'type',
  'locale',
  'ulimit',
  'getconf',
  // 进程（只查看）
  'ps',
  'top',
  'pgrep',
  'jobs',
  // GPU
  'nvidia-smi',
  'rocm-smi',
  // 调度器查询
  'squeue',
  'sinfo',
  'sacct',
  'scontrol',
  'sshare',
  'sprio',
  'sstat',
  'qstat',
  'pbsnodes',
  'qhost',
  // 环境管理查询
  'module',
  'conda',
  'micromamba',
  'mamba',
  'pip',
  'python',
  'python3',
  'R',
  'Rscript',
  // 版本控制。只有 SUBCOMMAND_READ_ONLY 里列出的子命令算只读
  'git',
];

/**
 * 只读表里那些「取决于子命令」的项。
 *
 * `conda list` 只读，`conda remove` 不是。`pip list` 只读，`pip install` 不是。
 * 不区分子命令的话整个白名单会漏掉一大片写操作。
 */
const SUBCOMMAND_READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  conda: ['list', 'info', 'env', 'search', 'config'],
  mamba: ['list', 'info', 'search'],
  micromamba: ['list', 'info', 'search'],
  pip: ['list', 'show', 'freeze', 'check', 'index'],
  module: ['list', 'avail', 'show', 'spider', 'help', 'whatis'],
  scontrol: ['show', 'ping'],
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'describe', 'rev-parse'],
  // python/Rscript 跑的是任意代码，只有 -V / --version 能算只读
  python: ['-V', '--version'],
  python3: ['-V', '--version'],
  Rscript: ['--version'],
  R: ['--version'],
};

/** `conda env` 之类的第二层子命令里，只读的那些。 */
const NESTED_READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  'conda env': ['list', 'export'],
};

/**
 * 会把后续内容藏起来的构造。
 *
 * 命中这些时**不做只读判定**，直接算 `write`：`eval "$CMD"` 里真正执行的是什么，
 * 从文本上看不出来。判成只读等于让任意命令绕过这一档。
 */
const OPAQUE: readonly { re: RegExp; why: string }[] = [
  { re: /\beval\b/iu, why: 'eval 执行的内容从文本上看不出来' },
  { re: /\$\(/u, why: '命令替换 $(...) 的内容会先被执行' },
  { re: /`[^`]*`/u, why: '反引号命令替换' },
  { re: /\bbase64\s+(-d|--decode)/iu, why: 'base64 解码后执行的内容不可见' },
  { re: /\|\s*(sh|bash|zsh|python\d?)\b/iu, why: '管道喂给解释器：执行的是上游产生的内容' },
  { re: /\bcurl\b[^|;]*\|/iu, why: 'curl 下载后直接管道执行' },
  { re: /\bwget\b[^|;]*-O\s*-/iu, why: 'wget 输出到 stdout 后管道执行' },
  { re: /\bxargs\b/iu, why: 'xargs 的实际参数来自上游输出' },
];

/** 写重定向。它把只读命令变成写操作。 */
const WRITE_REDIRECT = /(^|[^0-9>])>{1,2}(?!&)\s*\S/u;

/**
 * 按 `;` `&&` `||` `|` 拆成段。
 *
 * 逐段判定后取**最危险的那一档**：`ls && rm -rf /data` 整体必须是 destructive。
 * 只看第一段是这类判定最常见的漏洞。
 */
function segments(command: string): readonly string[] {
  return command
    .split(/;|&&|\|\||\||\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 取一段命令的可执行名，跳过前置的环境变量赋值与 `env`。 */
function commandNameOf(segment: string): { name: string; rest: readonly string[] } {
  const tokens = segment.split(/\s+/u).filter((t) => t !== '');
  let i = 0;
  // 跳过 FOO=bar 形式的前置赋值
  while (i < tokens.length && /^[A-Za-z_]\w*=/u.test(tokens[i] ?? '')) i += 1;
  if ((tokens[i] ?? '') === 'env') {
    i += 1;
    while (i < tokens.length && /^[A-Za-z_]\w*=/u.test(tokens[i] ?? '')) i += 1;
  }
  if ((tokens[i] ?? '') === 'time' || (tokens[i] ?? '') === 'nohup') i += 1;

  const raw = tokens[i] ?? '';
  // 去掉路径前缀：/usr/bin/rm 与 rm 是同一件事
  const name = raw.split(/[/\\]/u).pop() ?? raw;
  return { name, rest: tokens.slice(i + 1) };
}

function isReadOnlySegment(segment: string): boolean {
  if (WRITE_REDIRECT.test(segment)) return false;

  const { name, rest } = commandNameOf(segment);
  if (name === '') return false;
  if (!READ_ONLY_COMMANDS.includes(name)) return false;

  const nested = NESTED_READ_ONLY[`${name} ${rest[0] ?? ''}`];
  if (nested !== undefined) {
    return nested.includes(rest[1] ?? '');
  }

  const allowed = SUBCOMMAND_READ_ONLY[name];
  if (allowed === undefined) return true;

  // 需要子命令但一个也没给：`pip` 单独跑只打印帮助，算只读
  const sub = rest.find((t) => !t.startsWith('-')) ?? rest[0];
  if (sub === undefined) return true;
  return allowed.includes(sub);
}

/**
 * 判定一条远程命令的危险度。
 *
 * 顺序是「破坏性 → 不透明 → 只读 → 其余算写」。破坏性排最前面，因为
 * `ls && rm -rf` 里的 `ls` 会让只读判定先命中。
 */
export function classifyCommand(command: string): RiskVerdict {
  const text = command.trim();
  if (text === '') {
    return { risk: 'write', reason: '命令为空', matched: null };
  }

  for (const rule of DESTRUCTIVE) {
    const hit = rule.re.exec(text);
    if (hit !== null) {
      return { risk: 'destructive', reason: rule.why, matched: hit[0].slice(0, 120) };
    }
  }

  for (const rule of OPAQUE) {
    const hit = rule.re.exec(text);
    if (hit !== null) {
      return {
        risk: 'write',
        reason: `${rule.why}——判不出来的一律按需要审批处理`,
        matched: hit[0].slice(0, 120),
      };
    }
  }

  const parts = segments(text);
  if (parts.length > 0 && parts.every((s) => isReadOnlySegment(s))) {
    const { name } = commandNameOf(parts[0] ?? '');
    return { risk: 'read', reason: `只读命令（${name}）`, matched: null };
  }

  const firstNonRead = parts.find((s) => !isReadOnlySegment(s));
  const { name } = commandNameOf(firstNonRead ?? text);
  return {
    risk: 'write',
    reason:
      name === ''
        ? '无法识别的命令形式，按需要审批处理'
        : `${name} 不在只读白名单里。白名单是穷举的——不在表里不代表危险，只代表要问一次。`,
    matched: firstNonRead === undefined ? null : firstNonRead.slice(0, 120),
  };
}

/** 危险度排序，用于「取最危险的那一档」。 */
export function riskRank(risk: CommandRisk): number {
  return risk === 'destructive' ? 2 : risk === 'write' ? 1 : 0;
}
