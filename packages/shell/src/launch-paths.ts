/**
 * 打包 / 未打包启动路径。
 *
 * 不 import electron：主进程把 app.isPackaged、process.resourcesPath、仓库根
 * 注入进来，vitest 才能在没有 Electron 的环境里测路径约定。
 */

import { delimiter, dirname, join } from 'node:path';

export type LaunchContext = {
  readonly packaged: boolean;
  readonly repoRoot: string;
  readonly resourcesPath: string;
  readonly here: string;
  readonly env: NodeJS.ProcessEnv;
};

export type LaunchPaths = {
  readonly nodeBin: string;
  readonly backendEntry: string;
  readonly rendererHtml: string;
  readonly builtinSkills: string;
  readonly sidecarCwd: string;
};

export function resolveLaunchPaths(ctx: LaunchContext): LaunchPaths {
  if (ctx.packaged) {
    return {
      nodeBin: join(ctx.resourcesPath, 'node', 'node.exe'),
      backendEntry: join(
        ctx.resourcesPath,
        'sidecar',
        'app',
        'packages',
        'core',
        'dist',
        'backend.js',
      ),
      rendererHtml: join(ctx.here, '..', 'renderer', 'index.html'),
      builtinSkills: join(ctx.resourcesPath, 'skills', 'builtin'),
      sidecarCwd: join(ctx.resourcesPath, 'sidecar', 'app'),
    };
  }

  return {
    nodeBin: ctx.env['L_SCIENCE_NODE'] ?? 'node',
    backendEntry: join(ctx.repoRoot, 'packages', 'core', 'dist', 'backend.js'),
    rendererHtml: join(ctx.repoRoot, 'packages', 'ui', 'dist', 'index.html'),
    builtinSkills: join(ctx.repoRoot, 'resources', 'skills', 'builtin'),
    sidecarCwd: ctx.repoRoot,
  };
}

export function spawnEnv(paths: LaunchPaths, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next['ELECTRON_RUN_AS_NODE'];

  const pathKey = Object.keys(next).find((k) => k.toLowerCase() === 'path');
  const existing = pathKey === undefined ? undefined : next[pathKey];
  if (pathKey !== undefined && pathKey !== 'PATH') {
    delete next[pathKey];
  }

  const nodeDir = dirname(paths.nodeBin);
  next['PATH'] =
    existing === undefined || existing === '' ? nodeDir : `${nodeDir}${delimiter}${existing}`;
  next['L_SCIENCE_NODE'] = paths.nodeBin;
  next['L_SCIENCE_BUILTIN_SKILLS'] = paths.builtinSkills;
  return next;
}
