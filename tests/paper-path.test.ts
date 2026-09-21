/**
 * 论文主路径：文献 / 断言 / 手稿必须是一等导航，并有 IPC 列表方法。
 * 后端工具已经存在；缺的是研究者找得到的视图。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRequest } from '@l-science/shared';

const APP = readFileSync(join('packages', 'ui', 'src', 'App.tsx'), 'utf8');

describe('paper path navigation', () => {
  it('home is 文献 and composer docks on the paper path', () => {
    expect(APP).toContain("useState<ViewId>('refs')");
    expect(APP).toContain('PRIMARY_NAV');
    expect(APP).toContain('app__dock');
    expect(APP).toContain('extractClaims');
    expect(APP).toContain('bindClaim');
    expect(APP).toContain('composerPlaceholder');
    expect(APP).toContain('dock-paper');
    expect(APP).toContain("label: '助手'");
    expect(APP).toContain('nav__group');
  });

  it('sidebar registers 文献 断言 手稿 as ready views', () => {
    expect(APP).toContain("id: 'refs'");
    expect(APP).toContain("label: '文献'");
    expect(APP).toContain("id: 'claims'");
    expect(APP).toContain("label: '断言'");
    expect(APP).toContain("id: 'manuscripts'");
    expect(APP).toContain("label: '手稿'");
    expect(APP).toContain('<RefsView');
    expect(APP).toContain('<ClaimsView');
    expect(APP).toContain('<ManuscriptsView');
  });

  it('empty chat offers DOI and claims next steps', () => {
    const chat = readFileSync(join('packages', 'ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    expect(chat).toContain('去文献贴 DOI');
    expect(chat).toContain('去断言');
  });

  it('refs view pastes identifiers into ref.resolve', () => {
    const refs = readFileSync(join('packages', 'ui', 'src', 'components', 'RefsView.tsx'), 'utf8');
    expect(refs).toContain('resolveRefs');
    expect(refs).toContain('splitIdentifiers');
    expect(refs).toContain('贴 DOI / PMID / 链接');
    expect(refs).toContain('rows={empty ? 8 : 3}');
    expect(refs).toContain('attempts');
    expect(refs).toContain('从本篇抽断言');
    expect(refs).toContain('ref-card');
  });

  it('manuscripts view blocks ready-to-submit copy when claims are unresolved', () => {
    const ms = readFileSync(
      join('packages', 'ui', 'src', 'components', 'ManuscriptsView.tsx'),
      'utf8',
    );
    expect(ms).toContain('listClaims');
    expect(ms).toContain('不能标为可投稿');
    expect(ms).toContain('getManuscript');
    // 手稿页必须是可写的编辑器，不只是编译报告查看器
    expect(ms).toContain('compileManuscript');
    expect(ms).toContain('manuscript-source');
    expect(ms).toContain('sourceMarkdown');
  });
});

describe('paper path IPC', () => {
  it('accepts ref.list, claim.list, manuscript.list', () => {
    for (const method of ['ref.list', 'claim.list', 'manuscript.list'] as const) {
      const parsed = parseRequest({ method, projectId: 'p1' });
      expect(parsed.ok, method).toBe(true);
    }
  });

  it('ui api wraps every paper-path IPC method', () => {
    const api = readFileSync(join('packages', 'ui', 'src', 'lib', 'api.ts'), 'utf8');
    const methods = [
      'claim.get',
      'claim.register',
      'claim.unbind',
      'claim.verify',
      'claim.confirm',
      'claim.close',
      'claim.reopen',
      'claim.delete',
      'ref.get',
      'ref.delete',
      'ref.merge',
      'ref.duplicates',
      'ref.fetchFulltext',
      'ref.assets',
      'ref.export',
      'manuscript.profiles',
      'manuscript.parse',
      'manuscript.history',
      'manuscript.delete',
      'citation.parse',
      'citation.verify',
      'citation.checks',
      'grant.list',
      'grant.revoke',
    ] as const;
    for (const method of methods) {
      expect(api, method).toContain(`method: '${method}'`);
    }
  });
});

describe('composer gates on enabled models', () => {
  it('App counts enabled models and passes enabledModelCount to the composer gate', () => {
    // Given: App.tsx source (composerBlockedReason input is a type contract)
    // When / Then: gate on enabled models, not provider rows; first-run overlay stays on providers
    expect(APP).toContain('enabledModelCount');
    expect(APP).toContain('listModels');
    expect(APP).toContain('enabled === true');
    const gateCall = /composerBlockedReason\(\{[\s\S]*?\n  \}\);/.exec(APP);
    expect(gateCall?.[0]).toContain('enabledModelCount');
    expect(gateCall?.[0]).not.toContain('providerCount');
    expect(APP).toContain('shouldShowFirstRun({ providerCount');
  });
});

describe('project load survives a slow backend', () => {
  it('does not call listProjects once on mount without waiting for backend ready', () => {
    // Given: App.tsx source
    // When / Then: empty-deps listProjects is the first-run dead end
    expect(APP).not.toMatch(/void listProjects\(\)\.then\([\s\S]*?\}, \[\]\);/);
    expect(APP).toContain('projectLoadError');
    expect(APP).toContain('loadProjects');
  });
});

describe('extract-claims never fails silently', () => {
  it('does not swallow extract errors with a bare catch or silent send', () => {
    // Given: App.tsx extract handler
    // When / Then: failures are visible; zero claims is a status, not a chat prompt
    expect(APP).not.toMatch(/catch \{/);
    expect(APP).toContain('extractError');
    expect(APP).toContain('err.message');
    expect(APP).toContain('extractStatus');
    expect(APP).not.toContain('EXTRACT_CLAIMS_PROMPT');
    expect(APP).toContain('ref.doi !== null');
  });
});

describe('ClaimsView pass-through', () => {
  it('forwards onGoToRefs to ClaimsView', () => {
    expect(APP).toContain(
      "{view === 'claims' && <ClaimsView projectId={projectId} onGoToRefs={() => setView('refs')} />}",
    );
  });
});
