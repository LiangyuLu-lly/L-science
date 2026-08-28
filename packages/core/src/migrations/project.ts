/**
 * 项目库的迁移序列（`projects/<id>/project.db`）。
 *
 * 这里放属于单个项目的一切：会话与消息、artifact 与血缘、计划与审查、
 * 路由决策、审批、论文流水线、项目作用域的记忆。
 *
 * 表里不带 `project_id` 列：数据库文件本身就是项目边界，再冗余一列只会带来
 * 「列值与所在文件不一致」这种不可能被约束住的状态。项目身份记在
 * `project_meta` 单行里，用于检测被误复制到别处的库。
 */

import type { Migration } from '../db.js';

const M001 = `
-- 自我标识 ----------------------------------------------------------------
-- 单行表。库被复制或错放时可据此发现。
CREATE TABLE project_meta (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 会话 --------------------------------------------------------------------
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  agent_id   TEXT,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_conversations_recent ON conversations (updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content_json    TEXT NOT NULL,
  model_id        TEXT,
  provider_id     TEXT,
  usage_json      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
-- 按游标向前翻页用（seq 降序）
CREATE INDEX idx_messages_page ON messages (conversation_id, seq DESC);

CREATE TABLE tool_calls (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  input_json  TEXT,
  output_json TEXT,
  status     TEXT NOT NULL,
  sandbox_id TEXT,
  exit_code  INTEGER,
  background INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at   INTEGER
);
CREATE INDEX idx_tool_calls_message ON tool_calls (message_id);
CREATE INDEX idx_tool_calls_running ON tool_calls (status) WHERE status = 'running';

-- Artifact 与血缘 ----------------------------------------------------------
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  rel_path   TEXT NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_blobs_unreferenced ON blobs (sha256) WHERE refcount = 0;

CREATE TABLE artifacts (
  id                TEXT PRIMARY KEY,
  filename          TEXT NOT NULL,
  mime              TEXT,
  kind              TEXT,
  latest_version_id TEXT,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_artifacts_live ON artifacts (created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE artifact_versions (
  id                      TEXT PRIMARY KEY,
  artifact_id             TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version_no              INTEGER NOT NULL,
  blob_sha256             TEXT NOT NULL REFERENCES blobs (sha256),
  created_by_tool_call_id TEXT,
  language                TEXT,
  code_lineage_json       TEXT,
  created_at              INTEGER NOT NULL,
  UNIQUE (artifact_id, version_no)
);

CREATE TABLE artifact_lineage (
  child_version_id  TEXT NOT NULL REFERENCES artifact_versions (id) ON DELETE CASCADE,
  parent_version_id TEXT NOT NULL REFERENCES artifact_versions (id) ON DELETE CASCADE,
  relation          TEXT NOT NULL,
  PRIMARY KEY (child_version_id, parent_version_id)
);

-- 计划与审查 --------------------------------------------------------------
CREATE TABLE plans (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE plan_steps (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  phase           INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  title           TEXT,
  description     TEXT,
  skill_slug      TEXT,
  status          TEXT NOT NULL,
  delegation_json TEXT,
  result_ref      TEXT,
  UNIQUE (plan_id, phase, seq)
);

CREATE TABLE reviewer_runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  trigger         TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  summary         TEXT,
  started_at      INTEGER,
  ended_at        INTEGER
);

CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  reviewer_run_id TEXT REFERENCES reviewer_runs (id) ON DELETE SET NULL,
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
CREATE INDEX idx_findings_open ON findings (conversation_id, severity) WHERE status = 'open';

-- 路由与用量 --------------------------------------------------------------
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
CREATE INDEX idx_routing_task ON routing_decisions (task_type, created_at DESC);

CREATE TABLE routing_feedback (
  id                  TEXT PRIMARY KEY,
  routing_decision_id TEXT NOT NULL REFERENCES routing_decisions (id) ON DELETE CASCADE,
  signal              TEXT NOT NULL,
  value               REAL NOT NULL,
  source              TEXT NOT NULL,
  created_at          INTEGER NOT NULL
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
CREATE INDEX idx_egress_ts ON egress_log (ts DESC);

-- 审批 --------------------------------------------------------------------
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  state           TEXT NOT NULL,
  note            TEXT,
  requested_at    INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX idx_approvals_pending ON approvals (requested_at) WHERE state = 'pending';

-- 算力作业（与会话关联，因此属于项目）------------------------------------
CREATE TABLE compute_jobs (
  id              TEXT PRIMARY KEY,
  target_id       TEXT NOT NULL,
  conversation_id TEXT,
  external_id     TEXT,
  state           TEXT NOT NULL,
  spec_json       TEXT,
  result_json     TEXT,
  submitted_at    INTEGER,
  finished_at     INTEGER
);

-- 论文流水线 --------------------------------------------------------------
CREATE TABLE refs (
  id                   TEXT PRIMARY KEY,
  doi                  TEXT,
  type                 TEXT,
  csl_json             TEXT NOT NULL,
  bibtex               TEXT,
  fulltext_artifact_id TEXT,
  oa_status            TEXT,
  added_at             INTEGER NOT NULL,
  UNIQUE (doi)
);

CREATE TABLE manuscripts (
  id             TEXT PRIMARY KEY,
  title          TEXT,
  target_journal TEXT,
  style_json     TEXT,
  artifact_id    TEXT,
  status         TEXT
);

CREATE TABLE claims (
  id            TEXT PRIMARY KEY,
  manuscript_id TEXT REFERENCES manuscripts (id) ON DELETE CASCADE,
  locator       TEXT,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_claims_manuscript ON claims (manuscript_id, status);

CREATE TABLE claim_evidence (
  claim_id             TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  evidence_kind        TEXT NOT NULL,
  evidence_ref         TEXT NOT NULL,
  note                 TEXT,
  verdict              TEXT,
  verified_by_model_id TEXT,
  verified_at          INTEGER,
  PRIMARY KEY (claim_id, evidence_kind, evidence_ref)
);

-- 项目作用域的记忆 --------------------------------------------------------
CREATE TABLE memory_notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  content_md TEXT NOT NULL,
  reason     TEXT,
  updated_at INTEGER NOT NULL
);
`;

/**
 * blob 的内容回收标记。
 *
 * 起因是一个设计冲突：软删除刻意保留 artifact_versions 行（血缘不能断），
 * 而版本行的 blob_sha256 外键指向 blobs，因此 blobs 行删不掉——垃圾回收
 * 直接撞 FOREIGN KEY constraint failed，空间根本回收不了。
 *
 * 解法是把「内容还在吗」与「记录还在吗」分开：GC 删掉磁盘文件并打上
 * evicted_at，blobs 行与版本行都保留。血缘因此完整，空间也能回收。
 *
 * 单独记这个时间戳而不是只靠「文件不存在」推断，是为了区分两件事：
 * 内容被主动回收（预期行为，可以如实告知用户）与文件意外丢失（数据损坏，
 * 需要告警）。两者对用户的含义完全不同。
 */
const M002 = `
ALTER TABLE blobs ADD COLUMN evicted_at INTEGER;
CREATE INDEX idx_blobs_evicted ON blobs (evicted_at) WHERE evicted_at IS NOT NULL;
`;

/**
 * 技能加载审计（需求 9.8）。
 *
 * 记在项目库而不是应用库：「这次会话为什么用了睡眠分期技能」是项目内的追溯
 * 问题，跟着项目一起归档、一起导出才有意义。
 *
 * `slug` 刻意**不加外键**指向应用库的 `skills`——跨库外键做不到，而且即便能做
 * 也不该做：技能被卸载之后，历史上「当时用了它」这个事实必须保留下来，否则
 * 半年后回看一份结论时，产生它的方法凭空消失了。
 */
const M003 = `
CREATE TABLE skill_loads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  detail          TEXT,
  injected_chars  INTEGER NOT NULL DEFAULT 0,
  at              INTEGER NOT NULL
);
CREATE INDEX idx_skill_loads_conv ON skill_loads (conversation_id, at DESC);
CREATE INDEX idx_skill_loads_slug ON skill_loads (slug);
`;

export const PROJECT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'project-initial', sql: M001 },
  { version: 2, name: 'blob-eviction', sql: M002 },
  { version: 3, name: 'skill-load-audit', sql: M003 },
];
