/**
 * 项目库的迁移序列。
 *
 * 规则：已发布的迁移永不修改（migrate() 会用校验和强制这一点），结构变更一律新增一条。
 */

import type { Migration } from './db.js';

const M001 = `
-- 项目与会话 --------------------------------------------------------------
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  root_path   TEXT,
  settings_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT,
  agent_id   TEXT,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_conversations_project ON conversations(project_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content_json    TEXT NOT NULL,
  model_id        TEXT,
  provider_id     TEXT,
  usage_json      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE tool_calls (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status     TEXT NOT NULL,
  sandbox_id TEXT,
  exit_code  INTEGER,
  background INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at   INTEGER
);
CREATE INDEX idx_tool_calls_message ON tool_calls(message_id);

-- Artifact 与血缘 ----------------------------------------------------------
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  rel_path   TEXT NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT,
  kind       TEXT,
  latest_version_id TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_artifacts_project ON artifacts(project_id) WHERE deleted_at IS NULL;

CREATE TABLE artifact_versions (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_no  INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  created_by_tool_call_id TEXT,
  language    TEXT,
  code_lineage_json TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (artifact_id, version_no)
);

CREATE TABLE artifact_lineage (
  child_version_id  TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  parent_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  relation          TEXT NOT NULL,
  PRIMARY KEY (child_version_id, parent_version_id)
);

-- 计划与审查 --------------------------------------------------------------
CREATE TABLE plans (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE plan_steps (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase       INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT,
  description TEXT,
  skill_slug  TEXT,
  status      TEXT NOT NULL,
  delegation_json TEXT,
  result_ref  TEXT
);

CREATE TABLE reviewer_runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trigger         TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  summary         TEXT,
  started_at      INTEGER,
  ended_at        INTEGER
);

CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reviewer_run_id TEXT REFERENCES reviewer_runs(id) ON DELETE SET NULL,
  severity        TEXT NOT NULL,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  evidence_json   TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  addressed_note  TEXT,
  addressed_at    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_findings_open ON findings(conversation_id, severity) WHERE status = 'open';

-- 模型与路由 --------------------------------------------------------------
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
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_name      TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health_json     TEXT
);

CREATE TABLE routing_decisions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  message_id      TEXT,
  task_type       TEXT NOT NULL,
  chosen_model_id TEXT,
  candidates_json TEXT NOT NULL,
  score_json      TEXT,
  excluded_json   TEXT,
  reason          TEXT,
  fallback_of     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_routing_task ON routing_decisions(task_type, created_at DESC);

CREATE TABLE routing_feedback (
  id      TEXT PRIMARY KEY,
  routing_decision_id TEXT NOT NULL REFERENCES routing_decisions(id) ON DELETE CASCADE,
  signal  TEXT NOT NULL,
  value   REAL NOT NULL,
  source  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE egress_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  conversation_id TEXT,
  provider_id     TEXT,
  model_id        TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost            REAL,
  latency_ms      INTEGER,
  status          TEXT NOT NULL,
  error           TEXT
);
CREATE INDEX idx_egress_ts ON egress_log(ts DESC);

-- 授权与批准 --------------------------------------------------------------
CREATE TABLE host_grants (
  id         TEXT PRIMARY KEY,
  host_path  TEXT NOT NULL,
  guest_path TEXT,
  mode       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE domain_allowlist (
  id       TEXT PRIMARY KEY,
  scope    TEXT NOT NULL,
  domain   TEXT NOT NULL,
  mode     TEXT NOT NULL,
  reason   TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  state           TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  decided_at      INTEGER
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
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  family         TEXT NOT NULL,
  config_json    TEXT NOT NULL,
  notes_md       TEXT,
  credential_ref TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_probe_json TEXT
);

CREATE TABLE compute_jobs (
  id              TEXT PRIMARY KEY,
  target_id       TEXT NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  conversation_id TEXT,
  external_id     TEXT,
  state           TEXT NOT NULL,
  spec_json       TEXT,
  result_json     TEXT,
  submitted_at    INTEGER,
  finished_at     INTEGER
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

-- 论文流水线 --------------------------------------------------------------
CREATE TABLE refs (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doi        TEXT,
  type       TEXT,
  csl_json   TEXT NOT NULL,
  bibtex     TEXT,
  fulltext_artifact_id TEXT,
  oa_status  TEXT,
  added_at   INTEGER NOT NULL,
  UNIQUE (project_id, doi)
);

CREATE TABLE manuscripts (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT,
  target_journal TEXT,
  style_json     TEXT,
  artifact_id    TEXT,
  status         TEXT
);

CREATE TABLE claims (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  manuscript_id TEXT REFERENCES manuscripts(id) ON DELETE CASCADE,
  locator       TEXT,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_claims_manuscript ON claims(manuscript_id, status);

CREATE TABLE claim_evidence (
  claim_id      TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL,
  evidence_ref  TEXT NOT NULL,
  note          TEXT,
  verdict       TEXT,
  verified_by_model_id TEXT,
  verified_at   INTEGER,
  PRIMARY KEY (claim_id, evidence_kind, evidence_ref)
);

-- 记忆 --------------------------------------------------------------------
CREATE TABLE memory_notes (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  kind       TEXT NOT NULL,
  content_md TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_scope ON memory_notes(scope, scope_id);
`;

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial-schema', sql: M001 }];
