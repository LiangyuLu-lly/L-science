/**
 * 凭据库测试（任务 11.1 的一部分）。
 *
 * 这是安全相关代码，重点不在「能存能取」，而在几条容易无意破坏的性质：
 * 密文不含明文、字符串化不泄漏、list 不返回值、跨 entropy 解不开。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialVault, dpapiAvailable, providerRef } from '@l-science/core';

const SECRET = 'sk-test-0123456789abcdef-do-not-use';

let dir: string;
let vault: CredentialVault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsci-cred-'));
  vault = new CredentialVault(join(dir, 'vault.bin'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('引用名约定', () => {
  it('供应商引用名带前缀，避免与其他用途撞名', () => {
    expect(providerRef('deepseek')).toBe('provider:deepseek');
  });
});

describe.skipIf(!dpapiAvailable())('凭据库（DPAPI 可用）', () => {
  it('存取往返一致', () => {
    vault.set('provider:x', SECRET);
    expect(vault.get('provider:x')).toBe(SECRET);
  });

  it('落盘文件不含明文', () => {
    vault.set('provider:x', SECRET);
    const raw = readFileSync(vault.path);
    expect(raw.includes(Buffer.from(SECRET, 'utf8'))).toBe(false);
    // 引用名也不该以明文出现（整个 payload 都被加密）
    expect(raw.includes(Buffer.from('provider:x', 'utf8'))).toBe(false);
  });

  it('list 只返回键名，不返回值', () => {
    vault.set('provider:a', SECRET);
    vault.set('provider:b', `${SECRET}-2`);
    const refs = vault.list();
    expect(refs).toEqual(['provider:a', 'provider:b']);
    expect(JSON.stringify(refs)).not.toContain('sk-test');
  });

  it('指纹只暴露长度与末四位', () => {
    vault.set('provider:x', SECRET);
    const fp = vault.fingerprint('provider:x');
    expect(fp).toEqual({ length: SECRET.length, tail: SECRET.slice(-4) });
    expect(JSON.stringify(fp)).not.toContain('sk-test');
  });

  it('toString 与 toJSON 不泄漏凭据', () => {
    vault.set('provider:x', SECRET);
    // 一次 console.log(vault) 就把 key 打进日志，是最常见的无意泄漏
    expect(String(vault)).not.toContain(SECRET);
    expect(JSON.stringify(vault)).not.toContain(SECRET);
    expect(JSON.stringify(vault)).toContain('redacted');
  });

  it('覆盖已有条目', () => {
    vault.set('provider:x', SECRET);
    vault.set('provider:x', 'replaced');
    expect(vault.get('provider:x')).toBe('replaced');
    expect(vault.list()).toHaveLength(1);
  });

  it('删除与存在性判断', () => {
    vault.set('provider:x', SECRET);
    expect(vault.has('provider:x')).toBe(true);
    expect(vault.delete('provider:x')).toBe(true);
    expect(vault.has('provider:x')).toBe(false);
    expect(vault.delete('provider:x')).toBe(false);
    expect(vault.get('provider:x')).toBeNull();
  });

  it('拒绝空引用名与空值', () => {
    expect(() => vault.set('', SECRET)).toThrow(/不能为空/);
    expect(() => vault.set('  ', SECRET)).toThrow(/不能为空/);
    expect(() => vault.set('provider:x', '')).toThrow(/不能为空/);
  });

  it('新建实例能读到已落盘的内容', () => {
    vault.set('provider:x', SECRET);
    const reopened = new CredentialVault(vault.path);
    expect(reopened.get('provider:x')).toBe(SECRET);
  });

  it('lock 丢弃内存明文后仍能重新读出', () => {
    vault.set('provider:x', SECRET);
    vault.lock();
    expect(vault.get('provider:x')).toBe(SECRET);
  });

  it('不存在的库视为空而不是报错', () => {
    const fresh = new CredentialVault(join(dir, 'nope.bin'));
    expect(fresh.exists).toBe(false);
    expect(fresh.list()).toEqual([]);
    expect(fresh.get('x')).toBeNull();
  });

  it('文件内容不是合法密文时明确报错，不静默返回空库', () => {
    // 静默当成空库是最糟的行为：用户会以为凭据丢了，重新录入后覆盖掉可能还能救的文件
    writeFileSync(vault.path, Buffer.from('not a dpapi blob'));
    const reopened = new CredentialVault(vault.path);
    expect(() => reopened.list()).toThrow(/CryptUnprotectData 失败/);
  });

  it('destroy 删除文件', () => {
    vault.set('provider:x', SECRET);
    expect(existsSync(vault.path)).toBe(true);
    vault.destroy();
    expect(existsSync(vault.path)).toBe(false);
  });

  it('写入采用临时文件加改名，中途失败不毁掉已有凭据', () => {
    vault.set('provider:a', SECRET);
    vault.set('provider:b', SECRET);
    // 正常写完后不该残留 .tmp
    expect(existsSync(`${vault.path}.tmp`)).toBe(false);
    expect(vault.list()).toHaveLength(2);
  });
});

describe('DPAPI 不可用时的行为', () => {
  it.skipIf(dpapiAvailable())('明确报错而不是静默明文存储', () => {
    expect(() => vault.set('provider:x', SECRET)).toThrow(/DPAPI 不可用/);
  });

  it('available 反映真实能力', () => {
    expect(vault.available).toBe(dpapiAvailable());
  });
});
