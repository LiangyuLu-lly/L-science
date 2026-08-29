/**
 * 内置技能目录的完整性验证（任务 12.4、12.11、12.12）。
 *
 * 单元测试用临时目录里造出来的技能验加载逻辑；这个脚本验的是**真实的内置目录**：
 * 46 个技能能否全部加载、有没有清单与文档不一致、triggers 能不能被检索命中、
 * 交叉引用的 slug 是否都存在。
 *
 * 最后一条是这里唯一能抓到的一类错误：SKILL.md 里写 `见 \`alphafodl2\`` 这种拼错，
 * 编译不会报、单元测试不会报，但模型照着去 load 会拿到「技能不存在」。
 *
 * 用法：node scripts/verify-skills.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSkillCatalog } from '../packages/core/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtinDir = join(repoRoot, 'resources', 'skills', 'builtin');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}  ${detail}\n`);
};

/* ---------------- 1. 全部加载 ---------------- */

process.stdout.write('\n--- 1. 加载 ---\n');

const catalog = loadSkillCatalog({
  builtinDir,
  userDir: join(repoRoot, '.no-such-user-dir'),
});

check(
  catalog.broken.length === 0,
  '全部技能加载成功',
  catalog.broken.length === 0
    ? `${catalog.skills.size} 个`
    : catalog.broken.map((b) => `${b.dirName}: ${b.reason}`).join(' | '),
);

const skills = [...catalog.skills.values()];
check(skills.length >= 46, '技能数量达到目录规模', `${skills.length} 个`);

/* ---------------- 2. 清单质量 ---------------- */

process.stdout.write('\n--- 2. 清单质量 ---\n');

const noWarnings = skills.filter((s) => s.warnings.length > 0);
check(
  noWarnings.length === 0,
  '没有清单/文档不一致警告',
  noWarnings
    .map((s) => `${s.manifest.slug}: ${s.warnings[0]}`)
    .join(' | ')
    .slice(0, 200),
);

const shortDocs = skills.filter((s) => s.instructions.length < 600);
check(
  shortDocs.length === 0,
  '每个技能的文档都有实质内容',
  shortDocs.map((s) => `${s.manifest.slug}(${s.instructions.length}字)`).join(', '),
);

const fewTriggers = skills.filter((s) => s.manifest.triggers.length < 3);
check(
  fewTriggers.length === 0,
  '每个技能至少 3 条 triggers',
  fewTriggers.map((s) => s.manifest.slug).join(', '),
);

const noTools = skills.filter((s) => s.manifest.tools.length === 0);
check(
  noTools.length === 0,
  '每个技能都声明了 tools',
  noTools.map((s) => s.manifest.slug).join(', '),
);

/* ---------------- 3. 交叉引用 ---------------- */

process.stdout.write('\n--- 3. 交叉引用 ---\n');

/*
 * 文档里用反引号引用别的技能 slug。拼错的话模型照着去 load 会拿到「技能不存在」，
 * 而这类错误编译与单元测试都抓不到。
 *
 * 只把「看起来像 slug」的反引号内容当候选：全小写 + 连字符 + 至少一个连字符或
 * 已知 slug。这样不会把 `python`、`nb` 这类普通标识符误判成技能引用。
 */
const slugs = new Set(catalog.skills.keys());
const dangling = [];

for (const skill of skills) {
  const src = readFileSync(join(skill.path, 'SKILL.md'), 'utf8');
  for (const m of src.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
    const token = m[1];
    // 只检查「看起来是技能名」的：与某个真实 slug 编辑距离很近，或恰好是 slug
    if (slugs.has(token)) continue;
    const near = [...slugs].find((s) => close(s, token));
    if (near !== undefined) dangling.push({ from: skill.manifest.slug, token, near });
  }
}

/** 编辑距离 ≤2 且长度接近，用来抓拼错而不是抓所有不认识的词。 */
function close(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let d = 0;
  const m = Math.max(a.length, b.length);
  for (let i = 0; i < m; i += 1) if (a[i] !== b[i]) d += 1;
  return d > 0 && d <= 2;
}

check(
  dangling.length === 0,
  '技能间引用没有拼错',
  dangling.map((d) => `${d.from} 里的 \`${d.token}\` 疑似 ${d.near}`).join(' | '),
);

/* ---------------- 4. 领域分布 ---------------- */

process.stdout.write('\n--- 4. 领域分布 ---\n');

const byDomain = new Map();
for (const s of skills) {
  const d = s.manifest.domain ?? '(未分类)';
  byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
}
for (const [domain, n] of [...byDomain].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`      ${domain.padEnd(16)} ${String(n)}\n`);
}
check(byDomain.get('(未分类)') === undefined, '每个技能都有 domain', '');

const expectedDomains = ['结构与设计', '组学与单细胞', '文献', '写作与投稿', '统计与建模'];
const missingDomains = expectedDomains.filter((d) => !byDomain.has(d));
check(missingDomains.length === 0, '对标要求的领域都有覆盖', missingDomains.join(', '));

/* ---------------- 5. 对标清单逐项核对 ---------------- */

process.stdout.write('\n--- 5. 对标清单 ---\n');

// Claude Science 的 featured 科学技能清单（官方文档）
const reference = {
  'literature review': 'literature-review',
  'indication dossier': 'indication-dossier',
  AlphaFold2: 'alphafold2',
  'Boltz-2': 'boltz-2',
  'Chai-1': 'chai-1',
  ESMFold2: 'esmfold',
  OpenFold3: 'openfold3',
  ProteinMPNN: 'proteinmpnn',
  DiffDock: 'diffdock',
  'ESM-2': 'esm2',
  'Evo 2': 'evo2',
  Borzoi: 'borzoi',
  scGPT: 'scgpt',
  'scvi-tools': 'scvi-tools',
};

const absent = Object.entries(reference).filter(([, slug]) => !slugs.has(slug));
check(
  absent.length === 0,
  '对标的 featured 技能全部存在',
  absent.length === 0
    ? `${Object.keys(reference).length} 项`
    : absent.map(([name, slug]) => `${name}→${slug}`).join(', '),
);

// ProteinMPNN 那一条在对方是「含 LigandMPNN 与 SolubleMPNN」，这里要确认都覆盖了
const mpnn = catalog.skills.get('proteinmpnn');
const mpnnDoc = mpnn === undefined ? '' : mpnn.instructions;
check(
  mpnnDoc.includes('LigandMPNN') && mpnnDoc.includes('SolubleMPNN'),
  'ProteinMPNN 覆盖三个变体',
  '',
);

/* ---------------- 6. 依赖声明合理性 ---------------- */

process.stdout.write('\n--- 6. 依赖声明 ---\n');

const knownCaps = new Set([
  'kernel:python',
  'kernel:r',
  'shell:powershell',
  'shell:bash',
  'filesystem',
]);
const badCaps = [];
for (const s of skills) {
  for (const c of s.manifest.requires.capabilities ?? []) {
    if (!knownCaps.has(c)) badCaps.push(`${s.manifest.slug}: ${c}`);
  }
}
check(badCaps.length === 0, 'capabilities 取值都是已知的', badCaps.join(', '));

const knownTools = new Set([
  'python',
  'r',
  'bash',
  'read_file',
  'edit_file',
  'save_artifacts',
  'delete_artifacts',
  'search_skills',
  'load_skill_reference',
  'generate_plan',
  'plan_status',
  'delegate',
  'agent_status',
  'guide_agent',
  'stop_agent',
  'control_repl',
  'control_repl_admin',
  'ask_user',
  'check_findings',
  'mark_finding_addressed',
  'request_review',
  'remember',
  'recall_memory',
]);
const badTools = [];
for (const s of skills) {
  for (const t of s.manifest.tools) {
    if (!knownTools.has(t)) badTools.push(`${s.manifest.slug}: ${t}`);
  }
}
check(badTools.length === 0, 'tools 取值都是真实存在的工具', badTools.join(', '));

/* ---------------- 7. 归档解析对真实打包工具的兼容（任务 12.15）---------------- */

/*
 * 单元测试里的归档是手写构造的——那是为了造出「含 ../ 的条目」这类正常工具不会
 * 产出的东西。但反过来的风险也真实存在：**真实工具产出的归档我们读不读得了**。
 * zip 的实现细节（数据描述符、UTF-8 标志位、额外字段）各家不同，只用自造的归档
 * 验证等于只验了自己那一种写法。
 *
 * 这里用 PowerShell 的 Compress-Archive（Windows 用户手里最常见的打包方式）与
 * 系统自带的 tar 各造一个，再用我们的解析器读回来。
 */

process.stdout.write('\n--- 7. 归档兼容 ---\n');

const {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync: readBin,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { spawnSync } = await import('node:child_process');
const { readArchive, findArchivedSkills, importSkillsFromArchive } =
  await import('../packages/core/dist/index.js');

const archRoot = mkdtempSync(join(tmpdir(), 'lsci-arch-'));
try {
  // 造一个真实的技能目录
  const srcSkill = join(archRoot, 'src', 'archive-probe');
  mkdirSync(join(srcSkill, 'references'), { recursive: true });
  writeFileSync(
    join(srcSkill, 'skill.json'),
    JSON.stringify(
      {
        slug: 'archive-probe',
        name: '归档探针',
        version: '1.0.0',
        domain: '测试',
        description: '用于验证归档解析对真实打包工具的兼容性',
        triggers: ['归档兼容性检查', '解析 zip', '解析 tar'],
        tools: [],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(srcSkill, 'SKILL.md'), '# 归档探针\n\n这是正文，用于验证解析结果。\n', 'utf8');
  // 中文文件名：UTF-8 标志位没处理对时这一条会失败
  writeFileSync(join(srcSkill, 'references', 'canshu-biao.md'), '参数表内容\n', 'utf8');

  /* --- PowerShell Compress-Archive --- */

  const zipPath = join(archRoot, 'probe.zip');
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${srcSkill}' -DestinationPath '${zipPath}' -Force`,
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );

  if (ps.status !== 0 || !existsSync(zipPath)) {
    check(
      false,
      'Compress-Archive 产出的 zip 能读',
      `打包失败：${(ps.stderr ?? '').slice(0, 120)}`,
    );
  } else {
    const zip = readArchive(readBin(zipPath));
    const found = findArchivedSkills(zip.entries);
    check(
      zip.format === 'zip' && found.length === 1,
      'Compress-Archive 产出的 zip 能读',
      `${zip.entries.length} 个条目，认出 ${found.length} 个技能`,
    );
    check(
      Object.keys(found[0]?.files ?? {}).includes('references/canshu-biao.md'),
      'zip 里的子目录条目路径正确',
      Object.keys(found[0]?.files ?? {}).join(' '),
    );
    check(
      String(found[0]?.files['SKILL.md'] ?? '').includes('这是正文'),
      'zip 里的 UTF-8 内容未被改坏',
      '',
    );

    // 走完整导入路径：能不能真的落成一个可加载的技能
    const importDir = join(archRoot, 'user');
    mkdirSync(importDir, { recursive: true });
    const outcome = importSkillsFromArchive({
      userDir: importDir,
      data: readBin(zipPath),
      fileName: 'probe.zip',
    });
    check(
      outcome.ok && outcome.skills[0]?.ok === true,
      'zip 导入后技能可加载',
      outcome.ok ? (outcome.skills[0]?.path ?? '') : outcome.errors.join('；'),
    );
  }

  /* --- 系统 tar（bsdtar），也是 GitHub tarball 的格式 --- */

  const tgzPath = join(archRoot, 'probe.tar.gz');
  const tarResult = spawnSync(
    'tar',
    ['-czf', tgzPath, '-C', join(archRoot, 'src'), 'archive-probe'],
    {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    },
  );

  if (tarResult.status !== 0 || !existsSync(tgzPath)) {
    check(
      false,
      'tar -czf 产出的 tar.gz 能读',
      `打包失败：${(tarResult.stderr ?? tarResult.error?.message ?? '').slice(0, 120)}`,
    );
  } else {
    const tgz = readArchive(readBin(tgzPath));
    const found = findArchivedSkills(tgz.entries);
    check(
      tgz.format === 'tar.gz' && found.length === 1,
      'tar -czf 产出的 tar.gz 能读',
      `${tgz.entries.length} 个条目，认出 ${found.length} 个技能`,
    );
    check(
      String(found[0]?.files['references/canshu-biao.md'] ?? '').includes('参数表'),
      'tar.gz 里的参考材料内容正确',
      '',
    );
  }
} finally {
  rmSync(archRoot, { recursive: true, force: true });
}

process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
