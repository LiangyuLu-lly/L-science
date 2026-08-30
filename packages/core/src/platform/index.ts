/**
 * 平台抽象层（任务 15.1，需求 20.4.1）。
 *
 * 用法：
 *
 * ```ts
 * import { platform } from '../platform/index.js';
 * const shell = platform().shellInvocation({ family: 'posix', command: 'ls' });
 * ```
 *
 * **不要在别处写 `process.platform === 'win32'`。** 那句判断散开之后，「移植到 Linux
 * 还差什么」就只能靠把每一处逐个读一遍来回答，而漏掉一处的表现不是编译失败，是在那个
 * 平台上某个功能静默走错分支。有测试守着这条约定（`tests/platform.test.ts` 扫源码）。
 *
 * 例外是三处**必须**直接判平台的地方，它们在 win32/ 目录下：FFI 加载、DPAPI 加载、
 * 原生能力报告。那三处判断的正是「这个平台有没有这套 API」，绕一层抽象只会让它们更绕。
 */

import { darwinAdapter, linuxAdapter } from './posix.js';
import type { PlatformAdapter, PlatformGap, PlatformId } from './types.js';
import { windowsAdapter } from './windows.js';

export type {
  KillTreeSpec,
  PlatformAdapter,
  PlatformGap,
  PlatformId,
  ShellFamily,
  ShellInvocation,
} from './types.js';
export { windowsAdapter, findPowerShell, withUtf8Preamble } from './windows.js';
export { darwinAdapter, linuxAdapter } from './posix.js';

const ADAPTERS: Readonly<Record<PlatformId, PlatformAdapter>> = {
  win32: windowsAdapter,
  linux: linuxAdapter,
  darwin: darwinAdapter,
};

/** 已知平台。用于「这个平台我们认不认」的判断。 */
export const KNOWN_PLATFORMS: readonly PlatformId[] = ['win32', 'linux', 'darwin'];

let override: PlatformAdapter | null = null;

/**
 * 当前平台的适配器。
 *
 * 未知平台（freebsd、aix……）落到 Linux 适配器而不是抛错：路径与 shell 那两组在任何
 * POSIX 上都成立，因此「能跑但有缺口」比「直接起不来」更有用。`unknownPlatform()`
 * 让调用方能把这件事显示出来。
 */
export function platform(): PlatformAdapter {
  if (override !== null) return override;
  const id = process.platform as PlatformId;
  return ADAPTERS[id] ?? linuxAdapter;
}

/** 当前运行的平台是不是我们认识的。 */
export function unknownPlatform(): boolean {
  return !KNOWN_PLATFORMS.includes(process.platform as PlatformId);
}

/** 按 id 取适配器。用于「在 Windows 上说明 Linux 上会怎样」这类场景。 */
export function adapterFor(id: PlatformId): PlatformAdapter {
  return ADAPTERS[id];
}

/**
 * 替换当前适配器。**仅供测试**。
 *
 * 做成显式的替换而不是让测试改 `process.platform`：后者是全局副作用，一个忘了恢复的
 * 测试会让之后所有测试跑在错误的平台假设下，而那种失败看起来与被测代码毫无关系。
 */
export function setPlatformAdapter(adapter: PlatformAdapter | null): void {
  override = adapter;
}

/** 当前平台是不是 Windows。少数确实需要分支的地方用它，而不是直接读 process.platform。 */
export function isWindows(): boolean {
  return platform().id === 'win32';
}

/**
 * 平台缺口报告。
 *
 * `doctor` 与设置页用它回答「这台机器上有哪些能力是降级的」。在 Windows 上返回空数组
 * ——那是权威实现。
 */
export function platformGaps(): readonly PlatformGap[] {
  return platform().gaps;
}

/** 缺口的可读摘要。 */
export function describePlatform(): string {
  const adapter = platform();
  const lines = [`平台：${adapter.label}（${adapter.id}）`];

  if (unknownPlatform()) {
    lines.push(
      `⚠ ${process.platform} 不在已知平台列表里，按 POSIX 处理。` +
        '路径与 shell 应当可用，其余能力未经验证。',
    );
  }

  if (adapter.gaps.length === 0) {
    lines.push('全部平台能力可用。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`这个平台上有 ${String(adapter.gaps.length)} 项能力是降级的：`);
  for (const gap of adapter.gaps) {
    lines.push('');
    lines.push(`· ${gap.what}（${gap.id}）`);
    lines.push(`  实际行为：${gap.consequence}`);
    lines.push(`  补齐方式：${gap.plan ?? '暂无已知方案'}`);
  }
  return lines.join('\n');
}
