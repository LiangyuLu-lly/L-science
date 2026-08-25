/**
 * 工具面测试（任务 6.1、6.3、6.4）。
 *
 * 重点在几处会造成静默损坏或误导模型的行为：
 * - R 缺失时 `r` 不进工具列表，且被问起时给出可执行的安装指引（需求 2.4、9.6）
 * - 输出截断必须标注。静默截断会让模型基于半截输出下结论
 * - 非零退出不吞 stdout
 * - 精确替换命中零次或多次都必须失败且不改文件
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CAPABILITY,
  ToolInputError,
  ToolRegistry,
  ToolUnavailableError,
  collectExecution,
  createEditFileTool,
  createKernelTool,
  createReadFileTool,
  createShellTool,
  describeMimeBundle,
  formatExecution,
  formatShellResult,
  isPdf,
  looksBinary,
  replaceOnce,
  sliceLines,
  truncateStream,
  type SandboxBackend,
  type ToolContext,
  type ToolDefinition,
} from '@l-science/core';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'lsci-tools-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  projectId: 'p1',
  conversationId: 'c1',
  workspaceDir: workspace,
});

/** 最小工具定义，用于测注册表本身。 */
const dummy = (name: string, capability?: string): ToolDefinition<unknown> => ({
  name,
  description: `${name} 工具`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...(capability === undefined
    ? {}
    : { requirements: [{ capability, remediation: `请安装 ${capability}` }] }),
  parseInput: (raw) => raw,
  execute: async () => ({ ok: true, output: { kind: 'text', text: 'ok' } }),
});

describe('Tool Registry 条件注册（需求 2.4）', () => {
  it('依赖满足时注册成功', () => {
    const registry = new ToolRegistry({ probe: () => true });
    expect(registry.register(dummy('python', CAPABILITY.kernelPython))).toBe(true);
    expect(registry.has('python')).toBe(true);
  });

  it('R 缺失时 r 不进工具列表', () => {
    // 让不可用的工具出现在列表里，结果是模型调用它、拿到执行期错误、然后重试。
    // 模型无法从一个失败的调用里学到「这个环境没装 R」
    const registry = new ToolRegistry({ probe: (c) => c !== CAPABILITY.kernelR });
    registry.register(dummy('python', CAPABILITY.kernelPython));
    registry.register(dummy('r', CAPABILITY.kernelR));

    expect(registry.list().map((t) => t.name)).toEqual(['python']);
    expect(registry.has('r')).toBe(false);
    expect(registry.toolSchemas().map((t) => t.name)).toEqual(['python']);
  });

  it('未注册的工具记下缺失原因', () => {
    const registry = new ToolRegistry({ probe: () => false });
    registry.register(dummy('r', CAPABILITY.kernelR));

    expect(registry.unavailable()).toEqual([
      { name: 'r', missing: [{ capability: CAPABILITY.kernelR, remediation: '请安装 kernel:r' }] },
    ]);
  });

  it('被问起时给出可执行的安装指引（需求 9.6）', () => {
    // 「r 工具不可用」毫无帮助，用户需要具体的命令
    const registry = new ToolRegistry({ probe: () => false });
    registry.register(dummy('r', CAPABILITY.kernelR));

    const explanation = registry.explainUnavailable('r');
    expect(explanation).toContain(CAPABILITY.kernelR);
    expect(explanation).toContain('请安装');
  });

  it('可用的工具解释为 null', () => {
    const registry = new ToolRegistry({ probe: () => true });
    registry.register(dummy('python', CAPABILITY.kernelPython));
    expect(registry.explainUnavailable('python')).toBeNull();
  });

  it('完全不存在的工具与依赖缺失的工具区分开', () => {
    const registry = new ToolRegistry({ probe: () => true });
    expect(registry.explainUnavailable('nonexistent')).toContain('没有名为');
  });

  it('依赖缺失不抛错，不让后端启动失败', () => {
    // R 没装是正常情况
    const registry = new ToolRegistry({ probe: () => false });
    expect(() => registry.register(dummy('r', CAPABILITY.kernelR))).not.toThrow();
  });

  it('工具名重复时抛错', () => {
    const registry = new ToolRegistry({ probe: () => true });
    registry.register(dummy('python'));
    expect(() => registry.register(dummy('python'))).toThrow(/重复/);
  });

  it('列表按名字排序，保证稳定', () => {
    const registry = new ToolRegistry({ probe: () => true });
    registry.register(dummy('zebra'));
    registry.register(dummy('alpha'));
    expect(registry.list().map((t) => t.name)).toEqual(['alpha', 'zebra']);
  });

  it('无依赖声明的工具总是注册', () => {
    const registry = new ToolRegistry({ probe: () => false });
    expect(registry.register(dummy('read_file'))).toBe(true);
  });
});

describe('工具调用', () => {
  it('调用不可用的工具抛 ToolUnavailableError 并带上指引', async () => {
    const registry = new ToolRegistry({ probe: () => false });
    registry.register(dummy('r', CAPABILITY.kernelR));

    await expect(registry.invoke('r', {}, ctx())).rejects.toThrow(ToolUnavailableError);
    await expect(registry.invoke('r', {}, ctx())).rejects.toThrow(/请安装/);
  });

  it('入参非法抛 ToolInputError 而不是执行错误', async () => {
    // 两者必须分开：入参错了重试同样的参数没有意义，
    // 执行失败可能是环境的临时问题
    const registry = new ToolRegistry({ probe: () => true });
    registry.register({
      ...dummy('strict'),
      parseInput: () => {
        throw new Error('缺少必填字段 x');
      },
    });

    await expect(registry.invoke('strict', {}, ctx())).rejects.toThrow(ToolInputError);
    await expect(registry.invoke('strict', {}, ctx())).rejects.toThrow(/缺少必填字段/);
  });

  it('正常调用返回工具结果', async () => {
    const registry = new ToolRegistry({ probe: () => true });
    registry.register(dummy('echo'));
    const result = await registry.invoke('echo', {}, ctx());
    expect(result).toMatchObject({ ok: true, output: { kind: 'text', text: 'ok' } });
  });
});

/* ------------------------------------------------------------------ *
 * bash 工具
 * ------------------------------------------------------------------ */

/** 假后端，用于在不起真进程的情况下测工具层。 */
function fakeBackend(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    id: 'native',
    isolation: {
      backend: 'native',
      filesystem: 'advisory',
      network: 'proxy',
      process: 'job-object',
      caveats: [],
    },
    runShell: async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'hello',
      stderr: '',
      truncated: false,
      durationMs: 5,
      timedOut: false,
    }),
    toGuestPath: (p) => p,
    supportsShell: (k) => k === 'powershell',
    dispose: async () => undefined,
    ...overrides,
  } as SandboxBackend;
}

describe('输出截断标注（需求 4.3）', () => {
  it('未超限时原样返回', () => {
    expect(truncateStream('short', 100)).toBe('short');
  });

  it('超限时截断并标注省略量', () => {
    // 静默截断会让模型基于半截输出下结论，而它无从知道后面还有东西
    const long = 'x'.repeat(500);
    const result = truncateStream(long, 100);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('已省略');
    expect(result).toContain('400');
  });

  it('保留头尾而不是只留头部', () => {
    // 失败原因通常在末尾（错误摘要、栈顶），上下文通常在开头
    const text = `HEAD${'m'.repeat(500)}TAIL`;
    const result = truncateStream(text, 100);
    expect(result.startsWith('HEAD')).toBe(true);
    expect(result.endsWith('TAIL')).toBe(true);
  });
});

describe('结果三元组（需求 4.4、4.5）', () => {
  it('成功时也标注退出码', () => {
    // 只在失败时标注会让模型无法区分「成功且无输出」与「输出被吞了」
    const text = formatShellResult({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    expect(text).toContain('退出码 0');
    expect(text).toContain('没有输出');
  });

  it('非零退出不吞 stdout', () => {
    // 很多工具把有用的信息写在 stdout 上
    const text = formatShellResult({
      stdout: '正在编译...\n找到 3 个警告',
      stderr: 'error: 编译失败',
      exitCode: 1,
      timedOut: false,
    });
    expect(text).toContain('正在编译');
    expect(text).toContain('编译失败');
    expect(text).toContain('退出码 1');
  });

  it('超时单独标注而不是报退出码', () => {
    const text = formatShellResult({ stdout: 'a', stderr: '', exitCode: null, timedOut: true });
    expect(text).toContain('超时被终止');
    expect(text).not.toContain('退出码');
  });

  it('后端层截断也要标注', () => {
    // 字节上限与字符上限是两道，只报一道会让用户以为输出完整
    const text = formatShellResult({
      stdout: 'a',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: true,
    });
    expect(text).toContain('后端截断');
  });
});

describe('bash 工具入参与执行', () => {
  const tool = () =>
    createShellTool({ backend: fakeBackend(), resolveCwd: (raw) => raw ?? workspace });

  it('只暴露后端支持的 shell', () => {
    const schema = tool().inputSchema as { properties: { shell: { enum: string[] } } };
    // 假后端只支持 powershell
    expect(schema.properties.shell.enum).toEqual(['powershell']);
  });

  it('省略 shell 时用默认值', () => {
    expect(tool().parseInput({ command: 'ls' })).toMatchObject({ shell: 'powershell' });
  });

  it('请求不可用的 shell 时报错并给出指引', () => {
    expect(() => tool().parseInput({ command: 'ls', shell: 'bash' })).toThrow(/不可用/);
    expect(() => tool().parseInput({ command: 'ls', shell: 'bash' })).toThrow(/wsl --install/);
  });

  it('WSL2 后端下 bash 可用', () => {
    const wslTool = createShellTool({
      backend: fakeBackend({ id: 'wsl2', supportsShell: () => true }),
      resolveCwd: () => workspace,
    });
    expect(wslTool.parseInput({ command: 'ls', shell: 'bash' })).toMatchObject({ shell: 'bash' });
  });

  it('空命令被拒', () => {
    expect(() => tool().parseInput({ command: '   ' })).toThrow(/非空/);
  });

  it('非法 timeoutMs 被拒', () => {
    expect(() => tool().parseInput({ command: 'ls', timeoutMs: -1 })).toThrow(/正数/);
    expect(() => tool().parseInput({ command: 'ls', timeoutMs: 'x' })).toThrow(/正数/);
  });

  it('执行成功返回 ok', async () => {
    const result = await tool().execute({ command: 'ls', shell: 'powershell' }, ctx());
    expect(result.ok).toBe(true);
    expect((result.output as { text: string }).text).toContain('hello');
  });

  it('非零退出返回 ok=false 但保留输出', async () => {
    const failing = createShellTool({
      backend: fakeBackend({
        runShell: async () => ({
          exitCode: 2,
          signal: null,
          stdout: '部分结果',
          stderr: '出错了',
          truncated: false,
          durationMs: 1,
          timedOut: false,
        }),
      }),
      resolveCwd: () => workspace,
    });

    const result = await failing.execute({ command: 'x', shell: 'powershell' }, ctx());
    expect(result.ok).toBe(false);
    const text = (result.output as { text: string }).text;
    expect(text).toContain('部分结果');
    expect(text).toContain('出错了');
  });

  it('路径越界作为 error 输出返回', async () => {
    const guarded = createShellTool({
      backend: fakeBackend(),
      resolveCwd: () => {
        throw new Error('路径超出沙箱边界');
      },
    });
    const result = await guarded.execute({ command: 'ls', shell: 'powershell' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ kind: 'error', ename: 'PathDenied' });
  });

  it('后端抛错时报环境问题而不是命令错误', async () => {
    const broken = createShellTool({
      backend: fakeBackend({
        runShell: async () => {
          throw new Error('ENOENT');
        },
      }),
      resolveCwd: () => workspace,
    });
    const result = await broken.execute({ command: 'ls', shell: 'powershell' }, ctx());
    expect(result.output).toMatchObject({ ename: 'ShellSpawnError' });
  });
});

/* ------------------------------------------------------------------ *
 * read_file
 * ------------------------------------------------------------------ */

describe('二进制识别（需求 5.4）', () => {
  it('含 NUL 字节判定为二进制', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('普通 UTF-8 文本不是二进制', () => {
    expect(looksBinary(Buffer.from('第一行\n第二行\ttab\r\n', 'utf8'))).toBe(false);
  });

  it('空文件不是二进制', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  it('控制字符比例高时判定为二进制', () => {
    const bytes = Buffer.alloc(100);
    for (let i = 0; i < 100; i += 1) bytes[i] = i % 10 === 0 ? 0x01 : 0x41;
    expect(looksBinary(bytes)).toBe(true);
  });

  it('按内容判定而不是扩展名', () => {
    // 扩展名会骗人：.dat 可能是文本，.txt 可能是误命名的二进制
    expect(looksBinary(Buffer.from('plain text', 'utf8'))).toBe(false);
  });

  it('PDF 按魔数识别', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n...', 'latin1'))).toBe(true);
    expect(isPdf(Buffer.from('not a pdf', 'utf8'))).toBe(false);
  });
});

describe('按行读取', () => {
  const text = ['第一行', '第二行', '第三行', '第四行'].join('\n');

  it('不指定范围时返回全文', () => {
    expect(sliceLines(text).text).toBe(text);
  });

  it('指定范围时带上行号', () => {
    // 模型后续要用 edit_file 精确替换，没有行号它无法确认自己看的是哪段
    const result = sliceLines(text, 2, 3);
    expect(result.text).toContain('2\t第二行');
    expect(result.text).toContain('3\t第三行');
    expect(result.text).not.toContain('第一行');
    expect(result.note).toContain('第 2-3 行');
  });

  it('结束行超出文件时截到末行', () => {
    expect(sliceLines(text, 3, 999).note).toContain('第 3-4 行');
  });

  it('起始行超出文件时明确说明', () => {
    const result = sliceLines(text, 99);
    expect(result.text).toBe('');
    expect(result.note).toContain('超出文件行数');
  });

  it('超长文件不静默截断，而是提示分段读', () => {
    const huge = 'x'.repeat(300_000);
    const result = sliceLines(huge);
    expect(result.note).toContain('分段读取');
    expect(result.note).toContain('startLine');
  });
});

describe('read_file 工具', () => {
  const tool = () => createReadFileTool({ resolvePath: (raw) => join(workspace, raw) });

  it('读取文本文件', async () => {
    writeFileSync(join(workspace, 'a.txt'), '内容', 'utf8');
    const result = await tool().execute({ path: 'a.txt' }, ctx());
    expect(result.ok).toBe(true);
    expect((result.output as { text: string }).text).toContain('内容');
  });

  it('二进制文件被拒并提示改用代码工具', async () => {
    // 返回一串 U+FFFD 会让模型基于垃圾推理
    writeFileSync(join(workspace, 'data.npy'), Buffer.from([0x93, 0x4e, 0x00, 0x50]));
    const result = await tool().execute({ path: 'data.npy' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ ename: 'BinaryFile' });
    expect((result.output as { evalue: string }).evalue).toContain('python');
  });

  it('目录被拒', async () => {
    const result = await tool().execute({ path: '.' }, ctx());
    expect(result.output).toMatchObject({ ename: 'IsADirectory' });
  });

  it('不存在的文件报读取失败', async () => {
    const result = await tool().execute({ path: 'nope.txt' }, ctx());
    expect(result.output).toMatchObject({ ename: 'ReadFailed' });
  });

  it('path 与 versionId 必须提供其一', () => {
    expect(() => tool().parseInput({})).toThrow(/必须提供/);
  });

  it('path 与 versionId 不能同时提供', () => {
    // 同时给两个说明模型不确定该用哪个，猜一个会掩盖它的困惑
    expect(() => tool().parseInput({ path: 'a', versionId: 'v1' })).toThrow(/只能提供一个/);
  });

  it('行号必须是不小于 1 的整数', () => {
    expect(() => tool().parseInput({ path: 'a', startLine: 0 })).toThrow(/不小于 1/);
    expect(() => tool().parseInput({ path: 'a', startLine: 1.5 })).toThrow(/整数/);
  });

  it('endLine 不能小于 startLine', () => {
    expect(() => tool().parseInput({ path: 'a', startLine: 5, endLine: 2 })).toThrow(/不能小于/);
  });

  it('PDF 未指定页码时要求指定', async () => {
    // 默认读第一页会让模型以为自己看过全文了
    writeFileSync(join(workspace, 'p.pdf'), Buffer.from('%PDF-1.7\ncontent', 'latin1'));
    const result = await tool().execute({ path: 'p.pdf' }, ctx());
    expect(result.output).toMatchObject({ ename: 'PdfSupportMissing' });
  });

  it('接入抽取器后可按页读 PDF', async () => {
    writeFileSync(join(workspace, 'p.pdf'), Buffer.from('%PDF-1.7\ncontent', 'latin1'));
    const withPdf = createReadFileTool({
      resolvePath: (raw) => join(workspace, raw),
      extractPdfPage: async (_p, page) => ({ text: `第 ${String(page)} 页正文`, pageCount: 10 }),
    });

    const result = await withPdf.execute({ path: 'p.pdf', page: 3 }, ctx());
    expect(result.ok).toBe(true);
    const text = (result.output as { text: string }).text;
    expect(text).toContain('第 3 页正文');
    expect(text).toContain('共 10 页');
  });

  it('页码超范围时报错并给出总页数', async () => {
    writeFileSync(join(workspace, 'p.pdf'), Buffer.from('%PDF-1.7\n', 'latin1'));
    const withPdf = createReadFileTool({
      resolvePath: (raw) => join(workspace, raw),
      extractPdfPage: async () => ({ text: '', pageCount: 5 }),
    });
    const result = await withPdf.execute({ path: 'p.pdf', page: 99 }, ctx());
    expect(result.output).toMatchObject({ ename: 'PageOutOfRange' });
    expect((result.output as { evalue: string }).evalue).toContain('共 5 页');
  });

  it('versionId 找不到时明确报错', async () => {
    const result = await tool().execute({ versionId: 'v_missing' }, ctx());
    expect(result.output).toMatchObject({ ename: 'VersionNotFound' });
  });
});

/* ------------------------------------------------------------------ *
 * edit_file
 * ------------------------------------------------------------------ */

describe('精确替换命中判定（需求 6.9）', () => {
  it('唯一命中时报 1', () => {
    expect(replaceOnce('abc def ghi', 'def').matches).toBe(1);
  });

  it('零次命中时报 0', () => {
    expect(replaceOnce('abc', 'xyz').matches).toBe(0);
  });

  it('多次命中时报大于 1', () => {
    expect(replaceOnce('aa bb aa', 'aa').matches).toBeGreaterThan(1);
  });

  it('不做任何归一化', () => {
    // 任何「智能匹配」都会让模型在没意识到的情况下改动别的地方
    expect(replaceOnce('a  b', 'a b').matches).toBe(0);
    expect(replaceOnce('Hello', 'hello').matches).toBe(0);
  });

  it('空 oldText 视为零命中', () => {
    expect(replaceOnce('anything', '').matches).toBe(0);
  });
});

describe('edit_file 工具', () => {
  const tool = () => createEditFileTool({ resolvePath: (raw) => join(workspace, raw) });
  const file = () => join(workspace, 'doc.md');

  beforeEach(() => {
    writeFileSync(file(), '# 标题\n\n第一段内容。\n\n第二段内容。\n', 'utf8');
  });

  it('唯一命中时完成替换', async () => {
    const result = await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: '第一段内容。', newText: '改过的第一段。' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file(), 'utf8')).toContain('改过的第一段。');
  });

  it('零次命中时失败且不改文件', async () => {
    const before = readFileSync(file(), 'utf8');
    const result = await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: '不存在的原文', newText: 'x' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ ename: 'NoMatch' });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('零次命中时提示重新读取并注意逐字符一致', async () => {
    const result = await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: 'x', newText: 'y' },
      ctx(),
    );
    const evalue = (result.output as { evalue: string }).evalue;
    expect(evalue).toContain('read_file');
    expect(evalue).toContain('逐字符一致');
  });

  it('多次命中时失败且不改文件', async () => {
    // 改错地方在手稿编辑里最难发现：文件还在、语法还对，只是内容悄悄变了
    writeFileSync(file(), '重复\n重复\n', 'utf8');
    const before = readFileSync(file(), 'utf8');

    const result = await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: '重复', newText: '改了' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ ename: 'AmbiguousMatch' });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('多次命中时提示带上更多上下文', async () => {
    writeFileSync(file(), 'x\nx\n', 'utf8');
    const result = await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: 'x', newText: 'y' },
      ctx(),
    );
    expect((result.output as { evalue: string }).evalue).toContain('更多上下文');
  });

  it('newText 里的 $& 不被当作替换模式展开', async () => {
    // String.replace 会把 $& 展开成匹配内容，而手稿里完全可能出现 $
    await tool().execute(
      { path: 'doc.md', mode: 'replace', oldText: '第一段内容。', newText: '价格是 $&100 美元' },
      ctx(),
    );
    expect(readFileSync(file(), 'utf8')).toContain('$&100');
  });

  it('write 模式覆盖全文', async () => {
    const result = await tool().execute(
      { path: 'doc.md', mode: 'write', newText: '全新内容' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file(), 'utf8')).toBe('全新内容');
  });

  it('write 模式报告写入规模', async () => {
    const result = await tool().execute(
      { path: 'doc.md', mode: 'write', newText: 'a\nb\nc' },
      ctx(),
    );
    expect((result.output as { text: string }).text).toContain('3 行');
  });

  it('replace 模式必须提供非空 oldText', () => {
    expect(() => tool().parseInput({ path: 'a', mode: 'replace', newText: 'x' })).toThrow(
      /oldText/,
    );
    expect(() =>
      tool().parseInput({ path: 'a', mode: 'replace', oldText: '', newText: 'x' }),
    ).toThrow(/oldText/);
  });

  it('oldText 与 newText 相同时报错', () => {
    // 静默成功会让模型以为改动生效了
    expect(() =>
      tool().parseInput({ path: 'a', mode: 'replace', oldText: 'same', newText: 'same' }),
    ).toThrow(/不会产生任何变化/);
  });

  it('非法 mode 被拒', () => {
    expect(() => tool().parseInput({ path: 'a', mode: 'append', newText: 'x' })).toThrow(/mode/);
  });

  it('二进制文件不能做文本替换', async () => {
    writeFileSync(join(workspace, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const result = await tool().execute(
      { path: 'bin.dat', mode: 'replace', oldText: 'a', newText: 'b' },
      ctx(),
    );
    expect(result.output).toMatchObject({ ename: 'BinaryFile' });
  });

  it('路径越界被拒', async () => {
    const guarded = createEditFileTool({
      resolvePath: () => {
        throw new Error('越界');
      },
    });
    const result = await guarded.execute(
      { path: '../../etc/passwd', mode: 'write', newText: 'x' },
      ctx(),
    );
    expect(result.output).toMatchObject({ ename: 'PathDenied' });
  });
});

/* ------------------------------------------------------------------ *
 * python / r 工具
 * ------------------------------------------------------------------ */

describe('富输出降级为文本（需求 3.1）', () => {
  it('优先取 text/plain', () => {
    expect(describeMimeBundle({ 'text/plain': '42', 'text/html': '<b>42</b>' })).toBe('42');
  });

  it('只有 HTML 时粗剥标签', () => {
    // 目的是让模型看到 DataFrame 的表格文字，不追求正确的 HTML 解析
    const html = '<style>.x{}</style><table><tr><td>甲</td><td>乙</td></tr></table>';
    const result = describeMimeBundle({ 'text/html': html });
    expect(result).toContain('甲');
    expect(result).toContain('乙');
    expect(result).not.toContain('<td>');
    expect(result).not.toContain('.x{}');
  });

  it('图像返回说明而不是 base64', () => {
    // 几百 KB 的 base64 既挤掉真正的内容，模型也读不出图里画了什么
    const bundle = { 'image/png': 'A'.repeat(4000) };
    const result = describeMimeBundle(bundle);
    expect(result).toContain('image/png');
    expect(result).toContain('KB');
    expect(result).toContain('制品');
    expect(result).not.toContain('AAAA');
  });

  it('JSON 表示是对象时正确序列化', () => {
    // 这正是 MimeBundle 的值类型必须是 unknown 而不是 string 的原因
    const result = describeMimeBundle({ 'application/json': { a: 1, b: [2, 3] } });
    expect(result).toContain('"a":1');
  });

  it('未知类型至少报告有哪些表示', () => {
    expect(describeMimeBundle({ 'application/vnd.custom': 'x' })).toContain(
      'application/vnd.custom',
    );
  });

  it('空 bundle 返回空串', () => {
    expect(describeMimeBundle({})).toBe('');
  });
});

/** 把数组变成异步可迭代，模拟内核输出流。 */
async function* streamOf<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe('内核输出收集', () => {
  it('拼接 stdout 与 stderr 并保序', async () => {
    const collected = await collectExecution(
      streamOf([
        { type: 'stream', name: 'stdout', text: '第一段' },
        { type: 'stream', name: 'stderr', text: '警告' },
        { type: 'stream', name: 'stdout', text: '第二段' },
      ] as const),
    );
    expect(collected.text).toBe('第一段警告第二段');
  });

  it('富输出单独收集，不被压进文本', async () => {
    const collected = await collectExecution(
      streamOf([
        { type: 'stream', name: 'stdout', text: '正在画图' },
        { type: 'display_data', data: { 'image/png': 'AAAA' } },
      ] as const),
    );
    expect(collected.text).toBe('正在画图');
    expect(collected.rich).toHaveLength(1);
  });

  it('只保留第一个错误', async () => {
    // 后续错误通常是同一问题的连带反应，全部返回会把真正的原因埋在噪声里
    const collected = await collectExecution(
      streamOf([
        { type: 'error', ename: 'ValueError', evalue: '真正的原因', traceback: [] },
        { type: 'error', ename: 'RuntimeError', evalue: '连带反应', traceback: [] },
      ] as const),
    );
    expect(collected.error).toMatchObject({ ename: 'ValueError', evalue: '真正的原因' });
  });

  it('协议状态消息不进结果', async () => {
    const collected = await collectExecution(
      streamOf([
        { type: 'status', state: 'busy' },
        { type: 'execute_input', code: 'x=1', executionCount: 1 },
        { type: 'status', state: 'idle' },
      ] as const),
    );
    expect(collected.text).toBe('');
    expect(collected.rich).toHaveLength(0);
    expect(collected.error).toBeNull();
  });

  it('流式回调按到达顺序触发', async () => {
    const seen: string[] = [];
    await collectExecution(
      streamOf([
        { type: 'stream', name: 'stdout', text: 'a' },
        { type: 'display_data', data: { 'text/plain': 'b' } },
        { type: 'error', ename: 'E', evalue: 'v', traceback: [] },
      ] as const),
      (chunk) => seen.push(chunk.kind),
    );
    expect(seen).toEqual(['text', 'rich', 'error']);
  });
});

describe('执行结果格式化', () => {
  it('成功且有输出', () => {
    const result = formatExecution({ text: '结果是 42\n', rich: [], error: null });
    expect(result.ok).toBe(true);
    expect((result.output as { text: string }).text).toBe('结果是 42');
  });

  it('无输出时明确说明', () => {
    // 返回空串会让模型无法区分「跑完没输出」与「输出丢了」
    const result = formatExecution({ text: '', rich: [], error: null });
    expect((result.output as { text: string }).text).toContain('没有输出');
  });

  it('出错时返回 error 输出且 ok=false', () => {
    const result = formatExecution({
      text: '',
      rich: [],
      error: { ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['line 1'] },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ kind: 'error', ename: 'ZeroDivisionError' });
  });

  it('超长 traceback 保留末尾', () => {
    // 异常类型与出错位置在末尾，顶部的调用栈通常是框架代码
    const traceback = Array.from({ length: 50 }, (_, i) => `frame ${String(i)}`);
    const result = formatExecution({
      text: '',
      rich: [],
      error: { ename: 'E', evalue: 'v', traceback },
    });
    const tb = (result.output as { traceback: string[] }).traceback;
    expect(tb.length).toBeLessThan(50);
    expect(tb.at(-1)).toBe('frame 49');
    expect(tb[0]).toContain('已省略');
  });

  it('文本与富输出都被纳入', () => {
    const result = formatExecution({
      text: '前置输出',
      rich: [{ 'text/plain': '<DataFrame>' }],
      error: null,
    });
    const text = (result.output as { text: string }).text;
    expect(text).toContain('前置输出');
    expect(text).toContain('<DataFrame>');
  });
});

describe('内核工具入参', () => {
  /** 假池，只需满足入参校验路径。 */
  const fakePool = { acquire: async () => ({}) } as never;

  it('python 工具声明 Python 内核依赖', () => {
    const tool = createKernelTool({ pool: fakePool, language: 'python' });
    expect(tool.name).toBe('python');
    expect(tool.requirements?.[0]?.capability).toBe(CAPABILITY.kernelPython);
  });

  it('r 工具声明 R 内核依赖，并说明变量不与 Python 共享', () => {
    const tool = createKernelTool({ pool: fakePool, language: 'r' });
    expect(tool.name).toBe('r');
    expect(tool.requirements?.[0]?.capability).toBe(CAPABILITY.kernelR);
    expect(tool.description).toContain('变量不共享');
  });

  it('空代码被拒', () => {
    const tool = createKernelTool({ pool: fakePool, language: 'python' });
    expect(() => tool.parseInput({ code: '  ' })).toThrow(/非空/);
  });

  it('不支持后台时 background 不在 schema 里也不接受', () => {
    const tool = createKernelTool({ pool: fakePool, language: 'python' });
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.background).toBeUndefined();
    expect(() => tool.parseInput({ code: 'x', background: true })).toThrow(/不支持后台/);
  });

  it('支持后台时接受 background', () => {
    const tool = createKernelTool({
      pool: fakePool,
      language: 'python',
      submitBackground: () => 'task-1',
    });
    expect(tool.parseInput({ code: 'x', background: true })).toMatchObject({ background: true });
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.background).toBeDefined();
  });

  it('内核起不来时给出安装指引而不是裸错误', async () => {
    const brokenPool = {
      acquire: async () => {
        throw new Error('conda env not found');
      },
    } as never;
    const tool = createKernelTool({ pool: brokenPool, language: 'r' });
    const result = await tool.execute({ code: '1+1' }, ctx());

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ ename: 'KernelUnavailable' });
    expect((result.output as { evalue: string }).evalue).toContain('conda create');
  });
});
