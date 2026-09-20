/**
 * 导航与会话状态的中文标签（C4）。
 *
 * 英文枚举是 SQLite / IPC 的稳定值，不能改。界面必须走映射，否则侧栏会把
 * awaiting_user_input 这种内部标识直接亮给用户。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = readFileSync(join('packages', 'ui', 'src', 'App.tsx'), 'utf8');
const MAP = join('packages', 'ui', 'src', 'lib', 'conversation-status.ts');

describe('nav i18n', () => {
  it('nav artifacts label is 制品', () => {
    // Given: STUDIO_NAV 是工作室导航的标签源
    const start = APP.indexOf('const STUDIO_NAV');
    const block = APP.slice(start, APP.indexOf('];', start));
    // When: 取出 artifacts 项的 label
    const label = /id:\s*'artifacts',\s*label:\s*'([^']+)'/u.exec(block)?.[1];
    // Then: 中文「制品」，不是英文 Artifacts
    expect(label).toBe('制品');
  });

  it('conversation status English enums are mapped to Chinese', () => {
    // Given: 会话列表在非 idle 时显示状态
    // When: 渲染 nav__conv-status
    // Then: 不直接输出英文枚举，走中文映射
    expect(APP).not.toMatch(/nav__conv-status">\{c\.status\}/u);
    expect(APP).toMatch(/conversationStatusLabel\(c\.status\)/u);

    const mapSrc = readFileSync(MAP, 'utf8');
    expect(mapSrc).toContain("idle: '空闲'");
    expect(mapSrc).toContain("planning: '规划中'");
    expect(mapSrc).toContain("executing: '执行中'");
    expect(mapSrc).toContain("reviewing: '审查中'");
    expect(mapSrc).toContain("awaiting_approval: '等待批准'");
    expect(mapSrc).toContain("awaiting_user_input: '等待你的回复'");
    expect(mapSrc).toContain("background_pending: '后台进行中'");
  });
});
