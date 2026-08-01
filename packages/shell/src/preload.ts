/**
 * Preload 脚本。渲染层唯一的能力入口。
 *
 * 只暴露窄接口，绝不暴露 `ipcRenderer` 本身——否则渲染层可以往任意通道发消息，
 * contextIsolation 带来的隔离就名存实亡了。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const IPC_INVOKE = 'lscience:invoke';
const IPC_EVENT = 'lscience:event';
const IPC_LOG = 'lscience:log';

export interface BackendEvent {
  /** 关联的请求 id；广播事件为 null。 */
  id: string | null;
  payload: unknown;
}

/** 取消订阅函数。渲染层组件卸载时必须调用，否则会累积监听器。 */
export type Unsubscribe = () => void;

const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /**
   * 调用后端方法。参数结构由 @l-science/shared 的 Request 类型约定，
   * 主进程会在转发前再校验一遍。
   */
  invoke(request: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC_INVOKE, request) as Promise<unknown>;
  },

  onEvent(listener: (event: BackendEvent) => void): Unsubscribe {
    const wrapped = (_e: IpcRendererEvent, payload: BackendEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_EVENT, wrapped);
    return () => {
      ipcRenderer.off(IPC_EVENT, wrapped);
    };
  },

  onLog(listener: (line: string) => void): Unsubscribe {
    const wrapped = (_e: IpcRendererEvent, line: string): void => {
      listener(line);
    };
    ipcRenderer.on(IPC_LOG, wrapped);
    return () => {
      ipcRenderer.off(IPC_LOG, wrapped);
    };
  },
} as const;

export type LScienceApi = typeof api;

contextBridge.exposeInMainWorld('lscience', api);
