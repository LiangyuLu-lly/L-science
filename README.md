# L-science

<table>
<tr>
<td width="50%" valign="top">

Windows 上的**本地优先 AI 科研工作台**。文献、断言、手稿和 Python / R 内核都在你这台机器上，不经过云端后端。

</td>
<td width="50%" valign="top">

A **local-first AI research workbench** for Windows. Literature, claims, manuscripts, and Python/R kernels stay on your machine — no cloud backend.

</td>
</tr>
</table>

**1.0.0** · Windows x64 · MIT · [GitHub](https://github.com/LiangyuLu-lly/L-science)

无 macOS / Linux 安装包 · 无自动更新 · 未做代码签名  
No macOS/Linux builds · no auto-update · unsigned installer

---

## 界面 / Interface

打开之后默认在**文献**，底部始终可以跟助手说话。

After launch you land on **Literature**; the composer stays docked at the bottom.

![Workbench: literature home and docked assistant](docs/screenshots/workbench.svg)

第一次打开只要求贴一把密钥；计算环境在后台安装。

First launch asks for an API key only; the kernel environment installs in the background.

![First-run overlay](docs/screenshots/first-run.svg)

![Paper path: DOI → claims → manuscript → assistant](docs/screenshots/flow.svg)

---

## 这是什么 / What it is

<table>
<tr>
<th width="50%">中文</th>
<th width="50%">English</th>
</tr>
<tr>
<td valign="top">

把论文主路径做成桌面应用，而不是又一个聊天窗口：

1. **文献** — 贴 DOI / PMID / 链接入库（默认 Crossref）
2. **断言** — 无证据与矛盾置顶
3. **手稿** — 点开看编译错误；未关闭断言不得标可投稿
4. **助手** — 看着文献就能问；点「助手」才展开对话记录
5. **工作室** — 制品、技能、连接器、路由、用量、设置

智力取决于你登记的模型。没有 Key，它不会变聪明。

</td>
<td valign="top">

The paper path is the product, not another chat window:

1. **Literature** — paste DOI / PMID / URL (Crossref by default)
2. **Claims** — unsupported and contradictory items sort first
3. **Manuscripts** — open a compile report; unresolved claims block “ready to submit”
4. **Assistant** — talk while looking at the paper; expand the transcript with 助手
5. **Studio** — artifacts, skills, connectors, routing, usage, settings

Model quality is entirely the key you register. No key, no intelligence.

</td>
</tr>
</table>

---

## 能做 / 不能做 · Can / cannot

<table>
<tr>
<th width="50%">中文</th>
<th width="50%">English</th>
</tr>
<tr>
<td valign="top">

**能做**

- 多家云端接口同时登记（Kimi、通义、OpenAI、Groq、OpenRouter 等）
- 本机 Ollama
- 一键下载 micromamba 并创建 `lsci` / `lsci-r`（不打进安装包）
- 数字版 PDF 按页抽字
- 导出可复现 zip 并打开所在文件夹
- 密钥只在本机 DPAPI 加密；无遥测

**不能做（有意不做）**

- 替你注册云账号
- 把 conda / ColabFold / CUDA 打进安装包
- 红灯技能假装已经算出结构
- 静默自动更新、代码签名、macOS / Linux

</td>
<td valign="top">

**Can**

- Register several cloud gateways at once (Kimi, Qwen, OpenAI, Groq, OpenRouter, …)
- Local Ollama
- One-click micromamba + `lsci` / `lsci-r` (not bundled in the installer)
- Page-level text extract from digital PDFs
- Export a reproducibility zip and reveal it in Explorer
- Keys in DPAPI only; no telemetry

**Will not (on purpose)**

- Sign you up for a cloud account
- Ship conda / ColabFold / CUDA inside the NSIS package
- Inject red-light skill procedures as if they ran
- Silent auto-update, code signing, macOS / Linux

</td>
</tr>
</table>

---

## 安装 / Install

<table>
<tr>
<td width="50%" valign="top">

1. 下载 `L-science-Setup-1.0.0.exe`（自行 `npm run pack:win` 后在 `release/win/`）。
2. SmartScreen「Windows 已保护你的电脑」→ **更多信息 → 仍要运行**。未签名，发布者未知是预期。
3. 默认当前用户安装，不需要管理员。

数据目录：`%LOCALAPPDATA%\L-science`。卸载**不会**删除它。多开：设 `L_SCIENCE_DATA_DIR`。

</td>
<td width="50%" valign="top">

1. Get `L-science-Setup-1.0.0.exe` (after `npm run pack:win`, under `release/win/`).
2. SmartScreen “Windows protected your PC” → **More info → Run anyway**. Unsigned publisher is expected.
3. Per-user install; no administrator required.

Data lives in `%LOCALAPPDATA%\L-science`. Uninstall does **not** delete it. Multiple instances: set `L_SCIENCE_DATA_DIR`.

</td>
</tr>
</table>

---

## 第一次打开 / First launch

<table>
<tr>
<td width="50%" valign="top">

1. 默认供应商是 **Kimi**，也可改通义 / OpenAI / Groq。
2. 把 API 密钥贴进密码框，点 **开始使用**。密钥立刻从界面清除。
3. Python / R 内核在后台装：有 conda 就用；没有就下载 micromamba 到数据目录。
4. 若本机已有 Ollama，会自动检测。
5. 文献默认放行 `api.crossref.org`，设置里可撤。

DeepSeek 与手动 conda 命令折在「其他方式 / 手动命令」。点跳过会进设置；再点论文页仍可继续。

</td>
<td width="50%" valign="top">

1. Default provider is **Kimi**; switch to Qwen / OpenAI / Groq if you want.
2. Paste the API key into the password field, click **Start**. The key is wiped from the form immediately.
3. Python/R kernels install in the background: existing conda if present, otherwise micromamba under the data dir.
4. Running Ollama is detected automatically.
5. `api.crossref.org` is pre-allowed for literature; revoke it in Settings.

DeepSeek and manual conda commands live under “other / manual”. Skip opens Settings; the paper pages remain usable.

</td>
</tr>
</table>

备用命令（一键失败时）/ fallback if one-click fails:

```text
conda create -n lsci python=3.13 ipykernel -y
conda create -n lsci-r -c conda-forge r-base r-irkernel -y
```

或 / or `scripts/bootstrap-kernels.ps1`。

---

## 日常使用 / Daily use

<table>
<tr>
<td width="50%" valign="top">

1. **文献**：贴 DOI → 入库。失败会显示 Crossref 等上游原因。
2. 底部输入框直接问助手（不必离开文献页）。
3. **断言**：先处理无证据条目。
4. **手稿**：点一条看最近编译报告。有未关闭断言时不能标可投稿。
5. **制品**：导出可复现 zip 后会打开文件夹。
6. OpenRouter / 硅基流动 / Together 默认同步只启用一小撮模型。

</td>
<td width="50%" valign="top">

1. **Literature**: paste a DOI → ingest. Failures show the upstream reason (e.g. Crossref 404).
2. Talk from the bottom composer without leaving the paper view.
3. **Claims**: handle unsupported items first.
4. **Manuscripts**: open a row for the latest compile report. Unresolved claims block “ready to submit”.
5. **Artifacts**: exporting a zip reveals the folder.
6. OpenRouter / SiliconFlow / Together enable only a small default subset after sync.

</td>
</tr>
</table>

侧栏结构 / sidebar:

```text
论文     Literature path
  文献   refs (home)
  断言   claims
  手稿   manuscripts
助手     transcript toggle (composer already docked)
工作室   studio
  制品 / 技能 / 连接器 / 路由 / 用量 / 工具 / 设置
```

---

## 隐私 / Privacy

<table>
<tr>
<td width="50%" valign="top">

- 不发送遥测
- 密钥经 Windows DPAPI 加密，只在本机
- 卸载安装包不清数据目录

</td>
<td width="50%" valign="top">

- No telemetry
- Keys encrypted with Windows DPAPI, local only
- Uninstalling the setup does not wipe the data directory

</td>
</tr>
</table>

---

## 从源码开发 / Development

需要 Node ≥ 24。Need Node ≥ 24.

```powershell
npm install
npm run doctor
npm run dev:ui
npm run dev:shell
```

UI：`http://127.0.0.1:5223`。改控制平面后请重启 Electron（Vite 可留着）。

After control-plane changes, restart Electron; Vite can stay up.

```powershell
npm run pack:win
```

产物 / output: `release/win/`。`vendor/` 与 `release/` 不进 git。

---

## 许可证 / License

[MIT](LICENSE) © 2026 LiangyuLu-lly
