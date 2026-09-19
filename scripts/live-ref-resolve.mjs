/**
 * 实机：临时数据目录里对真实 DOI 走 RefLibrary.addMany（Crossref 等上游）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AppStore,
  ArtifactStore,
  RefLibrary,
  RefsRepo,
  citeLine,
} from '../packages/core/dist/index.js';

const dois = ['10.1038/s41586-021-03819-2'];

async function main() {
  process.stdout.write('live-ref-resolve start\n');
  const root = mkdtempSync(join(tmpdir(), 'lsci-live-ref-'));
  const store = AppStore.open(root);
  let failed = 0;
  try {
    const created = store.createProject({ name: 'live-ref' });
    const project = store.openProject(created.id);
    const artifacts = new ArtifactStore(project.db, project.paths.blobs);
    const library = new RefLibrary({
      repo: new RefsRepo(project.db),
      artifacts,
      http: { sources: ['crossref'], timeoutMs: 20_000 },
      authorizeHosts: async (hosts) => hosts,
      onLog: (line) => process.stderr.write(`${line}\n`),
    });

    const result = await library.addMany(dois);
    for (const o of result.outcomes) {
      const cite = o.ref === null ? '' : citeLine(o.ref.csl);
      const ok = o.ok && o.ref !== null;
      if (!ok) failed += 1;
      process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  ${o.input}  created=${String(o.created)}  ${cite || o.reason || ''}\n`,
      );
    }
    process.stdout.write(`created=${String(result.created)} failed=${String(result.failed)}\n`);
    if (result.created < 1 || failed === dois.length) process.exitCode = 1;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
