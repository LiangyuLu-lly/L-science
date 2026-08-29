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

/**
 * 子 agent 会话（需求 10.5、10.6）。
 *
 * 子 agent 拿到自己的会话行，而不是把消息混进父会话。三个理由：
 *
 * 1. `tool_calls.message_id` 有外键指向 `messages`，子 agent 的工具调用必须挂在
 *    真实存在的消息上。给它一个合成 id 会违反外键。
 * 2. 父会话的对话记录要保持可读。五个并行子 agent 的几十轮工具调用交错插进去之后，
 *    用户看不出主线在说什么。
 * 3. 子 agent 做了什么必须可查（它可能产出了进入结论的制品）。独立会话让它的完整
 *    过程可以像普通会话一样被翻看。
 *
 * `parent_conversation_id` 让默认列表能把子会话排除掉——否则会话侧栏会被子任务淹没。
 * 级联删除是刻意的：删父会话时子 agent 的记录一起走，它们不能独立存在。
 */
const M004 = `
ALTER TABLE conversations
  ADD COLUMN parent_conversation_id TEXT REFERENCES conversations (id) ON DELETE CASCADE;
CREATE INDEX idx_conversations_children ON conversations (parent_conversation_id)
  WHERE parent_conversation_id IS NOT NULL;
`;

/**
 * 文献库的检索与去重辅助列（任务 13.1，需求 12.1、12.2）。
 *
 * 这些字段全部能从 `csl_json` 里算出来，单独立列是为了让去重在 SQL 里可做。
 * 每次去重都把全部 refs 的 CSL 反序列化再比对，在几千条文献的项目里是一次
 * 全表 JSON 解析——而去重发生在每一次新增文献时。
 *
 * `title_norm` 存的是归一化后的标题（小写、去标点、折叠空白），不是原标题：
 * 模糊匹配的候选集筛选靠它。原标题仍在 CSL 里，不会因归一化而丢失。
 *
 * `source` 记录元数据来自哪个上游。四家对同一 DOI 给出的字段完备度差别很大
 * （Crossref 有页码与 ISSN，Semantic Scholar 有摘要与被引数），事后判断
 * 「这条要不要重新解析一次」需要知道当时是谁给的。
 */
const M005 = `
ALTER TABLE refs ADD COLUMN title_norm TEXT;
ALTER TABLE refs ADD COLUMN source TEXT;
ALTER TABLE refs ADD COLUMN year INTEGER;
ALTER TABLE refs ADD COLUMN container TEXT;
ALTER TABLE refs ADD COLUMN first_author TEXT;
ALTER TABLE refs ADD COLUMN pmid TEXT;
ALTER TABLE refs ADD COLUMN pmcid TEXT;
ALTER TABLE refs ADD COLUMN arxiv_id TEXT;
ALTER TABLE refs ADD COLUMN updated_at INTEGER;

CREATE INDEX idx_refs_title_norm ON refs (title_norm) WHERE title_norm IS NOT NULL;
CREATE INDEX idx_refs_year ON refs (year);
CREATE INDEX idx_refs_pmid ON refs (pmid) WHERE pmid IS NOT NULL;
CREATE INDEX idx_refs_pmcid ON refs (pmcid) WHERE pmcid IS NOT NULL;
CREATE INDEX idx_refs_arxiv ON refs (arxiv_id) WHERE arxiv_id IS NOT NULL;

/*
 * 别名表：同一条文献在不同上游的标识。
 *
 * 不把它们塞进 refs 的列里，是因为一条文献可以同时有多个同类标识——preprint 的
 * DOI 与正式发表的 DOI、OpenAlex 的 work id 与 MAG id。合并两条重复记录时，
 * 被合并那条的标识必须保留下来，否则下次用旧 DOI 再查一次又会新建一条。
 */
CREATE TABLE ref_aliases (
  ref_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  scheme TEXT NOT NULL,
  value  TEXT NOT NULL,
  PRIMARY KEY (scheme, value)
);
CREATE INDEX idx_ref_aliases_ref ON ref_aliases (ref_id);
`;

/**
 * 全文抓取的尝试记录与随文资源（任务 13.2，需求 12.3、12.4、12.6）。
 *
 * `ref_fetch_attempts` 直接对应需求 12.6：拿不到全文时必须记下试过哪些来源、
 * 各自为什么失败，不得静默跳过。这条要求只能靠一张表满足——把原因塞进 `refs` 的
 * 一个文本列，第二次尝试就会把第一次的记录覆盖掉，而「上次是 403 这次是 404」
 * 恰恰是判断「要不要换个途径」的依据。
 *
 * 表里不加 UNIQUE：同一来源被试过多次是有意义的历史（半年后开放获取了）。
 *
 * `ref_assets` 让一条文献可以绑定多个制品。`refs.fulltext_artifact_id` 只能存一个，
 * 而 PMC 的一篇论文会带回来正文 Markdown、原始 XML、十几张插图与补充材料。把它们
 * 都塞进一个制品的多个版本是错的——版本表达的是同一份内容的演进，而这些是并列的
 * 不同东西。
 *
 * `version_id` 与 `artifact_id` 都存：制品会有新版本，而「当时抓到的是这一版」
 * 是可核查性的一部分。只存 artifact_id 的话，后来有人在同一制品上存了新版本，
 * 回看时就分不清引用的是哪一版。
 */
const M006 = `
CREATE TABLE ref_fetch_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id     TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  url        TEXT,
  outcome    TEXT NOT NULL,
  detail     TEXT,
  status     INTEGER,
  bytes      INTEGER,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_ref_fetch_ref ON ref_fetch_attempts (ref_id, at DESC);
CREATE INDEX idx_ref_fetch_outcome ON ref_fetch_attempts (outcome);

CREATE TABLE ref_assets (
  id          TEXT PRIMARY KEY,
  ref_id      TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  label       TEXT,
  caption     TEXT,
  source_url  TEXT,
  /* 包内原文件名。正文 Markdown 里的图片路径靠它对上制品 */
  origin_path TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (ref_id, kind, artifact_id)
);
CREATE INDEX idx_ref_assets_ref ON ref_assets (ref_id, kind);
`;

/**
 * Claim Ledger 的补齐（任务 13.4，需求 13.1-13.4）。
 *
 * `claims` 与 `claim_evidence` 在 M001 里就建了，但只有最小字段。这里补上让它
 * 真正能用的部分：
 *
 * - **`conversation_id`**：Reviewer 是按会话跑的，findings 必须挂在一个会话上
 *   （`findings.conversation_id` 是 NOT NULL）。没有这一列的话，「这条无证据断言
 *   属于哪次对话」无从判断，于是每个会话的审查都会把全项目的断言重报一遍。
 *
 * - **`origin`**：区分自动抽取、模型登记与用户手写。自动抽取的断言未经人确认，
 *   把它和用户明确写下的断言同等对待会让 FAIL 级发现里塞满误抽的句子——而一旦
 *   开始忽略 FAIL，整个 Claim Ledger 就失效了。
 *
 * - **`kinds_json` 与 `numbers_json`**：一句话可以同时是数值结论与因果陈述
 *   （「治疗组的死亡率降低了 30%，说明该药有效」），`kind` 只能存一个主类型。
 *   抽出的数字单独存下来，核验时要把它们明确摆给模型看——问「这句话对不对」
 *   与问「0.03 这个数字在证据里能找到吗」是两个难度完全不同的任务。
 *
 * - `claim_evidence` 的 `locator` 与 `quote`：证据指到「哪一份制品」是不够的，
 *   要指到「第几页第几行」或「哪一行原文」。缺了这一步，核验结论无法被复核。
 */
const M007 = `
ALTER TABLE claims ADD COLUMN conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN origin TEXT NOT NULL DEFAULT 'model';
ALTER TABLE claims ADD COLUMN kinds_json TEXT;
ALTER TABLE claims ADD COLUMN numbers_json TEXT;
ALTER TABLE claims ADD COLUMN section TEXT;
ALTER TABLE claims ADD COLUMN note TEXT;
ALTER TABLE claims ADD COLUMN updated_at INTEGER;

CREATE INDEX idx_claims_conversation ON claims (conversation_id, status)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_claims_status ON claims (status);

ALTER TABLE claim_evidence ADD COLUMN locator TEXT;
ALTER TABLE claim_evidence ADD COLUMN quote TEXT;
ALTER TABLE claim_evidence ADD COLUMN created_at INTEGER;

CREATE INDEX idx_claim_evidence_ref ON claim_evidence (evidence_kind, evidence_ref);
`;

export const PROJECT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'project-initial', sql: M001 },
  { version: 2, name: 'blob-eviction', sql: M002 },
  { version: 3, name: 'skill-load-audit', sql: M003 },
  { version: 4, name: 'subagent-conversations', sql: M004 },
  { version: 5, name: 'reference-library', sql: M005 },
  { version: 6, name: 'reference-fulltext', sql: M006 },
  { version: 7, name: 'claim-ledger', sql: M007 },
];
