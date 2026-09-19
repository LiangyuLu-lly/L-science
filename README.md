# L-science

Windows 上的本地优先 AI 科研工作台。把文献、断言、手稿和算力放在同一台机器上，不经过云端后端。

当前版本 **1.0.0**，仅提供 Windows x64 安装包。本仓库没有 macOS / Linux 安装包，也没有自动更新。

## 安装

1. 下载 `L-science-Setup-1.0.0.exe`。
2. 若出现 SmartScreen「Windows 已保护你的电脑」：点 **更多信息 → 仍要运行**。本版未做代码签名，发布者显示为未知是预期行为。
3. 安装向导可改目录，默认按当前用户安装，不需要管理员。

数据目录默认是 `%LOCALAPPDATA%\L-science`。多开实例请设环境变量 `L_SCIENCE_DATA_DIR` 指向不同文件夹。卸载安装包不会删除本机数据目录。

## 第一次打开

安装包会弹出引导层：

- **DeepSeek**：粘贴 API 密钥（密码框，提交后清空）。
- **Ollama**：点「检测本机 Ollama」。本机要已经装着并跑着 Ollama。
- **稍后设置**：只跳过这一次会话。之后可在「设置 → 登记模型」再打开同一层。

没有可用模型时，对话仍能打开，但发送后会提示注册表为空。

## 内核环境（安装包不带）

安装包 **不包含** conda 环境 `lsci` / `lsci-r`。要跑 Python / R 内核，请自己创建：

```text
conda create -n lsci python=3.13
conda create -n lsci-r -c conda-forge r-base r-irkernel
```

更完整的本机检查：开发机上可运行 `npm run doctor`。安装包里的「工具与环境」页会显示控制平面给出的能力摘要，并重复上面这句 conda 说明。

## 开发者从源码跑

需要 Node ≥ 24。

```powershell
npm install
npm run doctor
npm run dev:ui
npm run dev:shell
```

打安装包（会下载官方 Node 24 win-x64 的 `node.exe`，不入库）：

```powershell
npm run pack:win
```

产物在 `release/win/`。`vendor/` 与 `release/` 均不进 git。
