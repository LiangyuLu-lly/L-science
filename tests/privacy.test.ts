/**
 * 隐私与遥测确认（任务 15.4，需求 20.6.1-20.6.3）。
 *
 * 这三条需求的共同点是**回退的时候没有信号**。加一个 Sentry SDK、把 `listen` 绑到
 * `0.0.0.0`、技能检索里多一次 `fetch`，界面和功能看起来都完全正常——用的人永远不会
 * 发现数据已经出网。也正因为如此，它们靠人工核对是守不住的：核对过一次的结论在
 * 下一个依赖加进来之后就失效了。
 *
 * 因此这里把能判定的部分变成断言。判不了的（某个传递依赖是否自己打点、模型供应商
 * 在服务端留不留日志）不在这张清单里。
 *
 * 需要说清的一点：这些断言不等于律师做的隐私审计，也不等于隐私认证。真正的合规
 * 判定需要专业人员评审，任何静态检查都只能覆盖其中机械可判的那部分。
 *
 * 范围外：`usage.ts` / `egress_log` 是本地成本审计，不是遥测；模型适配器与 MCP/连接器
 * 的 HTTP 是产品功能本身。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { appPaths, dataDir } from '@l-science/core';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CORE_SRC = join(REPO_ROOT, 'packages', 'core', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const TELEMETRY_PACKAGES: readonly string[] = [
  '@sentry/*',
  'sentry',
  'posthog-js',
  'posthog-node',
  'mixpanel',
  'mixpanel-browser',
  '@amplitude/*',
  'amplitude-js',
  '@segment/analytics-node',
  '@segment/analytics-next',
  'analytics-node',
  'applicationinsights',
  '@microsoft/applicationinsights-*',
  'newrelic',
  '@newrelic/*',
  'dd-trace',
  '@datadog/*',
  '@opentelemetry/sdk-*',
  '@opentelemetry/exporter-*',
  '@opentelemetry/instrumentation*',
  'logrocket',
  '@fullstory/*',
  '@openreplay/*',
  'bugsnag',
  '@bugsnag/*',
];

const REQUIRED_MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/ui/package.json',
  'packages/shell/package.json',
  'packages/kernel/package.json',
  'packages/adapters/package.json',
  'packages/shared/package.json',
] as const;

function posixRel(abs: string, from = REPO_ROOT): string {
  return relative(from, abs).split(sep).join('/');
}

function walkFiles(dir: string, want: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { encoding: 'utf8' })) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkFiles(abs, want));
    else if (want(name)) out.push(abs);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesDeny(name: string): boolean {
  for (const pattern of TELEMETRY_PACKAGES) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

function callArgs(text: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return text.slice(openParen + 1);
}

function braceBlock(text: string, openBrace: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openBrace; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBrace, i + 1);
    }
  }
  return text.slice(openBrace);
}

const MANIFESTS = walkFiles(REPO_ROOT, (name) => name === 'package.json').map((abs) =>
  posixRel(abs),
);

const BACKEND = readFileSync(join(CORE_SRC, 'backend.ts'), 'utf8');
const SEARCH = readFileSync(join(CORE_SRC, 'skills', 'search.ts'), 'utf8');

/* ------------------------------------------------------------------ *
 * 20.6.1 无遥测
 * ------------------------------------------------------------------ */

describe('无遥测（20.6.1）', () => {
  it('扫到了工作区全部 package.json', () => {
    // 扫描本身要能扫到东西，否则下一例会在遍历漏掉 packages/ 时静默通过
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(7);
    for (const rel of REQUIRED_MANIFESTS) expect(MANIFESTS).toContain(rel);
  });

  it('工作区 package.json 的 dependencies/devDependencies/optionalDependencies 不含遥测 SDK', () => {
    /*
     * 只看依赖对象的键。扫文件正文会把注释、脚本说明、甚至 `@opentelemetry/api`
     * 这种被明确排除的包名当成命中，而修不掉的告警最后会被整条关掉。
     * 不扫 peerDependencies，不扫 package-lock.json。
     */
    const offenders: string[] = [];
    for (const rel of MANIFESTS) {
      const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      if (!isRecord(parsed)) continue;
      for (const section of DEP_SECTIONS) {
        const deps = parsed[section];
        if (!isRecord(deps)) continue;
        for (const name of Object.keys(deps)) {
          if (matchesDeny(name)) offenders.push(`${rel}:${section}:${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 20.6.2 状态全本地
 * ------------------------------------------------------------------ */

describe('状态全本地（20.6.2）', () => {
  it('appPaths 的每个目录都落在 dataDir() 下面', () => {
    const root = dataDir();
    const paths = appPaths();
    expect(paths.root).toBe(root);
    const nested = Object.entries(paths).filter(([key]) => key !== 'root');
    expect(nested.length).toBeGreaterThan(0);
    for (const [key, value] of nested) {
      const relToRoot = relative(root, value);
      expect(
        relToRoot !== '' && !relToRoot.startsWith('..') && !isAbsolute(relToRoot),
        `${key} = ${value} 不在 dataDir()=${root} 下`,
      ).toBe(true);
    }
  });

  it('控制平面传输是 stdin/stdout 上的 NDJSON', () => {
    expect(BACKEND).toMatch(
      /new StdioTransport\(\{\s*input: process\.stdin,\s*output: process\.stdout/u,
    );
  });

  it('hostapi、egress-proxy、mcp bridge 只监听 127.0.0.1', () => {
    const found: string[] = [];
    const offenders: string[] = [];
    for (const abs of walkFiles(CORE_SRC, (name) => name.endsWith('.ts'))) {
      const text = readFileSync(abs, 'utf8');
      const rel = posixRel(abs, CORE_SRC);
      for (const m of text.matchAll(/\.listen\s*\(/gu)) {
        const args = callArgs(text, m.index + m[0].length - 1);
        found.push(rel);
        if (/0\.0\.0\.0/u.test(args)) {
          offenders.push(`${rel}:0.0.0.0`);
          continue;
        }
        if (!/127\.0\.0\.1/u.test(args)) {
          offenders.push(`${rel}:missing-host`);
          continue;
        }
        const allowed =
          rel === 'hostapi/server.ts' ||
          rel === 'mcp/bridge.ts' ||
          (rel === 'sandbox/egress-proxy.ts' && args.includes("host ?? '127.0.0.1'"));
        if (!allowed) offenders.push(`${rel}:unexpected-listen`);
      }
    }
    expect(found).toEqual(
      expect.arrayContaining(['hostapi/server.ts', 'mcp/bridge.ts', 'sandbox/egress-proxy.ts']),
    );
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 20.6.3 技能检索不出网
 * ------------------------------------------------------------------ */

describe('技能检索不出网（20.6.3）', () => {
  it('SkillSearchIndex 类体不含 fetch', () => {
    const classAt = SEARCH.indexOf('export class SkillSearchIndex');
    expect(classAt).toBeGreaterThanOrEqual(0);
    const body = braceBlock(SEARCH, SEARCH.indexOf('{', classAt));
    expect(body).not.toMatch(/\bfetch\s*\(/u);
  });

  it('packages/core/src/skills 里唯一的 fetch 是 createOllamaEmbedder 的 POST /api/embed', () => {
    const hits: string[] = [];
    for (const abs of walkFiles(join(CORE_SRC, 'skills'), (name) => name.endsWith('.ts'))) {
      const text = readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/\bfetch\s*\(/gu)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${posixRel(abs, join(CORE_SRC, 'skills'))}:${String(line)}`);
      }
    }
    expect(hits).toEqual(['search.ts:350']);
    expect(SEARCH).toMatch(
      /export function createOllamaEmbedder[\s\S]*?await fetch\(`\$\{base\}\/api\/embed`,\s*\{[\s\S]*?method: 'POST'/u,
    );
  });

  it('embedderNow 只在 adapter 为 ollama 且 baseUrl 非空时构造嵌入器', () => {
    const start = BACKEND.indexOf('const embedderNow');
    expect(start).toBeGreaterThanOrEqual(0);
    const fn = BACKEND.slice(start, BACKEND.indexOf('const skills = new SkillManager'));
    expect(fn).toContain(".find((p) => p.adapter === 'ollama' && p.baseUrl !== null)");
    expect(fn).toMatch(/return null/u);
    expect(fn).toContain('createOllamaEmbedder');
  });
});
