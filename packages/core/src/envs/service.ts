/**
 * 环境与包管理服务（任务 14.4，需求 15.1-15.7）。
 *
 * 把探测、冲突检查、命令构造、后台执行与内核重启串起来。
 *
 * 三条贯穿的判断：
 *
 * 1. **托管与登记的区别决定能不能删目录**（需求 15.1、15.2）。平台建的环境可以删，
 *    用户登记的只能取消登记——那里面可能有他花了一天装好的 GDAL。
 * 2. **耗时操作走后台任务**（需求 15.6）。创建一个带 scipy 的环境要几分钟，而同步等
 *    会让整个会话卡住；更糟的是它会被会话中断连带取消，于是用户随口打断一句就把
 *    装了三分钟的环境毁了一半。
 * 3. **重启告知必须在动手之前给出**（需求 15.5）。装完再说「顺便把你的变量清了」是
 *    没有意义的通知。
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { MANAGED_PYTHON_ENV, MANAGED_R_ENV, resolveCondaExe } from '@l-science/kernel';
import type { ToolOutput } from '@l-science/shared';

import type { BackgroundRunner } from '../tools/background.js';
import type { EnvRecord, EnvsRepo } from '../repo/envs.js';
import { runLocalShell } from '../compute/probe.js';

import {
  checkConflicts,
  existingMixups,
  isNativeSensitive,
  renderConflicts,
  renderMixups,
  specName,
} from './conflicts.js';
import {
  condaAvailable,
  detectEnvKind,
  detectInstallers,
  listCondaEnvironments,
  listPackages,
  pickInstaller,
  probeEnv,
  pythonInterpreterIn,
  prefixOfInterpreter,
  remediationForInstaller,
  rscriptIn,
} from './detect.js';
import {
  createCondaEnvCommand,
  installCommand,
  needsRestart,
  removeCondaEnvCommand,
  restartNotice,
  validateSpecs,
  type CommandSpec,
} from './installers.js';
import {
  ENV_STATUS_LABEL,
  INSTALLER_FAMILY,
  type EnvLanguage,
  type InstallPlan,
  type InstallerFamily,
  type InstallerInfo,
  type PackageRecord,
  type PackageRequest,
  type PackageSource,
} from './types.js';

/** 创建环境的超时。带 scipy 的环境在慢网络上要几分钟。 */
const CREATE_TIMEOUT_MS = 30 * 60 * 1000;
/** 装包的超时。torch 的 wheel 有 2 GB。 */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export interface EnvServiceDeps {
  repo: EnvsRepo;
  /** 后台执行器（需求 15.6）。缺省时耗时操作同步跑。 */
  background?: () => BackgroundRunner;
  /**
   * 这个环境当前有没有活着的内核，以及影响到哪些会话（需求 15.5）。
   *
   * 由 backend 从内核池取。不给时按「没有」处理——那会让重启告知偏乐观，因此调用方
   * 应当接上它。
   */
  liveKernels?: (env: EnvRecord) => readonly string[];
  /** 重启受影响的内核。用户确认后调用。 */
  restartKernels?: (env: EnvRecord) => Promise<number>;
  onChanged?: (info: { action: string; envId: string | null }) => void;
  onLog?: (line: string) => void;
}

export interface CreateResult {
  ok: boolean;
  env: EnvRecord | null;
  /** 后台任务 id（需求 15.6）。 */
  taskId: string | null;
  reason: string | null;
}

export interface InstallResult {
  ok: boolean;
  plan: InstallPlan;
  taskId: string | null;
  reason: string | null;
}

export class EnvService {
  readonly #deps: EnvServiceDeps;
  readonly #log: (line: string) => void;

  constructor(deps: EnvServiceDeps) {
    this.#deps = deps;
    this.#log = deps.onLog ?? ((): void => undefined);
  }

  get repo(): EnvsRepo {
    return this.#deps.repo;
  }

  /* ---------------- 发现与同步 ---------------- */

  /**
   * 把本机的 conda 环境同步进登记表（需求 15.1）。
   *
   * 只**加**不删：一条记录对应的目录暂时探测不到（网络盘没挂上、conda 正在被别的进程
   * 用）不该让它从列表里消失，那会让用户以为环境丢了。目录真的不在了由探测标成
   * `missing`，那是可见的状态而不是静默移除。
   */
  async sync(): Promise<{ added: number; existing: number; skipped: readonly string[] }> {
    const found = await listCondaEnvironments();
    const skipped: string[] = [];
    let added = 0;
    let existing = 0;

    for (const info of found) {
      if (this.#deps.repo.getByPath(info.prefix) !== null) {
        existing += 1;
        continue;
      }
      if (info.language === null) {
        // 既没有 python 也没有 Rscript：可能是 conda 的 base 之外的空壳环境
        skipped.push(`${info.name}（既找不到 python 也找不到 Rscript）`);
        continue;
      }

      try {
        const interpreter =
          info.language === 'python' ? pythonInterpreterIn(info.prefix) : rscriptIn(info.prefix);
        const record = this.#deps.repo.add({
          name: info.name,
          kind: 'conda',
          /*
           * 只有平台自己建的那两个算 managed。
           *
           * 用户自己的 conda 环境也是 conda 环境，但平台没有资格删它们——判据是名字
           * 而不是类型。判错的方向很具体：把用户的 research-env 标成 managed，然后
           * 他点了「删除环境」，以为删的是一条登记记录。
           */
          mode: info.managed ? 'managed' : 'registered',
          language: info.language,
          path: info.prefix,
          interpreter,
          status: 'creating',
        });
        await this.probe(record.id);
        added += 1;
      } catch (err) {
        skipped.push(`${info.name}（${err instanceof Error ? err.message : String(err)}）`);
      }
    }

    if (added > 0) this.#deps.onChanged?.({ action: 'sync', envId: null });
    return { added, existing, skipped };
  }

  /** 探测一个环境并把结果落库。 */
  async probe(envId: string): Promise<EnvRecord | null> {
    const env = this.#deps.repo.get(envId);
    if (env === null) return null;

    const probe = await probeEnv({
      prefix: env.path,
      kind: env.kind,
      language: env.language,
      interpreter: env.interpreter,
    });
    this.#deps.repo.recordProbe(envId, probe);

    /*
     * 顺便刷新包清单。
     *
     * 权威来源是探测而不是我们的安装记录：用户可以在环境里自己跑 pip，那时记录会漏，
     * 而混装检查（需求 15.4）依赖清单的准确性。
     */
    if (probe.status === 'ready' || probe.status === 'incomplete') {
      const packages = await listPackages({
        kind: env.kind,
        language: env.language,
        prefix: env.path,
        interpreter: env.interpreter,
      });
      this.#deps.repo.replacePackages(envId, packages.packages);
    }

    this.#deps.onChanged?.({ action: 'probe', envId });
    return this.#deps.repo.get(envId);
  }

  list(options: { language?: EnvLanguage } = {}): readonly EnvRecord[] {
    return this.#deps.repo.list(options);
  }

  /** 可用的安装器与它们的优先级（需求 15.3）。 */
  async installers(): Promise<{
    all: readonly InstallerInfo[];
    chosen: Readonly<Record<InstallerFamily, { id: string | null; reason: string }>>;
  }> {
    const all = await detectInstallers();
    const families: InstallerFamily[] = ['pypi', 'conda', 'cran'];
    const chosen: Record<string, { id: string | null; reason: string }> = {};
    for (const family of families) {
      const pick = pickInstaller(all, family);
      chosen[family] = { id: pick.installer?.id ?? null, reason: pick.reason };
    }
    return { all, chosen: chosen as never };
  }

  /* ---------------- 创建与删除（需求 15.1）---------------- */

  /**
   * 创建一个托管 conda 环境。
   *
   * 走后台任务（需求 15.6）：带 scipy 的环境要几分钟，同步等会让会话卡住，而且会被
   * 会话中断连带取消——用户随口打断一句就把装了三分钟的环境毁了一半。
   */
  async create(input: {
    name: string;
    language: EnvLanguage;
    pythonVersion?: string | null;
    rVersion?: string | null;
    packages?: readonly string[];
    channel?: string;
    conversationId: string;
    notes?: string | null;
  }): Promise<CreateResult> {
    if (!condaAvailable()) {
      return {
        ok: false,
        env: null,
        taskId: null,
        reason: remediationForInstaller('conda'),
      };
    }
    const condaExe = resolveCondaExe();
    if (condaExe === null) {
      return { ok: false, env: null, taskId: null, reason: remediationForInstaller('conda') };
    }

    const name = input.name.trim();
    if (!/^[\w.-]{1,64}$/u.test(name)) {
      return {
        ok: false,
        env: null,
        taskId: null,
        reason:
          `环境名不合法：${name}。只接受字母、数字、下划线、点与连字符，最多 64 个字符。\n` +
          '环境名会进命令行与文件路径，带空格或引号的名字会在某一层传参时被截断。',
      };
    }
    if (name === MANAGED_PYTHON_ENV || name === MANAGED_R_ENV) {
      return {
        ok: false,
        env: null,
        taskId: null,
        reason:
          `${name} 是平台的托管环境名，不能用它新建。` +
          '这两个环境由平台维护，重建会让当前所有会话的内核失效。',
      };
    }
    if (this.#deps.repo.getByName(name) !== null) {
      return { ok: false, env: null, taskId: null, reason: `已有同名环境：${name}` };
    }

    const packages = input.packages ?? [];
    if (packages.length > 0) {
      const check = validateSpecs(packages);
      if (!check.ok) return { ok: false, env: null, taskId: null, reason: check.reason };
    }

    const installers = await detectInstallers();
    const pick = pickInstaller(installers, 'conda');
    if (pick.installer === null || pick.installer.command === null) {
      return { ok: false, env: null, taskId: null, reason: pick.reason };
    }

    const command = createCondaEnvCommand({
      condaExe,
      installer: pick.installer.id,
      installerCommand: pick.installer.command,
      name,
      language: input.language,
      ...(input.pythonVersion === undefined ? {} : { pythonVersion: input.pythonVersion }),
      ...(input.rVersion === undefined ? {} : { rVersion: input.rVersion }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      packages,
    });

    /*
     * 先落一条 `creating` 记录再开跑。
     *
     * 反过来的话，创建过程中用户看不到任何东西——他会以为点击没生效然后再点一次，
     * 而第二次会撞上「已有同名环境」或者更糟，两个 conda 进程同时写一个目录。
     */
    const prefix = this.#guessPrefix(name);
    let record: EnvRecord;
    try {
      record = this.#deps.repo.add({
        name,
        kind: 'conda',
        mode: 'managed',
        language: input.language,
        path: prefix,
        status: 'creating',
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
    } catch (err) {
      return {
        ok: false,
        env: null,
        taskId: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    this.#deps.onChanged?.({ action: 'create', envId: record.id });

    const runCreate = async (): Promise<ToolOutput> => {
      const result = await runLocalShell({
        command: command.display,
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
        timeoutMs: CREATE_TIMEOUT_MS,
      });

      if (!result.ok) {
        this.#deps.repo.update(record.id, { status: 'failed' });
        this.#deps.onChanged?.({ action: 'create-failed', envId: record.id });
        return {
          kind: 'error',
          ename: 'EnvCreateFailed',
          evalue:
            `创建环境 ${name} 失败（退出码 ${String(result.exitCode)}）。\n` +
            `命令：${command.display}\n` +
            `${(result.stderr || result.stdout).slice(-4000)}`,
          traceback: [],
        };
      }

      // 创建成功后探测一次并刷新包清单：用户接下来要问的是「装上了吗」
      const probed = await this.probe(record.id);
      const status = probed?.status ?? 'failed';
      return {
        kind: 'text',
        text:
          `环境 ${name} 已创建（${ENV_STATUS_LABEL[status]}）。\n` +
          `${probed?.lastProbe?.summary ?? ''}\n` +
          `路径：${probed?.path ?? prefix}\n` +
          (input.language === 'r'
            ? 'R 环境与 Python 环境完全分开（需求 15.7）：在这里装 R 包不会影响 Python 内核。'
            : '要让新内核默认用它，把它设为默认环境。'),
      };
    };

    const background = this.#deps.background;
    if (background === undefined) {
      // 没有后台执行器时同步跑。测试与控制面脚本走这条路
      const output = await runCreate();
      return {
        ok: output.kind !== 'error',
        env: this.#deps.repo.get(record.id),
        taskId: null,
        reason: output.kind === 'error' ? output.evalue : null,
      };
    }

    const taskId = background().submit({
      conversationId: input.conversationId,
      label: `创建环境 ${name}`,
      run: async () => runCreate(),
    });

    return { ok: true, env: this.#deps.repo.get(record.id), taskId, reason: null };
  }

  /**
   * conda 会把新环境建在哪。
   *
   * 用 `CONDA_PREFIX`/`envs` 推。推错不影响创建（conda 自己知道往哪建），只影响我们
   * 先落的那条记录里的 path——因此创建成功后要重新 sync 一次拿到真实路径。
   */
  #guessPrefix(name: string): string {
    const exe = resolveCondaExe();
    if (exe === null) return name;
    // <base>/Scripts/conda.exe 或 <base>/bin/conda → <base>/envs/<name>
    const base = prefixOfInterpreter(exe);
    return `${base.replace(/[\\/]+$/u, '')}${process.platform === 'win32' ? '\\envs\\' : '/envs/'}${name}`;
  }

  /**
   * 删除或取消登记。
   *
   * 两件事**必须分开**（需求 15.1、15.2）：
   *
   * - `managed`：删目录 + 删记录。是平台建的，删掉它符合用户的预期。
   * - `registered`：只删记录。那是用户自己的环境，里面可能有他花了一天装好的 GDAL，
   *   而「取消登记」这个动作在他的理解里绝不包含删掉那个目录。
   */
  async remove(
    envId: string,
    options: { deleteFiles?: boolean } = {},
  ): Promise<{ ok: boolean; deletedFiles: boolean; reason: string | null }> {
    const env = this.#deps.repo.get(envId);
    if (env === null) return { ok: false, deletedFiles: false, reason: '环境不存在' };

    if (env.name === MANAGED_PYTHON_ENV || env.name === MANAGED_R_ENV) {
      return {
        ok: false,
        deletedFiles: false,
        reason:
          `${env.name} 是平台的托管环境，删掉它会让所有会话的内核起不来。\n` +
          '要重建它请在终端里手动操作，那样你能看到完整过程。',
      };
    }

    const live = this.#deps.liveKernels?.(env) ?? [];
    if (live.length > 0) {
      return {
        ok: false,
        deletedFiles: false,
        reason:
          `这个环境上还有 ${String(live.length)} 个活着的内核。删掉它会让那些内核在下一次` +
          '执行时以看不懂的方式失败（解释器还在内存里，但它的 site-packages 没了）。\n' +
          '先关掉那些会话的内核。',
      };
    }

    if (env.mode === 'registered' && options.deleteFiles === true) {
      return {
        ok: false,
        deletedFiles: false,
        reason:
          `「${env.name}」是你自己的环境，平台只登记了它的位置。\n` +
          '平台不会删除它的目录——那里面可能有花很久才装好的依赖。' +
          '取消登记不带 deleteFiles 即可；真要删目录请自己动手，那样你能确认删的是什么。',
      };
    }

    let deletedFiles = false;
    if (env.mode === 'managed' && options.deleteFiles !== false && existsSync(env.path)) {
      const installers = await detectInstallers();
      const pick = pickInstaller(installers, 'conda');
      if (pick.installer !== null && pick.installer.command !== null) {
        const command = removeCondaEnvCommand({
          installerCommand: pick.installer.command,
          prefix: env.path,
        });
        const result = await runLocalShell({
          command: command.display,
          shell: process.platform === 'win32' ? 'powershell' : 'bash',
          timeoutMs: 10 * 60 * 1000,
        });
        deletedFiles = result.ok;
        if (!result.ok) {
          /*
           * conda remove 失败时**不**回退到 rm -rf。
           *
           * 直接删目录会留下 conda 自己的登记（envs.txt），于是 `conda env list` 会
           * 一直报一个不存在的环境。更要紧的是：如果 path 推错了，rm -rf 删掉的是
           * 别的东西。
           */
          this.#log(`conda remove 失败：${(result.stderr || result.stdout).slice(0, 500)}`);
          return {
            ok: false,
            deletedFiles: false,
            reason:
              `conda remove 失败，登记记录**没有**删除：\n${(result.stderr || result.stdout).slice(-2000)}\n` +
              '平台不会退回直接删目录：那会留下 conda 自己的登记，而且万一路径推错就删错了东西。',
          };
        }
      }
    }

    this.#deps.repo.delete(envId);
    this.#deps.onChanged?.({ action: 'remove', envId });
    return { ok: true, deletedFiles, reason: null };
  }

  /* ---------------- 登记用户的 venv（需求 15.2）---------------- */

  /**
   * 登记一个用户既有的环境。
   *
   * 需求 15.2 的「代码编辑可持久生效」靠**不复制任何东西**实现：内核直接用这个环境的
   * 解释器启动，因此 `pip install -e` 装出来的可编辑包、以及用户直接改的源码，
   * 都立刻生效。任何「把环境复制一份到平台目录下」的做法都会破坏这一点，而破坏的
   * 表现是「我改了代码但跑的还是旧的」。
   */
  async register(input: {
    name: string;
    /** 环境根目录，或直接给解释器路径。 */
    path: string;
    language?: EnvLanguage;
    notes?: string | null;
    setDefault?: boolean;
  }): Promise<{ ok: boolean; env: EnvRecord | null; reason: string | null }> {
    const raw = input.path.trim();
    if (raw === '') return { ok: false, env: null, reason: '要登记的路径不能为空' };
    if (!existsSync(raw)) {
      return {
        ok: false,
        env: null,
        reason:
          `路径不存在：${raw}\n` +
          '给环境根目录（含 pyvenv.cfg 或 conda-meta 的那一层）或者解释器本身都可以。',
      };
    }

    /*
     * 给的是解释器还是目录，两种都认。
     *
     * 用户从终端里 `where python` 拿到的是解释器路径，而向导里提示的是环境目录。
     * 只认一种会让另一种输入得到「路径不存在」这类完全误导的报错。
     */
    const looksLikeInterpreter = /(python(\d(\.\d+)?)?(\.exe)?|Rscript(\.exe)?)$/iu.test(raw);
    const prefix = looksLikeInterpreter ? prefixOfInterpreter(raw) : raw;

    const kind = detectEnvKind(prefix);
    if (kind === null) {
      return {
        ok: false,
        env: null,
        reason:
          `${prefix} 看起来不是一个 Python 环境：既没有 conda-meta/ 也没有 pyvenv.cfg。\n` +
          'venv 的根目录里应该有 pyvenv.cfg。如果你给的是 site-packages 或 Scripts 目录，' +
          '往上一层试试。',
      };
    }

    const language =
      input.language ??
      (rscriptIn(prefix) !== null && pythonInterpreterIn(prefix) === null ? 'r' : 'python');
    const interpreter = language === 'python' ? pythonInterpreterIn(prefix) : rscriptIn(prefix);
    if (interpreter === null) {
      return {
        ok: false,
        env: null,
        reason:
          `${prefix} 下找不到${language === 'python' ? ' Python 解释器' : ' Rscript'}。\n` +
          (language === 'python'
            ? 'conda 环境的解释器在根目录或 bin/ 下，venv 在 Scripts\\ 或 bin/ 下。'
            : 'conda 装的 R 在 lib/R/bin/x64 下。'),
      };
    }

    const probe = await probeEnv({ prefix, kind, language, interpreter });
    /*
     * 缺 ipykernel 时**照样登记**，但状态标成 incomplete。
     *
     * 拒绝登记会让用户陷在一个死循环里：他要先装 ipykernel 才能登记，而装它最方便的
     * 方式正是登记之后用平台的包管理。登记 + 明确的状态 + 可复制的补救命令是更好的
     * 组合。
     */
    const name = input.name.trim() === '' ? basename(prefix) : input.name.trim();

    let record: EnvRecord;
    try {
      record = this.#deps.repo.add({
        name,
        kind,
        mode: 'registered',
        language,
        path: prefix,
        interpreter,
        status: probe.status,
        ...(language === 'python' ? { pythonVersion: probe.version } : { rVersion: probe.version }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
    } catch (err) {
      return { ok: false, env: null, reason: err instanceof Error ? err.message : String(err) };
    }

    this.#deps.repo.recordProbe(record.id, probe);
    const packages = await listPackages({ kind, language, prefix, interpreter });
    this.#deps.repo.replacePackages(record.id, packages.packages);

    if (input.setDefault === true && probe.status === 'ready') {
      this.#deps.repo.setDefault(record.id);
    }

    this.#deps.onChanged?.({ action: 'register', envId: record.id });
    return { ok: true, env: this.#deps.repo.get(record.id), reason: null };
  }

  /**
   * 设为默认环境（新内核用它）。
   *
   * 切换默认**不会**动已有内核：那些内核跑在旧环境上，而强行重启它们等于在用户没要求
   * 的时候清掉他的变量。返回值里说清这一点，让调用方决定要不要提示重启。
   */
  setDefault(envId: string): {
    ok: boolean;
    reason: string | null;
    liveOnOthers: readonly string[];
  } {
    const env = this.#deps.repo.get(envId);
    if (env === null) return { ok: false, reason: '环境不存在', liveOnOthers: [] };
    if (env.status !== 'ready') {
      return {
        ok: false,
        reason:
          `「${env.name}」当前状态是「${ENV_STATUS_LABEL[env.status]}」，不能设为默认——` +
          '新内核会起不来。先解决探测报出的问题。\n' +
          (env.lastProbe?.checks ?? [])
            .filter((c) => !c.ok)
            .map((c) => `- ${c.name}：${c.detail}`)
            .join('\n'),
        liveOnOthers: [],
      };
    }

    const others = this.#deps.repo
      .list({ language: env.language })
      .filter((e) => e.id !== envId)
      .flatMap((e) => this.#deps.liveKernels?.(e) ?? []);

    this.#deps.repo.setDefault(envId);
    this.#deps.onChanged?.({ action: 'default', envId });
    return { ok: true, reason: null, liveOnOthers: others };
  }

  /* ---------------- 包管理（需求 15.3、15.4、15.5）---------------- */

  /**
   * 算一次安装计划。
   *
   * 在动手之前就把「用哪个安装器、为什么、会不会冲突、要不要重启」算出来，是为了让
   * 审批卡片与工具输出能说清代价。反过来（先跑起来再解释）在这里行不通：装一半再
   * 发现混装冲突时，环境已经坏了。
   */
  async plan(input: {
    envId: string;
    request: PackageRequest;
    uninstall?: boolean;
  }): Promise<InstallPlan> {
    const empty = (reason: string): InstallPlan => ({
      ok: false,
      envId: input.envId,
      installer: null,
      family: null,
      command: null,
      installerReason: '',
      conflicts: [],
      restartRequired: false,
      reason,
    });

    const env = this.#deps.repo.get(input.envId);
    if (env === null) return empty(`环境不存在：${input.envId}`);

    const specCheck = validateSpecs(input.request.specs);
    if (!specCheck.ok) return empty(specCheck.reason);

    if (env.status === 'missing') {
      return empty(
        `「${env.name}」的目录已经不在了：${env.path}\n` + '重新登记它的新位置，或者删掉这条记录。',
      );
    }

    /*
     * 家族选择。
     *
     * 顺序：显式指定 > 环境类型与包性质推断。
     *
     * 推断规则：R 环境只能 cran；venv 只能 pypi（那里没有 conda）；conda 环境里，
     * **对原生库敏感的包默认走 conda 家族**——那是需求 15.4 的正面表达：不只是挡住
     * 混装，还要让默认选择本身不产生混装。
     */
    let family: InstallerFamily;
    if (input.request.family !== undefined) {
      family = input.request.family;
      if (env.language === 'r' && family !== 'cran') {
        return empty(
          `「${env.name}」是 R 环境，只能用 CRAN 装包。\n` +
            '需求 15.7 要求 R 与 Python 分处独立环境：在 R 环境里装 Python 包不会生效，' +
            '而且会让两边的依赖开始互相牵扯。',
        );
      }
      if (env.language === 'python' && family === 'cran') {
        return empty(`「${env.name}」是 Python 环境，装不了 CRAN 包。`);
      }
      if (env.kind === 'venv' && family === 'conda') {
        return empty(
          `「${env.name}」是 venv，不是 conda 环境，用不了 conda 装包。\n` +
            '需要 conda 频道的包（GDAL、pytorch+cudatoolkit 这类）请新建一个 conda 环境。',
        );
      }
    } else if (env.language === 'r') {
      family = 'cran';
    } else if (env.kind === 'venv') {
      family = 'pypi';
    } else {
      const sensitive = input.request.specs.some((s) => isNativeSensitive(s));
      family = sensitive ? 'conda' : 'pypi';
    }

    const requestedSource: PackageSource =
      family === 'conda' ? 'conda' : family === 'pypi' ? 'pypi' : 'cran';

    /*
     * 混装检查（需求 15.4）**排在挑安装器之前**。
     *
     * 顺序反过来的话，一个既有混装冲突又缺安装器的请求只会报「没有可用的安装器」，
     * 而那条提示会把用户引向「装个 uv」——装完之后他撞上的才是真正的问题。冲突是更硬
     * 的阻断（它不会因为装了工具就消失），因此先算它。
     *
     * 只在 conda 环境上做：venv 里只有 pip 一个来源，混装在物理上不可能发生。
     * 卸载也不做——移除一个包不会造成新的混装。
     */
    const conflicts =
      env.kind === 'conda' && input.uninstall !== true
        ? checkConflicts({
            specs: input.request.specs,
            requestedSource,
            installed: this.#deps.repo.packages(env.id),
          })
        : [];

    const conflictReason =
      conflicts.length === 0
        ? null
        : `${renderConflicts(conflicts)}\n\n` +
          '这道检查来自需求 15.4。它挡住的不是「装不上」，' +
          '而是「装上了、能导入、但算出来的数是错的」——那种失败不会报错。';

    const installers = await detectInstallers();
    const pick = pickInstaller(installers, family);
    if (pick.installer === null || pick.installer.command === null) {
      return {
        ok: false,
        envId: env.id,
        installer: null,
        // 家族已经定了，即使挑不出安装器也要报出来：它决定了这次装会不会造成混装
        family,
        command: null,
        installerReason: pick.reason,
        conflicts,
        restartRequired: false,
        reason: conflictReason === null ? pick.reason : `${conflictReason}\n\n另外：${pick.reason}`,
      };
    }

    const command = installCommand({
      installer: pick.installer.id,
      installerCommand: pick.installer.command,
      envKind: env.kind,
      prefix: env.path,
      interpreter: env.interpreter,
      specs: input.request.specs,
      ...(input.request.channel === undefined ? {} : { channel: input.request.channel }),
      ...(input.uninstall === undefined ? {} : { uninstall: input.uninstall }),
    });
    if (command === null) {
      /*
       * 构造不出命令时**不能用 `empty()`**：那会把已经算出来的 family 与 conflicts 一起
       * 清掉，于是「这次装会造成混装」这个更重要的结论被一句「缺解释器路径」盖住。
       *
       * 两个问题一起报，冲突排前面——它是更硬的阻断（重新探测能拿到解释器路径，
       * 而混装不会因此消失）。
       */
      const missing =
        `构造不出安装命令：${pick.installer.id} 需要解释器路径，而「${env.name}」的记录里没有。` +
        '重新探测这个环境（action=probe）会把它补上。';
      return {
        ok: false,
        envId: env.id,
        installer: pick.installer,
        family,
        command: null,
        installerReason: pick.reason,
        conflicts,
        restartRequired: false,
        reason: conflictReason === null ? missing : `${conflictReason}\n\n另外：${missing}`,
      };
    }

    const live = this.#deps.liveKernels?.(env) ?? [];
    const restart = needsRestart({
      specs: input.request.specs,
      ...(input.uninstall === undefined ? {} : { uninstall: input.uninstall }),
      hasLiveKernel: live.length > 0,
    });

    return {
      ok: conflicts.length === 0,
      envId: env.id,
      installer: pick.installer,
      family,
      command: command.display,
      installerReason: pick.reason,
      conflicts,
      restartRequired: restart.required,
      reason: conflictReason,
    };
  }

  /**
   * 装或卸包。
   *
   * 走后台任务（需求 15.6）：torch 的 wheel 有 2 GB，同步等会让会话卡住。
   */
  async install(input: {
    envId: string;
    request: PackageRequest;
    uninstall?: boolean;
    conversationId: string;
    /** 明知有混装风险仍要继续。调用方必须已经把风险展示给用户。 */
    force?: boolean;
  }): Promise<InstallResult> {
    const plan = await this.plan({
      envId: input.envId,
      request: input.request,
      ...(input.uninstall === undefined ? {} : { uninstall: input.uninstall }),
    });

    if (plan.command === null || plan.installer === null) {
      return { ok: false, plan, taskId: null, reason: plan.reason };
    }
    if (!plan.ok && input.force !== true) {
      return { ok: false, plan, taskId: null, reason: plan.reason };
    }

    const env = this.#deps.repo.get(input.envId);
    if (env === null) {
      return { ok: false, plan, taskId: null, reason: '环境不存在' };
    }

    const verb = input.uninstall === true ? '卸载' : '安装';
    const names = input.request.specs.map((s) => specName(s));
    const installerId = plan.installer.id;

    const run = async (): Promise<ToolOutput> => {
      const result = await runLocalShell({
        command: plan.command as string,
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
        timeoutMs: INSTALL_TIMEOUT_MS,
      });

      // 无论成败都重新探测：失败可能只装了一半，而那时的清单才是真实状态
      await this.probe(input.envId).catch(() => undefined);
      if (result.ok) {
        this.#deps.repo.markInstalledBy(input.envId, names, `platform:${installerId}`);
      }

      if (!result.ok) {
        return {
          kind: 'error',
          ename: input.uninstall === true ? 'PackageUninstallFailed' : 'PackageInstallFailed',
          evalue:
            `${verb}失败（退出码 ${String(result.exitCode)}）。\n` +
            `命令：${plan.command as string}\n` +
            `${(result.stderr || result.stdout).slice(-4000)}`,
          traceback: [],
        };
      }

      const live = this.#deps.liveKernels?.(env) ?? [];
      const restart = needsRestart({
        specs: input.request.specs,
        ...(input.uninstall === undefined ? {} : { uninstall: input.uninstall }),
        hasLiveKernel: live.length > 0,
      });

      return {
        kind: 'text',
        text: [
          `${verb}完成：${names.join('、')}（${env.name}，用 ${installerId}）`,
          '',
          restartNotice({
            required: restart.required,
            why: restart.why,
            affectedConversations: live,
          }),
        ].join('\n'),
      };
    };

    const background = this.#deps.background;
    if (background === undefined) {
      const output = await run();
      return {
        ok: output.kind !== 'error',
        plan,
        taskId: null,
        reason: output.kind === 'error' ? output.evalue : null,
      };
    }

    const taskId = background().submit({
      conversationId: input.conversationId,
      label: `${verb} ${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}（${env.name}）`,
      run: async () => run(),
    });

    return { ok: true, plan, taskId, reason: null };
  }

  /**
   * 这个环境上有哪些会话的内核在跑（需求 15.5）。
   *
   * 对外暴露是因为界面上「这个环境有 2 个内核在跑」是删除与切换默认之前必须看到的
   * 信息，而它只有内核池知道。
   */
  liveKernels(envId: string): readonly string[] {
    const env = this.#deps.repo.get(envId);
    if (env === null) return [];
    return this.#deps.liveKernels?.(env) ?? [];
  }

  /** 重启某个环境上的内核（需求 15.5）。用户确认后调用。 */
  async restart(envId: string): Promise<{ ok: boolean; restarted: number; reason: string | null }> {
    const env = this.#deps.repo.get(envId);
    if (env === null) return { ok: false, restarted: 0, reason: '环境不存在' };
    const restart = this.#deps.restartKernels;
    if (restart === undefined) {
      return { ok: false, restarted: 0, reason: '本次运行没有接上内核池，无法重启' };
    }
    const restarted = await restart(env);
    return { ok: true, restarted, reason: null };
  }

  /* ---------------- 诊断 ---------------- */

  packages(
    envId: string,
    options: { source?: PackageSource; query?: string; limit?: number } = {},
  ): { packages: readonly PackageRecord[]; stats: ReturnType<EnvsRepo['packageStats']> } {
    return {
      packages: this.#deps.repo.packages(envId, options),
      stats: this.#deps.repo.packageStats(envId),
    };
  }

  /** 这个环境里已经存在的混装（需求 15.4 的排查面）。 */
  mixups(envId: string): { mixups: ReturnType<typeof existingMixups>; rendered: string } {
    const installed = this.#deps.repo.packages(envId);
    const mixups = existingMixups(installed);
    return { mixups, rendered: renderMixups(mixups) };
  }

  /**
   * 需求 15.7 的检查：R 与 Python 是否分处独立环境。
   *
   * 做成可查而不是只在文档里声明：这条约束的价值在于「R 侧依赖变更不影响 Python 内核」，
   * 而一旦有人在同一个环境里同时装了两边，那个保证就没了——而它不会以报错的形式出现。
   */
  separationCheck(): { ok: boolean; summary: string; violations: readonly string[] } {
    const violations: string[] = [];
    for (const env of this.#deps.repo.list()) {
      if (!existsSync(env.path)) continue;
      const hasPython = pythonInterpreterIn(env.path) !== null;
      const hasR = rscriptIn(env.path) !== null;
      if (hasPython && hasR) {
        violations.push(
          `${env.name}（${env.path}）里同时有 Python 与 R。` +
            'R 的依赖体量大且更新频繁，装在一起时它的一次升级可能把 Python 侧的领域包' +
            '版本拖着一起变，而那个影响不会有任何提示。',
        );
      }
    }
    return {
      ok: violations.length === 0,
      summary:
        violations.length === 0
          ? 'R 与 Python 分处独立环境（需求 15.7）。'
          : `发现 ${String(violations.length)} 个环境里 R 与 Python 混在一起。`,
      violations,
    };
  }

  /** 渲染环境清单，供工具输出。 */
  render(): string {
    const envs = this.#deps.repo.list();
    if (envs.length === 0) {
      return '还没有登记任何环境。用 action=sync 把本机的 conda 环境同步进来。';
    }

    const lines: string[] = [];
    for (const env of envs) {
      const stats = this.#deps.repo.packageStats(env.id);
      lines.push(
        `- ${env.name}　${env.language}　${env.kind}　${
          env.mode === 'managed' ? '平台托管' : '已登记（你自己的）'
        }${env.isDefault ? '　★默认' : ''}`,
      );
      lines.push(
        `  ${ENV_STATUS_LABEL[env.status]}` +
          (env.lastProbe === null ? '' : ` —— ${env.lastProbe.summary}`),
      );
      lines.push(`  路径：${env.path}`);
      if (stats.total > 0) {
        const bySource = Object.entries(stats.bySource)
          .map(([source, n]) => `${source} ${String(n)}`)
          .join('、');
        lines.push(`  包：${String(stats.total)} 个（${bySource}）`);
      }
      if (env.status !== 'ready') {
        for (const check of env.lastProbe?.checks ?? []) {
          if (!check.ok) lines.push(`  ✗ ${check.name}：${check.detail}`);
        }
      }
    }
    return lines.join('\n');
  }
}

export { INSTALLER_FAMILY };
export type { CommandSpec };
