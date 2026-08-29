/**
 * conda 与 pip 混装的冲突判定（任务 14.4，需求 15.4）。
 *
 * ## 为什么这条约束值得一整个模块
 *
 * 需求 15.4 说的「避免混用 conda 与 pip 安装同一科学计算依赖，以防版本约束冲突导致
 * 运行时导入失败」，实际发生的事比「版本约束冲突」更具体也更难查：
 *
 * conda 的 numpy 链接 conda 装的 MKL/OpenBLAS（在 `$PREFIX/Library/bin` 或
 * `$PREFIX/lib`）；PyPI 的 numpy wheel **自带一份** OpenBLAS（在
 * `site-packages/numpy.libs`）。两份都在一个进程里被加载时，符号来自哪一份取决于加载
 * 顺序，而结果是三种之一：
 *
 * 1. `ImportError: DLL load failed`（最好的一种，至少报错了）
 * 2. 进程直接崩掉，没有 Python 层的 traceback
 * 3. **算出错误的数值而不报任何错**
 *
 * 第三种是这条需求真正要防的。它在科研场景里的代价不是「程序挂了」，是「结论错了而
 * 没人知道」。
 *
 * ## 判定按「原生库组」而不是按包名
 *
 * 只比对同名包会漏掉最常见的一类：conda 装了 scipy（链接 conda 的 BLAS），然后 pip
 * 装 numpy（自带 BLAS）。两个包名不同，但它们在同一个进程里共用 BLAS——冲突照样成立。
 *
 * 因此下面按共享的原生库分组，组内任意两个包分属不同来源就算冲突。
 */

import type { PackageConflict, PackageRecord, PackageSource } from './types.js';

/** 一组共用同一份原生库的包。 */
export interface NativeGroup {
  id: string;
  label: string;
  /** 共享的原生库。冲突的物理原因。 */
  library: string;
  why: string;
  packages: readonly string[];
}

/**
 * 混装会出事的包组。
 *
 * 只收**链接原生库**的包。纯 Python 包（requests、click、tqdm）混装不会有这个问题，
 * 把它们也列进来只会让这道门在无害的情况下反复挡人，而那会让用户去找绕过它的办法。
 */
export const NATIVE_GROUPS: readonly NativeGroup[] = [
  {
    id: 'blas',
    label: '数值计算栈',
    library: 'BLAS/LAPACK（MKL 或 OpenBLAS）',
    why:
      'conda 的这些包链接环境里那一份 BLAS，而 PyPI 的 wheel 各自带一份 OpenBLAS。' +
      '两份同时被加载时，最坏的结果不是报错，是矩阵运算算出错的数值而完全不报错。',
    packages: [
      'numpy',
      'scipy',
      'pandas',
      'scikit-learn',
      'sklearn',
      'statsmodels',
      'numexpr',
      'bottleneck',
      'mkl',
      'mkl-service',
      'openblas',
      'blas',
      'libblas',
      'liblapack',
    ],
  },
  {
    id: 'hdf5',
    label: 'HDF5 / NetCDF 存储栈',
    library: 'libhdf5',
    why:
      'h5py、tables、netCDF4 都链接 libhdf5。conda 装的是环境里那一份共享库，' +
      'PyPI wheel 自带静态或私有副本。两份 HDF5 在一个进程里会在打开文件时报' +
      '「file is already open for write」这类与实际情况完全无关的错误。',
    packages: ['h5py', 'tables', 'pytables', 'netcdf4', 'netCDF4', 'hdf5', 'libnetcdf', 'zarr'],
  },
  {
    id: 'llvm',
    label: 'JIT 编译栈',
    library: 'LLVM',
    why:
      'numba 与 llvmlite 对 LLVM 的版本要求极窄，而 conda 与 PyPI 两边的 llvmlite ' +
      '编译目标不同。混装的表现是 numba 在第一次 @jit 调用时崩掉，而错误信息指向 LLVM ' +
      '内部符号，看不出与安装来源有关。',
    packages: ['numba', 'llvmlite', 'llvm-openmp', 'libllvm'],
  },
  {
    id: 'arrow',
    label: 'Arrow / Parquet 栈',
    library: 'libarrow',
    why:
      'pyarrow 与 conda 的 libarrow 是分开的两个包；PyPI 的 pyarrow 自带 libarrow。' +
      '混装时 dask/pandas 读 parquet 会报 schema 相关的错，而文件本身没问题。',
    packages: ['pyarrow', 'arrow-cpp', 'libarrow', 'polars'],
  },
  {
    id: 'geo',
    label: '地理空间栈',
    library: 'GEOS / PROJ / GDAL',
    why:
      'shapely、pyproj、fiona、rasterio、geopandas 各自链接 GEOS/PROJ/GDAL。' +
      '这一组是混装事故最多的地方：两份 PROJ 会让坐标转换静默偏移几十米，' +
      '而结果看起来完全正常。',
    packages: [
      'gdal',
      'geopandas',
      'shapely',
      'pyproj',
      'fiona',
      'rasterio',
      'cartopy',
      'geos',
      'proj',
      'libgdal',
    ],
  },
  {
    id: 'cuda',
    label: '深度学习与 CUDA 栈',
    library: 'CUDA runtime / cuDNN',
    why:
      'torch、tensorflow、jax、cupy 都要匹配一份 CUDA runtime。conda 装的是环境里的' +
      'cudatoolkit，PyPI wheel 自带 nvidia-* 子包。两份同时在时表现是' +
      '「找不到 GPU」或在第一次 kernel 启动时崩掉，而 nvidia-smi 看起来一切正常。',
    packages: [
      'torch',
      'pytorch',
      'torchvision',
      'torchaudio',
      'tensorflow',
      'tensorflow-gpu',
      'jax',
      'jaxlib',
      'cupy',
      'cudatoolkit',
      'cudnn',
      'cuda-runtime',
    ],
  },
  {
    id: 'opencv',
    label: '图像处理栈',
    library: 'libopencv / FFmpeg',
    why:
      'opencv 有 conda 版（opencv / py-opencv）与 PyPI 版（opencv-python）两条线，' +
      '而它们的 FFmpeg 编译选项不同。混装时视频读取会静默返回空帧。',
    packages: ['opencv', 'py-opencv', 'opencv-python', 'opencv-contrib-python', 'ffmpeg', 'av'],
  },
  {
    id: 'neuro',
    label: '神经影像与电生理栈',
    library: '依赖上面数值栈与 HDF5',
    why:
      'mne、nibabel、nilearn、dipy 自己是纯 Python，但它们对 numpy/scipy/h5py 的' +
      'ABI 敏感。当数值栈已经混装时，报错会出现在这些包里，而原因在上一层——' +
      '因此把它们一并列进来，让提示指向真正的位置。',
    packages: ['mne', 'nibabel', 'nilearn', 'dipy', 'nitime', 'pybv', 'eeglabio'],
  },
  {
    id: 'qt',
    label: 'Qt 界面栈',
    library: 'Qt',
    why:
      'PyQt/PySide 的 conda 版与 PyPI 版各带一份 Qt 库。混装时会在创建窗口时报' +
      '「could not load the Qt platform plugin」，而两份库都在。',
    packages: ['pyqt', 'pyqt5', 'pyside2', 'pyside6', 'qt', 'qt-main', 'pyqtgraph'],
  },
];

/** 包名归一化：conda 与 PyPI 对同一个包的写法常有差异。 */
export function normalizePackageName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // 去掉版本约束与 extras：`numpy>=1.26`、`torch[cuda]`
      .replace(/\[.*?\]/gu, '')
      .split(/[<>=!~ ,;]/u)[0]!
      // PyPI 把 `_` 与 `.` 都归一成 `-`（PEP 503）
      .replace(/[_.]+/gu, '-')
  );
}

/** 从一条 spec 里取包名。`numpy>=1.26` → `numpy`。 */
export function specName(spec: string): string {
  return normalizePackageName(spec);
}

/** 一个包属于哪些原生库组。可能属于多组（zarr 既在 hdf5 组也可能牵 arrow）。 */
export function groupsOf(packageName: string): readonly NativeGroup[] {
  const name = normalizePackageName(packageName);
  return NATIVE_GROUPS.filter((g) => g.packages.some((p) => normalizePackageName(p) === name));
}

/** 这个包混装会不会出事。 */
export function isNativeSensitive(packageName: string): boolean {
  return groupsOf(packageName).length > 0;
}

/**
 * 检查一次安装请求会不会造成混装（需求 15.4）。
 *
 * `installed` 应当来自**探测**而不是我们自己的安装记录：用户可以在环境里自己跑 pip，
 * 那时我们的记录会漏，而 conda 自己的元数据不会（它把 pip 装的包标成 channel=pypi）。
 *
 * venv 环境传空数组即可——那里只有 pip 一个来源，混装在物理上不可能发生。
 */
export function checkConflicts(input: {
  specs: readonly string[];
  requestedSource: PackageSource;
  installed: readonly PackageRecord[];
}): readonly PackageConflict[] {
  // conda 与 pypi 之外的来源不参与这道检查：CRAN 包不与 Python 的原生库共处一个进程
  if (input.requestedSource !== 'conda' && input.requestedSource !== 'pypi') return [];

  const byName = new Map<string, PackageRecord>();
  for (const record of input.installed) {
    byName.set(normalizePackageName(record.name), record);
  }

  const conflicts: PackageConflict[] = [];
  const seen = new Set<string>();

  for (const spec of input.specs) {
    const name = specName(spec);
    const groups = groupsOf(name);
    if (groups.length === 0) continue;

    for (const group of groups) {
      for (const sibling of group.packages) {
        const key = normalizePackageName(sibling);
        const existing = byName.get(key);
        if (existing === undefined) continue;
        if (existing.source !== 'conda' && existing.source !== 'pypi') continue;
        if (existing.source === input.requestedSource) continue;

        // 同一个包只报一次，哪怕它出现在多个组里
        const dedupeKey = `${name}|${key}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        conflicts.push({
          name: key === name ? name : `${name}（与已装的 ${key} 同属${group.label}）`,
          existingSource: existing.source,
          existingVersion: existing.version,
          requestedSource: input.requestedSource,
          why: `两者共用 ${group.library}。${group.why}`,
          remediation: remediationFor({
            requested: name,
            existing: key,
            existingSource: existing.source,
            requestedSource: input.requestedSource,
            group,
          }),
        });
      }
    }
  }

  return conflicts;
}

/**
 * 解决办法。
 *
 * 三条都给出来，因为哪一条合适取决于用户的处境，而平台无从判断：他可能正需要一个
 * 只有 PyPI 才有的新版本，也可能只是随手装个包。**不替他选**，但把「用同一个来源」
 * 排在最前面——那是唯一不留下混装状态的做法。
 */
function remediationFor(input: {
  requested: string;
  existing: string;
  existingSource: PackageSource;
  requestedSource: PackageSource;
  group: NativeGroup;
}): string {
  const existingLabel = input.existingSource === 'conda' ? 'conda' : 'pip/uv';
  const requestedLabel = input.requestedSource === 'conda' ? 'conda' : 'pip/uv';

  return [
    `1. 改用 ${existingLabel} 装 ${input.requested}（与已有的保持同一来源，推荐）。`,
    `2. 先把这一组已装的包整组换成 ${requestedLabel}——` +
      `不能只换一个，${input.group.label}里的包要么全用 conda 要么全用 pip。`,
    `3. 新建一个干净的环境，在那里只用 ${requestedLabel} 装整套。` +
      '这是最稳的做法，代价是要重装一遍。',
  ].join('\n');
}

/** 把冲突渲染成给人看的文本。 */
export function renderConflicts(conflicts: readonly PackageConflict[]): string {
  if (conflicts.length === 0) return '';
  const lines = [`发现 ${String(conflicts.length)} 处 conda / pip 混装风险（需求 15.4）：`, ''];
  for (const conflict of conflicts) {
    lines.push(`· ${conflict.name}`);
    lines.push(
      `  已装：${conflict.existingSource === 'conda' ? 'conda' : 'PyPI'}` +
        (conflict.existingVersion === null ? '' : ` ${conflict.existingVersion}`) +
        `　这次要用：${conflict.requestedSource === 'conda' ? 'conda' : 'PyPI'}`,
    );
    lines.push(`  ${conflict.why}`);
    lines.push('  怎么办：');
    for (const line of conflict.remediation.split('\n')) lines.push(`    ${line}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 一个 conda 环境里已经存在的混装状态。
 *
 * 与 `checkConflicts` 不同：那个是「这次装会不会造成混装」，这个是「现在已经混着了」。
 * 后者要能查，因为用户最常见的求助是「我的 numpy 导入报 DLL 错误」，而那时混装已经
 * 发生了——挡住下一次安装帮不上他。
 */
export function existingMixups(installed: readonly PackageRecord[]): readonly {
  group: NativeGroup;
  conda: readonly PackageRecord[];
  pypi: readonly PackageRecord[];
}[] {
  const out: {
    group: NativeGroup;
    conda: readonly PackageRecord[];
    pypi: readonly PackageRecord[];
  }[] = [];

  for (const group of NATIVE_GROUPS) {
    const names = new Set(group.packages.map((p) => normalizePackageName(p)));
    const members = installed.filter((r) => names.has(normalizePackageName(r.name)));
    const conda = members.filter((r) => r.source === 'conda');
    const pypi = members.filter((r) => r.source === 'pypi');
    if (conda.length > 0 && pypi.length > 0) out.push({ group, conda, pypi });
  }

  return out;
}

/** 把已存在的混装渲染成排查提示。 */
export function renderMixups(mixups: ReturnType<typeof existingMixups>): string {
  if (mixups.length === 0) return '没有发现 conda / pip 混装。';

  const lines = [
    `发现 ${String(mixups.length)} 组已经混装的原生库栈。`,
    '这不一定立刻报错——最坏的情况是算出错的数值而完全不报错，因此值得处理。',
    '',
  ];
  for (const mixup of mixups) {
    lines.push(`· ${mixup.group.label}（共用 ${mixup.group.library}）`);
    lines.push(`  conda 装的：${mixup.conda.map((r) => r.name).join('、')}`);
    lines.push(`  PyPI 装的：${mixup.pypi.map((r) => r.name).join('、')}`);
    lines.push(`  ${mixup.group.why}`);
    lines.push('');
  }
  lines.push(
    '最稳的处理是新建一个环境，在那里只用一个来源装整套。' +
      '在已经混装的环境里逐个替换很容易只换掉一半，而剩下的那一半照样出事。',
  );
  return lines.join('\n');
}
