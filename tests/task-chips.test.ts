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
const APP = readFileSync(join('packages', 'ui', 'src', 'App.tsx'), 'utf8');
const ORCH = readFileSync(join('packages', 'core', 'src', 'orchestrator', 'orchestrator.ts'), 'utf8');
const IPC = readFileSync(join('packages', 'shared', 'src', 'ipc.ts'), 'utf8');

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

describe('核对引用 chip performs a real check', () => {
  it('uses citation.verify (citations[]) because the schema has no refId', () => {
    // Given: IPC 三个引文方法都不收 refId；只有 citation.verify 能对一条题录做检索判定
    expect(IPC).toContain("method: z.literal('citation.verify')");
    expect(IPC).toContain('citations: z.array(z.string()');
    expect(IPC).not.toMatch(/citation\.verify[\s\S]{0,400}refId/);

    // When: 芯片处理核对引用
    // Then: 走 verifyCitations，把选中文献的题录/DOI 当作 citations 传入
    expect(CHIPS).toContain('verifyCitations');
    expect(CHIPS).toContain('citations:');
    expect(CHIPS).not.toContain('listCitationChecks');
    expect(CHIPS).not.toContain('parseCitations');
  });

  it('still sets the routing hint when 核对引用 is clicked', () => {
    // Given: 芯片点击仍是下一条消息的 taskType 覆盖
    // When: 读 App 把芯片接到 routingOverride 的那一行
    // Then: 覆盖还在；核对不是替换路由，是额外做一次
    expect(APP).toContain('setRoutingOverride({ ...routingOverride, taskType })');
    expect(CHIPS).toContain('onSelect(chip.taskType)');
    expect(APP).toMatch(/<TaskTypeChips[\s\S]*focusRef=/);
    expect(APP).toMatch(/<TaskTypeChips[\s\S]*projectId=/);
  });

  it('names the next step when it cannot check, and never pretends success', () => {
    // Given: 没有选中文献时点核对引用
    // When: 读芯片源码里的可见文案
    // Then: 一句中文说明下一步；失败走 alert；进行中走 status
    expect(CHIPS).toContain('先在文献里选一篇，再点核对引用');
    expect(CHIPS).toContain('正在核对引用');
    expect(CHIPS).toContain('核对引用失败');
    expect(CHIPS).toContain('role="status"');
    expect(CHIPS).toContain('role="alert"');
    expect(CHIPS).toContain('panel__hint');
    expect(CHIPS).toContain('panel__error');
  });

  it('renders not-found and metadata-mismatch counts plus offending entries', () => {
    // Given: citation.verify 返回 counts 与 results
    // When: 芯片渲染核对结果
    // Then: 问题计数和条目都在，不把有问题的结果收成一个通过标记
    expect(CHIPS).toContain("counts['not-found']");
    expect(CHIPS).toContain("counts['metadata-mismatch']");
    expect(CHIPS).toContain('result.raw');
    expect(CHIPS).toContain('result.verdict');
    expect(CHIPS).not.toContain('✓');
    expect(CHIPS).not.toContain('核对通过');
  });

  it('says the actual check was skipped when it only set the routing hint', () => {
    // Given: 没选文献 / 没项目时芯片仍会按下一条消息的路由
    // When: 读跳过核对的可见文案
    // Then: 不让人以为已经核对过
    expect(CHIPS).toContain('同时跳过一次实际核对：先在文献里选一篇，再点核对引用');
    expect(CHIPS).toContain('同时跳过一次实际核对：当前没有项目');
    expect(CHIPS).toContain('同时跳过一次实际核对：这篇文献没有可核对的题录或 DOI');
  });
});
