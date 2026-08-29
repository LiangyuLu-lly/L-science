/**
 * 技能清单的解析与校验（任务 12.1，需求 9.1、9.2、9.6）。
 *
 * 目录约定：
 *
 * ```
 * skills/<scope>/<slug>/
 *   SKILL.md            主指令文档，front matter 含元数据
 *   skill.json          结构化清单
 *   provider.py         可选，BYOC / 推理供应商的 Python 侧实现
 *   provider.json       可选，供应商声明
 *   scripts/            可选，技能自带脚本
 *   references/         可选，按需二次加载的参考文档
 * ```
 *
 * **`skill.json` 是唯一权威来源，SKILL.md 的 front matter 只用于交叉核对。**
 * 两份都当权威会立刻产生「改了一处没改另一处，系统按哪份走」的问题，而这种
 * 分歧不会报错，只会让技能的行为与它自己的文档不一致。核对不通过时报为警告
 * 而不是拒绝加载——文档写错不该让一个可用的技能整个消失。
 *
 * front matter 刻意只支持标量与单行数组，不引 YAML 解析器：这里需要的是
 * 「name 和 slug 对得上吗」这种核对，把一个通用 YAML 解析器（及其别名、锚点、
 * 多文档这些特性）请进来解决不了任何实际问题，反而多一个攻击面。
 */

/** 技能声明的环境依赖。缺失时要能给出可执行的补齐指引（需求 9.6）。 */
export interface SkillRequires {
  /** Python 包（import 名）。用 `import` 探测而不是查 pip list——装了但装错环境的情况很常见。 */
  python?: readonly string[];
  /** R 包。 */
  r?: readonly string[];
  /** 需要的可执行命令，例如 `pandoc`、`latexmk`。 */
  commands?: readonly string[];
  /** 需要的连接器 id。 */
  connectors?: readonly string[];
  /** 需要的运行时能力，取值同 CAPABILITY.*，例如 `kernel:r`。 */
  capabilities?: readonly string[];
}

export interface SkillManifest {
  slug: string;
  name: string;
  version: string | null;
  domain: string | null;
  description: string;
  /**
   * 语义触发描述，供检索索引使用。
   *
   * 写成「什么时候该用它」而不是「它是什么」：检索的输入是用户的话，
   * 而用户说的是自己的目的（「帮我把这段 EEG 分期」），不是技能的定义。
   */
  triggers: readonly string[];
  requires: SkillRequires;
  /** 该技能需要哪些工具权限。空数组表示纯文档型技能。 */
  tools: readonly string[];
}

/* ------------------------------------------------------------------ *
 * BYOC / 推理供应商声明（provider.json）
 * ------------------------------------------------------------------ */

/**
 * 技能自带的供应商类型。
 *
 * - `inference`：把一个模型端点接进来（自建的 vLLM、公司内网的推理服务）。
 * - `compute`：把一套算力接进来（自家云、实验室调度器）。
 * - `dataset`：把一个数据源接进来（内部数据湖、仪器归档）。
 *
 * 三者共用同一个协议（`provider.py` 里的入口函数 + 声明式清单）而不是各设一套：
 * 用户要写的其实是同一件事——「按这个协议实现几个函数」。分成三套协议只会让
 * 「我该照哪份文档写」变成第一个障碍。
 */
export type SkillProviderKind = 'inference' | 'compute' | 'dataset';

/** 供应商需要用户填的一项配置。 */
export interface SkillProviderField {
  name: string;
  label: string;
  /** `secret` 的值进凭据库，不落配置文件。 */
  type: 'string' | 'number' | 'boolean' | 'secret' | 'path' | 'choice';
  required: boolean;
  /** `choice` 类型的可选值。 */
  choices?: readonly string[];
  default?: string;
  help?: string;
}

export interface SkillProvider {
  id: string;
  name: string;
  kind: SkillProviderKind;
  /**
   * `provider.py` 里的入口函数名。
   *
   * 显式声明而不是约定固定名字：一个文件里可以实现多个入口（比如 `list_models`
   * 与 `invoke`），而固定名字的约定在需要第二个入口时就得再定一条约定。
   */
  entrypoints: Readonly<Record<string, string>>;
  /** 用户需要填的配置项。 */
  fields: readonly SkillProviderField[];
  /** 该供应商自己的 Python 依赖。与 skill.requires.python 分开：它只在启用时才需要。 */
  pythonRequires: readonly string[];
  description: string;
}

export type SkillScope = 'builtin' | 'user';

/** 加载后的技能。`instructions` 是 SKILL.md 正文，不含 front matter。 */
export interface LoadedSkill {
  manifest: SkillManifest;
  scope: SkillScope;
  /** 技能目录的绝对路径。 */
  path: string;
  /** SKILL.md 正文（已剥离 front matter）。 */
  instructions: string;
  /** `references/` 下的文件名，按需二次加载用。不预读内容。 */
  references: readonly string[];
  /** `scripts/` 下的文件名。 */
  scripts: readonly string[];
  /**
   * `provider.json` 解析出的供应商声明。没有该文件时为 null。
   *
   * 与 `provider.py` 的存在性分开判断：只有声明没有实现是一种明确的错误状态
   * （启用后调用必然失败），要在加载时就报出来，而不是等用户点了「启用」才发现。
   */
  provider: SkillProvider | null;
  /** `provider.py` 的绝对路径。声明了供应商但文件缺失时为 null。 */
  providerScript: string | null;
  /** 解析期发现的问题。不阻止加载，但要透出给用户。 */
  warnings: readonly string[];
}

export class SkillManifestError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}：${message}`);
    this.name = 'SkillManifestError';
    this.path = path;
  }
}

/** slug 同时是目录名与覆盖的键，因此字符集必须收紧。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function asStringArray(value: unknown, field: string, path: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SkillManifestError(path, `${field} 必须是字符串数组`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SkillManifestError(path, `${field} 里有空项或非字符串`);
    }
  }
  return (value as string[]).map((s) => s.trim());
}

function parseRequires(raw: unknown, path: string): SkillRequires {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillManifestError(path, 'requires 必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const known = ['python', 'r', 'commands', 'connectors', 'capabilities'];
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      // 拼错的键静默忽略等于「声明了依赖但从不检查」，那比不声明更危险
      throw new SkillManifestError(
        path,
        `requires 里有未知字段 ${key}，可用字段为 ${known.join('、')}`,
      );
    }
  }

  const out: SkillRequires = {};
  const python = asStringArray(obj.python, 'requires.python', path);
  const r = asStringArray(obj.r, 'requires.r', path);
  const commands = asStringArray(obj.commands, 'requires.commands', path);
  const connectors = asStringArray(obj.connectors, 'requires.connectors', path);
  const capabilities = asStringArray(obj.capabilities, 'requires.capabilities', path);

  return {
    ...(python.length > 0 ? { python } : {}),
    ...(r.length > 0 ? { r } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(connectors.length > 0 ? { connectors } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...out,
  };
}

/**
 * 解析 `skill.json`。
 *
 * 校验失败直接抛错而不是降级成一个「部分可用」的技能：一个 description 为空的
 * 技能进了检索索引之后永远不会被命中，表现是「装了但从来不生效」，而那比
 * 「加载时就报错」难查得多。
 */
export function parseSkillManifest(raw: unknown, path: string): SkillManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkillManifestError(path, 'skill.json 必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const slug = typeof obj.slug === 'string' ? obj.slug.trim() : '';
  if (!isValidSlug(slug)) {
    throw new SkillManifestError(
      path,
      `slug ${JSON.stringify(obj.slug)} 不合法。只允许小写字母、数字与连字符，且不超过 64 字符`,
    );
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (name === '') throw new SkillManifestError(path, 'name 不能为空');

  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (description === '') {
    throw new SkillManifestError(
      path,
      'description 不能为空——它是检索索引的主要输入，空描述的技能永远不会被命中',
    );
  }

  const triggers = asStringArray(obj.triggers, 'triggers', path);
  if (triggers.length === 0) {
    throw new SkillManifestError(
      path,
      'triggers 至少要有一条。它描述「什么时候该用这个技能」，是检索能否命中的关键',
    );
  }

  const version =
    obj.version === undefined || obj.version === null ? null : String(obj.version).trim();
  const domain = obj.domain === undefined || obj.domain === null ? null : String(obj.domain).trim();

  return {
    slug,
    name,
    version: version === '' ? null : version,
    domain: domain === '' ? null : domain,
    description,
    triggers,
    requires: parseRequires(obj.requires, path),
    tools: asStringArray(obj.tools, 'tools', path),
  };
}

/* ------------------------------------------------------------------ *
 * provider.json
 * ------------------------------------------------------------------ */

const PROVIDER_KINDS: readonly SkillProviderKind[] = ['inference', 'compute', 'dataset'];
const FIELD_TYPES: readonly SkillProviderField['type'][] = [
  'string',
  'number',
  'boolean',
  'secret',
  'path',
  'choice',
];

function parseProviderField(raw: unknown, index: number, path: string): SkillProviderField {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkillManifestError(path, `fields[${String(index)}] 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // 字段名会作为 Python 侧的关键字参数传进去，因此必须是合法标识符
    throw new SkillManifestError(
      path,
      `fields[${String(index)}].name ${JSON.stringify(obj.name)} 不是合法标识符。` +
        '它会作为 Python 侧的关键字参数名传入',
    );
  }

  const type = typeof obj.type === 'string' ? obj.type : '';
  if (!FIELD_TYPES.includes(type as SkillProviderField['type'])) {
    throw new SkillManifestError(
      path,
      `fields[${String(index)}].type 必须是 ${FIELD_TYPES.join(' / ')}`,
    );
  }

  const choices = asStringArray(obj.choices, `fields[${String(index)}].choices`, path);
  if (type === 'choice' && choices.length === 0) {
    throw new SkillManifestError(
      path,
      `fields[${String(index)}] 是 choice 类型但没有 choices，用户无从选择`,
    );
  }

  return {
    name,
    label: typeof obj.label === 'string' && obj.label.trim() !== '' ? obj.label.trim() : name,
    type: type as SkillProviderField['type'],
    required: obj.required !== false,
    ...(choices.length > 0 ? { choices } : {}),
    ...(typeof obj.default === 'string' ? { default: obj.default } : {}),
    ...(typeof obj.help === 'string' && obj.help.trim() !== '' ? { help: obj.help.trim() } : {}),
  };
}

/**
 * 解析 `provider.json`。
 *
 * 校验失败抛错而不是忽略：一个声明写错的供应商在 UI 上会显示为可配置，用户填完
 * 一堆字段之后调用才失败，而那时错误信息来自 Python 侧，与「声明写错了」这个
 * 真实原因完全对不上。
 */
export function parseSkillProvider(raw: unknown, path: string): SkillProvider {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkillManifestError(path, 'provider.json 必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!isValidSlug(id)) {
    throw new SkillManifestError(
      path,
      `id ${JSON.stringify(obj.id)} 不合法。只允许小写字母、数字与连字符`,
    );
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (name === '') throw new SkillManifestError(path, 'name 不能为空');

  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  if (!PROVIDER_KINDS.includes(kind as SkillProviderKind)) {
    throw new SkillManifestError(path, `kind 必须是 ${PROVIDER_KINDS.join(' / ')}`);
  }

  const rawEntrypoints = obj.entrypoints;
  if (
    typeof rawEntrypoints !== 'object' ||
    rawEntrypoints === null ||
    Array.isArray(rawEntrypoints)
  ) {
    throw new SkillManifestError(path, 'entrypoints 必须是对象（角色名 → Python 函数名）');
  }
  const entrypoints: Record<string, string> = {};
  for (const [role, fn] of Object.entries(rawEntrypoints as Record<string, unknown>)) {
    if (typeof fn !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn)) {
      throw new SkillManifestError(
        path,
        `entrypoints.${role} 必须是合法的 Python 函数名，实际是 ${JSON.stringify(fn)}`,
      );
    }
    entrypoints[role] = fn;
  }
  if (Object.keys(entrypoints).length === 0) {
    throw new SkillManifestError(path, 'entrypoints 至少要有一个入口，否则这个供应商无法被调用');
  }

  const rawFields = obj.fields;
  if (rawFields !== undefined && rawFields !== null && !Array.isArray(rawFields)) {
    throw new SkillManifestError(path, 'fields 必须是数组');
  }
  const fields = (Array.isArray(rawFields) ? rawFields : []).map((f, i) =>
    parseProviderField(f, i, path),
  );

  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) {
      // 重名字段在传参时后者覆盖前者，而 UI 上会显示两个输入框
      throw new SkillManifestError(path, `fields 里有重复的 name：${field.name}`);
    }
    names.add(field.name);
  }

  const description = typeof obj.description === 'string' ? obj.description.trim() : '';

  return {
    id,
    name,
    kind: kind as SkillProviderKind,
    entrypoints,
    fields,
    pythonRequires: asStringArray(obj.pythonRequires, 'pythonRequires', path),
    description,
  };
}

export interface FrontMatter {
  /** 解析出的键值。值为字符串或字符串数组。 */
  fields: Readonly<Record<string, string | readonly string[]>>;
  /** 剥掉 front matter 之后的正文。 */
  body: string;
}

/**
 * 剥离并解析 Markdown 的 front matter。
 *
 * 只认文件开头的 `---` 分隔块，且只支持 `key: value` 与 `key: [a, b]`。
 * 见文件头对「不引 YAML 解析器」的说明。
 */
export function parseFrontMatter(source: string): FrontMatter {
  // 允许 BOM 与 CRLF：Windows 上用记事本存的文件两者都会有
  const text = source.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return { fields: {}, body: text };

  const fields: Record<string, string | readonly string[]> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;

    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (key === '') continue;

    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s !== '');
      continue;
    }

    // 去掉成对的引号，但不处理转义——见文件头说明
    value = value.replace(/^["']|["']$/g, '');
    fields[key] = value;
  }

  return { fields, body: text.slice(match[0].length) };
}

/**
 * 核对 front matter 与 skill.json 是否一致。
 *
 * 返回警告列表而不是抛错：文档与清单不一致是需要被看到的问题，但它不影响技能
 * 能否工作——按 skill.json 走就是了。让它阻止加载会把一个「文档笔误」升级成
 * 「技能不可用」。
 */
export function crossCheckFrontMatter(
  manifest: SkillManifest,
  front: FrontMatter,
): readonly string[] {
  const warnings: string[] = [];
  const scalar = (key: string): string | null => {
    const value = front.fields[key];
    return typeof value === 'string' ? value : null;
  };

  const slug = scalar('slug');
  if (slug !== null && slug !== manifest.slug) {
    warnings.push(
      `SKILL.md 的 front matter 里 slug 是 ${slug}，skill.json 里是 ${manifest.slug}。按 skill.json 走`,
    );
  }

  const name = scalar('name');
  if (name !== null && name !== manifest.name) {
    warnings.push(`SKILL.md 与 skill.json 的 name 不一致（${name} / ${manifest.name}）`);
  }

  const version = scalar('version');
  if (version !== null && manifest.version !== null && version !== manifest.version) {
    warnings.push(
      `SKILL.md 与 skill.json 的 version 不一致（${version} / ${manifest.version}）。` +
        '版本号对不上会让「用户技能覆盖了哪一版内置技能」无从判断',
    );
  }

  return warnings;
}
