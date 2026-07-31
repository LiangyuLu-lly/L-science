/**
 * 环境发现工具，doctor 与 verify-kernel 共用。
 *
 * 刻意不用 `shell: true`：Node 24 会对「shell + 数组参数」发弃用警告，因为参数
 * 不做转义只做拼接，存在注入面。这里改成直接定位真实可执行文件。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** L-science 托管的默认 Python 环境名。用户自己的研究环境不受影响。 */
export const MANAGED_ENV_NAME = 'lsci';

/**
 * R 独立成环境而不是塞进 Python 环境。
 *
 * 不是洁癖：conda 往 Python 环境装 R 时会连带解出新的 numpy，实测把 numpy 顶到
 * 2.5 而 numba 要求 ≤2.4，整个领域栈随即导入失败。按语言分环境让这类冲突不可能发生。
 */
export const MANAGED_R_ENV_NAME = 'lsci-r';

/** 跑一个可执行文件，拿 trim 后的 stdout。失败返回 null 而不是抛错。 */
export function capture(exe, args, { utf16 = false, timeout = 20_000, env } = {}) {
  try {
    const buf = execFileSync(exe, args, {
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    // wsl.exe 在 Windows 上输出 UTF-16LE，按 UTF-8 解码会得到夹杂空字符的乱码。
    const text = utf16 ? buf.toString('utf16le') : buf.toString('utf8');
    return text.replace(/\u0000/g, '').trim();
  } catch {
    return null;
  }
}

export function firstLine(text) {
  if (text === null) return null;
  const [line] = text.split(/\r?\n/);
  return line?.trim() ?? null;
}

/** npm 在 Windows 上是 .cmd 包装器，直接 spawn 会被 Node 拒绝。走它的 cli.js。 */
export function npmVersion() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(cli)) return null;
  return firstLine(capture(process.execPath, [cli, '--version']));
}

/**
 * 定位 conda 的真实可执行文件。
 * CONDA_EXE 由 conda 的 shell 集成设置，是最可靠的来源。
 */
export function resolveCondaExe() {
  const fromEnv = process.env.CONDA_EXE;
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;

  const candidates = [];
  const prefix = process.env.CONDA_PREFIX;
  if (prefix !== undefined && prefix !== '') {
    candidates.push(join(prefix, 'Scripts', 'conda.exe'), join(prefix, 'bin', 'conda'));
  }
  for (const base of [
    join(homedir(), 'anaconda3'),
    join(homedir(), 'miniconda3'),
    join(homedir(), 'miniforge3'),
  ]) {
    candidates.push(join(base, 'Scripts', 'conda.exe'), join(base, 'bin', 'conda'));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function condaInfo() {
  const exe = resolveCondaExe();
  if (exe === null) return { exe: null, base: null, envs: null };

  const base = firstLine(capture(exe, ['info', '--base']));
  let envs = null;
  const raw = capture(exe, ['env', 'list', '--json']);
  if (raw !== null) {
    try {
      envs = JSON.parse(raw).envs ?? null;
    } catch {
      envs = null;
    }
  }
  return { exe, base, envs };
}

/** 从 conda 环境列表里挑出托管环境的解释器路径。 */
export function managedPython(envs, envName = MANAGED_ENV_NAME) {
  const override = process.env.L_SCIENCE_PYTHON;
  if (override !== undefined && override !== '' && existsSync(override)) {
    return { prefix: dirname(override), executable: override };
  }

  const prefix = (envs ?? []).find((p) => p.replace(/[\\/]+$/, '').endsWith(envName));
  if (prefix === undefined) return null;

  const win = join(prefix, 'python.exe');
  const executable = existsSync(win) ? win : join(prefix, 'bin', 'python');
  return existsSync(executable) ? { prefix, executable } : null;
}

/**
 * 定位托管的 R 环境，并给出启动 R 所需的完整环境变量。
 *
 * Windows 上 conda 装的 R 不能直接跑 `lib/R/bin/x64/Rscript.exe`——它依赖的 DLL
 * 散落在 env 的 Library\bin 等目录下，不预置 PATH 会以 0xC0000135
 * （STATUS_DLL_NOT_FOUND）静默退出，stdout 与 stderr 都是空的，极难定位。
 *
 * 这里手动复现 conda activate 对 R 做的事，而不是用 `conda run`：后者会在
 * 内核外面多包一层进程，平台管理内核生命周期（中断、重启、强杀）时会拿不到真实 pid。
 */
export function managedR(envs, envName = MANAGED_R_ENV_NAME) {
  const prefix = (envs ?? []).find((p) => p.replace(/[\\/]+$/, '').endsWith(envName));
  if (prefix === undefined) return null;

  const rHome = join(prefix, 'lib', 'R');
  const isWin = process.platform === 'win32';
  const rscript = isWin ? join(rHome, 'bin', 'x64', 'Rscript.exe') : join(prefix, 'bin', 'Rscript');
  if (!existsSync(rscript)) return null;

  const pathDirs = [
    prefix,
    join(prefix, 'Library', 'mingw-w64', 'bin'),
    join(prefix, 'Library', 'usr', 'bin'),
    join(prefix, 'Library', 'bin'),
    join(prefix, 'Scripts'),
    join(prefix, 'bin'),
  ].filter((p) => existsSync(p));

  return {
    prefix,
    rHome,
    rscript,
    pathDirs,
    /** 传给 spawn 的 env 覆盖项。 */
    spawnEnv: {
      R_HOME: rHome,
      PATH: `${pathDirs.join(';')};${process.env.PATH ?? ''}`,
    },
  };
}

/** 探测 R 与 IRkernel 版本。返回 null 表示 R 不可用。 */
export function probeRVersions(r) {
  if (r === null) return null;
  const out = capture(
    r.rscript,
    ['-e', 'cat(R.version.string,"|",as.character(packageVersion("IRkernel")))'],
    { env: r.spawnEnv },
  );
  if (out === null) return null;
  const [rVersion, irkernel] = out.split('|').map((s) => s.trim());
  return { rVersion: rVersion ?? null, irkernel: irkernel ?? null };
}
