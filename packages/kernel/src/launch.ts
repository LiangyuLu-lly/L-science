/**
 * 内核进程的启动规格与环境定位。
 *
 * 两条硬约束来自实测，不是偏好：
 *
 * 1. **不使用 `conda run`。** 它会在内核外面多包一层进程，导致我们拿到的 pid
 *    不是内核的 pid，中断、重启与强杀全部失效。改为手动复现 conda activate
 *    对 PATH 与 R_HOME 做的事。
 * 2. **R 必须预置 DLL 目录。** Windows 上 conda 装的 R 依赖散落在 env 的
 *    `Library\bin` 等目录，不预置 PATH 会以 `0xC0000135`
 *    （STATUS_DLL_NOT_FOUND）退出，且 stdout 与 stderr 全空，极难定位。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type KernelLanguage = 'python' | 'r';

/** L-science 托管的环境名。用户自己的研究环境不受影响。 */
export const MANAGED_PYTHON_ENV = 'lsci';
export const MANAGED_R_ENV = 'lsci-r';

export interface LaunchSpec {
  language: KernelLanguage;
  /** Jupyter 的 kernel_name，仅用于连接文件里的标识。 */
  kernelName: string;
  command: string;
  /** 连接文件路径会被追加到末尾。 */
  args: string[];
  /** 需要注入的环境变量（会与 process.env 合并）。 */
  env: Record<string, string>;
  /** 冷启动预算。R 加载 base 包明显慢于 Python。 */
  startupTimeoutMs: number;
  /**
   * 内核就绪后立即执行的初始化代码。
   * 逐条静默执行，失败只记录不阻塞——初始化失败不该让内核不可用。
   */
  initCode: string[];
}

/* ------------------------------------------------------------------ *
 * conda 环境定位
 * ------------------------------------------------------------------ *
 * 注意：`scripts/lib/env.mjs` 有一份等价实现。那是刻意的重复——诊断脚本
 * 必须在项目构建之前就能跑，不能依赖 dist 产物。两处的环境名常量由
 * tests/kernel-launch.test.ts 断言一致。
 */

function capture(exe: string, args: string[]): string | null {
  try {
    return execFileSync(exe, args, {
      timeout: 20_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

/** 定位 conda 可执行文件。CONDA_EXE 由 conda 的 shell 集成设置，最可靠。 */
export function resolveCondaExe(): string | null {
  const fromEnv = process.env['CONDA_EXE'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;

  const candidates: string[] = [];
  const prefix = process.env['CONDA_PREFIX'];
  if (prefix !== undefined && prefix !== '') {
    candidates.push(join(prefix, 'Scripts', 'conda.exe'), join(prefix, 'bin', 'conda'));
  }
  for (const base of ['anaconda3', 'miniconda3', 'miniforge3']) {
    candidates.push(
      join(homedir(), base, 'Scripts', 'conda.exe'),
      join(homedir(), base, 'bin', 'conda'),
    );
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function listCondaEnvs(): string[] {
  const exe = resolveCondaExe();
  if (exe === null) return [];
  const raw = capture(exe, ['env', 'list', '--json']);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { envs?: unknown };
    return Array.isArray(parsed.envs)
      ? parsed.envs.filter((e): e is string => typeof e === 'string')
      : [];
  } catch {
    return [];
  }
}

function findEnvPrefix(envs: readonly string[], name: string): string | null {
  return envs.find((p) => p.replace(/[\\/]+$/, '').endsWith(name)) ?? null;
}

export interface PythonEnv {
  prefix: string;
  executable: string;
}

export function resolvePythonEnv(envs: readonly string[] = listCondaEnvs()): PythonEnv | null {
  const override = process.env['L_SCIENCE_PYTHON'];
  if (override !== undefined && override !== '' && existsSync(override)) {
    return { prefix: dirname(override), executable: override };
  }

  const prefix = findEnvPrefix(envs, MANAGED_PYTHON_ENV);
  if (prefix === null) return null;

  const win = join(prefix, 'python.exe');
  const executable = existsSync(win) ? win : join(prefix, 'bin', 'python');
  return existsSync(executable) ? { prefix, executable } : null;
}

export interface REnv {
  prefix: string;
  rHome: string;
  rscript: string;
  pathDirs: string[];
}

/**
 * 按给定的环境目录构造 R 启动信息。
 *
 * 单独导出是为了让「用户登记的 R 环境」也能走同一段路径（任务 14.4，需求 15.2）。
 * 这段路径推断在 Windows 上有几个非显然的地方（真正的 Rscript 在 `lib/R/bin/x64` 下，
 * DLL 目录必须预置进 PATH），复制一份到别处迟早分叉，而分叉的表现是 R 内核以
 * `0xC0000135` 退出且 stdout/stderr 全空。
 */
export function rEnvAt(prefix: string): REnv | null {
  const rHome = join(prefix, 'lib', 'R');
  const isWin = process.platform === 'win32';
  // Windows 上真正的可执行文件在 bin/x64 下；bin/R.exe 与 Scripts/R.exe 都起不来。
  const candidates = isWin
    ? [join(rHome, 'bin', 'x64', 'Rscript.exe'), join(rHome, 'bin', 'Rscript.exe')]
    : [join(prefix, 'bin', 'Rscript'), join(rHome, 'bin', 'Rscript')];
  const rscript = candidates.find((p) => existsSync(p));
  if (rscript === undefined) return null;

  const pathDirs = [
    prefix,
    join(prefix, 'Library', 'mingw-w64', 'bin'),
    join(prefix, 'Library', 'usr', 'bin'),
    join(prefix, 'Library', 'bin'),
    join(prefix, 'Scripts'),
    join(prefix, 'bin'),
  ].filter((p) => existsSync(p));

  return { prefix, rHome, rscript, pathDirs };
}

export function resolveREnv(envs: readonly string[] = listCondaEnvs()): REnv | null {
  const prefix = findEnvPrefix(envs, MANAGED_R_ENV);
  return prefix === null ? null : rEnvAt(prefix);
}

/* ------------------------------------------------------------------ *
 * IRkernel 启动器
 * ------------------------------------------------------------------ */

/**
 * IRkernel 的启动器脚本内容。
 *
 * 不用文档里常见的 `R --slave -e "IRkernel::main()" --args <file>`：那条命令的
 * 引号要穿过 PowerShell、cmd 与 conda 多层传参，实测被剥掉后 R 报
 * `unexpected end of input`。写成文件就没有引号问题。
 *
 * 内容内联在这里而不是引用仓库里的 .R 文件，是为了让打包后的应用不依赖
 * 源码目录布局。
 */
const IRKERNEL_LAUNCHER = `args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) {
  stop("usage: Rscript irkernel-launch.R <connection_file>")
}
IRkernel::main(args[[1L]])
`;

/** 把启动器写到内核运行目录，返回其路径。 */
export function writeIRkernelLauncher(runtimeDir: string): string {
  const path = join(runtimeDir, 'irkernel-launch.R');
  writeFileSync(path, IRKERNEL_LAUNCHER, 'utf8');
  return path;
}

/* ------------------------------------------------------------------ *
 * 启动规格
 * ------------------------------------------------------------------ */

/**
 * Python 内核。
 *
 * `initCode` 里的 inline 后端是必须的：裸 ipykernel 不会把 figure 渲染成 PNG，
 * `display(fig)` 只返回 `text/plain`。
 */
export function pythonLaunchSpec(env: PythonEnv): LaunchSpec {
  return {
    language: 'python',
    kernelName: 'python3',
    command: env.executable,
    args: ['-m', 'ipykernel_launcher', '-f'],
    env: {},
    startupTimeoutMs: 30_000,
    initCode: ['%matplotlib inline'],
  };
}

/** R 内核。IRkernel 默认就把绘图作为 display_data 推送，不需要额外初始化。 */
export function rLaunchSpec(env: REnv, launcherPath: string): LaunchSpec {
  return {
    language: 'r',
    kernelName: 'ir',
    command: env.rscript,
    args: [launcherPath],
    env: {
      R_HOME: env.rHome,
      PATH: `${env.pathDirs.join(';')};${process.env['PATH'] ?? ''}`,
    },
    // R 冷启动明显慢于 Python
    startupTimeoutMs: 60_000,
    initCode: [],
  };
}

export interface AvailableKernels {
  python: PythonEnv | null;
  r: REnv | null;
}

/**
 * 探测可用内核。
 *
 * `r` 为 null 时上层不应注册 `r` 工具——需求 2.4 要求「R 不可用则不注册，
 * 并在被请求时给出可执行的安装指引」，而不是注册一个一调用就失败的工具。
 */
export function detectKernels(): AvailableKernels {
  const envs = listCondaEnvs();
  return { python: resolvePythonEnv(envs), r: resolveREnv(envs) };
}
