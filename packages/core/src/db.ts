/**
 * SQLite 持久化。
 *
 * 设计决策 AD-1：用 better-sqlite3（Node-API prebuilt，本机零编译可用）而不是
 * Node 内置的 node:sqlite——后者在 Node 24 仍标记为实验特性。
 *
 * 迁移刻意保持成「顺序编号 + 校验和」的最朴素形式：每条迁移一旦发布就不可修改，
 * 校验和不匹配时直接报错而不是尝试自动修复。
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 打开数据库并应用 PRAGMA。
 *
 * - WAL：读写并发，长时间运行的分析任务不会被 UI 的读取阻塞
 * - foreign_keys：SQLite 默认关闭，必须显式开
 * - busy_timeout：多进程（控制平面 + 可能的旁路工具）访问同一库时避免立即 SQLITE_BUSY
 */
export function openDatabase(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS migrations (
  version   INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  checksum  TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`;

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * 应用迁移。已应用过的迁移会校验 checksum；不一致时抛错而非静默继续，
 * 因为那意味着历史迁移被改过，数据库的实际形状已经不可推断。
 */
export function migrate(db: Db, migrations: readonly Migration[]): number {
  db.exec(MIGRATIONS_TABLE);

  const applied = new Map<number, MigrationRow>();
  for (const row of db
    .prepare('SELECT version, name, checksum FROM migrations')
    .all() as MigrationRow[]) {
    applied.set(row.version, row);
  }

  const pending = [...migrations].sort((a, b) => a.version - b.version);
  let count = 0;

  for (const m of pending) {
    const prev = applied.get(m.version);
    const sum = checksum(m.sql);

    if (prev !== undefined) {
      if (prev.checksum !== sum) {
        throw new Error(
          `迁移 ${m.version} (${m.name}) 的内容与已应用版本不一致（期望校验和 ${prev.checksum}，实际 ${sum}）。` +
            '已发布的迁移不允许修改，请新增一条迁移来变更结构。',
        );
      }
      continue;
    }

    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.name, sum, Date.now());
    });
    run();
    count += 1;
  }

  return count;
}

/** 当前 schema 版本，即已应用的最大迁移号。空库返回 0。 */
export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function sqliteVersion(db: Db): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  return row.v;
}
