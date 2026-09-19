/**
 * 技能加载与作用域（任务 12.1，需求 9.1、9.2、9.6）。
 *
 * 两个作用域：`builtin`（随平台分发）与 `user`（用户自建）。同名时用户胜出。
 *
 * 覆盖必须是**整体替换而非字段合并**。合并听起来更灵活，实际会造出一个
 * 「一半是内置一半是用户」的技能：SKILL.md 来自用户、requires 来自内置，
 * 于是文档说的做法与实际检查的依赖对不上，而这种不一致没有任何地方会报出来。
 * 用户想改一个字段就把整份拿过去改，代价是复制一次，收益是行为可预测。
 *
 * 加载失败的技能**不会让整次扫描失败**，而是收进 `broken` 一并报告。一个手写
 * 的用户技能里少个逗号不该让全部三十几个内置技能一起消失。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  crossCheckFrontMatter,
  parseFrontMatter,
  parseSkillManifest,
  parseSkillProvider,
  SkillManifestError,
  type LoadedSkill,
  type SkillScope,
} from './manifest.js';

export interface BrokenSkill {
  /** 技能目录路径。 */
  path: string;
  scope: SkillScope;
  /** 目录名。清单坏掉时它是唯一能用的标识。 */
  dirName: string;
  reason: string;
}

export interface SkillCatalog {
  /** 生效的技能，按 slug 索引。用户技能已覆盖同名内置技能。 */
  skills: ReadonlyMap<string, LoadedSkill>;
  /** 被用户技能遮蔽的内置技能。要能查到，否则「我的改动生效了吗」无从确认。 */
  shadowed: readonly LoadedSkill[];
  broken: readonly BrokenSkill[];
  /**
   * 清单合法但不进入生效目录的技能。必须带原因展示，不能静默省略。
   */
  unavailable: readonly LoadedSkill[];
}

/**
 * 内置技能的目录拒绝名单。skill.json 的 unavailableReason 优先；
 * 这里是防止有人删掉字段后 pdf-explore 又被当成可用技能检索到。
 */
const CATALOG_UNAVAILABLE: Readonly<Record<string, string>> = {};

function catalogUnavailableReason(raw: unknown, slug: string, scope: SkillScope): string | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'unavailableReason' in raw) {
    const value = raw.unavailableReason;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  if (scope === 'builtin') {
    const denylist = CATALOG_UNAVAILABLE[slug];
    if (denylist !== undefined) return denylist;
  }
  return null;
}

export interface LoadSkillsOptions {
  builtinDir: string;
  userDir: string;
}

function listDirs(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 加载单个技能目录。抛 SkillManifestError 表示这个技能不可用。 */
export function loadSkill(dir: string, scope: SkillScope): LoadedSkill {
  const manifestPath = join(dir, 'skill.json');
  if (!existsSync(manifestPath)) {
    throw new SkillManifestError(dir, '缺少 skill.json');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new SkillManifestError(
      manifestPath,
      `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const manifest = parseSkillManifest(raw, manifestPath);

  const skillMdPath = join(dir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    throw new SkillManifestError(dir, '缺少 SKILL.md，技能没有主指令文档就无法注入上下文');
  }
  const front = parseFrontMatter(readFileSync(skillMdPath, 'utf8'));

  const warnings: string[] = [...crossCheckFrontMatter(manifest, front)];

  // 目录名与 slug 不一致是个陷阱：覆盖是按 slug 判定的，而人是按目录名找文件的
  const dirName =
    dir
      .split(/[\\/]/)
      .filter((s) => s !== '')
      .at(-1) ?? '';
  if (dirName !== manifest.slug) {
    warnings.push(
      `目录名 ${dirName} 与 slug ${manifest.slug} 不一致。覆盖是按 slug 判定的，` +
        '目录名对不上会让人以为改的是另一个技能',
    );
  }

  const body = front.body.trim();
  if (body === '') {
    warnings.push('SKILL.md 除 front matter 之外没有正文，命中后注入的内容会是空的');
  }

  /* ---------------- BYOC 供应商（可选）---------------- */

  const providerJsonPath = join(dir, 'provider.json');
  const providerPyPath = join(dir, 'provider.py');
  const hasProviderJson = existsSync(providerJsonPath);
  const hasProviderPy = existsSync(providerPyPath);

  let provider = null as ReturnType<typeof parseSkillProvider> | null;
  let providerScript: string | null = null;

  if (hasProviderJson) {
    let providerRaw: unknown;
    try {
      providerRaw = JSON.parse(readFileSync(providerJsonPath, 'utf8'));
    } catch (err) {
      throw new SkillManifestError(
        providerJsonPath,
        `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    provider = parseSkillProvider(providerRaw, providerJsonPath);

    if (hasProviderPy) {
      providerScript = providerPyPath;
    } else {
      /*
       * 有声明没有实现。
       *
       * 这条必须在加载时就报出来：UI 会把它显示成一个可配置的供应商，用户填完
       * 几个字段（可能含凭据）之后调用才失败，而那时的报错来自 Python 侧的
       * ImportError，与「声明写错了」这个真实原因完全对不上。
       */
      warnings.push('provider.json 声明了供应商但目录里没有 provider.py，启用后调用必然失败');
    }
  } else if (hasProviderPy) {
    // 反过来也要报：光有实现没有声明的话平台无从知道该调哪个函数、要用户填什么
    warnings.push('目录里有 provider.py 但没有 provider.json，平台不知道该怎么调用它');
  }

  return {
    manifest,
    scope,
    path: dir,
    instructions: body,
    references: listFiles(join(dir, 'references')),
    scripts: listFiles(join(dir, 'scripts')),
    provider,
    providerScript,
    warnings,
    unavailableReason: catalogUnavailableReason(raw, manifest.slug, scope),
  };
}

/** 扫描一个作用域目录。 */
function loadScope(
  root: string,
  scope: SkillScope,
): { loaded: LoadedSkill[]; broken: BrokenSkill[] } {
  const loaded: LoadedSkill[] = [];
  const broken: BrokenSkill[] = [];

  for (const dirName of listDirs(root)) {
    const dir = join(root, dirName);
    try {
      loaded.push(loadSkill(dir, scope));
    } catch (err) {
      broken.push({
        path: dir,
        scope,
        dirName,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { loaded, broken };
}

/**
 * 扫描两个作用域并合成目录。
 *
 * 同一作用域内 slug 重复（两个目录写了同一个 slug）按先出现者胜出并记为坏技能：
 * 静默让后者覆盖前者会让「我改了 A 目录却没生效」完全无从解释。
 */
export function loadSkillCatalog(options: LoadSkillsOptions): SkillCatalog {
  const builtin = loadScope(options.builtinDir, 'builtin');
  const user = loadScope(options.userDir, 'user');
  const broken: BrokenSkill[] = [...builtin.broken, ...user.broken];

  const collect = (list: readonly LoadedSkill[]): Map<string, LoadedSkill> => {
    const map = new Map<string, LoadedSkill>();
    for (const skill of list) {
      const existing = map.get(skill.manifest.slug);
      if (existing !== undefined) {
        broken.push({
          path: skill.path,
          scope: skill.scope,
          dirName: skill.path.split(/[\\/]/).at(-1) ?? '',
          reason:
            `slug ${skill.manifest.slug} 与 ${existing.path} 重复。` +
            '同一作用域内 slug 必须唯一，否则改动落在哪个目录上无从判断',
        });
        continue;
      }
      map.set(skill.manifest.slug, skill);
    }
    return map;
  };

  const builtinMap = collect(builtin.loaded);
  const userMap = collect(user.loaded);

  const skills = new Map<string, LoadedSkill>(builtinMap);
  const shadowed: LoadedSkill[] = [];

  for (const [slug, skill] of userMap) {
    const overridden = builtinMap.get(slug);
    if (overridden !== undefined) shadowed.push(overridden);
    skills.set(slug, skill);
  }

  const unavailable: LoadedSkill[] = [];
  for (const [slug, skill] of [...skills]) {
    if (skill.unavailableReason !== null) {
      unavailable.push(skill);
      skills.delete(slug);
    }
  }

  return { skills, shadowed, broken, unavailable };
}

/**
 * 读取技能的一份参考材料（需求 9.5 的「按需二次加载」）。
 *
 * 路径必须落在该技能的 `references/` 里。这不是形式主义：`name` 来自模型的
 * 输出，一个 `../../../credentials/vault.bin` 就能把凭据库读成上下文。
 */
export function readSkillReference(
  skill: LoadedSkill,
  name: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!skill.references.includes(name)) {
    return {
      ok: false,
      reason:
        skill.references.length === 0
          ? `技能 ${skill.manifest.slug} 没有参考材料`
          : `技能 ${skill.manifest.slug} 没有名为 ${name} 的参考材料。可用：${skill.references.join('、')}`,
    };
  }

  const full = join(skill.path, 'references', name);
  try {
    const info = statSync(full);
    // 参考材料是要塞进上下文的，超大文件塞进去只会挤掉真正的内容
    if (info.size > 512 * 1024) {
      return {
        ok: false,
        reason: `${name} 有 ${String(Math.round(info.size / 1024))} KB，太大不适合注入上下文。请用 read_file 分段读`,
      };
    }
    return { ok: true, content: readFileSync(full, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
