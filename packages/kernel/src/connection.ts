/**
 * 内核连接信息与连接文件。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

import type { SignatureScheme } from './protocol.js';

/**
 * Jupyter 连接文件结构。字段名必须与规范完全一致（snake_case），不能改成
 * camelCase——内核直接按这些名字读。
 */
export interface ConnectionInfo {
  transport: 'tcp';
  ip: string;
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  key: string;
  signature_scheme: SignatureScheme;
  kernel_name: string;
}

/** 找一个当前空闲的 TCP 端口。让操作系统分配，避免自己维护端口池。 */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close(() => reject(new Error('无法从监听套接字获取端口号')));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 生成一份新的连接信息。
 *
 * 绑定在 127.0.0.1：Jupyter 内核通道没有传输层加密，只有 HMAC 消息签名，
 * 因此绝不能监听在对外可达的地址上。
 */
export async function createConnectionInfo(kernelName: string): Promise<ConnectionInfo> {
  const ip = '127.0.0.1';
  const ports = await Promise.all([
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
    findFreePort(ip),
  ]);
  const [shell, iopub, stdin, control, hb] = ports as [number, number, number, number, number];

  return {
    transport: 'tcp',
    ip,
    shell_port: shell,
    iopub_port: iopub,
    stdin_port: stdin,
    control_port: control,
    hb_port: hb,
    key: randomUUID(),
    signature_scheme: 'hmac-sha256',
    kernel_name: kernelName,
  };
}

/**
 * 端口分配到内核实际绑定之间有一段窗口，期间端口可能被别的进程抢走。
 * 探测重试时重新分配端口，而不是死等同一组。
 */
export function writeConnectionFile(path: string, info: ConnectionInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  // 连接文件里含 HMAC key，权限应尽量收紧。Windows 上 mode 基本无效，
  // 真正的防线是它落在用户私有的 LOCALAPPDATA 下。
  writeFileSync(path, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function removeConnectionFile(path: string): void {
  rmSync(path, { force: true });
}

export function endpoint(
  info: ConnectionInfo,
  channel: 'shell' | 'iopub' | 'stdin' | 'control' | 'hb',
): string {
  const port = {
    shell: info.shell_port,
    iopub: info.iopub_port,
    stdin: info.stdin_port,
    control: info.control_port,
    hb: info.hb_port,
  }[channel];
  return `${info.transport}://${info.ip}:${String(port)}`;
}
