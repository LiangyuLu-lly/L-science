#!/usr/bin/env node
/**
 * L-science 环境自检。
 *
 * 同一份探测逻辑会被平台运行时复用：工具面要按探测结果决定注册哪些工具
 * （比如 R 未安装时不注册 `r`），沙箱后端要按探测结果决定隔离强度徽章。
 *
 * 用法：
 *   node scripts/doctor.mjs          人类可读报告
 *   node scripts/doctor.mjs --json   机器可读 JSON
 */

import { createRequire } from 'node:module';
import { existsSync, statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  MANAGED_ENV_NAME,
  MANAGED_R_ENV_NAME,
  capture,
  condaInfo,
  firstLine,
  managedPython,
  managedR,
  npmVersion,
  probeRVersions,
} from './lib/env.mjs';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

function gb(bytes) {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** 东亚宽字符占两列，padEnd 按码元计数会导致中文标签对不齐。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/* ---------------------------------------------------------------- *
 * 探测项
 * ---------------------------------------------------------------- */

function probeNode() {
  return {
    version: process.version,
    abi: process.versions.modules,
    platform: `${process.platform}-${process.arch}`,
    npm: npmVersion(),
  };
}

/**
 * 探测一个 Node-API 原生模块能否加载。
 *
 * 本机没有 C/C++ 工具链，所有原生依赖都必须命中 prebuilt 二进制。这个探测把
 * 「prebuilt 没匹配上当前 ABI」的问题在启动期暴露，而不是等用户跑第一个 cell 才炸。
 */
function probeNativeModule(name, extract) {
  try {
    const mod = require(name);
    return { available: true, detail: extract ? extract(mod) : null };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

/**
 * 探测 L-science 托管环境。
 *
 * 刻意不看 PATH 上的 python：平台的 `python` 工具跑在自己的托管环境里，
 * conda base 装了什么与内核能不能起来无关。把两者混在一起会给出假绿灯。
 */
function probeManagedEnv(envs) {
  const found = managedPython(envs);
  if (found === null) return { name: MANAGED_ENV_NAME, found: false };

  const probe = (mod, attr = '__version__') =>
    firstLine(capture(found.executable, ['-c', `import ${mod}; print(${mod}.${attr})`]));

  return {
    name: MANAGED_ENV_NAME,
    found: true,
    prefix: found.prefix,
    executable: found.executable,
    version: firstLine(capture(found.executable, ['--version'])),
    packages: {
      // ipykernel 是 `python` 工具的前置依赖（AD-2 走标准 Jupyter 协议）
      ipykernel: probe('ipykernel'),
      numpy: probe('numpy'),
      pandas: probe('pandas'),
      scipy: probe('scipy'),
      matplotlib: probe('matplotlib'),
      statsmodels: probe('statsmodels'),
      sklearn: probe('sklearn'),
      mne: probe('mne'),
      yasa: probe('yasa'),
      neurokit2: probe('neurokit2'),
      antropy: probe('antropy'),
      pyedflib: probe('pyedflib'),
      numba: probe('numba'),
    },
  };
}

/**
 * 探测托管的 R 环境。
 *
 * 刻意不看 PATH 上的 R：平台的 `r` 工具跑在自己的托管环境里。而且 Windows 上
 * conda 装的 R 不预置 PATH 就会以 STATUS_DLL_NOT_FOUND 静默退出（stdout/stderr
 * 全空），只探测 `R --version` 会得出「R 不存在」的错误结论。
 */
function probeREnv(envs) {
  const r = managedR(envs);
  if (r === null) return { name: MANAGED_R_ENV_NAME, found: false, available: false };

  const versions = probeRVersions(r);
  return {
    name: MANAGED_R_ENV_NAME,
    found: true,
    available: versions !== null && versions.irkernel !== null,
    prefix: r.prefix,
    rscript: r.rscript,
    ...(versions ?? {}),
  };
}

function probeWsl() {
  const status = capture('wsl.exe', ['--status'], { utf16: true });
  const list = capture('wsl.exe', ['-l', '-q'], { utf16: true });
  const distros =
    list === null
      ? []
      : list
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  return { installed: status !== null, distros, usable: distros.length > 0 };
}

function probeDocker() {
  const cli = firstLine(capture('docker', ['--version']));
  if (cli === null) return { cli: null, daemon: false };
  const info = capture('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 12_000 });
  return { cli, daemon: info !== null && info.length > 0, serverVersion: info };
}

function probeGpu() {
  const out = capture('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total',
    '--format=csv,noheader',
  ]);
  if (out === null) return { available: false };
  const parts = (firstLine(out) ?? '').split(',').map((s) => s.trim());
  return {
    available: true,
    name: parts[0] ?? null,
    driver: parts[1] ?? null,
    memory: parts[2] ?? null,
  };
}

function probeDisk() {
  try {
    const s = statfsSync(repoRoot);
    return { freeGb: gb(s.bsize * s.bavail), totalGb: gb(s.bsize * s.blocks) };
  } catch {
    return null;
  }
}

function probeElevation() {
  if (process.platform !== 'win32') return { admin: null };
  return { admin: capture('net', ['session']) !== null };
}

/* ---------------------------------------------------------------- *
 * 汇总
 * ---------------------------------------------------------------- */

const node = probeNode();
const conda = condaInfo();
const managed = probeManagedEnv(conda.envs);

const report = {
  timestamp: new Date().toISOString(),
  repoRoot,
  node,
  native: {
    'better-sqlite3': probeNativeModule('better-sqlite3', (Db) => {
      const db = new Db(':memory:');
      const { v } = db.prepare('SELECT sqlite_version() AS v').get();
      db.close();
      return `SQLite ${v}`;
    }),
    zeromq: probeNativeModule('zeromq', (z) => (z.version ? `libzmq ${z.version}` : null)),
  },
  conda: { exe: conda.exe, base: conda.base, envCount: conda.envs?.length ?? 0 },
  uv: firstLine(capture('uv', ['--version'])),
  managedEnv: managed,
  r: probeREnv(conda.envs),
  wsl: probeWsl(),
  docker: probeDocker(),
  gpu: probeGpu(),
  disk: probeDisk(),
  elevation: probeElevation(),
  installed: existsSync(resolve(repoRoot, 'node_modules')),
};

/** 沙箱后端可行性结论，直接对应设计文档 AD-3 的三种后端。 */
report.sandbox = {
  native: {
    usable: true,
    isolation: 'weak',
    note: '用户态：Job Object 限额 + 路径白名单 + 代理出口，可被绕过',
  },
  wsl2: {
    usable: report.wsl.usable,
    isolation: 'strong',
    note: report.wsl.usable
      ? '可用'
      : 'WSL2 已装但无发行版，需 wsl --install -d <Distro>（管理员 + 重启）',
  },
  docker: {
    usable: report.docker.daemon,
    isolation: 'strong',
    note: report.docker.daemon ? '可用' : 'Docker Desktop 未运行，需手动启动以重建 WSL 后端',
  },
};

report.recommendedSandbox = report.wsl.usable ? 'wsl2' : report.docker.daemon ? 'docker' : 'native';

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

/* ---------------------------------------------------------------- *
 * 人类可读输出
 * ---------------------------------------------------------------- */

const OK = '[ OK ]';
const NO = '[FAIL]';
const WARN = '[WARN]';

function line(status, label, detail) {
  process.stdout.write(`${status} ${padTo(label, 22)} ${detail ?? ''}\n`);
}

process.stdout.write('\nL-science 环境自检\n');
process.stdout.write(`${'-'.repeat(76)}\n`);

line(OK, 'Node', `${node.version}  ABI ${node.abi}  ${node.platform}  npm ${node.npm ?? '?'}`);

for (const [name, res] of Object.entries(report.native)) {
  line(res.available ? OK : NO, name, res.available ? (res.detail ?? '已加载') : res.error);
}

line(
  conda.base !== null ? OK : WARN,
  'conda',
  conda.base !== null ? `base ${conda.base}  共 ${report.conda.envCount} 个环境` : '未找到',
);
line(report.uv !== null ? OK : WARN, 'uv', report.uv ?? '未安装（可选，用于快速装包）');

// 托管环境是平台真正用来跑 python 内核的地方，与 PATH 上的 base 无关。
if (!managed.found) {
  line(
    NO,
    `托管环境 ${managed.name}`,
    `不存在 —— 需先创建：conda create -n ${managed.name} python=3.13`,
  );
} else {
  line(OK, `托管环境 ${managed.name}`, `${managed.version}  ${managed.prefix}`);
  const pkgs = managed.packages;
  line(
    pkgs.ipykernel !== null ? OK : NO,
    '  ipykernel',
    pkgs.ipykernel ?? '未安装 —— python 工具依赖它',
  );

  const core = ['numpy', 'pandas', 'scipy', 'matplotlib', 'statsmodels', 'sklearn'];
  const coreMissing = core.filter((m) => pkgs[m] === null);
  line(
    coreMissing.length === 0 ? OK : NO,
    '  科学栈',
    coreMissing.length === 0
      ? core.map((m) => `${m} ${pkgs[m]}`).join('  ')
      : `缺少 ${coreMissing.join(', ')}`,
  );

  const domain = ['mne', 'yasa', 'neurokit2', 'antropy', 'pyedflib'];
  const domainMissing = domain.filter((m) => pkgs[m] === null);
  line(
    domainMissing.length === 0 ? OK : WARN,
    '  领域栈',
    domain
      .filter((m) => pkgs[m] !== null)
      .map((m) => `${m} ${pkgs[m]}`)
      .join('  ') + (domainMissing.length > 0 ? `  |  缺少 ${domainMissing.join(', ')}` : ''),
  );

  // numba 编译期检查 numpy 上限，conda/pip 混装时最先炸的就是这一对。
  if (pkgs.numba !== null) {
    line(OK, '  numba/numpy', `numba ${pkgs.numba} 与 numpy ${pkgs.numpy} 兼容`);
  }
}

line(
  report.r.available ? OK : WARN,
  `托管环境 ${report.r.name}`,
  report.r.available
    ? `${report.r.rVersion}  IRkernel ${report.r.irkernel}  ${report.r.prefix}`
    : report.r.found
      ? '环境存在但 R 或 IRkernel 不可用（r 工具将不注册）'
      : `不存在（r 工具将不注册）—— 需先创建：conda create -n ${report.r.name} -c conda-forge r-base r-irkernel`,
);
line(
  report.wsl.usable ? OK : WARN,
  'WSL2',
  report.wsl.installed
    ? report.wsl.distros.length > 0
      ? `发行版：${report.wsl.distros.join(', ')}`
      : '内核就绪但无发行版'
    : '未安装',
);
line(
  report.docker.daemon ? OK : WARN,
  'Docker',
  report.docker.cli === null
    ? '未安装'
    : report.docker.daemon
      ? `daemon 可达，server ${report.docker.serverVersion}`
      : `${report.docker.cli}，但 daemon 未运行`,
);
line(
  report.gpu.available ? OK : WARN,
  'GPU',
  report.gpu.available
    ? `${report.gpu.name}  driver ${report.gpu.driver}  ${report.gpu.memory}`
    : '无 NVIDIA GPU',
);
if (report.disk !== null) {
  line(OK, '磁盘', `剩余 ${report.disk.freeGb} GB / 共 ${report.disk.totalGb} GB`);
}
line(
  report.elevation.admin === true ? OK : WARN,
  '权限',
  report.elevation.admin === true ? '管理员' : '普通用户（WSL 安装与防火墙规则需提权）',
);

process.stdout.write(`${'-'.repeat(76)}\n`);
process.stdout.write('沙箱后端可行性\n');
for (const [id, s] of Object.entries(report.sandbox)) {
  line(s.usable ? OK : WARN, `  ${id}`, `${padTo(s.isolation, 7)} ${s.note}`);
}
process.stdout.write(`\n建议后端：${report.recommendedSandbox}\n\n`);

const blockers = [];
if (!report.native['better-sqlite3'].available) blockers.push('better-sqlite3 无法加载');
if (!report.native.zeromq.available) blockers.push('zeromq 无法加载');
if (!managed.found) blockers.push(`托管环境 ${managed.name} 不存在`);
else if (managed.packages.ipykernel === null) blockers.push('托管环境缺 ipykernel');

if (blockers.length > 0) {
  process.stdout.write(`阻塞项：${blockers.join('；')}\n\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('无阻塞项。\n\n');
}
