/**
 * 原生依赖可用性测试。
 *
 * 本机没有 C/C++ 工具链（无 MSVC、Windows SDK 头文件缺失），因此所有原生模块
 * 必须命中发布方提供的 prebuilt 二进制。这组测试把这个硬约束固化下来：
 * 一旦某次依赖升级导致 prebuilt 不再覆盖当前 Node ABI，CI 立刻失败，
 * 而不是等到运行期才发现内核起不来。
 */

import { describe, expect, it } from 'vitest';

describe('原生依赖', () => {
  it('better-sqlite3 可加载并能建表读写', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
      const rows = db.prepare('SELECT id, v FROM t').all() as Array<{ id: number; v: string }>;
      expect(rows).toEqual([{ id: 1, v: 'hello' }]);

      const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      expect(v).toMatch(/^3\.\d+\.\d+$/);
    } finally {
      db.close();
    }
  });

  it('zeromq 可加载', async () => {
    const zmq = await import('zeromq');
    expect(typeof zmq.Push).toBe('function');
  });

  it('zeromq PUSH/PULL 能在本地回环上收发', async () => {
    const { Push, Pull } = await import('zeromq');
    const push = new Push();
    const pull = new Pull();
    try {
      // 绑定到随机端口，避免与开发机上其他进程抢占固定端口。
      // zeromq 6 用 lastEndpoint 回读实际绑定的地址。
      await pull.bind('tcp://127.0.0.1:0');
      const endpoint = pull.lastEndpoint;
      expect(endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
      push.connect(endpoint ?? '');

      await push.send('ping');
      const [frame] = await pull.receive();
      expect(frame?.toString()).toBe('ping');
    } finally {
      push.close();
      pull.close();
    }
  });
});
