/**
 * 内置技能的安装（任务 12.4，需求 9.7）。
 *
 * 内置技能的源在仓库的 `resources/skills/builtin`，运行时目标是数据目录下的
 * `skills/builtin`。为什么要复制而不是直接读源目录：
 *
 * - 用户需要能**看到**内置技能的写法，才能照着写自己的。数据目录是他会去翻的地方，
 *   而打包后的应用资源目录他找不到。
 * - `skills/user` 与 `skills/builtin` 并列，覆盖关系一目了然。
 *
 * 同步策略是**内置目录由平台完全拥有**：内容变了就覆盖，源里删掉的就删掉。
 * 用户想改内置技能应该复制到 `skills/user` 下同名 slug（那才是覆盖的正确方式），
 * 直接改 `skills/builtin` 的改动会在下次启动时丢失——这一点在 `customize` 技能里
 * 写明了。
 *
 * 不这样做的后果更糟：内置技能一旦被就地改过，平台升级带来的修正（比如某条统计
 * 判据写错了）就永远到不了这台机器，而没有任何地方会提示这件事。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface InstallResult {
  /** 源目录。找不到时为 null，此时什么都没做。 */
  sourceDir: string | null;
  installed: number;
  updated: number;
  removed: number;
  /** 逐个技能的失败原因。单个失败不影响其余。 */
  failures: ReadonlyArray<{ slug: string; reason: string }>;
}

/**
 * 定位内置技能的源目录。
 *
 * 三条路径依次尝试：环境变量覆盖（测试与打包用）、从当前模块向上找仓库里的
 * `resources/skills/builtin`、Electron 打包后的 `process.resourcesPath`。
 */
export function findBuiltinSkillSource(fromDir: string): string | null {
  const override = process.env['L_SCIENCE_BUILTIN_SKILLS'];
  if (override !== undefined && override !== '' && existsSync(override)) return override;

  // 从 packages/core/dist 往上找到仓库根。深度上限防止在文件系统根上打转
  let dir = resolve(fromDir);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'resources', 'skills', 'builtin');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const packaged = (process as { resourcesPath?: string }).resourcesPath;
  if (packaged !== undefined) {
    const candidate = join(packaged, 'skills', 'builtin');
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** 目录内容的指纹。用于判断是否需要覆盖，避免每次启动都重写文件。 */
function fingerprint(dir: string): string {
  const hash = createHash('sha256');

  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full, rel);
      } else if (entry.isFile()) {
        // 内容而不是 mtime：复制过去的文件 mtime 必然不同，用 mtime 会导致每次都覆盖
        hash.update(`F:${rel}:`);
        hash.update(readFileSync(full));
        hash.update('\n');
      }
    }
  };

  walk(dir, '');
  return hash.digest('hex');
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) copyFileSync(src, dst);
  }
}

/**
 * 把内置技能安装（或更新）到目标目录。
 *
 * 幂等：内容未变时不写任何文件。这一点对启动路径很重要——三十几个技能每次启动都
 * 重写一遍是几百次文件写入，而且会让「用户是不是改过内置技能」这个问题无从判断。
 */
export function installBuiltinSkills(input: {
  targetDir: string;
  /** 源目录。省略时自动定位。 */
  sourceDir?: string | null;
  /** 用于自动定位的起点，通常是当前模块所在目录。 */
  fromDir?: string;
  onLog?: (line: string) => void;
}): InstallResult {
  const onLog = input.onLog ?? ((): void => {});
  const sourceDir =
    input.sourceDir === undefined
      ? findBuiltinSkillSource(input.fromDir ?? process.cwd())
      : input.sourceDir;

  if (sourceDir === null || !existsSync(sourceDir)) {
    onLog('未找到内置技能源目录，跳过安装');
    return { sourceDir: null, installed: 0, updated: 0, removed: 0, failures: [] };
  }

  mkdirSync(input.targetDir, { recursive: true });

  const failures: Array<{ slug: string; reason: string }> = [];
  let installed = 0;
  let updated = 0;
  let removed = 0;

  const sourceSlugs = readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const slug of sourceSlugs) {
    const src = join(sourceDir, slug);
    const dst = join(input.targetDir, slug);

    try {
      if (!existsSync(dst)) {
        copyTree(src, dst);
        installed += 1;
        continue;
      }

      if (fingerprint(src) === fingerprint(dst)) continue;

      // 先删再拷：源里删掉某个 reference 文件时，只拷不删会留下一个孤儿文件，
      // 而它仍然会出现在技能的 references 列表里
      rmSync(dst, { recursive: true, force: true });
      copyTree(src, dst);
      updated += 1;
    } catch (err) {
      failures.push({ slug, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // 源里已不存在的内置技能要删掉。内置目录由平台拥有，留着它会让一个已被撤下的
  // （可能是因为内容有错的）技能继续被检索到
  const shipped = new Set(sourceSlugs);
  for (const entry of readdirSync(input.targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || shipped.has(entry.name)) continue;
    try {
      rmSync(join(input.targetDir, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      failures.push({
        slug: entry.name,
        reason: `删除已下架的内置技能失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (installed + updated + removed > 0) {
    onLog(
      `内置技能同步：新增 ${String(installed)}，更新 ${String(updated)}，移除 ${String(removed)}`,
    );
  }
  for (const failure of failures) {
    onLog(`内置技能 ${failure.slug} 同步失败：${failure.reason}`);
  }

  return { sourceDir, installed, updated, removed, failures };
}

/** 源目录里有多少个内置技能。用于自检脚本核对数量。 */
export function countBuiltinSkills(sourceDir: string): number {
  if (!existsSync(sourceDir)) return 0;
  return readdirSync(sourceDir, { withFileTypes: true }).filter((e) => {
    if (!e.isDirectory()) return false;
    const dir = join(sourceDir, e.name);
    return existsSync(join(dir, 'skill.json')) && existsSync(join(dir, 'SKILL.md'));
  }).length;
}

/** 目录是否存在且是目录。供调用方在安装前做基本检查。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
