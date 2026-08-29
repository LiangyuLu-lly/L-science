/**
 * 技能创建与导入（任务 12.15，需求 9.6）。
 *
 * 这个文件里最值得跑的是三组：
 *
 * 1. **归档解析的安全防护**。zip-slip、符号链接、解压炸弹三类问题都只在解压这一层
 *    能挡住，而它们的共同点是「不挡也能跑通」——测试是唯一能证明挡住了的手段。
 * 2. **写入的原子性**。校验失败时用户原来那个能用的技能必须还在。
 * 3. **一次性细节的识别**。蒸馏最容易把某次运行的路径与数值写成通用规则。
 *
 * 归档用手写的构造器生成（`makeZip` / `makeTar`），因为要造出「含 `../` 的条目」
 * 这种正常打包工具不会产出的归档。真实工具产出的归档由 `verify:skills` 覆盖。
 */

import { deflateRawSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_LIMITS,
  ArchiveError,
  auditSkillContent,
  buildDistillContext,
  findArchivedSkills,
  findSkillRoots,
  importSkillsFromArchive,
  importSkillsFromDirectory,
  parseDistilledSkill,
  parseGitHubSpec,
  readArchive,
  readSkillOrigin,
  readSkillTree,
  removeUserSkill,
  skillFingerprint,
  validateSkillFiles,
  writeUserSkill,
  type SkillFileMap,
} from '@l-science/core';

let root: string;
let userDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-authoring-'));
  userDir = join(root, 'user');
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const manifest = (slug: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    slug,
    name: `技能 ${slug}`,
    version: '1.0.0',
    domain: '测试',
    description: `${slug} 的用途说明，足够长以通过非空校验`,
    triggers: ['触发一', '触发二', '触发三'],
    tools: [],
    ...extra,
  });

const goodFiles = (slug = 'demo-skill'): SkillFileMap => ({
  'skill.json': manifest(slug),
  'SKILL.md': `# ${slug}\n\n按下面的步骤做：\n\n1. 先查数据\n2. 再算\n`,
});

/** 造一个最小可用的 zip。entries 的 path 原样写入，用于构造越界条目。 */
function makeZip(
  entries: ReadonlyArray<{
    path: string;
    content: string | Buffer;
    externalAttrs?: number;
    store?: boolean;
  }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const raw =
      typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const stored = entry.store === true;
    const data = stored ? raw : deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(0, 14); // crc32：读取侧不校验
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(entry.externalAttrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

/** 造一个 ustar tar。typeflag 可指定，用于构造符号链接条目。 */
function makeTar(
  entries: ReadonlyArray<{ path: string; content?: string; typeflag?: string; linkname?: string }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.path.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write(entry.typeflag ?? '0', 156, 'ascii');
    if (entry.linkname !== undefined) header.write(entry.linkname, 157, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');

    // 校验和：先填空格再求和。读取侧不校验，但真实工具会写，这里照做
    header.write('        ', 148, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

    blocks.push(header);
    if (content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      content.copy(padded);
      blocks.push(padded);
    }
  }

  blocks.push(Buffer.alloc(1024)); // 结束标记
  return Buffer.concat(blocks);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

describe('validateSkillFiles', () => {
  it('接受一个完整的技能', () => {
    const result = validateSkillFiles(goodFiles());
    expect(result.ok).toBe(true);
    expect(result.manifest?.slug).toBe('demo-skill');
  });

  it('缺 SKILL.md 时说清后果', () => {
    const result = validateSkillFiles({ 'skill.json': manifest('x') });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('SKILL.md');
    // 只说「缺文件」不够，要说清缺了它会怎样
    expect(result.errors.join()).toContain('注入上下文');
  });

  it('skill.json 语法错误直接指出来', () => {
    const result = validateSkillFiles({ 'skill.json': '{ "slug": ', 'SKILL.md': '# x' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('不是合法 JSON');
  });

  it('拒绝越界路径与反斜杠', () => {
    for (const bad of ['../evil.md', 'references/../../x.md', 'references\\x.md', '/abs.md']) {
      const result = validateSkillFiles({ ...goodFiles(), [bad]: 'x' });
      expect(result.ok, bad).toBe(false);
    }
  });

  it('根目录只允许约定的几个文件', () => {
    const result = validateSkillFiles({ ...goodFiles(), 'README.md': '说明' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('references/');
  });

  it('隐藏文件被拒（它们不该出现在技能里）', () => {
    const result = validateSkillFiles({ ...goodFiles(), 'references/.env': 'SECRET=1' });
    expect(result.ok).toBe(false);
  });

  it('单文件与合计大小都有上限', () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const result = validateSkillFiles({ ...goodFiles(), 'references/big.md': huge });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('单文件上限');
  });

  it('triggers 太少只警告不拒绝', () => {
    const result = validateSkillFiles({
      'skill.json': manifest('x', { triggers: ['只有一条'] }),
      'SKILL.md': '# x\n正文',
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toContain('triggers');
  });

  it('provider 声明与实现不配对时警告', () => {
    const result = validateSkillFiles({
      ...goodFiles(),
      'provider.json': JSON.stringify({
        id: 'p',
        name: 'P',
        kind: 'inference',
        entrypoints: { invoke: 'invoke' },
        fields: [],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toContain('provider.py');
  });
});

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

describe('writeUserSkill', () => {
  it('写入后能被加载，并留下来源记录', () => {
    const result = writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: '手写' },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(userDir, 'demo-skill', 'SKILL.md'))).toBe(true);

    const origin = readSkillOrigin(join(userDir, 'demo-skill'));
    expect(origin?.kind).toBe('authored');
    expect(origin?.contentSha256).toBe(skillFingerprint(goodFiles()));
  });

  it('默认拒绝覆盖同名技能', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    const again = writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    expect(again.ok).toBe(false);
    // 静默覆盖会让用户自己改过的版本无声消失
    expect(again.errors.join()).toContain('显式');
  });

  it('overwrite 时替换并标记 replaced', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    const changed: SkillFileMap = {
      'skill.json': manifest('demo-skill'),
      'SKILL.md': '# 新版本\n\n改过的正文\n',
    };
    const again = writeUserSkill({
      userDir,
      files: changed,
      origin: { kind: 'authored', source: null, detail: null },
      overwrite: true,
    });
    expect(again.ok).toBe(true);
    expect(again.replaced).toBe(true);
    expect(readFileSync(join(userDir, 'demo-skill', 'SKILL.md'), 'utf8')).toContain('新版本');
  });

  it('校验失败时不碰已存在的技能', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    const before = readFileSync(join(userDir, 'demo-skill', 'SKILL.md'), 'utf8');

    const broken = writeUserSkill({
      userDir,
      files: { 'skill.json': manifest('demo-skill'), 'SKILL.md': '' },
      origin: { kind: 'authored', source: null, detail: null },
      overwrite: true,
    });
    expect(broken.ok).toBe(false);
    // 用户失去的不能是一个能用的技能，换来一条错误消息
    expect(readFileSync(join(userDir, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(before);
    // 备份目录也不能留下：它会被当成一个 slug 非法的技能出现在「加载失败」列表里
    expect(readSkillTree(userDir).skipped.join()).not.toContain('backup');
  });

  it('不留下临时目录', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    writeUserSkill({
      userDir,
      files: { 'skill.json': '{', 'SKILL.md': 'x' },
      origin: { kind: 'authored', source: null, detail: null },
    });
    const leftovers = readSkillTree(userDir).skipped.filter((s) => s.includes('.staging'));
    expect(leftovers).toEqual([]);
  });

  it('遮蔽内置技能时明确报出来', () => {
    const result = writeUserSkill({
      userDir,
      files: goodFiles('sleep-staging'),
      origin: { kind: 'authored', source: null, detail: null },
      builtinSlugs: new Set(['sleep-staging']),
    });
    expect(result.ok).toBe(true);
    expect(result.shadowsBuiltin).toBe(true);
  });

  it('SKILL.md 只有 front matter 时拒绝创建', () => {
    const result = writeUserSkill({
      userDir,
      files: { 'skill.json': manifest('x'), 'SKILL.md': '---\nslug: x\n---\n' },
      origin: { kind: 'authored', source: null, detail: null },
    });
    /*
     * 创建时比加载时严：加载器对已存在的技能只警告（把它变成错误等于让一个能修好的
     * 技能直接消失），而创建时必须拦住——一个命中后什么都不注入的技能只会占掉
     * 一个检索候选位。
     */
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('候选位');
    expect(existsSync(join(userDir, 'x'))).toBe(false);
  });

  it('provider.json 语法错误由真实加载抓出来，且不碰已存在的技能', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    const before = readFileSync(join(userDir, 'demo-skill', 'SKILL.md'), 'utf8');

    /*
     * 这一条走的正是「校验通过但加载失败」那条路：`validateSkillFiles` 不解析
     * provider.json，只有 `loadSkill` 会。它证明原子换入的备份/回退真的在起作用。
     */
    const result = writeUserSkill({
      userDir,
      files: {
        ...goodFiles(),
        'SKILL.md': '# 新内容\n\n不该被写进去\n',
        'provider.json': '{ "id": "p", 坏的',
        'provider.py': 'def invoke():\n    pass\n',
      },
      origin: { kind: 'authored', source: null, detail: null },
      overwrite: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('无法加载');
    // 用户失去的不能是一个能用的技能，换来一条错误消息
    expect(readFileSync(join(userDir, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(before);
  });
});

describe('removeUserSkill', () => {
  it('删掉存在的用户技能', () => {
    writeUserSkill({
      userDir,
      files: goodFiles(),
      origin: { kind: 'authored', source: null, detail: null },
    });
    expect(removeUserSkill(userDir, 'demo-skill').ok).toBe(true);
    expect(existsSync(join(userDir, 'demo-skill'))).toBe(false);
  });

  it('不存在时如实报失败', () => {
    expect(removeUserSkill(userDir, 'nope').ok).toBe(false);
  });

  it('拒绝非法 slug（防止拼出别的路径）', () => {
    expect(removeUserSkill(userDir, '../user').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 归档：安全防护
 * ------------------------------------------------------------------ */

describe('readArchive 的安全防护', () => {
  it('zip-slip：含 .. 的条目被丢掉而不是写到外面', () => {
    const zip = makeZip([
      { path: 'skill.json', content: manifest('z') },
      { path: 'SKILL.md', content: '# z\n正文' },
      { path: '../../../evil.txt', content: 'pwned' },
    ]);
    const result = readArchive(zip);
    expect(result.entries.map((e) => e.path)).not.toContain('../../../evil.txt');
    expect(result.skipped.join()).toContain('路径越界');
  });

  it('zip 里的绝对路径与盘符被丢掉', () => {
    const zip = makeZip([
      { path: 'skill.json', content: manifest('z') },
      { path: 'SKILL.md', content: '# z' },
      { path: '/etc/passwd', content: 'x' },
      { path: 'C:/Windows/system32/a.dll', content: 'x' },
    ]);
    const result = readArchive(zip);
    const paths = result.entries.map((e) => e.path);
    expect(paths).not.toContain('/etc/passwd');
    expect(paths.some((p) => p.includes('Windows'))).toBe(false);
  });

  it('zip 里的符号链接被丢掉', () => {
    // 高 16 位是 Unix 模式，0xA1FF 表示 S_IFLNK | 0777
    const zip = makeZip([
      { path: 'skill.json', content: manifest('z') },
      { path: 'SKILL.md', content: '# z' },
      { path: 'references/link.md', content: '/etc/shadow', externalAttrs: 0xa1ff0000 },
    ]);
    const result = readArchive(zip);
    expect(result.entries.map((e) => e.path)).not.toContain('references/link.md');
    expect(result.skipped.join()).toContain('符号链接');
  });

  it('tar 里的符号链接与硬链接被丢掉', () => {
    const tar = makeTar([
      { path: 'skill.json', content: manifest('t') },
      { path: 'SKILL.md', content: '# t' },
      { path: 'references/sym.md', typeflag: '2', linkname: '/etc/shadow' },
      { path: 'references/hard.md', typeflag: '1', linkname: 'skill.json' },
    ]);
    const result = readArchive(tar);
    const paths = result.entries.map((e) => e.path);
    expect(paths).not.toContain('references/sym.md');
    expect(paths).not.toContain('references/hard.md');
    expect(result.skipped.join()).toContain('链接');
  });

  it('tar 里的 .. 条目被丢掉', () => {
    const tar = makeTar([
      { path: 'skill.json', content: manifest('t') },
      { path: 'SKILL.md', content: '# t' },
      { path: '../outside.txt', content: 'x' },
    ]);
    const result = readArchive(tar);
    expect(result.entries.map((e) => e.path)).not.toContain('../outside.txt');
  });

  it('归档整体过大直接拒绝', () => {
    const big = Buffer.alloc(ARCHIVE_LIMITS.maxArchiveBytes + 1);
    // 让它看起来像 zip，确保是大小检查先拦下而不是格式检查
    big.writeUInt32LE(0x04034b50, 0);
    expect(() => readArchive(big)).toThrow(ArchiveError);
  });

  it('无法识别的格式给出可操作的说明', () => {
    expect(() => readArchive(Buffer.from('not an archive at all'))).toThrow(/zip|tar/);
  });

  it('解压炸弹：单条目超限被丢掉而不是解出来', () => {
    // 一段高度可压缩的内容，解压后超过单条目上限
    const bomb = Buffer.alloc(ARCHIVE_LIMITS.maxEntryBytes + 1024, 0);
    const zip = makeZip([
      { path: 'skill.json', content: manifest('z') },
      { path: 'SKILL.md', content: '# z' },
      { path: 'references/bomb.bin', content: bomb },
    ]);
    const result = readArchive(zip);
    expect(result.entries.map((e) => e.path)).not.toContain('references/bomb.bin');
    expect(result.skipped.join()).toContain('单条目上限');
  });
});

describe('readArchive 的格式支持', () => {
  it('读 zip（deflate 与 stored 都要能读）', () => {
    const zip = makeZip([
      { path: 'a.txt', content: '压缩的内容' },
      { path: 'b.txt', content: '未压缩的内容', store: true },
    ]);
    const result = readArchive(zip);
    expect(result.format).toBe('zip');
    const byPath = new Map(result.entries.map((e) => [e.path, e.data.toString('utf8')]));
    expect(byPath.get('a.txt')).toBe('压缩的内容');
    expect(byPath.get('b.txt')).toBe('未压缩的内容');
  });

  it('读裸 tar 与 tar.gz', () => {
    const tar = makeTar([{ path: 'a.txt', content: 'tar 内容' }]);
    expect(readArchive(tar).format).toBe('tar');
    const gz = readArchive(gzipSync(tar));
    expect(gz.format).toBe('tar.gz');
    expect(gz.entries[0]?.data.toString('utf8')).toBe('tar 内容');
  });

  it('目录条目不产生文件', () => {
    const tar = makeTar([
      { path: 'dir/', typeflag: '5' },
      { path: 'dir/a.txt', content: 'x' },
    ]);
    expect(readArchive(tar).entries.map((e) => e.path)).toEqual(['dir/a.txt']);
  });

  it('tar 的 GNU 长文件名（typeflag L）能读', () => {
    const longName = `references/${'n'.repeat(120)}.md`;
    const tar = makeTar([
      { path: '././@LongLink', content: longName, typeflag: 'L' },
      { path: longName.slice(0, 100), content: '长名字的内容' },
    ]);
    const result = readArchive(tar);
    expect(result.entries[0]?.path).toBe(longName);
  });

  it('pax 扩展头里的 path 能读', () => {
    const longName = 'references/pax-named-file.md';
    const tar = makeTar([
      {
        path: 'PaxHeader',
        content: `${String(longName.length + 6)} path=${longName}\n`,
        typeflag: 'x',
      },
      { path: 'placeholder', content: 'pax 内容' },
    ]);
    const result = readArchive(tar);
    expect(result.entries[0]?.path).toBe(longName);
  });
});

/* ------------------------------------------------------------------ *
 * 在归档里认技能
 * ------------------------------------------------------------------ */

describe('findArchivedSkills', () => {
  const entry = (path: string, content: string) => ({ path, data: Buffer.from(content, 'utf8') });

  it('认出根目录上的技能', () => {
    const found = findArchivedSkills([
      entry('skill.json', manifest('a')),
      entry('SKILL.md', '# a'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.prefix).toBe('');
    expect(Object.keys(found[0]?.files ?? {}).sort()).toEqual(['SKILL.md', 'skill.json']);
  });

  it('认出多层前缀下的技能，并剥掉前缀', () => {
    const found = findArchivedSkills([
      entry('repo-abc123/skills/mine/skill.json', manifest('mine')),
      entry('repo-abc123/skills/mine/SKILL.md', '# mine'),
      entry('repo-abc123/README.md', '不属于技能'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.prefix).toBe('repo-abc123/skills/mine/');
    expect(Object.keys(found[0]?.files ?? {}).sort()).toEqual(['SKILL.md', 'skill.json']);
  });

  it('一个包里的多个技能各自成组', () => {
    const found = findArchivedSkills([
      entry('a/skill.json', manifest('a')),
      entry('a/SKILL.md', '# a'),
      entry('a/references/x.md', 'x'),
      entry('b/skill.json', manifest('b')),
      entry('b/SKILL.md', '# b'),
    ]);
    expect(found.map((f) => f.prefix)).toEqual(['a/', 'b/']);
    expect(Object.keys(found[0]?.files ?? {})).toContain('references/x.md');
    expect(Object.keys(found[1]?.files ?? {})).not.toContain('references/x.md');
  });

  it('只有 skill.json 没有 SKILL.md 时不算技能', () => {
    expect(findArchivedSkills([entry('a/skill.json', manifest('a'))])).toHaveLength(0);
  });

  it('名字以 skill.json 结尾但不是它的文件不误判', () => {
    const found = findArchivedSkills([entry('notaskill.json', '{}'), entry('SKILL.md', '# x')]);
    expect(found).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

describe('importSkillsFromArchive', () => {
  it('把 zip 里的技能导进用户目录', () => {
    const zip = makeZip([
      { path: 'my-skill/skill.json', content: manifest('my-skill') },
      { path: 'my-skill/SKILL.md', content: '# my-skill\n\n正文内容\n' },
      { path: 'my-skill/references/params.md', content: '参数表' },
    ]);
    const outcome = importSkillsFromArchive({ userDir, data: zip });
    expect(outcome.ok).toBe(true);
    expect(outcome.skills).toHaveLength(1);
    expect(outcome.skills[0]?.slug).toBe('my-skill');
    expect(existsSync(join(userDir, 'my-skill', 'references', 'params.md'))).toBe(true);
    expect(readSkillOrigin(join(userDir, 'my-skill'))?.kind).toBe('archive');
  });

  it('多技能包里坏的那个不影响好的', () => {
    const zip = makeZip([
      { path: 'good/skill.json', content: manifest('good') },
      { path: 'good/SKILL.md', content: '# good\n正文' },
      { path: 'bad/skill.json', content: '{ 坏的 JSON' },
      { path: 'bad/SKILL.md', content: '# bad' },
    ]);
    const outcome = importSkillsFromArchive({ userDir, data: zip });
    expect(outcome.ok).toBe(true);
    expect(outcome.skills.filter((s) => s.ok)).toHaveLength(1);
    expect(outcome.skills.filter((s) => !s.ok)).toHaveLength(1);
    // 要能指认是哪一个坏了
    expect(outcome.skills.find((s) => !s.ok)?.location).toBe('bad');
  });

  it('包里没有技能时说清判据', () => {
    const zip = makeZip([{ path: 'README.md', content: '# 什么都没有' }]);
    const outcome = importSkillsFromArchive({ userDir, data: zip });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join()).toContain('skill.json');
    expect(outcome.errors.join()).toContain('SKILL.md');
  });

  it('损坏的归档不抛错而是回一条能读的消息', () => {
    const outcome = importSkillsFromArchive({ userDir, data: Buffer.from('garbage') });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toHaveLength(1);
  });
});

describe('importSkillsFromDirectory', () => {
  it('从本机目录导入，跳过无关目录', () => {
    const src = join(root, 'src', 'disk-skill');
    mkdirSync(join(src, 'references'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    mkdirSync(join(src, '__pycache__'), { recursive: true });
    writeFileSync(join(src, 'skill.json'), manifest('disk-skill'));
    writeFileSync(join(src, 'SKILL.md'), '# disk-skill\n\n正文\n');
    writeFileSync(join(src, 'references', 'r.md'), '参考');
    writeFileSync(join(src, '.git', 'config'), '[core]');
    writeFileSync(join(src, '__pycache__', 'x.pyc'), 'binary');

    const outcome = importSkillsFromDirectory({ userDir, sourceDir: src });
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(userDir, 'disk-skill', 'references', 'r.md'))).toBe(true);
    expect(existsSync(join(userDir, 'disk-skill', '.git'))).toBe(false);
    expect(outcome.skipped.join()).toContain('.git');
  });

  it('目录不存在时如实报错', () => {
    const outcome = importSkillsFromDirectory({ userDir, sourceDir: join(root, 'nope') });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join()).toContain('不存在');
  });

  it('findSkillRoots 在一棵树里找出多个技能且不进技能内部', () => {
    for (const slug of ['one', 'two']) {
      const dir = join(root, 'many', slug);
      mkdirSync(join(dir, 'references'), { recursive: true });
      writeFileSync(join(dir, 'skill.json'), manifest(slug));
      writeFileSync(join(dir, 'SKILL.md'), `# ${slug}`);
      // 技能内部再放一个「技能」，不该被当成第三个
      const nested = join(dir, 'references', 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'skill.json'), manifest('nested'));
      writeFileSync(join(nested, 'SKILL.md'), '# nested');
    }
    const roots = findSkillRoots(join(root, 'many'));
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r.includes('nested'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * GitHub 标识解析
 * ------------------------------------------------------------------ */

describe('parseGitHubSpec', () => {
  it('接受 owner/repo', () => {
    expect(parseGitHubSpec('acme/skills')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: null,
      subdir: null,
    });
  });

  it('接受 owner/repo@ref', () => {
    expect(parseGitHubSpec('acme/skills@v2')).toMatchObject({ ref: 'v2' });
  });

  it('接受完整仓库网址并去掉 .git', () => {
    expect(parseGitHubSpec('https://github.com/acme/skills.git')).toMatchObject({
      owner: 'acme',
      repo: 'skills',
    });
  });

  it('接受从地址栏复制来的 tree 链接，连 ref 与子目录一起解出来', () => {
    // 这是用户手里最常有的形式，不认它会得到一个「仓库不存在」的误导性错误
    expect(parseGitHubSpec('https://github.com/acme/skills/tree/main/science/alphafold')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: 'main',
      subdir: 'science/alphafold',
    });
  });

  it('拒绝路径穿越与非法字符', () => {
    expect(parseGitHubSpec('acme/skills/tree/main/../../etc')).toHaveProperty('error');
    expect(parseGitHubSpec('acme')).toHaveProperty('error');
    expect(parseGitHubSpec('')).toHaveProperty('error');
  });
});

/* ------------------------------------------------------------------ *
 * 内容审查
 * ------------------------------------------------------------------ */

describe('auditSkillContent', () => {
  it('抓出具体机器上的绝对路径', () => {
    const warnings = auditSkillContent('把文件放到 D:/data/subject01/raw.edf 然后运行');
    expect(warnings.join()).toContain('绝对路径');
  });

  it('抓出 Unix 家目录路径', () => {
    expect(auditSkillContent('读取 /home/li/project/out.csv').join()).toContain('绝对路径');
  });

  it('抓出制品版本引用', () => {
    const warnings = auditSkillContent('用 av_3f8a9c21-0000-4000-8000-000000000000 作为输入');
    expect(warnings.join()).toContain('制品版本');
  });

  it('抓出会话指代', () => {
    expect(auditSkillContent('按刚才的参数再跑一次').join()).toContain('会话指代');
  });

  it('干净的方法学文档不报警告', () => {
    const clean = [
      '## 适用范围',
      '需要对多导睡眠图做分期时用。',
      '## 步骤',
      '1. 用 30 秒窗口重采样到 100 Hz。',
      '2. 固定随机种子后训练。',
      '## 验证',
      '与人工分期的 Cohen kappa 应当不低于 0.7。',
    ].join('\n');
    expect(auditSkillContent(clean)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 蒸馏
 * ------------------------------------------------------------------ */

describe('buildDistillContext', () => {
  const msg = (seq: number, role: string, text: string) =>
    ({ id: `m${String(seq)}`, seq, role, content: text }) as never;

  it('从最早往后取——方法的主干在开头', () => {
    const ctx = buildDistillContext({
      messages: [msg(1, 'user', '第一条'), msg(2, 'assistant', '第二条')],
    });
    expect(ctx.text.indexOf('第一条')).toBeLessThan(ctx.text.indexOf('第二条'));
    expect(ctx.included).toBe(2);
  });

  it('超预算时截断并标记', () => {
    const long = 'x'.repeat(5000);
    const ctx = buildDistillContext({
      messages: [msg(1, 'user', long), msg(2, 'user', long)],
      maxChars: 6000,
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.included).toBe(1);
  });

  it('把实际调用过的工具附在末尾', () => {
    const ctx = buildDistillContext({
      messages: [msg(1, 'user', '做点事')],
      toolUsage: new Map([
        ['python', 3],
        ['save_artifacts', 1],
      ]),
    });
    expect(ctx.text).toContain('python×3');
  });
});

describe('parseDistilledSkill', () => {
  const output = (json: Record<string, unknown>, body: string): string =>
    `${JSON.stringify(json)}\n\n\`\`\`markdown\n${body}\n\`\`\``;

  const validJson = {
    slug: 'psg-pipeline',
    name: 'PSG 处理流程',
    domain: '信号与数据',
    description: '把原始多导睡眠图处理成可分析的分期结果',
    triggers: ['处理 PSG 数据', '睡眠分期流程', 'EDF 预处理'],
    tools: ['python'],
  };

  it('解析出可落盘的两个文件', () => {
    const result = parseDistilledSkill(output(validJson, '# 流程\n\n1. 读 EDF\n2. 重采样'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.slug).toBe('psg-pipeline');
    expect(String(result.draft.files['SKILL.md'])).toContain('读 EDF');
    expect(JSON.parse(String(result.draft.files['skill.json'])).triggers).toHaveLength(3);
  });

  it('剔除不存在的工具名并说明', () => {
    const result = parseDistilledSkill(
      output({ ...validJson, tools: ['python', 'run_shell_magic'] }, '# 正文'),
      { availableTools: ['python', 'r'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(String(result.draft.files['skill.json'])).tools).toEqual(['python']);
    expect(result.draft.manifestWarnings.join()).toContain('run_shell_magic');
  });

  it('模型说不够提炼时如实转达，不硬凑', () => {
    const result = parseDistilledSkill('{"insufficient": "这次只是闲聊"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.insufficient).toBe(true);
  });

  it('缺正文围栏时报错而不是拿 JSON 当正文', () => {
    const result = parseDistilledSkill(JSON.stringify(validJson));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toContain('围栏');
  });

  it('取最后一个围栏块（模型常把 JSON 也包在围栏里）', () => {
    const text = [
      '```json',
      JSON.stringify(validJson),
      '```',
      '',
      '```markdown',
      '# 真正的正文',
      '```',
    ].join('\n');
    const result = parseDistilledSkill(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.draft.files['SKILL.md'])).toContain('真正的正文');
  });

  it('slug 非法时报错', () => {
    const result = parseDistilledSkill(output({ ...validJson, slug: 'Bad Slug!' }, '# 正文'));
    expect(result.ok).toBe(false);
  });

  it('截断的 JSON 明确说是截断', () => {
    const result = parseDistilledSkill('{"slug": "x", "name": "y"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toContain('截断');
  });

  it('把一次性细节作为警告带出来', () => {
    const result = parseDistilledSkill(
      output(validJson, '# 流程\n\n读取 D:/data/s01.edf，刚才那个通道要去掉'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 蒸馏最容易犯这两类错，必须让用户在保存前看到
    expect(result.draft.contentWarnings.join()).toContain('绝对路径');
    expect(result.draft.contentWarnings.join()).toContain('会话指代');
  });
});
