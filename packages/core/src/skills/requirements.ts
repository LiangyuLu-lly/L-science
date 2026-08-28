/**
 * 技能依赖检查（任务 12.1，需求 9.6）。
 *
 * 一个声明了 `mne` 却没装 mne 的技能，被命中之后会让模型按 SKILL.md 写出一段
 * `import mne`，然后拿到 ImportError，然后开始猜——它无法从一次 import 失败里
 * 推断出「这台机器就是没装」，于是往往改成手写实现，产出一段看起来能跑但方法
 * 不对的代码。因此依赖必须在注入之前检查，缺失时**把安装命令给出来**。
 *
 * 探测是**批量**的：把所有技能声明的 Python 包合成一次 `find_spec` 调用。逐个
 * 起 Python 进程在三十几个技能上是几十秒的量级，而这件事发生在检索命中之后、
 * 用户等着回答的时候。
 */

import { spawnSync } from 'node:child_process';

import type { SkillRequires } from './manifest.js';

export interface ProbeResult {
  /** 名字到「是否可用」。探测本身失败时全部记为 false 并给出 reason。 */
  present: ReadonlyMap<string, boolean>;
  /** 探测无法进行的原因（例如环境不存在）。为 null 表示探测成功。 */
  failure: string | null;
}

export interface RequirementProbes {
  /** 批量探测 Python 包是否可 import。 */
  python: (modules: readonly string[]) => ProbeResult;
  /** 批量探测 R 包。 */
  r: (packages: readonly string[]) => ProbeResult;
  /** 探测可执行命令是否在 PATH 上。 */
  commands: (names: readonly string[]) => ProbeResult;
  /** 已配置且启用的连接器 id。 */
  connectors: () => ReadonlySet<string>;
  /** 当前可用的运行时能力。 */
  capabilities: () => ReadonlySet<string>;
}

export type MissingKind = 'python' | 'r' | 'command' | 'connector' | 'capability';

export interface MissingRequirement {
  kind: MissingKind;
  name: string;
  /** 可执行的补齐指引。 */
  remediation: string;
}

export interface RequirementReport {
  satisfied: boolean;
  missing: readonly MissingRequirement[];
  /** 探测本身失败的说明。此时 missing 里的项可能是误报，必须一并告知。 */
  probeFailures: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 默认探针（实际调环境）
 * ------------------------------------------------------------------ */

/** 单次探测的墙钟上限。探测卡住比探测失败更糟——用户在等回答。 */
const PROBE_TIMEOUT_MS = 20_000;

function runCapture(
  command: string,
  args: readonly string[],
): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const r = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.error !== undefined) return { ok: false, reason: r.error.message };
    if (r.status !== 0) {
      return {
        ok: false,
        reason: `退出码 ${String(r.status)}${r.stderr === '' ? '' : `：${r.stderr.trim().slice(0, 300)}`}`,
      };
    }
    return { ok: true, stdout: r.stdout };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 一次 Python 调用探测全部模块。用 find_spec 而不是真 import：真 import 会执行模块顶层代码。 */
export function probePythonModules(pythonExe: string | null): RequirementProbes['python'] {
  return (modules) => {
    if (modules.length === 0) return { present: new Map(), failure: null };
    if (pythonExe === null) {
      return {
        present: new Map(modules.map((m) => [m, false])),
        failure: '托管 Python 环境不存在，无法探测 Python 包',
      };
    }

    // 模块名经 JSON 传入，避免拼进代码字符串时被引号或换行破坏
    const code =
      'import importlib.util as u, json, sys\n' +
      'names = json.loads(sys.argv[1])\n' +
      'out = {}\n' +
      'for n in names:\n' +
      '    try:\n' +
      '        out[n] = u.find_spec(n) is not None\n' +
      '    except Exception:\n' +
      // find_spec 对某些包会抛（父包不存在时的 ModuleNotFoundError），按不可用处理
      '        out[n] = False\n' +
      'print(json.dumps(out))\n';

    const r = runCapture(pythonExe, ['-c', code, JSON.stringify(modules)]);
    if (!r.ok) {
      return { present: new Map(modules.map((m) => [m, false])), failure: r.reason };
    }

    try {
      const parsed = JSON.parse(r.stdout.trim()) as Record<string, boolean>;
      return { present: new Map(Object.entries(parsed)), failure: null };
    } catch {
      return {
        present: new Map(modules.map((m) => [m, false])),
        failure: `无法解析探测输出：${r.stdout.trim().slice(0, 200)}`,
      };
    }
  };
}

export function probeRPackages(rscriptExe: string | null): RequirementProbes['r'] {
  return (packages) => {
    if (packages.length === 0) return { present: new Map(), failure: null };
    if (rscriptExe === null) {
      return {
        present: new Map(packages.map((p) => [p, false])),
        failure: 'R 环境不存在，无法探测 R 包',
      };
    }

    const list = packages.map((p) => `"${p.replace(/["\\]/g, '')}"`).join(',');
    const code =
      `pkgs <- c(${list});` +
      'ok <- vapply(pkgs, function(p) requireNamespace(p, quietly = TRUE), logical(1));' +
      'cat(paste(pkgs, ifelse(ok, "1", "0"), sep = "=", collapse = "\\n"))';

    const r = runCapture(rscriptExe, ['-e', code]);
    if (!r.ok) {
      return { present: new Map(packages.map((p) => [p, false])), failure: r.reason };
    }

    const present = new Map<string, boolean>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, flag] = line.trim().split('=');
      if (name !== undefined && name !== '') present.set(name, flag === '1');
    }
    return { present, failure: null };
  };
}

export function probeCommands(): RequirementProbes['commands'] {
  return (names) => {
    const present = new Map<string, boolean>();
    for (const name of names) {
      // where 在 Windows 上、which 在别处。两者都在找不到时返回非零
      const r =
        process.platform === 'win32' ? runCapture('where', [name]) : runCapture('which', [name]);
      present.set(name, r.ok);
    }
    return { present, failure: null };
  };
}

/* ------------------------------------------------------------------ *
 * 检查
 * ------------------------------------------------------------------ */

/** Python 包的安装指引。托管环境用 conda run + pip，避免装进错误的环境。 */
function pythonRemediation(module: string, envName: string): string {
  return `conda run -n ${envName} python -m pip install ${module}`;
}

function rRemediation(pkg: string, envName: string): string {
  // conda-forge 的 R 包命名约定是 r-<小写包名>
  return `conda install -n ${envName} -c conda-forge r-${pkg.toLowerCase()}`;
}

const COMMAND_HINTS: Readonly<Record<string, string>> = {
  pandoc: 'conda install -n lsci -c conda-forge pandoc（手稿编译需要它）',
  latexmk: 'conda install -n lsci -c conda-forge texlive-core（LaTeX 编译需要它）',
  git: '从 https://git-scm.com/download/win 安装 Git for Windows',
};

export interface CheckRequirementsInput {
  requires: SkillRequires;
  probes: RequirementProbes;
  /** 托管 Python 环境名，用于生成安装命令。 */
  pythonEnv?: string;
  rEnv?: string;
  /** 各能力缺失时的指引，通常传 tools 层的 REMEDIATION 表。 */
  capabilityRemediation?: Readonly<Record<string, string>>;
}

/**
 * 检查一个技能的依赖。
 *
 * 探测失败时 `satisfied` 为 false 但会在 `probeFailures` 里说明「这是探测不出来，
 * 不是确定缺失」。把两者混为一谈会让「conda 恰好没响应」表现成「你没装 mne」，
 * 用户于是去装一个已经装好的包。
 */
export function checkRequirements(input: CheckRequirementsInput): RequirementReport {
  const { requires, probes } = input;
  const pythonEnv = input.pythonEnv ?? 'lsci';
  const rEnv = input.rEnv ?? 'lsci-r';

  const missing: MissingRequirement[] = [];
  const probeFailures: string[] = [];

  if (requires.python !== undefined && requires.python.length > 0) {
    const r = probes.python(requires.python);
    if (r.failure !== null) probeFailures.push(`Python 包探测失败：${r.failure}`);
    for (const name of requires.python) {
      if (r.present.get(name) !== true) {
        missing.push({
          kind: 'python',
          name,
          remediation: pythonRemediation(name, pythonEnv),
        });
      }
    }
  }

  if (requires.r !== undefined && requires.r.length > 0) {
    const r = probes.r(requires.r);
    if (r.failure !== null) probeFailures.push(`R 包探测失败：${r.failure}`);
    for (const name of requires.r) {
      if (r.present.get(name) !== true) {
        missing.push({ kind: 'r', name, remediation: rRemediation(name, rEnv) });
      }
    }
  }

  if (requires.commands !== undefined && requires.commands.length > 0) {
    const r = probes.commands(requires.commands);
    if (r.failure !== null) probeFailures.push(`命令探测失败：${r.failure}`);
    for (const name of requires.commands) {
      if (r.present.get(name) !== true) {
        missing.push({
          kind: 'command',
          name,
          remediation: COMMAND_HINTS[name] ?? `把 ${name} 装好并加入 PATH`,
        });
      }
    }
  }

  if (requires.connectors !== undefined && requires.connectors.length > 0) {
    const configured = probes.connectors();
    for (const id of requires.connectors) {
      if (!configured.has(id)) {
        missing.push({
          kind: 'connector',
          name: id,
          remediation: `在设置里配置并启用连接器 ${id}`,
        });
      }
    }
  }

  if (requires.capabilities !== undefined && requires.capabilities.length > 0) {
    const available = probes.capabilities();
    for (const capability of requires.capabilities) {
      if (!available.has(capability)) {
        missing.push({
          kind: 'capability',
          name: capability,
          remediation:
            input.capabilityRemediation?.[capability] ?? `当前环境缺少能力 ${capability}`,
        });
      }
    }
  }

  return { satisfied: missing.length === 0, missing, probeFailures };
}

/** 把缺失项整理成给模型与用户看的说明。 */
export function describeMissing(report: RequirementReport): string {
  if (report.satisfied && report.probeFailures.length === 0) return '';

  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push('该技能声明的依赖尚未满足：');
    for (const item of report.missing) {
      lines.push(`  · ${item.name}（${item.kind}）→ ${item.remediation}`);
    }
  }
  for (const failure of report.probeFailures) {
    // 明确区分「确定缺失」与「探测不出来」，否则用户会去装一个已经装好的包
    lines.push(`  ! ${failure}（以上判定可能是误报）`);
  }
  return lines.join('\n');
}

/**
 * 批量检查多个技能的依赖，Python 与 R 各只探测一次。
 *
 * 逐个技能各探测一次在三十几个技能上是几十秒量级，而这件事发生在用户等回答的
 * 时候。合并成一次调用之后代价与技能数量无关。
 */
export function checkManyRequirements(input: {
  entries: ReadonlyArray<{ slug: string; requires: SkillRequires }>;
  probes: RequirementProbes;
  pythonEnv?: string;
  rEnv?: string;
  capabilityRemediation?: Readonly<Record<string, string>>;
}): ReadonlyMap<string, RequirementReport> {
  const allPython = new Set<string>();
  const allR = new Set<string>();
  const allCommands = new Set<string>();

  for (const entry of input.entries) {
    for (const m of entry.requires.python ?? []) allPython.add(m);
    for (const p of entry.requires.r ?? []) allR.add(p);
    for (const c of entry.requires.commands ?? []) allCommands.add(c);
  }

  const pythonResult = input.probes.python([...allPython]);
  const rResult = input.probes.r([...allR]);
  const commandResult = input.probes.commands([...allCommands]);
  const connectors = input.probes.connectors();
  const capabilities = input.probes.capabilities();

  // 把已经拿到的结果包成「不再实际探测」的探针，复用单个技能的检查逻辑
  const cached: RequirementProbes = {
    python: () => pythonResult,
    r: () => rResult,
    commands: () => commandResult,
    connectors: () => connectors,
    capabilities: () => capabilities,
  };

  const out = new Map<string, RequirementReport>();
  for (const entry of input.entries) {
    out.set(
      entry.slug,
      checkRequirements({
        requires: entry.requires,
        probes: cached,
        ...(input.pythonEnv === undefined ? {} : { pythonEnv: input.pythonEnv }),
        ...(input.rEnv === undefined ? {} : { rEnv: input.rEnv }),
        ...(input.capabilityRemediation === undefined
          ? {}
          : { capabilityRemediation: input.capabilityRemediation }),
      }),
    );
  }
  return out;
}
