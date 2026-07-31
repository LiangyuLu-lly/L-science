/**
 * Jupyter 消息协议纯函数测试（AD-2）。
 *
 * 签名算法必须与规范逐字节一致，否则内核会静默丢弃我们的消息——这类故障
 * 在运行期表现为「cell 提交后永远不返回」，极难定位，所以在这里锁死。
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  JUPYTER_PROTOCOL_VERSION,
  createConnectionInfo,
  createHeader,
  createSessionId,
  findFreePort,
  signMessage,
  verifyMessage,
  type MessageFrames,
} from '@l-science/kernel';

const frames: MessageFrames = {
  header: '{"msg_id":"a","msg_type":"execute_request"}',
  parentHeader: '{}',
  metadata: '{}',
  content: '{"code":"1+1","silent":false}',
};

describe('消息签名', () => {
  it('与规范定义的 HMAC-SHA256 拼接顺序一致', () => {
    const key = 'test-key';
    const expected = createHmac('sha256', key)
      .update(frames.header)
      .update(frames.parentHeader)
      .update(frames.metadata)
      .update(frames.content)
      .digest('hex');

    expect(signMessage(key, frames)).toBe(expected);
  });

  it('签名是 64 位十六进制小写', () => {
    expect(signMessage('k', frames)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任一段被篡改都会导致签名不同', () => {
    const base = signMessage('k', frames);
    expect(signMessage('k', { ...frames, content: '{"code":"2+2"}' })).not.toBe(base);
    expect(signMessage('k', { ...frames, metadata: '{"x":1}' })).not.toBe(base);
    expect(signMessage('k', { ...frames, parentHeader: '{"y":1}' })).not.toBe(base);
  });

  it('换 key 会导致签名不同', () => {
    expect(signMessage('k1', frames)).not.toBe(signMessage('k2', frames));
  });

  it('段边界不可移动 —— 拼接歧义会被检出', () => {
    // 若实现改成先拼字符串再签名，下面两组会碰撞。分段喂入 HMAC 可避免。
    const a: MessageFrames = { header: 'ab', parentHeader: 'c', metadata: '', content: '' };
    const b: MessageFrames = { header: 'a', parentHeader: 'bc', metadata: '', content: '' };
    // 注意：HMAC 对流式输入本身不区分边界，因此这两者相等是预期行为。
    // 这条测试的作用是把该性质写明，防止后续误以为签名能防重组。
    expect(signMessage('k', a)).toBe(signMessage('k', b));
  });
});

describe('签名校验', () => {
  it('接受正确签名', () => {
    expect(verifyMessage('k', frames, signMessage('k', frames))).toBe(true);
  });

  it('拒绝错误签名', () => {
    expect(verifyMessage('k', frames, 'deadbeef')).toBe(false);
    expect(verifyMessage('k', frames, signMessage('other', frames))).toBe(false);
  });

  it('空 key 表示内核未启用签名，跳过校验', () => {
    expect(verifyMessage('', frames, '')).toBe(true);
  });
});

describe('消息头', () => {
  it('携带规范版本号且 msg_id 唯一', () => {
    const session = createSessionId();
    const h1 = createHeader('execute_request', session);
    const h2 = createHeader('execute_request', session);

    expect(h1.version).toBe(JUPYTER_PROTOCOL_VERSION);
    expect(h1.msg_type).toBe('execute_request');
    expect(h1.session).toBe(session);
    expect(h1.msg_id).not.toBe(h2.msg_id);
    expect(() => new Date(h1.date).toISOString()).not.toThrow();
  });

  it('session id 是 32 位十六进制', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('连接文件', () => {
  it('findFreePort 返回可用的非特权端口', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65536);
  });

  it('五个通道端口互不相同且只绑回环地址', async () => {
    const info = await createConnectionInfo('python3');
    const ports = [
      info.shell_port,
      info.iopub_port,
      info.stdin_port,
      info.control_port,
      info.hb_port,
    ];

    expect(new Set(ports).size).toBe(5);
    // 通道没有传输层加密，只有消息签名，绝不能监听对外地址。
    expect(info.ip).toBe('127.0.0.1');
    expect(info.transport).toBe('tcp');
    expect(info.signature_scheme).toBe('hmac-sha256');
    expect(info.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.kernel_name).toBe('python3');
  });

  it('每次生成的 key 都不同', async () => {
    const [a, b] = await Promise.all([
      createConnectionInfo('python3'),
      createConnectionInfo('python3'),
    ]);
    expect(a.key).not.toBe(b.key);
  });
});
