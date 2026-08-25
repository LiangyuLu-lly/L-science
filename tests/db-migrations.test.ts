/**
 * 迁移机制与 schema 结构测试。
 *
 * 除了迁移本身的正确性，这里还锁住一条结构约束：全局配置表只能在应用库，
 * 项目库不得出现。它们曾经被错放在项目库里，后果是每个项目各有一份供应商
 * 注册表，而「列出所有项目」根本无法实现——每个项目库只装自己那一个项目。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_MIGRATIONS,
  PROJECT_MIGRATIONS,
  blobRelPath,
  migrate,
  openDatabase,
  schemaVersion,
  sqliteVersion,
  type Db,
} from '@l-science/core';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsci-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: Db): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('数据库连接', () => {
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

describe('应用库 schema', () => {
  it('应用全部迁移后版本正确', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      expect(migrate(db, APP_MIGRATIONS)).toBe(APP_MIGRATIONS.length);
      expect(schemaVersion(db)).toBe(Math.max(...APP_MIGRATIONS.map((m) => m.version)));
    } finally {
      db.close();
    }
  });

  it('包含跨项目的全局表', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      migrate(db, APP_MIGRATIONS);
      const names = tableNames(db);
      for (const t of [
        'projects',
        'providers',
        'models',
        'skills',
        'connectors',
        'compute_targets',
        'environments',
        'host_grants',
        'domain_allowlist',
        'memory_notes',
      ]) {
        expect(names.has(t), `应用库缺少表 ${t}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('不包含属于单个项目的表', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      migrate(db, APP_MIGRATIONS);
      const names = tableNames(db);
      for (const t of ['conversations', 'messages', 'artifacts', 'findings', 'claims']) {
        expect(names.has(t), `${t} 不该在应用库`).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('projects 表有 archived_at，支持可逆归档', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      migrate(db, APP_MIGRATIONS);
      expect(columnNames(db, 'projects').has('archived_at')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('models 对 providers 的外键生效', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      migrate(db, APP_MIGRATIONS);
      expect(() =>
        db
          .prepare(
            'INSERT INTO models (id, provider_id, model_name, descriptor_json) VALUES (?,?,?,?)',
          )
          .run('m1', 'no-such-provider', 'x', '{}'),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('项目库 schema', () => {
  it('应用全部迁移后版本正确', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      expect(migrate(db, PROJECT_MIGRATIONS)).toBe(PROJECT_MIGRATIONS.length);
      expect(schemaVersion(db)).toBe(Math.max(...PROJECT_MIGRATIONS.map((m) => m.version)));
    } finally {
      db.close();
    }
  });

  it('包含项目内容表', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      const names = tableNames(db);
      for (const t of [
        'project_meta',
        'conversations',
        'messages',
        'tool_calls',
        'blobs',
        'artifacts',
        'artifact_versions',
        'artifact_lineage',
        'plans',
        'plan_steps',
        'reviewer_runs',
        'findings',
        'routing_decisions',
        'routing_feedback',
        'egress_log',
        'approvals',
        'compute_jobs',
        'refs',
        'manuscripts',
        'claims',
        'claim_evidence',
        'memory_notes',
      ]) {
        expect(names.has(t), `项目库缺少表 ${t}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('不包含全局配置表', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      const names = tableNames(db);
      for (const t of [
        'projects',
        'providers',
        'models',
        'skills',
        'connectors',
        'compute_targets',
        'environments',
        'host_grants',
        'domain_allowlist',
      ]) {
        expect(names.has(t), `${t} 属于应用库，不该在项目库`).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('内容表不带 project_id 冗余列', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      for (const t of ['conversations', 'artifacts', 'refs', 'claims', 'memory_notes']) {
        expect(columnNames(db, t).has('project_id'), `${t} 不该有 project_id`).toBe(false);
      }
      // 项目身份只记在 project_meta 单行里
      expect(columnNames(db, 'project_meta').has('project_id')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('project_meta 只允许一行', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      db.prepare('INSERT INTO project_meta (singleton, project_id, created_at) VALUES (1,?,?)').run(
        'p1',
        1,
      );
      expect(() =>
        db
          .prepare('INSERT INTO project_meta (singleton, project_id, created_at) VALUES (2,?,?)')
          .run('p2', 2),
      ).toThrow(); // CHECK (singleton = 1)
      expect(() =>
        db
          .prepare('INSERT INTO project_meta (singleton, project_id, created_at) VALUES (1,?,?)')
          .run('p3', 3),
      ).toThrow(); // 主键冲突
    } finally {
      db.close();
    }
  });

  it('messages 对 conversations 的外键生效', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      expect(() =>
        db
          .prepare(
            'INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?,?,?,?,?,?)',
          )
          .run('m1', 'no-such-conversation', 1, 'user', '{}', 1),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('同一会话内 seq 唯一', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      db.prepare(
        'INSERT INTO conversations (id, status, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('c1', 'idle', 1, 1);
      const ins = db.prepare(
        'INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?,?,?,?,?,?)',
      );
      ins.run('m1', 'c1', 1, 'user', '{}', 1);
      expect(() => ins.run('m2', 'c1', 1, 'user', '{}', 2)).toThrow();
    } finally {
      db.close();
    }
  });

  it('删除会话级联清掉消息与工具调用', () => {
    const db = openDatabase(join(dir, 'project.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      db.prepare(
        'INSERT INTO conversations (id, status, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('c1', 'idle', 1, 1);
      db.prepare(
        'INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?,?,?,?,?,?)',
      ).run('m1', 'c1', 1, 'assistant', '{}', 1);
      db.prepare(
        "INSERT INTO tool_calls (id, message_id, tool_name, status) VALUES (?,?,?,'ok')",
      ).run('t1', 'm1', 'python');

      db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');

      expect((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) n FROM tool_calls').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('迁移机制', () => {
  it('重复执行是幂等的', () => {
    const db = openDatabase(join(dir, 'app.db'));
    try {
      migrate(db, APP_MIGRATIONS);
      expect(migrate(db, APP_MIGRATIONS)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('已应用迁移被改动时拒绝继续', () => {
    const path = join(dir, 'app.db');
    const first = openDatabase(path);
    migrate(first, APP_MIGRATIONS);
    first.close();

    const tampered = APP_MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- 事后追加的改动` } : m,
    );

    const second = openDatabase(path);
    try {
      expect(() => migrate(second, tampered)).toThrow(/不允许修改/);
    } finally {
      second.close();
    }
  });

  it('迁移失败时整条回滚', () => {
    const db = openDatabase(join(dir, 'x.db'));
    try {
      const bad = [
        {
          version: 1,
          name: 'half-bad',
          sql: 'CREATE TABLE ok_table (a); CREATE TABLE 非法语法 (;',
        },
      ];
      expect(() => migrate(db, bad)).toThrow();
      // 事务回滚后前半句建的表也不该留下
      expect(tableNames(db).has('ok_table')).toBe(false);
      expect(schemaVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('两套迁移各自独立编号，互不干扰', () => {
    const app = openDatabase(join(dir, 'app.db'));
    const project = openDatabase(join(dir, 'project.db'));
    try {
      migrate(app, APP_MIGRATIONS);
      migrate(project, PROJECT_MIGRATIONS);

      // 断言各自跑到自己那套的最新版本，而不是写死具体数字——
      // 写死会让每次新增迁移都误报一次失败，而失败并不指向任何真实问题
      const appLatest = Math.max(...APP_MIGRATIONS.map((m) => m.version));
      const projectLatest = Math.max(...PROJECT_MIGRATIONS.map((m) => m.version));
      expect(schemaVersion(app)).toBe(appLatest);
      expect(schemaVersion(project)).toBe(projectLatest);

      // 版本号互不影响，结构也不同
      expect(tableNames(app).has('providers')).toBe(true);
      expect(tableNames(project).has('providers')).toBe(false);
      expect(tableNames(project).has('artifacts')).toBe(true);
      expect(tableNames(app).has('artifacts')).toBe(false);
    } finally {
      app.close();
      project.close();
    }
  });
});

describe('blob 回收标记迁移（v2）', () => {
  it('blobs 表带上 evicted_at 列', () => {
    // 这一列是为了解决「软删除保留版本行 → 外键挡住删 blob 行 → GC 回收不了
    // 空间」这个冲突。没有它，垃圾回收会直接撞 FOREIGN KEY constraint failed
    const db = openDatabase(join(dir, 'evict.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS);
      const columns = (db.prepare('PRAGMA table_info(blobs)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(columns).toContain('evicted_at');
    } finally {
      db.close();
    }
  });

  it('从 v1 增量升级到 v2 而不是重建', () => {
    // 用户已有的项目库必须能就地升级，重建会丢掉全部数据
    const path = join(dir, 'upgrade.db');
    const first = openDatabase(path);
    try {
      migrate(first, [PROJECT_MIGRATIONS[0]!]);
      first
        .prepare(
          "INSERT INTO blobs (sha256, size_bytes, rel_path, refcount, created_at) VALUES ('a', 1, 'a/a', 0, 1)",
        )
        .run();
    } finally {
      first.close();
    }

    const second = openDatabase(path);
    try {
      migrate(second, PROJECT_MIGRATIONS);
      // 升级后旧数据还在
      const row = second.prepare("SELECT sha256, evicted_at FROM blobs WHERE sha256 = 'a'").get();
      expect(row).toMatchObject({ sha256: 'a', evicted_at: null });
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
