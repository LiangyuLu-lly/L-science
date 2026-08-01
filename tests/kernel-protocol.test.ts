/**
 * Jupyter 协议编解码测试（任务 4.1）。
 *
 * 签名算法必须与规范逐字节一致，否则内核会静默丢弃我们的消息——这类故障在
 * 运行期表现为「cell 提交后永远不返回」，极难定位，所以在这里锁死。
 *
 * 另一个重点是「校验必须用原始字节」：先 JSON.parse 再 stringify 去算签名，
 * 键序或空白的任何差异都会让校验失败。
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  JUPYTER_PROTOCOL_VERSION,
  ProtocolError,
  SIGNATURE_DELIMITER,
  createConnectionInfo,
  createHeader,
  createSessionId,
  decodeMessage,
  encodeMessage,
  endpoint,
  findFreePort,
  signParts,
  toKernelOutput,
  verifySignature,
  type DecodedMessage,
} from '@l-science/kernel';

const KEY = 'test-key';

function buildMessage(overrides: Partial<Record<string, unknown>> = {}): Buffer[] {
  return encodeMessage({
    key: KEY,
    header: createHeader('execute_request', 'sess-1'),
    content: { code: '1+1', silent: false, ...overrides },
  });
}

describe('签名', () => {
  it('与规范定义的分段拼接顺序一致', () => {
    const header = Buffer.from('{"a":1}');
    const parent = Buffer.from('{}');
    const meta = Buffer.from('{}');
    const content = Buffer.from('{"code":"1+1"}');

    const expected = createHmac('sha256', KEY)
      .update(header)
      .update(parent)
      .update(meta)
      .update(content)
      .digest('hex');

    expect(signParts(KEY, [header, parent, meta, content])).toBe(expected);
  });

  it('输出 64 位十六进制小写', () => {
    expect(signParts(KEY, [Buffer.from('x')])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('换 key 得到不同签名', () => {
    const parts = [Buffer.from('a'), Buffer.from('b')];
    expect(signParts('k1', parts)).not.toBe(signParts('k2', parts));
  });

  it('校验通过与失败', () => {
    const parts = [Buffer.from('a'), Buffer.from('b')];
    const sig = signParts(KEY, parts);
    expect(verifySignature(KEY, parts, sig)).toBe(true);
    expect(verifySignature(KEY, parts, 'deadbeef')).toBe(false);
    expect(verifySignature('other', parts, sig)).toBe(false);
  });

  it('空 key 表示内核未启用签名，跳过校验', () => {
    expect(verifySignature('', [Buffer.from('x')], '')).toBe(true);
  });
});

describe('编码', () => {
  it('产出规范要求的分段顺序', () => {
    const parts = buildMessage();
    expect(parts[0]?.toString()).toBe(SIGNATURE_DELIMITER);
    expect(parts[1]?.toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(parts[2]?.toString() ?? '{}')).toMatchObject({
      msg_type: 'execute_request',
      version: JUPYTER_PROTOCOL_VERSION,
    });
    expect(parts[3]?.toString()).toBe('{}');
    expect(parts[4]?.toString()).toBe('{}');
    expect(JSON.parse(parts[5]?.toString() ?? '{}')).toMatchObject({ code: '1+1' });
  });

  it('携带二进制 buffers 时附在末尾', () => {
    const parts = encodeMessage({
      key: KEY,
      header: createHeader('execute_request', 's'),
      buffers: [Buffer.from([1, 2, 3])],
    });
    expect(parts).toHaveLength(7);
    expect(parts[6]).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('解码', () => {
  it('往返等价且签名有效', () => {
    const decoded = decodeMessage(buildMessage(), KEY);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.header.msg_type).toBe('execute_request');
    expect(decoded.content['code']).toBe('1+1');
  });

  it('忽略分隔符之前的分段（iopub 的 topic 前缀）', () => {
    const parts = buildMessage();
    const withTopic = [Buffer.from('kernel.abc.status'), ...parts];
    const decoded = decodeMessage(withTopic, KEY);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.header.msg_type).toBe('execute_request');
  });

  it('忽略 DEALER 的 routing id 前缀', () => {
    const parts = buildMessage();
    const withRouting = [Buffer.from([0xde, 0xad]), Buffer.from(''), ...parts];
    expect(decodeMessage(withRouting, KEY).signatureValid).toBe(true);
  });

  it('内容被篡改时签名校验失败但仍能解析', () => {
    const parts = buildMessage();
    parts[5] = Buffer.from(JSON.stringify({ code: 'os.system("rm -rf /")' }), 'utf8');

    const decoded = decodeMessage(parts, KEY);
    // 关键：不是抛异常，而是标记为无效交由调用方丢弃
    expect(decoded.signatureValid).toBe(false);
    expect(decoded.content['code']).toContain('rm -rf');
  });

  it('用错 key 时校验失败', () => {
    expect(decodeMessage(buildMessage(), 'wrong-key').signatureValid).toBe(false);
  });

  it('校验用的是原始字节而非重序列化结果', () => {
    // 手工构造一段键序与 JSON.stringify 不同、但语义相同的 content
    const header = Buffer.from(JSON.stringify(createHeader('execute_request', 's')), 'utf8');
    const parent = Buffer.from('{}', 'utf8');
    const meta = Buffer.from('{}', 'utf8');
    const content = Buffer.from('{ "silent" : false ,  "code" : "1+1" }', 'utf8');
    const sig = signParts(KEY, [header, parent, meta, content]);

    const parts = [
      Buffer.from(SIGNATURE_DELIMITER),
      Buffer.from(sig),
      header,
      parent,
      meta,
      content,
    ];

    // 若实现改成解析后重新序列化再签名，这条会失败
    expect(decodeMessage(parts, KEY).signatureValid).toBe(true);
  });

  it('缺少分隔符时抛 ProtocolError', () => {
    expect(() => decodeMessage([Buffer.from('nonsense')], KEY)).toThrow(ProtocolError);
  });

  it('分段不足时抛 ProtocolError', () => {
    expect(() =>
      decodeMessage([Buffer.from(SIGNATURE_DELIMITER), Buffer.from('sig')], KEY),
    ).toThrow(ProtocolError);
  });

  it('header 非 JSON 时抛 ProtocolError', () => {
    const parts = buildMessage();
    parts[2] = Buffer.from('not json');
    expect(() => decodeMessage(parts, KEY)).toThrow(ProtocolError);
  });

  it('header 缺 msg_type 时抛 ProtocolError', () => {
    const parts = buildMessage();
    parts[2] = Buffer.from(JSON.stringify({ msg_id: 'x' }));
    expect(() => decodeMessage(parts, KEY)).toThrow(ProtocolError);
  });
});

describe('消息头', () => {
  it('携带规范版本且 msg_id 唯一', () => {
    const session = createSessionId();
    const a = createHeader('execute_request', session);
    const b = createHeader('execute_request', session);
    expect(a.version).toBe(JUPYTER_PROTOCOL_VERSION);
    expect(a.session).toBe(session);
    expect(a.msg_id).not.toBe(b.msg_id);
    expect(() => new Date(a.date).toISOString()).not.toThrow();
  });

  it('session id 是 32 位十六进制', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('连接信息', () => {
  it('findFreePort 返回可用的非特权端口', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65536);
  });

  it('五个通道端口互不相同且只绑回环', async () => {
    const info = await createConnectionInfo('python3');
    const ports = [
      info.shell_port,
      info.iopub_port,
      info.stdin_port,
      info.control_port,
      info.hb_port,
    ];
    expect(new Set(ports).size).toBe(5);
    // 通道没有传输层加密，只有消息签名，绝不能监听对外地址
    expect(info.ip).toBe('127.0.0.1');
    expect(info.transport).toBe('tcp');
    expect(info.signature_scheme).toBe('hmac-sha256');
    expect(info.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('每次生成的 key 都不同', async () => {
    const [a, b] = await Promise.all([createConnectionInfo('x'), createConnectionInfo('x')]);
    expect(a.key).not.toBe(b.key);
  });

  it('endpoint 拼出 tcp 地址', async () => {
    const info = await createConnectionInfo('x');
    expect(endpoint(info, 'shell')).toBe(`tcp://127.0.0.1:${String(info.shell_port)}`);
    expect(endpoint(info, 'hb')).toBe(`tcp://127.0.0.1:${String(info.hb_port)}`);
  });
});

/* ------------------------------------------------------------------ *
 * 输出归一化
 * ------------------------------------------------------------------ */

function fakeMsg(msgType: string, content: Record<string, unknown>): DecodedMessage {
  return {
    header: {
      msg_id: 'x',
      session: 's',
      username: 'u',
      date: new Date().toISOString(),
      msg_type: msgType as DecodedMessage['header']['msg_type'],
      version: '5.3',
    },
    parentHeader: {},
    metadata: {},
    content,
    buffers: [],
    signatureValid: true,
  };
}

describe('输出归一化', () => {
  it('stream 区分 stdout 与 stderr', () => {
    expect(toKernelOutput(fakeMsg('stream', { name: 'stderr', text: 'boom' }))).toEqual({
      type: 'stream',
      name: 'stderr',
      text: 'boom',
    });
    // 未知的 name 归到 stdout 而不是丢弃
    expect(toKernelOutput(fakeMsg('stream', { name: '???', text: 'x' }))).toMatchObject({
      name: 'stdout',
    });
  });

  it('execute_result 保留多 MIME 束与执行序号', () => {
    const out = toKernelOutput(
      fakeMsg('execute_result', {
        data: { 'text/plain': 'a', 'text/html': '<b>a</b>' },
        execution_count: 3,
      }),
    );
    expect(out).toMatchObject({ type: 'execute_result', executionCount: 3 });
    expect(Object.keys((out as { data: Record<string, unknown> }).data)).toEqual([
      'text/plain',
      'text/html',
    ]);
  });

  it('display_data 与 update_display_data 分开归类', () => {
    expect(toKernelOutput(fakeMsg('display_data', { data: {} }))?.type).toBe('display_data');
    expect(toKernelOutput(fakeMsg('update_display_data', { data: {} }))?.type).toBe(
      'update_display_data',
    );
  });

  it('error 归一化为结构化三元组', () => {
    expect(
      toKernelOutput(
        fakeMsg('error', {
          ename: 'ZeroDivisionError',
          evalue: 'division by zero',
          traceback: ['a', 'b'],
        }),
      ),
    ).toEqual({
      type: 'error',
      ename: 'ZeroDivisionError',
      evalue: 'division by zero',
      traceback: ['a', 'b'],
    });
  });

  it('error 缺字段时给出可用默认值', () => {
    expect(toKernelOutput(fakeMsg('error', {}))).toEqual({
      type: 'error',
      ename: 'Error',
      evalue: '',
      traceback: [],
    });
  });

  it('status 只接受三种合法状态', () => {
    expect(toKernelOutput(fakeMsg('status', { execution_state: 'idle' }))).toEqual({
      type: 'status',
      state: 'idle',
    });
    expect(toKernelOutput(fakeMsg('status', { execution_state: '???' }))).toBeNull();
  });

  it('comm 类消息属于 widget 协议，M1 忽略', () => {
    expect(toKernelOutput(fakeMsg('comm_open', {}))).toBeNull();
    expect(toKernelOutput(fakeMsg('comm_msg', {}))).toBeNull();
  });

  it('data 非对象时归一化为空束而不是崩溃', () => {
    expect(toKernelOutput(fakeMsg('display_data', { data: 'oops' }))).toEqual({
      type: 'display_data',
      data: {},
    });
  });
});
