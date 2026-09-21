# IPC 覆盖清册

审计：`node scripts/audit-ipc-callsites.mjs`（2026-09-21）

```
schema 方法 151　UI 包装 101

包装了但无人调用（假可用风险）9 个：
  approval.forgetDenial        forgetApprovalDenial
  approval.history             listApprovalHistory
  approval.pending             listPendingApprovals
  artifact.describeDeletion    describeDeletion
  citation.checks              listCitationChecks
  citation.parse               parseCitations
  claim.register               registerClaim
  ref.get                      getRef
  skill.reference              loadSkillReferenceFile

后端有但 UI 完全没包装 49 个：见下文「未包装家族」。其中 3 个是刚删的包装，见「已删包装」。
```

分类只能取其一：

- **已接线**：UI 调用方今天存在（给 file:line）。
- **agent-only（有意）**：能力由助手工具驱动；写明工具名与注册点；不断言有按钮。
- **缺口（应接线）**：用户可见承诺在，没有控件；写明承诺位置与最小控件。
- **应删包装**：包装是死重量（无承诺、无对应工具，或界面已用别的方法满足）。

本清册只登记「包装了但无人调用」的 9 个，外加未包装家族的短表。已接线的 92 个包装不在这里逐条列。已删包装见下文专节。

## 包装了但无人调用

| 方法 | 包装 | 分类 | 证据 | 怎样才算诚实 |
| --- | --- | --- | --- | --- |
| `citation.checks` | `listCitationChecks`（`api.ts:1133`） | agent-only（有意） | UI 除 `api.ts` 外零引用。「核对引用」芯片已调 `verifyCitations` / `citation.verify`（`TaskTypeChips.tsx:149`），不调本方法。核对历史无独立页。agent 工具 `verify_citations` 会落库（`backend.ts:1727`）。 | 芯片继续跑 `citation.verify`。若要做核对历史页，再接线并改本行。 |
| `citation.parse` | `parseCitations`（`api.ts:1086`） | agent-only（有意） | 同上。芯片不调 parse。解析发生在 `verify_citations` / `citation.verify` 内部。 | 不要把芯片文案写成「点一下就 parse」。解析不是独立 UI 能力。 |
| `claim.register` | `registerClaim`（`api.ts:739`） | 缺口（应接线） | 抽取路径已接线：`extractClaims`（`App.tsx:760`）。断言页有「用户登记」来源标签（`ClaimsView.tsx:35`）但没有登记表单。agent `manage_claims action=register` 写入 origin=`model`（`manuscript/tools.ts:356-366`，注册于 `backend.ts:1648`）。origin=`user` 只走这条 IPC。 | 最小控件：断言页「手动登记」调用 `registerClaim`。不做按钮就把 `ORIGIN_LABEL.user` 删掉或改成「仅 IPC」。 |
| `ref.get` | `getRef`（`api.ts:488`） | agent-only（有意） | RefsView 点选只做论文焦点（`RefsView.tsx:476`），展开的是资源清单（`listRefAssets`）不是单条记录+BibTeX。BibTeX 走批量 `exportRefs`。agent `manage_references action=get`（`refs/tools.ts:404`，注册于 `backend.ts:1632`）。 | 不断言「点开一条看 BibTeX」。若要做详情抽屉，再接线。 |
| `skill.reference` | `loadSkillReferenceFile`（`api.ts:2066`） | 缺口（应接线） | 技能详情列出参考材料文件名但不能打开（`SkillsView.tsx:1019-1023`）。agent 有 `load_skill_reference`（`skills/tools.ts:171`，注册于 `backend.ts:1067`）。 | 最小控件：文件名可点，调用 `loadSkillReferenceFile` 展示正文。只列名却打不开是假可用。 |
| `approval.pending` | `listPendingApprovals`（`api.ts:202`） | 缺口（应接线） | 审批卡片只吃 `approval.request` 事件（`useTurn.ts:290`，`App.tsx:684`）。任务 14.5 写明「重开窗口后恢复显示」。刷新后卡片消失、后端仍在挂着。 | 启动或重连时调 `listPendingApprovals` 把未决卡片补回来。 |
| `approval.history` | `listApprovalHistory`（`api.ts:210`） | 缺口（应接线） | 任务 14.5：「谁在什么时候批准了删除哪个制品」在库里有答案，界面问不出来。无历史视图。 | 最小控件：设置或工作室里的审批审计列表。 |
| `approval.forgetDenial` | `forgetApprovalDenial`（`api.ts:228`） | 缺口（应接线） | 任务 14.5 承诺拒绝记忆可撤销。无「现在可以了」控件。用户改主意只能重启后端。 | 历史行上的「忘记这条拒绝」按钮。依赖 `approval.history` 先接线。 |
| `artifact.describeDeletion` | `describeDeletion`（`api.ts:1197`） | agent-only（有意） | 制品页无删除按钮，只展示已删除（`ArtifactsView.tsx:169`）。需求 6.7 是「当 agent 请求删除」：`delete_artifacts`（`backend.ts:941`）内部调 `store.describeDeletion`（`artifact/tools.ts:277`），然后弹审批卡片。 | 任务 9.3「删除入口」应读成审批卡片，不是制品页按钮。不要在制品页画一个点了没反应的删除。 |

## 已删包装

日期：2026-09-21。`packages/ui/src` 除 `api.ts` 外，包装名与 raw method 字符串均为零命中。IPC schema 与后端处理器保留。

| 方法 | 包装 | 证据 |
| --- | --- | --- |
| `manuscript.delete` | `deleteManuscript` | UI 除 `api.ts` 外零引用。`ManuscriptsView` 无删除；compile 工具无 delete 动作。 |
| `manuscript.history` | `listManuscriptHistory` | UI 除 `api.ts` 外零引用。手稿页历史来自 `getManuscript().runs`，无独立历史承诺。 |
| `plan.get` | `loadPlan` | UI 除 `api.ts` 外零引用。`plan.list` 已返回完整 `PlanView[]`，无需按 id 再取。 |

## 未包装家族

审计 49 个。按家族：

| 家族 | 方法 | 现状 | 诚实说法 |
| --- | --- | --- | --- |
| `compute.*` | `addNote` `cancelJob` `commands` `confirmHostKey` `deleteNote` `grants` `job` `jobOutputs` `jobs` `localCapabilities` `notes` `ping` `probe` `register` `remove` `revokeGrant` `scanHostKey` `setDescription` `setEnabled` `target` `targets` `update`（22） | 侧栏无算力工作室。 | 助手工具 `manage_compute` / `run_remote_command` / `submit_compute_job`（`backend.ts:1919-1921`）。 |
| `env.*` | `clearDefault` `create` `discover` `get` `install` `installers` `list` `mixups` `packages` `plan` `probe` `register` `remove` `restartKernels` `setDefault` `sync`（16） | 「工具与环境」是工具清单 + doctor（`ToolsPanel.tsx`），不是环境管理。 | 助手工具 `manage_environments`（`backend.ts:1822`）。 |
| `connector.upsert` / `connector.delete` | 2 | 连接器页只能开关已有项（`ConnectorsView.tsx`）。 | 增删连接器不是当前界面承诺。内置项不可删只可禁用，见任务 12.13。 |
| `memory.*` | `delete` `list` `upsert`（3） | 无记忆视图。 | 助手工具 `remember` / `recall_memory`（`backend.ts:1509-1510`）。 |
| `host.requestAccess` | 1 | 无「申请宿主路径」控件。 | 授权走审批卡片事件。 |
| `project.archive` | 1 | 顶栏能显示已归档，不能归档（`ProjectHeader.tsx:41`）。 | 归档不是当前界面承诺。 |
| `ref.search` | 1 | 文献页是贴 DOI 入库，不是检索框。 | 助手 `manage_references action=search`（`refs/tools.ts:310`）。 |
| 已删 UI 包装 | `manuscript.delete` `manuscript.history` `plan.get`（3） | 2026-09-21 删包装。 | 见「已删包装」。后端处理器仍在。 |

## 判据

重跑：

```powershell
node scripts/audit-ipc-callsites.mjs
```

规则：

1. 「包装了但无人调用」的数量不得在本文件没有对应分类行的情况下增长。新增死包装必须先在上表加一行，写分类与证据。
2. 分类变更（例如芯片真的改去调用 `citation.parse`）必须改表，不能只改代码。
3. 未包装家族新增方法，归入上表对应行或新开一行。不要靠「后端有」把界面说成能用。
4. `tasks.md` 的 `[x]` 只证明后端与测试。界面够不着的标 `[~]`，证据指向本文件。
