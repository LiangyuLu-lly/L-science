/**
 * 10 篇公开论文 DOI：打 Crossref 证明文献路径的上游活着。
 * 入库仍走应用内 ref.resolve（要项目与域名批准）。
 */

const DOIS = [
  '10.1038/nature14539',
  '10.1126/science.1260419',
  '10.1038/s41586-021-03819-2',
  '10.1038/s41586-020-2649-2',
  '10.1101/gr.092759.109',
  '10.1038/nbt.4314',
  '10.1038/s41592-019-0686-2',
  '10.1016/j.cell.2015.05.002',
  '10.1038/nature12373',
  '10.1038/s41587-019-0113-3',
];

const mailto = process.env.L_SCIENCE_MAILTO ?? 'l-science-eval@localhost';

let ok = 0;
for (const doi of DOIS) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': `L-science-eval/1.0 (mailto:${mailto})` },
  });
  const title =
    res.ok && res.headers.get('content-type')?.includes('json')
      ? (await res.json())?.message?.title?.[0]
      : null;
  const passed = res.ok && typeof title === 'string';
  if (passed) ok += 1;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${doi}  ${title ?? res.status}\n`);
}

if (ok < 8) {
  process.stderr.write(`只解析到 ${String(ok)}/10 篇，Crossref 或网络有问题。\n`);
  process.exit(1);
}
process.stdout.write(`OK  ${String(ok)}/10\n`);
