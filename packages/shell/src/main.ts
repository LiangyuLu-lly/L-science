/**
 * Electron 主进程。
 *
 * 职责刻意压到最小：开窗口、守护后端进程、在渲染层与后端之间转发消息。
 * 所有业务逻辑都在 @l-science/core 里，跑在独立的系统 Node 进程中（AD-1）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import { parseRequest, type ErrorEnvelope } from '@l-science/shared';

import { BackendClient } from './backend-client.js';
import { resolveLaunchPaths, spawnEnv } from './launch-paths.js';

/**
 * 后端因数据目录被占用而拒绝启动时的退出码。
 *
 * 与 `INSTANCE_LOCK_EXIT_CODE`（@l-science/core）必须一致。这里写字面量而不是 import：
 * 主进程刻意不依赖 core（AD-1，core 带 better-sqlite3 这类原生模块，跑在独立的系统
 * Node 进程里）。有测试守着这两个常量相等。
 */
const BACKEND_EXIT_DATA_DIR_LOCKED = 78;

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

function launchPaths() {
  return resolveLaunchPaths({
    packaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
    here,
    env: process.env,
  });
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
  const paths = launchPaths();
  const env = spawnEnv(paths, process.env);

  // 后端拒绝启动时它把原因写在 stderr，这里留着最后几行用于弹窗
  const stderrTail: string[] = [];

  backend = spawn(paths.nodeBin, [paths.backendEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: paths.sidecarCwd,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  client = new BackendClient({
    child: backend,
    onEvent: (id, payload) => {
      broadcast(IPC_EVENT, { id, payload });
    },
    onLog: (line) => {
      process.stderr.write(`[core] ${line}\n`);
      broadcast(IPC_LOG, line);
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    },
  });

  backend.on('exit', (code) => {
    backend = null;
    client = null;

    /*
     * 数据目录被占用要弹窗说明（任务 15.2，需求 20.4.2）。
     *
     * 不弹的话用户看到的是界面上一句「后端未就绪」，那条消息对「另一个实例正在用这个
     * 目录」这个原因毫无指向性——而这是唯一一种用户能自己解决的启动失败。后端为此专门
     * 用了一个退出码，正是为了让外壳能把它与「后端崩了」区分开。
     */
    if (code === BACKEND_EXIT_DATA_DIR_LOCKED) {
      const detail = stderrTail.join('\n').trim();
      dialog.showErrorBox(
        'L-science 已在运行',
        detail === '' ? '这个数据目录正被另一个实例使用。' : detail,
      );
      app.quit();
    }
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

/**
 * 把完整错误信封编进 Error 的 message。
 *
 * Electron 的 `ipcMain.handle` 只能把 Error 传回渲染层，且只保留 message。原先
 * 这里编的是 `code: message`，于是 `detail` 与 `remediation` 全部丢在这一跳——
 * 而 remediation 存在的唯一目的就是给用户看「下一步该做什么」。整个信封序列化
 * 成 JSON 并加一个哨兵前缀，渲染层据此还原；Electron 会给 message 加自己的前缀，
 * 因此必须靠哨兵定位而不是假设 JSON 从头开始。
 */
const ERROR_SENTINEL = 'L-SCIENCE-ENVELOPE ';

function encodeEnvelope(envelope: ErrorEnvelope): Error {
  return new Error(`${ERROR_SENTINEL}${JSON.stringify(envelope)}`);
}

function registerIpc(): void {
  ipcMain.handle(IPC_INVOKE, async (_event, raw: unknown): Promise<unknown> => {
    // 渲染层是不可信输入源，在主进程侧先校验一遍再转发，
    // 不把「校验」这件事整个外包给后端。
    const parsed = parseRequest(raw);
    if (!parsed.ok) {
      throw encodeEnvelope(parsed.error);
    }
    if (client === null) {
      throw encodeEnvelope({
        code: 'internal',
        message: '后端未就绪',
        remediation: '稍等片刻后重试；若持续如此，请查看控制平面日志。',
      });
    }
    try {
      return await client.invoke(parsed.value);
    } catch (err) {
      const envelope = err as Partial<ErrorEnvelope>;
      throw encodeEnvelope({
        code: envelope.code ?? 'internal',
        message: envelope.message ?? String(err),
        ...(envelope.detail === undefined ? {} : { detail: envelope.detail }),
        ...(envelope.remediation === undefined ? {} : { remediation: envelope.remediation }),
      });
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
    void win.loadFile(launchPaths().rendererHtml);
  }
}

/**
 * 让单实例锁按**数据目录**分离，而不是按应用分离（任务 15.2，需求 20.4.2）。
 *
 * Electron 的 `requestSingleInstanceLock()` 没有 key 参数，它的锁文件就放在
 * `userData` 里。因此在这之前，「一台机器上只能开一个 L-science」是硬性的——即便
 * 用户给两个实例设了不同的 `L_SCIENCE_DATA_DIR`，第二个进程也会在下面那行直接退出。
 * 需求 20.4.2 要的多实例并行因此从来不成立。
 *
 * 把 `userData` 放进数据目录内之后，锁跟着数据目录走：不同数据目录各有一把锁（两个
 * 实例都能跑），同一个数据目录仍然只有一把（第二次启动聚焦已有窗口，那正是用户重复
 * 点图标时想要的行为）。
 *
 * 刻意**不**去推算默认数据目录：那要把平台适配层搬进 Electron 主进程，而主进程刻意
 * 不依赖 @l-science/core（AD-1：core 跑在独立的系统 Node 进程里，带 better-sqlite3
 * 这类原生模块）。没设环境变量时保持 Electron 的默认 userData，行为与以前一致。
 *
 * 用「目录内」而不是「路径哈希」也是刻意的：同一个目录的两种写法（`C:\x` 与 `c:/x/`）
 * 哈希不同但物理目录相同，放进目录内之后它们自然指向同一个锁文件，不需要我们自己
 * 处理路径归一化。
 */
{
  const override = process.env['L_SCIENCE_DATA_DIR'];
  if (override !== undefined && override !== '') {
    app.setPath('userData', join(resolve(override), 'electron'));
  }
}

// 单实例锁：同一个数据目录只能有一个实例，否则会争抢同一个 SQLite 库与凭据文件。
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
