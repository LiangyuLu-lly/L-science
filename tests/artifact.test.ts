/**
 * Artifact Store 测试（任务 7.1-7.5，需求 6）。
 *
 * 重点在几处会毁掉论文可用性的行为：
 * - 相同内容只占一份，refcount 归零后可回收（需求 6.1）
 * - 更新即新版本，不覆盖（需求 6.2）
 * - 多级派生的追溯路径正确（需求 6.4）
 * - 图像缺少可复现血缘时被标记（需求 6.6）
 * - 标记必须是字面量，变量拼接被拒并给出可执行提示（需求 6.5）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalRepo,
  ApprovalService,
  ArtifactStore,
  AppStore,
  BlobStore,
  assessReproducibility,
  createDeleteArtifactsTool,
  createSaveArtifactsTool,
  humanBytes,
  blobRelPath,
  escapePath,
  formatRejections,
  findMarkers,
  hashBuffer,
  inferKind,
  resolveMarkers,
  type ProjectStore,
} from '@l-science/core';

let root: string;
let store: AppStore;
let project: ProjectStore;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsci-af-'));
  store = AppStore.open(root);
  const created = store.createProject({ name: '制品测试' });
  project = store.openProject(created.id);
  artifacts = new ArtifactStore(project.db, project.paths.blobs);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('内容寻址与去重（需求 6.1）', () => {
  it('sha256 按前两位分桶', () => {
    // 单目录几万个文件时 NTFS 目录枚举会明显变慢。
    // 分隔符用平台原生的（join），因为这个值要拼成真实路径
    const sha = 'abcdef0123456789'.repeat(4);
    expect(blobRelPath(sha)).toBe(join('ab', sha));
  });

  it('sha256 太短时报错而不是产出一个畸形路径', () => {
    expect(() => blobRelPath('a')).toThrow(/不是合法的 sha256/);
  });

  it('相同内容只占一份', () => {
    const a = artifacts.save({ filename: 'fig1.png', content: buf('同样的内容'), code: 'x' });
    const b = artifacts.save({ filename: 'fig2.png', content: buf('同样的内容'), code: 'x' });

    expect(a.version.blobSha256).toBe(b.version.blobSha256);
    expect(b.deduped).toBe(true);
    expect(artifacts.blobs.stats().blobCount).toBe(1);
  });

  it('去重后 refcount 累加', () => {
    artifacts.save({ filename: 'a.txt', content: buf('dup'), code: 'x' });
    artifacts.save({ filename: 'b.txt', content: buf('dup'), code: 'x' });

    const sha = hashBuffer(buf('dup')).sha256;
    expect(artifacts.blobs.get(sha)?.refcount).toBe(2);
  });

  it('不同内容各占一份', () => {
    artifacts.save({ filename: 'a.txt', content: buf('甲'), code: 'x' });
    artifacts.save({ filename: 'b.txt', content: buf('乙'), code: 'x' });
    expect(artifacts.blobs.stats().blobCount).toBe(2);
  });

  it('blob 文件真的落在分桶路径下', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('内容'), code: 'x' });
    const path = artifacts.blobs.absolutePath(result.version.blobSha256);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('内容');
  });

  it('refcount 归零后可被回收', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('待回收'), code: 'x' });
    const sha = result.version.blobSha256;

    artifacts.softDelete([result.artifact.id]);
    expect(artifacts.blobs.get(sha)?.refcount).toBe(0);
    expect(artifacts.blobs.unreferenced().map((b) => b.sha256)).toContain(sha);

    // minAgeMs 设 0 以绕过「刚存进来的不回收」保护
    const gc = artifacts.blobs.collectGarbage({ minAgeMs: 0 });
    expect(gc.removed).toContain(sha);
    expect(existsSync(artifacts.blobs.absolutePath(sha))).toBe(false);
  });

  it('仍被引用的 blob 不会被回收', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('在用'), code: 'x' });
    const gc = artifacts.blobs.collectGarbage({ minAgeMs: 0 });
    expect(gc.removed).not.toContain(result.version.blobSha256);
  });

  it('刚存入还未被引用的 blob 默认不回收', () => {
    // 保存流程分两步，立即回收会把正在进行的保存操作的内容删掉
    const blobs = new BlobStore(project.db, project.paths.blobs);
    const record = blobs.put(buf('中间状态'));
    expect(record.refcount).toBe(0);

    expect(blobs.collectGarbage().removed).not.toContain(record.sha256);
    expect(blobs.collectGarbage({ minAgeMs: 0 }).removed).toContain(record.sha256);
  });

  it('release 不让 refcount 变负', () => {
    // 负计数会让 blob 永远无法回收，故障从「计数错了」升级成「空间永久泄漏」
    const blobs = new BlobStore(project.db, project.paths.blobs);
    const record = blobs.put(buf('x'));
    expect(blobs.release(record.sha256)).toBe(0);
    expect(blobs.release(record.sha256)).toBe(0);
  });

  it('引用不存在的 blob 时报错', () => {
    const blobs = new BlobStore(project.db, project.paths.blobs);
    expect(() => blobs.addRef('0'.repeat(64))).toThrow(/不存在/);
  });

  it('dryRun 不真的删文件', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('y'), code: 'x' });
    artifacts.softDelete([result.artifact.id]);

    const gc = artifacts.blobs.collectGarbage({ minAgeMs: 0, dryRun: true });
    expect(gc.removed).toContain(result.version.blobSha256);
    expect(existsSync(artifacts.blobs.absolutePath(result.version.blobSha256))).toBe(true);
  });

  it('清理磁盘上的孤儿文件', async () => {
    // 来自「写文件成功但事务未提交」的崩溃点。无害但占空间，
    // 且只能靠扫盘发现——没有任何记录指向它们
    const orphanDir = join(project.paths.blobs, 'ff');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'f'.repeat(64)), 'orphan');

    const swept = artifacts.blobs.sweepOrphans();
    expect(swept.removed).toBe(1);
    expect(existsSync(join(orphanDir, 'f'.repeat(64)))).toBe(false);
  });

  it('sweepOrphans 不动有库行的文件', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('keep'), code: 'x' });
    expect(artifacts.blobs.sweepOrphans().removed).toBe(0);
    expect(existsSync(artifacts.blobs.absolutePath(result.version.blobSha256))).toBe(true);
  });

  it('putFile 从已有文件导入并计算 sha', async () => {
    const src = join(root, 'source.bin');
    writeFileSync(src, 'from file');
    const record = await artifacts.blobs.putFile(src);
    expect(record.sha256).toBe(hashBuffer(buf('from file')).sha256);
    expect(readFileSync(artifacts.blobs.absolutePath(record.sha256), 'utf8')).toBe('from file');
  });
});

describe('版本序列（需求 6.2）', () => {
  it('更新产生新版本而不是覆盖', () => {
    // 覆盖会毁掉「投稿时用的是哪一版」这个问题的答案，且不留痕迹
    const v1 = artifacts.save({ filename: 'fig.png', content: buf('第一版'), code: 'a' });
    const v2 = artifacts.save({
      artifactId: v1.artifact.id,
      filename: 'fig.png',
      content: buf('第二版'),
      code: 'b',
      inputVersionIds: [v1.version.id],
    });

    expect(v2.version.versionNo).toBe(2);
    expect(artifacts.listVersions(v1.artifact.id)).toHaveLength(2);
    // 旧版本内容仍可读出
    expect(artifacts.readVersion(v1.version.id)?.toString('utf8')).toBe('第一版');
    expect(artifacts.readVersion(v2.version.id)?.toString('utf8')).toBe('第二版');
  });

  it('latest_version_id 指向最新版本', () => {
    const v1 = artifacts.save({ filename: 'fig.png', content: buf('1'), code: 'a' });
    const v2 = artifacts.save({
      artifactId: v1.artifact.id,
      filename: 'fig.png',
      content: buf('2'),
      code: 'b',
    });
    expect(artifacts.getArtifact(v1.artifact.id)?.latestVersionId).toBe(v2.version.id);
  });

  it('版本号取最大值加一，不用 COUNT', () => {
    // 删过版本之后 COUNT 会产生重复号
    const v1 = artifacts.save({ filename: 'a.txt', content: buf('1'), code: 'x' });
    artifacts.save({ artifactId: v1.artifact.id, filename: 'a.txt', content: buf('2'), code: 'x' });
    project.db.prepare('DELETE FROM artifact_versions WHERE version_no = 1').run();

    const v3 = artifacts.save({
      artifactId: v1.artifact.id,
      filename: 'a.txt',
      content: buf('3'),
      code: 'x',
    });
    expect(v3.version.versionNo).toBe(3);
  });

  it('版本按序号升序列出，读起来就是演进过程', () => {
    const v1 = artifacts.save({ filename: 'a.txt', content: buf('1'), code: 'x' });
    artifacts.save({ artifactId: v1.artifact.id, filename: 'a.txt', content: buf('2'), code: 'x' });
    artifacts.save({ artifactId: v1.artifact.id, filename: 'a.txt', content: buf('3'), code: 'x' });
    expect(artifacts.listVersions(v1.artifact.id).map((v) => v.versionNo)).toEqual([1, 2, 3]);
  });

  it('指定不存在的 artifactId 时报错', () => {
    expect(() =>
      artifacts.save({ artifactId: 'af_nope', filename: 'a.txt', content: buf('x'), code: 'y' }),
    ).toThrow(/不存在/);
  });

  it('文件不存在时 readVersion 返回 null 而不是抛错', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    rmSync(artifacts.blobs.absolutePath(result.version.blobSha256));
    expect(artifacts.readVersion(result.version.id)).toBeNull();
  });
});

describe('分类推断', () => {
  it('按 MIME 优先', () => {
    expect(inferKind('mystery.dat', 'image/png')).toBe('image');
  });

  it('按扩展名兜底', () => {
    expect(inferKind('fig.png', null)).toBe('image');
    expect(inferKind('data.csv', null)).toBe('table');
    expect(inferKind('draft.md', null)).toBe('document');
    expect(inferKind('run.py', null)).toBe('data' === 'data' ? 'code' : 'code');
    expect(inferKind('raw.edf', null)).toBe('data');
    expect(inferKind('weird.xyz', null)).toBe('other');
  });
});

describe('可复现血缘判定（需求 6.6）', () => {
  it('图像缺代码时不可复现，且说明为什么要紧', () => {
    const result = assessReproducibility({ kind: 'image', code: null, inputVersionIds: [] });
    expect(result.reproducible).toBe(false);
    expect(result.gap).toContain('审稿人');
  });

  it('图像有代码但无输入版本时仍不可复现', () => {
    // 代码里的数据来源不明——可能是硬编码路径，也可能是上一个 cell 的变量
    const result = assessReproducibility({
      kind: 'image',
      code: 'plt.plot(x)',
      inputVersionIds: [],
    });
    expect(result.reproducible).toBe(false);
    expect(result.gap).toContain('数据来源不明');
  });

  it('图像有代码有输入时可复现', () => {
    const result = assessReproducibility({
      kind: 'image',
      code: 'plt.plot(x)',
      inputVersionIds: ['av_1'],
    });
    expect(result.reproducible).toBe(true);
    expect(result.gap).toBeNull();
  });

  it('非图像只要求有代码', () => {
    // 表格与文档的内容本身可核对，图不可核对——看不出数字对不对
    expect(
      assessReproducibility({ kind: 'table', code: 'df.to_csv(...)', inputVersionIds: [] })
        .reproducible,
    ).toBe(true);
  });

  it('空白代码视为没有代码', () => {
    expect(
      assessReproducibility({ kind: 'table', code: '   \n  ', inputVersionIds: [] }).reproducible,
    ).toBe(false);
  });

  it('保存图像缺血缘时返回缺口说明', () => {
    const result = artifacts.save({ filename: 'fig.png', content: buf('png') });
    expect(result.version.codeLineage?.reproducible).toBe(false);
    expect(result.reproducibilityGap).not.toBeNull();
  });

  it('irreproducible 只列 latest 版本', () => {
    // 历史版本的血缘缺陷无法补救，全列出来会让真正需要处理的当前版本看不见
    const v1 = artifacts.save({ filename: 'fig.png', content: buf('1') });
    artifacts.save({
      artifactId: v1.artifact.id,
      filename: 'fig.png',
      content: buf('2'),
      code: 'plt.plot()',
      inputVersionIds: [v1.version.id],
    });

    // 最新版血缘完整，因此不该出现在列表里
    expect(artifacts.irreproducible()).toHaveLength(0);
  });

  it('irreproducible 不含已删除的制品', () => {
    const result = artifacts.save({ filename: 'bad.png', content: buf('x') });
    expect(artifacts.irreproducible()).toHaveLength(1);
    artifacts.softDelete([result.artifact.id]);
    expect(artifacts.irreproducible()).toHaveLength(0);
  });
});

describe('血缘追溯（需求 6.4）', () => {
  /** 建一条五级链：raw -> clean -> epochs -> stats -> fig */
  function buildChain() {
    const raw = artifacts.save({ filename: 'raw.edf', content: buf('raw'), code: 'load()' });
    const clean = artifacts.save({
      filename: 'clean.fif',
      content: buf('clean'),
      code: 'filter()',
      inputVersionIds: [raw.version.id],
    });
    const epochs = artifacts.save({
      filename: 'epochs.fif',
      content: buf('epochs'),
      code: 'epoch()',
      inputVersionIds: [clean.version.id],
    });
    const stats = artifacts.save({
      filename: 'stats.csv',
      content: buf('stats'),
      code: 'anova()',
      inputVersionIds: [epochs.version.id],
    });
    const fig = artifacts.save({
      filename: 'fig.png',
      content: buf('fig'),
      code: 'plot()',
      inputVersionIds: [stats.version.id],
    });
    return { raw, clean, epochs, stats, fig };
  }

  it('多级派生的追溯路径正确', () => {
    const chain = buildChain();
    const ancestors = artifacts.ancestors(chain.fig.version.id);

    expect(ancestors.map((a) => a.filename)).toEqual([
      'stats.csv',
      'epochs.fif',
      'clean.fif',
      'raw.edf',
    ]);
    expect(ancestors.map((a) => a.depth)).toEqual([1, 2, 3, 4]);
  });

  it('向下追溯派生产物', () => {
    const chain = buildChain();
    const descendants = artifacts.descendants(chain.raw.version.id);
    expect(descendants.map((d) => d.filename)).toEqual([
      'clean.fif',
      'epochs.fif',
      'stats.csv',
      'fig.png',
    ]);
  });

  it('多输入的分叉都被追溯到', () => {
    const a = artifacts.save({ filename: 'a.csv', content: buf('a'), code: 'x' });
    const b = artifacts.save({ filename: 'b.csv', content: buf('b'), code: 'x' });
    const merged = artifacts.save({
      filename: 'merged.png',
      content: buf('m'),
      code: 'merge()',
      inputVersionIds: [a.version.id, b.version.id],
    });

    expect(
      artifacts
        .ancestors(merged.version.id)
        .map((n) => n.filename)
        .sort(),
    ).toEqual(['a.csv', 'b.csv']);
  });

  it('没有血缘的版本追溯结果为空', () => {
    const lone = artifacts.save({ filename: 'lone.csv', content: buf('x'), code: 'y' });
    expect(artifacts.ancestors(lone.version.id)).toEqual([]);
  });

  it('maxDepth 限制递归深度', () => {
    const chain = buildChain();
    expect(artifacts.ancestors(chain.fig.version.id, 2)).toHaveLength(2);
  });

  it('血缘图里的环不会导致无限递归', () => {
    // 环本不该存在（派生关系天然是 DAG），但一次错误写入就能造出来，
    // 而无限递归会把整个后端卡死
    const a = artifacts.save({ filename: 'a.csv', content: buf('a'), code: 'x' });
    const b = artifacts.save({
      filename: 'b.csv',
      content: buf('b'),
      code: 'x',
      inputVersionIds: [a.version.id],
    });
    // 手工造一条反向边构成环
    project.db
      .prepare(
        'INSERT INTO artifact_lineage (child_version_id, parent_version_id, relation) VALUES (?, ?, ?)',
      )
      .run(a.version.id, b.version.id, 'derived-from');

    const result = artifacts.ancestors(a.version.id, 8);
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('指向不存在版本的血缘边被跳过并报告', () => {
    // 让整次保存失败会连带丢掉已经算出来的结果
    const result = artifacts.save({
      filename: 'fig.png',
      content: buf('x'),
      code: 'plot()',
      inputVersionIds: ['av_does-not-exist'],
    });
    expect(result.version.id).toBeTruthy();
    expect(result.reproducibilityGap).toContain('av_does-not-exist');
  });
});

describe('删除与恢复（需求 6.7）', () => {
  it('软删除后不在默认列表里，但版本仍在', () => {
    // 物理删除会让引用它的版本失去追溯路径。空间可回收，血缘断了补不回来
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    expect(artifacts.softDelete([result.artifact.id])).toBe(1);

    expect(artifacts.listArtifacts()).toHaveLength(0);
    expect(artifacts.listArtifacts({ includeDeleted: true })).toHaveLength(1);
    expect(artifacts.listVersions(result.artifact.id)).toHaveLength(1);
  });

  it('恢复后回到列表且 refcount 复原', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    const sha = result.version.blobSha256;

    artifacts.softDelete([result.artifact.id]);
    expect(artifacts.blobs.get(sha)?.refcount).toBe(0);

    expect(artifacts.restore(result.artifact.id)).toBe(true);
    expect(artifacts.listArtifacts()).toHaveLength(1);
    expect(artifacts.blobs.get(sha)?.refcount).toBe(1);
  });

  it('重复删除返回 0', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    artifacts.softDelete([result.artifact.id]);
    expect(artifacts.softDelete([result.artifact.id])).toBe(0);
  });

  it('恢复未删除的制品返回 false', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    expect(artifacts.restore(result.artifact.id)).toBe(false);
  });

  it('describeDeletion 报出被依赖数', () => {
    // 删掉被引用的制品会让那些版本的血缘断掉，用户要在点同意前知道
    const input = artifacts.save({ filename: 'data.csv', content: buf('d'), code: 'x' });
    artifacts.save({
      filename: 'fig.png',
      content: buf('f'),
      code: 'plot()',
      inputVersionIds: [input.version.id],
    });

    const described = artifacts.describeDeletion([input.artifact.id]);
    expect(described[0]).toMatchObject({ filename: 'data.csv', dependentCount: 1 });
  });

  it('同批删除的内部依赖不计入被依赖数', () => {
    const input = artifacts.save({ filename: 'data.csv', content: buf('d'), code: 'x' });
    const fig = artifacts.save({
      filename: 'fig.png',
      content: buf('f'),
      code: 'plot()',
      inputVersionIds: [input.version.id],
    });

    // 两个一起删，彼此的依赖不构成「删掉会影响别人」
    const described = artifacts.describeDeletion([input.artifact.id, fig.artifact.id]);
    expect(described.find((d) => d.filename === 'data.csv')?.dependentCount).toBe(0);
  });

  it('describeDeletion 统计版本数与总字节', () => {
    const v1 = artifacts.save({ filename: 'a.txt', content: buf('11111'), code: 'x' });
    artifacts.save({
      artifactId: v1.artifact.id,
      filename: 'a.txt',
      content: buf('2222222222'),
      code: 'x',
    });

    const described = artifacts.describeDeletion([v1.artifact.id]);
    expect(described[0]?.versionCount).toBe(2);
    expect(described[0]?.totalBytes).toBe(15);
  });

  it('不存在的制品被跳过', () => {
    expect(artifacts.describeDeletion(['af_nope'])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * {{artifact:VERSION_ID}} 标记（需求 6.5）
 * ------------------------------------------------------------------ */

const VALID_ID = 'av_1f2e3d4c-5b6a-7980-abcd-567890abcdef';

describe('标记识别', () => {
  it('找出全部出现处', () => {
    const code = `a = "{{artifact:${VALID_ID}}}"\nb = "{{artifact:${VALID_ID}}}"`;
    expect(findMarkers(code)).toHaveLength(2);
  });

  it('没有标记时返回空', () => {
    expect(findMarkers('print(1)')).toEqual([]);
  });

  it('取出大括号内的 id 部分', () => {
    expect(findMarkers(`x = "{{artifact:${VALID_ID}}}"`)[0]?.rawId).toBe(VALID_ID);
  });
});

describe('标记解析', () => {
  const resolveTo = (path: string) => ({ resolve: () => path, language: 'python' as const });

  it('字面量 UUID 解析成功', () => {
    const result = resolveMarkers(`df = pd.read_csv("{{artifact:${VALID_ID}}}")`, {
      ...resolveTo('D:\\proj\\blobs\\ab\\abc'),
    });
    expect(result.rejected).toEqual([]);
    expect(result.resolved).toBe(1);
    expect(result.code).toContain('D:/proj/blobs/ab/abc');
    expect(result.referencedVersionIds).toEqual([VALID_ID]);
  });

  it('兼容裸 UUID（用户手工粘贴）', () => {
    const bare = VALID_ID.slice(3);
    const result = resolveMarkers(`x = "{{artifact:${bare}}}"`, resolveTo('/p/a'));
    expect(result.rejected).toEqual([]);
    expect(result.referencedVersionIds).toEqual([VALID_ID]);
  });

  it('f-string 拼接被拒并给出可执行提示', () => {
    // 解析发生在执行之前，此时变量还没有值。放过去的话内核会拿到一个不存在的
    // 路径并报 FileNotFoundError，那个提示完全不指向真正的原因
    const result = resolveMarkers('x = f"{{artifact:{vid}}}"', resolveTo('/p/a'));
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('变量拼接');
    expect(result.rejected[0]?.reason).toContain('字面量');
    // 提示要说清怎么改
    expect(result.rejected[0]?.reason).toContain('先用工具查出版本 id');
  });

  it('模板字符串拼接被拒', () => {
    const result = resolveMarkers('const x = `{{artifact:${vid}}}`', resolveTo('/p/a'));
    expect(result.rejected).toHaveLength(1);
  });

  it('格式化占位符被拒', () => {
    const result = resolveMarkers('x = "{{artifact:%s}}" % vid', resolveTo('/p/a'));
    expect(result.rejected).toHaveLength(1);
  });

  it('非 UUID 的字面量被拒并提示如何查 id', () => {
    const result = resolveMarkers('x = "{{artifact:my-figure}}"', resolveTo('/p/a'));
    expect(result.rejected[0]?.reason).toContain('不是合法的版本 id');
    expect(result.rejected[0]?.reason).toContain('列出制品');
  });

  it('空 id 被拒', () => {
    expect(resolveMarkers('x = "{{artifact:}}"', resolveTo('/p/a')).rejected).toHaveLength(1);
  });

  it('版本不存在时报可执行原因', () => {
    const result = resolveMarkers(`x = "{{artifact:${VALID_ID}}}"`, {
      resolve: () => null,
      language: 'python',
    });
    expect(result.rejected[0]?.reason).toContain('已被删除');
  });

  it('有任何拒绝项时不做部分替换', () => {
    // 部分替换会让代码进入半解析状态，执行后只暴露其中一个问题，
    // 用户得来回修好几轮
    const code = `a = "{{artifact:${VALID_ID}}}"\nb = f"{{artifact:{v}}}"`;
    const result = resolveMarkers(code, resolveTo('/p/a'));
    expect(result.rejected).toHaveLength(1);
    expect(result.code).toBe(code);
    expect(result.resolved).toBe(0);
  });

  it('同一 id 多处出现只记一次引用', () => {
    const code = `a = "{{artifact:${VALID_ID}}}"\nb = "{{artifact:${VALID_ID}}}"`;
    const result = resolveMarkers(code, resolveTo('/p/a'));
    expect(result.resolved).toBe(2);
    expect(result.referencedVersionIds).toEqual([VALID_ID]);
  });

  it('无标记时原样返回', () => {
    const result = resolveMarkers('print(1)', resolveTo('/p/a'));
    expect(result.code).toBe('print(1)');
    expect(result.resolved).toBe(0);
  });
});

describe('路径转义', () => {
  it('Python 用正斜杠', () => {
    // 反斜杠在 Python 字符串里是转义字符：D:\proj\a.png 会得到 \p 与 \a
    // （后者是响铃字符），报的错是「找不到 D:proja.png」，完全不指向原因
    expect(escapePath('D:\\proj\\a.png', 'python')).toBe('D:/proj/a.png');
  });

  it('R 同样用正斜杠', () => {
    expect(escapePath('D:\\proj\\a.png', 'r')).toBe('D:/proj/a.png');
  });

  it('shell 转义反引号', () => {
    expect(escapePath('D:\\a`b', 'shell')).toBe('D:\\a``b');
  });

  it('raw 不做处理', () => {
    expect(escapePath('D:\\a', 'raw')).toBe('D:\\a');
  });
});

describe('标记与真实制品联通', () => {
  it('解析出的路径能读到内容', () => {
    const saved = artifacts.save({ filename: 'data.csv', content: buf('a,b\n1,2'), code: 'x' });
    const result = resolveMarkers(`df = pd.read_csv("{{artifact:${saved.version.id}}}")`, {
      resolve: (id) => artifacts.versionPath(id),
      language: 'python',
    });

    expect(result.rejected).toEqual([]);
    const path = result.code.match(/"([^"]+)"/)?.[1] ?? '';
    expect(readFileSync(path, 'utf8')).toBe('a,b\n1,2');
  });

  it('已删除制品的版本仍能解析（软删除保留内容）', () => {
    const saved = artifacts.save({ filename: 'data.csv', content: buf('x'), code: 'y' });
    artifacts.softDelete([saved.artifact.id]);

    // 软删除只是标记，版本与 blob 仍在，因此历史代码里的标记不会突然失效
    const result = resolveMarkers(`x = "{{artifact:${saved.version.id}}}"`, {
      resolve: (id) => artifacts.versionPath(id),
      language: 'python',
    });
    expect(result.rejected).toEqual([]);
  });
});

describe('回收内容但保留血缘（调试中发现的设计冲突）', () => {
  it('GC 后版本行与血缘边仍在', () => {
    // 软删除刻意保留 artifact_versions（血缘不能断），而版本行的外键指向
    // blobs。最初的实现直接 DELETE blobs 行，撞 FOREIGN KEY constraint
    // failed，空间根本回收不了
    const input = artifacts.save({ filename: 'data.csv', content: buf('d'), code: 'x' });
    const fig = artifacts.save({
      filename: 'fig.png',
      content: buf('f'),
      code: 'plot()',
      inputVersionIds: [input.version.id],
    });

    artifacts.softDelete([input.artifact.id]);
    const gc = artifacts.blobs.collectGarbage({ minAgeMs: 0 });
    expect(gc.removed).toContain(input.version.blobSha256);

    // 血缘仍能追溯——这正是不删行的理由
    expect(artifacts.ancestors(fig.version.id).map((a) => a.filename)).toEqual(['data.csv']);
    expect(artifacts.getVersion(input.version.id)).not.toBeNull();
  });

  it('GC 后 blob 行保留并标记为已回收', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    artifacts.softDelete([result.artifact.id]);
    artifacts.blobs.collectGarbage({ minAgeMs: 0 });

    expect(artifacts.blobs.get(result.version.blobSha256)).not.toBeNull();
    expect(artifacts.blobs.isEvicted(result.version.blobSha256)).toBe(true);
  });

  it('已回收的 blob 不会被反复处理', () => {
    // 不排除的话每次 GC 都重复计数，看起来一直在回收空间而实际什么都没发生
    const result = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    artifacts.softDelete([result.artifact.id]);

    expect(artifacts.blobs.collectGarbage({ minAgeMs: 0 }).removed).toHaveLength(1);
    expect(artifacts.blobs.collectGarbage({ minAgeMs: 0 }).removed).toHaveLength(0);
  });

  it('区分主动回收与意外丢失', () => {
    // 两者含义完全不同：前者是用户删了制品之后的预期结果，后者是数据损坏。
    // 都返回 null 会让后者被当成前者忽略过去
    const evicted = artifacts.save({ filename: 'a.txt', content: buf('a'), code: 'x' });
    artifacts.softDelete([evicted.artifact.id]);
    artifacts.blobs.collectGarbage({ minAgeMs: 0 });

    const lost = artifacts.save({ filename: 'b.txt', content: buf('b'), code: 'x' });
    rmSync(artifacts.blobs.absolutePath(lost.version.blobSha256));

    const evictedResult = artifacts.readVersionDetailed(evicted.version.id);
    expect(evictedResult.state).toBe('evicted');
    expect(evictedResult).toHaveProperty('reason', expect.stringContaining('血缘记录仍然完整'));

    const lostResult = artifacts.readVersionDetailed(lost.version.id);
    expect(lostResult.state).toBe('missing');
    expect(lostResult).toHaveProperty('reason', expect.stringContaining('数据损坏'));
  });

  it('内容完好时正常读出', () => {
    const result = artifacts.save({ filename: 'a.txt', content: buf('内容'), code: 'x' });
    const read = artifacts.readVersionDetailed(result.version.id);
    expect(read.state).toBe('ok');
    expect(read).toHaveProperty('content');
  });

  it('版本不存在与内容缺失是两种状态', () => {
    expect(artifacts.readVersionDetailed('av_nope').state).toBe('not-found');
  });
});

describe('标记正则能看见写错的形式（调试中发现的 bug）', () => {
  it('f-string 形式能被匹配到', () => {
    // 最初写成 [^{}]* 排除大括号，结果这种形式根本匹配不到，
    // 于是它绕过全部校验带着字面文本进内核
    expect(findMarkers('x = f"{{artifact:{vid}}}"')).toHaveLength(1);
  });

  it('模板字符串形式能被匹配到', () => {
    expect(findMarkers('const x = `{{artifact:${vid}}}`')).toHaveLength(1);
  });

  it('标记不跨行匹配', () => {
    // 跨行会让一个漏写右括号的标记吞掉后面几十行代码
    const code = '{{artifact:abc\nimport os\nos.remove("x")}}';
    expect(findMarkers(code)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * save_artifacts / delete_artifacts 工具（任务 7.3、7.5）
 * ------------------------------------------------------------------ */

describe('save_artifacts 工具（需求 6.3、6.6）', () => {
  const ctx = () => ({ projectId: project.projectId, conversationId: 'c1', workspaceDir: root });
  const tool = () =>
    createSaveArtifactsTool({
      store: artifacts,
      resolvePath: (raw) => join(root, raw),
      currentToolCallId: () => 'tc_1',
    });

  beforeEach(() => {
    writeFileSync(join(root, 'fig.png'), 'png bytes');
    writeFileSync(join(root, 'table.csv'), 'a,b\n1,2');
  });

  it('提升文件为制品并记录工具调用 id', async () => {
    const result = await tool().execute({ paths: ['table.csv'], code: 'df.to_csv()' }, ctx());
    expect(result.ok).toBe(true);

    const saved = artifacts.listArtifacts();
    expect(saved).toHaveLength(1);
    expect(artifacts.listVersions(saved[0]?.id ?? '')[0]?.createdByToolCallId).toBe('tc_1');
  });

  it('图缺代码时报出血缘缺口，但仍然保存', async () => {
    // 缺口不是错误——文件还是要存下来的，只是 Reviewer 会据此提出发现
    const result = await tool().execute({ paths: ['fig.png'] }, ctx());
    expect(result.ok).toBe(true);
    const text = (result.output as { text: string }).text;
    expect(text).toContain('血缘不完整');
    expect(text).toContain('Reviewer');
  });

  it('图有代码有输入时不报缺口', async () => {
    const input = artifacts.save({ filename: 'data.csv', content: buf('d'), code: 'x' });
    const result = await tool().execute(
      { paths: ['fig.png'], code: 'plt.plot()', inputVersionIds: [input.version.id] },
      ctx(),
    );
    expect((result.output as { text: string }).text).not.toContain('血缘不完整');
  });

  it('去重命中时在输出里说明', async () => {
    await tool().execute({ paths: ['table.csv'], code: 'x' }, ctx());
    writeFileSync(join(root, 'copy.csv'), 'a,b\n1,2');
    const result = await tool().execute({ paths: ['copy.csv'], code: 'x' }, ctx());
    expect((result.output as { text: string }).text).toContain('未重复占用空间');
  });

  it('指定 artifactId 时产生新版本', async () => {
    const first = await tool().execute({ paths: ['table.csv'], code: 'x' }, ctx());
    expect(first.ok).toBe(true);
    const artifactId = artifacts.listArtifacts()[0]?.id ?? '';

    writeFileSync(join(root, 'table.csv'), 'a,b\n3,4');
    await tool().execute({ paths: ['table.csv'], code: 'y', artifactId }, ctx());

    expect(artifacts.listArtifacts()).toHaveLength(1);
    expect(artifacts.listVersions(artifactId)).toHaveLength(2);
  });

  it('artifactId 配多个文件被拒', () => {
    // 一个制品的一个版本对应一份内容，多文件配一个 id 是对版本语义的误解
    expect(() => tool().parseInput({ paths: ['a.csv', 'b.csv'], artifactId: 'af_1' })).toThrow(
      /只能保存一个文件/,
    );
  });

  it('文件不存在时提示确认代码真的写出来了', async () => {
    const result = await tool().execute({ paths: ['nope.csv'], code: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect((result.output as { text: string }).text).toContain('确认代码真的把它写出来了');
  });

  it('目录被拒并给出替代做法', async () => {
    const result = await tool().execute({ paths: ['.'], code: 'x' }, ctx());
    expect((result.output as { text: string }).text).toContain('先打包');
  });

  it('部分成功时仍保存成功的那些', async () => {
    const result = await tool().execute({ paths: ['table.csv', 'nope.csv'], code: 'x' }, ctx());
    expect(result.ok).toBe(true);
    expect(artifacts.listArtifacts()).toHaveLength(1);
  });

  it('空 paths 被拒', () => {
    expect(() => tool().parseInput({ paths: [] })).toThrow(/非空数组/);
  });

  it('工具描述明确要求图表提供代码', () => {
    // 这个要求要让模型看见，否则它不会主动传 code
    expect(tool().description).toContain('必须提供 code');
  });
});

describe('delete_artifacts 工具（需求 6.7）', () => {
  const ctx = () => ({ projectId: project.projectId, conversationId: 'c1', workspaceDir: root });

  function setupDelete() {
    const published: import('@l-science/shared').ApprovalRequest[] = [];
    const approvals = new ApprovalService({
      repo: new ApprovalRepo(project.db),
      publish: (r) => published.push(r),
    });
    const tool = createDeleteArtifactsTool({ store: artifacts, approvals });
    return { published, approvals, tool };
  }

  it('阻塞在审批上，列出待删条目', async () => {
    const target = artifacts.save({ filename: 'fig.png', content: buf('x'), code: 'y' });
    const { published, approvals, tool } = setupDelete();

    const pending = tool.execute({ artifactIds: [target.artifact.id] }, ctx());
    expect(published).toHaveLength(1);
    // 只说「3 个制品」不够，用户需要看到文件名才能判断是不是他想删的
    expect(published[0]?.detail).toContain('fig.png');
    expect(published[0]?.title).toContain('删除 1 个制品');

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(artifacts.listArtifacts()).toHaveLength(0);
    approvals.close();
  });

  it('卡片说明血缘会断掉', async () => {
    const input = artifacts.save({ filename: 'data.csv', content: buf('d'), code: 'x' });
    artifacts.save({
      filename: 'fig.png',
      content: buf('f'),
      code: 'plot()',
      inputVersionIds: [input.version.id],
    });
    const { published, approvals, tool } = setupDelete();

    const pending = tool.execute({ artifactIds: [input.artifact.id] }, ctx());
    // 这是删除最要紧的后果：血缘断掉的图在论文里就不可用了
    expect(published[0]?.impact).toContain('血缘会断掉');
    expect(published[0]?.detail).toContain('有 1 个其他版本依赖它');

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await pending;
    approvals.close();
  });

  it('拒绝后不删任何东西', async () => {
    const target = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    const { published, approvals, tool } = setupDelete();

    const pending = tool.execute({ artifactIds: [target.artifact.id] }, ctx());
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'deny', note: '还要用' });

    const result = await pending;
    expect(result.ok).toBe(false);
    expect((result.output as { text: string }).text).toContain('还要用');
    expect(artifacts.listArtifacts()).toHaveLength(1);
    approvals.close();
  });

  it('拒绝后重复请求被识别并阻止', async () => {
    const target = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    const { published, approvals, tool } = setupDelete();

    const first = tool.execute({ artifactIds: [target.artifact.id] }, ctx());
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    const second = await tool.execute({ artifactIds: [target.artifact.id] }, ctx());
    expect(published).toHaveLength(1);
    const text = (second.output as { text: string }).text;
    expect(text).toContain('不再重复询问');
    // 提示模型改换做法而不是换个说法再试
    expect(text).toContain('改问用户');
    approvals.close();
  });

  it('id 顺序不影响拒绝记忆的命中', async () => {
    const a = artifacts.save({ filename: 'a.txt', content: buf('a'), code: 'x' });
    const b = artifacts.save({ filename: 'b.txt', content: buf('b'), code: 'x' });
    const { published, approvals, tool } = setupDelete();

    const first = tool.execute({ artifactIds: [a.artifact.id, b.artifact.id] }, ctx());
    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'deny' });
    await first;

    // 载荷里的 id 已排序，因此换顺序仍是「同一请求」
    const second = await tool.execute({ artifactIds: [b.artifact.id, a.artifact.id] }, ctx());
    expect(published).toHaveLength(1);
    expect((second.output as { text: string }).text).toContain('不再重复询问');
    approvals.close();
  });

  it('制品都不存在时直接报错，不发审批', async () => {
    const { published, approvals, tool } = setupDelete();
    const result = await tool.execute({ artifactIds: ['af_nope'] }, ctx());
    expect(result.output).toMatchObject({ ename: 'ArtifactNotFound' });
    expect(published).toHaveLength(0);
    approvals.close();
  });

  it('卡片如实说明可逆的限度', async () => {
    const target = artifacts.save({ filename: 'a.txt', content: buf('x'), code: 'y' });
    const { published, approvals, tool } = setupDelete();

    const pending = tool.execute({ artifactIds: [target.artifact.id] }, ctx());
    expect(published[0]?.reversible).toBe(true);
    // 软删除可恢复，但被删期间无法建立血缘边，恢复后也补不回来
    expect(published[0]?.undoHint).toContain('补不回来');

    approvals.decide({ approvalId: published[0]?.id ?? '', decision: 'approve' });
    await pending;
    approvals.close();
  });

  it('字节数以人类可读形式展示', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(humanBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});

describe('拒绝清单格式化', () => {
  it('说明没有执行任何代码', () => {
    // 用户要立刻知道代码没跑，否则会以为只是部分失败
    const text = formatRejections([{ raw: '{{artifact:x}}', reason: '不合法' }]);
    expect(text).toContain('没有执行任何代码');
    expect(text).toContain('{{artifact:x}}');
  });
});
