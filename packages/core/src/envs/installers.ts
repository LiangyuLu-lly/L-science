/**
 * 安装命令构造（任务 14.4，需求 15.3、15.4、15.5）。
 *
 * 纯函数：给定环境与请求，产出要跑的命令行参数。执行在 `service.ts`。分开是为了让
 * 「装 numpy 会跑哪条命令」可以完整测试而不需要真的装一遍。
 *
 * 一条贯穿的约定：**所有命令都显式指定目标环境**（`--prefix` / `-p` / `--python`），
 * 不依赖「当前激活的环境」。依赖激活状态是这类工具最常见的事故来源：包装到了别的
 * 环境里，而两边看起来都成功了。
 */

import { specName } from './conflicts.js';
import type { EnvKind, EnvLanguage, InstallerId } from './types.js';

export interface CommandSpec {
  command: string;
  args: readonly string[];
  /** 给人看的完整命令行。审批卡片与工具输出用它。 */
  display: string;
}

function display(command: string, args: readonly string[]): string {
  const quote = (part: string): string => (/[\s"']/u.test(part) ? `"${part}"` : part);
  return [quote(command), ...args.map(quote)].join(' ');
}

/** 校验包名。 */
export function validateSpecs(
  specs: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (specs.length === 0) return { ok: false, reason: '没有给出要装的包' };
  if (specs.length > 100) return { ok: false, reason: '一次最多装 100 个包' };

  for (const spec of specs) {
    const trimmed = spec.trim();
    if (trimmed === '') return { ok: false, reason: '包名不能为空' };
    /*
     * 挡住 shell 元字符与选项注入。
     *
     * 我们用 execFile 传 argv，因此 shell 元字符本身不会被解释——但 `--index-url`
     * 这类**选项**会被安装器自己接受，而那等于让调用方指定从哪个源下载。一个指向
     * 攻击者服务器的 index-url 会让 `pip install numpy` 装进任意代码。
     */
    if (trimmed.startsWith('-')) {
      return {
        ok: false,
        reason:
          `包名不能以 - 开头：${trimmed}。\n` +
          '这样写会被安装器当成选项。要指定频道用 channel 参数，' +
          '平台不接受任意安装器选项——`--index-url` 之类的选项能让一次安装从任意服务器取包。',
      };
    }
    if (
      !/^[A-Za-z0-9][\w.\-+[\]]*([<>=!~]=?[\w.*+-]+)?(\s*,\s*[<>=!~]=?[\w.*+-]+)*$/u.test(trimmed)
    ) {
      return {
        ok: false,
        reason:
          `包名或版本约束的形式不认识：${trimmed}。\n` +
          '接受的形式：numpy、numpy==1.26.4、numpy>=1.26,<2、torch[cuda]。' +
          'URL、本地路径与 git 地址不接受——那些要走 python 工具里的显式安装，' +
          '因为它们能从任意位置取代码。',
      };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 创建环境
 * ------------------------------------------------------------------ */

/**
 * 创建 conda 环境的命令（需求 15.1）。
 *
 * 固定用 `-c conda-forge`：conda 官方的 defaults 频道对科研包的覆盖与更新都落后于
 * conda-forge，而混用两个频道是另一类版本冲突的来源（它们的编译工具链不同）。
 * 用户要用别的频道可以显式传。
 */
export function createCondaEnvCommand(input: {
  condaExe: string;
  installer: InstallerId;
  installerCommand: string;
  name: string;
  language: EnvLanguage;
  pythonVersion?: string | null;
  rVersion?: string | null;
  channel?: string;
  /** 建环境时一并装的包。 */
  packages?: readonly string[];
}): CommandSpec {
  const channel = input.channel ?? 'conda-forge';
  const args = ['create', '-n', input.name, '-c', channel, '-y'];

  if (input.language === 'python') {
    args.push(`python=${input.pythonVersion ?? '3.13'}`);
    /*
     * ipykernel 在创建时就装上。
     *
     * 不装的话新环境的探测结果是 `incomplete`，而用户刚点了「创建环境」看到的是
     * 「缺组件」——那看起来像创建失败了。
     */
    args.push('ipykernel');
  } else {
    args.push(
      `r-base${input.rVersion === undefined || input.rVersion === null ? '' : `=${input.rVersion}`}`,
    );
    // 需求 15.7：R 环境自带 IRkernel，与 Python 环境完全分开
    args.push('r-irkernel');
  }

  args.push(...(input.packages ?? []));

  // micromamba 的子命令与 conda 兼容，但它需要显式的 root prefix 时才用 -r；
  // 这里用 -n 形式，交给它自己的配置解析
  return {
    command: input.installerCommand,
    args,
    display: display(input.installerCommand, args),
  };
}

/**
 * 删除 conda 环境的命令。
 *
 * 用 `remove --all` 而不是直接 rm 目录：conda 会同时清掉 envs.txt 里的登记，
 * 直接删目录会留下一条指向不存在环境的记录，而那会让 `conda env list` 一直报它。
 */
export function removeCondaEnvCommand(input: {
  installerCommand: string;
  prefix: string;
}): CommandSpec {
  const args = ['remove', '--prefix', input.prefix, '--all', '-y'];
  return { command: input.installerCommand, args, display: display(input.installerCommand, args) };
}

/* ------------------------------------------------------------------ *
 * 装包
 * ------------------------------------------------------------------ */

export interface InstallCommandInput {
  installer: InstallerId;
  installerCommand: string;
  envKind: EnvKind;
  /** 环境根目录。 */
  prefix: string;
  /** 解释器绝对路径。PyPI 家族用它锁定目标环境。 */
  interpreter: string | null;
  specs: readonly string[];
  channel?: string;
  /** 卸载而不是安装。 */
  uninstall?: boolean;
}

/**
 * 构造装/卸命令。
 *
 * 每个安装器锁定目标环境的方式都不同，而这正是最容易出错的地方：
 *
 * - `pip`：`<interpreter> -m pip`。**不用 PATH 里的 pip.exe**——它属于哪个环境取决于
 *   PATH 顺序，而装错环境的表现是「装成功了但导入不到」。
 * - `uv`：`uv pip install --python <interpreter>`。uv 默认会去找当前目录的 .venv，
 *   不给 --python 会装到一个我们没预期的地方。
 * - conda 家族：`--prefix <prefix>`。用 `-n <name>` 的话，名字要能被 conda 解析成
 *   路径，而登记的用户环境可能不在 conda 的 envs 目录下。
 */
export function installCommand(input: InstallCommandInput): CommandSpec | null {
  const verb = input.uninstall === true ? 'uninstall' : 'install';

  switch (input.installer) {
    case 'pip': {
      const interpreter = input.interpreter;
      if (interpreter === null) return null;
      const args = ['-m', 'pip', verb, ...(input.uninstall === true ? ['-y'] : []), ...input.specs];
      return { command: interpreter, args, display: display(interpreter, args) };
    }

    case 'uv': {
      const interpreter = input.interpreter;
      if (interpreter === null) return null;
      const args = ['pip', verb, '--python', interpreter, ...input.specs];
      return {
        command: input.installerCommand,
        args,
        display: display(input.installerCommand, args),
      };
    }

    case 'conda':
    case 'mamba':
    case 'micromamba': {
      const args =
        input.uninstall === true
          ? ['remove', '--prefix', input.prefix, '-y', ...input.specs]
          : [
              'install',
              '--prefix',
              input.prefix,
              '-c',
              input.channel ?? 'conda-forge',
              '-y',
              ...input.specs,
            ];
      return {
        command: input.installerCommand,
        args,
        display: display(input.installerCommand, args),
      };
    }

    case 'R': {
      const rscript = input.interpreter;
      if (rscript === null) return null;
      /*
       * R 包用 Rscript -e 调 install.packages。
       *
       * 必须显式给 repos：不给的话 R 会尝试弹出一个图形化的镜像选择器，而我们没有
       * 图形界面也没有 TTY——那会让进程永久挂住。这与 ssh 的 BatchMode 是同一类问题。
       */
      const names = input.specs.map((s) => specName(s));
      const rExpr =
        input.uninstall === true
          ? `remove.packages(c(${names.map((n) => JSON.stringify(n)).join(', ')}))`
          : `install.packages(c(${names.map((n) => JSON.stringify(n)).join(', ')}), repos = "https://cloud.r-project.org", quiet = FALSE)`;
      const args = ['-e', rExpr];
      return { command: rscript, args, display: display(rscript, args) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 重启判定（需求 15.5）
 * ------------------------------------------------------------------ */

/**
 * 装完要不要重启内核。
 *
 * 判定刻意**偏保守**：拿不准就说要重启。
 *
 * 两个方向的错误代价不对称。说了要重启而其实不用，代价是用户白丢一次内存状态；
 * 说了不用而其实要，代价是他继续在一个加载了旧版本的进程里跑分析——而 Python 的
 * 模块缓存会让新装的版本完全不生效，同时不给任何提示。第二种情况下得到的结果是
 * 用旧代码算的，而用户以为用的是新版本。
 */
export function needsRestart(input: {
  specs: readonly string[];
  uninstall?: boolean;
  /** 这个环境当前有没有活着的内核。 */
  hasLiveKernel: boolean;
}): { required: boolean; why: string } {
  if (!input.hasLiveKernel) {
    return {
      required: false,
      why: '这个环境当前没有活着的内核，下次启动自然会用到新版本。',
    };
  }

  if (input.uninstall === true) {
    return {
      required: true,
      why:
        '卸载不会把已经导入的模块从内存里移除：内核里那份仍然可用，' +
        '于是「卸载成功了但还能 import」——而那份代码在下次重启后就消失。',
    };
  }

  return {
    required: true,
    why:
      'Python 的模块缓存（sys.modules）不会因为磁盘上的包换了版本而失效。' +
      '不重启的话内核里用的仍然是旧版本，而且不会有任何提示——' +
      '得到的结果是旧代码算的，而你以为用的是新版本。',
  };
}

/** 重启告知的完整措辞（需求 15.5）。 */
export function restartNotice(input: {
  required: boolean;
  why: string;
  affectedConversations?: readonly string[];
}): string {
  if (!input.required) return input.why;

  const lines = [
    '需要重启内核才能生效。',
    input.why,
    '',
    '重启会丢掉：内核内存里的变量、已导入的模块、打开的文件句柄、随机数状态。',
    '重启**不会**影响：工作区里的文件、已保存的制品、会话历史。',
  ];
  if (input.affectedConversations !== undefined && input.affectedConversations.length > 0) {
    lines.push('');
    lines.push(
      `受影响的会话：${input.affectedConversations.length} 个` +
        `（${input.affectedConversations.slice(0, 5).join('、')}${
          input.affectedConversations.length > 5 ? ' 等' : ''
        }）`,
    );
  }
  return lines.join('\n');
}
