/**
 * 把 micromamba 下到数据目录。安装包不带 conda；没装过 conda 的机器走这条路。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataDir } from '../paths.js';

export const MICROMAMBA_URLS = [
  'https://micro.mamba.pm/api/micromamba/win-64/latest',
  'https://github.com/mamba-org/micromamba-releases/releases/download/2.3.3-0/micromamba-win-64',
] as const;

export function micromambaRoot(): string {
  return join(dataDir(), 'micromamba');
}

export function micromambaExe(): string {
  return join(micromambaRoot(), 'micromamba.exe');
}

export async function ensureMicromamba(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const exe = micromambaExe();
  if (existsSync(exe)) return { ok: true, path: exe };

  mkdirSync(micromambaRoot(), { recursive: true });
  const errors: string[] = [];
  for (const url of MICROMAMBA_URLS) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${String(res.status)}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) {
        errors.push(`${url} → 文件过小（${String(buf.length)} 字节）`);
        continue;
      }
      writeFileSync(exe, buf);
      return { ok: true, path: exe };
    } catch (err: unknown) {
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ok: false,
    reason:
      '下载 micromamba 失败。检查网络或换镜像后重试。\n' + errors.join('\n'),
  };
}
