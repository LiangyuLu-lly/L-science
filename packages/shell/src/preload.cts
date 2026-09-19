/**
 * Preload 脚本。渲染层唯一的能力入口。
 *
 * 为什么是 `.cts` 而不是 `.ts`：Electron 在 `sandbox: true` 下的 preload 必须是
 * CommonJS。shell 包整体是 ESM（`"type": "module"`），编出的 `.js` 会带 ESM
 * `import`，沙箱化的 preload 加载器直接报
 * `SyntaxError: Cannot use import statement outside a module` 并静默放弃加载——
 * 表现是窗口正常打开但 `window.lscience` 不存在，功能全废却没有任何显式报错。
 * `.cts` 让 tsc 产出 `preload.cjs`，同时保住 sandbox 带来的 OS 级隔离。
 *
 * 只暴露窄接口，绝不暴露 `ipcRenderer` 本身——否则渲染层可以往任意通道发消息，
 * contextIsolation 带来的隔离就名存实亡了。
 */

import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

const IPC_INVOKE = 'lscience:invoke';
const IPC_EVENT = 'lscience:event';
const IPC_LOG = 'lscience:log';
const IPC_SHELL = 'lscience:shell';

export interface BackendEvent {
  /** 关联的请求 id；广播事件为 null。 */
  id: string | null;
  payload: unknown;
}

/** 取消订阅函数。渲染层组件卸载时必须调用，否则会累积监听器。 */
export type Unsubscribe = () => void;

const api = {
  versions: {
    // 沙箱 preload 里的 process 是受限的 polyfill，字段可能缺失，给默认值兜底。
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },

  /**
   * 调用后端方法。参数结构由 @l-science/shared 的 Request 类型约定，
   * 主进程会在转发前再校验一遍。
   */
  invoke(request: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC_INVOKE, request) as Promise<unknown>;
  },

  onEvent(listener: (event: BackendEvent) => void): Unsubscribe {
    const wrapped = (_e: electron.IpcRendererEvent, payload: BackendEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_EVENT, wrapped);
    return () => {
      ipcRenderer.off(IPC_EVENT, wrapped);
    };
  },

  onLog(listener: (line: string) => void): Unsubscribe {
    const wrapped = (_e: electron.IpcRendererEvent, line: string): void => {
      listener(line);
    };
    ipcRenderer.on(IPC_LOG, wrapped);
    return () => {
      ipcRenderer.off(IPC_LOG, wrapped);
    };
  },

  exportDiagnostics(): Promise<void> {
    return ipcRenderer.invoke(IPC_SHELL, 'export-diagnostics') as Promise<void>;
  },

  checkUpdates(): Promise<void> {
    return ipcRenderer.invoke(IPC_SHELL, 'check-updates') as Promise<void>;
  },

  getReleasesUrl(): Promise<string> {
    return ipcRenderer.invoke(IPC_SHELL, 'get-releases-url') as Promise<string>;
  },

  setReleasesUrl(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC_SHELL, 'set-releases-url', url) as Promise<void>;
  },

  revealPath(path: string): Promise<void> {
    return ipcRenderer.invoke(IPC_SHELL, 'reveal-path', path) as Promise<void>;
  },
} as const;

export type LScienceApi = typeof api;

contextBridge.exposeInMainWorld('lscience', api);
