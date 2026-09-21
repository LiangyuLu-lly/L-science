/**
 * numba 与 numpy 的版本门（需求 2.7）。
 *
 * 只根据已探测到的版本字符串做判定，不访问 Python。表会在 numba / numpy
 * 发新版后过期；未收录的 numba 版本不做兼容判定。
 *
 * 约束来自 Numba 官方 Version support information（不是「能 import 就算兼容」）：
 * https://numba.readthedocs.io/en/stable/user/installing.html#version-support-information
 *
 * 各行 release notes：
 * 0.67 https://numba.readthedocs.io/en/stable/release/0.67.0-notes.html
 * 0.66 https://numba.readthedocs.io/en/stable/release/0.66.0-notes.html
 * 0.65 https://numba.readthedocs.io/en/stable/release/0.65.0-notes.html
 * 0.64 https://numba.readthedocs.io/en/stable/release/0.64.0-notes.html
 * 0.63 https://numba.readthedocs.io/en/stable/release/0.63.0-notes.html
 * 0.62 https://numba.readthedocs.io/en/stable/release/0.62.0-notes.html
 * 0.61 https://numba.readthedocs.io/en/stable/release/0.61.0-notes.html
 * 0.60 https://numba.readthedocs.io/en/stable/release/0.60.0-notes.html
 * 0.59 https://numba.readthedocs.io/en/stable/release/0.59.0-notes.html
 * 0.58 https://numba.readthedocs.io/en/stable/release/0.58.0-notes.html
 * 0.57 https://numba.readthedocs.io/en/stable/release/0.57.0-notes.html
 *
 * scripts/doctor.mjs 从本模块的 dist 引用同一张表，不要在那边再抄一份。
 */

export type VersionTriple = readonly [major: number, minor: number, patch: number];

export type NumpyInterval = {
  readonly minInclusive: VersionTriple;
  readonly maxExclusive: VersionTriple;
};

export type NumbaNumpyConstraint = {
  /** `0.62` 覆盖该次版本全部补丁；`0.61.2` 只覆盖这一补丁。 */
  readonly numba: string;
  readonly numpy: readonly NumpyInterval[];
};

export type NumbaNumpyVerdict =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly numba: string; readonly numpy: string | null }
  | { readonly kind: 'compatible'; readonly numba: string; readonly numpy: string }
  | {
      readonly kind: 'incompatible';
      readonly numba: string;
      readonly numpy: string | null;
      readonly reason: 'numpy-too-new' | 'numpy-too-old' | 'numpy-absent';
      readonly pinSpec: string;
      readonly command: string;
    };

const LSCI_ENV = 'lsci';

/** 半开区间 [min, max)。补丁级上下限在官方表里按 minor 给出，第三位为 0。 */
const V = (major: number, minor: number): VersionTriple => [major, minor, 0];

export const NUMBA_NUMPY_CONSTRAINTS: readonly NumbaNumpyConstraint[] = [
  { numba: '0.67', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 6) }] },
  { numba: '0.66', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 5) }] },
  { numba: '0.65', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 5) }] },
  { numba: '0.64', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 5) }] },
  { numba: '0.63', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 4) }] },
  { numba: '0.62', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 4) }] },
  { numba: '0.61.2', numpy: [{ minInclusive: V(1, 24), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 3) }] },
  { numba: '0.61.0', numpy: [{ minInclusive: V(1, 24), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 2) }] },
  { numba: '0.60', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }, { minInclusive: V(2, 0), maxExclusive: V(2, 1) }] },
  { numba: '0.59', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }] },
  { numba: '0.58.1', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 27) }] },
  { numba: '0.58.0', numpy: [{ minInclusive: V(1, 22), maxExclusive: V(1, 26) }] },
  { numba: '0.57', numpy: [{ minInclusive: V(1, 21), maxExclusive: V(1, 25) }] },
];

function assertNever(value: never): never {
  throw new Error(`unexpected verdict: ${JSON.stringify(value)}`);
}

export function parseVersion(raw: string): VersionTriple | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

function cmp(a: VersionTriple, b: VersionTriple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function inInterval(version: VersionTriple, interval: NumpyInterval): boolean {
  return cmp(version, interval.minInclusive) >= 0 && cmp(version, interval.maxExclusive) < 0;
}

function formatBound(version: VersionTriple): string {
  return version[2] === 0 ? `${version[0]}.${version[1]}` : `${version[0]}.${version[1]}.${version[2]}`;
}

function pinSpec(intervals: readonly NumpyInterval[]): string {
  const first = intervals[0];
  if (first === undefined) return 'numpy';
  let min = first.minInclusive;
  let max = first.maxExclusive;
  for (const interval of intervals) {
    if (cmp(interval.minInclusive, min) < 0) min = interval.minInclusive;
    if (cmp(interval.maxExclusive, max) > 0) max = interval.maxExclusive;
  }
  return `numpy>=${formatBound(min)},<${formatBound(max)}`;
}

function condaPinCommand(spec: string): string {
  return `conda install -n ${LSCI_ENV} "${spec}"`;
}

function findConstraint(numba: VersionTriple): NumbaNumpyConstraint | null {
  const exact = `${numba[0]}.${numba[1]}.${numba[2]}`;
  const minor = `${numba[0]}.${numba[1]}`;
  const exactRow = NUMBA_NUMPY_CONSTRAINTS.find((row) => row.numba === exact);
  if (exactRow !== undefined) return exactRow;
  const minorRow = NUMBA_NUMPY_CONSTRAINTS.find((row) => row.numba === minor);
  return minorRow ?? null;
}

function incompatibleReason(
  numpy: VersionTriple | null,
  intervals: readonly NumpyInterval[],
): 'numpy-too-new' | 'numpy-too-old' | 'numpy-absent' {
  if (numpy === null) return 'numpy-absent';
  const first = intervals[0];
  if (first === undefined) return 'numpy-too-new';
  let min = first.minInclusive;
  for (const interval of intervals) {
    if (cmp(interval.minInclusive, min) < 0) min = interval.minInclusive;
  }
  return cmp(numpy, min) < 0 ? 'numpy-too-old' : 'numpy-too-new';
}

export function judgeNumbaNumpyCompat(
  numbaVersion: string | null,
  numpyVersion: string | null,
): NumbaNumpyVerdict {
  if (numbaVersion === null || numbaVersion === '') return { kind: 'absent' };

  const numba = parseVersion(numbaVersion);
  if (numba === null) return { kind: 'unknown', numba: numbaVersion, numpy: numpyVersion };

  const constraint = findConstraint(numba);
  if (constraint === null) return { kind: 'unknown', numba: numbaVersion, numpy: numpyVersion };

  const spec = pinSpec(constraint.numpy);
  if (numpyVersion === null || numpyVersion === '') {
    return {
      kind: 'incompatible',
      numba: numbaVersion,
      numpy: null,
      reason: 'numpy-absent',
      pinSpec: spec,
      command: condaPinCommand(spec),
    };
  }

  const numpy = parseVersion(numpyVersion);
  if (numpy === null) return { kind: 'unknown', numba: numbaVersion, numpy: numpyVersion };

  if (constraint.numpy.some((interval) => inInterval(numpy, interval))) {
    return { kind: 'compatible', numba: numbaVersion, numpy: numpyVersion };
  }

  return {
    kind: 'incompatible',
    numba: numbaVersion,
    numpy: numpyVersion,
    reason: incompatibleReason(numpy, constraint.numpy),
    pinSpec: spec,
    command: condaPinCommand(spec),
  };
}

export function formatNumbaNumpyDoctorDetail(verdict: NumbaNumpyVerdict): string {
  switch (verdict.kind) {
    case 'absent':
      return '未安装';
    case 'unknown':
      return `numba ${verdict.numba} 未收录约束，不做兼容判定`;
    case 'compatible':
      return `numba ${verdict.numba} 与 numpy ${verdict.numpy} 兼容`;
    case 'incompatible': {
      const numpy = verdict.numpy ?? '未安装';
      return `numba ${verdict.numba} 与 numpy ${numpy} 不兼容 —— ${verdict.command}`;
    }
    default:
      return assertNever(verdict);
  }
}
