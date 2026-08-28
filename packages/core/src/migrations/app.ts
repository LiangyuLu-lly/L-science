/**
 * 应用级数据库的迁移序列（`config/app.db`）。
 *
 * 这里放**跨项目**的东西：项目注册表、供应商与模型、技能、连接器、算力目标、
 * 环境、宿主授权、域名白名单、全局与算力作用域的记忆。
 *
 * 与项目库分开的理由很实际：设计定的是「按项目分库」，那么「列出所有项目」
 * 就不可能由某个项目库回答——每个库只装自己那一个项目。供应商注册表这类
 * 全局配置若放进项目库，还会变成每个项目各有一份，改一处不影响其他项目。
 */

import type { Migration } from '../db.js';

const M001 = `
-- 项目注册表 ---------------------------------------------------------------
-- 只存元数据；项目内容在各自的 projects/<id>/project.db 里。
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  root_path     TEXT,
  settings_json TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE INDEX idx_projects_active ON projects (updated_at DESC) WHERE archived_at IS NULL;

-- 供应商与模型 -------------------------------------------------------------
CREATE TABLE providers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  adapter        TEXT NOT NULL,
  base_url       TEXT,
  credential_ref TEXT,
  policy_json    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE models (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  model_name      TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health_json     TEXT,
  UNIQUE (provider_id, model_name)
);

-- 技能、连接器、算力、环境 ------------------------------------------------
CREATE TABLE skills (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT,
  scope         TEXT NOT NULL,
  domain        TEXT,
  path          TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE connectors (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  config_json    TEXT NOT NULL,
  credential_ref TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  health_json    TEXT
);

CREATE TABLE compute_targets (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  family          TEXT NOT NULL,
  config_json     TEXT NOT NULL,
  notes_md        TEXT,
  credential_ref  TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_probe_json TEXT
);

CREATE TABLE environments (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  mode           TEXT NOT NULL,
  path           TEXT,
  python_version TEXT,
  r_version      TEXT,
  packages_json  TEXT,
  status         TEXT
);

-- 授权 --------------------------------------------------------------------
-- 宿主路径授权与域名白名单是跨项目的：授权一次不该因为切项目而失效，
-- 但作用域字段允许把某条授权限定到单个项目或单个会话。
CREATE TABLE host_grants (
  id         TEXT PRIMARY KEY,
  host_path  TEXT NOT NULL,
  guest_path TEXT,
  mode       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_host_grants_live ON host_grants (host_path) WHERE revoked_at IS NULL;

CREATE TABLE domain_allowlist (
  id       TEXT PRIMARY KEY,
  scope    TEXT NOT NULL,
  scope_id TEXT,
  domain   TEXT NOT NULL,
  mode     TEXT NOT NULL,
  reason   TEXT,
  added_at INTEGER NOT NULL
);

-- 记忆（全局与算力作用域；项目作用域的记忆在项目库里）--------------------
CREATE TABLE memory_notes (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  kind       TEXT NOT NULL,
  content_md TEXT NOT NULL,
  reason     TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_scope ON memory_notes (scope, scope_id);
`;

/**
 * 技能嵌入向量缓存（需求 9.4）。
 *
 * 嵌入是可选层，但重算的代价不小：三十几个技能一次批量嵌入在本机 Ollama 上是
 * 几秒，而后端每次启动都重算意味着这几秒落在用户第一次检索技能的时候。
 *
 * 缓存键必须同时包含 `model` 与 `text_sha256`：
 * - 换了嵌入模型，旧向量与新查询向量维度或语义空间都不同，混用得到的相似度
 *   是噪声，而它不会报错，只会让检索结果变得莫名其妙。
 * - 技能描述改了而向量没更新，表现是「我改了 triggers 但搜不到」。
 */
const M002 = `
CREATE TABLE skill_embeddings (
  slug        TEXT NOT NULL,
  model       TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, model)
);
`;

export const APP_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'app-initial', sql: M001 },
  { version: 2, name: 'skill-embeddings', sql: M002 },
];
