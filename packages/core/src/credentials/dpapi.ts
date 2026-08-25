/**
 * Windows DPAPI 加解密（经 koffi FFI 调 crypt32.dll）。
 *
 * DPAPI 的密钥由操作系统派生自当前用户账户，因此密文只能被**同一 Windows 用户**
 * 在**同一台机器**上解开。这正好匹配「凭据不出本机」的要求：vault 文件即便被
 * 复制走，在别处也解不开。
 *
 * 额外绑定一段固定 entropy，使密文与「L-science 的凭据库」这个用途关联——同一
 * 用户下的其他程序即便调用 DPAPI 也无法直接解开我们的密文。这不是强边界
 * （entropy 就在源码里），但能挡住顺手一试。
 */

import { createRequire } from 'node:module';

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

/** 与用途绑定的 entropy。修改它会让已有密文全部无法解开。 */
const ENTROPY = Buffer.from('l-science.credentials.v1', 'utf8');

interface DataBlob {
  cbData: number;
  pbData: unknown;
}

interface Dpapi {
  protect(plaintext: Buffer): Buffer;
  unprotect(ciphertext: Buffer): Buffer;
}

interface Koffi {
  load(name: string): { func(signature: string): (...args: never[]) => unknown };
  struct(name: string, fields: Record<string, string>): unknown;
  array(type: string, length: number, kind: string): unknown;
  decode(value: unknown, type: unknown): unknown;
}

let cached: Dpapi | null | undefined;

function load(): Dpapi | null {
  if (process.platform !== 'win32') return null;

  try {
    const req = createRequire(import.meta.url);
    const koffi = req('koffi') as Koffi;

    // 让 koffi 负责结构体封送：DATA_BLOB 里要放指向数据的指针，
    // 手工取 Node Buffer 的地址不可靠，交给 koffi 更稳。
    koffi.struct('DATA_BLOB', { cbData: 'uint32_t', pbData: 'void *' });

    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const CryptProtectData = crypt32.func(
      'bool CryptProtectData(DATA_BLOB *in, const char16_t *desc, DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DATA_BLOB *out)',
    );
    const CryptUnprotectData = crypt32.func(
      'bool CryptUnprotectData(DATA_BLOB *in, _Out_ void *descOut, DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DATA_BLOB *out)',
    );
    const LocalFree = kernel32.func('void *LocalFree(void *h)');
    const GetLastError = kernel32.func('uint32_t GetLastError()') as () => number;

    const blob = (buf: Buffer): DataBlob => ({ cbData: buf.length, pbData: buf });

    /** 读出 DPAPI 分配的输出并释放。不 LocalFree 会每次调用泄漏一块内存。 */
    const takeOutput = (out: DataBlob): Buffer => {
      const bytes = koffi.decode(
        out.pbData,
        koffi.array('uint8_t', out.cbData, 'Array'),
      ) as number[];
      const result = Buffer.from(bytes);
      LocalFree(out.pbData as never);
      return result;
    };

    return {
      protect(plaintext): Buffer {
        const out: DataBlob = { cbData: 0, pbData: null };
        const ok = CryptProtectData(
          blob(plaintext) as never,
          null as never,
          blob(ENTROPY) as never,
          null as never,
          null as never,
          CRYPTPROTECT_UI_FORBIDDEN as never,
          out as never,
        );
        if (ok !== true) {
          throw new Error(`CryptProtectData 失败，GetLastError=${String(GetLastError())}`);
        }
        return takeOutput(out);
      },

      unprotect(ciphertext): Buffer {
        const out: DataBlob = { cbData: 0, pbData: null };
        const ok = CryptUnprotectData(
          blob(ciphertext) as never,
          null as never,
          blob(ENTROPY) as never,
          null as never,
          null as never,
          CRYPTPROTECT_UI_FORBIDDEN as never,
          out as never,
        );
        if (ok !== true) {
          throw new Error(
            `CryptUnprotectData 失败，GetLastError=${String(GetLastError())}。` +
              '密文可能来自其他 Windows 用户或其他机器——DPAPI 的密钥绑定到用户与机器，跨环境无法解开。',
          );
        }
        return takeOutput(out);
      },
    };
  } catch {
    return null;
  }
}

function api(): Dpapi | null {
  if (cached === undefined) cached = load();
  return cached;
}

export function dpapiAvailable(): boolean {
  return api() !== null;
}

export class DpapiUnavailableError extends Error {
  constructor() {
    super(
      'DPAPI 不可用（需要 Windows 且 koffi 可加载）。' +
        '此环境下无法加密存储凭据，请勿在此保存真实 API key。',
    );
    this.name = 'DpapiUnavailableError';
  }
}

export function protect(plaintext: Buffer): Buffer {
  const a = api();
  if (a === null) throw new DpapiUnavailableError();
  return a.protect(plaintext);
}

export function unprotect(ciphertext: Buffer): Buffer {
  const a = api();
  if (a === null) throw new DpapiUnavailableError();
  return a.unprotect(ciphertext);
}
