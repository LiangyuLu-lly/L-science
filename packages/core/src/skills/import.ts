/**
 * 技能导入（任务 12.15，需求 9.6）。
 *
 * 三条「从外部拿技能」的路径共用一套后半程：认出技能 → 校验 → 原子写入
 * `skills/user`。差别只在前半程怎么拿到文件。
 *
 * ## 一次导入可能带进来多个技能
 *
 * 一个仓库或压缩包里放一批技能是常见做法。因此导入的返回值是**逐个技能的结果**
 * 而不是一个总的成功/失败：其中一个技能的 `skill.json` 写错了，不该让另外五个
 * 也导不进来，而「全部失败」会让用户去猜是哪个坏的。
 *
 * ## GitHub 与出口管控
 *
 * 后端进程直接 `fetch` 不经出口代理（那一层管的是内核里的代码）。所以从 GitHub
 * 拉东西必须**显式**过一遍域名授权：`authorizeHost` 由调用方注入，backend 在那里
 * 接域名白名单与审批。不接的话就出现了一条绕过全部出网管控的路径，而它恰好还能
 * 往用户机器上写可执行脚本（技能可以带 `scripts/*.py`）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { findArchivedSkills, readArchive, ArchiveError } from './archive.js';
import {
  findSkillRoots,
  readSkillTree,
  writeUserSkill,
  type SkillFileMap,
  type SkillOrigin,
  type WriteSkillResult,
} from './authoring.js';

/* ------------------------------------------------------------------ *
 * 结果形状
 * ------------------------------------------------------------------ */

export interface ImportedSkill extends WriteSkillResult {
  /** 这个技能在归档或目录里的位置。用于在多技能导入时指认是哪一个。 */
  location: string;
}

export interface ImportOutcome {
  ok: boolean;
  /** 整体性失败（下载失败、归档损坏、里面没有技能）。 */
  errors: readonly string[];
  /** 归档或目录层面被跳过的条目。 */
  skipped: readonly string[];
  skills: readonly ImportedSkill[];
  /** 来源描述，写进每个技能的 origin.json。 */
  source: string | null;
}

interface CommonInput {
  userDir: string;
  overwrite?: boolean;
  builtinSlugs?: ReadonlySet<string>;
}

/** 把一批「位置 → 文件集合」写成用户技能。三条导入路径的公共后半程。 */
function writeAll(
  input: CommonInput,
  groups: ReadonlyArray<{ location: string; files: SkillFileMap }>,
  origin: Omit<SkillOrigin, 'createdAt' | 'contentSha256'>,
): readonly ImportedSkill[] {
  return groups.map((group) => ({
    location: group.location,
    ...writeUserSkill({
      userDir: input.userDir,
      files: group.files,
      origin: { ...origin, detail: group.location === '' ? origin.detail : group.location },
      ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
      ...(input.builtinSlugs === undefined ? {} : { builtinSlugs: input.builtinSlugs }),
    }),
  }));
}

/* ------------------------------------------------------------------ *
 * 压缩包
 * ------------------------------------------------------------------ */

export interface ImportArchiveInput extends CommonInput {
  data: Buffer;
  /** 上传时的文件名，只用于来源描述。 */
  fileName?: string;
}

export function importSkillsFromArchive(input: ImportArchiveInput): ImportOutcome {
  const source = input.fileName ?? null;

  let archive;
  try {
    archive = readArchive(input.data);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof ArchiveError ? err.message : String(err)],
      skipped: [],
      skills: [],
      source,
    };
  }

  const found = findArchivedSkills(archive.entries);
  if (found.length === 0) {
    return {
      ok: false,
      errors: [
        `归档（${archive.format}，${String(archive.entries.length)} 个文件）里没有技能。` +
          '技能目录必须同时含 skill.json 与 SKILL.md，两者要在同一层',
      ],
      skipped: archive.skipped,
      skills: [],
      source,
    };
  }

  const skills = writeAll(
    input,
    found.map((s) => ({
      location: s.prefix === '' ? '(归档根目录)' : s.prefix.replace(/\/$/, ''),
      files: s.files,
    })),
    { kind: 'archive', source, detail: null },
  );

  return {
    ok: skills.some((s) => s.ok),
    errors: [],
    skipped: archive.skipped,
    skills,
    source,
  };
}

/* ------------------------------------------------------------------ *
 * 本机目录
 * ------------------------------------------------------------------ */

export interface ImportDirectoryInput extends CommonInput {
  sourceDir: string;
}

export function importSkillsFromDirectory(input: ImportDirectoryInput): ImportOutcome {
  if (!existsSync(input.sourceDir)) {
    return {
      ok: false,
      errors: [`目录不存在：${input.sourceDir}`],
      skipped: [],
      skills: [],
      source: input.sourceDir,
    };
  }

  const roots = findSkillRoots(input.sourceDir);
  if (roots.length === 0) {
    return {
      ok: false,
      errors: [`${input.sourceDir} 里没有技能。技能目录必须同时含 skill.json 与 SKILL.md`],
      skipped: [],
      skills: [],
      source: input.sourceDir,
    };
  }

  const skipped: string[] = [];
  const groups = roots.map((root) => {
    const tree = readSkillTree(root);
    skipped.push(...tree.skipped.map((s) => `${root}: ${s}`));
    return { location: root, files: tree.files };
  });

  const skills = writeAll(input, groups, {
    kind: 'directory',
    source: input.sourceDir,
    detail: null,
  });

  return { ok: skills.some((s) => s.ok), errors: [], skipped, skills, source: input.sourceDir };
}

/* ------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------ */

export interface GitHubRepoSpec {
  owner: string;
  repo: string;
  /** 分支、标签或提交。省略时用仓库默认分支。 */
  ref: string | null;
  /** 仓库内的子目录。省略时全仓库找技能。 */
  subdir: string | null;
}

const GITHUB_HOST = 'api.github.com';

/**
 * 解析用户输入的仓库标识。
 *
 * 接受四种写法，因为这四种都是用户手里会有的：`owner/repo`、`owner/repo@ref`、
 * 完整的仓库 URL、以及**从浏览器地址栏复制来的 tree URL**——最后一种最常见，
 * 而它同时带了 ref 与子目录。不认它的话用户会得到一个「仓库不存在」的错误。
 */
export function parseGitHubSpec(input: string): GitHubRepoSpec | { error: string } {
  const text = input.trim();
  if (text === '') return { error: '仓库标识不能为空' };

  let rest = text;
  let ref: string | null = null;
  let subdir: string | null = null;

  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(rest);
  if (urlMatch?.[1] !== undefined) rest = urlMatch[1];
  rest = rest.replace(/\.git$/, '').replace(/\/+$/, '');

  // tree / blob 形式：owner/repo/tree/<ref>/<subdir...>
  const treeMatch = /^([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(rest);
  if (treeMatch !== null) {
    ref = treeMatch[3] ?? null;
    subdir = treeMatch[4] === undefined || treeMatch[4] === '' ? null : treeMatch[4];
    rest = `${treeMatch[1] ?? ''}/${treeMatch[2] ?? ''}`;
  }

  const at = rest.lastIndexOf('@');
  if (at > 0 && !rest.slice(at).includes('/')) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  const parts = rest.split('/').filter((p) => p !== '');
  if (parts.length !== 2) {
    return {
      error: `无法解析 ${JSON.stringify(input)}。写成 owner/repo、owner/repo@分支，或者直接粘贴仓库网址`,
    };
  }
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
    return { error: `owner 或 repo 含非法字符：${owner}/${repo}` };
  }
  if (ref !== null && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    return { error: `ref 含非法字符：${ref}` };
  }
  if (subdir !== null && (subdir.includes('..') || subdir.startsWith('/'))) {
    return { error: `子目录不合法：${subdir}` };
  }

  return { owner, repo, ref, subdir };
}

export interface ImportGitHubInput extends CommonInput {
  spec: string;
  /**
   * 私库访问令牌。
   *
   * 由调用方从凭据库取出明文传进来，用完即弃——不落配置也不进日志。
   * 请求载荷里传的是凭据引用名而不是令牌本身（见 ipc.ts 对凭据的约定）。
   */
  token?: string | null;
  /**
   * 域名授权检查。返回 false 表示不放行。
   *
   * 必须由调用方提供而不是这里默认放行：后端 fetch 不经出口代理，
   * 没有这道检查就出现了一条绕过全部出网管控的路径。
   */
  authorizeHost: (host: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_GITHUB_TIMEOUT_MS = 90_000;

export async function importSkillsFromGitHub(input: ImportGitHubInput): Promise<ImportOutcome> {
  const parsed = parseGitHubSpec(input.spec);
  if ('error' in parsed) {
    return { ok: false, errors: [parsed.error], skipped: [], skills: [], source: input.spec };
  }
  const { owner, repo, ref, subdir } = parsed;
  const source = `${owner}/${repo}${ref === null ? '' : `@${ref}`}${subdir === null ? '' : `/${subdir}`}`;

  const allowed = await input.authorizeHost(GITHUB_HOST);
  if (!allowed) {
    return {
      ok: false,
      errors: [
        `访问 ${GITHUB_HOST} 未获批准，已取消导入。` +
          '导入技能会把外部编写的指令与脚本写进你的技能目录，因此需要一次明确的放行。',
      ],
      skipped: [],
      skills: [],
      source,
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const url =
    `https://${GITHUB_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/tarball${ref === null ? '' : `/${ref.split('/').map(encodeURIComponent).join('/')}`}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS);
  timer.unref?.();

  let data: Buffer;
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'L-science/1 (research workbench)',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(input.token === undefined || input.token === null || input.token === ''
          ? {}
          : { authorization: `Bearer ${input.token}` }),
      },
    });

    if (!res.ok) {
      // 把状态码翻译成原因：401/404 在私库场景下几乎总是令牌问题，而 GitHub
      // 对没有权限的私库故意回 404（避免泄露仓库是否存在），这一点必须说出来
      const hint =
        res.status === 404
          ? input.token === undefined || input.token === null || input.token === ''
            ? '仓库不存在，或者它是私有仓库——GitHub 对无权限的私库一律回 404。私库需要提供访问令牌。'
            : '仓库或分支不存在，或者这个令牌对它没有读权限。'
          : res.status === 401 || res.status === 403
            ? '令牌无效、已过期，或者没有 repo 读权限。'
            : res.status === 429
              ? '触发了 GitHub 的速率限制，过一会儿再试。'
              : '';
      return {
        ok: false,
        errors: [`GitHub 返回 ${String(res.status)}。${hint}`],
        skipped: [],
        skills: [],
        source,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    data = buf;
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      errors: [
        aborted
          ? `下载超时（${String(input.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS)} ms）。`
          : `下载失败：${err instanceof Error ? err.message : String(err)}`,
      ],
      skipped: [],
      skills: [],
      source,
    };
  } finally {
    clearTimeout(timer);
  }

  let archive;
  try {
    archive = readArchive(data);
  } catch (err) {
    return {
      ok: false,
      errors: [`归档无法读取：${err instanceof ArchiveError ? err.message : String(err)}`],
      skipped: [],
      skills: [],
      source,
    };
  }

  /*
   * GitHub 的 tarball 会把所有内容套在 `owner-repo-<sha>/` 一层里。子目录过滤要
   * 在剥掉那一层之后做，否则用户填的 `skills/foo` 永远匹配不上。
   */
  const entries = archive.entries;
  const topLevel = new Set(entries.map((e) => e.path.split('/')[0] ?? ''));
  const stripPrefix = topLevel.size === 1 ? `${[...topLevel][0] ?? ''}/` : '';
  const normalized = entries.map((e) => ({
    path: e.path.startsWith(stripPrefix) ? e.path.slice(stripPrefix.length) : e.path,
    data: e.data,
  }));

  const scoped =
    subdir === null
      ? normalized
      : normalized
          .filter((e) => e.path === subdir || e.path.startsWith(`${subdir.replace(/\/$/, '')}/`))
          .map((e) => ({
            path: e.path.slice(subdir.replace(/\/$/, '').length + 1),
            data: e.data,
          }))
          .filter((e) => e.path !== '');

  if (subdir !== null && scoped.length === 0) {
    return {
      ok: false,
      errors: [`仓库里没有子目录 ${subdir}`],
      skipped: archive.skipped,
      skills: [],
      source,
    };
  }

  const found = findArchivedSkills(scoped);
  if (found.length === 0) {
    return {
      ok: false,
      errors: [
        `${source} 里没有技能。技能目录必须同时含 skill.json 与 SKILL.md。` +
          (subdir === null ? '如果技能在某个子目录里，请把那个目录也指出来。' : ''),
      ],
      skipped: archive.skipped,
      skills: [],
      source,
    };
  }

  const skills = writeAll(
    input,
    found.map((s) => ({
      location: s.prefix === '' ? '(仓库根目录)' : s.prefix.replace(/\/$/, ''),
      files: s.files,
    })),
    { kind: 'github', source, detail: null },
  );

  return { ok: skills.some((s) => s.ok), errors: [], skipped: archive.skipped, skills, source };
}

/** 凭据库里 GitHub 令牌的引用名约定。与 `providerRef` 同一个格式。 */
export function skillSourceRef(name: string): string {
  return `skill-source:${name}`;
}

/** 用户技能目录里是否已经有这个 slug。供 UI 在导入前提示会不会覆盖。 */
export function userSkillExists(userDir: string, slug: string): boolean {
  return existsSync(join(userDir, slug));
}
