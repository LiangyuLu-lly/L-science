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
