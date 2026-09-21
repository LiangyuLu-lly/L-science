/**
 * 工具面板：Python 内核缺失时，不可用列表要把 python-kernel 排到最前。
 *
 * 不可用的工具必须显示出来并带上安装指引。藏起来用户会以为功能不存在。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  pythonKernelGapBanner,
  rankUnavailableTools,
} from '../packages/ui/src/lib/unavailable-tools.js';

const PANEL_SRC = readFileSync(join('packages', 'ui', 'src', 'components', 'ToolsPanel.tsx'), 'utf8');

describe('ToolsPanel python-kernel gap', () => {
  it('python-kernel gap is ranked first with 还没有 lsci', () => {
    // Given: 按名字排序的话 bash 会排在 python 前面；R 也在不可用清单里
    const unavailable = [
      {
        name: 'bash',
        missing: [{ capability: 'shell:bash', remediation: 'wsl --install -d Ubuntu' }],
      },
      {
        name: 'r',
        missing: [{ capability: 'kernel:r', remediation: 'conda create -n lsci-r' }],
      },
      {
        name: 'python',
        missing: [
          {
            capability: 'kernel:python',
            remediation:
              '托管 Python 环境缺失。执行：conda create -n lsci python=3.13 -y && conda run -n lsci pip install ipykernel',
          },
        ],
      },
    ];
    const blockers = [{ id: 'lsci', command: 'conda create -n lsci python=3.13' }];

    // When
    const ranked = rankUnavailableTools(unavailable);
    const banner = pythonKernelGapBanner({
      blockers,
      remediations: unavailable.flatMap((tool) => tool.missing.map((m) => m.remediation)),
    });

    // Then: python-kernel 领头；一条都不藏；先指向一键安装，conda 只作兜底
    expect(ranked.map((tool) => tool.name)).toEqual(['python', 'bash', 'r']);
    expect(ranked).toHaveLength(unavailable.length);
    expect(banner).toMatch(/^还没有 lsci/u);
    expect(banner).toContain('点『一键安装 Python / R 内核』；装不上时再用手动命令');
    expect(banner).toContain('conda create -n lsci python=3.13');
    const ctaAt = banner!.indexOf('一键安装 Python / R 内核');
    const condaAt = banner!.indexOf('conda create');
    expect(ctaAt).toBeGreaterThan(-1);
    expect(condaAt).toBeGreaterThan(-1);
    expect(ctaAt).toBeLessThan(condaAt);
  });

  it('ToolsPanel ranks unavailable tools and does not hide them', () => {
    // Given / Then: 面板走排序助手；不可用列表仍全量 map，没有 filter 掉
    expect(PANEL_SRC).toContain('rankUnavailableTools');
    expect(PANEL_SRC).toContain('pythonKernelGapBanner');
    expect(PANEL_SRC).not.toMatch(/unavailable\.filter\(/u);
    expect(PANEL_SRC).toMatch(/rankUnavailableTools\(listing\.unavailable\)/u);
  });
});
