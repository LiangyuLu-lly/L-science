/**
 * 一键创建 lsci / lsci-r。已有 conda 就用 conda；否则下载 micromamba 到数据目录。
 * 不把 conda 打进安装包。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import {
  MANAGED_PYTHON_ENV,
  MANAGED_R_ENV,
  micromambaEnvPrefix,
  resolveCondaExe,
  resolvePythonEnv,
  resolveREnv,
} from '@l-science/kernel';

import { ensureMicromamba, micromambaRoot } from './micromamba.js';

const execFileAsync = promisify(execFile);
const CREATE_TIMEOUT_MS = 30 * 60 * 1000;

export type BootstrapStep = 'exists' | 'created' | 'failed' | 'running';

export type BootstrapReport = {
  readonly running: boolean;
  readonly python: BootstrapStep;
  readonly r: BootstrapStep;
  readonly log: readonly string[];
  readonly error: string | null;
  readonly commands: readonly string[];
};

export type RunCommand = (
  command: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stderr: string }>;

const defaultRun: RunCommand = async (command, args) => {
  try {
    const result = await execFileAsync(command, [...args], {
      timeout: CREATE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stderr: result.stderr.toString() };
  } catch (err: unknown) {
    const stderr =
      err !== null && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, stderr };
  }
};

let inFlight: Promise<void> | null = null;
let last: BootstrapReport = {
  running: false,
  python: 'exists',
  r: 'exists',
  log: [],
  error: null,
  commands: [],
};

export function resetBootstrapState(): void {
  inFlight = null;
  last = {
    running: false,
    python: 'exists',
    r: 'exists',
    log: [],
    error: null,
    commands: [],
  };
}

export function bootstrapKernelsStatus(): BootstrapReport {
  return last;
}

function pythonReady(): boolean {
  if (resolvePythonEnv() !== null) return true;
  const prefix = micromambaEnvPrefix(MANAGED_PYTHON_ENV);
  return prefix !== null && existsSync(prefix);
}

function rReady(): boolean {
  if (resolveREnv() !== null) return true;
  const prefix = micromambaEnvPrefix(MANAGED_R_ENV);
  return prefix !== null && existsSync(prefix);
}

export function startBootstrapKernels(options: {
  fetchImpl?: typeof fetch;
  run?: RunCommand;
  log?: (line: string) => void;
} = {}): BootstrapReport {
  if (inFlight !== null) {
    return { ...last, running: true };
  }
  if (pythonReady() && rReady()) {
    last = {
      running: false,
      python: 'exists',
      r: 'exists',
      log: ['lsci 与 lsci-r 已存在，无需安装。'],
      error: null,
      commands: [],
    };
    return last;
  }

  last = {
    running: true,
    python: pythonReady() ? 'exists' : 'running',
    r: rReady() ? 'exists' : 'running',
    log: ['开始安装内核环境…'],
    error: null,
    commands: [],
  };
  inFlight = runBootstrap(options)
    .catch((err: unknown) => {
      last = {
        ...last,
        running: false,
        error: err instanceof Error ? err.message : String(err),
      };
    })
    .finally(() => {
      inFlight = null;
    });
  return last;
}

async function runBootstrap(options: {
  fetchImpl?: typeof fetch;
  run?: RunCommand;
  log?: (line: string) => void;
}): Promise<void> {
  const run = options.run ?? defaultRun;
  const lines: string[] = [...last.log];
  const commands: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    last = { ...last, log: [...lines] };
    options.log?.(line);
  };

  const conda = resolveCondaExe();
  let installer: string;
  let extraArgs: string[] = [];
  if (conda !== null) {
    installer = conda;
    say(`使用本机 conda：${conda}`);
  } else {
    say('本机没有 conda，下载 micromamba 到数据目录（不打进安装包）。');
    const ensured = await ensureMicromamba(options.fetchImpl ?? fetch);
    if (!ensured.ok) {
      last = {
        running: false,
        python: pythonReady() ? 'exists' : 'failed',
        r: rReady() ? 'exists' : 'failed',
        log: [...lines, ensured.reason],
        error: ensured.reason,
        commands: [
          'conda create -n lsci python=3.13 ipykernel -y',
          'conda create -n lsci-r -c conda-forge r-base r-irkernel -y',
        ],
      };
      return;
    }
    installer = ensured.path;
    extraArgs = ['-r', micromambaRoot()];
    say(`micromamba：${installer}`);
  }

  const create = async (
    name: string,
    packages: readonly string[],
  ): Promise<'created' | 'exists' | 'failed'> => {
    if (name === MANAGED_PYTHON_ENV && pythonReady()) return 'exists';
    if (name === MANAGED_R_ENV && rReady()) return 'exists';
    const args = ['create', '-n', name, ...extraArgs, '-c', 'conda-forge', '-y', ...packages];
    const display = [installer, ...args].join(' ');
    commands.push(display);
    say(display);
    const result = await run(installer, args);
    if (!result.ok) {
      say(result.stderr.slice(-2000));
      return 'failed';
    }
    return 'created';
  };

  const python = await create(MANAGED_PYTHON_ENV, ['python=3.13', 'ipykernel']);
  const r = await create(MANAGED_R_ENV, ['r-base', 'r-irkernel']);
  const failed = python === 'failed' || r === 'failed';
  last = {
    running: false,
    python,
    r,
    log: lines,
    error: failed ? '有环境创建失败，见日志。可复制命令在终端重试。' : null,
    commands,
  };
  say(failed ? '未完成。' : '完成。重新体检即可。');
}
