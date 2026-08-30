/**
 * 数据目录布局。见设计文档「数据目录布局」一节。
 *
 * 所有路径都从 %LOCALAPPDATA%\L-science 派生。允许用 L_SCIENCE_DATA_DIR 覆盖，
 * 测试与多实例并行需要这个逃生口。
 */

import { join } from 'node:path';

import { platform } from './platform/index.js';

export const APP_DIR_NAME = 'L-science';

/**
 * 数据目录。
 *
 * 默认位置由平台适配器给（需求 20.4.1）：Windows 是 `%LOCALAPPDATA%`，Linux 走 XDG，
 * macOS 是 `~/Library/Application Support`。把三者混成一个 `~/.l-science` 能跑，但在
 * macOS 上那个目录不会被 Time Machine 按应用数据处理，而用户以为它被备份了。
 */
export function dataDir(): string {
  const override = process.env['L_SCIENCE_DATA_DIR'];
  if (override !== undefined && override !== '') return override;
  return platform().defaultDataDir(APP_DIR_NAME);
}

export interface AppPaths {
  root: string;
  config: string;
  /** 应用级数据库：项目注册表、供应商、技能、连接器、算力、全局记忆。 */
  appDb: string;
  credentials: string;
  projects: string;
  runtime: string;
  runtimeKernels: string;
  runtimeEnvs: string;
  skillsBuiltin: string;
  skillsUser: string;
  logs: string;
}

export function appPaths(root = dataDir()): AppPaths {
  return {
    root,
    config: join(root, 'config'),
    appDb: join(root, 'config', 'app.db'),
    credentials: join(root, 'credentials'),
    projects: join(root, 'projects'),
    runtime: join(root, 'runtime'),
    runtimeKernels: join(root, 'runtime', 'kernels'),
    runtimeEnvs: join(root, 'runtime', 'envs'),
    skillsBuiltin: join(root, 'skills', 'builtin'),
    skillsUser: join(root, 'skills', 'user'),
    logs: join(root, 'logs'),
  };
}

export interface ProjectPaths {
  root: string;
  db: string;
  blobs: string;
  workspace: string;
  logs: string;
}

export function projectPaths(projectId: string, root = dataDir()): ProjectPaths {
  const projectRoot = join(root, 'projects', projectId);
  return {
    root: projectRoot,
    db: join(projectRoot, 'project.db'),
    blobs: join(projectRoot, 'blobs'),
    workspace: join(projectRoot, 'workspace'),
    logs: join(projectRoot, 'logs'),
  };
}

/**
 * 内容寻址 blob 的相对路径：用 sha256 前两位做一级分桶，避免单目录下堆几十万文件。
 */
export function blobRelPath(sha256: string): string {
  if (sha256.length < 2) {
    throw new Error(`不是合法的 sha256：${sha256}`);
  }
  return join(sha256.slice(0, 2), sha256);
}
