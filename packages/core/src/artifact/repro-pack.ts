/**
 * 把制品 blob 与清单打成本地 zip。不出网。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type ReproFile = {
  readonly name: string;
  readonly src: string;
  readonly reproducible: boolean;
};

export function writeReproZip(input: {
  readonly projectId: string;
  readonly stageDir: string;
  readonly zipPath: string;
  readonly files: readonly ReproFile[];
}): { readonly fileCount: number; readonly irreproducible: number } {
  mkdirSync(input.stageDir, { recursive: true });
  const live = input.files;
  const bad = live.filter((f) => !f.reproducible).length;
  const lines = [
    '# L-science 可复现包',
    '',
    `- 项目：${input.projectId}`,
    `- 制品数：${String(live.length)}`,
    `- 血缘不完整：${String(bad)}`,
    '',
  ];
  const used = new Set<string>();
  for (const file of live) {
    let name = basename(file.name).replace(/[<>:"|?*]/gu, '_');
    if (name === '') name = 'artifact.bin';
    let destName = name;
    let n = 1;
    while (used.has(destName)) {
      destName = `${String(n)}-${name}`;
      n += 1;
    }
    used.add(destName);
    copyFileSync(file.src, join(input.stageDir, destName));
    lines.push(`- ${destName} ${file.reproducible ? '可复现' : '血缘不完整'}`);
  }
  writeFileSync(join(input.stageDir, 'MANIFEST.md'), `${lines.join('\n')}\n`, 'utf8');

  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path ${JSON.stringify(input.stageDir)} -DestinationPath ${JSON.stringify(input.zipPath)} -Force`,
    ],
    { windowsHide: true },
  );
  return { fileCount: live.length, irreproducible: bad };
}
