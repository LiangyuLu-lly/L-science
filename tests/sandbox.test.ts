/**
 * 沙箱边界测试（任务 5.1-5.7）。
 *
 * 路径守卫是 `native` 后端下**唯一真正起作用**的文件系统边界，所以这里对每一类
 * 绕过手法都有单独用例。Windows 的路径语义有一批容易被忽略的等价写法，漏掉任何
 * 一条都等于边界失效。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InterruptEvent,
  JobObject,
  NativeBackend,
  PathDeniedError,
  PathGuard,
  isolationStrength,
  nativeCapabilities,
  runSupervised,
  selectBackend,
  toWslPath,
  win32Available,
} from '@l-science/core';

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-sbx-'));
  workspace = join(root, 'workspace');
  outside = join(root, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function guard(extra: { readOnlyRoots?: string[]; protectedPaths?: string[] } = {}): PathGuard {
  return new PathGuard({
    roots: [workspace],
    caseSensitive: false,
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * 路径守卫
 * ------------------------------------------------------------------ */

describe('路径守卫：允许的情况', () => {
  it('允许根目录本身与其下的路径', () => {
    const g = guard();
    expect(g.check(workspace, 'write').allowed).toBe(true);
    expect(g.check(join(workspace, 'a', 'b.txt'), 'write').allowed).toBe(true);
  });

  it('允许尚不存在的目标路径（写新文件）', () => {
    expect(guard().check(join(workspace, 'not-yet', 'file.csv'), 'write').allowed).toBe(true);
  });

  it('大小写不同但仍在根内时允许（NTFS 不区分大小写）', () => {
    const g = guard();
    expect(g.check(workspace.toUpperCase(), 'read').allowed).toBe(true);
  });

  it('assert 返回规范化后的路径', () => {
    const messy = join(workspace, 'a', '.', 'b', '..', 'c.txt');
    expect(guard().assert(messy, 'write')).toBe(join(workspace, 'a', 'c.txt'));
  });
});

describe('路径守卫：逃逸手法', () => {
  it('拒绝 .. 穿越到根外', () => {
    const d = guard().check(join(workspace, '..', 'outside', 'x.txt'), 'write');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('outside-allowed-roots');
  });

  it('拒绝相对路径', () => {
    expect(guard().check('a/b.txt', 'read').reason).toBe('not-absolute');
  });

  it('拒绝根外的绝对路径', () => {
    expect(guard().check(join(outside, 'x.txt'), 'read').reason).toBe('outside-allowed-roots');
  });

  it('拒绝 UNC 路径', () => {
    expect(guard().check('\\\\server\\share\\x.txt', 'read').reason).toBe('unc-path');
    expect(guard().check('//server/share/x.txt', 'read').reason).toBe('unc-path');
  });

  it('拒绝长路径前缀（会绕过规范化）', () => {
    const d = guard().check(`\\\\?\\${workspace}\\..\\outside\\x.txt`, 'write');
    expect(d.reason).toBe('long-path-prefix');
  });

  it('拒绝设备命名空间前缀', () => {
    expect(guard().check('\\\\.\\PhysicalDrive0', 'read').reason).toBe('long-path-prefix');
  });

  it('拒绝备用数据流', () => {
    const d = guard().check(join(workspace, 'notes.txt:hidden'), 'write');
    expect(d.reason).toBe('alternate-data-stream');
  });

  it('拒绝保留设备名，含带扩展名的形式', () => {
    const g = guard();
    for (const name of ['NUL', 'CON', 'com1', 'LPT9', 'nul.txt', 'CON.log']) {
      expect(g.check(join(workspace, name), 'write').reason, name).toBe('reserved-device-name');
    }
  });

  it('拒绝尾随点或空格（系统会静默剥掉，造成校验与实际不一致）', () => {
    const g = guard();
    expect(g.check(join(workspace, 'secret.'), 'write').reason).toBe('trailing-dot-or-space');
    expect(g.check(`${join(workspace, 'secret')} `, 'write').reason).toBe('trailing-dot-or-space');
  });

  it('拒绝 8.3 短名别名', () => {
    expect(guard().check('C:\\PROGRA~1\\x.txt', 'read').reason).toBe('short-name-alias');
  });

  it('拒绝含 NUL 字节的路径', () => {
    expect(guard().check(`${join(workspace, 'a')}\0.txt`, 'write').reason).toBe('nul-byte');
  });

  it('拒绝经符号链接指向根外的路径', () => {
    const link = join(workspace, 'escape');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      // 无权限创建链接时跳过（Windows 上 junction 通常不需要提权）
      return;
    }
    const d = guard().check(join(link, 'x.txt'), 'write');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('symlink-escape');
  });

  it('空根列表时一律拒绝', () => {
    const g = new PathGuard({ roots: [] });
    expect(g.check(join(workspace, 'a.txt'), 'read').allowed).toBe(false);
  });
});

describe('路径守卫：受保护路径', () => {
  it('拒写凭据与可执行配置，但允许读', () => {
    const g = guard();
    const cases = [
      join(workspace, '.ssh', 'id_rsa'),
      join(workspace, '.git', 'config'),
      join(workspace, '.git', 'hooks', 'pre-commit'),
      join(workspace, '.vscode', 'tasks.json'),
      join(workspace, '.idea', 'workspace.xml'),
      join(workspace, '.npmrc'),
      join(workspace, '.bashrc'),
      join(workspace, 'Microsoft.PowerShell_profile.ps1'),
    ];
    for (const p of cases) {
      expect(g.check(p, 'write').reason, p).toBe('protected-path');
      // 读取无害且有诊断价值
      expect(g.check(p, 'read').allowed, p).toBe(true);
    }
  });

  it('拒写显式声明的受保护目录（如平台自身的数据目录）', () => {
    const dataDir = join(workspace, 'appdata');
    const g = guard({ protectedPaths: [dataDir] });
    expect(g.check(join(dataDir, 'app.db'), 'write').reason).toBe('protected-path');
  });

  it('只读授权下拒写但允许读', () => {
    const ro = join(workspace, 'readonly');
    mkdirSync(ro, { recursive: true });
    const g = guard({ readOnlyRoots: [ro] });
    expect(g.check(join(ro, 'x.txt'), 'read').allowed).toBe(true);
    expect(g.check(join(ro, 'x.txt'), 'write').reason).toBe('read-only-grant');
  });
});

describe('路径守卫：错误信息', () => {
  it('assert 抛出带原因的错误', () => {
    try {
      guard().assert('\\\\server\\share\\x', 'read');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PathDeniedError);
      expect((err as PathDeniedError).reason).toBe('unc-path');
      expect((err as Error).message).toContain('UNC');
    }
  });

  it('受保护路径的错误信息说明是什么东西', () => {
    try {
      guard().assert(join(workspace, '.ssh', 'id_rsa'), 'write');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as Error).message).toContain('SSH');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 原生能力
 * ------------------------------------------------------------------ */

describe('原生能力（FFI）', () => {
  it('报告 FFI 与 Job Object 可用性', () => {
    const caps = nativeCapabilities();
    expect(typeof caps.ffi).toBe('boolean');
    // 本机应当可用；不可用时 notes 必须给出后果说明
    if (!caps.ffi) expect(caps.notes.length).toBeGreaterThan(0);
  });

  it.skipIf(!win32Available())('Job Object 可创建并设限额', () => {
    const job = JobObject.create({ memoryMb: 256, killOnClose: true });
    expect(job).not.toBeNull();
    expect(job?.closed).toBe(false);
    job?.close();
    expect(job?.closed).toBe(true);
  });

  it.skipIf(!win32Available())('Job Object 关闭后拒绝继续 assign', () => {
    const job = JobObject.create({ killOnClose: true });
    job?.close();
    expect(() => job?.assign(process.pid)).toThrow(/已关闭/);
  });

  it.skipIf(!win32Available())('中断事件可创建并给出可传递的句柄值', () => {
    const evt = InterruptEvent.create();
    expect(evt).not.toBeNull();
    expect(evt?.env['JPY_INTERRUPT_EVENT']).toMatch(/^\d+$/);
    // 触发应当成功（此刻无人等待，但 SetEvent 本身要返回成功）
    expect(evt?.signal()).toBe(true);
    evt?.close();
    // 关闭后不再递送
    expect(evt?.signal()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 进程监管
 * ------------------------------------------------------------------ */

describe('进程监管', () => {
  it('捕获输出与退出码', async () => {
    const r = await runSupervised({
      command: process.execPath,
      args: ['-e', 'console.log("hi"); process.exit(3)'],
      cwd: workspace,
    });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  }, 30_000);

  it('墙钟超时会终止进程', async () => {
    const r = await runSupervised({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      cwd: workspace,
      timeoutMs: 1200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(20_000);
  }, 40_000);

  it('输出超限时截断并标注', async () => {
    const r = await runSupervised({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(200000))'],
      cwd: workspace,
      maxOutputBytes: 4096,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain('已截断');
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(20_000);
  }, 30_000);

  it.skipIf(!win32Available())(
    '限额由内核强制执行而非轮询',
    async () => {
      const r = await runSupervised({
        command: process.execPath,
        args: ['-e', 'console.log("ok")'],
        cwd: workspace,
        memoryMb: 512,
      });
      expect(r.enforcement).toBe('kernel');
    },
    30_000,
  );

  it.skipIf(!win32Available())(
    'Job Object 终止超出内存限额的进程',
    async () => {
      const r = await runSupervised({
        command: process.execPath,
        // 持续申请内存，应被 Job Object 干掉
        args: ['-e', 'const a=[];for(;;){a.push(Buffer.alloc(16*1024*1024));}'],
        cwd: workspace,
        memoryMb: 128,
        timeoutMs: 30_000,
      });
      // 关键：进程必须结束，而不是把机器内存吃光
      expect(r.durationMs).toBeLessThan(30_000);
      expect(r.exitCode === 0).toBe(false);
    },
    60_000,
  );
});

/* ------------------------------------------------------------------ *
 * 后端
 * ------------------------------------------------------------------ */

describe('native 后端', () => {
  it('如实报告隔离强度为弱，且 caveats 非空', () => {
    const b = new NativeBackend();
    expect(b.id).toBe('native');
    expect(isolationStrength(b.isolation)).toBe('weak');
    expect(b.isolation.filesystem).toBe('advisory');
    expect(b.isolation.caveats.length).toBeGreaterThan(0);
    // 必须明说文件系统边界可被绕过
    expect(b.isolation.caveats.join(' ')).toMatch(/绕过/);
  });

  it('未配置代理时网络标为 none 并在 caveats 说明', () => {
    const b = new NativeBackend();
    expect(b.isolation.network).toBe('none');
    expect(b.isolation.caveats.join(' ')).toMatch(/不受管控/);
  });

  it('配置代理后网络标为 proxy 且仍标注可绕过', () => {
    const b = new NativeBackend({ proxyUrl: 'http://127.0.0.1:8888' });
    expect(b.isolation.network).toBe('proxy');
    expect(b.isolation.caveats.join(' ')).toMatch(/socket/);
  });

  it.skipIf(!win32Available())('Job Object 可用时进程隔离标为 job-object', () => {
    expect(new NativeBackend().isolation.process).toBe('job-object');
  });

  it('WSL 不可用时拒绝 bash 并给出可执行指引', async () => {
    const b = new NativeBackend({ wslAvailable: false });
    expect(b.supportsShell('bash')).toBe(false);
    await expect(b.runShell({ command: 'echo hi', cwd: workspace, shell: 'bash' })).rejects.toThrow(
      /wsl --install/,
    );
  });

  it('执行 PowerShell 命令', async () => {
    const b = new NativeBackend();
    const r = await b.runShell({ command: 'Write-Output "hello-ps"', cwd: workspace });
    expect(r.stdout).toContain('hello-ps');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('非零退出码不被吞掉', async () => {
    const b = new NativeBackend();
    const r = await b.runShell({ command: 'exit 7', cwd: workspace });
    expect(r.exitCode).toBe(7);
  }, 60_000);

  it('命令含引号与中文时不被多层传参破坏', async () => {
    const b = new NativeBackend();
    const r = await b.runShell({
      command: 'Write-Output "含 \'单引号\' 与 中文"',
      cwd: workspace,
    });
    expect(r.stdout).toContain('单引号');
    expect(r.stdout).toContain('中文');
  }, 60_000);

  it('在指定工作目录执行', async () => {
    writeFileSync(join(workspace, 'marker.txt'), 'x');
    const b = new NativeBackend();
    const r = await b.runShell({ command: 'Get-ChildItem -Name', cwd: workspace });
    expect(r.stdout).toContain('marker.txt');
  }, 60_000);

  it('路径无需翻译', () => {
    expect(new NativeBackend().toGuestPath('C:\\a\\b')).toBe('C:\\a\\b');
  });
});

describe('wsl2 路径翻译', () => {
  it('Windows 路径转为 /mnt 形式', () => {
    expect(toWslPath('C:\\Users\\x\\ws')).toBe('/mnt/c/Users/x/ws');
    expect(toWslPath('D:/data/file.csv')).toBe('/mnt/d/data/file.csv');
  });

  it('已是 POSIX 形式时保持原样', () => {
    expect(toWslPath('/home/u/x')).toBe('/home/u/x');
  });
});

describe('后端选择', () => {
  it('SandboxBackendId 不含 docker', () => {
    // Given: docker 从未实现，类型里留下它就是幽灵承诺
    // When: 读后端 id 联合类型
    // Then: 只有 native 与 wsl2
    const src = readFileSync(join('packages', 'core', 'src', 'sandbox', 'backend.ts'), 'utf8');
    expect(src).toMatch(/export type SandboxBackendId = 'native' \| 'wsl2';/u);
    expect(src).not.toContain("'docker'");
  });

  it('强制 native 时不探测 WSL', async () => {
    const { backend, skipped } = await selectBackend({ prefer: 'native' });
    expect(backend.id).toBe('native');
    expect(skipped.some((s) => s.id === 'wsl2')).toBe(false);
  }, 30_000);

  it('skipped 说明 Docker 未实现以及实际后端', async () => {
    // Given: Docker 不是可选后端
    // When: 选择后端（含强制 native，避免本机 WSL 探测干扰）
    // Then: skipped 用一条中文说明未实现，以及实际是 native / WSL2
    const { skipped } = await selectBackend({ prefer: 'native' });
    expect(skipped).toContainEqual({
      id: 'docker',
      reason: 'Docker 未实现，实际可用的是 native（Windows 作业对象）与 WSL2。',
    });
  }, 30_000);

  it('自动选择时给出被跳过的候选及原因', async () => {
    const { backend, skipped } = await selectBackend();
    // 本机已装 Ubuntu，应选到 wsl2；未装时必须说明如何获得
    if (backend.id === 'native') {
      expect(skipped.some((s) => s.id === 'wsl2' && /wsl --install/.test(s.reason))).toBe(true);
    } else {
      expect(backend.id).toBe('wsl2');
      expect(isolationStrength(backend.isolation)).toBe('strong');
    }
  }, 60_000);

  it('wsl2 后端的 caveats 说明 /mnt 挂载仍可访问宿主文件', async () => {
    const { backend } = await selectBackend();
    if (backend.id !== 'wsl2') return;
    expect(backend.isolation.caveats.join(' ')).toMatch(/mnt/);
  }, 60_000);
});
