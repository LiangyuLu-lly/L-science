/**
 * findBuiltinSkillSource 的定位契约。
 *
 * 打包后的 sidecar 是系统 Node，没有 Electron 的 `process.resourcesPath`。
 * 那种进程只能靠 `L_SCIENCE_BUILTIN_SKILLS` 找到内置技能；walk-up 只服务仓库开发树。
 * 这里锁的是「三条路径的优先级」，不是安装覆盖策略。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findBuiltinSkillSource } from '@l-science/core';

const ENV = 'L_SCIENCE_BUILTIN_SKILLS';

describe('findBuiltinSkillSource', () => {
  let root: string;
  const savedEnv = process.env[ENV];
  const proc: { resourcesPath?: string } = process;
  const savedResourcesPath = proc.resourcesPath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsci-builtin-src-'));
    delete process.env[ENV];
    delete proc.resourcesPath;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    if (savedResourcesPath === undefined) delete proc.resourcesPath;
    else proc.resourcesPath = savedResourcesPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('L_SCIENCE_BUILTIN_SKILLS 指向已存在目录时优先于 walk-up', () => {
    const walkUp = join(root, 'resources', 'skills', 'builtin');
    mkdirSync(walkUp, { recursive: true });
    const override = join(root, 'override-skills');
    mkdirSync(override, { recursive: true });
    const fromDir = join(root, 'packages', 'core', 'dist');
    mkdirSync(fromDir, { recursive: true });

    process.env[ENV] = override;

    expect(findBuiltinSkillSource(fromDir)).toBe(override);
  });

  it('环境变量未设时从 fromDir 向上找到 resources/skills/builtin', () => {
    const builtin = join(root, 'resources', 'skills', 'builtin');
    mkdirSync(builtin, { recursive: true });
    const fromDir = join(root, 'packages', 'core', 'dist');
    mkdirSync(fromDir, { recursive: true });

    expect(findBuiltinSkillSource(fromDir)).toBe(resolve(builtin));
  });

  it('环境变量未设、walk-up 找不到、且没有 process.resourcesPath 时返回 null', () => {
    // 深度足够：8 次向上走完仍停在临时树里，不会误撞到仓库或用户目录里的同名路径
    const fromDir = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    mkdirSync(fromDir, { recursive: true });

    expect(findBuiltinSkillSource(fromDir)).toBeNull();
  });

  it('环境变量指向不存在的路径时回落到 walk-up', () => {
    const builtin = join(root, 'resources', 'skills', 'builtin');
    mkdirSync(builtin, { recursive: true });
    const fromDir = join(root, 'packages', 'core', 'dist');
    mkdirSync(fromDir, { recursive: true });

    process.env[ENV] = join(root, 'missing-override');

    expect(findBuiltinSkillSource(fromDir)).toBe(resolve(builtin));
  });
});
