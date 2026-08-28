#!/usr/bin/env node
/**
 * M1 端到端冒烟（任务 10.2，需求 3.7、3.9、3.10、6.3）。
 *
 * 一条会话内跑完：Python 出图 → 存为制品 → 读回 → R 复算 → 中断长任务 →
 * 重启内核。这是 M1 的收口验收，把内核、沙箱、工具面、制品血缘串起来跑真东西。
 *
 * 不打模型 API——这里验的是执行平面，模型侧由 verify-turn.mjs 覆盖。因此它可以
 * 在没有任何供应商凭据的机器上跑。
 *
 * 用法：node scripts/verify-smoke.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KernelPool, detectKernels } from '../packages/kernel/dist/index.js';
import {
  ApprovalRepo,
  ApprovalService,
  ArtifactStore,
  AppStore,
  EgressProxy,
  GrantRepo,
  InterruptEvent,
  ToolRegistry,
  createKernelTool,
  createReadFileTool,
  createSaveArtifactsTool,
  nativeCapabilities,
  resolveMarkers,
} from '../packages/core/dist/index.js';

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

const kernels = detectKernels();
if (kernels.python === null) {
  process.stdout.write('Python 内核不可用，无法做 M1 冒烟。\n');
  process.stdout.write('创建托管环境：conda create -n lsci python=3.13 -y 然后装 ipykernel\n');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'lsci-smoke-'));
const store = AppStore.open(join(root, 'app'));
let pool = null;

try {
  const created = store.createProject({ name: 'M1 冒烟' });
  const project = store.openProject(created.id);
  const conversation = project.conversations.create({ title: '冒烟会话' });

  const artifacts = new ArtifactStore(project.db, project.paths.blobs);
  const grants = new GrantRepo(store.db);
  const approvals = new ApprovalService({
    repo: new ApprovalRepo(project.db),
    // 冒烟里自动批准，审批逻辑本身由单元测试覆盖
    publish: (request) => {
      setImmediate(() => approvals.decide({ approvalId: request.id, decision: 'approve' }));
    },
  });

  // 出口代理：验证它能起来并给出环境变量，内核会带上它
  const proxy = new EgressProxy({ grants, requestApproval: async () => false });
  await proxy.start();
  check(proxy.port > 0, '出口代理已启动', `端口 ${proxy.port}`);

  pool = new KernelPool({
    runtimeDir: join(root, 'runtime'),
    workspaceRoot: project.paths.workspace,
    available: kernels,
    // 日志走 stderr，不与 stdout 上的检查结果混在一起。没有它，中断退化成重启时
    // 只能看到「状态没保留」这个症状，看不到内核层给出的原因
    onLog: (line) => process.stderr.write(`[kernel] ${line}\n`),
    // Windows 上真中断依赖 FFI 创建的可继承 Event 句柄；拿不到时会退化成重启，
    // 而下面第 6 步会把这个退化如实报出来（状态保留检查会失败）
    interrupterFactory: () => InterruptEvent.create(),
    extraEnv: () => proxy.env(),
  });

  const workspace = join(project.paths.workspace, conversation.id);
  const ctx = { projectId: created.id, conversationId: conversation.id, workspaceDir: workspace };

  const tools = new ToolRegistry({ probe: () => true });
  tools.register(createKernelTool({ pool, language: 'python' }));
  if (kernels.r !== null) tools.register(createKernelTool({ pool, language: 'r' }));
  tools.register(
    createReadFileTool({
      resolvePath: (raw) => join(workspace, raw),
      resolveVersion: (versionId) => artifacts.versionPath(versionId),
    }),
  );
  tools.register(
    createSaveArtifactsTool({ store: artifacts, resolvePath: (raw) => join(workspace, raw) }),
  );

  /* ---------------- 1. Python 出图 ---------------- */

  process.stdout.write('\n--- 1. Python 出图 ---\n');

  const plotCode = [
    'import matplotlib',
    "matplotlib.use('Agg')",
    'import matplotlib.pyplot as plt',
    'import numpy as np',
    'rng = np.random.default_rng(42)',
    'data = rng.normal(loc=3.0, scale=1.0, size=200)',
    'fig, ax = plt.subplots(figsize=(4, 3))',
    'ax.hist(data, bins=20)',
    "ax.set_title('smoke test')",
    "fig.savefig('hist.png', dpi=80)",
    'np.save("data.npy", data)',
    'print(f"mean={data.mean():.6f}")',
    'print(f"std={data.std(ddof=1):.6f}")',
  ].join('\n');

  const plotResult = await tools.invoke('python', { code: plotCode }, ctx);
  check(
    plotResult.ok,
    'Python 代码执行成功',
    plotResult.ok ? '' : JSON.stringify(plotResult.output),
  );

  const plotText = plotResult.output.kind === 'text' ? plotResult.output.text : '';
  const meanMatch = /mean=([\d.]+)/.exec(plotText);
  const pythonMean = meanMatch === null ? null : Number(meanMatch[1]);
  check(pythonMean !== null, 'Python 算出统计量', `mean=${pythonMean ?? '?'}`);
  check(existsSync(join(workspace, 'hist.png')), '图文件已落盘', 'hist.png');

  /* ---------------- 2. 保存为制品 ---------------- */

  process.stdout.write('\n--- 2. 保存为制品（需求 6.3）---\n');

  const saveResult = await tools.invoke(
    'save_artifacts',
    { paths: ['hist.png', 'data.npy'], code: plotCode, language: 'python' },
    ctx,
  );
  check(saveResult.ok, 'save_artifacts 成功', '');

  const saved = artifacts.listArtifacts();
  check(saved.length === 2, '两个制品都已入库', saved.map((a) => a.filename).join(', '));

  const figure = saved.find((a) => a.filename === 'hist.png');
  const dataArtifact = saved.find((a) => a.filename === 'data.npy');
  check(figure?.kind === 'image', '图被识别为 image 类', figure?.kind ?? '?');
  check(dataArtifact?.kind === 'data', '数据被识别为 data 类', dataArtifact?.kind ?? '?');

  const figureVersion = artifacts.listVersions(figure?.id ?? '')[0];
  check(
    figureVersion?.codeLineage?.code === plotCode,
    '血缘记录了生成代码',
    `${String(figureVersion?.codeLineage?.code?.length ?? 0)} 字符`,
  );
  // 图有代码但没有输入版本，按需求 6.6 应标为血缘不完整
  check(
    figureVersion?.codeLineage?.reproducible === false,
    '图缺输入版本被标记（需求 6.6）',
    figureVersion?.codeLineage?.gap?.slice(0, 40) ?? '',
  );

  /* ---------------- 3. 读回制品 ---------------- */

  process.stdout.write('\n--- 3. 读回 ---\n');

  const dataVersion = artifacts.listVersions(dataArtifact?.id ?? '')[0];

  const readBinary = await tools.invoke('read_file', { versionId: dataVersion?.id }, ctx);
  check(
    !readBinary.ok && readBinary.output.ename === 'BinaryFile',
    '二进制被拒并提示改用代码',
    readBinary.output.kind === 'error' ? readBinary.output.evalue.slice(0, 50) : '',
  );

  // 标记解析：把版本 id 换成物理路径喂给 Python
  const markerCode =
    'import numpy as np\nd = np.load("{{artifact:' +
    (dataVersion?.id ?? '') +
    '}}")\nprint(f"reloaded={d.mean():.6f}")';
  const resolved = resolveMarkers(markerCode, {
    resolve: (id) => artifacts.versionPath(id),
    language: 'python',
  });
  check(resolved.rejected.length === 0, '标记解析成功（需求 6.5）', `${resolved.resolved} 处`);

  const reloadResult = await tools.invoke('python', { code: resolved.code }, ctx);
  const reloadText = reloadResult.output.kind === 'text' ? reloadResult.output.text : '';
  const reloadMatch = /reloaded=([\d.]+)/.exec(reloadText);
  check(
    reloadMatch !== null && Math.abs(Number(reloadMatch[1]) - (pythonMean ?? 0)) < 1e-6,
    '读回的数据与原始一致',
    `reloaded=${reloadMatch?.[1] ?? '?'}`,
  );

  /* ---------------- 4. 内核状态保持 ---------------- */

  process.stdout.write('\n--- 4. 内核状态（需求 3.9）---\n');

  // 上一格定义的 data 变量应当还在——同一会话复用同一内核
  const statefulResult = await tools.invoke(
    'python',
    { code: 'print(f"still_here={len(data)}")' },
    ctx,
  );
  const statefulText = statefulResult.output.kind === 'text' ? statefulResult.output.text : '';
  check(statefulText.includes('still_here=200'), '跨调用保持内存状态', statefulText.trim());

  /* ---------------- 5. R 复算 ---------------- */

  process.stdout.write('\n--- 5. R 复算 ---\n');

  if (kernels.r === null) {
    skip('R 复算', 'R 内核不可用（conda create -n lsci-r -c conda-forge r-base r-irkernel）');
  } else {
    /*
     * R 与 Python 是两个独立内核，变量不共享，因此必须经文件传数据。
     * 这正是「用 R 复算 Python 的结果」在真实场景里的做法，也顺带验证了
     * 两个内核看到的是同一个工作目录。
     */
    const csvResult = await tools.invoke(
      'python',
      { code: 'np.savetxt("data.csv", data, delimiter=",")\nprint("exported")' },
      ctx,
    );
    check(csvResult.ok, 'Python 导出 CSV', '');

    const rResult = await tools.invoke(
      'r',
      {
        code: [
          'd <- as.numeric(readLines("data.csv"))',
          'cat(sprintf("r_mean=%.6f\\n", mean(d)))',
          'cat(sprintf("r_sd=%.6f\\n", sd(d)))',
        ].join('\n'),
      },
      ctx,
    );

    const rText = rResult.output.kind === 'text' ? rResult.output.text : '';
    const rMeanMatch = /r_mean=([\d.]+)/.exec(rText);
    const rMean = rMeanMatch === null ? null : Number(rMeanMatch[1]);

    check(rResult.ok, 'R 代码执行成功', rResult.ok ? '' : rText.slice(0, 80));
    check(
      rMean !== null && pythonMean !== null && Math.abs(rMean - pythonMean) < 1e-5,
      'R 与 Python 结果一致',
      `python=${pythonMean ?? '?'} r=${rMean ?? '?'}`,
    );

    // R 内核也保持自己的状态，且与 Python 的互不干扰
    const rStateful = await tools.invoke(
      'r',
      { code: 'cat(sprintf("r_n=%d\\n", length(d)))' },
      ctx,
    );
    const rStatefulText = rStateful.output.kind === 'text' ? rStateful.output.text : '';
    check(rStatefulText.includes('r_n=200'), 'R 内核保持自己的状态', rStatefulText.trim());
  }

  /* ---------------- 6. 中断长任务 ---------------- */

  process.stdout.write('\n--- 6. 中断（需求 3.10）---\n');

  // 先把前提说清楚：没有原生中断事件时下面的「状态保留」必然失败，而那不是
  // 中断逻辑写错了，是这台机器缺能力。把原因印出来，省掉一轮排查
  const native = nativeCapabilities();
  if (!native.kernelInterrupt) {
    process.stdout.write(`      原生中断事件不可用：${native.notes.join('；')}\n`);
  }

  const kernel = await pool.acquire(conversation.id, 'python');

  /*
   * 用一个纯 Python 的忙循环，不用 time.sleep。
   *
   * 这个区别是实测出来的固有限制：CPython 的 interrupt_main 只设一个待处理信号
   * 标志，解释器在字节码之间检查它——而 time.sleep(60) 是单个阻塞的 C 调用，
   * 中间没有字节码边界，因此中断递送不到。忙循环有大量字节码边界，能被打断。
   */
  /*
   * 必须在这里就把异常收进返回值，不能让它以 rejection 的形式跑出来。
   *
   * 中断若退化成重启，`restart()` 会主动 reject 正在进行的那次执行——而那时
   * 谁都还没 await 这个 promise（下面要先 await interrupt()）。Node 会把它判为
   * unhandled rejection 并直接杀掉进程，于是后面所有检查一个都跑不到，输出里
   * 只剩一个看不出所以然的栈。
   */
  const longRunning = (async () => {
    const outputs = [];
    try {
      for await (const out of kernel.execute(
        'marker = "before"\ntotal = 0\nfor i in range(10**10):\n    total += i\nmarker = "after"',
      )) {
        outputs.push(out);
      }
      return { outputs, error: null };
    } catch (err) {
      return { outputs, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  // 给它一点时间真的跑起来，否则中断可能在执行开始前到达
  await new Promise((r) => setTimeout(r, 900));

  const interruptStart = Date.now();
  // 返回值是三态：idle / interrupted / restarted。restarted 意味着中断没能递送、
  // 退化成了重启——那和「中断成功」在用户看来完全不同（变量全丢），因此必须
  // 按值判断而不是按真假判断
  const outcome = await kernel.interrupt();
  const interruptMs = Date.now() - interruptStart;

  const { outputs, error: longError } = await longRunning;
  const hadKeyboardInterrupt = outputs.some(
    (o) => o.type === 'error' && o.ename === 'KeyboardInterrupt',
  );

  check(outcome === 'interrupted', '中断被递送（未退化为重启）', `${outcome}，${interruptMs} ms`);
  check(hadKeyboardInterrupt, '产生 KeyboardInterrupt', longError ?? '');

  // 关键：中断之后内存状态应当保留（这是真中断而不是重启的证据）
  const afterInterrupt = await tools.invoke(
    'python',
    { code: 'print(f"marker={marker}")\nprint(f"survived={len(data)}")' },
    ctx,
  );
  const survivedText = afterInterrupt.output.kind === 'text' ? afterInterrupt.output.text : '';
  check(
    survivedText.includes('marker=before'),
    '中断后状态保留（真中断而非重启）',
    survivedText.replace(/\s+/g, ' ').trim(),
  );
  check(survivedText.includes('survived=200'), '更早的变量也还在', '');

  /* ---------------- 7. 重启内核 ---------------- */

  process.stdout.write('\n--- 7. 重启（需求 3.7）---\n');

  const pidBefore = kernel.pid;
  const restarted = await pool.restart(conversation.id, 'python');
  check(restarted, '重启成功', '');

  const kernelAfter = await pool.acquire(conversation.id, 'python');
  check(
    kernelAfter.pid !== pidBefore && kernelAfter.pid !== null,
    '换了新进程',
    `${pidBefore ?? '?'} -> ${kernelAfter.pid ?? '?'}`,
  );

  // 重启后状态必须丢失——这是重启的语义，如果还在说明重启没真发生
  const afterRestart = await tools.invoke(
    'python',
    {
      code: 'print("data" in dir())\ntry:\n    data\n    print("state=kept")\nexcept NameError:\n    print("state=cleared")',
    },
    ctx,
  );
  const restartText = afterRestart.output.kind === 'text' ? afterRestart.output.text : '';
  check(
    restartText.includes('state=cleared'),
    '重启后状态已清空',
    restartText.replace(/\s+/g, ' ').trim(),
  );

  /* ---------------- 8. 制品血缘完整性 ---------------- */

  process.stdout.write('\n--- 8. 血缘与去重 ---\n');

  // 基于已有制品再存一个，这次带上输入版本——血缘应当完整
  const derivedCode = 'print("derived")';
  const derived = artifacts.save({
    filename: 'summary.txt',
    content: Buffer.from(`mean=${String(pythonMean)}\n`, 'utf8'),
    code: derivedCode,
    language: 'python',
    inputVersionIds: [dataVersion?.id ?? ''],
  });
  check(derived.version.codeLineage?.reproducible === true, '带输入版本的制品血缘完整', '');

  const ancestors = artifacts.ancestors(derived.version.id);
  check(
    ancestors.length === 1 && ancestors[0]?.filename === 'data.npy',
    '向上追溯到输入制品（需求 6.4）',
    ancestors.map((a) => `${a.filename}@${String(a.depth)}`).join(', '),
  );

  const descendants = artifacts.descendants(dataVersion?.id ?? '');
  check(
    descendants.some((d) => d.filename === 'summary.txt'),
    '向下追溯到派生产物',
    descendants.map((d) => d.filename).join(', '),
  );

  // 去重：同样内容再存一次不该多占空间
  const blobsBefore = artifacts.blobs.stats().blobCount;
  artifacts.save({
    filename: 'summary-copy.txt',
    content: Buffer.from(`mean=${String(pythonMean)}\n`, 'utf8'),
    code: derivedCode,
  });
  check(
    artifacts.blobs.stats().blobCount === blobsBefore,
    '相同内容只占一份（需求 6.1）',
    `${blobsBefore} 个 blob 不变`,
  );

  /* ---------------- 9. 出口管控 ---------------- */

  process.stdout.write('\n--- 9. 出口管控（需求 5.8）---\n');

  const kernelEnv = proxy.env();
  check(kernelEnv.HTTP_PROXY !== undefined, '代理地址已注入内核', kernelEnv.HTTP_PROXY ?? '');

  // 内核里读环境变量，确认它真的拿到了
  const envCheck = await tools.invoke(
    'python',
    { code: "import os\nprint(f\"proxy={os.environ.get('HTTP_PROXY', 'MISSING')}\")" },
    ctx,
  );
  const envText = envCheck.output.kind === 'text' ? envCheck.output.text : '';
  check(
    envText.includes(`127.0.0.1:${String(proxy.port)}`),
    '内核进程确实带上了代理',
    envText.trim(),
  );

  await proxy.stop();
  approvals.close();
} catch (err) {
  check(false, '冒烟流程异常', err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
} finally {
  if (pool !== null) await pool.close();
  store.close();
  // Windows 不允许删任何进程的 cwd，也不允许删占用中的 SQLite。等进程退干净
  await new Promise((r) => setTimeout(r, 1200));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

process.stdout.write(`\n通过 ${String(passed)}，失败 ${String(failed)}，跳过 ${String(skipped)}\n`);
process.exit(failed > 0 ? 1 : 0);
