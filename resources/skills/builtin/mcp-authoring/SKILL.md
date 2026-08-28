---
slug: mcp-authoring
name: MCP 服务器编写
version: 1.0.0
---

# MCP 服务器编写

## 选传输

| 传输 | 何时用 | 注意 |
|---|---|---|
| **stdio** | 本机进程，绝大多数情况 | stdout 被协议独占，**日志必须走 stderr** |
| **HTTP/SSE** | 服务已在别处运行、需要跨机 | 必须有鉴权；localhost 在多用户机器上不等于可信 |

默认选 stdio。它的可达性天然等于「持有这个子进程句柄」，不需要额外解决鉴权问题。

## 最小 stdio 服务器

```python
import sys
from mcp.server.fastmcp import FastMCP

mcp = FastMCP('psg-tools')

@mcp.tool()
def summarize_edf(path: str) -> str:
    """读取 EDF 头部并返回通道、采样率与时长摘要。

    Args:
        path: EDF 文件的绝对路径。
    """
    import mne
    raw = mne.io.read_raw_edf(path, preload=False, verbose='error')
    return (f'channels={raw.ch_names} sfreq={raw.info["sfreq"]} '
            f'duration_h={raw.n_times / raw.info["sfreq"] / 3600:.2f}')

if __name__ == '__main__':
    # 日志一律 stderr。往 stdout 写一行普通文本就会让对端解析失败，
    # 而症状是「偶发的协议错误」，极难定位
    print('psg-tools starting', file=sys.stderr)
    mcp.run()
```

## 工具描述写给模型看

描述与参数说明是模型决定「要不要调、怎么调」的唯一依据。

- **写「什么时候用它」而不是「它是什么」。** `读取 EDF 头部` 不如
  `在分析之前确认一份 PSG 记录的通道、采样率与时长；不读取信号数据，因此很快`。
- **说明代价与副作用。** 「这个调用会下载约 200 MB」「这个调用会写文件」
  必须写出来，否则模型无法权衡。
- **枚举取值写进描述。** 参数只接受 `raw`/`derived` 时就把两个值列出来，
  别让模型猜。
- **不要写「见文档」。** 模型看不到你的文档。

## 参数校验与错误信息

错误信息是模型唯一的反馈渠道，必须**可执行**：

```python
@mcp.tool()
def load_stage_file(path: str, epoch_sec: int = 30) -> str:
    """加载分期文件。epoch_sec 必须与记录的 epoch 长度一致。"""
    if epoch_sec not in (20, 30, 60):
        # 差：'invalid epoch_sec'
        # 好：说清合法值与判断依据
        raise ValueError(
            f'epoch_sec={epoch_sec} 不支持。合法值为 20、30、60。'
            f'常规 AASM 分期为 30 s；不确定时用 记录时长/分期条目数 推算。')
    ...
```

**不要把异常栈直接抛给模型。** 栈里的路径与内部结构对它无用，且会挤占上下文。
抛一个说清「为什么不行、该怎么改」的消息。

## 幂等与超时

- **同样入参多次调用应给同样结果**，或者在描述里明确说明它有副作用。
  模型会重试失败的调用，非幂等的写操作重试两次就是两条记录。
- **自己加超时**。挂住的工具调用会让整个回合卡死，而调用方通常只能整体中断。

```python
import asyncio

@mcp.tool()
async def fetch_metadata(doi: str) -> str:
    """按 DOI 从 Crossref 取元数据。"""
    async with asyncio.timeout(30):      # 永远给上限
        ...
```

## 安全边界

本地优先意味着这些边界要自己守住：

- **路径参数必须校验。** `path` 来自模型输出，一个 `../../../credentials/vault.bin`
  就能把凭据库读出来。把路径解析后确认它落在允许的根目录内。
- **不要把凭据放进工具的返回值**，包括错误信息里。
- **不要在描述里承诺自己做不到的隔离。** 「本工具在沙箱中运行」如果不成立，
  会让上层基于错误的前提放行。
- **外部网络访问会触发平台的出口审批**。这是预期行为，别为了「省事」绕过它
  （比如自己起一个代理）。

## 注册到平台

MCP 服务器**只在控制面 REPL 暴露调用表面**，不会自动进入主对话的工具列表。
这是刻意的：主对话的工具列表是模型每次调用都要读的，把任意数量的第三方工具塞进去
会挤占上下文，且它们的可靠性不受平台控制。

配置形如：

```json
{
  "mcpServers": {
    "psg-tools": {
      "command": "conda",
      "args": ["run", "-n", "lsci", "python", "-m", "psg_tools.server"],
      "env": { "PSG_DATA_ROOT": "D:/data" }
    }
  }
}
```

## 调试

stdio 服务器不方便直接看，两条路：

1. **单独跑**并手工喂 JSON-RPC 帧，确认它响应正常。
2. 用 MCP Inspector（`npx @modelcontextprotocol/inspector <command>`）交互测试。

最常见的三个问题：**日志写进了 stdout**（协议帧被污染）、
**依赖不在启动它的那个环境里**（用 `conda run -n <env>` 明确指定）、
**工作目录不确定**（不要依赖 cwd，路径从参数或环境变量来）。
