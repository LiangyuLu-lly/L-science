/**
 * 内容寻址 blob 存储（任务 7.1，需求 6.1、1.5）。
 *
 * 按 sha256 分两级桶落盘：`blobs/<前两位>/<完整 sha>`。分桶是为了避开单目录
 * 几万个文件时的性能塌陷——Windows 上 NTFS 目录枚举在文件数上万后明显变慢，
 * 而制品在长期项目里很容易积累到这个量级。
 *
 * refcount 与版本行的一致性是这里最要紧的事。次序是刻意的：
 *
 * 1. 先把文件写到最终位置（内容寻址，因此重复写入是幂等的）
 * 2. 再在**同一个事务**里插入 blob 行、递增 refcount、插入版本行
 *
 * 崩溃点的后果因此是可控的：文件写完但事务没提交，留下一个磁盘上的孤儿文件
 * ——浪费空间但无害，且可以被 `sweepOrphans()` 发现。反过来（先写库后写文件）
 * 会留下一个指向不存在文件的版本记录，那是真正的数据损坏，而且要等到用户
 * 打开那张图时才暴露。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Db } from '../db.js';
import { blobRelPath } from '../paths.js';

export interface BlobRecord {
  sha256: string;
  sizeBytes: number;
  /** 相对 blobs 根目录的路径。存相对路径以便整个项目目录可以搬走。 */
  relPath: string;
  refcount: number;
  createdAt: number;
}

interface BlobRow {
  sha256: string;
  size_bytes: number;
  rel_path: string;
  refcount: number;
  created_at: number;
}

function toRecord(row: BlobRow): BlobRecord {
  return {
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    relPath: row.rel_path,
    refcount: row.refcount,
    createdAt: row.created_at,
  };
}

/** 计算 sha256。流式读取，避免把大文件整个装进内存。 */
export async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += buf.length;
      hash.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({ sha256: hash.digest('hex'), sizeBytes });
    });
  });
}

export function hashBuffer(buffer: Buffer): { sha256: string; sizeBytes: number } {
  return { sha256: createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.length };
}

// 分桶路径由 paths.ts 的 blobRelPath 提供，不在这里重复定义。
// 我最初在本文件又写了一份（返回正斜杠），与 paths.ts 里的（用 join，
// Windows 上返回反斜杠）在 barrel 导出里撞名，实际生效的是后者——症状是
// 单元测试断言正斜杠却收到反斜杠，而两个文件的源码看起来都"对"。

export class BlobStore {
  readonly #db: Db;
  readonly #root: string;

  constructor(db: Db, blobsRoot: string) {
    this.#db = db;
    this.#root = blobsRoot;
    mkdirSync(blobsRoot, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** blob 的绝对路径。 */
  absolutePath(sha256: string): string {
    return join(this.#root, blobRelPath(sha256));
  }

  get(sha256: string): BlobRecord | null {
    const row = this.#db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha256) as
      BlobRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * 把内容写入 blob 存储。已存在则不重复写盘（需求 6.1 的去重）。
   *
   * **不递增 refcount**：引用计数属于「谁引用了它」这个事实，由创建版本行的
   * 事务负责。在这里递增会让「暂存但最终没被引用」的 blob 永远回收不掉。
   */
  put(content: Buffer): BlobRecord {
    const { sha256, sizeBytes } = hashBuffer(content);
    return this.#persist(sha256, sizeBytes, (target) => {
      writeFileSync(target, content);
    });
  }

  /** 从已有文件导入。流式计算 sha，避免把大文件读进内存。 */
  async putFile(sourcePath: string): Promise<BlobRecord> {
    const { sha256, sizeBytes } = await hashFile(sourcePath);
    return this.#persist(sha256, sizeBytes, (target) => {
      // 先复制到临时名再改名：直接写目标路径时，若并发有另一个进程正在读
      // 同一个 blob（内容相同因此路径相同），Windows 会因文件占用而失败
      const tmp = `${target}.incoming-${String(process.pid)}-${String(Date.now())}`;
      copyFileSync(sourcePath, tmp);
      renameSync(tmp, target);
    });
  }

  #persist(sha256: string, sizeBytes: number, write: (target: string) => void): BlobRecord {
    const existing = this.get(sha256);
    const target = this.absolutePath(sha256);

    // 内容寻址意味着同 sha 必然同内容，因此文件已存在时无需重写。
    // 这既是去重，也避免了覆盖一个正在被读取的文件
    if (existing !== null && existsSync(target)) return existing;

    mkdirSync(join(this.#root, sha256.slice(0, 2)), { recursive: true });
    if (!existsSync(target)) write(target);

    const record: BlobRecord = {
      sha256,
      sizeBytes,
      relPath: blobRelPath(sha256),
      refcount: existing?.refcount ?? 0,
      createdAt: existing?.createdAt ?? Date.now(),
    };

    this.#db
      .prepare(
        `INSERT INTO blobs (sha256, size_bytes, rel_path, refcount, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sha256) DO NOTHING`,
      )
      .run(record.sha256, record.sizeBytes, record.relPath, record.refcount, record.createdAt);

    return record;
  }

  /**
   * 递增引用计数。必须在插入版本行的同一事务里调用。
   *
   * 单独暴露而不是藏在 put 里，是为了让调用点必须显式表达「我要引用它」——
   * 这个动作与「把内容存起来」在生命周期上不同。
   */
  addRef(sha256: string): void {
    const info = this.#db
      .prepare('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?')
      .run(sha256);
    if (info.changes === 0) {
      throw new Error(`blob 不存在，无法引用：${sha256}`);
    }
  }

  /**
   * 递减引用计数。
   *
   * 用 `MAX(0, ...)` 而不是允许变负：负的 refcount 说明有 bug，但让它变负会
   * 让这个 blob 永远无法被回收，故障从「计数错了」升级成「空间永久泄漏」。
   * 夹在 0 上至少保证 GC 仍能工作。
   */
  release(sha256: string): number {
    this.#db
      .prepare('UPDATE blobs SET refcount = MAX(0, refcount - 1) WHERE sha256 = ?')
      .run(sha256);
    return this.get(sha256)?.refcount ?? 0;
  }

  /**
   * refcount 归零、内容尚未被回收的 blob。
   *
   * 排除已回收的：不排除的话每次 GC 都会重复处理同一批，`removed` 里塞满
   * 早就删过的 sha，`freedBytes` 也会重复计数，看起来像是一直在回收空间
   * 而实际上什么都没发生。
   */
  unreferenced(): readonly BlobRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM blobs WHERE refcount = 0 AND evicted_at IS NULL ORDER BY created_at')
      .all() as BlobRow[];
    return rows.map(toRecord);
  }

  /**
   * 回收未被引用的 blob 的**内容**，保留其记录行。
   *
   * 为什么不删行：软删除刻意保留 artifact_versions（血缘不能断），而版本行的
   * `blob_sha256` 外键指向 blobs。删 blobs 行会直接撞
   * `FOREIGN KEY constraint failed`，空间根本回收不了。因此把「内容还在吗」
   * 与「记录还在吗」分开：删文件、打 evicted_at、行留着。血缘完整，空间也回收了。
   *
   * `minAgeMs` 存在的原因：刚 put 进来但还没被任何版本引用的 blob 是正常的
   * 中间状态（保存流程分两步：先落 blob，再在事务里建版本行）。立即回收会把
   * 正在进行的保存操作的内容删掉。默认保留一小时。
   */
  collectGarbage(options: { minAgeMs?: number; dryRun?: boolean } = {}): {
    removed: readonly string[];
    freedBytes: number;
  } {
    const minAgeMs = options.minAgeMs ?? 60 * 60 * 1000;
    const cutoff = Date.now() - minAgeMs;

    const candidates = this.unreferenced().filter((b) => b.createdAt <= cutoff);
    const removed: string[] = [];
    let freedBytes = 0;

    for (const blob of candidates) {
      if (options.dryRun === true) {
        removed.push(blob.sha256);
        freedBytes += blob.sizeBytes;
        continue;
      }

      const path = this.absolutePath(blob.sha256);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Windows 上文件可能被占用。跳过它而不是打标记：打了标记但文件还在，
        // 下次就不会再试着删了，空间永久占住
        continue;
      }

      // 文件已删才打标记，次序不能反
      this.#db
        .prepare('UPDATE blobs SET evicted_at = ? WHERE sha256 = ? AND refcount = 0')
        .run(Date.now(), blob.sha256);

      removed.push(blob.sha256);
      freedBytes += blob.sizeBytes;
    }

    return { removed, freedBytes };
  }

  /**
   * 内容是否已被回收。
   *
   * 与「文件不存在」分开判断，因为两者对用户的含义完全不同：内容被主动回收是
   * 预期行为（可以如实告知「这个版本的内容已回收，血缘记录仍在」），文件意外
   * 丢失是数据损坏（需要告警）。合成一个「读不到」会让后者被当成前者忽略掉。
   */
  isEvicted(sha256: string): boolean {
    const row = this.#db.prepare('SELECT evicted_at FROM blobs WHERE sha256 = ?').get(sha256) as
      { evicted_at: number | null } | undefined;
    return row?.evicted_at !== null && row?.evicted_at !== undefined;
  }

  /**
   * 清理磁盘上没有对应库行的孤儿文件。
   *
   * 这类文件来自「写文件成功但事务未提交」的崩溃点。它们无害但占空间，
   * 而且只能靠扫盘发现——没有任何记录指向它们。
   */
  sweepOrphans(): { removed: number; freedBytes: number } {
    if (!existsSync(this.#root)) return { removed: 0, freedBytes: 0 };

    const known = new Set(
      (this.#db.prepare('SELECT sha256 FROM blobs').all() as Array<{ sha256: string }>).map(
        (r) => r.sha256,
      ),
    );

    let removed = 0;
    let freedBytes = 0;

    for (const bucket of readdirSync(this.#root, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = join(this.#root, bucket.name);

      for (const entry of readdirSync(bucketPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (known.has(entry.name)) continue;

        const path = join(bucketPath, entry.name);
        try {
          freedBytes += statSync(path).size;
          unlinkSync(path);
          removed += 1;
        } catch {
          // 占用中，下次再说
        }
      }
    }

    return { removed, freedBytes };
  }

  /** 存储统计，用于设置页显示与去重效果验证。 */
  stats(): { blobCount: number; totalBytes: number; referencedCount: number } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(CASE WHEN refcount > 0 THEN 1 ELSE 0 END), 0) AS referenced
         FROM blobs`,
      )
      .get() as { n: number; bytes: number; referenced: number };
    return { blobCount: row.n, totalBytes: row.bytes, referencedCount: row.referenced };
  }
}
