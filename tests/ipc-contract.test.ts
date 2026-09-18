/**
 * IPC 契约测试（任务 2.1）。
 *
 * 这条通道是不可信输入的入口，所以重点不是「合法载荷能通过」，而是
 * 「非法载荷被拒且错误码正确」，以及「不可重试的错误码不会被误判为可重试」。
 */

import { describe, expect, it } from 'vitest';

import {
  IPC_PROTOCOL_VERSION,
  errResponse,
  eventFrame,
  isRetryable,
  makeError,
  okResponse,
  parseFrame,
  parseRequest,
  requestFrame,
  type ErrorCode,
} from '@l-science/shared';

describe('错误信封', () => {
  it('内容安全拒答与策略拒绝永不可重试', () => {
    expect(isRetryable('content_filtered')).toBe(false);
    expect(isRetryable('policy_denied')).toBe(false);
  });

  it('沙箱拒绝与参数错误不可重试', () => {
    expect(isRetryable('sandbox_denied')).toBe(false);
    expect(isRetryable('bad_request')).toBe(false);
    expect(isRetryable('not_found')).toBe(false);
    expect(isRetryable('conflict')).toBe(false);
  });

  it('供应商故障与超时可重试', () => {
    expect(isRetryable('provider_error')).toBe(true);
    expect(isRetryable('timeout')).toBe(true);
    expect(isRetryable('internal')).toBe(true);
  });

  it('makeError 省略未提供的可选字段而不是塞 undefined', () => {
    const e = makeError('internal', '出错了');
    expect(Object.keys(e)).toEqual(['code', 'message']);
  });

  it('makeError 保留 detail 与 remediation', () => {
    const e = makeError('sandbox_denied', '路径被拒', {
      detail: 'C:\\Users\\x\\.ssh\\id_rsa',
      remediation: '改用项目工作区内的路径',
    });
    expect(e.detail).toContain('.ssh');
    expect(e.remediation).toBeDefined();
  });
});

describe('帧解析', () => {
  it('接受合法请求帧', () => {
    const frame = requestFrame('r1', { method: 'app.status' });
    const res = parseFrame(frame);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.type).toBe('request');
    }
  });

  it('拒绝协议版本不匹配的帧', () => {
    const res = parseFrame({
      v: 999,
      type: 'request',
      id: 'r1',
      payload: { method: 'app.status' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('bad_request');
  });

  it('拒绝未知方法名', () => {
    const res = parseFrame({
      v: IPC_PROTOCOL_VERSION,
      type: 'request',
      id: 'r1',
      payload: { method: 'app.dropDatabase' },
    });
    expect(res.ok).toBe(false);
  });

  it('拒绝缺少关联 id 的帧', () => {
    const res = parseFrame({
      v: IPC_PROTOCOL_VERSION,
      type: 'request',
      payload: { method: 'app.status' },
    });
    expect(res.ok).toBe(false);
  });

  it('拒绝非对象载荷', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(parseFrame(bad).ok).toBe(false);
    }
  });

  it('解析失败时指出出错位置', () => {
    const res = parseFrame({
      v: IPC_PROTOCOL_VERSION,
      type: 'request',
      id: 'r1',
      payload: { method: 'project.create' }, // 缺 name
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.detail).toBeDefined();
      expect(res.error.detail).toContain('name');
    }
  });

  it('区分成功响应与失败响应', () => {
    const ok = parseFrame(okResponse('r1', { a: 1 }));
    expect(ok.ok).toBe(true);

    const err = parseFrame(errResponse('r1', makeError('timeout', '超时')));
    expect(err.ok).toBe(true);
    if (err.ok && err.value.type === 'response') {
      expect(err.value.ok).toBe(false);
    }
  });

  it('事件帧允许 id 为 null（无关联的广播）', () => {
    const res = parseFrame(eventFrame(null, { kind: 'turn.end' }));
    expect(res.ok).toBe(true);
  });
});

describe('请求参数校验', () => {
  it('填充声明的默认值', () => {
    const res = parseRequest({ method: 'project.list' });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'project.list') {
      expect(res.value.includeArchived).toBe(false);
    }
  });

  it('history 的 limit 有上界，防止一次拉整个会话', () => {
    expect(
      parseRequest({ method: 'conversation.history', conversationId: 'c1', limit: 5000 }).ok,
    ).toBe(false);
    expect(
      parseRequest({ method: 'conversation.history', conversationId: 'c1', limit: 200 }).ok,
    ).toBe(true);
  });

  it('history 不传 limit 时用默认值 50', () => {
    const res = parseRequest({ method: 'conversation.history', conversationId: 'c1' });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'conversation.history') {
      expect(res.value.limit).toBe(50);
    }
  });

  it('拒绝空文本的发送请求', () => {
    expect(parseRequest({ method: 'conversation.send', conversationId: 'c1', text: '' }).ok).toBe(
      false,
    );
  });

  it('审批决定只接受 approve 与 deny', () => {
    expect(
      parseRequest({ method: 'approval.decide', approvalId: 'a1', decision: 'maybe' }).ok,
    ).toBe(false);
    expect(parseRequest({ method: 'approval.decide', approvalId: 'a1', decision: 'deny' }).ok).toBe(
      true,
    );
  });

  it('拒绝超长字段', () => {
    const res = parseRequest({ method: 'project.create', name: 'x'.repeat(500) });
    expect(res.ok).toBe(false);
  });

  it('错误码集合与 isRetryable 覆盖一致', () => {
    const all: ErrorCode[] = [
      'bad_request',
      'not_found',
      'conflict',
      'policy_denied',
      'content_filtered',
      'sandbox_denied',
      'kernel_error',
      'provider_error',
      'timeout',
      'aborted',
      'internal',
    ];
    // 每个码都能被判定，不抛异常也不返回 undefined
    for (const c of all) {
      expect(typeof isRetryable(c)).toBe('boolean');
    }
  });
});

describe('env.doctor 契约', () => {
  it('env.doctor 无需参数即可解析', () => {
    const res = parseRequest({ method: 'env.doctor' });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'env.doctor') {
      expect(res.value.refresh).toBe(false);
    }
  });

  it('env.doctor 接受 refresh 布尔', () => {
    expect(parseRequest({ method: 'env.doctor', refresh: true }).ok).toBe(true);
    expect(parseRequest({ method: 'env.doctor', refresh: 'yes' }).ok).toBe(false);
  });
});

describe('provider.provision 契约', () => {
  const SECRET = 'sk-PROVISION-CANARY-7c1e90ab';

  it('无参数即可解析，detectOllama 默认为 true', () => {
    const res = parseRequest({ method: 'provider.provision' });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'provider.provision') {
      expect(res.value.detectOllama).toBe(true);
      expect(res.value.deepseekKey).toBeUndefined();
    }
  });

  it('接受可选 deepseekKey 与 detectOllama', () => {
    const res = parseRequest({
      method: 'provider.provision',
      deepseekKey: SECRET,
      detectOllama: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'provider.provision') {
      expect(res.value.deepseekKey).toBe(SECRET);
      expect(res.value.detectOllama).toBe(false);
    }
  });

  it('拒绝额外的 baseUrl，不允许 UI 指定任意端点', () => {
    const res = parseRequest({
      method: 'provider.provision',
      baseUrl: 'http://evil',
    });
    expect(res.ok).toBe(false);
  });

  it('provider.provision still rejects extra baseUrl', () => {
    const res = parseRequest({
      method: 'provider.provision',
      baseUrl: 'http://evil',
    });
    expect(res.ok).toBe(false);
  });

  it('拒绝未知供应商 id', () => {
    expect(parseRequest({ method: 'provider.provision', providerId: 'openai' }).ok).toBe(false);
    expect(parseRequest({ method: 'provider.provision', openaiKey: 'sk-x' }).ok).toBe(false);
  });

  it('带密钥的非法载荷被拒时，错误信封不含密钥', () => {
    const res = parseRequest({
      method: 'provider.provision',
      deepseekKey: SECRET,
      baseUrl: 'http://evil',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(JSON.stringify(res.error)).not.toContain(SECRET);
  });
});

describe('provider.registerCompat 契约', () => {
  const KEY = 'sk-COMPAT-CANARY-9f2a11cd';

  it('provider.registerCompat rejects file and javascript URLs', () => {
    expect(
      parseRequest({
        method: 'provider.registerCompat',
        baseUrl: 'file:///etc/passwd',
        apiKey: KEY,
      }).ok,
    ).toBe(false);
    expect(
      parseRequest({
        method: 'provider.registerCompat',
        baseUrl: 'javascript:alert(1)',
        apiKey: KEY,
      }).ok,
    ).toBe(false);
    expect(
      parseRequest({
        method: 'provider.registerCompat',
        baseUrl: 'data:text/html,hi',
        apiKey: KEY,
      }).ok,
    ).toBe(false);
  });

  it('provider.registerCompat rejects non-loopback http', () => {
    expect(
      parseRequest({
        method: 'provider.registerCompat',
        baseUrl: 'http://evil.example/v1',
        apiKey: KEY,
      }).ok,
    ).toBe(false);
    expect(
      parseRequest({
        method: 'provider.registerCompat',
        baseUrl: 'http://8.8.8.8/v1',
        apiKey: KEY,
      }).ok,
    ).toBe(false);
  });

  it('provider.registerCompat accepts https URL', () => {
    const res = parseRequest({
      method: 'provider.registerCompat',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: KEY,
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.value.method === 'provider.registerCompat') {
      expect(res.value.baseUrl).toBe('https://api.openai.com/v1');
      expect(res.value.apiKey).toBe(KEY);
    }
  });
});
