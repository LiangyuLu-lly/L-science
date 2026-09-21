# L-science

**中文** · [English](README.en.md)

Windows 上的本地优先 AI 科研工作台。文献、断言、手稿和 Python / R 内核都在你这台机器上，不经过云端后端。

**1.0.0** · Windows x64 · MIT · [GitHub](https://github.com/LiangyuLu-lly/L-science)

无 macOS / Linux 安装包 · 无自动更新 · 未做代码签名

---

## 界面

打开之后默认在**文献**，底部始终可以跟助手说话。

![工作台：文献首页与底部助手](docs/screenshots/workbench.svg)

第一次打开只要求贴一把密钥；计算环境在后台安装。

![首次引导](docs/screenshots/first-run.svg)

![论文路径：DOI → 断言 → 手稿 → 助手](docs/screenshots/flow.svg)

---

## 这是什么

把论文主路径做成桌面应用，而不是又一个聊天窗口：

1. **文献** — 贴 DOI / PMID / 链接入库（默认 Crossref）
2. **断言** — 无证据与矛盾置顶
3. **手稿** — 点开看编译错误；未关闭断言不得标可投稿
4. **助手** — 看着文献就能问；点「助手」才展开对话记录
5. **工作室** — 制品、技能、连接器、路由、用量、设置

智力取决于你登记的模型。没有 Key，它不会变聪明。

---

## 能做 / 不能做

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

---

## 安装

1. 下载 `L-science-Setup-1.0.0.exe`（自行 `npm run pack:win` 后在 `release/win/`）。
2. SmartScreen「Windows 已保护你的电脑」→ **更多信息 → 仍要运行**。未签名，发布者未知是预期。
3. 默认当前用户安装，不需要管理员。

数据目录：`%LOCALAPPDATA%\L-science`。卸载**不会**删除它。多开：设 `L_SCIENCE_DATA_DIR`。

---

## 第一次打开

1. 默认供应商是 **Kimi**，也可改通义 / OpenAI / Groq。
2. 把 API 密钥贴进密码框，点 **开始使用**。密钥立刻从界面清除。
3. Python / R 内核在后台装：有 conda 就用；没有就下载 micromamba 到数据目录。
4. 若本机已有 Ollama，会自动检测。
5. 文献默认放行 `api.crossref.org`，设置里可撤。

DeepSeek 与手动 conda 命令折在「其他方式 / 手动命令」。点跳过会进设置。

备用命令（一键失败时）：

```text
conda create -n lsci python=3.13 ipykernel -y
conda create -n lsci-r -c conda-forge r-base r-irkernel -y
```

或 `scripts/bootstrap-kernels.ps1`。

---

## 日常使用

1. **文献**：贴 DOI → 入库。失败会显示 Crossref 等上游原因。
2. 底部输入框直接问助手（不必离开文献页）。
3. **断言**：先处理无证据条目。
4. **手稿**：编译产出 Markdown 与检查报告，不是投稿文件（导出的可复现 zip 在制品里）。有未关闭断言时不能标可投稿。
5. **制品**：导出可复现 zip 后会打开文件夹。
6. OpenRouter / 硅基流动 / Together 默认同步只启用一小撮模型。

侧栏：

```text
论文
  文献   （首页）
  断言
  手稿
助手     展开对话记录（输入框已经停在底部）
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
