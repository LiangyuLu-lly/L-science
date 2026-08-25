/**
 * 凭据库。
 *
 * 落盘为单个 DPAPI 加密文件，位于 `%LOCALAPPDATA%\L-science\credentials\vault.bin`
 * ——**在仓库之外**，因此不可能被误提交。
 *
 * 三条刻意的约束：
 *
 * 1. **值只在需要时解密，不缓存明文。** 缓存会让明文长期驻留在进程内存里，
 *    core dump 或调试器都能捞到。
 * 2. **`list()` 只返回键名，永不返回值。** UI 与日志需要知道「配了哪些供应商」，
 *    但不需要知道 key 是什么。
 * 3. **`toString`/`toJSON` 被显式覆盖。** 否则一次 `console.log(vault)` 或把它
 *    塞进错误对象就会把全部凭据打进日志。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { appPaths } from '../paths.js';
import { DpapiUnavailableError, dpapiAvailable, protect, unprotect } from './dpapi.js';

export { dpapiAvailable, DpapiUnavailableError } from './dpapi.js';

/** 文件格式版本。变更加密方案时递增，避免把旧密文当新格式解。 */
const FORMAT_VERSION = 1;

interface VaultPayload {
  version: number;
  entries: Record<string, string>;
}

export interface CredentialRef {
  /** 引用名，例如 `provider:deepseek`。存进数据库的是这个，不是 key 本身。 */
  ref: string;
}

export class CredentialVault {
  readonly path: string;
  /** 明文只在方法内部存在，不作为字段保留。 */
  #entries: Map<string, string> | null = null;

  constructor(path?: string) {
    this.path = path ?? join(appPaths().credentials, 'vault.bin');
  }

  get available(): boolean {
    return dpapiAvailable();
  }

  get exists(): boolean {
    return existsSync(this.path);
  }

  #load(): Map<string, string> {
    if (this.#entries !== null) return this.#entries;

    if (!existsSync(this.path)) {
      this.#entries = new Map();
      return this.#entries;
    }
    if (!dpapiAvailable()) throw new DpapiUnavailableError();

    const cipher = readFileSync(this.path);
    const plain = unprotect(cipher);

    let payload: VaultPayload;
    try {
      payload = JSON.parse(plain.toString('utf8')) as VaultPayload;
    } catch {
      throw new Error(`凭据库内容损坏：${this.path}。删除该文件后重新录入凭据。`);
    }
    if (payload.version !== FORMAT_VERSION) {
      throw new Error(
        `凭据库格式版本不匹配（文件 ${String(payload.version)}，当前 ${String(FORMAT_VERSION)}）`,
      );
    }

    this.#entries = new Map(Object.entries(payload.entries));
    return this.#entries;
  }

  #persist(entries: Map<string, string>): void {
    if (!dpapiAvailable()) throw new DpapiUnavailableError();

    mkdirSync(dirname(this.path), { recursive: true });
    const payload: VaultPayload = {
      version: FORMAT_VERSION,
      entries: Object.fromEntries(entries),
    };
    const cipher = protect(Buffer.from(JSON.stringify(payload), 'utf8'));

    // 先写临时文件再改名：中途崩溃不会留下半个文件把已有凭据毁掉
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, cipher, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows 上 mode 基本无效，真正的防线是它位于用户私有目录
    }
    renameSync(tmp, this.path);
  }

  /** 存入或覆盖一条凭据。 */
  set(ref: string, secret: string): void {
    if (ref.trim() === '') throw new Error('凭据引用名不能为空');
    if (secret === '') throw new Error('凭据值不能为空');
    const entries = this.#load();
    entries.set(ref, secret);
    this.#persist(entries);
  }

  /** 取出明文。调用方用完即弃，不要长期持有。 */
  get(ref: string): string | null {
    return this.#load().get(ref) ?? null;
  }

  has(ref: string): boolean {
    return this.#load().has(ref);
  }

  delete(ref: string): boolean {
    const entries = this.#load();
    const existed = entries.delete(ref);
    if (existed) this.#persist(entries);
    return existed;
  }

  /** 只返回键名。UI 与日志需要知道配了哪些供应商，不需要知道 key。 */
  list(): string[] {
    return [...this.#load().keys()].sort();
  }

  /** 供 UI 显示的脱敏摘要：只给长度与末尾四位，足以让用户确认「是这把 key」。 */
  fingerprint(ref: string): { length: number; tail: string } | null {
    const value = this.get(ref);
    if (value === null) return null;
    return { length: value.length, tail: value.slice(-4) };
  }

  /** 丢弃内存中的明文。长时间空闲后调用可缩小明文驻留窗口。 */
  lock(): void {
    this.#entries = null;
  }

  destroy(): void {
    this.#entries = null;
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  /**
   * 覆盖默认的字符串化行为。
   *
   * 不覆盖的话，一次 `console.log(vault)` 或把 vault 塞进错误对象，就会把全部
   * 凭据打进日志——这类泄漏几乎总是无意的，所以在类型层面堵住。
   */
  toString(): string {
    return `[CredentialVault ${this.path} (${String(this.#entries?.size ?? '未加载')} 条)]`;
  }

  toJSON(): Record<string, unknown> {
    return { path: this.path, entryCount: this.#entries?.size ?? null, redacted: true };
  }
}

/** 供应商凭据的引用名约定。 */
export function providerRef(providerId: string): string {
  return `provider:${providerId}`;
}
