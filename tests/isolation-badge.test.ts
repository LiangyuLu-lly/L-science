/**
 * 隔离徽章折叠文案（A6）。
 *
 * 折叠态用「本机用户态隔离」而不是「弱隔离」：后者是吓人标签，前者是机制说明。
 * 展开后 caveats 仍原文展示——诚实降级在展开层，不在折叠层用吓词代替。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const BADGE = readFileSync(join('packages', 'ui', 'src', 'components', 'IsolationBadge.tsx'), 'utf8');

describe('IsolationBadge collapsed copy', () => {
  it('collapsed isolation label is 本机用户态隔离（点击查看说明）', () => {
    // Given: 折叠态是用户未点开时唯一看见的标签
    // When: 读徽章源码
    // Then: 折叠标签是机制说明，不是「弱隔离」吓词
    expect(BADGE).toContain('本机用户态隔离（点击查看说明）');
  });

  it('PROCESS_LABEL includes monitor', () => {
    // Given: native 后端在没有 Job Object 时 process 是 monitor
    // When: 读 PROCESS_LABEL
    // Then: 有对应中文，而不是把 raw `monitor` 漏到界面上
    expect(BADGE).toMatch(/monitor:\s*'进程树监控（非硬限额）'/u);
  });

  it('PROCESS_LABEL includes container', () => {
    expect(BADGE).toMatch(/container:\s*'容器隔离'/u);
  });
});
