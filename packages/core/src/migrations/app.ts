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

/**
 * 连接器分组与内置目录（任务 12.13、12.14，需求 14.1、14.2）。
 *
 * 初版 `connectors` 表只有 id / kind / name / config / credential / enabled / health。
 * 内置目录有约五十个公共库连接器，靠这几列撑不起两件事：
 *
 * 1. **按组开关。** 用户不会逐个去关五十个连接器，他关的是「结构与相互作用」这一组。
 *    组同时也是出口白名单的单位——关掉一组就要把它依赖的域名一起从白名单撤下，
 *    否则「关了连接器但网络还通」这种半开状态没人能解释清楚。
 * 2. **区分内置与自建。** 内置的随平台分发、只读、免凭据，升级时要能被整体替换；
 *    自建的是用户资产，升级绝不能碰。混在一张表里且无标记的话，同步逻辑只能靠
 *    id 前缀猜，而猜错的方向是「把用户的连接器删了」。
 *
 * `tool_grants` 独立于 `domain_allowlist`：域名授权管的是「能不能连这个主机」，
 * 工具授权管的是「能不能调这个具体的工具」。同一个连接器上「查基因」与「提交作业」
 * 的风险完全不同，用一条域名授权覆盖两者等于没有管控。
 */
const M003 = `
ALTER TABLE connectors ADD COLUMN group_id TEXT;
ALTER TABLE connectors ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connectors ADD COLUMN transport TEXT;
ALTER TABLE connectors ADD COLUMN source_sha256 TEXT;
ALTER TABLE connectors ADD COLUMN last_error TEXT;
CREATE INDEX idx_connectors_group ON connectors (group_id, enabled);

CREATE TABLE connector_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE connector_domains (
  connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  domain       TEXT NOT NULL,
  PRIMARY KEY (connector_id, domain)
);

CREATE TABLE tool_grants (
  id           TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  scope_id     TEXT,
  granted_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_tool_grants_lookup
  ON tool_grants (connector_id, tool_name, scope) WHERE revoked_at IS NULL;
`;

export const APP_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'app-initial', sql: M001 },
  { version: 2, name: 'skill-embeddings', sql: M002 },
  { version: 3, name: 'connector-groups', sql: M003 },
];
