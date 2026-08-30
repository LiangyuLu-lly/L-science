/**
 * 数据目录覆盖与实例锁测试（任务 15.2，需求 20.4.2）。
 *
 * 需求 20.4.2 只要求「能用环境变量覆盖数据目录，以支持测试与多实例并行」。覆盖那一半
 * 早就有了；这里测的重点是另一半——**并行必须是安全的并行**。
 *
 * 在这之前，两个后端指向同一个数据目录时两边都能打开成功、谁也不报错，而后果是凭据库
 * 与连接器配置这类整文件读改写的地方「后写的覆盖前一个」。那种损坏不会在冲突发生的当天
 * 表现出来，因此必须靠一条拒绝启动的硬边界挡住，而不是靠警告。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_DIR_NAME,
  INSTANCE_LOCK_EXIT_CODE,
  acquireInstanceLock,
  dataDir,
  dataDirSource,
  describeDataDir,
  describeLockConflict,
  instanceLockPath,
  linuxAdapter,
  setPlatformAdapter,
} from '@l-science/core';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-inst-'));
});

afterEach(() => {
  setPlatformAdapter(null);
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 数据目录覆盖
 * ------------------------------------------------------------------ */

describe('数据目录覆盖', () => {
  const saved = process.env['L_SCIENCE_DATA_DIR'];

  afterEach(() => {
    if (saved === undefined) delete process.env['L_SCIENCE_DATA_DIR'];
    else process.env['L_SCIENCE_DATA_DIR'] = saved;
  });

  it('环境变量生效时来源报 env，否则报平台默认', () => {
    process.env['L_SCIENCE_DATA_DIR'] = root;
    expect(dataDir()).toBe(root);
    expect(dataDirSource()).toBe('env');
    // 说明里必须带上变量名：用户看到一个陌生路径时需要知道该去改哪里
    expect(describeDataDir()).toContain('L_SCIENCE_DATA_DIR');
    expect(describeDataDir()).toContain(root);

    delete process.env['L_SCIENCE_DATA_DIR'];
    expect(dataDirSource()).toBe('platform-default');
    expect(describeDataDir()).toContain('平台默认');
  });

  it('空串不算覆盖', () => {
    // 空串在 shell 里是「设过但清掉了」，按覆盖处理会把数据目录指到进程的工作目录
    process.env['L_SCIENCE_DATA_DIR'] = '';
    expect(dataDirSource()).toBe('platform-default');
    setPlatformAdapter(linuxAdapter);
    expect(dataDir()).toBe(linuxAdapter.defaultDataDir(APP_DIR_NAME));
  });
});

/* ------------------------------------------------------------------ *
 * 实例锁
 * ------------------------------------------------------------------ */

describe('实例锁', () => {
  it('首个实例取得锁，锁文件落在 config 下并带持有者信息', () => {
    const result = acquireInstanceLock({ root, pid: 1111 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lock.path).toBe(instanceLockPath(root));
    expect(result.lock.path).toBe(join(root, 'config', 'instance.lock'));
    expect(existsSync(result.lock.path)).toBe(true);
    expect(result.lock.tookOverStale).toBeNull();

    const written = JSON.parse(readFileSync(result.lock.path, 'utf8')) as Record<string, unknown>;
    expect(written['pid']).toBe(1111);
    expect(written['dataDir']).toBe(root);
    expect(typeof written['startedAt']).toBe('number');
    expect(typeof written['hostname']).toBe('string');

    result.lock.release();
    expect(existsSync(result.lock.path)).toBe(false);
  });

  it('config 目录不存在时自行创建', () => {
    // 锁必须在 AppStore.open() 之前取，那时候目录还没建
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const result = acquireInstanceLock({ root, pid: 1111 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(dirname(result.lock.path))).toBe(true);
      result.lock.release();
    }
  });

  it('持有者还活着时第二个实例被拒，并报出是谁占着', () => {
    const first = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(first.ok).toBe(true);

    const second = acquireInstanceLock({ root, pid: 2222, isAlive: () => true });
    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.holder?.pid).toBe(1111);
    expect(second.path).toBe(instanceLockPath(root));
    // 被拒绝的一方不能把锁文件改成自己的
    const written = JSON.parse(readFileSync(second.path, 'utf8')) as Record<string, unknown>;
    expect(written['pid']).toBe(1111);
  });

  it('持有者已死时接管过期锁，并把这件事报出来', () => {
    const first = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(first.ok).toBe(true);

    // 模拟上一次崩溃退出：锁文件留着，但进程不在了
    const second = acquireInstanceLock({ root, pid: 2222, isAlive: () => false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    /*
     * 接管要留痕。崩溃退出意味着上次可能停在半个迁移或半个编译上，而这是用户排查
     * 「上次为什么不对」时唯一的线索。
     */
    expect(second.lock.tookOverStale?.pid).toBe(1111);
    const written = JSON.parse(readFileSync(second.lock.path, 'utf8')) as Record<string, unknown>;
    expect(written['pid']).toBe(2222);
  });

  it('锁文件损坏时按过期处理而不是把目录锁死', () => {
    const path = instanceLockPath(root);
    mkdirSync(dirname(path), { recursive: true });
    // 写锁过程中断电会留下半个 JSON
    writeFileSync(path, '{"pid": 111');

    const result = acquireInstanceLock({ root, pid: 2222, isAlive: () => true });
    expect(result.ok).toBe(true);
    if (result.ok) result.lock.release();
  });

  it('同一个进程重复取锁不算冲突', () => {
    const first = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(first.ok).toBe(true);
    // 自己跟自己冲突没有意义，而重入会在「先探测再启动」这类流程里自然发生
    const again = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(again.ok).toBe(true);
  });

  it('release 只删自己的锁，不动已被接管的那一份', () => {
    const first = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 第二个实例判定 1111 已死并接管
    const second = acquireInstanceLock({ root, pid: 2222, isAlive: () => false });
    expect(second.ok).toBe(true);

    /*
     * 此时 1111 的退出钩子跑了。它不能删掉 2222 的锁——否则第三个实例能进来，
     * 于是同时有两个实例在写同一个库。退出路径上的清理恰好是最容易被执行两次的代码。
     */
    first.lock.release();
    expect(existsSync(instanceLockPath(root))).toBe(true);
    const written = JSON.parse(readFileSync(instanceLockPath(root), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written['pid']).toBe(2222);
  });

  it('release 是幂等的', () => {
    const result = acquireInstanceLock({ root, pid: 1111 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lock.release();
    result.lock.release();
    expect(existsSync(result.lock.path)).toBe(false);
  });

  it('默认的存活判断认得当前进程', () => {
    // 不注入 isAlive 时用 process.kill(pid, 0)。本进程一定活着
    const first = acquireInstanceLock({ root, pid: process.pid });
    expect(first.ok).toBe(true);
    const second = acquireInstanceLock({ root, pid: process.pid + 100000 });
    // 本进程持有锁且确实存活，因此另一个 pid 必须被拒
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder?.pid).toBe(process.pid);
    if (first.ok) first.lock.release();
  });

  it('冲突说明同时给出持有者、锁文件路径与并行办法', () => {
    const first = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
    expect(first.ok).toBe(true);
    const second = acquireInstanceLock({ root, pid: 2222, isAlive: () => true });
    expect(second.ok).toBe(false);
    if (second.ok) return;

    const message = describeLockConflict(second);
    // 是谁占着
    expect(message).toContain('1111');
    // 锁文件在哪——用户需要能自己确认并删掉
    expect(message).toContain(instanceLockPath(root));
    // 怎么并行。少了这条，用户会以为平台不支持同时开两个
    expect(message).toContain('L_SCIENCE_DATA_DIR');
  });

  it('不同数据目录互不干扰', () => {
    const other = mkdtempSync(join(tmpdir(), 'lsci-inst2-'));
    try {
      const a = acquireInstanceLock({ root, pid: 1111, isAlive: () => true });
      const b = acquireInstanceLock({ root: other, pid: 2222, isAlive: () => true });
      // 这就是需求 20.4.2 的「多实例并行」：换个数据目录即可
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok) a.lock.release();
      if (b.ok) b.lock.release();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 退出码约定
 * ------------------------------------------------------------------ */

describe('退出码约定', () => {
  it('外壳里写死的退出码与控制面导出的一致', () => {
    /*
     * 外壳刻意不 import @l-science/core（AD-1：core 带 better-sqlite3 这类原生模块，
     * 跑在独立的系统 Node 进程里），因此那个常量只能写字面量。两边分叉的表现是「数据
     * 目录被占用」这种可自行解决的失败退化成一句「后端未就绪」。
     */
    const main = readFileSync('packages/shell/src/main.ts', 'utf8');
    const match = /BACKEND_EXIT_DATA_DIR_LOCKED = (\d+)/u.exec(main);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(INSTANCE_LOCK_EXIT_CODE);
  });

  it('外壳按数据目录分离 userData，否则单实例锁会挡掉多实例', () => {
    const main = readFileSync('packages/shell/src/main.ts', 'utf8');
    // setPath 必须在真正那次调用之前：锁文件就放在 userData 里。
    // 匹配调用点而不是裸名字——注释里也会提到它
    const setPathAt = main.indexOf("app.setPath('userData'");
    const lockAt = main.indexOf('if (!app.requestSingleInstanceLock())');
    expect(setPathAt).toBeGreaterThan(0);
    expect(lockAt).toBeGreaterThan(setPathAt);
    expect(main).toContain('L_SCIENCE_DATA_DIR');
  });

  it('开发端口可以覆盖，且 dev server 地址由 UI 端口推出', () => {
    // 两个固定端口是「不同数据目录也仍然冲突」的最后两处（需求 20.4.2）
    expect(readFileSync('packages/ui/vite.config.ts', 'utf8')).toContain('L_SCIENCE_UI_PORT');
    const devShell = readFileSync('scripts/dev-shell.mjs', 'utf8');
    expect(devShell).toContain('L_SCIENCE_UI_PORT');
    expect(devShell).toContain('L_SCIENCE_CDP_PORT');
    // 端口与地址各自写死的话，改了端口忘了改地址的表现是窗口一片空白
    expect(devShell).toContain('${uiPort}');
  });
});
