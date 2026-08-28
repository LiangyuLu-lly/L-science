/**
 * 注册表与凭据的 IPC 契约（任务 11.1b、11.11）。
 *
 * 这些方法是设置页的全部数据来源，而设置页出错的后果不是「界面不好看」，
 * 而是用户以为配好了、实际路由永远选不到任何模型。因此重点验三件事：
 *
 * 1. 新方法的参数校验形状正确（错的载荷进不来，对的载荷不被误拒）
 * 2. **凭据密钥不会出现在任何错误信封里**——这条通道要传密钥，而错误信封会
 *    被记日志、被贴 issue
 * 3. 路由覆盖的类型与校验规则同源，不会一边允许一边拒收
 */

import { describe, expect, it } from 'vitest';

import { isRetryable, parseRequest, routingOverrideSchema } from '@l-science/shared';

/** 一个足够特征化的假密钥，便于在输出里搜它是否泄漏。 */
const SECRET = 'sk-UNIQUE-CANARY-9f3a71c2e5b84d06';

describe('注册表方法的参数校验', () => {
  it('provider.list 不需要参数', () => {
    expect(parseRequest({ method: 'provider.list' }).ok).toBe(true);
  });

  it('provider.setCredentialRef 允许 null 表示解绑', () => {
    const parsed = parseRequest({
      method: 'provider.setCredentialRef',
      providerId: 'deepseek',
      credentialRef: null,
    });
    expect(parsed.ok).toBe(true);
  });

  it('provider.setCredentialRef 拒绝空字符串引用名', () => {
    // 空串既不是「解绑」也不是一个合法引用名。放过它会写进库，
    // 之后 vault.has('') 恒为假，表现为「明明绑了却说缺凭据」
    const parsed = parseRequest({
      method: 'provider.setCredentialRef',
      providerId: 'deepseek',
      credentialRef: '',
    });
    expect(parsed.ok).toBe(false);
  });

  it('model.setEnabled 要求布尔值，不接受 0/1', () => {
    expect(parseRequest({ method: 'model.setEnabled', modelId: 'm', enabled: false }).ok).toBe(
      true,
    );
    expect(parseRequest({ method: 'model.setEnabled', modelId: 'm', enabled: 0 }).ok).toBe(false);
  });

  it('model.list 的 includeDisabled 默认为 true', () => {
    const parsed = parseRequest({ method: 'model.list' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 设置页默认要看全部模型——只显示已启用的会让用户找不到自己关掉的那个，
    // 也就无法重新打开它
    expect(parsed.value).toMatchObject({ includeDisabled: true });
  });
});

describe('凭据密钥不进错误信封', () => {
  it('密钥超长被拒时，错误信封里不含密钥', () => {
    const parsed = parseRequest({
      method: 'credential.set',
      ref: 'provider:deepseek',
      secret: SECRET.repeat(1000),
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const serialized = JSON.stringify(parsed.error);
    expect(serialized).not.toContain(SECRET);
    // 但必须说清楚是哪个字段出了问题，否则用户不知道该改什么
    expect(serialized).toContain('secret');
  });

  it('缺 ref 时的错误信封里不含密钥', () => {
    const parsed = parseRequest({ method: 'credential.set', secret: SECRET });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(JSON.stringify(parsed.error)).not.toContain(SECRET);
  });

  it('方法名写错时的错误信封里不含密钥', () => {
    // 判别联合失败会让 zod 报根节点错误，此时最容易顺手把整个载荷塞进 detail
    const parsed = parseRequest({ method: 'credential.setX', ref: 'r', secret: SECRET });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(JSON.stringify(parsed.error)).not.toContain(SECRET);
  });

  it('合法的 credential.set 能通过', () => {
    const parsed = parseRequest({
      method: 'credential.set',
      ref: 'provider:deepseek',
      secret: SECRET,
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('平台能力缺失的错误码', () => {
  it('unavailable 不可重试', () => {
    // 凭据库依赖 DPAPI。重试不会让 DPAPI 出现，把它判成可重试会让 UI
    // 一直给用户「重试」按钮
    expect(isRetryable('unavailable')).toBe(false);
  });
});

describe('路由覆盖', () => {
  it('权重覆盖允许把某个维度设为 0', () => {
    // 这正是「替换而非合并」要保住的能力：合并语义下 0 与「没给」不可区分
    const parsed = routingOverrideSchema.safeParse({ weightOverrides: { writingEn: 0 } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.weightOverrides).toEqual({ writingEn: 0 });
  });

  it('权重覆盖允许只给部分维度', () => {
    const parsed = routingOverrideSchema.safeParse({
      weightOverrides: { reasoning: 90, coding: 10 },
    });
    expect(parsed.success).toBe(true);
  });

  it('拒绝不存在的能力维度', () => {
    // 拼错维度名时静默忽略，表现为「我调了权重但排序没变」
    const parsed = routingOverrideSchema.safeParse({ weightOverrides: { reasonning: 90 } });
    expect(parsed.success).toBe(false);
  });

  it('拒绝超出 0-100 的权重', () => {
    expect(routingOverrideSchema.safeParse({ weightOverrides: { reasoning: 500 } }).success).toBe(
      false,
    );
    expect(routingOverrideSchema.safeParse({ weightOverrides: { reasoning: -1 } }).success).toBe(
      false,
    );
  });

  it('conversation.send 可以带路由覆盖，也可以不带', () => {
    expect(parseRequest({ method: 'conversation.send', conversationId: 'c', text: 'hi' }).ok).toBe(
      true,
    );
    expect(
      parseRequest({
        method: 'conversation.send',
        conversationId: 'c',
        text: 'hi',
        routing: { forcedModelId: 'deepseek-v4-pro', taskType: 'stats.reason' },
      }).ok,
    ).toBe(true);
  });

  it('routing.preview 的 token 估算有默认值', () => {
    const parsed = parseRequest({ method: 'routing.preview', taskType: 'analysis.codegen' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      estimatedInputTokens: 4000,
      expectedOutputTokens: 2000,
      needToolUse: true,
      requiredModalities: ['text'],
    });
  });

  it('routing.preview 拒绝不存在的任务类型', () => {
    expect(parseRequest({ method: 'routing.preview', taskType: 'write.paper' }).ok).toBe(false);
  });
});
