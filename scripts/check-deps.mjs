#!/usr/bin/env node
/**
 * 依赖约束检查（任务 10.1，需求 20.1.1、20.1.2）。
 *
 * 约束是：**装依赖不需要现场编译 C/C++**。所有 `.node` 二进制必须来自 prebuilt。
 *
 * 这条约束的价值不是洁癖。本机实测没有 MSVC（`Windows Kits\10\Include` 是空的），
 * 一个需要现场编译的包会让 `npm install` 直接失败，而失败信息通常是一长串
 * node-gyp 的输出，指向「装 Visual Studio Build Tools」——3 到 6 GB 的下载加一次
 * 提权。整个技术选型（koffi 而不是自写 addon、better-sqlite3 的 prebuilt、
 * zeromq 的 prebuilt）都建立在这条约束上，因此它需要被自动检查而不是靠记性。
 *
 * 检查三件事：
 * 1. 每个 `.node` 文件都能被定位到某个包，且该包不含 binding.gyp（即不是现场编译的）
 * 2. 没有包在 install/postinstall 脚本里调 node-gyp
 * 3. `.node` 的架构与当前 Node 的 ABI 匹配（错的 prebuilt 加载时才报错，很晚）
 *
 * 用法：node scripts/check-deps.mjs [--json]
 * 退出码非零表示有违规，可直接接进 CI。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = join(repoRoot, 'node_modules');
const asJson = process.argv.includes('--json');

/**
 * 已知需要现场编译的包名。
 *
 * 这份清单不是用来「允许」它们，而是在发现它们时给出准确的说明——一个开发者
 * 顺手 `npm install some-native-thing` 之后，报错要能立刻告诉他为什么不行、
 * 以及本项目一贯的替代做法是什么。
 */
const KNOWN_COMPILERS = new Map([
  ['node-gyp', '这是编译工具本身，出现在依赖里说明有包要现场编译。'],
  ['node-gyp-build', '它本身只是 prebuilt 加载器，不构成问题——但要确认对应包真带了 prebuilt。'],
  ['ffi-napi', '需要现场编译。本项目用 koffi 替代，它自带 prebuilt。'],
  ['ref-napi', '同 ffi-napi。'],
  ['node-addon-api', '仅头文件，出现在 devDependencies 里通常意味着某个包要编译。'],
  ['nan', '同上，且是更老的 addon 接口。'],
]);

/** 递归找出全部 .node 文件。跳过 .bin 与嵌套的 node_modules 以外的目录。 */
function findNativeBinaries(root) {
  const found = [];
  if (!existsSync(root)) return found;

  const walk = (dir, depth) => {
    // 深度上限防止符号链接成环。真实的包结构不会超过这个深度
    if (depth > 12) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限问题跳过而不是让整个检查失败
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.bin' || entry.name === '.cache') continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        found.push(full);
      }
    }
  };

  walk(root, 0);
  return found;
}

/** 从 .node 文件路径回溯出它属于哪个包。 */
function owningPackage(binaryPath) {
  let dir = dirname(binaryPath);
  while (dir.startsWith(modulesRoot) || dir === modulesRoot) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        // 有些包内部的子目录也有 package.json（只含 type 字段），跳过它们
        if (typeof pkg.name === 'string') return { dir, pkg };
      } catch {
        // 坏的 manifest 继续往上找
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 列出全部已安装包的 manifest。 */
function allPackages() {
  const result = [];
  if (!existsSync(modulesRoot)) return result;

  const scan = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin' || entry.name === '.cache') continue;

      const full = join(dir, entry.name);

      // scope 目录（@foo）本身不是包，往里再走一层
      if (entry.name.startsWith('@')) {
        scan(full, depth + 1);
        continue;
      }

      const manifest = join(full, 'package.json');
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
          if (typeof pkg.name === 'string') result.push({ dir: full, pkg });
        } catch {
          /* 坏 manifest 跳过 */
        }
      }

      // 嵌套的 node_modules
      const nested = join(full, 'node_modules');
      if (existsSync(nested)) scan(nested, depth + 1);
    }
  };

  scan(modulesRoot, 0);
  return result;
}

/**
 * 检查 .node 的 ABI 是否匹配。
 *
 * Node-API（napi）的 prebuilt 跨 Node 版本通用，文件名通常带 `napi` 或
 * `node-api`。非 napi 的 prebuilt 绑定到具体 ABI 版本，文件名带 `node-v137`
 * 这样的标记。错的 ABI 只会在 `require()` 时才报错——那通常发生在用户第一次
 * 跑分析代码的时候，而不是安装时。
 */
function describeBinary(binaryPath) {
  // 必须看完整路径而不是只看文件名。zeromq 把 ABI 编码在目录名里
  // （build/win32/x64/node/msvc-115-Release/addon.node），只看文件名的话
  // 所有条目都会归到「无标记」，这个检查就等于没做
  const full = binaryPath.toLowerCase().split(sep).join('/');
  const abi = process.versions.modules;

  if (/napi|node-api/.test(full)) return { targeted: null, note: 'Node-API，跨版本通用' };

  // 常见的三种标记法
  const tagged = /node-v(\d+)/.exec(full) ?? /(?:msvc|glibc|musl|libc)-(\d+)-/.exec(full) ?? null;

  if (tagged !== null) {
    const target = tagged[1];
    return {
      targeted: target,
      note: target === abi ? `ABI ${target}（匹配）` : `ABI ${target}`,
    };
  }

  // 按平台命名的（win32-x64.node、index.win32-x64-msvc.node）通常是 Node-API
  if (/win32|darwin|linux/.test(full)) {
    return { targeted: null, note: '按平台命名，通常为 Node-API' };
  }

  return { targeted: null, note: '无 ABI 标记' };
}

/**
 * 实际加载项目声明的原生依赖。
 *
 * 这是唯一能真正回答「这台机器上能不能用」的检查。文件名模式匹配只能看出
 * prebuilt 声称支持什么，而 zeromq 这类包会为多个 ABI 各带一份、由加载器
 * 在运行时挑——静态看路径根本判断不出它会挑中哪个、以及那个存不存在。
 *
 * 缺失或不匹配的 prebuilt 只会在 require 时报错，而那通常发生在用户第一次跑
 * 分析代码的时候。把它提前到安装后立刻能跑的检查里，代价只是几百毫秒。
 */
async function checkLoadable() {
  const targets = [
    { name: 'better-sqlite3', why: '应用库与项目库的 SQLite 驱动' },
    { name: 'zeromq', why: 'Jupyter 协议的五个通道' },
    { name: 'koffi', why: 'Windows 作业对象与内核中断事件的 FFI' },
  ];

  const results = [];
  for (const target of targets) {
    try {
      await import(target.name);
      results.push({ ...target, ok: true, error: null });
    } catch (err) {
      results.push({
        ...target,
        ok: false,
        error: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    }
  }
  return results;
}

/**
 * 检查**编译产物**能否真的用上原生能力。
 *
 * 与上面直接 `import('koffi')` 不是一回事，这个区别是踩出来的：koffi 本身一直
 * 加载正常，但 `packages/core` 编译出来的是 ESM，而里面用了裸 `require` 去懒加载
 * 它——ESM 里 `require` 这个标识符不存在，抛出的 ReferenceError 又被降级分支
 * 静默吞掉。于是「koffi 可加载」为真、「平台能用 Job Object 与内核真中断」为假，
 * 而所有只检查前者的手段都显示一切正常。
 *
 * 结论：原生依赖的检查必须落在**产物实际调用它的那条路径**上。
 */
async function checkBuiltCapabilities() {
  const entry = join(repoRoot, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(entry)) return { built: false };

  try {
    const core = await import(pathToFileURL(entry).href);
    const caps = core.nativeCapabilities();
    return {
      built: true,
      ffi: caps.ffi,
      jobObject: caps.jobObject,
      kernelInterrupt: caps.kernelInterrupt,
      reason: caps.ffi ? null : (core.win32UnavailableReason?.() ?? '原因未知'),
    };
  } catch (err) {
    return { built: true, ffi: false, reason: `导入控制平面失败：${err.message}` };
  }
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

const violations = [];
const findings = [];

if (!existsSync(modulesRoot)) {
  process.stdout.write('node_modules 不存在。请先运行 npm install。\n');
  process.exit(1);
}

const packages = allPackages();

/* 1. 有 binding.gyp 的包意味着需要现场编译 */
for (const { dir, pkg } of packages) {
  if (!existsSync(join(dir, 'binding.gyp'))) continue;

  /*
   * 有 binding.gyp 不必然意味着它在本机编译过——很多包同时提供 prebuilt 与
   * 源码回退。判定依据是：该包目录下是否有 build/Release，那是 node-gyp 的
   * 输出目录。有它才说明真的在本机编译了。
   */
  const compiled = existsSync(join(dir, 'build', 'Release'));
  findings.push({
    kind: 'has-binding-gyp',
    package: pkg.name,
    path: relative(repoRoot, dir),
    compiledLocally: compiled,
  });

  if (compiled) {
    violations.push({
      kind: 'compiled-locally',
      package: pkg.name,
      detail:
        `${pkg.name} 在本机编译过（存在 build/Release）。这违反「装依赖不需要 C 工具链」` +
        '的约束——在没有 MSVC 的机器上 npm install 会直接失败。请换用提供 prebuilt 的替代品。',
    });
  }
}

/* 2. install / postinstall 里调 node-gyp */
for (const { pkg } of packages) {
  const scripts = pkg.scripts ?? {};
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    const script = scripts[hook];
    if (typeof script !== 'string') continue;
    // node-gyp-build 是 prebuilt 加载器，不是编译器，要排除掉
    if (/\bnode-gyp\b(?!-build)/.test(script) || /\bcmake-js\b/.test(script)) {
      violations.push({
        kind: 'gyp-in-install',
        package: pkg.name,
        detail: `${pkg.name} 的 ${hook} 脚本调用编译器：${script}`,
      });
    }
  }
}

/* 3. 已知的现场编译包 */
for (const { pkg } of packages) {
  const note = KNOWN_COMPILERS.get(pkg.name);
  if (note === undefined) continue;
  findings.push({ kind: 'known-native-tool', package: pkg.name, note });

  // node-gyp-build 与 node-addon-api 本身不构成违规，只作为线索记录
  if (pkg.name === 'ffi-napi' || pkg.name === 'ref-napi' || pkg.name === 'nan') {
    violations.push({ kind: 'known-compiler', package: pkg.name, detail: note });
  }
}

/* 4. 每个 .node 的归属与 ABI */
const binaries = findNativeBinaries(modulesRoot);
const byPackage = new Map();

for (const binary of binaries) {
  const owner = owningPackage(binary);
  const abi = describeBinary(binary);
  const rel = relative(repoRoot, binary);

  if (owner === null) {
    violations.push({
      kind: 'orphan-binary',
      package: '(未知)',
      detail: `无法确定 ${rel} 属于哪个包。来源不明的原生二进制不应出现在依赖里。`,
    });
    continue;
  }

  const list = byPackage.get(owner.pkg.name) ?? [];
  list.push({ path: rel, abi: abi.note, sizeKb: Math.round(statSync(binary).size / 1024) });
  byPackage.set(owner.pkg.name, list);
}

/*
 * 5. 实际加载。
 *
 * 不把「ABI 不匹配」当静态违规：一个包为多个 ABI 各带一份 prebuilt 是正常的
 * （zeromq 就是），静态看路径判断不出加载器会挑中哪个。能不能用只有真加载
 * 才知道，而这一步的结果才是权威的。
 */
const loadResults = await checkLoadable();
for (const result of loadResults) {
  if (!result.ok) {
    violations.push({
      kind: 'load-failed',
      package: result.name,
      detail:
        `${result.name} 无法加载（${result.why}）：${result.error ?? '未知错误'}\n` +
        '    这通常意味着当前 Node 版本没有对应的 prebuilt。检查该包是否支持 ' +
        `ABI ${process.versions.modules}。`,
    });
  }
}

/* 6. 编译产物里原生能力是否真的可用 */
const builtCaps = await checkBuiltCapabilities();
if (builtCaps.built && process.platform === 'win32' && builtCaps.ffi !== true) {
  violations.push({
    kind: 'capability-degraded',
    package: '@l-science/core (dist)',
    detail:
      `编译产物报告原生 API 不可用：${builtCaps.reason ?? '原因未知'}\n` +
      '    koffi 本身能加载，说明问题在产物调用它的那条路径上，而不是依赖缺失。\n' +
      '    后果：资源限额退化为轮询（存在超限窗口），内核中断退化为重启（丢失内存状态）。',
  });
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: violations.length === 0,
        node: process.version,
        abi: process.versions.modules,
        platform: `${process.platform}-${process.arch}`,
        nativePackages: [...byPackage.entries()].map(([name, files]) => ({ name, files })),
        loadable: loadResults,
        builtCapabilities: builtCaps,
        findings,
        violations,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(violations.length === 0 ? 0 : 1);
}

process.stdout.write(
  `依赖约束检查\n` +
    `Node ${process.version}（ABI ${process.versions.modules}）· ${process.platform}-${process.arch}\n\n`,
);

process.stdout.write(
  `原生二进制（${String(binaries.length)} 个，来自 ${String(byPackage.size)} 个包）\n`,
);
if (byPackage.size === 0) {
  process.stdout.write('  没有 .node 文件。\n');
}
for (const [name, files] of [...byPackage.entries()].sort()) {
  process.stdout.write(`  ${name}\n`);
  for (const file of files) {
    process.stdout.write(`    ${file.path}  ${String(file.sizeKb)} KB  ${file.abi}\n`);
  }
}

const gypPackages = findings.filter((f) => f.kind === 'has-binding-gyp');
if (gypPackages.length > 0) {
  process.stdout.write(`\n带 binding.gyp 的包（${String(gypPackages.length)} 个）\n`);
  for (const f of gypPackages) {
    // 区分「带源码但用了 prebuilt」与「真的在本机编译了」——前者完全正常，
    // 多数原生包都同时提供两条路
    process.stdout.write(
      `  ${f.package}：${f.compiledLocally ? '在本机编译过（违规）' : '未在本机编译，用的是 prebuilt'}\n`,
    );
  }
}

// 实际加载的结果是权威信号，单独列出
process.stdout.write('\n实际加载检查\n');
for (const result of loadResults) {
  process.stdout.write(
    `  ${result.ok ? 'OK  ' : 'FAIL'} ${result.name.padEnd(16)} ${result.ok ? result.why : (result.error ?? '')}\n`,
  );
}

process.stdout.write('\n编译产物的原生能力\n');
if (!builtCaps.built) {
  process.stdout.write('  跳过  控制平面尚未构建（npm run build 后再查）\n');
} else if (builtCaps.ffi === true) {
  process.stdout.write('  OK    Job Object 硬限额 + 内核真中断均可用\n');
} else {
  process.stdout.write(`  FAIL  ${builtCaps.reason ?? '原因未知'}\n`);
}

if (violations.length === 0) {
  process.stdout.write(
    '\n结果：通过。所有原生依赖均来自 prebuilt 且能在当前 Node 上加载，\n' +
      '安装不需要 C/C++ 工具链。\n',
  );
  process.exit(0);
}

process.stdout.write(`\n发现 ${String(violations.length)} 项违规：\n`);
for (const v of violations) {
  process.stdout.write(`  [${v.kind}] ${v.package}\n    ${v.detail}\n`);
}
process.stdout.write(
  '\n本项目刻意不依赖现场编译——实测本机没有 MSVC，一个需要编译的包会让\n' +
    'npm install 直接失败，而修复代价是 3-6 GB 的 Build Tools 加一次提权。\n' +
    '需要原生能力时优先找自带 prebuilt 的方案（例如用 koffi 做 FFI 而不是写 addon）。\n',
);
process.exit(1);
