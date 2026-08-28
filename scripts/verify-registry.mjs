#!/usr/bin/env node
/**
 * 注册表、凭据与路由试算的端到端验证（任务 11.1b、11.11）。
 *
 * 起真实后端进程，走真实 NDJSON 通道，用真实的 DPAPI 凭据库与 SQLite 应用库。
 * 数据目录是临时的（`L_SCIENCE_DATA_DIR`），不碰 `%LOCALAPPDATA%\L-science`。
 *
 * 为什么必须端到端：这些 handler 的错误几乎都不是类型错误，而是「参数校验通过、
 * 数据库写了、但路由那边读不到」这类接缝问题。单元测试各自 mock 掉对面，恰好
 * 测不到接缝。
 *
 * 唯一需要网络的是 provider.sync 与 provider.checkHealth，它们对本机 Ollama
 * 发起；Ollama 没起时这两项跳过并说明原因，其余检查照跑。
 *
 * 用法：node scripts/verify-registry.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'packages', 'core', 'dist', 'backend.js');
const dataDir = mkdtempSync(join(tmpdir(), 'lsci-vr-'));

let passed = 0;
let failed = 0;
let skipped = 0;

const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}  ${detail}\n`);
};
const skip = (label, why) => {
  skipped += 1;
  process.stdout.write(`SKIP  ${label.padEnd(34)}  ${why}\n`);
};

/* ------------------------------------------------------------------ *
 * 通道
 * ------------------------------------------------------------------ */

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, L_SCIENCE_DATA_DIR: dataDir },
});

const frames = [];
let buf = '';
let stderrText = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      frames.push({ __unparsable: line });
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrText += chunk;
});

let seq = 0;
/** 发一个请求并等它的响应帧。按帧类型过滤，事件帧带同一 id。 */
const call = async (payload, timeoutMs = 30_000) => {
  seq += 1;
  const id = `vr${String(seq)}`;
  child.stdin.write(`${JSON.stringify({ v: 1, type: 'request', id, payload })}\n`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = frames.find((f) => f.type === 'response' && f.id === id);
    if (frame !== undefined) return frame;
    if (Date.now() > deadline) throw new Error(`${payload.method} 超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 失败响应的可读摘要。 */
const why = (frame) =>
  frame.ok === true
    ? ''
    : `${frame.error?.code}: ${frame.error?.message}${frame.error?.detail === undefined ? '' : ` (${frame.error.detail})`}`;

/** 这个引用名与密钥只存在于本次临时数据目录里。 */
const REF = 'provider:verify-registry';
const SECRET = 'sk-verify-registry-CANARY-0011223344556677';

try {
  await call({ method: 'app.status' });

  /* ---------------- 1. 凭据 ---------------- */

  process.stdout.write('\n--- 1. 凭据（需求 8.5、8.6）---\n');

  const emptyList = await call({ method: 'credential.list' });
  check(emptyList.ok === true, 'credential.list 可用', why(emptyList));

  const vaultAvailable = emptyList.ok === true && emptyList.result.available === true;
  if (!vaultAvailable) {
    skip('凭据读写', '凭据库不可用（非 Windows 或 DPAPI 缺失）');
  } else {
    check(
      Array.isArray(emptyList.result.credentials) && emptyList.result.credentials.length === 0,
      '临时数据目录里初始为空',
      `${String(emptyList.result.credentials.length)} 条`,
    );

    const set = await call({ method: 'credential.set', ref: REF, secret: SECRET });
    check(set.ok === true, 'credential.set 写入成功', why(set));
    check(
      set.ok === true && set.result.fingerprint?.tail === SECRET.slice(-4),
      '回执只给指纹的末四位',
      set.ok === true ? JSON.stringify(set.result.fingerprint) : '',
    );

    // 决定性的一条：整条通道上的任何一帧都不该出现密钥原文
    const allFrames = JSON.stringify(frames);
    check(!allFrames.includes(SECRET), '响应与事件帧里不含密钥', '');
    check(!stderrText.includes(SECRET), '后端日志里不含密钥', '');

    const listed = await call({ method: 'credential.list' });
    const entry0 = listed.ok === true ? listed.result.credentials[0] : null;
    check(entry0?.ref === REF, 'credential.list 列出键名', entry0?.ref ?? '');
    check(
      JSON.stringify(listed.result ?? {}).includes(SECRET) === false,
      'credential.list 不返回密钥',
      '',
    );
    check(
      entry0?.fingerprint?.length === SECRET.length,
      '指纹给出长度',
      String(entry0?.fingerprint?.length ?? -1),
    );
  }

  /* ---------------- 2. 供应商 ---------------- */

  process.stdout.write('\n--- 2. 供应商注册表（需求 8.5、8.6）---\n');

  const providers0 = await call({ method: 'provider.list' });
  check(providers0.ok === true, 'provider.list 可用', why(providers0));
  check(
    providers0.ok === true && Array.isArray(providers0.result.providers),
    '返回供应商数组',
    `${String(providers0.result?.providers?.length ?? -1)} 家`,
  );

  // 临时数据目录里还没有任何供应商，先登记一家指向本机 Ollama 的
  const ollamaBase = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
  const provisioned = await call({
    method: 'provider.setEnabled',
    providerId: 'ollama',
    enabled: true,
  });
  check(
    provisioned.ok === false && provisioned.error?.code === 'not_found',
    '未登记的供应商报 not_found 而非静默成功',
    why(provisioned),
  );

  /*
   * 直接往应用库里插一条供应商记录，绕过 provision.mjs。
   *
   * 这里不该走「再加一个 provider.upsert IPC 方法」的路：登记供应商是一次性的
   * 部署动作，而把它做成 IPC 意味着渲染层可以任意指定 baseUrl——那等于让界面
   * 决定「把数据发给谁」。provision.mjs 的显式登记是刻意的边界。
   */
  const { AppStore, RegistryRepo } = await import(
    `file:///${join(repoRoot, 'packages', 'core', 'dist', 'index.js').replace(/\\/g, '/')}`
  );
  {
    const side = AppStore.open(dataDir);
    new RegistryRepo(side.db).upsertProvider({
      id: 'ollama',
      name: 'Ollama（本机）',
      adapter: 'ollama',
      baseUrl: ollamaBase,
      credentialRef: null,
      policy: null,
      enabled: true,
    });
    side.close();
  }

  const providers1 = await call({ method: 'provider.list' });
  const ollama =
    providers1.ok === true ? providers1.result.providers.find((p) => p.id === 'ollama') : null;
  check(ollama !== null && ollama !== undefined, '登记后能读到该供应商', ollama?.name ?? '');
  check(ollama?.adapterRegistered === true, '适配器已注册', String(ollama?.adapterRegistered));
  check(ollama?.modelCount === 0, '初始没有模型', String(ollama?.modelCount));

  const disabled = await call({
    method: 'provider.setEnabled',
    providerId: 'ollama',
    enabled: false,
  });
  check(disabled.ok === true, 'provider.setEnabled 生效', why(disabled));
  const afterDisable = await call({ method: 'provider.list' });
  check(
    afterDisable.result.providers.find((p) => p.id === 'ollama')?.enabled === false,
    '禁用状态被持久化',
    '',
  );
  await call({ method: 'provider.setEnabled', providerId: 'ollama', enabled: true });

  /* ---------------- 3. 凭据绑定 ---------------- */

  process.stdout.write('\n--- 3. 凭据绑定 ---\n');

  const bogus = await call({
    method: 'provider.setCredentialRef',
    providerId: 'ollama',
    credentialRef: 'provider:does-not-exist',
  });
  check(
    bogus.ok === false && bogus.error?.code === 'bad_request',
    '绑定不存在的引用名被当场拒绝',
    why(bogus),
  );

  if (vaultAvailable) {
    const bound = await call({
      method: 'provider.setCredentialRef',
      providerId: 'ollama',
      credentialRef: REF,
    });
    check(bound.ok === true, '绑定已存在的引用名成功', why(bound));

    const listedAfterBind = await call({ method: 'provider.list' });
    const p = listedAfterBind.result.providers.find((x) => x.id === 'ollama');
    check(p?.credentialPresent === true, '界面能看出凭据确实存在', '');
    check(p?.credentialRef === REF, '存的是引用名而不是密钥', p?.credentialRef ?? '');

    const inUse = await call({ method: 'credential.delete', ref: REF });
    check(
      inUse.ok === false && inUse.error?.code === 'conflict',
      '仍被引用的凭据不许删',
      why(inUse),
    );

    await call({ method: 'provider.setCredentialRef', providerId: 'ollama', credentialRef: null });
    const freed = await call({ method: 'credential.delete', ref: REF });
    check(freed.ok === true && freed.result.deleted === true, '解绑后可以删', why(freed));
  } else {
    skip('凭据绑定', '凭据库不可用');
  }

  /* ---------------- 4. 模型同步 ---------------- */

  process.stdout.write('\n--- 4. 模型同步 ---\n');

  const sync = await call({ method: 'provider.sync', providerId: 'ollama' }, 60_000);

  if (sync.ok !== true) {
    skip('provider.sync', `${why(sync)}（Ollama 未运行时属预期）`);
    skip('model.setEnabled', '没有模型可操作');
    skip('provider.checkHealth', 'Ollama 未运行');
  } else {
    check(true, 'provider.sync 成功', `新增 ${String(sync.result.added.length)} 个`);
    check(
      Array.isArray(sync.result.models) && sync.result.models.length > 0,
      '同步后返回完整模型列表',
      sync.result.models
        .map((m) => m.id)
        .join(', ')
        .slice(0, 60),
    );

    const first = sync.result.models[0];
    check(
      typeof first?.descriptor?.contextWindow === 'number' && first.descriptor.contextWindow > 0,
      '模型带真实上下文窗口而非猜测值',
      `${first?.id} ${String(first?.descriptor?.contextWindow)}`,
    );

    // 关掉再同步一次：用户的选择必须被保留（否则每次同步都把关掉的模型打开）
    const off = await call({ method: 'model.setEnabled', modelId: first.id, enabled: false });
    check(off.ok === true, 'model.setEnabled 关闭模型', why(off));

    const resync = await call({ method: 'provider.sync', providerId: 'ollama' }, 60_000);
    const stillOff = resync.ok === true && resync.result.models.find((m) => m.id === first.id);
    check(stillOff?.enabled === false, '再次同步保留用户的禁用选择', '');

    await call({ method: 'model.setEnabled', modelId: first.id, enabled: true });

    const missing = await call({
      method: 'model.setEnabled',
      modelId: 'no-such-model',
      enabled: true,
    });
    check(
      missing.ok === false && missing.error?.code === 'not_found',
      '未知模型报 not_found',
      why(missing),
    );

    const health = await call({ method: 'provider.checkHealth', providerId: 'ollama' }, 30_000);
    check(health.ok === true, 'provider.checkHealth 返回结论', why(health));
    check(
      health.ok === true && typeof health.result.health?.ok === 'boolean',
      '健康结果落到每个模型上',
      `ok=${String(health.result?.health?.ok)} 覆盖 ${String(health.result?.appliedTo)} 个`,
    );
  }

  /* ---------------- 5. 路由试算 ---------------- */

  process.stdout.write('\n--- 5. 路由试算（需求 7.6、7.14）---\n');

  const preview = await call({ method: 'routing.preview', taskType: 'analysis.codegen' });
  check(preview.ok === true, 'routing.preview 可用', why(preview));

  const decision = preview.ok === true ? preview.result.decision : null;
  check(decision !== null && typeof decision.reason === 'string', '给出人类可读理由', '');
  check(
    preview.ok === true && preview.result.weights !== undefined,
    '回传生效的权重表',
    Object.keys(preview.result?.weights ?? {}).join(', '),
  );

  if (decision?.chosenModelId === null) {
    // 注册表为空或全部被排除时应给出可执行报告，而不是一句「没有可用模型」
    check(
      typeof preview.result.emptyReport === 'string' && preview.result.emptyReport.length > 20,
      '候选为空时给出可执行报告',
      (preview.result.emptyReport ?? '').split('\n')[0].slice(0, 60),
    );
    check(
      decision.excluded.every((e) => typeof e.reasonText === 'string' && e.reasonText !== ''),
      '每个排除项都带中文文案',
      decision.excluded
        .map((e) => `${e.modelId}:${e.reasonText}`)
        .join(' | ')
        .slice(0, 70),
    );
    skip('权重覆盖改变排序', '没有可用候选');
    skip('强制指定模型', '没有可用候选');
  } else {
    check(
      true,
      '选出了模型',
      `${decision.chosenModelId}（${decision.scores[0].total.toFixed(1)} 分）`,
    );
    check(
      preview.result.candidates.some((c) => c.id === decision.chosenModelId),
      '候选显示信息与得分对得上',
      '',
    );
    check(
      typeof decision.scores[0].breakdown['预估成本'] === 'number',
      '得分构成里含预估成本',
      String(decision.scores[0].breakdown['预估成本']),
    );

    // 权重覆盖：把 coding 压到 0、reasoning 拉满，得分构成必须随之改变
    const overridden = await call({
      method: 'routing.preview',
      taskType: 'analysis.codegen',
      routing: { weightOverrides: { reasoning: 100 } },
    });
    const baseCapability = decision.scores[0].breakdown['能力得分'];
    const newCapability =
      overridden.ok === true
        ? overridden.result.decision.scores.find((s) => s.modelId === decision.chosenModelId)
            ?.breakdown['能力得分']
        : null;
    check(
      overridden.ok === true && newCapability !== null && newCapability !== baseCapability,
      '权重覆盖改变能力得分',
      `${String(baseCapability)} -> ${String(newCapability)}`,
    );
    check(
      overridden.ok === true &&
        Object.keys(overridden.result.weights).length === 1 &&
        overridden.result.weights.reasoning === 100,
      '覆盖是替换而非合并（只剩给定维度）',
      JSON.stringify(overridden.result?.weights),
    );

    // 强制指定：候选集收窄成一个，但硬过滤仍然执行
    const forced = await call({
      method: 'routing.preview',
      taskType: 'analysis.codegen',
      routing: { forcedModelId: decision.chosenModelId },
    });
    check(
      forced.ok === true && forced.result.decision.scores.length === 1,
      '强制指定后只剩一个候选',
      String(forced.result?.decision?.scores?.length),
    );
    check(
      forced.ok === true && forced.result.decision.reason.includes('强制指定'),
      '理由说明这是用户强制指定的',
      (forced.result?.decision?.reason ?? '').slice(0, 40),
    );

    const forcedBad = await call({
      method: 'routing.preview',
      taskType: 'analysis.codegen',
      routing: { forcedModelId: 'not-a-real-model' },
    });
    check(
      forcedBad.ok === true && forcedBad.result.decision.chosenModelId === null,
      '强制指定不存在的模型不会硬报错',
      '',
    );
    check(
      forcedBad.ok === true && (forcedBad.result.emptyReport ?? '').includes('not-a-real-model'),
      '报告点名是哪个模型不行',
      (forcedBad.result?.emptyReport ?? '').slice(0, 50),
    );
  }

  // 试算必须可复现：同样输入给同样结果（探索加成被刻意排除）
  const again = await call({ method: 'routing.preview', taskType: 'analysis.codegen' });
  check(
    again.ok === true &&
      JSON.stringify(again.result.decision.scores) === JSON.stringify(decision?.scores ?? []),
    '同样输入给同样结果（无随机探索）',
    '',
  );

  /* ---------------- 6. 参数校验 ---------------- */

  process.stdout.write('\n--- 6. 参数校验 ---\n');

  const badTask = await call({ method: 'routing.preview', taskType: 'write.paper' });
  check(
    badTask.ok === false && badTask.error?.code === 'bad_request',
    '未知任务类型被拒',
    why(badTask),
  );

  const badWeight = await call({
    method: 'routing.preview',
    taskType: 'stats.reason',
    routing: { weightOverrides: { reasonning: 90 } },
  });
  check(
    badWeight.ok === false && badWeight.error?.code === 'bad_request',
    '拼错的能力维度被拒（否则静默无效）',
    why(badWeight),
  );
} catch (err) {
  check(false, '验证流程异常', err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null) child.kill();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

process.stdout.write(`\n通过 ${String(passed)}，失败 ${String(failed)}，跳过 ${String(skipped)}\n`);
process.exit(failed > 0 ? 1 : 0);
