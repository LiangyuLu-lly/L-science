/**
 * 技能写入原语（任务 12.15，需求 9.6）。
 *
 * 五条创建/导入路径（模型生成、手写、上传压缩包、导入目录、从 GitHub 拉、从会话蒸馏）
 * 最终都落到这里的两个函数上：`validateSkillFiles` 与 `writeUserSkill`。
 *
 * ## 为什么先在临时目录里组装再原子换入
 *
 * 校验一个技能能不能用，唯一可靠的办法是**用 `loadSkill` 真的加载一次**——
 * 只跑 `parseSkillManifest` 会漏掉「SKILL.md 只有 front matter 没有正文」、
 * 「声明了 provider 但没有 provider.py」这类只有加载器知道的问题。
 *
 * 但如果直接往 `skills/user/<slug>` 写然后再加载校验，校验失败时用户原来那个
 * 能用的同名技能已经被破坏了：他失去的是一个能用的技能，换来一条错误消息。
 * 因此顺序是「临时目录组装 → 加载校验 → 原子换入 → 删备份」，任何一步失败都
 * 回到写入前的状态。
 *
 * ## 为什么写 `origin.json`
 *
 * 技能来源要留痕：从 GitHub 拉来的技能与自己写的技能，在「能不能相信它的方法学」
 * 上完全不是一回事，而半年后没人记得某个技能是哪来的。放在技能目录里而不是数据库里，
 * 是因为它跟着技能一起被复制、导出、备份——放数据库里的话，导出的技能包丢了来源。
 *
 * 加载器只从 `references/` 与 `scripts/` 收文件，根目录多一个 json 不影响它。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { loadSkill } from './loader.js';
import {
  isValidSlug,
  parseFrontMatter,
  parseSkillManifest,
  SkillManifestError,
} from './manifest.js';
import type { LoadedSkill, SkillManifest } from './manifest.js';

/* ------------------------------------------------------------------ *
 * 来源
 * ------------------------------------------------------------------ */

/**
 * 技能是怎么来的。
 *
 * 这几个值刻意分得细：`authored`（用户自己写）与 `model`（对话里模型生成）在
 * 「方法学由谁负责」上不同，而 `github` 与 `archive` 在「能不能重新拉一次更新」
 * 上不同。合并成一个「导入」会让这些区别在 UI 上消失。
 */
export type SkillOriginKind =
  'authored' | 'model' | 'archive' | 'directory' | 'github' | 'distilled';

export interface SkillOrigin {
  kind: SkillOriginKind;
  /** 人可读的来源说明。GitHub 是 `owner/repo@ref`，蒸馏是会话 id。 */
  source: string | null;
  /** 补充说明。模型生成时是模型标识，蒸馏时是被蒸馏的消息条数。 */
  detail: string | null;
  createdAt: number;
  /** 内容指纹。用于判断导入后是否被本地改过。 */
  contentSha256: string | null;
}

const ORIGIN_FILE = 'origin.json';

/** 读一个技能目录的来源记录。没有或损坏时返回 null。 */
export function readSkillOrigin(dir: string): SkillOrigin | null {
  const path = join(dir, ORIGIN_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    const kinds: readonly string[] = [
      'authored',
      'model',
      'archive',
      'directory',
      'github',
      'distilled',
    ];
    if (!kinds.includes(kind)) return null;
    return {
      kind: kind as SkillOriginKind,
      source: typeof raw.source === 'string' ? raw.source : null,
      detail: typeof raw.detail === 'string' ? raw.detail : null,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      contentSha256: typeof raw.contentSha256 === 'string' ? raw.contentSha256 : null,
    };
  } catch {
    // 来源记录损坏不该让技能不可用——它是元数据，不是技能本体
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 文件集合
 * ------------------------------------------------------------------ */

/**
 * 一个技能的全部文件，键是相对技能目录的路径（一律用 `/` 分隔）。
 *
 * 值允许 `Buffer` 是必须的：导入进来的技能可能带二进制参考材料（示例数据、图），
 * 全部按 utf8 字符串处理会把它们悄悄改坏，而那种损坏要到用户打开文件时才发现。
 */
export type SkillFileMap = Readonly<Record<string, Buffer | string>>;

/** 技能目录根下允许出现的文件。 */
const ROOT_FILES: readonly string[] = ['skill.json', 'SKILL.md', 'provider.json', 'provider.py'];

/** 单个文件名允许的字符。刻意不含空格：跨平台与命令行里都是麻烦来源。 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** 导入时直接丢掉的目录：它们与技能内容无关，只会撑大体积。 */
const SKIP_DIRS: readonly string[] = [
  '.git',
  '.github',
  '.gitlab',
  '.vscode',
  '.idea',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'build',
];

export const SKILL_LIMITS = {
  /** 文件数上限。 */
  maxFiles: 200,
  /** 单文件字节上限。与 `readSkillReference` 的注入上限同量级。 */
  maxFileBytes: 2 * 1024 * 1024,
  /** 全部文件合计字节上限。 */
  maxTotalBytes: 16 * 1024 * 1024,
  /** 目录深度上限（`references/a/b.md` 算 3 段）。 */
  maxDepth: 4,
} as const;

export interface ValidateResult {
  ok: boolean;
  /** 阻止写入的问题。 */
  errors: readonly string[];
  /** 不阻止写入但要让用户看到的问题。 */
  warnings: readonly string[];
  /** 校验通过时给出解析后的清单。 */
  manifest: SkillManifest | null;
}

function toBuffer(value: Buffer | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

/** 校验一个相对路径能不能作为技能内的文件。 */
function checkRelPath(rel: string): string | null {
  if (rel.includes('\\')) return `路径 ${rel} 含反斜杠，请统一用 /`;
  const segments = rel.split('/');
  if (segments.length > SKILL_LIMITS.maxDepth) {
    return `路径 ${rel} 层级过深（上限 ${String(SKILL_LIMITS.maxDepth)} 段）`;
  }
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return `路径 ${rel} 含非法路径段`;
    if (!SEGMENT_RE.test(seg)) {
      return `路径段 ${JSON.stringify(seg)} 不合法：只允许字母、数字、点、下划线与连字符，且不能以点开头`;
    }
  }
  if (segments.length === 1 && !ROOT_FILES.includes(rel)) {
    return `根目录下只能有 ${ROOT_FILES.join('、')}，多出来的 ${rel} 请放进 references/ 或 scripts/`;
  }
  return null;
}

/**
 * 校验一组文件能不能构成一个可用技能。
 *
 * 这里只做**不需要落盘就能做的检查**（路径、大小、清单本体）。结构性检查
 * （SKILL.md 有没有正文、provider 声明与实现是否配对）由 `writeUserSkill` 里的
 * 真实加载完成——那些检查复刻一遍就会与加载器漂移。
 */
export function validateSkillFiles(files: SkillFileMap): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const names = Object.keys(files);
  if (names.length === 0) return { ok: false, errors: ['没有任何文件'], warnings, manifest: null };
  if (names.length > SKILL_LIMITS.maxFiles) {
    errors.push(`文件数 ${String(names.length)} 超过上限 ${String(SKILL_LIMITS.maxFiles)}`);
  }

  let total = 0;
  for (const rel of names) {
    const bad = checkRelPath(rel);
    if (bad !== null) {
      errors.push(bad);
      continue;
    }
    const size = toBuffer(files[rel] ?? '').byteLength;
    if (size > SKILL_LIMITS.maxFileBytes) {
      errors.push(
        `${rel} 有 ${String(Math.round(size / 1024))} KB，超过单文件上限 ` +
          `${String(SKILL_LIMITS.maxFileBytes / 1024 / 1024)} MB`,
      );
    }
    total += size;
  }
  if (total > SKILL_LIMITS.maxTotalBytes) {
    errors.push(
      `合计 ${String(Math.round(total / 1024 / 1024))} MB，超过上限 ` +
        `${String(SKILL_LIMITS.maxTotalBytes / 1024 / 1024)} MB`,
    );
  }

  // 两个必需文件。缺任一 `loadSkill` 都会抛错，提前说清楚比让它抛更有指向性
  if (files['skill.json'] === undefined) errors.push('缺少 skill.json');

  const skillMd = files['SKILL.md'];
  if (skillMd === undefined) {
    errors.push('缺少 SKILL.md。技能没有主指令文档就无法注入上下文');
  } else if (parseFrontMatter(toBuffer(skillMd).toString('utf8')).body.trim() === '') {
    /*
     * 正文为空在**创建时是错误**，而加载器只把它当警告。
     *
     * 两者不一致是刻意的：加载器面对的是磁盘上已经存在的技能，把它变成错误等于
     * 让一个能被修好的技能直接消失；而创建时拒绝，防的是「保存了一个命中后什么都
     * 不注入的技能」——它会出现在检索结果里，占掉一个候选位，然后什么也不提供。
     */
    errors.push(
      'SKILL.md 除 front matter 之外没有正文。命中这个技能时注入的内容会是空的，' +
        '它只会占掉一个检索候选位',
    );
  }

  let manifest: SkillManifest | null = null;
  const manifestRaw = files['skill.json'];
  if (manifestRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toBuffer(manifestRaw).toString('utf8'));
    } catch (err) {
      errors.push(`skill.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      try {
        manifest = parseSkillManifest(parsed, 'skill.json');
      } catch (err) {
        errors.push(err instanceof SkillManifestError ? err.message : String(err));
      }
    }
  }

  if (manifest !== null) {
    // 清单里声明的工具在这一层无从核对（注册表是运行期的），但空 tools 值得提一句
    if (manifest.triggers.length < 3) {
      warnings.push(
        `只有 ${String(manifest.triggers.length)} 条 triggers。它决定检索能否命中，` +
          '建议写三条以上、覆盖用户可能的不同说法',
      );
    }
    if (manifest.domain === null) {
      warnings.push('没有 domain，设置页里会归到未分类');
    }
  }

  // provider 配对：这里能查，因为不需要落盘
  const hasProviderJson = files['provider.json'] !== undefined;
  const hasProviderPy = files['provider.py'] !== undefined;
  if (hasProviderJson && !hasProviderPy) {
    warnings.push('有 provider.json 但没有 provider.py，启用该供应商后调用必然失败');
  }
  if (hasProviderPy && !hasProviderJson) {
    warnings.push('有 provider.py 但没有 provider.json，平台不知道该怎么调用它');
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

/* ------------------------------------------------------------------ *
 * 内容审查
 * ------------------------------------------------------------------ */

/**
 * 检查技能正文里有没有**一次性细节**。
 *
 * 与记忆服务的准入判定同一个道理：技能是可复用的方法学，写进具体机器的路径、
 * 某次运行的制品版本号、某次分析的具体数值，会让它在别的场合失效——而失效的方式
 * 是「照着做但结果对不上」，那比明确报错难查得多。
 *
 * 蒸馏路径（从历史会话生成技能）最容易犯这些错，因为它的输入就是一次具体的分析。
 *
 * 只报警告不拒绝：技能里举个带数字的例子是合理的，而这里分不清「例子」与「结论」。
 */
export function auditSkillContent(instructions: string): readonly string[] {
  const warnings: string[] = [];

  const absWin = /\b[A-Za-z]:[\\/](?:[^\s"'`]+)/g;
  const absNix = /(?:^|[\s"'`(])(\/(?:home|Users|mnt|media|opt|srv)\/[^\s"'`)]+)/g;
  const paths = [
    ...new Set([
      ...(instructions.match(absWin) ?? []),
      ...[...instructions.matchAll(absNix)].map((m) => m[1] ?? ''),
    ]),
  ].filter((p) => p !== '');
  if (paths.length > 0) {
    warnings.push(
      `正文里有 ${String(paths.length)} 个具体机器上的绝对路径（如 ${paths[0] ?? ''}）。` +
        '技能要在别人的机器上也能用，路径应当写成参数或相对工作区的位置',
    );
  }

  const artifacts = [...new Set(instructions.match(/\bav_[0-9a-f-]{8,}/g) ?? [])];
  if (artifacts.length > 0) {
    warnings.push(
      `正文里引用了具体的制品版本 ${artifacts.slice(0, 3).join('、')}。` +
        '那是某一次运行的产物，换个项目就不存在了',
    );
  }

  // 会话指代：技能是独立文档，读它的人看不到「上面」是什么
  const deictic = ['刚才', '上面那个', '这次分析', '本次运行', '前面提到的', '我们刚'];
  const hit = deictic.filter((d) => instructions.includes(d));
  if (hit.length > 0) {
    warnings.push(`正文里有会话指代（${hit.join('、')}）。技能是独立文档，读它的人看不到上文`);
  }

  return warnings;
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 一组文件的内容指纹。用于判断导入后是否被本地改过。 */
export function skillFingerprint(files: SkillFileMap): string {
  const hash = createHash('sha256');
  for (const rel of Object.keys(files).sort()) {
    hash.update(`${rel}:`);
    hash.update(toBuffer(files[rel] ?? ''));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export interface WriteSkillInput {
  /** 用户技能根目录，通常是 `store.paths.skillsUser`。 */
  userDir: string;
  files: SkillFileMap;
  origin: Omit<SkillOrigin, 'createdAt' | 'contentSha256'>;
  /** 同名技能已存在时是否覆盖。默认不覆盖。 */
  overwrite?: boolean;
  /** 内置技能的 slug 集合。用于提示「这会遮蔽某个内置技能」。 */
  builtinSlugs?: ReadonlySet<string>;
}

export interface WriteSkillResult {
  ok: boolean;
  slug: string | null;
  path: string | null;
  errors: readonly string[];
  warnings: readonly string[];
  /** 是否覆盖了一个已存在的用户技能。 */
  replaced: boolean;
  /** 是否遮蔽了一个内置技能。 */
  shadowsBuiltin: boolean;
}

/**
 * 把一组文件写成一个用户技能。
 *
 * **只写 `skills/user`。** 写进 `skills/builtin` 的内容会在下次启动被
 * `installBuiltinSkills` 删掉（那个目录由平台完全拥有），而那种消失没有任何报错。
 */
export function writeUserSkill(input: WriteSkillInput): WriteSkillResult {
  const fail = (errors: readonly string[], warnings: readonly string[] = []): WriteSkillResult => ({
    ok: false,
    slug: null,
    path: null,
    errors,
    warnings,
    replaced: false,
    shadowsBuiltin: false,
  });

  const validated = validateSkillFiles(input.files);
  if (!validated.ok || validated.manifest === null) {
    return fail(validated.errors, validated.warnings);
  }
  const slug = validated.manifest.slug;
  if (!isValidSlug(slug)) return fail([`slug ${slug} 不合法`]);

  const warnings = [...validated.warnings];
  const target = join(input.userDir, slug);
  const exists = existsSync(target);
  if (exists && input.overwrite !== true) {
    return fail([
      `已存在同名的用户技能 ${slug}。要替换它请显式选择覆盖——` +
        '静默覆盖会让用户自己改过的版本无声消失',
    ]);
  }

  mkdirSync(input.userDir, { recursive: true });

  /*
   * 临时目录建在 userDir 的同级而不是系统临时目录：换入用的是 rename，
   * 而 rename 跨卷会失败（Windows 上 EXDEV）。技能目录可能在 D 盘而临时目录在 C 盘。
   */
  const stagingRoot = mkdtempSync(join(input.userDir, `.staging-${slug}-`));
  const staging = join(stagingRoot, slug);
  let backup: string | null = null;

  try {
    for (const rel of Object.keys(input.files)) {
      const dest = join(staging, ...rel.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, toBuffer(input.files[rel] ?? ''));
    }

    const originRecord: SkillOrigin = {
      ...input.origin,
      createdAt: Date.now(),
      contentSha256: skillFingerprint(input.files),
    };
    writeFileSync(join(staging, ORIGIN_FILE), `${JSON.stringify(originRecord, null, 2)}\n`, 'utf8');

    // 真实加载一次。这是唯一能保证「写进去的技能确实能被加载」的检查
    let loaded: LoadedSkill;
    try {
      loaded = loadSkill(staging, 'user');
    } catch (err) {
      return fail([`技能无法加载：${err instanceof Error ? err.message : String(err)}`], warnings);
    }
    warnings.push(...loaded.warnings);
    warnings.push(...auditSkillContent(loaded.instructions));

    if (exists) {
      backup = `${target}.backup-${randomUUID().slice(0, 8)}`;
      renameSync(target, backup);
    }
    renameSync(staging, target);

    // 到这一步才删备份：删早了的话换入失败就没法回退
    if (backup !== null) {
      rmSync(backup, { recursive: true, force: true });
      backup = null;
    }

    return {
      ok: true,
      slug,
      path: target,
      errors: [],
      warnings,
      replaced: exists,
      shadowsBuiltin: input.builtinSlugs?.has(slug) ?? false,
    };
  } catch (err) {
    // 换入过程中失败：把备份改回去，用户手里那个能用的技能不能因为一次失败的导入消失
    if (backup !== null && !existsSync(target)) {
      try {
        renameSync(backup, target);
        backup = null;
      } catch {
        // 连回退都失败时把备份路径报出来，用户至少能手工恢复
        return fail(
          [
            `写入失败且回退失败：${err instanceof Error ? err.message : String(err)}。` +
              `原技能已备份在 ${backup ?? ''}`,
          ],
          warnings,
        );
      }
    }
    return fail([`写入失败：${err instanceof Error ? err.message : String(err)}`], warnings);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    if (backup !== null) rmSync(backup, { recursive: true, force: true });
  }
}

/**
 * 删除一个用户技能。
 *
 * 只删用户作用域。内置技能不可删只可禁用——删了它下次启动会被同步回来，
 * 那只会让状态看起来不一致（与内置连接器同一个道理）。
 */
export function removeUserSkill(userDir: string, slug: string): { ok: boolean; reason?: string } {
  if (!isValidSlug(slug)) return { ok: false, reason: `slug 不合法：${slug}` };
  const dir = join(userDir, slug);
  if (!existsSync(dir)) return { ok: false, reason: `用户技能不存在：${slug}` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * 从磁盘读回文件集合
 * ------------------------------------------------------------------ */

export interface ReadTreeResult {
  files: SkillFileMap;
  /** 被跳过的条目（构建产物目录、超限文件、非法名字）。 */
  skipped: readonly string[];
}

/**
 * 把一个技能目录读成文件集合。
 *
 * 导入本机目录与从压缩包解出来之后都走这里，于是「导入」与「新建」共用同一套
 * 校验与原子写入。跳过的条目要报出来而不是静默丢掉：一个被跳过的 reference
 * 会让技能文档里引用的材料打不开。
 */
export function readSkillTree(dir: string): ReadTreeResult {
  const files: Record<string, Buffer> = {};
  const skipped: string[] = [];

  const walk = (current: string, prefix: string, depth: number): void => {
    if (depth > SKILL_LIMITS.maxDepth) {
      skipped.push(`${prefix}（层级过深）`);
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      skipped.push(`${prefix}（读取失败：${err instanceof Error ? err.message : String(err)}）`);
      return;
    }

    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);

      if (entry.isSymbolicLink()) {
        // 符号链接会把技能目录之外的东西带进来
        skipped.push(`${rel}（符号链接）`);
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('.')) {
          skipped.push(`${rel}/（无关目录）`);
          continue;
        }
        walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(`${rel}（不是普通文件）`);
        continue;
      }
      if (entry.name === ORIGIN_FILE && prefix === '') continue; // 来源由本次导入重写

      const bad = checkRelPath(rel);
      if (bad !== null) {
        skipped.push(`${rel}（${bad}）`);
        continue;
      }
      try {
        const size = statSync(full).size;
        if (size > SKILL_LIMITS.maxFileBytes) {
          skipped.push(`${rel}（${String(Math.round(size / 1024))} KB，超过单文件上限）`);
          continue;
        }
        files[rel] = readFileSync(full);
      } catch (err) {
        skipped.push(`${rel}（读取失败：${err instanceof Error ? err.message : String(err)}）`);
      }
    }
  };

  walk(dir, '', 1);
  return { files, skipped };
}

/**
 * 在一棵目录树里找出所有技能目录。
 *
 * 一个仓库可能在根上就是一个技能，也可能在 `skills/<slug>/` 下放一批。GitHub 的
 * tarball 还会多一层 `owner-repo-<sha>/`。因此要往下找而不是只看根，
 * 但**找到一个技能目录之后不再往里找**——技能自己的 `references/` 里不会再有技能。
 */
export function findSkillRoots(root: string, maxDepth = 4): readonly string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (existsSync(join(dir, 'skill.json')) && existsSync(join(dir, 'SKILL.md'))) {
      found.push(dir);
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 1);
  return found.sort();
}
