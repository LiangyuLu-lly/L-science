/**
 * electron-builder NSIS 配置契约。
 *
 * 安装包只从 extraResources 带三棵树（vendor Node、sidecar 预构建、内置技能）。
 * 仓库根 node_modules、linux-x64、conda 都不能进包；原生模块不进 shell asar。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  sidecarApp,
  sidecarStage,
  skillsBuiltin,
  vendorNode,
} from '../scripts/lib/pack-layout.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const shellPkg = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'shell', 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  build?: {
    appId?: string;
    productName?: string;
    artifactName?: string;
    asar?: boolean;
    npmRebuild?: boolean;
    directories?: { output?: string };
    files?: unknown;
    extraResources?: Array<{ from?: string; to?: string }>;
    extraFiles?: unknown;
    win?: { target?: unknown; signAndEditExecutable?: boolean; icon?: string };
    nsis?: {
      oneClick?: boolean;
      perMachine?: boolean;
      allowToChangeInstallationDirectory?: boolean;
      installerIcon?: string;
      uninstallerIcon?: string;
    };
    mac?: unknown;
    linux?: unknown;
    publish?: unknown;
  };
};

describe('shell package.json build', () => {
  it('keeps production dependencies as only @l-science/shared', () => {
    expect(Object.keys(shellPkg.dependencies ?? {})).toEqual(['@l-science/shared']);
  });

  it('pins electron-builder 26.15.3', () => {
    expect(shellPkg.devDependencies?.['electron-builder']).toBe('26.15.3');
  });

  it('exposes pack:win as electron-builder --win nsis', () => {
    expect(shellPkg.scripts?.['pack:win']).toBe('electron-builder --win nsis');
  });

  it('sets appId, productName, artifactName, asar, and output dir', () => {
    expect(shellPkg.build?.appId).toBe('app.l-science.desktop');
    expect(shellPkg.build?.productName).toBe('L-science');
    expect(shellPkg.build?.artifactName).toBe('L-science-Setup-${version}.exe');
    expect(shellPkg.build?.asar).toBe(true);
    expect(shellPkg.build?.directories?.output).toBe('../../release/win');
  });

  it('disables npmRebuild so Electron ABI is not forced onto sidecar natives', () => {
    expect(shellPkg.build?.npmRebuild).toBe(false);
  });

  it('packs only shell dist and the ui renderer, not repo node_modules', () => {
    expect(shellPkg.build?.files).toEqual(['dist/**/*', { from: '../ui/dist', to: 'renderer' }]);
    const dumped = JSON.stringify(shellPkg.build?.files);
    expect(dumped).not.toContain('node_modules');
    expect(dumped).not.toContain('linux-x64');
    expect(dumped).not.toContain('conda');
  });

  it('copies extraResources from vendor node.exe, sidecar-stage, and resources/skills/builtin', () => {
    const extra = shellPkg.build?.extraResources ?? [];
    expect(extra.map((item) => item.from)).toEqual([
      `../../${vendorNode}/node.exe`,
      `../../${sidecarStage}`,
      `../../${sidecarStage}/node_modules`,
      '../../resources/skills/builtin',
    ]);
    expect(extra.map((item) => item.to)).toEqual([
      'node/node.exe',
      sidecarApp,
      `${sidecarApp}/node_modules`,
      skillsBuiltin,
    ]);
    for (const item of extra) {
      expect(item.from).not.toBe('../../node_modules');
      expect(item.from).not.toContain('linux-x64');
      expect(item.from).not.toContain('conda');
    }
    const moduleFrom = extra.find((item) => item.to === `${sidecarApp}/node_modules`)?.from;
    expect(moduleFrom).toBe(`../../${sidecarStage}/node_modules`);
  });

  it('targets unsigned NSIS only, with a directory-picking per-user installer', () => {
    expect(shellPkg.build?.win?.target).toBe('nsis');
    expect(shellPkg.build?.win?.signAndEditExecutable).toBe(false);
    expect(shellPkg.build?.nsis?.oneClick).toBe(false);
    expect(shellPkg.build?.nsis?.perMachine).toBe(false);
    expect(shellPkg.build?.nsis?.allowToChangeInstallationDirectory).toBe(true);
  });

  it('declares a win/nsis icon under packages/shell/build/icon.ico', () => {
    expect(shellPkg.build?.win?.icon).toBe('build/icon.ico');
    expect(shellPkg.build?.nsis?.installerIcon).toBe('build/icon.ico');
    expect(shellPkg.build?.nsis?.uninstallerIcon).toBe('build/icon.ico');
  });

  it('does not declare extraFiles, mac/linux targets, or auto-update publish', () => {
    expect(shellPkg.build).not.toHaveProperty('extraFiles');
    expect(shellPkg.build).not.toHaveProperty('mac');
    expect(shellPkg.build).not.toHaveProperty('linux');
    expect(shellPkg.build).not.toHaveProperty('publish');
  });
});
