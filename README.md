# L-science

**中文** · [English](README.en.md)

Windows 上的本地优先 AI 科研工作台。文献、断言、手稿和 Python / R 内核都在你这台机器上，不经过云端后端。

**1.0.0** · Windows x64 · MIT · [GitHub](https://github.com/LiangyuLu-lly/L-science)

无 macOS / Linux 安装包 · 无自动更新 · 未做代码签名

---

## 界面

打开之后默认在**文献**，一个动作：贴 DOI 或拖入 PDF。付费墙或本地 PDF 可拖到条目上绑定全文。

![工作台：文献首页与底部助手](docs/screenshots/workbench.svg)

第一次打开要求贴一把密钥（Kimi / 通义 / OpenAI / Groq）。跳过不挡文献、断言、手稿。没有启用模型时，底部输入框不能发，会显示「没有可用模型」和「去登记模型」。计算环境要点「一键安装 Python / R 内核」。

![首次引导](docs/screenshots/first-run.svg)

![论文路径：DOI → 断言 → 手稿 → 助手](docs/screenshots/flow.svg)

---

## 这是什么

把论文主路径做成桌面应用，而不是又一个聊天窗口：

1. **文献**：贴 DOI 或拖入 PDF。解析器接 Crossref、OpenAlex、Semantic Scholar、PubMed、Europe PMC、DataCite。条目可抓全文、删除、查重合并、导出。
2. **断言**：无证据与未关闭条目置顶。可确认 / 核验 / 关闭 / 重开 / 解绑证据 / 删除。抽断言有全文读全文，否则用题录与摘要，并盖「摘自全文」「摘自题录与摘要（无全文）」或「摘自题录与摘要（扫描件无文本层）」。
3. **手稿**：编译产出 Markdown 与检查报告，在制品里查看。可选期刊档案。未关闭断言不得标可投稿。
4. **工作室**：制品、技能、连接器、路由、用量、工具、设置。

论文页底部输入框一直在；点「助手」才展开对话记录。智力取决于你登记的模型。没有启用模型，它不会变聪明。

---

## 能做 / 不能做

**能做**

- 多家云端接口同时登记。首次引导是 Kimi、通义、OpenAI、Groq；OpenRouter 等在设置里加
- 本机 Ollama
- 一键下载 micromamba 并创建 `lsci` / `lsci-r`（不打进安装包；conda 命令是备用）
- 有文本层的 PDF 可抽字；扫描件没有文本层
- 导出可复现 zip 并打开所在文件夹
- 密钥只在本机 DPAPI 加密；无遥测
- 设置里的授权列出宿主路径与域名，可撤销
- 红灯技能不可选，不注入 SKILL.md，并告知模型本机不能跑

**不能做（有意不做）**

- 替你注册云账号
- 把 conda / ColabFold / CUDA 打进安装包
- 红灯技能假装已经算出结构
- 静默自动更新、代码签名、macOS / Linux
- 编译出可投稿的 PDF / Word

---

## 安装

1. 自行 `npm run pack:win`，安装包 `L-science-Setup-1.0.0.exe` 在 `release/win/`。没有现成下载。
2. SmartScreen「Windows 已保护你的电脑」→ **更多信息 → 仍要运行**。未签名，发布者未知是预期。
3. 默认当前用户安装，不需要管理员。

数据目录：`%LOCALAPPDATA%\L-science`。卸载**不会**删除它。多开：设 `L_SCIENCE_DATA_DIR`。

---

## 第一次打开

1. 默认供应商是 **Kimi**，也可改通义 / OpenAI / Groq。OpenRouter / 硅基流动 / Together 不在首次引导，去设置登记。
2. 把 API 密钥贴进密码框，点 **开始使用**。密钥立刻从界面清除。
3. 点 **一键安装 Python / R 内核**：有 conda 就用；没有就下载 micromamba 到数据目录。安装包不含 conda。
4. 若本机已有 Ollama，会自动检测。
5. 文献访问学术元数据域名需批准；可在设置的授权里撤销。

DeepSeek 与手动 conda 命令折在「其他方式 / 手动命令」。点跳过会进设置，但不挡文献 / 断言 / 手稿。

备用命令（一键失败时）：

```text
conda create -n lsci python=3.13 ipykernel -y
conda create -n lsci-r -c conda-forge r-base r-irkernel -y
```

或 `scripts/bootstrap-kernels.ps1`。

---

## 日常使用

1. **文献**：贴 DOI 或拖入 PDF。失败会显示各上游原因。付费墙 PDF 拖到条目上绑定全文。
2. 论文页底部可以写给助手；没有启用模型时不能发，去登记模型。
3. **断言**：先处理无证据与未关闭条目。抽断言会盖来源章。
4. **手稿**：编译产出 Markdown 与检查报告，在制品里查看。期刊档案的字数上限是作者指南的近似值，会过期，改稿前请核对官方要求。列出编译历史。有未关闭断言时不能标可投稿。
5. **制品**：导出可复现 zip 后会打开文件夹。
6. 设置的授权可撤销宿主路径与域名。

侧栏：

```text
论文
  文献   （首页）
  断言
  手稿
助手     展开对话记录（输入框停在论文页底部）
工作室
  制品 / 技能 / 连接器 / 路由 / 用量 / 工具 / 设置
```

---

## 隐私

- 不发送遥测
- 密钥经 Windows DPAPI 加密，只在本机
- 卸载安装包不清数据目录

---

## 从源码开发

需要 Node ≥ 24。

```powershell
npm install
npm run doctor
npm run dev:ui
npm run dev:shell
```

UI：`http://127.0.0.1:5223`。改控制平面后请重启 Electron（Vite 可留着）。

```powershell
npm run pack:win
```

产物在 `release/win/`。`vendor/` 与 `release/` 不进 git。

---

## 许可证

[MIT](LICENSE) © 2026 LiangyuLu-lly
