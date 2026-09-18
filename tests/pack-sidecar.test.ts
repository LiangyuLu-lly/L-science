/**
 * sidecar 预构建舞台。
 *
 * extraResources 复制的是 release/sidecar-stage，不是仓库根 node_modules。
 * 原生模块必须在舞台目录里 npm install --omit=dev；本文件不跑安装。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backendRel, sidecarStage } from '../scripts/lib/pack-layout.mjs';
import { packSidecar, sidecarStageManifest } from '../scripts/pack-sidecar.mjs';

const WORKSPACE = ['shared', 'adapters', 'kernel', 'core'] as const;

describe('sidecarStageManifest', () => {
  it('pins runtime natives and zod, plus file: copies of workspace dist', () => {
    expect(sidecarStageManifest()).toEqual({
      name: 'l-science-sidecar',
      private: true,
      type: 'module',
      dependencies: {
        'better-sqlite3': '13.0.2',
        koffi: '3.1.4',
        zeromq: '6.5.0',
        zod: '4.4.3',
        '@l-science/shared': 'file:packages/shared/dist',
        '@l-science/adapters': 'file:packages/adapters/dist',
        '@l-science/kernel': 'file:packages/kernel/dist',
        '@l-science/core': 'file:packages/core/dist',
      },
    });
  });

  it('does not point file: deps at repo-root node_modules', () => {
    const dumped = JSON.stringify(sidecarStageManifest());
    expect(dumped).not.toContain('node_modules');
    expect(dumped).not.toContain('linux-x64');
    expect(dumped).not.toContain('conda');
  });
});

describe('packSidecar', () => {
  let root: string;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('copies packages/*/dist into the stage and writes the production package.json', async () => {
    root = fakeRepo();
    const stageDir = join(root, sidecarStage);

    await packSidecar({ root, install: false });

    const manifest = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['better-sqlite3']).toBe('13.0.2');
    expect(manifest.dependencies['@l-science/core']).toBe('file:packages/core/dist');
    expect(readFileSync(join(stageDir, backendRel), 'utf8')).toBe('export {}\n');
    expect(
      JSON.parse(
        readFileSync(join(stageDir, 'packages', 'shared', 'dist', 'package.json'), 'utf8'),
      ),
    ).toMatchObject({ name: '@l-science/shared', main: './index.js' });
  });

  it('does not copy linux-x64, conda, or repo-root node_modules', async () => {
    root = fakeRepo();
    mkdirSync(join(root, 'packages', 'core', 'dist', 'linux-x64'), { recursive: true });
    mkdirSync(join(root, 'packages', 'core', 'dist', 'conda'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'dist', 'linux-x64', 'native.node'), 'nope');
    writeFileSync(join(root, 'packages', 'core', 'dist', 'conda', 'env.txt'), 'nope');
    mkdirSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'index.js'), 'decoy\n');

    await packSidecar({ root, install: false });

    const stageDir = join(root, sidecarStage);
    expect(() =>
      readFileSync(join(stageDir, 'packages', 'core', 'dist', 'linux-x64', 'native.node')),
    ).toThrow();
    expect(() =>
      readFileSync(join(stageDir, 'packages', 'core', 'dist', 'conda', 'env.txt')),
    ).toThrow();
    expect(() =>
      readFileSync(join(stageDir, 'node_modules', 'better-sqlite3', 'index.js')),
    ).toThrow();
  });
});

function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lsci-sidecar-'));
  for (const name of WORKSPACE) {
    const dist = join(root, 'packages', name, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'export {}\n');
  }
  writeFileSync(join(root, 'packages', 'core', 'dist', 'backend.js'), 'export {}\n');
  return root;
}
