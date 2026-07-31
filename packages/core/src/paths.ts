/**
 * 数据目录布局。见设计文档「数据目录布局」一节。
 *
 * 所有路径都从 %LOCALAPPDATA%\L-science 派生。允许用 L_SCIENCE_DATA_DIR 覆盖，
 * 测试与多实例并行需要这个逃生口。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_DIR_NAME = 'L-science';

export function dataDir(): string {
  const override = process.env['L_SCIENCE_DATA_DIR'];
  if (override !== undefined && override !== '') return override;

  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData !== undefined && localAppData !== '') {
    return join(localAppData, APP_DIR_NAME);
  }
  // 非 Windows 或环境变量缺失时的回退，保持跨平台可测试性。
  return join(homedir(), '.l-science');
}

export interface AppPaths {
  root: string;
  config: string;
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
