/**
 * Electron 主进程。
 *
 * 职责刻意压到最小：开窗口、守护后端进程、在渲染层与后端之间转发消息。
 * 所有业务逻辑都在 @l-science/core 里，跑在独立的系统 Node 进程中（AD-1）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { parseRequest, type ErrorEnvelope } from '@l-science/shared';

import { BackendClient } from './backend-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** Vite 开发服务器地址。未设置时按生产模式加载打包后的静态文件。 */
const DEV_SERVER_URL = process.env['L_SCIENCE_DEV_SERVER'];

const IPC_INVOKE = 'lscience:invoke';
const IPC_EVENT = 'lscience:event';
const IPC_LOG = 'lscience:log';

let backend: ChildProcessWithoutNullStreams | null = null;
let client: BackendClient | null = null;

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc: WebContents = win.webContents;
    if (!wc.isDestroyed()) wc.send(channel, ...args);
  }
}

/**
 * 启动控制平面后端。
 *
 * 用系统 Node 而不是 `process.execPath`：后者是 Electron 自己的可执行文件，
 * 会把后端拖进 Electron 的 Node 版本与 ABI。允许用 L_SCIENCE_NODE 覆盖解释器。
 *
 * 三个流全部用 pipe：stdin 与 stdout 是 NDJSON 协议通道，stderr 才是日志。
 * 把 stdin 设成 'ignore' 会让后端立刻收到 EOF 并自行退出。
 */
function startBackend(): void {
  const nodeBin = process.env['L_SCIENCE_NODE'] ?? 'node';
  const entry = join(repoRoot, 'packages', 'core', 'dist', 'backend.js');

  const env = { ...process.env };
  // Electron 会给子进程注入这个变量，传下去会让 node 行为异常。
  delete env['ELECTRON_RUN_AS_NODE'];

  backend = spawn(nodeBin, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }) as ChildProcessWithoutNullStreams;

  client = new BackendClient({
    child: backend,
    onEvent: (id, payload) => {
      broadcast(IPC_EVENT, { id, payload });
    },
    onLog: (line) => {
      process.stderr.write(`[core] ${line}\n`);
      broadcast(IPC_LOG, line);
    },
  });

  backend.on('exit', () => {
    backend = null;
    client = null;
  });
}

function stopBackend(): void {
  client?.close();
  client = null;
  if (backend !== null && backend.exitCode === null) {
    // close() 已合上 stdin 让后端优雅退出；留一手兜底强杀。
    const child = backend;
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500);
  }
  backend = null;
}

function registerIpc(): void {
  ipcMain.handle(IPC_INVOKE, async (_event, raw: unknown): Promise<unknown> => {
    // 渲染层是不可信输入源，在主进程侧先校验一遍再转发，
    // 不把「校验」这件事整个外包给后端。
    const parsed = parseRequest(raw);
    if (!parsed.ok) {
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    }
    if (client === null) {
      throw new Error('internal: 后端未就绪');
    }
    try {
      return await client.invoke(parsed.value);
    } catch (err) {
      const envelope = err as Partial<ErrorEnvelope>;
      const code = envelope.code ?? 'internal';
      const message = envelope.message ?? String(err);
      // Electron 的 invoke 只能传递 Error，把错误码编进 message 以便渲染层还原。
      throw new Error(`${code}: ${message}`);
    }
  });
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
      // 必须是 .cjs：sandbox 下的 preload 只能是 CommonJS，源文件为 preload.cts
      preload: join(here, 'preload.cjs'),
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
    registerIpc();
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
