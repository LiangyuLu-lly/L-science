/**
 * 工具卡片对 aborted 状态的展示（T8）。
 *
 * 重启后遗留的 running 会被标成 aborted。卡片必须用文字标出「已中止」，
 * 不能只靠颜色，也不能继续显示「执行中」转圈。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CARD = readFileSync(join('packages', 'ui', 'src', 'components', 'ToolCard.tsx'), 'utf8');

describe('ToolCard aborted status', () => {
  it('renders 已中止 for aborted tool calls, distinct from running and error', () => {
    // Given: ToolCard 用 statusOf 把调用状态映射成文字 + tone
    // When: 读卡片源码
    // Then: aborted 有独立中文标签，不是「执行中」也不是「出错」
    expect(CARD).toContain("call.status === 'aborted'");
    expect(CARD).toContain('已中止（应用上次退出时未完成）');
    expect(CARD).toMatch(/tone:\s*'aborted'/u);
    expect(CARD).not.toMatch(/if \(call\.status === 'aborted'\) return \{ label: '出错'/u);
    expect(CARD).not.toMatch(/if \(call\.status === 'aborted'\) return \{ label: '执行中'/u);
  });
});
