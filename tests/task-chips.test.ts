/**
 * 一次性任务类型芯片（B5）。
 *
 * 关键词推断故意不猜 citation.verify：猜错的代价比退到通用档大。
 * 芯片把「写代码 / 画图 / 核对引用」钉成这一条消息的 routing.taskType，
 * 发完即失效——沿用已有覆盖清空，不另做会话级开关。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inferTaskType } from '@l-science/core';

const CHIPS = readFileSync(
  join('packages', 'ui', 'src', 'components', 'TaskTypeChips.tsx'),
  'utf8',
);
const ORCH = readFileSync(join('packages', 'core', 'src', 'orchestrator', 'orchestrator.ts'), 'utf8');

describe('task type chips', () => {
  it('maps 写代码/画图/核对引用 to analysis.codegen/figure.compose/citation.verify', () => {
    // Given: 芯片表是路由覆盖的唯一快捷入口
    // When: 读 TaskTypeChips 源码里的 label → taskType
    const chips = [...CHIPS.matchAll(/label:\s*'([^']+)',\s*taskType:\s*'([^']+)'/gu)].map(
      (m) => [m[1], m[2]] as const,
    );

    // Then: 三枚，没有第四枚，映射固定
    expect(chips).toEqual([
      ['写代码', 'analysis.codegen'],
      ['画图', 'figure.compose'],
      ['核对引用', 'citation.verify'],
    ]);
  });

  it('does not change inferTaskType keyword table', () => {
    // Given: inferTaskType 是关键词表，不是芯片
    const start = ORCH.indexOf('export function inferTaskType');
    expect(start).toBeGreaterThan(-1);
    const fn = ORCH.slice(start);

    // When: 核对函数体里的关键词正则
    // Then: 表本身没动——芯片不得靠改推断来生效
    expect(fn).toContain('/润色|polish|改写|rewrite|语言|grammar/');
    expect(fn).toContain('/翻译|translate/');
    expect(fn).toContain('/写.*(引言|讨论|摘要|方法)|draft|起草|introduction|discussion/');
    expect(fn).toContain('/统计|显著|p 值|p-value|anova|回归|regression|检验|test/');
    expect(fn).toContain(
      '/[画绘作做制].{0,6}图|绘制|plot|figure|可视化|visuali|箱线|散点|直方|热图|折线|柱状|小提琴|饼图/',
    );
    expect(fn).toContain('/筛|screen|摘要.*文献|literature/');
    expect(fn).toContain('/审稿|review|评审/');
    expect(fn).toContain("return 'analysis.codegen'");
    expect(fn).not.toContain("return 'citation.verify'");

    const ask = (text: string) => inferTaskType([{ role: 'user', content: text }]);
    expect(ask('帮我润色这段引言')).toBe('manuscript.polish');
    expect(ask('画一张箱线图')).toBe('figure.compose');
    expect(ask('核对一下这些引用')).not.toBe('citation.verify');
    expect(ask('核对引用')).not.toBe('citation.verify');
  });
});
