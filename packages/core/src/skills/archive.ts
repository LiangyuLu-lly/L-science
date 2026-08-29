/**
 * 压缩包读取（任务 12.15，需求 9.6）。
 *
 * 技能上传要接受 `.zip`（用户手里最常见）与 `.tar.gz`（GitHub 的仓库归档就是这个）。
 *
 * ## 为什么自己实现而不是加依赖
 *
 * 两个理由，第二个是决定性的：
 *
 * - 这两种格式在「读取一个几百 KB 的归档」这个用途上都很小：tar 是定长头
 *   加数据块，zip 是中央目录加 deflate 流，而 deflate 由 `node:zlib` 提供。
 * - **解压是攻击面**。zip-slip（`../../` 逃出目标目录）、符号链接指向系统文件、
 *   解压炸弹（几 KB 压出几 GB）三类问题都要在这一层挡住。用第三方库的话，
 *   这些防护取决于那个库当年的实现选择，而且要靠读它的源码才能确认；自己写
 *   则可以把「条目数、单条大小、合计大小」三个上限写在明面上。
 *
 * ## 返回内存而不是写盘
 *
 * `readArchive` 返回条目列表而不是解压到目录：调用方接着要判断「这个包里有几个
 * 技能」并做校验，任何一步失败都不该在磁盘上留下半个技能。归档本身受大小上限
 * 约束，放内存里是安全的。
 */

import { gunzipSync, inflateRawSync } from 'node:zlib';

export interface ArchiveEntry {
  /** 归档内的路径，一律 `/` 分隔，已确认不含 `..` 与绝对路径。 */
  path: string;
  data: Buffer;
}

export interface ArchiveResult {
  format: 'zip' | 'tar' | 'tar.gz';
  entries: readonly ArchiveEntry[];
  /** 被跳过的条目及原因。符号链接、越界路径、超限文件都在这里。 */
  skipped: readonly string[];
}

export const ARCHIVE_LIMITS = {
  /** 归档文件本身的字节上限。 */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** 条目数上限。 */
  maxEntries: 2000,
  /** 单条目解压后的字节上限。 */
  maxEntryBytes: 8 * 1024 * 1024,
  /** 全部条目解压后合计的字节上限。挡解压炸弹。 */
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

export type ArchiveLimits = {
  -readonly [K in keyof typeof ARCHIVE_LIMITS]: number;
};

/**
 * 上限可以按调用方覆盖。
 *
 * 默认值是按「用户上传一个技能包」定的。PMC 的开放获取包（任务 13.2）是另一种
 * 量级：一篇带十几张高分辨率插图的论文，压缩包常在 30-80MB，单张 TIFF 就能超过
 * 8MB。用默认上限去解它的结果是插图被逐个跳过，而需求 12.4 要的正是那些插图。
 *
 * 覆盖上限不等于放弃防护：三个上限仍然都在，只是数值由调用方按用途声明。
 * 保持它们必须被显式给出，而不是在超限时自动放宽——自动放宽等于没有上限。
 */
function resolveLimits(override?: Partial<ArchiveLimits>): ArchiveLimits {
  return { ...ARCHIVE_LIMITS, ...(override ?? {}) };
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/**
 * 归一化并校验归档内路径。
 *
 * 返回 null 表示这个条目必须丢掉。三类要挡的东西：绝对路径（`/etc/passwd`）、
 * 盘符（`C:\Windows`）、上跳（`../../`）。任何一条漏掉，解压就能写到目标目录之外。
 */
function safePath(raw: string): string | null {
  // tar 允许 `./` 前缀，zip 里也常见
  let path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  while (path.startsWith('/')) path = path.slice(1);
  if (/^[A-Za-z]:/.test(path)) return null;
  if (path === '' || path.endsWith('/')) return null; // 目录条目不单独保留

  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  if (segments.length === 0) return null;
  return segments.join('/');
}

/* ------------------------------------------------------------------ *
 * tar
 * ------------------------------------------------------------------ */

/** tar 的数值字段是八进制 ASCII；GNU 对大数值改用 base-256。 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length);
  if ((raw[0] ?? 0) & 0x80) {
    // base-256：最高位为符号位，其余按大端整数
    let value = 0;
    for (let i = 0; i < raw.length; i += 1) {
      value = value * 256 + ((raw[i] ?? 0) & (i === 0 ? 0x7f : 0xff));
    }
    return value;
  }
  const text = raw.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
}

function readTar(
  buf: Buffer,
  limits: ArchiveLimits,
): { entries: ArchiveEntry[]; skipped: string[] } {
  const entries: ArchiveEntry[] = [];
  const skipped: string[] = [];
  let total = 0;

  /** GNU 长文件名（typeflag 'L'）或 pax `path=` 记录会给下一个条目改名。 */
  let pendingName: string | null = null;

  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // 两个全零块表示结束；单个全零块也当结束处理（有的实现只写一个）
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      skipped.push(`${rawName}（归档被截断）`);
      break;
    }
    // 数据按 512 对齐
    offset = dataStart + Math.ceil(size / 512) * 512;

    const name = pendingName ?? (prefix === '' ? rawName : `${prefix}/${rawName}`);
    if (typeflag !== 'L' && typeflag !== 'x' && typeflag !== 'g') pendingName = null;

    switch (typeflag) {
      case 'L': {
        // 本块的数据就是下一个条目的文件名
        pendingName = buf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      case 'x': {
        // pax 扩展头：`<len> path=<value>\n`
        const text = buf.subarray(dataStart, dataEnd).toString('utf8');
        const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
        if (match?.[1] !== undefined) pendingName = match[1];
        continue;
      }
      case 'g':
        continue; // 全局扩展头，与单个条目无关
      case '5':
        continue; // 目录：文件路径本身已经隐含目录结构
      case '1':
      case '2':
        // 硬链接与符号链接会把归档之外的文件带进来
        skipped.push(`${name}（${typeflag === '2' ? '符号' : '硬'}链接）`);
        continue;
      case '0':
      case '\0':
      case '7':
        break; // 普通文件
      default:
        skipped.push(`${name}（不支持的条目类型 ${typeflag}）`);
        continue;
    }

    const path = safePath(name);
    if (path === null) {
      skipped.push(`${name}（路径越界或非法）`);
      continue;
    }
    if (size > limits.maxEntryBytes) {
      skipped.push(`${path}（${String(Math.round(size / 1024))} KB，超过单条目上限）`);
      continue;
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError('归档解压后超过总大小上限，已中止');
    }
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(`归档条目数超过上限 ${String(limits.maxEntries)}，已中止`);
    }

    entries.push({ path, data: buf.subarray(dataStart, dataEnd) });
  }

  return { entries, skipped };
}

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从尾部往前找 EOCD。注释最长 65535 字节，所以搜索范围有界。 */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** 解析 zip64 扩展信息（extra field 0x0001），按需覆盖 32 位字段。 */
function readZip64Extra(
  extra: Buffer,
  need: { uncompressed: boolean; compressed: boolean; localOffset: boolean },
): { uncompressed?: number; compressed?: number; localOffset?: number } {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = extra.subarray(cursor + 4, cursor + 4 + size);
    cursor += 4 + size;
    if (id !== 0x0001) continue;

    const out: { uncompressed?: number; compressed?: number; localOffset?: number } = {};
    let p = 0;
    // 字段按「原字段为 0xFFFFFFFF 才出现」的顺序排列
    if (need.uncompressed && p + 8 <= body.length) {
      out.uncompressed = Number(body.readBigUInt64LE(p));
      p += 8;
    }
    if (need.compressed && p + 8 <= body.length) {
      out.compressed = Number(body.readBigUInt64LE(p));
      p += 8;
    }
    if (need.localOffset && p + 8 <= body.length) {
      out.localOffset = Number(body.readBigUInt64LE(p));
    }
    return out;
  }
  return {};
}

function readZip(
  buf: Buffer,
  limits: ArchiveLimits,
): { entries: ArchiveEntry[]; skipped: string[] } {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new ArchiveError('不是合法的 zip：找不到中央目录结束记录');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // zip64：32 位字段放不下时用 0xFFFF/0xFFFFFFFF 占位，真值在 zip64 记录里
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
      if (eocd64 >= 0 && eocd64 + 56 <= buf.length && buf.readUInt32LE(eocd64) === EOCD64_SIG) {
        count = Number(buf.readBigUInt64LE(eocd64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
      }
    }
  }

  const entries: ArchiveEntry[] = [];
  const skipped: string[] = [];
  let total = 0;
  let cursor = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new ArchiveError(`zip 中央目录在第 ${String(i + 1)} 项处损坏`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    let uncompressed = buf.readUInt32LE(cursor + 24);
    let compressed = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    let localOffset = buf.readUInt32LE(cursor + 42);

    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const extra = buf.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    const zip64 = readZip64Extra(extra, {
      uncompressed: uncompressed === 0xffffffff,
      compressed: compressed === 0xffffffff,
      localOffset: localOffset === 0xffffffff,
    });
    if (zip64.uncompressed !== undefined) uncompressed = zip64.uncompressed;
    if (zip64.compressed !== undefined) compressed = zip64.compressed;
    if (zip64.localOffset !== undefined) localOffset = zip64.localOffset;

    if (name.endsWith('/')) continue; // 目录条目

    // Unix 模式在外部属性的高 16 位；S_IFLNK 是 0xA000
    if (((externalAttrs >>> 16) & 0xf000) === 0xa000) {
      skipped.push(`${name}（符号链接）`);
      continue;
    }

    const path = safePath(name);
    if (path === null) {
      skipped.push(`${name}（路径越界或非法）`);
      continue;
    }
    if (uncompressed > limits.maxEntryBytes) {
      skipped.push(`${path}（${String(Math.round(uncompressed / 1024))} KB，超过单条目上限）`);
      continue;
    }
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(`归档条目数超过上限 ${String(limits.maxEntries)}，已中止`);
    }

    /*
     * 数据起点要用本地头重新算：中央目录里的名字长度与本地头的可以不同
     * （有的打包器在本地头里放短名、中央目录里放长名），按中央目录的长度去偏移
     * 会读到数据中间。
     */
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      skipped.push(`${path}（本地文件头损坏）`);
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressed;
    if (dataEnd > buf.length) {
      skipped.push(`${path}（数据超出归档范围）`);
      continue;
    }
    const raw = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
      else {
        skipped.push(`${path}（不支持的压缩方式 ${String(method)}）`);
        continue;
      }
    } catch (err) {
      skipped.push(`${path}（解压失败：${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }

    total += data.byteLength;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError('归档解压后超过总大小上限，已中止');
    }

    entries.push({ path, data });
  }

  return { entries, skipped };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 按内容嗅探格式。不看扩展名——上传过来的文件名不可信。
 *
 * `options.limits` 只覆盖给出的那几项，其余保持默认。见 `resolveLimits`。
 */
export function readArchive(
  data: Buffer,
  options: { limits?: Partial<ArchiveLimits> } = {},
): ArchiveResult {
  const limits = resolveLimits(options.limits);

  if (data.byteLength > limits.maxArchiveBytes) {
    throw new ArchiveError(
      `归档有 ${String(Math.round(data.byteLength / 1024 / 1024))} MB，超过上限 ` +
        `${String(Math.round(limits.maxArchiveBytes / 1024 / 1024))} MB`,
    );
  }
  if (data.byteLength < 4) throw new ArchiveError('文件太小，不是有效的归档');

  // gzip
  if (data[0] === 0x1f && data[1] === 0x8b) {
    let plain: Buffer;
    try {
      plain = gunzipSync(data, { maxOutputLength: limits.maxTotalBytes });
    } catch (err) {
      throw new ArchiveError(`gzip 解压失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const { entries, skipped } = readTar(plain, limits);
    return { format: 'tar.gz', entries, skipped };
  }

  // zip：本地文件头签名，或空归档/分卷的其他签名
  if (data.readUInt32LE(0) === LOCAL_SIG || data.readUInt32LE(0) === EOCD_SIG) {
    const { entries, skipped } = readZip(data, limits);
    return { format: 'zip', entries, skipped };
  }

  // 裸 tar：第 257 字节起是 `ustar`
  if (data.byteLength >= 512 && data.subarray(257, 262).toString('ascii') === 'ustar') {
    const { entries, skipped } = readTar(data, limits);
    return { format: 'tar', entries, skipped };
  }

  throw new ArchiveError(
    '无法识别的归档格式。支持 .zip、.tar 与 .tar.gz（.tgz）；' +
      '如果这是 .rar 或 .7z，请先转成 zip',
  );
}

/* ------------------------------------------------------------------ *
 * 从归档条目里认出技能
 * ------------------------------------------------------------------ */

export interface ArchivedSkill {
  /** 归档内该技能所在的目录，根上就是技能时为空串。 */
  prefix: string;
  files: Readonly<Record<string, Buffer>>;
}

/**
 * 在归档条目里找出所有技能，并把路径改成相对技能目录。
 *
 * 三种真实形态都要认：包根就是一个技能、包里有 `<slug>/` 一层（用户直接压缩了
 * 技能文件夹）、包里有一批技能（GitHub 仓库归档会多一层 `owner-repo-<sha>/`，
 * 里面可能还有 `skills/<slug>/`）。
 *
 * 判据是「同一目录下同时有 `skill.json` 与 `SKILL.md`」，与加载器一致。
 */
export function findArchivedSkills(entries: readonly ArchiveEntry[]): readonly ArchivedSkill[] {
  const byPath = new Map(entries.map((e) => [e.path, e.data]));

  const prefixes: string[] = [];
  for (const path of byPath.keys()) {
    if (!path.endsWith('skill.json')) continue;
    const prefix = path.slice(0, path.length - 'skill.json'.length);
    if (prefix !== '' && !prefix.endsWith('/')) continue; // 形如 `xskill.json`
    if (!byPath.has(`${prefix}SKILL.md`)) continue;
    prefixes.push(prefix);
  }

  // 嵌套时取最外层：一个技能的 references 里不会再放技能，但万一有，外层才是本体
  const roots = prefixes.filter(
    (p) => !prefixes.some((other) => other !== p && p.startsWith(other)),
  );

  return roots.sort().map((prefix) => {
    const files: Record<string, Buffer> = {};
    for (const [path, data] of byPath) {
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      if (rel === '' || rel.includes('/../')) continue;
      // 别的技能目录不算这个技能的文件
      if (roots.some((other) => other !== prefix && path.startsWith(other))) continue;
      files[rel] = data;
    }
    return { prefix, files };
  });
}
