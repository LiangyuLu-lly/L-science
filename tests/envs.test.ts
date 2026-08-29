/**
 * 环境与包管理测试（任务 14.4，需求 15.1-15.7）。
 *
 * 五块重点：
 *
 * 1. **conda / pip 混装判定**（需求 15.4）。这是这一组里最重要的一块：它挡住的失败
 *    模式不是「装不上」，而是「装上了、能导入、但算出来的数是错的」。判定按共享的
 *    原生库分组，因此 `conda scipy + pip numpy` 也必须被认出来。
 * 2. **安装器选择与回退**（需求 15.3）。回退只在家族内发生——让 uv 顶替 conda 不是
 *    回退而是换了包来源，那正是 15.4 要防的事。
 * 3. **命令构造**。每个安装器锁定目标环境的方式都不同，而装错环境的表现是
 *    「装成功了但导入不到」。
 * 4. **托管与登记的区别**（需求 15.1、15.2）。取消登记绝不能删掉用户自己的目录。
 * 5. **重启告知**（需求 15.5）。判定偏保守，措辞要同时说清丢什么与不丢什么。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AppStore,
  ENV_STATUS_LABEL,
  EnvService,
  EnvsRepo,
  INSTALLER_PRIORITY,
  NATIVE_GROUPS,
  checkConflicts,
  createCondaEnvCommand,
  detectEnvKind,
  existingMixups,
  groupsOf,
  installCommand,
  isNativeSensitive,
  needsRestart,
  normalizePackageName,
  parseCondaList,
  parsePipList,
  parseRPackages,
  pickInstaller,
  prefixOfInterpreter,
  pythonInterpreterIn,
  readVenvConfig,
  removeCondaEnvCommand,
  renderConflicts,
  renderMixups,
  restartNotice,
  sourceOfChannel,
  validateSpecs,
  type EnvRecord,
  type InstallerInfo,
  type PackageRecord,
} from '@l-science/core';

/* ------------------------------------------------------------------ *
 * 固定装置
 * ------------------------------------------------------------------ */

function pkg(name: string, source: PackageRecord['source'], version = '1.0.0'): PackageRecord {
  return {
    name,
    version,
    source,
    channel: source === 'pypi' ? 'pypi' : source === 'conda' ? 'conda-forge' : 'cran',
    installedBy: null,
    installedAt: 0,
  };
}

function installer(id: InstallerInfo['id'], available: boolean): InstallerInfo {
  return {
    id,
    family: id === 'uv' || id === 'pip' ? 'pypi' : id === 'R' ? 'cran' : 'conda',
    available,
    command: available ? id : null,
    version: available ? `${id} 1.0.0` : null,
    reason: available ? null : '不可用',
  };
}

/* ------------------------------------------------------------------ *
 * 1. 混装判定（需求 15.4）
 * ------------------------------------------------------------------ */

describe('conda / pip 混装判定', () => {
  it('同名包分属两个来源时报冲突', () => {
    const conflicts = checkConflicts({
      specs: ['numpy'],
      requestedSource: 'pypi',
      installed: [pkg('numpy', 'conda', '1.26.4')],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.existingSource).toBe('conda');
    expect(conflicts[0]?.requestedSource).toBe('pypi');
    // 冲突的物理原因要说出来，不能只说「可能有版本冲突」
    expect(conflicts[0]?.why).toContain('BLAS');
    expect(conflicts[0]?.why).toContain('算出错的数值');
  });

  it('同一原生库组里的不同包也报冲突', () => {
    // 只比对同名包会漏掉最常见的一类：conda 装了 scipy，然后 pip 装 numpy
    const conflicts = checkConflicts({
      specs: ['numpy'],
      requestedSource: 'pypi',
      installed: [pkg('scipy', 'conda')],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.name).toContain('scipy');
  });

  it('来源相同时不报', () => {
    expect(
      checkConflicts({
        specs: ['numpy'],
        requestedSource: 'conda',
        installed: [pkg('scipy', 'conda'), pkg('pandas', 'conda')],
      }),
    ).toHaveLength(0);
  });

  it('纯 Python 包不进这道门', () => {
    // 收进来只会让这道门在无害的情况下反复挡人，而那会让用户去找绕过它的办法
    expect(isNativeSensitive('requests')).toBe(false);
    expect(isNativeSensitive('tqdm')).toBe(false);
    expect(
      checkConflicts({
        specs: ['requests'],
        requestedSource: 'pypi',
        installed: [pkg('requests', 'conda')],
      }),
    ).toHaveLength(0);
  });

  it('识别各个原生库组的成员', () => {
    expect(groupsOf('numpy').map((g) => g.id)).toContain('blas');
    expect(groupsOf('h5py').map((g) => g.id)).toContain('hdf5');
    expect(groupsOf('torch').map((g) => g.id)).toContain('cuda');
    expect(groupsOf('shapely').map((g) => g.id)).toContain('geo');
    expect(groupsOf('numba').map((g) => g.id)).toContain('llvm');
    expect(groupsOf('opencv-python').map((g) => g.id)).toContain('opencv');
    expect(groupsOf('mne').map((g) => g.id)).toContain('neuro');
  });

  it('包名归一化按 PEP 503：下划线与点都当连字符', () => {
    expect(normalizePackageName('opencv_python')).toBe('opencv-python');
    expect(normalizePackageName('scikit.learn')).toBe('scikit-learn');
    expect(normalizePackageName('  NumPy>=1.26  ')).toBe('numpy');
    expect(normalizePackageName('torch[cuda]')).toBe('torch');
  });

  it('CRAN 请求不参与这道检查', () => {
    // R 包不与 Python 的原生库共处一个进程
    expect(
      checkConflicts({
        specs: ['ggplot2'],
        requestedSource: 'cran',
        installed: [pkg('numpy', 'conda')],
      }),
    ).toHaveLength(0);
  });

  it('解决办法给三条，「用同一来源」排在最前', () => {
    const conflicts = checkConflicts({
      specs: ['numpy'],
      requestedSource: 'pypi',
      installed: [pkg('numpy', 'conda')],
    });
    const remediation = conflicts[0]?.remediation ?? '';
    expect(remediation).toContain('1.');
    expect(remediation).toContain('2.');
    expect(remediation).toContain('3.');
    // 第一条必须是「与已有的保持同一来源」——那是唯一不留下混装状态的做法
    expect(remediation.split('\n')[0]).toContain('conda');
  });

  it('渲染出来的冲突说明包含物理原因与办法', () => {
    const text = renderConflicts(
      checkConflicts({
        specs: ['h5py'],
        requestedSource: 'pypi',
        installed: [pkg('tables', 'conda')],
      }),
    );
    expect(text).toContain('需求 15.4');
    expect(text).toContain('libhdf5');
    expect(text).toContain('怎么办');
  });

  it('已经存在的混装能查出来', () => {
    // 用户最常见的求助是「我的 numpy 导入报 DLL 错误」，而那时混装已经发生了
    const mixups = existingMixups([
      pkg('numpy', 'pypi'),
      pkg('scipy', 'conda'),
      pkg('requests', 'pypi'),
    ]);
    expect(mixups).toHaveLength(1);
    expect(mixups[0]?.group.id).toBe('blas');
    expect(mixups[0]?.conda.map((r) => r.name)).toEqual(['scipy']);
    expect(mixups[0]?.pypi.map((r) => r.name)).toEqual(['numpy']);

    const rendered = renderMixups(mixups);
    expect(rendered).toContain('算出错的数值');
    expect(rendered).toContain('新建一个环境');
  });

  it('没有混装时如实说没有', () => {
    expect(renderMixups(existingMixups([pkg('numpy', 'conda')]))).toContain('没有发现');
  });

  it('每个组都说清共享的是哪个原生库', () => {
    for (const group of NATIVE_GROUPS) {
      expect(group.library, group.id).not.toBe('');
      expect(group.why.length, group.id).toBeGreaterThan(20);
      expect(group.packages.length, group.id).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. 安装器选择与回退（需求 15.3）
 * ------------------------------------------------------------------ */

describe('安装器选择', () => {
  it('同家族里取最快可用的', () => {
    const pick = pickInstaller([installer('uv', true), installer('pip', true)], 'pypi');
    expect(pick.installer?.id).toBe('uv');
    expect(pick.reason).toContain('最快');
  });

  it('最快的不可用时回退，并说明回退了', () => {
    const pick = pickInstaller([installer('uv', false), installer('pip', true)], 'pypi');
    expect(pick.installer?.id).toBe('pip');
    expect(pick.reason).toContain('回退');
    expect(pick.reason).toContain('uv');
  });

  it('conda 家族的顺序是 micromamba → mamba → conda', () => {
    expect(INSTALLER_PRIORITY.conda).toEqual(['micromamba', 'mamba', 'conda']);
    const pick = pickInstaller(
      [installer('micromamba', false), installer('mamba', true), installer('conda', true)],
      'conda',
    );
    expect(pick.installer?.id).toBe('mamba');
  });

  it('整个家族都不可用时给出每一个的补救说明', () => {
    const pick = pickInstaller([installer('uv', false), installer('pip', false)], 'pypi');
    expect(pick.installer).toBeNull();
    expect(pick.reason).toContain('uv');
    expect(pick.reason).toContain('pip');
  });

  it('家族之间不互相回退', () => {
    // 让 uv 顶替 conda 不是回退，是换了包来源——那正是需求 15.4 要防的事
    const pick = pickInstaller(
      [installer('uv', true), installer('pip', true), installer('conda', false)],
      'conda',
    );
    expect(pick.installer).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3. 命令构造
 * ------------------------------------------------------------------ */

describe('安装命令构造', () => {
  it('pip 用解释器路径而不是 PATH 里的 pip.exe', () => {
    const command = installCommand({
      installer: 'pip',
      installerCommand: 'pip',
      envKind: 'venv',
      prefix: 'C:/proj/.venv',
      interpreter: 'C:/proj/.venv/Scripts/python.exe',
      specs: ['numpy'],
    });
    // PATH 里的 pip.exe 属于哪个环境取决于 PATH 顺序，装错环境的表现是「装成功了但导入不到」
    expect(command?.command).toBe('C:/proj/.venv/Scripts/python.exe');
    expect(command?.args).toEqual(['-m', 'pip', 'install', 'numpy']);
  });

  it('uv 必须给 --python，否则会装到它自己找到的 .venv 里', () => {
    const command = installCommand({
      installer: 'uv',
      installerCommand: 'uv',
      envKind: 'venv',
      prefix: 'C:/proj/.venv',
      interpreter: 'C:/proj/.venv/Scripts/python.exe',
      specs: ['numpy'],
    });
    expect(command?.args).toContain('--python');
    expect(command?.args).toContain('C:/proj/.venv/Scripts/python.exe');
  });

  it('conda 家族用 --prefix 而不是 -n', () => {
    const command = installCommand({
      installer: 'micromamba',
      installerCommand: 'micromamba',
      envKind: 'conda',
      prefix: 'C:/conda/envs/lsci',
      interpreter: 'C:/conda/envs/lsci/python.exe',
      specs: ['numpy'],
      channel: 'conda-forge',
    });
    // 用 -n 的话名字要能被 conda 解析成路径，而登记的用户环境可能不在 envs 目录下
    expect(command?.args).toContain('--prefix');
    expect(command?.args).toContain('C:/conda/envs/lsci');
    expect(command?.args).toContain('conda-forge');
  });

  it('卸载走各自的子命令', () => {
    expect(
      installCommand({
        installer: 'pip',
        installerCommand: 'pip',
        envKind: 'venv',
        prefix: 'p',
        interpreter: 'py',
        specs: ['numpy'],
        uninstall: true,
      })?.args,
    ).toEqual(['-m', 'pip', 'uninstall', '-y', 'numpy']);

    expect(
      installCommand({
        installer: 'conda',
        installerCommand: 'conda',
        envKind: 'conda',
        prefix: 'p',
        interpreter: null,
        specs: ['numpy'],
        uninstall: true,
      })?.args,
    ).toContain('remove');
  });

  it('R 包必须显式给 repos，否则会等一个不存在的镜像选择器', () => {
    const command = installCommand({
      installer: 'R',
      installerCommand: 'Rscript',
      envKind: 'conda',
      prefix: 'C:/conda/envs/lsci-r',
      interpreter: 'C:/conda/envs/lsci-r/lib/R/bin/x64/Rscript.exe',
      specs: ['ggplot2', 'lme4'],
    });
    // 不给 repos 时 R 会弹图形化选择器，而我们没有图形界面也没有 TTY——进程会永久挂住
    expect(command?.args[1]).toContain('repos');
    expect(command?.args[1]).toContain('ggplot2');
    expect(command?.args[1]).toContain('lme4');
  });

  it('缺解释器时构造不出 pip 命令而不是拼出一条错的', () => {
    expect(
      installCommand({
        installer: 'pip',
        installerCommand: 'pip',
        envKind: 'venv',
        prefix: 'p',
        interpreter: null,
        specs: ['numpy'],
      }),
    ).toBeNull();
  });

  it('创建 Python 环境时一并装 ipykernel', () => {
    const command = createCondaEnvCommand({
      condaExe: 'conda',
      installer: 'conda',
      installerCommand: 'conda',
      name: 'proj-a',
      language: 'python',
      pythonVersion: '3.12',
    });
    // 不装的话新环境的探测结果是 incomplete，而用户刚点了「创建」看到的是「缺组件」
    expect(command.args).toContain('ipykernel');
    expect(command.args).toContain('python=3.12');
    expect(command.args).toContain('conda-forge');
  });

  it('创建 R 环境时一并装 IRkernel，且与 Python 环境分开', () => {
    const command = createCondaEnvCommand({
      condaExe: 'conda',
      installer: 'conda',
      installerCommand: 'conda',
      name: 'proj-r',
      language: 'r',
    });
    expect(command.args).toContain('r-irkernel');
    // 需求 15.7：R 环境里不该出现 python=
    expect(command.args.some((a) => a.startsWith('python='))).toBe(false);
  });

  it('删除环境用 conda remove --all 而不是删目录', () => {
    const command = removeCondaEnvCommand({ installerCommand: 'conda', prefix: 'C:/envs/x' });
    // 直接删目录会留下 conda 自己的登记，于是 conda env list 一直报一个不存在的环境
    expect(command.args).toEqual(['remove', '--prefix', 'C:/envs/x', '--all', '-y']);
  });
});

describe('包名校验', () => {
  it('接受常见的版本约束写法', () => {
    expect(validateSpecs(['numpy']).ok).toBe(true);
    expect(validateSpecs(['numpy==1.26.4']).ok).toBe(true);
    expect(validateSpecs(['numpy>=1.26,<2']).ok).toBe(true);
    expect(validateSpecs(['torch[cuda]']).ok).toBe(true);
    expect(validateSpecs(['scikit-learn']).ok).toBe(true);
  });

  it('拒绝以 - 开头的选项注入', () => {
    const result = validateSpecs(['--index-url=http://evil/']);
    expect(result.ok).toBe(false);
    // --index-url 能让一次安装从任意服务器取包
    if (!result.ok) expect(result.reason).toContain('index-url');
  });

  it('拒绝 URL 与本地路径', () => {
    expect(validateSpecs(['https://evil/pkg.whl']).ok).toBe(false);
    expect(validateSpecs(['./local/pkg']).ok).toBe(false);
    expect(validateSpecs(['git+https://x/y.git']).ok).toBe(false);
  });

  it('空清单与超量都拒', () => {
    expect(validateSpecs([]).ok).toBe(false);
    expect(validateSpecs(Array.from({ length: 101 }, (_, i) => `p${String(i)}`)).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 重启告知（需求 15.5）
 * ------------------------------------------------------------------ */

describe('重启告知', () => {
  it('有活内核时判要重启，并说清为什么', () => {
    const result = needsRestart({ specs: ['numpy'], hasLiveKernel: true });
    expect(result.required).toBe(true);
    // 不重启的话内核里用的仍是旧版本，而且不会有任何提示
    expect(result.why).toContain('sys.modules');
  });

  it('没有活内核时不要求重启', () => {
    expect(needsRestart({ specs: ['numpy'], hasLiveKernel: false }).required).toBe(false);
  });

  it('卸载也要重启：已导入的模块不会被移除', () => {
    const result = needsRestart({ specs: ['numpy'], uninstall: true, hasLiveKernel: true });
    expect(result.required).toBe(true);
    expect(result.why).toContain('还能 import');
  });

  it('告知同时说清丢什么与不丢什么', () => {
    const notice = restartNotice({
      required: true,
      why: '模块缓存不会失效。',
      affectedConversations: ['conv-1', 'conv-2'],
    });
    expect(notice).toContain('变量');
    expect(notice).toContain('工作区里的文件');
    expect(notice).toContain('不会');
    expect(notice).toContain('2 个');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 包清单解析
 * ------------------------------------------------------------------ */

describe('包清单解析', () => {
  it('conda list 的 channel=pypi 被认成 PyPI 来源', () => {
    // 这一点是需求 15.4 能实现的全部基础：权威来源是 conda 自己的元数据
    const packages = parseCondaList(
      JSON.stringify([
        { name: 'numpy', version: '1.26.4', channel: 'conda-forge' },
        { name: 'mne', version: '1.6.0', channel: 'pypi' },
      ]),
    );
    expect(packages).toHaveLength(2);
    expect(packages[0]?.source).toBe('conda');
    expect(packages[1]?.source).toBe('pypi');
  });

  it('channel 缺失时记 unknown 而不是猜 conda', () => {
    expect(sourceOfChannel(null)).toBe('unknown');
    expect(sourceOfChannel('')).toBe('unknown');
    expect(sourceOfChannel('pypi')).toBe('pypi');
    expect(sourceOfChannel('https://conda.anaconda.org/conda-forge/win-64')).toBe('conda');
  });

  it('坏 JSON 返回空数组而不是抛', () => {
    expect(parseCondaList('{坏')).toEqual([]);
    expect(parsePipList('not json')).toEqual([]);
  });

  it('pip list 的条目一律算 pypi', () => {
    const packages = parsePipList(JSON.stringify([{ name: 'numpy', version: '1.26.4' }]));
    expect(packages[0]?.source).toBe('pypi');
  });

  it('R 的 TSV 清单被解析', () => {
    const packages = parseRPackages('ggplot2\t3.5.0\nlme4\t1.1-35\n\n');
    expect(packages).toHaveLength(2);
    expect(packages[0]).toMatchObject({ name: 'ggplot2', version: '3.5.0', source: 'cran' });
  });
});

/* ------------------------------------------------------------------ *
 * 6. 路径推断
 * ------------------------------------------------------------------ */

describe('环境路径推断', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-envpath-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('venv 靠 pyvenv.cfg 识别，conda 靠 conda-meta', () => {
    const venv = join(root, 'v');
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = C:/Python313\nversion = 3.13.1\n', 'utf8');
    expect(detectEnvKind(venv)).toBe('venv');
    expect(readVenvConfig(venv)?.['home']).toBe('C:/Python313');

    const conda = join(root, 'c');
    mkdirSync(join(conda, 'conda-meta'), { recursive: true });
    expect(detectEnvKind(conda)).toBe('conda');

    // 两个标记都缺时不猜——猜错会拿 conda 的命令去操作一个 venv
    expect(detectEnvKind(join(root, 'nothing'))).toBeNull();
  });

  it('三种解释器布局都能找到', () => {
    const a = join(root, 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'python.exe'), '', 'utf8');
    expect(pythonInterpreterIn(a)).toBe(join(a, 'python.exe'));

    const b = join(root, 'b', 'Scripts');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'python.exe'), '', 'utf8');
    expect(pythonInterpreterIn(join(root, 'b'))).toBe(join(b, 'python.exe'));

    expect(pythonInterpreterIn(join(root, 'missing'))).toBeNull();
  });

  it('从解释器路径反推环境根目录', () => {
    expect(prefixOfInterpreter('C:/envs/x/Scripts/python.exe')).toBe('C:/envs/x');
    expect(prefixOfInterpreter('/opt/env/bin/python')).toBe('/opt/env');
    // conda 环境的解释器直接在根上
    expect(prefixOfInterpreter('C:/envs/x/python.exe')).toBe('C:/envs/x');
  });
});

/* ------------------------------------------------------------------ *
 * 7. 仓储与服务
 * ------------------------------------------------------------------ */

describe('环境仓储与服务', () => {
  let root: string;
  let store: AppStore;
  let repo: EnvsRepo;
  let service: EnvService;
  let envDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-envs-'));
    store = AppStore.open(root);
    repo = new EnvsRepo(store.db);
    service = new EnvService({ repo });

    envDir = join(root, 'fake-venv');
    mkdirSync(join(envDir, 'Scripts'), { recursive: true });
    writeFileSync(join(envDir, 'pyvenv.cfg'), 'home = C:/Python313\n', 'utf8');
    // 空文件：探测会认出它但跑不起来，于是状态落在 incomplete——正是要验的那一档
    writeFileSync(join(envDir, 'Scripts', 'python.exe'), '', 'utf8');
  });

  afterEach(() => {
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const add = (over: Partial<Parameters<EnvsRepo['add']>[0]> = {}): EnvRecord =>
    repo.add({
      name: 'lsci',
      kind: 'conda',
      mode: 'managed',
      language: 'python',
      path: join(root, 'envs', 'lsci'),
      // 记上解释器路径：真实的 conda 环境一定有，而 uv/pip 的命令构造要用它
      interpreter: join(root, 'envs', 'lsci', 'python.exe'),
      status: 'ready',
      ...over,
    });

  it('同名与同路径都不许登记两次', () => {
    add();
    expect(() => add()).toThrow(/同名/u);
    // 同一个目录登记两次会让两条记录互相影响，而界面上看不出它们是同一个
    expect(() => add({ name: 'other' })).toThrow(/已经登记/u);
  });

  it('按名字或 id 都能找到', () => {
    const env = add();
    expect(repo.resolve('lsci')?.id).toBe(env.id);
    expect(repo.resolve('LSCI')?.id).toBe(env.id);
    expect(repo.resolve(env.id)?.id).toBe(env.id);
  });

  it('同一语言只能有一个默认', () => {
    const a = add({ name: 'a', path: join(root, 'a') });
    const b = add({ name: 'b', path: join(root, 'b') });
    repo.setDefault(a.id);
    expect(repo.defaultFor('python')?.id).toBe(a.id);

    // 设新的会自动清掉旧的——靠索引强制，而不是靠调用方记得
    repo.setDefault(b.id);
    expect(repo.defaultFor('python')?.id).toBe(b.id);
    expect(repo.get(a.id)?.isDefault).toBe(false);
  });

  it('R 与 Python 各有自己的默认', () => {
    const py = add({ name: 'py', path: join(root, 'py') });
    const r = add({ name: 'r', language: 'r', path: join(root, 'r') });
    repo.setDefault(py.id);
    repo.setDefault(r.id);
    expect(repo.defaultFor('python')?.id).toBe(py.id);
    expect(repo.defaultFor('r')?.id).toBe(r.id);
  });

  it('包清单整体替换，来源计数可查', () => {
    const env = add();
    repo.replacePackages(env.id, [pkg('numpy', 'conda'), pkg('mne', 'pypi')]);
    const stats = repo.packageStats(env.id);
    expect(stats.total).toBe(2);
    expect(stats.bySource['pypi']).toBe(1);

    // 整体替换：用户自己跑过 pip 之后重新探测要能反映真实状态
    repo.replacePackages(env.id, [pkg('numpy', 'conda')]);
    expect(repo.packageStats(env.id).total).toBe(1);
  });

  it('按来源筛包：「哪些是 pip 装的」是排查导入错误的第一个问题', () => {
    const env = add();
    repo.replacePackages(env.id, [
      pkg('numpy', 'conda'),
      pkg('mne', 'pypi'),
      pkg('nibabel', 'pypi'),
    ]);
    expect(
      repo
        .packages(env.id, { source: 'pypi' })
        .map((p) => p.name)
        .sort(),
    ).toEqual(['mne', 'nibabel']);
  });

  it('markInstalledBy 区分平台装的与用户装的', () => {
    const env = add();
    repo.replacePackages(env.id, [pkg('numpy', 'conda'), pkg('mne', 'pypi')]);
    expect(repo.markInstalledBy(env.id, ['numpy'], 'platform:conda')).toBe(1);
    expect(repo.packages(env.id).find((p) => p.name === 'numpy')?.installedBy).toBe(
      'platform:conda',
    );
    expect(repo.packages(env.id).find((p) => p.name === 'mne')?.installedBy).toBeNull();
  });

  it('取消登记用户的环境时不删目录', async () => {
    const env = repo.add({
      name: 'my-venv',
      kind: 'venv',
      mode: 'registered',
      language: 'python',
      path: envDir,
      status: 'ready',
    });

    // 带 deleteFiles 的请求要被明确拒绝并说清理由
    const refused = await service.remove(env.id, { deleteFiles: true });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('花很久');

    const removed = await service.remove(env.id, { deleteFiles: false });
    expect(removed.ok).toBe(true);
    expect(removed.deletedFiles).toBe(false);
    // 目录必须还在——那里面可能有花了一天装好的依赖
    expect(detectEnvKind(envDir)).toBe('venv');
  });

  it('托管环境 lsci / lsci-r 不许删', async () => {
    const env = add({ name: 'lsci' });
    const result = await service.remove(env.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('所有会话的内核');
  });

  it('有内核在跑的环境不许删', async () => {
    const env = add({ name: 'busy', path: join(root, 'busy') });
    const withKernels = new EnvService({ repo, liveKernels: () => ['conv-1', 'conv-2'] });
    const result = await withKernels.remove(env.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 个活着的内核');
  });

  it('状态不是 ready 的环境不许设为默认', () => {
    const env = add({ name: 'broken', path: join(root, 'broken'), status: 'incomplete' });
    const result = service.setDefault(env.id);
    expect(result.ok).toBe(false);
    // 设了之后新内核会起不来，而那时用户看到的是「内核启动失败」
    expect(result.reason).toContain('新内核会起不来');
  });

  it('登记一个真实存在的 venv 目录', async () => {
    const result = await service.register({ name: 'proj', path: envDir });
    expect(result.ok).toBe(true);
    expect(result.env?.mode).toBe('registered');
    expect(result.env?.kind).toBe('venv');
    // 缺 ipykernel 照样登记，但状态标出来——拒绝登记会让用户陷在死循环里
    expect(result.env?.status).not.toBe('ready');
    expect(ENV_STATUS_LABEL[result.env?.status ?? 'failed']).not.toBe('');
  });

  it('登记不存在的路径时说清该给哪一层', async () => {
    const result = await service.register({ name: 'x', path: join(root, 'nope') });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pyvenv.cfg');
  });

  it('登记一个既没有 conda-meta 也没有 pyvenv.cfg 的目录被拒', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    const result = await service.register({ name: 'x', path: plain });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('往上一层');
  });

  it('计划：R 环境不接受 pypi 家族，并指向需求 15.7', async () => {
    const env = add({ name: 'r-env', language: 'r', path: join(root, 'r-env') });
    const plan = await service.plan({
      envId: env.id,
      request: { specs: ['numpy'], family: 'pypi' },
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('需求 15.7');
  });

  it('计划：venv 不接受 conda 家族', async () => {
    const env = repo.add({
      name: 'v',
      kind: 'venv',
      mode: 'registered',
      language: 'python',
      path: envDir,
      status: 'ready',
    });
    const plan = await service.plan({
      envId: env.id,
      request: { specs: ['gdal'], family: 'conda' },
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('新建一个 conda 环境');
  });

  it('计划：目录不在了时先说这个，而不是去挑安装器', async () => {
    const env = add({ name: 'gone', path: join(root, 'gone'), status: 'missing' });
    const plan = await service.plan({ envId: env.id, request: { specs: ['numpy'] } });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('已经不在了');
  });

  it('计划：混装冲突会让 plan 不 ok，且理由带物理原因', async () => {
    const env = add({ name: 'mix', path: join(root, 'mix') });
    repo.replacePackages(env.id, [pkg('numpy', 'conda')]);
    const plan = await service.plan({
      envId: env.id,
      request: { specs: ['numpy'], family: 'pypi' },
    });
    expect(plan.ok).toBe(false);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.reason).toContain('需求 15.4');
    expect(plan.reason).toContain('不会报错');
  });

  it('计划：conda 环境里对原生库敏感的包默认走 conda 家族', async () => {
    const env = add({ name: 'sci', path: join(root, 'sci') });
    const sensitive = await service.plan({ envId: env.id, request: { specs: ['numpy'] } });
    // 这是需求 15.4 的正面表达：默认选择本身就不产生混装
    expect(sensitive.family).toBe('conda');

    const plain = await service.plan({ envId: env.id, request: { specs: ['requests'] } });
    expect(plain.family).toBe('pypi');
  });

  it('计划：包名不合法时不去挑安装器', async () => {
    const env = add({ name: 'x', path: join(root, 'x') });
    const plan = await service.plan({
      envId: env.id,
      request: { specs: ['--index-url=http://evil/'] },
    });
    expect(plan.ok).toBe(false);
    expect(plan.installer).toBeNull();
  });

  it('R 与 Python 混在一个环境里会被 separationCheck 报出来', () => {
    const both = join(root, 'both');
    mkdirSync(join(both, 'lib', 'R', 'bin', 'x64'), { recursive: true });
    mkdirSync(join(both, 'conda-meta'), { recursive: true });
    writeFileSync(join(both, 'python.exe'), '', 'utf8');
    writeFileSync(join(both, 'lib', 'R', 'bin', 'x64', 'Rscript.exe'), '', 'utf8');
    add({ name: 'both', path: both });

    const check = service.separationCheck();
    // 需求 15.7 做成可查而不是只在文档里声明
    expect(check.ok).toBe(false);
    expect(check.violations[0]).toContain('同时有 Python 与 R');
  });

  it('separationCheck 在分开时如实通过', () => {
    add({ name: 'py-only', path: join(root, 'py-only') });
    expect(service.separationCheck().ok).toBe(true);
  });

  it('render 列出状态、来源分布与托管标记', () => {
    const env = add({ name: 'lsci' });
    repo.replacePackages(env.id, [pkg('numpy', 'conda'), pkg('mne', 'pypi')]);
    const text = service.render();
    expect(text).toContain('lsci');
    expect(text).toContain('平台托管');
    expect(text).toContain('conda 1');
    expect(text).toContain('pypi 1');
  });

  it('没有环境时提示去 sync', () => {
    expect(service.render()).toContain('sync');
  });

  it('创建环境时拒绝非法名字与保留名', async () => {
    const bad = await service.create({
      name: 'has space',
      language: 'python',
      conversationId: 'c1',
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('被截断');

    const reserved = await service.create({
      name: 'lsci',
      language: 'python',
      conversationId: 'c1',
    });
    expect(reserved.ok).toBe(false);
    expect(reserved.reason).toContain('托管环境');
  });
});
