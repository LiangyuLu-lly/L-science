/**
 * 迁移机制测试。
 *
 * 重点是「已发布迁移不可修改」这条约束：如果历史迁移被改过，数据库的实际形状
 * 就无法从代码推断，此时必须报错而不是继续。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate, openDatabase, schemaVersion, sqliteVersion } from '@l-science/core';
import { blobRelPath } from '@l-science/core';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsci-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('数据库', () => {
  it('打开时启用 WAL 与外键', () => {
    const db = openDatabase(join(dir, 'a', 'b', 'p.db'));
    try {
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(sqliteVersion(db)).toMatch(/^3\./);
    } finally {
      db.close();
    }
  });

  it('会自动创建缺失的父目录', () => {
    const db = openDatabase(join(dir, 'deep', 'nested', 'path', 'p.db'));
    db.close();
  });
});

describe('迁移', () => {
  it('空库应用全部迁移后版本正确', () => {
    const db = openDatabase(join(dir, 'p.db'));
    try {
      const applied = migrate(db, MIGRATIONS);
      expect(applied).toBe(MIGRATIONS.length);
      expect(schemaVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    } finally {
      db.close();
    }
  });

  it('重复执行是幂等的', () => {
    const db = openDatabase(join(dir, 'p.db'));
    try {
      migrate(db, MIGRATIONS);
      expect(migrate(db, MIGRATIONS)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('建出设计文档约定的核心表', () => {
    const db = openDatabase(join(dir, 'p.db'));
    try {
      migrate(db, MIGRATIONS);
      const names = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      for (const t of [
        'projects',
        'conversations',
        'messages',
        'tool_calls',
        'blobs',
        'artifacts',
        'artifact_versions',
        'artifact_lineage',
        'plans',
        'findings',
        'providers',
        'models',
        'routing_decisions',
        'routing_feedback',
        'egress_log',
        'skills',
        'refs',
        'claims',
        'claim_evidence',
        'memory_notes',
      ]) {
        expect(names.has(t), `缺少表 ${t}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('匿名化相关表已按范围变更移除', () => {
    const db = openDatabase(join(dir, 'p.db'));
    try {
      migrate(db, MIGRATIONS);
      const names = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      for (const t of ['privacy_entities', 'privacy_lexicon', 'egress_audit']) {
        expect(names.has(t), `${t} 不应存在`).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('外键约束真实生效', () => {
    const db = openDatabase(join(dir, 'p.db'));
    try {
      migrate(db, MIGRATIONS);
      expect(() =>
        db
          .prepare(
            'INSERT INTO conversations (id, project_id, status, created_at, updated_at) VALUES (?,?,?,?,?)',
          )
          .run('c1', 'no-such-project', 'idle', 1, 1),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('已应用迁移被改动时拒绝继续', () => {
    const path = join(dir, 'p.db');
    const first = openDatabase(path);
    migrate(first, MIGRATIONS);
    first.close();

    const tampered = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- 事后追加的改动` } : m,
    );

    const second = openDatabase(path);
    try {
      expect(() => migrate(second, tampered)).toThrow(/不允许修改/);
    } finally {
      second.close();
    }
  });
});

describe('blob 路径', () => {
  it('按 sha256 前两位分桶', () => {
    expect(blobRelPath('abcdef0123')).toMatch(/^ab[\\/]abcdef0123$/);
  });

  it('拒绝非法输入', () => {
    expect(() => blobRelPath('a')).toThrow();
  });
});
