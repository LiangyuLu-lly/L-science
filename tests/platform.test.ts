/**
 * 平台抽象层测试（任务 15.1，需求 20.4.1）。
 *
 * 这个文件测的不只是「适配器返回了什么」，还有一条**约定**：`process.platform` 不得
 * 散在业务代码里。那条约定没有编译期保障——写一句 `process.platform === 'win32'` 永远
 * 能通过类型检查——因此这里用源码扫描来守。它挡的不是笔误，是抽象层被绕过之后重新
 * 退化成十几处散落判断的那个过程。
 *
 * 另一组用例断言两个适配器的行为**互不相同**。只有一个实现的接口会长出 Windows 专属
 * 的形状，而形状泄漏不会以报错的形式出现——它的表现是移植时才发现某个方法返回的是一条
 * `taskkill` 命令串。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_DIR_NAME,
  CAPABILITY,
  KNOWN_PLATFORMS,
  PathGuard,
  adapterFor,
  collectEnvDoctorBlockers,
  darwinAdapter,
  dataDir,
  defaultLocalShell,
  defaultStdioAllowList,
  describePlatform,
  detectCapabilities,
  findPowerShell,
  isWindows,
  linuxAdapter,
  platform,
  platformGaps,
  resetCapabilityCache,
  setPlatformAdapter,
  windowsAdapter,
  withUtf8Preamble,
} from '@l-science/core';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

afterEach(() => {
  // 忘了恢复的话之后所有测试都跑在错误的平台假设下，而那种失败看起来与被测代码无关
  setPlatformAdapter(null);
});

/* ------------------------------------------------------------------ *
 * 路径组
 * ------------------------------------------------------------------ */

describe('路径', () => {
  it('三个平台的数据目录各按自己的约定，互不相同', () => {
    const win = windowsAdapter.defaultDataDir(APP_DIR_NAME);
    const linux = linuxAdapter.defaultDataDir(APP_DIR_NAME);
    const mac = darwinAdapter.defaultDataDir(APP_DIR_NAME);

    expect(new Set([win, linux, mac]).size).toBe(3);
    // macOS 的约定位置。混成 ~/.l-science 能跑，但那目录不会被 Time Machine
    // 按应用数据处理，而用户以为它被备份了
    expect(mac).toBe(join(homedir(), 'Library', 'Application Support', APP_DIR_NAME));
    for (const p of [win, linux, mac]) expect(p.endsWith(APP_DIR_NAME)).toBe(true);
  });

  it('Windows 用 %LOCALAPPDATA%，缺失时仍落在 AppData\\Local 而不是家目录点文件', () => {
    const saved = process.env['LOCALAPPDATA'];
    try {
      process.env['LOCALAPPDATA'] = join('D:', 'appdata');
      expect(windowsAdapter.defaultDataDir('X')).toBe(join('D:', 'appdata', 'X'));

      delete process.env['LOCALAPPDATA'];
      // 兜底也留在 Windows 的约定位置：否则同一台机器上两种启动方式会用两个
      // 不同的数据目录，而那时用户看到的是「我的项目不见了」
      expect(windowsAdapter.defaultDataDir('X')).toBe(join(homedir(), 'AppData', 'Local', 'X'));
    } finally {
      if (saved === undefined) delete process.env['LOCALAPPDATA'];
      else process.env['LOCALAPPDATA'] = saved;
    }
  });

  it('Linux 遵守 XDG_DATA_HOME，未设时用规范给的默认值', () => {
    const saved = process.env['XDG_DATA_HOME'];
    try {
      process.env['XDG_DATA_HOME'] = '/custom/share';
      expect(linuxAdapter.defaultDataDir('X')).toBe(join('/custom/share', 'X'));

      delete process.env['XDG_DATA_HOME'];
      expect(linuxAdapter.defaultDataDir('X')).toBe(join(homedir(), '.local', 'share', 'X'));
    } finally {
      if (saved === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = saved;
    }
  });

  it('大小写敏感性按平台不同，且 macOS 取保守的一侧', () => {
    expect(windowsAdapter.pathsCaseSensitive).toBe(false);
    expect(linuxAdapter.pathsCaseSensitive).toBe(true);
    /*
     * 严格说默认的 APFS 卷不区分大小写。这里报「区分」是刻意的：按不区分处理会让一条
     * 对 /data 的授权放过 /Data，而按区分处理只是多问一次授权。两个方向的代价不对称。
     */
    expect(darwinAdapter.pathsCaseSensitive).toBe(true);
  });

  it('比较用的归一化：Windows 折叠大小写与斜杠方向，POSIX 只去尾斜杠', () => {
    expect(windowsAdapter.normalizeForCompare('D:\\Data\\Sub\\')).toBe('d:/data/sub');
    expect(windowsAdapter.normalizeForCompare('D:/Data/Sub')).toBe('d:/data/sub');
    // 两种写法必须归一到同一个串，否则路径授权检查会放过一个已被拒绝的路径
    expect(windowsAdapter.normalizeForCompare('D:\\Data')).toBe(
      windowsAdapter.normalizeForCompare('d:/data/'),
    );

    expect(linuxAdapter.normalizeForCompare('/data/Sub/')).toBe('/data/Sub');
    expect(linuxAdapter.normalizeForCompare('/data/sub')).not.toBe(
      linuxAdapter.normalizeForCompare('/data/Sub'),
    );
  });

  it('可执行文件的位置与扩展名按平台不同', () => {
    // conda 环境的 python 直接在 prefix 根上，venv 的在 Scripts 下
    expect(windowsAdapter.binDirs).toEqual(['', 'Scripts']);
    expect(linuxAdapter.binDirs).toEqual(['bin']);
    expect(windowsAdapter.executableExtensions).toContain('.exe');
    expect(linuxAdapter.executableExtensions).toEqual(['']);
  });
});

/* ------------------------------------------------------------------ *
 * shell 组
 * ------------------------------------------------------------------ */

describe('shell', () => {
  it('PowerShell 调用走 -EncodedCommand，且带完整的 UTF-8 前导', () => {
    const invocation = windowsAdapter.shellInvocation({
      family: 'powershell',
      command: 'echo 中文',
    });
    expect(invocation).not.toBeNull();
    expect(invocation?.encoded).toBe(true);
    expect(invocation?.args).toContain('-NoProfile');
    expect(invocation?.args).toContain('-NonInteractive');

    const idx = (invocation?.args ?? []).indexOf('-EncodedCommand');
    expect(idx).toBeGreaterThanOrEqual(0);
    const payload = invocation?.args[idx + 1] ?? '';
    const decoded = Buffer.from(payload, 'base64').toString('utf16le');

    // 命令原样进去
    expect(decoded).toContain('echo 中文');
    /*
     * 两条前导都要在。$OutputEncoding 管 PowerShell 传给原生命令的编码，
     * [Console]::OutputEncoding 管读原生命令输出与写自身输出的编码。少一条的表现
     * 是中文输出乱码——对一个中文平台来说这是必然会撞上的问题。
     */
    expect(decoded).toContain('$OutputEncoding');
    expect(decoded).toContain('[Console]::OutputEncoding');
    expect(decoded).toContain('UTF8');
    expect(decoded).toBe(withUtf8Preamble('echo 中文'));
  });

  it('Windows 上的 posix shell 经 wsl.exe，不编码', () => {
    const invocation = windowsAdapter.shellInvocation({ family: 'posix', command: 'ls -l' });
    expect(invocation?.command).toBe('wsl.exe');
    expect(invocation?.args).toContain('bash');
    expect(invocation?.encoded).toBe(false);
  });

  it('POSIX 起不了 PowerShell 时返回 null，而不是拼一条注定失败的命令', () => {
    expect(linuxAdapter.shellInvocation({ family: 'powershell', command: 'echo hi' })).toBeNull();
    expect(darwinAdapter.shellInvocation({ family: 'powershell', command: 'echo hi' })).toBeNull();
    expect(linuxAdapter.supportsShell('powershell')).toBe(false);
    expect(windowsAdapter.supportsShell('powershell')).toBe(true);
  });

  it('POSIX 用 /bin/sh -lc', () => {
    const invocation = linuxAdapter.shellInvocation({ family: 'posix', command: 'echo hi' });
    // /bin/sh 一定存在（Alpine 没 bash）；-l 让 conda 的初始化生效，而那是环境管理的主要路径
    expect(invocation?.command).toBe('/bin/sh');
    expect(invocation?.args).toEqual(['-lc', 'echo hi']);
    expect(invocation?.encoded).toBe(false);
  });

  it('默认 shell 与查可执行文件的命令都按平台不同', () => {
    expect(windowsAdapter.defaultShell).toBe('powershell');
    expect(linuxAdapter.defaultShell).toBe('posix');
    expect(windowsAdapter.whichCommand('python')).toEqual({
      command: 'where',
      args: ['python'],
    });
    expect(linuxAdapter.whichCommand('python')).toEqual({
      command: 'which',
      args: ['python'],
    });
  });

  it('findPowerShell 给出一个具体可执行文件', () => {
    const exe = findPowerShell();
    expect(exe.length).toBeGreaterThan(0);
    expect(/powershell\.exe$|pwsh\.exe$/i.test(exe)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 进程组
 * ------------------------------------------------------------------ */

describe('进程', () => {
  it('进程组策略相反：Windows 不建组，POSIX 建组', () => {
    // Windows 上整组终止由 Job Object 兜住；建组反而会让 taskkill /T 的父子关系失效
    expect(windowsAdapter.detachChildren).toBe(false);
    // POSIX 上建组才能整组终止
    expect(linuxAdapter.detachChildren).toBe(true);
  });

  it('进程树终止：Windows 用 taskkill 且没有信号兜底，POSIX 用 pkill 且有', () => {
    const win = windowsAdapter.killTree(4321);
    expect(win.command).toBe('taskkill');
    expect(win.args).toEqual(['/PID', '4321', '/T', '/F']);
    // Windows 没有进程组信号，因此没有退路可给
    expect(win.signalFallback).toBeNull();

    const posix = linuxAdapter.killTree(4321);
    expect(posix.command).toBe('pkill');
    expect(posix.args).toEqual(['-KILL', '-g', '4321']);
    // pkill 在极简容器里可能不存在，那时要退回向进程组发信号
    expect(posix.signalFallback).toEqual({ negatePid: true, signal: 'SIGKILL' });
  });

  it('内存探测的命令与解析成对给出，且解析结果是 MB', () => {
    const win = windowsAdapter.memoryProbe(4321);
    expect(win?.command).toBe('tasklist');
    // CSV 最后一列是 `"12,345 K"`
    expect(win?.parse('"node.exe","4321","Console","1","204,800 K"\r\n')).toBe(200);
    expect(win?.parse('信息: 没有运行的任务匹配指定标准。')).toBeNull();

    const posix = linuxAdapter.memoryProbe(4321);
    expect(posix?.command).toBe('ps');
    expect(posix?.parse('  204800\n')).toBe(200);
    expect(posix?.parse('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 环境组
 * ------------------------------------------------------------------ */

describe('环境', () => {
  it('PATH 分隔符与主目录变量按平台不同', () => {
    expect(windowsAdapter.pathSeparator).toBe(';');
    expect(linuxAdapter.pathSeparator).toBe(':');
    expect(windowsAdapter.homeEnvVars).toContain('USERPROFILE');
    expect(linuxAdapter.homeEnvVars).toEqual(['HOME']);
  });

  it('MCP stdio 的放行白名单从适配器取主目录变量', () => {
    setPlatformAdapter(windowsAdapter);
    const win = defaultStdioAllowList();
    expect(win).toContain('USERPROFILE');
    // HOMEDRIVE/HOMEPATH 也要放：少放一个的表现是连接器读不到自己的配置，
    // 然后报一个与环境变量毫无关系的错
    expect(win).toContain('HOMEDRIVE');
    expect(win).toContain('HOMEPATH');
    expect(win).toContain('PATH');

    setPlatformAdapter(linuxAdapter);
    const linux = defaultStdioAllowList();
    expect(linux).toContain('HOME');
    expect(linux).not.toContain('USERPROFILE');
    expect(linux).toContain('PATH');
  });

  it('白名单里始终不含特权凭据与代理地址', () => {
    // 一个第三方连接器进程拿到 L_SCIENCE_HOST_TOKEN 等于绕过平台的全部管控
    for (const adapter of [windowsAdapter, linuxAdapter, darwinAdapter]) {
      setPlatformAdapter(adapter);
      const allow = defaultStdioAllowList();
      for (const forbidden of [
        'L_SCIENCE_HOST_TOKEN',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'L_SCIENCE_DATA_DIR',
      ]) {
        expect(allow).not.toContain(forbidden);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 缺口清单
 * ------------------------------------------------------------------ */

describe('平台缺口', () => {
  it('Windows 是权威实现，缺口为空', () => {
    expect(windowsAdapter.gaps).toEqual([]);
  });

  it('POSIX 缺口非空，且每条都说清降级后的实际行为', () => {
    expect(linuxAdapter.gaps.length).toBeGreaterThanOrEqual(4);

    for (const gap of [...linuxAdapter.gaps, ...darwinAdapter.gaps]) {
      expect(gap.id).toMatch(/^[a-z][a-z0-9-]*$/u);
      expect(gap.what.length).toBeGreaterThan(4);
      /*
       * consequence 必须具体。「不支持」是没有信息量的——用户需要知道的是
       * 「那我现在得到的是什么」。用长度当代理指标不完美，但它能挡住把一条真实的
       * 降级说明改成一句「暂不支持」的那种退化。
       */
      expect(gap.consequence.length).toBeGreaterThan(30);
      expect(gap.consequence).not.toMatch(/^(暂?不支持|未实现|TODO)。?$/u);
      if (gap.plan !== null) expect(gap.plan.length).toBeGreaterThan(10);
    }
  });

  it('缺口 id 在同一个适配器内不重复', () => {
    for (const adapter of [linuxAdapter, darwinAdapter]) {
      const ids = adapter.gaps.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('凭据库的缺口说明必须点明「拒绝存」而不是「明文存」', () => {
    const gap = linuxAdapter.gaps.find((g) => g.id === 'credential-vault');
    expect(gap).toBeDefined();
    // 明文落盘比不落盘更糟，因为用户会以为它被保护着。这条语义不能在改写中丢掉
    expect(gap?.consequence).toContain('拒绝存');
  });

  it('macOS 的缺口是 Linux 的超集', () => {
    const linuxIds = linuxAdapter.gaps.map((g) => g.id);
    const macIds = darwinAdapter.gaps.map((g) => g.id);
    for (const id of linuxIds) expect(macIds).toContain(id);
    expect(macIds).toContain('data-dir-convention');
  });

  it('describePlatform 在 Windows 上说全部可用，在 POSIX 上逐条列出', () => {
    setPlatformAdapter(windowsAdapter);
    const win = describePlatform();
    expect(win).toContain('Windows');
    expect(win).toContain('全部平台能力可用');

    setPlatformAdapter(linuxAdapter);
    const linux = describePlatform();
    expect(linux).toContain('Linux');
    for (const gap of linuxAdapter.gaps) {
      expect(linux).toContain(gap.id);
      expect(linux).toContain(gap.consequence);
    }
    expect(linux).toContain('实际行为');
    expect(linux).toContain('补齐方式');
  });
});

/* ------------------------------------------------------------------ *
 * 当前平台与适配器替换
 * ------------------------------------------------------------------ */

describe('适配器选择', () => {
  it('本机解析到 Windows 适配器', () => {
    expect(platform().id).toBe('win32');
    expect(isWindows()).toBe(true);
    expect(platformGaps()).toEqual([]);
    expect(KNOWN_PLATFORMS).toEqual(['win32', 'linux', 'darwin']);
    expect(adapterFor('linux')).toBe(linuxAdapter);
    expect(adapterFor('darwin')).toBe(darwinAdapter);
  });

  it('替换适配器后，依赖平台的调用方全部跟着变', () => {
    const savedOverride = process.env['L_SCIENCE_DATA_DIR'];
    delete process.env['L_SCIENCE_DATA_DIR'];
    try {
      setPlatformAdapter(windowsAdapter);
      const winDataDir = dataDir();
      expect(defaultLocalShell()).toBe('powershell');
      expect(platform().whichCommand('python').command).toBe('where');
      expect(platform().killTree(1).command).toBe('taskkill');

      setPlatformAdapter(linuxAdapter);
      // 数据目录、shell、查找命令、进程终止四条都换了实现——这正是抽象层存在的意义
      expect(dataDir()).not.toBe(winDataDir);
      expect(dataDir()).toBe(linuxAdapter.defaultDataDir(APP_DIR_NAME));
      expect(defaultLocalShell()).toBe('bash');
      expect(platform().whichCommand('python').command).toBe('which');
      expect(platform().killTree(1).command).toBe('pkill');
      expect(isWindows()).toBe(false);
      expect(platformGaps().length).toBeGreaterThan(0);
    } finally {
      if (savedOverride === undefined) delete process.env['L_SCIENCE_DATA_DIR'];
      else process.env['L_SCIENCE_DATA_DIR'] = savedOverride;
    }
  });

  it('数据目录的环境变量覆盖优先于适配器', () => {
    const saved = process.env['L_SCIENCE_DATA_DIR'];
    try {
      process.env['L_SCIENCE_DATA_DIR'] = join(tmpdir(), 'lsci-override');
      setPlatformAdapter(linuxAdapter);
      // 多实例并行与测试都靠这个逃生口，它不能被平台默认值盖掉
      expect(dataDir()).toBe(join(tmpdir(), 'lsci-override'));
    } finally {
      if (saved === undefined) delete process.env['L_SCIENCE_DATA_DIR'];
      else process.env['L_SCIENCE_DATA_DIR'] = saved;
    }
  });

  it('PowerShell 能力判定跟着适配器走，而不是跟着本机平台', () => {
    try {
      setPlatformAdapter(linuxAdapter);
      resetCapabilityCache();
      const linux = detectCapabilities({
        id: 'native',
        isolation: {
          backend: 'native',
          filesystem: 'advisory',
          network: 'none',
          process: 'none',
          caveats: [],
        },
      } as never);
      expect(linux.available.has('shell:powershell')).toBe(false);

      setPlatformAdapter(windowsAdapter);
      resetCapabilityCache();
      const win = detectCapabilities({
        id: 'native',
        isolation: {
          backend: 'native',
          filesystem: 'advisory',
          network: 'none',
          process: 'none',
          caveats: [],
        },
      } as never);
      expect(win.available.has('shell:powershell')).toBe(true);
    } finally {
      resetCapabilityCache();
    }
  });
});

/* ------------------------------------------------------------------ *
 * env.doctor compact blockers
 * ------------------------------------------------------------------ */

describe('env.doctor blockers', () => {
  it('env.doctor blockers include koffi when ffi load failed', () => {
    // Given: koffi 加载失败；Python 内核仍在，避免和 lsci blocker 搅在一起
    const snapshot = {
      available: new Set([CAPABILITY.filesystem, CAPABILITY.kernelPython]),
      pythonEnv: 'lsci',
      rEnv: null,
    };

    // When
    const blockers = collectEnvDoctorBlockers(
      snapshot,
      '加载 koffi 失败：Error: Cannot find module',
    );

    // Then: id 是契约字段；what/consequence/command 必须都在
    const koffi = blockers.find((b) => b.id === 'koffi');
    expect(koffi).toBeDefined();
    expect(koffi).toEqual(
      expect.objectContaining({
        id: 'koffi',
        what: expect.any(String),
        consequence: expect.any(String),
        command: expect.any(String),
      }),
    );
  });

  it('env.doctor blockers include lsci when python kernel missing', () => {
    // Given: 探测不到 Python 内核（lsci / ipykernel）；FFI 正常
    const snapshot = {
      available: new Set([CAPABILITY.filesystem]),
      pythonEnv: null,
      rEnv: null,
    };

    // When
    const blockers = collectEnvDoctorBlockers(snapshot, null);

    // Then
    const lsci = blockers.find((b) => b.id === 'lsci');
    expect(lsci).toBeDefined();
    expect(lsci?.command).toContain('conda create -n lsci');
    expect(lsci).toEqual(
      expect.objectContaining({
        id: 'lsci',
        what: expect.any(String),
        consequence: expect.any(String),
        command: expect.any(String),
      }),
    );
  });

  it('numba/numpy 不兼容时先指一键安装再给 conda 命令', () => {
    // Given: Python 内核在，但 numba 0.60 撑不住 numpy 2.2
    const snapshot = {
      available: new Set([CAPABILITY.filesystem, CAPABILITY.kernelPython]),
      pythonEnv: 'lsci',
      rEnv: null,
    };

    // When
    const blockers = collectEnvDoctorBlockers(snapshot, null, {
      numba: '0.60.0',
      numpy: '2.2.0',
    });

    // Then: 阻塞项带上已装版本对；一键安装在 conda 之前
    const numba = blockers.find((b) => b.id === 'numba-numpy');
    expect(numba).toBeDefined();
    const combined = `${numba?.consequence ?? ''}\n${numba?.command ?? ''}`;
    expect(combined).toContain('0.60.0');
    expect(combined).toContain('2.2.0');
    const ctaAt = combined.indexOf('一键安装');
    const condaAt = combined.indexOf('conda');
    expect(ctaAt).toBeGreaterThan(-1);
    expect(condaAt).toBeGreaterThan(-1);
    expect(ctaAt).toBeLessThan(condaAt);
  });
});

/* ------------------------------------------------------------------ *
 * 路径守卫跟着适配器走
 * ------------------------------------------------------------------ */

describe('路径守卫的大小写判定', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-plat-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('默认取自适配器：Windows 上大小写不同视为同一路径', () => {
    setPlatformAdapter(windowsAdapter);
    const guard = new PathGuard({ roots: [workspace] });
    const upper = join(workspace.toUpperCase(), 'a.txt');
    expect(guard.check(upper, 'read').allowed).toBe(true);
  });

  it('切到 POSIX 适配器后同一路径按区分大小写判定', () => {
    setPlatformAdapter(linuxAdapter);
    const guard = new PathGuard({ roots: [workspace] });
    const upper = join(workspace.toUpperCase(), 'a.txt');
    const decision = guard.check(upper, 'read');
    // 这条断言的意义不在于「在 Windows 上拒绝大写路径」，而在于确认这个判定确实
    // 由适配器决定——它以前是一句写死的 process.platform !== 'win32'
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside-allowed-roots');

    // 原样大小写仍然放行，说明拒绝的原因是大小写而不是根本没匹配上
    expect(guard.check(join(workspace, 'a.txt'), 'read').allowed).toBe(true);
  });

  it('显式传入 caseSensitive 时不看适配器', () => {
    setPlatformAdapter(linuxAdapter);
    const guard = new PathGuard({ roots: [workspace], caseSensitive: false });
    expect(guard.check(join(workspace.toUpperCase(), 'a.txt'), 'read').allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 约定守卫：process.platform 不得散落
 * ------------------------------------------------------------------ */

/**
 * 允许直接读 `process.platform` 的文件。
 *
 * 前三项判的正是「这个平台有没有这套 API」——绕一层抽象只会让它们更绕，而且抽象层
 * 自己也要靠它们回答 `gaps`。后两项在 core 之外，各有具体理由写在下面。
 */
const ALLOWED = [
  // 平台层自己：这里是那句判断该待的地方。windows.ts 刻意不在清单里——
  // win32 适配器没有理由再判一次自己在哪个平台
  'packages/core/src/platform/index.ts',
  'packages/core/src/platform/types.ts',
  'packages/core/src/platform/posix.ts',
  // FFI / DPAPI 加载：判的是「这个平台有没有这套 API」
  'packages/core/src/win32/ffi.ts',
  'packages/core/src/win32/index.ts',
  'packages/core/src/credentials/dpapi.ts',
  // Electron 主进程的窗口生命周期：macOS 上关掉最后一个窗口不退出应用，
  // 这是平台的 UI 约定而不是能力差异，不属于适配器的四组任何一组
  'packages/shell/src/main.ts',
  // R 环境布局：Windows 上真正的可执行文件在 bin/x64 下，bin/R.exe 与 Scripts/R.exe
  // 都起不来。这是 conda 打包 R 的方式，不是平台能力
  'packages/kernel/src/launch.ts',
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      const rel = join('packages', pkg, 'src', entry);
      const abs = join(REPO_ROOT, rel);
      if (!/\.(ts|tsx)$/u.test(entry)) continue;
      if (/\.test\.tsx?$/u.test(entry)) continue;
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      out.push(rel.split(sep).join('/'));
    }
  }
  return out;
}

describe('process.platform 的分布', () => {
  it('只出现在允许清单里的文件中', () => {
    const files = sourceFiles();
    // 扫描本身要能扫到东西，否则这个用例会在遍历逻辑写错时静默通过
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const rel of files) {
      if (ALLOWED.includes(rel)) continue;
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (!text.includes('process.platform')) continue;
      const lines = text
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => line.includes('process.platform'));
      for (const { line, no } of lines) offenders.push(`${rel}:${String(no)}  ${line}`);
    }

    expect(
      offenders,
      '改用 platform() / isWindows()。散开之后「移植到 Linux 还差什么」' +
        '就只能靠把每一处逐个读一遍来回答，而漏掉一处的表现不是编译失败，' +
        '是在那个平台上某个功能静默走错分支。确有必要时把文件加进 ALLOWED 并写明理由。',
    ).toEqual([]);
  });

  it('允许清单里没有已经不存在或已经清理干净的条目', () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      // 清单是白名单，留着过期条目会让它慢慢失去约束力
      expect(text, `${rel} 已不含 process.platform，应从 ALLOWED 移除`).toContain(
        'process.platform',
      );
    }
  });

  it('业务代码里没有写死的平台 shell 三元与路径分隔符三元', () => {
    const suspicious: string[] = [];
    for (const rel of sourceFiles()) {
      if (ALLOWED.includes(rel)) continue;
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      // 这两种写法是抽象层被绕过的典型形态：它们能编译、能跑、且只在另一个平台上错
      if (/=== *'win32'/u.test(text)) suspicious.push(`${rel}（=== 'win32'）`);
      if (/!== *'win32'/u.test(text)) suspicious.push(`${rel}（!== 'win32'）`);
    }
    expect(suspicious).toEqual([]);
  });
});
