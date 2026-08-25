#!/usr/bin/env node
/**
 * 供应商适配器的真实 API 验证。
 *
 * mock 测试只能证明「我按自己以为的协议解析得对」，证明不了协议本身猜对了。
 * 这个脚本打真实端点，因此会产生极少量费用（几十 token）。
 *
 * 用法：node scripts/verify-providers.mjs
 * 没有凭据的供应商自动跳过而不是失败。
 */

import {
  DeepSeekAdapter,
  DEEPSEEK_BASE_URL,
  OllamaAdapter,
  OLLAMA_BASE_URL,
  deepseekPricing,
  isPeakPricing,
} from '../packages/adapters/dist/index.js';
import { CredentialVault, providerRef } from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;
let skipped = 0;

const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)}  ${detail}\n`);
};
const skip = (label, why) => {
  skipped += 1;
  process.stdout.write(`SKIP  ${label.padEnd(30)}  ${why}\n`);
};

const vault = new CredentialVault();

/* ------------------------------------------------------------------ *
 * DeepSeek
 * ------------------------------------------------------------------ */

process.stdout.write('\n=== DeepSeek ===\n');

const deepseekKey = vault.exists ? vault.get(providerRef('deepseek')) : null;

if (deepseekKey === null) {
  skip('DeepSeek 全部检查', '凭据库无 provider:deepseek');
} else {
  const adapter = new DeepSeekAdapter();
  const ctx = { baseUrl: DEEPSEEK_BASE_URL, apiKey: deepseekKey };

  // 1. 健康检查
  const health = await adapter.health(ctx);
  check(health.ok, '健康检查', `${health.latencyMs}ms ${health.detail ?? ''}`);

  // 2. 模型发现
  let models = [];
  try {
    models = await adapter.listModels(ctx);
    check(models.length > 0, '模型发现', models.map((m) => m.id).join(', '));
  } catch (error) {
    check(false, '模型发现', error.message);
  }

  // 3. 元数据与官方公布一致
  const flash = models.find((m) => m.id === 'deepseek-v4-flash');
  check(
    flash?.contextWindow === 1_000_000 && flash?.maxOutputTokens === 384_000,
    '上下文窗口与输出上限',
    `${flash?.contextWindow ?? '?'} / ${flash?.maxOutputTokens ?? '?'}`,
  );
  check(
    models.every((m) => m.features.toolUse) && models.some((m) => m.features.vision),
    '能力标记',
    `工具全支持；视觉：${models
      .filter((m) => m.features.vision)
      .map((m) => m.id)
      .join(', ')}`,
  );

  // 4. 时段计价
  const now = new Date();
  const price = deepseekPricing('deepseek-v4-flash', now);
  check(
    price !== null && price.inputPer1k > 0,
    '时段计价',
    `当前${isPeakPricing(now) ? '高峰' : '非高峰'}：输入 $${price?.inputPer1k}/1K 输出 $${price?.outputPer1k}/1K`,
  );

  // 5. 流式对话
  try {
    const started = Date.now();
    let firstChunkMs = null;
    let textChunks = 0;
    let text = '';
    let done = null;

    // 输出上限必须给思维模式留余量。v4 全系默认开启思维，给 24 token 的话
    // 会全部被思考消耗掉，正文一个字都产不出，停止原因变成 max_tokens
    for await (const chunk of adapter.chat(ctx, {
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '只输出三个字：验证通过' }],
      maxOutputTokens: 512,
      stream: true,
    })) {
      if (chunk.kind === 'text') {
        firstChunkMs ??= Date.now() - started;
        textChunks += 1;
        text += chunk.text;
      } else if (chunk.kind === 'done') {
        done = chunk;
      }
    }

    check(
      textChunks > 0 && done !== null,
      '流式对话',
      `首字 ${firstChunkMs}ms，${textChunks} 片，"${text.trim()}"`,
    );
    check(done?.stopReason === 'end_turn', '停止原因归一化', done?.stopReason ?? '缺失');
    check(
      (done?.usage.tokensIn ?? 0) > 0 && (done?.usage.tokensOut ?? 0) > 0,
      '用量上报',
      `in=${done?.usage.tokensIn} out=${done?.usage.tokensOut}`,
    );
    check(
      (done?.usage.cost ?? 0) > 0,
      '成本核算',
      `$${done?.usage.cost.toFixed(8)} ${done?.usage.currency}`,
    );
  } catch (error) {
    check(false, '流式对话', error.message);
  }

  // 6. 工具调用
  try {
    let call = null;
    let stopReason = null;
    for await (const chunk of adapter.chat(ctx, {
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '用工具计算 17 乘 23。' }],
      tools: [
        {
          name: 'calculate',
          description: '计算算式',
          parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: '算式' } },
            required: ['expression'],
          },
        },
      ],
      maxOutputTokens: 128,
      stream: true,
    })) {
      if (chunk.kind === 'tool_call') call = chunk;
      else if (chunk.kind === 'done') stopReason = chunk.stopReason;
    }

    check(
      call !== null,
      '工具调用解析',
      call === null ? '未产生调用' : `${call.name}(${call.argumentsJson})`,
    );
    if (call !== null) {
      let parsed = null;
      try {
        parsed = JSON.parse(call.argumentsJson);
      } catch {
        /* 下面报告 */
      }
      // 参数拼接错了这里就会失败——这是分片累积逻辑的真实检验
      check(parsed !== null, '工具参数是合法 JSON', parsed === null ? call.argumentsJson : '是');
      check(call.id !== '', '工具调用带 id', call.id);
    }
    check(stopReason === 'tool_use', '工具调用停止原因', stopReason ?? '缺失');
  } catch (error) {
    check(false, '工具调用解析', error.message);
  }

  // 7. 错误归一化
  try {
    const iterator = adapter.chat(ctx, {
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    // 用一个必然被拒的模型名触发真实错误
    const bad = adapter.chat(
      { ...ctx },
      {
        modelName: 'deepseek-does-not-exist',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      },
    );
    void iterator;
    let error = null;
    try {
      for await (const _ of bad) void _;
    } catch (e) {
      error = e;
    }
    check(
      error !== null && error.name === 'ProviderError' && error.retryable === false,
      '错误归一化',
      error === null ? '未抛错' : `status=${error.status} retryable=${error.retryable}`,
    );
  } catch (error) {
    check(false, '错误归一化', error.message);
  }
}

/* ------------------------------------------------------------------ *
 * Ollama
 * ------------------------------------------------------------------ */

process.stdout.write('\n=== Ollama（本地） ===\n');

const ollama = new OllamaAdapter();
const ollamaCtx = { baseUrl: OLLAMA_BASE_URL };
const ollamaHealth = await ollama.health(ollamaCtx);

if (!ollamaHealth.ok) {
  skip('Ollama 全部检查', ollamaHealth.detail ?? '不可用');
} else {
  check(true, '健康检查', `${ollamaHealth.latencyMs}ms`);

  try {
    const models = await ollama.listModels(ollamaCtx);
    check(
      models.length > 0,
      '模型发现',
      models.map((m) => `${m.id}(${m.contextWindow})`).join(', '),
    );
    check(
      models.every((m) => m.local && m.pricing.inputPer1k === 0),
      '本地模型标记与零计费',
      `${models.length} 个`,
    );
    check(
      models.every((m) => m.policy.zdr && m.policy.trainingUse === 'none'),
      '数据不出本机的策略',
      '全部满足',
    );

    const target = models.find((m) => m.features.toolUse) ?? models[0];
    if (target !== undefined) {
      const started = Date.now();
      let text = '';
      let thinkingChars = 0;
      let done = null;
      // 同理给思维模型留余量。实测 qwen3:4b 在 16 token 上限下产出 17 个
      // 分片全是思考、正文为空
      for await (const chunk of ollama.chat(ollamaCtx, {
        modelName: target.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxOutputTokens: target.features.thinking ? 1024 : 32,
        stream: true,
      })) {
        if (chunk.kind === 'text') text += chunk.text;
        else if (chunk.kind === 'thinking') thinkingChars += chunk.text.length;
        else if (chunk.kind === 'done') done = chunk;
      }
      check(
        text.trim() !== '' && done !== null,
        '本地流式对话',
        `${target.id} ${Date.now() - started}ms 思考${thinkingChars}字 正文"${text.trim().slice(0, 40)}"`,
      );
      check(
        (done?.usage.tokensIn ?? 0) > 0 && (done?.usage.tokensOut ?? 0) > 0,
        '本地用量上报',
        `in=${done?.usage.tokensIn} out=${done?.usage.tokensOut}`,
      );
      check(
        target.features.thinking === thinkingChars > 0,
        'thinking 标记与实际一致',
        `标记=${target.features.thinking} 实际思考=${thinkingChars}字`,
      );
      check((done?.usage.cost ?? -1) === 0, '本地推理零成本', `$${done?.usage.cost}`);
    }
  } catch (error) {
    check(false, 'Ollama 模型检查', error.message);
  }
}

/* ------------------------------------------------------------------ *
 * 跨厂商前提
 * ------------------------------------------------------------------ */

process.stdout.write('\n=== 跨厂商前提 ===\n');

const availableVendors = [];
if (deepseekKey !== null) availableVendors.push('deepseek');
if (ollamaHealth.ok) availableVendors.push('ollama');

check(
  availableVendors.length >= 2,
  '可用厂商数 >= 2',
  availableVendors.length >= 2
    ? availableVendors.join(' + ')
    : `只有 ${availableVendors.join('') || '零'} 家，跨厂商 committee 与 Reviewer 异厂商复核无法成立`,
);

process.stdout.write(`\n通过 ${String(passed)}，失败 ${String(failed)}，跳过 ${String(skipped)}\n`);
process.exit(failed > 0 ? 1 : 0);
