/**
 * Preload 脚本。渲染层唯一的能力入口。
 *
 * 这里只暴露窄接口，不暴露 ipcRenderer 本身——否则渲染层可以对任意通道发消息，
 * contextIsolation 带来的隔离就名存实亡了。
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 应用与协议版本，用于 UI 显示与兼容性检查。 */
  versions: {
    app: process.env['npm_package_version'] ?? '0.0.0',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** 后端健康状态。M0 阶段先只有这一个通道。 */
  backendStatus(): Promise<{ ok: boolean; detail?: string }> {
    return ipcRenderer.invoke('backend:status') as Promise<{ ok: boolean; detail?: string }>;
  },
} as const;

export type LScienceApi = typeof api;

contextBridge.exposeInMainWorld('lscience', api);
