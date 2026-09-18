/**
 * extraResources 磁盘布局契约。
 *
 * 打包只复制三棵树（vendor Node、sidecar 预构建、内置技能），
 * 绝不把仓库根的 node_modules 打进安装包。
 */

import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  backendRel,
  extraResourceSources,
  nodeDir,
  packLayout,
  sidecarApp,
  sidecarStage,
  skillsBuiltin,
  vendorNode,
} from '../scripts/lib/pack-layout.mjs';

describe('pack-layout', () => {
  it('freezes the layout object so pack paths cannot be reassigned', () => {
    expect(Object.isFrozen(packLayout)).toBe(true);
    expect(packLayout.nodeDir).toBe(nodeDir);
    expect(packLayout.sidecarApp).toBe(sidecarApp);
    expect(packLayout.backendRel).toBe(backendRel);
    expect(packLayout.skillsBuiltin).toBe(skillsBuiltin);
    expect(packLayout.vendorNode).toBe(vendorNode);
    expect(packLayout.sidecarStage).toBe(sidecarStage);
  });

  it('joins nodeDir to node.exe under extraResources', () => {
    expect(nodeDir).toBe('node');
    expect(posix.join(nodeDir, 'node.exe')).toBe('node/node.exe');
  });

  it('joins sidecarApp and backendRel to the packaged backend path', () => {
    expect(sidecarApp).toBe('sidecar/app');
    expect(backendRel).toBe('packages/core/dist/backend.js');
    expect(posix.join(sidecarApp, backendRel)).toBe(
      'sidecar/app/packages/core/dist/backend.js',
    );
  });

  it('keeps builtin skills at skills/builtin', () => {
    expect(skillsBuiltin).toBe('skills/builtin');
  });

  it('does not use node_modules as the sidecar stage directory', () => {
    expect(sidecarStage).toBe('release/sidecar-stage');
    expect(sidecarStage.split(/[\\/]/u)).not.toContain('node_modules');
  });

  it('does not use linux-x64 as a source path', () => {
    expect(vendorNode).toBe('vendor/node-win-x64');
    expect(extraResourceSources).toEqual([
      vendorNode,
      sidecarStage,
      skillsBuiltin,
    ]);
    for (const source of extraResourceSources) {
      expect(source).not.toContain('linux-x64');
    }
  });
});
