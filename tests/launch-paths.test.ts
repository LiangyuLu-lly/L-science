/**
 * Electron 启动路径解析（打包 / 未打包）。
 *
 * 主进程不能 import electron 之外再去猜路径：打包后 repoRoot 不存在，
 * 未打包时 resourcesPath 指向 Electron 自己的资源目录。解析必须吃注入的
 * 上下文，并且这个模块本身不能依赖 electron，否则 vitest 无法加载。
 */

import { readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveLaunchPaths, spawnEnv, type LaunchContext } from '@l-science/shell/launch-paths';

const REPO = join('/repo');
const RESOURCES = join('/packaged', 'resources');
const HERE_UNPACKAGED = join(REPO, 'packages', 'shell', 'dist');
const HERE_PACKAGED = join(RESOURCES, 'app', 'dist');

function unpackaged(env: NodeJS.ProcessEnv = {}): LaunchContext {
  return {
    packaged: false,
    repoRoot: REPO,
    resourcesPath: RESOURCES,
    here: HERE_UNPACKAGED,
    env,
  };
}

function packaged(env: NodeJS.ProcessEnv = {}): LaunchContext {
  return {
    packaged: true,
    repoRoot: REPO,
    resourcesPath: RESOURCES,
    here: HERE_PACKAGED,
    env,
  };
}

function envPath(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  return key === undefined ? undefined : env[key];
}

describe('未打包', () => {
  it('nodeBin 在未设置 L_SCIENCE_NODE 时为 node', () => {
    expect(resolveLaunchPaths(unpackaged()).nodeBin).toBe('node');
  });

  it('nodeBin 使用 L_SCIENCE_NODE 覆盖', () => {
    const nodeBin = join('/custom', 'node.exe');
    expect(resolveLaunchPaths(unpackaged({ L_SCIENCE_NODE: nodeBin })).nodeBin).toBe(nodeBin);
  });

  it('backendEntry 落在仓库 packages/core/dist', () => {
    expect(resolveLaunchPaths(unpackaged()).backendEntry).toBe(
      join(REPO, 'packages', 'core', 'dist', 'backend.js'),
    );
  });

  it('rendererHtml 落在仓库 packages/ui/dist', () => {
    expect(resolveLaunchPaths(unpackaged()).rendererHtml).toBe(
      join(REPO, 'packages', 'ui', 'dist', 'index.html'),
    );
  });

  it('builtinSkills 落在仓库 resources/skills/builtin', () => {
    expect(resolveLaunchPaths(unpackaged()).builtinSkills).toBe(
      join(REPO, 'resources', 'skills', 'builtin'),
    );
  });

  it('sidecarCwd 是仓库根', () => {
    expect(resolveLaunchPaths(unpackaged()).sidecarCwd).toBe(REPO);
  });

  it('忽略 resourcesPath：backend 与技能不落到打包资源目录', () => {
    const paths = resolveLaunchPaths(unpackaged());
    expect(paths.backendEntry.startsWith(RESOURCES)).toBe(false);
    expect(paths.builtinSkills.startsWith(RESOURCES)).toBe(false);
    expect(paths.nodeBin.startsWith(RESOURCES)).toBe(false);
  });
});

describe('打包', () => {
  it('nodeBin 是 resources/node/node.exe', () => {
    expect(resolveLaunchPaths(packaged()).nodeBin).toBe(join(RESOURCES, 'node', 'node.exe'));
  });

  it('打包态忽略 L_SCIENCE_NODE，仍用内置 node.exe', () => {
    const paths = resolveLaunchPaths(packaged({ L_SCIENCE_NODE: join('/custom', 'node.exe') }));
    expect(paths.nodeBin).toBe(join(RESOURCES, 'node', 'node.exe'));
  });

  it('backendEntry 落在 sidecar/app 下的 core dist', () => {
    expect(resolveLaunchPaths(packaged()).backendEntry).toBe(
      join(RESOURCES, 'sidecar', 'app', 'packages', 'core', 'dist', 'backend.js'),
    );
  });

  it('rendererHtml 是 here 的上一级下的 renderer/index.html', () => {
    expect(resolveLaunchPaths(packaged()).rendererHtml).toBe(
      join(HERE_PACKAGED, '..', 'renderer', 'index.html'),
    );
  });

  it('builtinSkills 落在 resources/skills/builtin', () => {
    expect(resolveLaunchPaths(packaged()).builtinSkills).toBe(join(RESOURCES, 'skills', 'builtin'));
  });

  it('sidecarCwd 是 resources/sidecar/app', () => {
    expect(resolveLaunchPaths(packaged()).sidecarCwd).toBe(join(RESOURCES, 'sidecar', 'app'));
  });

  it('忽略 repoRoot：backend 与技能不落到仓库路径', () => {
    const paths = resolveLaunchPaths(packaged());
    expect(paths.backendEntry.startsWith(REPO)).toBe(false);
    expect(paths.builtinSkills.startsWith(REPO)).toBe(false);
    expect(paths.sidecarCwd.startsWith(REPO)).toBe(false);
  });
});

describe('spawnEnv', () => {
  it('写入 L_SCIENCE_NODE 与 L_SCIENCE_BUILTIN_SKILLS', () => {
    const paths = resolveLaunchPaths(unpackaged({ L_SCIENCE_NODE: join('/opt', 'node') }));
    const env = spawnEnv(paths, { PATH: '/usr/bin' });
    expect(env['L_SCIENCE_NODE']).toBe(paths.nodeBin);
    expect(env['L_SCIENCE_BUILTIN_SKILLS']).toBe(paths.builtinSkills);
  });

  it('把 dirname(nodeBin) 接到 PATH 最前', () => {
    const nodeBin = join('/opt', 'node');
    const paths = resolveLaunchPaths(unpackaged({ L_SCIENCE_NODE: nodeBin }));
    const env = spawnEnv(paths, { PATH: '/usr/bin' });
    expect(envPath(env)).toBe(`${dirname(nodeBin)}${delimiter}/usr/bin`);
  });

  it('Windows 的 Path 键同样被前置，不留下一份未改的 Path', () => {
    const nodeBin = join('/opt', 'node');
    const paths = resolveLaunchPaths(unpackaged({ L_SCIENCE_NODE: nodeBin }));
    const env = spawnEnv(paths, { Path: 'C:\\Windows' });
    expect(env['Path']).toBeUndefined();
    expect(env['PATH']).toBe(`${dirname(nodeBin)}${delimiter}C:\\Windows`);
  });

  it('删除 ELECTRON_RUN_AS_NODE，不把它设成 1', () => {
    const paths = resolveLaunchPaths(unpackaged());
    const env = spawnEnv(paths, { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' });
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false);
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });

  it('不修改传入的 env 对象', () => {
    const paths = resolveLaunchPaths(unpackaged());
    const input: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };
    spawnEnv(paths, input);
    expect(input['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(input['PATH']).toBe('/usr/bin');
  });
});

describe('模块边界', () => {
  it('launch-paths.ts 不 import electron', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../packages/shell/src/launch-paths.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]electron['"]/u);
  });
});
