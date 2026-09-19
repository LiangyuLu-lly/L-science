/**
 * 外壳崩溃与数据目录占用的分流（A7）。
 *
 * 退出码 78 是用户能自己解决的失败（另一个实例占着数据目录），必须走已有的
 * showErrorBox。其它非 null 退出、uncaughtException、render-process-gone 走
 * 带「打开日志目录」按钮的崩溃对话框。这里扫 main.ts 源码：主进程跑在 Electron
 * 里，单测不能真的 spawn 一份。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const MAIN = readFileSync('packages/shell/src/main.ts', 'utf8');

describe('shell crash UX', () => {
  it('treats backend exit 78 as data-dir lock and any other non-null exit as crash dialog', () => {
    expect(MAIN).toMatch(/BACKEND_EXIT_DATA_DIR_LOCKED = 78/u);
    expect(MAIN).toContain('code === BACKEND_EXIT_DATA_DIR_LOCKED');
    expect(MAIN).toContain('showErrorBox');

    expect(MAIN).toContain('code !== null');
    expect(MAIN).toContain('showMessageBox');
    expect(MAIN).toContain('打开日志目录');
    expect(MAIN).toContain("app.getPath('userData')");
    expect(MAIN).toContain("'logs'");
    expect(MAIN).toContain('shell.openPath');
    expect(MAIN).toMatch(/\bmkdir(?:Sync)?\b/u);

    expect(MAIN).toContain('uncaughtException');
    expect(MAIN).toContain('render-process-gone');
  });

  it('crash dialog offers 导出诊断包', () => {
    expect(MAIN).toContain('导出诊断包');
    expect(MAIN).toContain('exportDiagnosticBundle');
    expect(MAIN).toContain('Compress-Archive');
    expect(MAIN).toContain('meta.json');
    expect(MAIN).not.toMatch(/sentry/iu);
  });

  it('help menu can check updates without auto-install', () => {
    expect(MAIN).toContain('检查更新');
    expect(MAIN).toContain('尚未配置发布地址');
    expect(MAIN).toContain('shell.openExternal');
    expect(MAIN).toContain('releases-url.txt');
    expect(MAIN).toContain('卸载安装包不会删除本机数据目录。');
  });
});
