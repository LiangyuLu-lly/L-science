/**
 * Electron 主进程。
 *
 * 职责刻意压到最小：开窗口、守护后端进程、转发 IPC。所有业务逻辑都在
 * @l-science/core 里，跑在独立的系统 Node 进程中（AD-1）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** Vite 开发服务器地址。未设置时按生产模式加载打包后的静态文件。 */
const DEV_SERVER_URL = process.env['L_SCIENCE_DEV_SERVER'];

let backend: ChildProcess | null = null;

/**
 * 启动控制平面后端。
 *
 * 用 `process.execPath` 会拿到 Electron 自己的可执行文件，那不是我们要的——
 * 后端必须跑在系统 Node 上才能确保原生模块 ABI 与开发时一致。
 * 允许用 L_SCIENCE_NODE 指定解释器路径。
 */
function startBackend(): void {
  const nodeBin = process.env['L_SCIENCE_NODE'] ?? 'node';
  const entry = join(repoRoot, 'packages', 'core', 'dist', 'backend.js');

  backend = spawn(nodeBin, [entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv,
  });

  backend.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[core] ${chunk.toString()}`);
  });
  backend.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[core:err] ${chunk.toString()}`);
  });
  backend.on('exit', (code, signal) => {
    process.stderr.write(`[core] 后端退出 code=${String(code)} signal=${String(signal)}\n`);
    backend = null;
  });
}

function stopBackend(): void {
  if (backend !== null && backend.exitCode === null) {
    backend.kill();
    backend = null;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#111318',
    title: 'L-science',
    webPreferences: {
      preload: join(here, 'preload.js'),
      // 渲染层不允许直接接触 Node：所有能力经 preload 的 contextBridge 显式暴露。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // 外部链接交给系统浏览器，不在应用内打开。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL !== undefined && DEV_SERVER_URL !== '') {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(join(repoRoot, 'packages', 'ui', 'dist', 'index.html'));
  }
}

// 单实例锁：多个实例会争抢同一个 SQLite 库与内核端口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win !== undefined) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    startBackend();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', stopBackend);
}
