/**
 * 环境与安装器探测（任务 14.4，需求 15.1、15.2、15.3）。
 *
 * 这一层只做「问出事实」，不改任何东西。写操作在 `service.ts`。
 *
 * 探测用 `execFile` 而不是走沙箱的 `runShell`：这些都是短命令（`--version`、
 * `list --json`），走沙箱要多一次 PowerShell 启动加一层 base64 编码，而在启动路径上
 * 那个开销是可感知的。真正需要管控的是**用户的代码**，不是我们自己发起的探测。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  listCondaEnvs,
  resolveCondaExe,
  MANAGED_PYTHON_ENV,
  MANAGED_R_ENV,
} from '@l-science/kernel';

import {
  INSTALLER_FAMILY,
  INSTALLER_PRIORITY,
  type EnvKind,
  type EnvProbe,
  type EnvStatus,
  type InstallerFamily,
  type InstallerId,
  type InstallerInfo,
  type PackageRecord,
  type PackageSource,
} from './types.js';

/** 探测超时。conda 的 `list --json` 在大环境上要几秒。 */
const PROBE_TIMEOUT_MS = 45_000;
const VERSION_TIMEOUT_MS = 10_000;

interface CaptureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function capture(
  command: string,
  args: readonly string[],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve) => {
    /*
     * `execFile` 会**同步抛**一部分错误，不是所有失败都走回调。
     *
     * 具体撞到的一个：目标文件存在但不是可执行映像（零字节的 python.exe，或者被
     * 杀软隔离后留下的占位文件）——libuv 报 `EFTYPE`，而 Node 把它作为同步异常扔出来。
     * 不接住的话，一个用户损坏的 venv 会让整个环境列表页崩掉，而崩掉的位置在
     * 「探测版本号」这种看起来无害的地方。
     */
    try {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: err === null, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: `启动 ${command} 失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 解释器路径
 * ------------------------------------------------------------------ */

/**
 * 环境目录下的 Python 解释器。
 *
 * 三种布局都要认：conda 环境（Windows 下直接在 prefix 根上）、venv（Windows 是
 * `Scripts\python.exe`，POSIX 是 `bin/python`）。
 *
 * 这段推断刻意集中在一处并落进库里（`environments.interpreter`）：散在多处的话，
 * 每个调用点都要自己猜一遍，而猜错的表现是内核起不来且不说为什么。
 */
export function pythonInterpreterIn(prefix: string): string | null {
  const candidates = [
    join(prefix, 'python.exe'),
    join(prefix, 'Scripts', 'python.exe'),
    join(prefix, 'bin', 'python3'),
    join(prefix, 'bin', 'python'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 环境目录下的 Rscript。 */
export function rscriptIn(prefix: string): string | null {
  const candidates = [
    join(prefix, 'lib', 'R', 'bin', 'x64', 'Rscript.exe'),
    join(prefix, 'lib', 'R', 'bin', 'Rscript.exe'),
    join(prefix, 'bin', 'Rscript.exe'),
    join(prefix, 'bin', 'Rscript'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 判断一个目录是 conda 环境还是 venv。
 *
 * conda 环境有 `conda-meta/history`；venv 有 `pyvenv.cfg`。两个标记都缺时不猜——
 * 猜错的后果是拿 conda 的命令去操作一个 venv，而那些命令会以看不懂的方式失败。
 */
export function detectEnvKind(prefix: string): EnvKind | null {
  if (existsSync(join(prefix, 'conda-meta'))) return 'conda';
  if (existsSync(join(prefix, 'pyvenv.cfg'))) return 'venv';
  return null;
}

/**
 * 读 venv 的 `pyvenv.cfg`。
 *
 * 里面的 `home` 指向创建它的那个 Python。这条信息有用：一个基于已经被删掉的 Python
 * 建出来的 venv 仍然「看起来存在」，但它的解释器是一个断掉的符号链接（POSIX）或者
 * 一个指向不存在目录的 launcher（Windows）。
 */
export function readVenvConfig(prefix: string): Readonly<Record<string, string>> | null {
  const path = join(prefix, 'pyvenv.cfg');
  if (!existsSync(path)) return null;
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 安装器
 * ------------------------------------------------------------------ */

let installerCache: readonly InstallerInfo[] | null = null;

/**
 * 探测可用的安装器（需求 15.3）。
 *
 * 结果缓存：用户不会在一次运行里装上 uv，而这个探测要启动最多五个进程。
 * `resetInstallerCache()` 供「装完之后手动刷新」与测试使用。
 */
export async function detectInstallers(): Promise<readonly InstallerInfo[]> {
  if (installerCache !== null) return installerCache;

  const condaExe = resolveCondaExe();

  const probes: { id: InstallerId; command: string; args: readonly string[] }[] = [
    { id: 'uv', command: 'uv', args: ['--version'] },
    // pip 用 `python -m pip`：PATH 里的 pip.exe 可能属于另一个环境，
    // 而那会把包装到用户没预期的地方
    { id: 'pip', command: 'python', args: ['-m', 'pip', '--version'] },
    { id: 'micromamba', command: 'micromamba', args: ['--version'] },
    { id: 'mamba', command: 'mamba', args: ['--version'] },
    {
      id: 'conda',
      command: condaExe ?? 'conda',
      args: ['--version'],
    },
    { id: 'R', command: 'Rscript', args: ['--version'] },
  ];

  const results = await Promise.all(
    probes.map(async (probe) => {
      const result = await capture(probe.command, probe.args);
      const text = `${result.stdout}${result.stderr}`.trim();
      const info: InstallerInfo = {
        id: probe.id,
        family: INSTALLER_FAMILY[probe.id],
        available: result.ok && text !== '',
        command: result.ok ? probe.command : null,
        version: text === '' ? null : (text.split('\n')[0] ?? null),
        reason: result.ok ? null : remediationForInstaller(probe.id),
      };
      return info;
    }),
  );

  installerCache = results;
  return results;
}

export function resetInstallerCache(): void {
  installerCache = null;
}

/** 安装器缺失时的补救说明。 */
export function remediationForInstaller(id: InstallerId): string {
  switch (id) {
    case 'uv':
      return (
        'uv 不在 PATH 里。它比 pip 快一到两个数量级，而且与 pip 用同一份 PyPI 元数据，' +
        '因此可以直接替代。安装：pip install uv，或到 https://docs.astral.sh/uv/ 看独立安装方式。' +
        '不装也能用——会回退到 pip。'
      );
    case 'pip':
      return 'python -m pip 不可用。托管环境里 pip 应当存在，缺失说明环境不完整。';
    case 'micromamba':
      return (
        'micromamba 不在 PATH 里。它是单个静态二进制，求解速度远快于 conda。' +
        '不装也能用——会回退到 mamba 或 conda。'
      );
    case 'mamba':
      return 'mamba 不在 PATH 里。安装：conda install -n base -c conda-forge mamba。不装会回退到 conda。';
    case 'conda':
      return (
        'conda 不可用。平台的托管环境依赖它，缺了它就没法创建或删除托管环境。' +
        '安装 Miniforge：https://conda-forge.org/download/'
      );
    case 'R':
      return (
        'Rscript 不在 PATH 里。R 包管理需要它。' +
        '创建托管 R 环境：conda create -n lsci-r -c conda-forge r-base r-irkernel -y'
      );
  }
}

/**
 * 在一个家族里挑最快可用的安装器（需求 15.3）。
 *
 * 回退**只在家族内**发生。让 `uv` 去顶替 `conda` 不是回退而是换了包来源，而那正是
 * 需求 15.4 要防的事。因此这个函数的签名里 family 是必填的——没有「随便给我一个
 * 最快的」这种调用方式。
 */
export function pickInstaller(
  installers: readonly InstallerInfo[],
  family: InstallerFamily,
): { installer: InstallerInfo | null; reason: string } {
  const order = INSTALLER_PRIORITY[family];
  const skipped: string[] = [];

  for (const id of order) {
    const info = installers.find((i) => i.id === id);
    if (info === undefined || !info.available) {
      skipped.push(id);
      continue;
    }
    const reason =
      skipped.length === 0
        ? `用 ${id}（${family} 家族里最快的可用安装器）`
        : `用 ${id}；更快的 ${skipped.join('、')} 不可用，已回退（需求 15.3）`;
    return { installer: info, reason };
  }

  return {
    installer: null,
    reason:
      `${family} 家族里没有可用的安装器（试过 ${order.join('、')}）。\n` +
      order.map((id) => `- ${id}：${remediationForInstaller(id)}`).join('\n'),
  };
}

/* ------------------------------------------------------------------ *
 * 包清单
 * ------------------------------------------------------------------ */

interface CondaListEntry {
  name?: unknown;
  version?: unknown;
  channel?: unknown;
  base_url?: unknown;
}

/**
 * 把 conda 的 channel 字段翻译成来源。
 *
 * conda 把 pip 装的包标成 `channel: "pypi"`——这一点是需求 15.4 能实现的全部基础：
 * **权威来源是 conda 自己的元数据，不是我们的安装记录**。用户可以在环境里自己跑 pip，
 * 那时我们的记录会漏，而 conda 不会。
 */
export function sourceOfChannel(channel: string | null): PackageSource {
  if (channel === null || channel.trim() === '') return 'unknown';
  const lower = channel.toLowerCase();
  if (lower === 'pypi' || lower.includes('/pypi')) return 'pypi';
  return 'conda';
}

/** 解析 `conda list --json`。 */
export function parseCondaList(raw: string): readonly PackageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const now = Date.now();
  const out: PackageRecord[] = [];
  for (const entry of parsed as CondaListEntry[]) {
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (name === null || name === '') continue;
    const channel = typeof entry.channel === 'string' ? entry.channel : null;
    out.push({
      name,
      version: typeof entry.version === 'string' ? entry.version : null,
      source: sourceOfChannel(channel),
      channel,
      installedBy: null,
      installedAt: now,
    });
  }
  return out;
}

/**
 * 解析 `pip list --format=json`。
 *
 * venv 环境走这条路：那里没有 conda 元数据，而且也不需要——venv 里只有 pip 一个来源，
 * 混装在物理上不可能发生。
 */
export function parsePipList(raw: string): readonly PackageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const now = Date.now();
  const out: PackageRecord[] = [];
  for (const entry of parsed as { name?: unknown; version?: unknown }[]) {
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (name === null || name === '') continue;
    out.push({
      name,
      version: typeof entry.version === 'string' ? entry.version : null,
      source: 'pypi',
      channel: 'pypi',
      installedBy: null,
      installedAt: now,
    });
  }
  return out;
}

/** 解析 R 的已装包清单（我们让 R 输出 TSV）。 */
export function parseRPackages(raw: string): readonly PackageRecord[] {
  const now = Date.now();
  const out: PackageRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [name, version] = trimmed.split('\t');
    if (name === undefined || name === '') continue;
    out.push({
      name,
      version: version === undefined || version === '' ? null : version,
      source: 'cran',
      channel: 'cran',
      installedBy: null,
      installedAt: now,
    });
  }
  return out;
}

/** 列出一个环境里已装的包。 */
export async function listPackages(input: {
  kind: EnvKind;
  language: 'python' | 'r';
  prefix: string;
  interpreter: string | null;
}): Promise<{ packages: readonly PackageRecord[]; detail: string }> {
  if (input.language === 'r') {
    const rscript = rscriptIn(input.prefix);
    if (rscript === null) {
      return { packages: [], detail: `${input.prefix} 下找不到 Rscript` };
    }
    const result = await capture(
      rscript,
      [
        '-e',
        // 只要名字与版本；write.table 输出 TSV，比 print 的对齐输出好解析
        'ip <- installed.packages(); cat(paste(ip[,"Package"], ip[,"Version"], sep="\\t"), sep="\\n")',
      ],
      PROBE_TIMEOUT_MS,
    );
    return {
      packages: parseRPackages(result.stdout),
      detail: result.ok ? '' : result.stderr.slice(0, 500),
    };
  }

  /*
   * conda 环境优先用 `conda list --json`。
   *
   * 它比 `pip list` 多给出**来源**（channel），而来源正是需求 15.4 的判据。
   * 退回 pip list 会让所有包看起来都是 pypi 装的，于是混装检查永远不触发。
   */
  if (input.kind === 'conda') {
    const condaExe = resolveCondaExe();
    if (condaExe !== null) {
      const result = await capture(
        condaExe,
        ['list', '--prefix', input.prefix, '--json'],
        PROBE_TIMEOUT_MS,
      );
      if (result.ok) {
        return { packages: parseCondaList(result.stdout), detail: '' };
      }
    }
  }

  const interpreter = input.interpreter ?? pythonInterpreterIn(input.prefix);
  if (interpreter === null) {
    return { packages: [], detail: `${input.prefix} 下找不到 Python 解释器` };
  }
  const result = await capture(
    interpreter,
    ['-m', 'pip', 'list', '--format=json'],
    PROBE_TIMEOUT_MS,
  );
  return {
    packages: parsePipList(result.stdout),
    detail: result.ok
      ? input.kind === 'conda'
        ? 'conda list 不可用，退回 pip list——因此看不到包的来源，混装检查会失效'
        : ''
      : result.stderr.slice(0, 500),
  };
}

/* ------------------------------------------------------------------ *
 * 环境探测
 * ------------------------------------------------------------------ */

/**
 * 探测一个环境。
 *
 * `status` 的四种非 ready 取值各对应一个不同的处理动作，因此不能合并：
 *
 * - `missing`：目录不在了（用户删了或移动了）。要重新登记或删掉记录。
 * - `incomplete`：目录在但缺 ipykernel。要装一个包。
 * - `failed`：创建过程失败。要看日志重试。
 * - `creating`：后台任务还在跑。等着就行。
 */
export async function probeEnv(input: {
  prefix: string;
  kind: EnvKind;
  language: 'python' | 'r';
  interpreter?: string | null;
}): Promise<EnvProbe> {
  const at = Date.now();
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  if (!existsSync(input.prefix)) {
    return {
      at,
      status: 'missing',
      summary: `环境目录不存在：${input.prefix}`,
      version: null,
      hasKernelSpec: false,
      checks: [
        {
          name: '目录',
          ok: false,
          detail:
            `${input.prefix} 不存在。用户可能删掉或移动了它。` +
            '平台不会替你重建——那里面可能有花很久装好的依赖，重建会得到一个空环境。',
        },
      ],
      packageCount: 0,
      pypiInCondaCount: 0,
    };
  }
  try {
    if (!statSync(input.prefix).isDirectory()) {
      return {
        at,
        status: 'missing',
        summary: `${input.prefix} 不是目录`,
        version: null,
        hasKernelSpec: false,
        checks: [{ name: '目录', ok: false, detail: '路径存在但不是目录' }],
        packageCount: 0,
        pypiInCondaCount: 0,
      };
    }
  } catch {
    // statSync 抛错按不存在处理
  }
  checks.push({ name: '目录', ok: true, detail: input.prefix });

  if (input.language === 'r') {
    const rscript = rscriptIn(input.prefix);
    checks.push({
      name: 'Rscript',
      ok: rscript !== null,
      detail:
        rscript ??
        `${input.prefix} 下找不到 Rscript。Windows 上 conda 装的 R 在 lib/R/bin/x64 下，` +
          'bin/R.exe 与 Scripts/R.exe 都起不来。',
    });
    if (rscript === null) {
      return {
        at,
        status: 'incomplete',
        summary: '找不到 Rscript',
        version: null,
        hasKernelSpec: false,
        checks,
        packageCount: 0,
        pypiInCondaCount: 0,
      };
    }

    const versionResult = await capture(rscript, ['--version']);
    const version =
      /(\d+\.\d+\.\d+)/u.exec(`${versionResult.stdout}${versionResult.stderr}`)?.[1] ?? null;
    checks.push({ name: 'R 版本', ok: version !== null, detail: version ?? '取不到版本号' });

    const packages = await listPackages({
      kind: input.kind,
      language: 'r',
      prefix: input.prefix,
      interpreter: null,
    });
    const hasIRkernel = packages.packages.some((p) => p.name === 'IRkernel');
    checks.push({
      name: 'IRkernel',
      ok: hasIRkernel,
      detail: hasIRkernel
        ? '已安装'
        : '没有 IRkernel，起不了 R 内核。装：conda install -c conda-forge r-irkernel',
    });

    return {
      at,
      status: hasIRkernel ? 'ready' : 'incomplete',
      summary: hasIRkernel
        ? `R ${version ?? '?'}，${String(packages.packages.length)} 个包`
        : 'R 在但缺 IRkernel',
      version,
      hasKernelSpec: hasIRkernel,
      checks,
      packageCount: packages.packages.length,
      pypiInCondaCount: 0,
    };
  }

  const interpreter = input.interpreter ?? pythonInterpreterIn(input.prefix);
  checks.push({
    name: 'Python 解释器',
    ok: interpreter !== null,
    detail:
      interpreter ??
      `${input.prefix} 下找不到 python。conda 环境在 prefix 根上或 bin/ 下，` +
        'venv 在 Scripts\\ 或 bin/ 下。',
  });
  if (interpreter === null) {
    return {
      at,
      status: 'incomplete',
      summary: '找不到 Python 解释器',
      version: null,
      hasKernelSpec: false,
      checks,
      packageCount: 0,
      pypiInCondaCount: 0,
    };
  }

  const versionResult = await capture(interpreter, ['--version']);
  const version =
    /(\d+\.\d+\.\d+)/u.exec(`${versionResult.stdout}${versionResult.stderr}`)?.[1] ?? null;
  checks.push({
    name: 'Python 版本',
    ok: version !== null,
    detail:
      version ??
      `解释器跑不起来：${(versionResult.stderr || versionResult.stdout).slice(0, 200)}。` +
        'venv 的解释器可能指向一个已经被删掉的基础 Python。',
  });
  if (version === null) {
    return {
      at,
      status: 'incomplete',
      summary: '解释器存在但跑不起来',
      version: null,
      hasKernelSpec: false,
      checks,
      packageCount: 0,
      pypiInCondaCount: 0,
    };
  }

  if (input.kind === 'venv') {
    const config = readVenvConfig(input.prefix);
    const home = config?.['home'] ?? null;
    checks.push({
      name: 'venv 基础解释器',
      ok: home === null || existsSync(home),
      detail:
        home === null
          ? 'pyvenv.cfg 里没有 home 字段'
          : existsSync(home)
            ? home
            : `pyvenv.cfg 指向的基础 Python 已不存在：${home}。` +
              'venv 目录还在，但它依赖的那个 Python 被删了或升级换了目录。',
    });
  }

  /*
   * ipykernel 决定能不能起内核（需求 15.2）。
   *
   * 用 `-c "import ipykernel"` 而不是查包清单：包清单可能因为元数据损坏而漏报，
   * 而这里要回答的是「导入得进去吗」——那与「装过吗」不是一回事。
   */
  const kernelCheck = await capture(interpreter, [
    '-c',
    'import ipykernel, sys; sys.stdout.write(ipykernel.__version__)',
  ]);
  const hasKernelSpec = kernelCheck.ok && kernelCheck.stdout.trim() !== '';
  checks.push({
    name: 'ipykernel',
    ok: hasKernelSpec,
    detail: hasKernelSpec
      ? `ipykernel ${kernelCheck.stdout.trim()}`
      : '这个环境里导入不了 ipykernel，因此起不了内核。' +
        `装："${interpreter}" -m pip install ipykernel`,
  });

  const packages = await listPackages({
    kind: input.kind,
    language: 'python',
    prefix: input.prefix,
    interpreter,
  });
  if (packages.detail !== '') {
    checks.push({ name: '包清单', ok: false, detail: packages.detail });
  }
  const pypiInConda =
    input.kind === 'conda' ? packages.packages.filter((p) => p.source === 'pypi').length : 0;

  const status: EnvStatus = hasKernelSpec ? 'ready' : 'incomplete';
  return {
    at,
    status,
    summary: hasKernelSpec
      ? `Python ${version}，${String(packages.packages.length)} 个包` +
        (pypiInConda > 0 ? `（其中 ${String(pypiInConda)} 个来自 PyPI）` : '')
      : `Python ${version}，但缺 ipykernel，起不了内核`,
    version,
    hasKernelSpec,
    checks,
    packageCount: packages.packages.length,
    pypiInCondaCount: pypiInConda,
  };
}

/* ------------------------------------------------------------------ *
 * conda 环境枚举
 * ------------------------------------------------------------------ */

export interface CondaEnvInfo {
  name: string;
  prefix: string;
  /** 是不是平台的托管环境。 */
  managed: boolean;
  language: 'python' | 'r' | null;
}

/**
 * 枚举本机的 conda 环境（需求 15.1）。
 *
 * 把托管环境（`lsci` / `lsci-r`）与用户自己的环境都列出来，但标记出来——用户需要知道
 * 「哪些是平台建的、可以让平台删」。删掉一个用户自己的环境是不可接受的。
 */
export async function listCondaEnvironments(): Promise<readonly CondaEnvInfo[]> {
  const prefixes = listCondaEnvs();
  const out: CondaEnvInfo[] = [];

  for (const prefix of prefixes) {
    const clean = prefix.replace(/[\\/]+$/u, '');
    const name = clean.split(/[\\/]/u).pop() ?? clean;
    const managed = name === MANAGED_PYTHON_ENV || name === MANAGED_R_ENV;

    /*
     * 语言判定：看装了什么，而不是看名字。
     *
     * 一个 conda 环境完全可以两个都装。需求 15.7 要求 R 与 Python 分处独立环境，
     * 因此「两个都有」本身就是要报出来的事——而按名字猜会把它藏起来。
     */
    const hasR = rscriptIn(clean) !== null;
    const hasPython = pythonInterpreterIn(clean) !== null;
    const language = hasR && !hasPython ? 'r' : hasPython && !hasR ? 'python' : hasR ? 'r' : null;

    out.push({ name, prefix: clean, managed, language });
  }

  return out;
}

/** conda 是否可用。创建与删除托管环境都要它。 */
export function condaAvailable(): boolean {
  return resolveCondaExe() !== null;
}

/** 猜一个 venv 的常见位置，供登记向导提示。 */
export function commonVenvLocations(workspaceDir?: string): readonly string[] {
  const candidates = [
    ...(workspaceDir === undefined
      ? []
      : [join(workspaceDir, '.venv'), join(workspaceDir, 'venv'), join(workspaceDir, 'env')]),
    join(homedir(), '.virtualenvs'),
    join(homedir(), '.venv'),
  ];
  return candidates.filter((p) => existsSync(p));
}

/** 从解释器路径反推环境根目录。 */
export function prefixOfInterpreter(interpreter: string): string {
  const dir = dirname(interpreter);
  const base = dir.split(/[\\/]/u).pop() ?? '';
  // Scripts / bin 下的解释器，环境根在上一层
  return base === 'Scripts' || base === 'bin' ? dirname(dir) : dir;
}
