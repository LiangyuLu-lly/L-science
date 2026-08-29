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

/**
 * 算力目标登记（任务 14.2，需求 14.3、14.6）。
 *
 * 初版 `compute_targets` 只有 id / name / family / config / notes / credential / enabled /
 * last_probe。补的这几列各有具体用途：
 *
 * - `created_at` / `updated_at`：需求 14.6 要求「用户中途新增后无需重启即可发现」。
 *   发现依赖的是「比我上次看到的更新」，没有时间戳就只能每次全量重读并比对配置。
 * - `last_probe_at` 单独一列而不是从 `last_probe_json` 里解：判断「这份探测结果是不是
 *   太旧了」是列表页每次都要做的事，为此解析 N 份 JSON 是白花的开销；更要紧的是
 *   探测**失败**时也要更新这个时间（否则会反复重试一台确定连不上的机器）。
 * - `host_key_fingerprint`：SSH 目标的主机公钥指纹经用户审批后落在这里。放在
 *   config_json 里也能存，但它是**安全决定的凭据**，与「分区叫什么」这类偏好混在
 *   一个 JSON 里，改配置的代码路径就有机会顺手把它覆盖掉。
 * - `disabled_reason`：与 `enabled=0` 配对。用户主动停用与探测连续失败后自动停用
 *   是两件事，而「为什么这个目标是灰的」在只有一个布尔时无法回答。
 */
const M004 = `
ALTER TABLE compute_targets ADD COLUMN created_at INTEGER;
ALTER TABLE compute_targets ADD COLUMN updated_at INTEGER;
ALTER TABLE compute_targets ADD COLUMN last_probe_at INTEGER;
ALTER TABLE compute_targets ADD COLUMN host_key_fingerprint TEXT;
ALTER TABLE compute_targets ADD COLUMN disabled_reason TEXT;

CREATE INDEX idx_compute_targets_live ON compute_targets (enabled, family);

/*
 * 算力授权（需求 14.4、17.5）。
 *
 * 单独一张表，不复用 host_grants 也不复用 tool_grants。
 *
 * 不复用 host_grants 的理由是它的语义是「沙箱外的**路径**」：把
 * \`compute:ct_xxx:command\` 塞进 host_path 列能跑，但设置页里的「已授权路径」列表
 * 会开始显示一堆不是路径的东西，而用户在那个列表里要判断的是「我给过哪些目录权限」。
 * 混进来之后这个判断就做不了了。
 *
 * 关键是 \`risk\` 这一列——授权按危险度分档：
 *
 * - \`read\`：只读命令，可以给到 always。不给的话一次排查要点十几次「同意」，
 *   而那种疲劳最终换来的是一个用户其实不想给的宽授权。
 * - \`write\`：最多给到 project。跨项目的「随便写」不该出现在下拉框里。
 * - \`job\`：提交作业，最多 project。它消耗集群配额，在云上直接是钱。
 * - 破坏性命令**根本不进这张表**：它每次都要单独问，持久授权对它无效。
 *   这是「不被 ls 烦到」与「rm -rf 要经过我」能同时成立的唯一办法。
 */
CREATE TABLE compute_grants (
  id         TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL REFERENCES compute_targets (id) ON DELETE CASCADE,
  /* read | write | job | credential */
  risk       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  reason     TEXT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_compute_grants_lookup
  ON compute_grants (target_id, risk) WHERE revoked_at IS NULL;
`;

/**
 * 环境与包管理（任务 14.4，需求 15.1-15.7）。
 *
 * 初版 `environments` 只有 id / name / kind / mode / path / python_version / r_version /
 * packages_json / status。补的这几列各有具体用途：
 *
 * - `language`：一条记录到底是 Python 环境还是 R 环境。原来靠 python_version 与
 *   r_version 哪个非空来推断，而一个 conda 环境完全可以两个都装——那时推断出来的
 *   答案取决于代码里 if 的顺序。需求 15.7 要求 R 与 Python 分处独立环境，这条约束
 *   要能被检查，就得先能说清每条记录是哪一边的。
 * - `interpreter`：解释器的绝对路径。需求 15.2 要求内核**直接从用户的 venv 启动**，
 *   而 venv 的 python 位置在 Windows（Scripts\python.exe）与 POSIX（bin/python）下不同。
 *   每次启动现推一遍意味着这段推断散在多处，而它错一次的表现是内核起不来但不说为什么。
 * - `is_default`：新内核用哪个环境。做成列而不是一条设置项，是为了让「同一语言只能有
 *   一个默认」可以用部分唯一索引强制，而不是靠调用方记得先清掉旧的。
 * - `last_probe_json` / `last_probe_at`：探测结果。venv 会被用户删掉或移动，而那时
 *   界面上它看起来还在。
 * - `created_at` / `updated_at`：与 compute_targets 同理，列表要能按新旧排序。
 *
 * `env_packages` 单独一张表而不是继续用 `packages_json`：需求 15.4 要挡住「同一个
 * 科学计算依赖被 conda 与 pip 各装一份」，而那需要按包名查「它是从哪装的」。JSON 里
 * 存着的话每次检查都要把整份解出来遍历，更要紧的是**没法查反向问题**——「这个环境里
 * 有哪些包是 pip 装的」在排查导入错误时是第一个要问的。
 */
const M005 = `
ALTER TABLE environments ADD COLUMN language TEXT;
ALTER TABLE environments ADD COLUMN interpreter TEXT;
ALTER TABLE environments ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN notes TEXT;
ALTER TABLE environments ADD COLUMN last_probe_json TEXT;
ALTER TABLE environments ADD COLUMN last_probe_at INTEGER;
ALTER TABLE environments ADD COLUMN created_at INTEGER;
ALTER TABLE environments ADD COLUMN updated_at INTEGER;

/* 同一语言只能有一个默认环境。靠索引强制而不是靠调用方记得先清掉旧的 */
CREATE UNIQUE INDEX idx_environments_default
  ON environments (language) WHERE is_default = 1;

CREATE TABLE env_packages (
  env_id       TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  version      TEXT,
  /*
   * 从哪装的。'conda' / 'pypi' / 'cran' / 'unknown'。
   *
   * 这一列是需求 15.4 的判据。取值刻意与 \`conda list --json\` 的 channel 字段对齐
   * （它把 pip 装的包标成 "pypi"），因为**权威来源是探测而不是我们的记录**：用户可以
   * 在环境里自己跑 pip，那时我们的记录会漏，而 conda 自己的元数据不会。
   */
  source       TEXT NOT NULL,
  channel      TEXT,
  /* 是不是平台装的。用户自己装的也要记，否则冲突检查只看得见一半 */
  installed_by TEXT,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (env_id, name)
);
CREATE INDEX idx_env_packages_source ON env_packages (env_id, source);
`;

export const APP_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'app-initial', sql: M001 },
  { version: 2, name: 'skill-embeddings', sql: M002 },
  { version: 3, name: 'connector-groups', sql: M003 },
  { version: 4, name: 'compute-targets', sql: M004 },
  { version: 5, name: 'environments', sql: M005 },
];
