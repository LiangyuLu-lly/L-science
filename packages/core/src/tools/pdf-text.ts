/**
 * 按页抽取 PDF 文本。不引入 pdfjs：原生 zlib 解 FlateDecode，再扫 Tj/TJ。
 *
 * 覆盖科研里最常见的「数字出生」PDF。扫描件、CID 字体仍会抽空，那时 read_file
 * 返回空正文加页码，技能文档继续建议 python。
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export async function extractPdfPage(
  path: string,
  page: number,
): Promise<{ text: string; pageCount: number }> {
  const buf = readFileSync(path);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`${path} 不是 PDF`);
  }
  const src = buf.toString('latin1');
  const objects = parseObjects(src);
  const pages: number[] = [];
  for (const [id, body] of objects) {
    if (/\/Type\s*\/Page(?!\s*s)/u.test(body)) pages.push(id);
  }
  pages.sort((a, b) => a - b);
  const pageCount = pages.length;
  if (pageCount === 0 || page > pageCount) return { text: '', pageCount };

  const pageId = pages[page - 1];
  if (pageId === undefined) return { text: '', pageCount };
  const pageBody = objects.get(pageId) ?? '';
  const contentIds = contentObjectIds(pageBody);
  const chunks: string[] = [];
  for (const id of contentIds) {
    const body = objects.get(id);
    if (body === undefined) continue;
    chunks.push(pdfStrings(decodeStream(body)));
  }
  return { text: chunks.join('\n').trim(), pageCount };
}

function parseObjects(src: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/gu;
  for (const m of src.matchAll(re)) {
    const id = Number(m[1]);
    if (!Number.isFinite(id)) continue;
    map.set(id, m[2] ?? '');
  }
  return map;
}

function contentObjectIds(pageBody: string): readonly number[] {
  const bracket = pageBody.match(/\/Contents\s*\[([^\]]*)\]/u);
  const blob = bracket?.[1] ?? pageBody.match(/\/Contents\s+((?:\d+\s+0\s+R\s*)+)/u)?.[1];
  if (blob === undefined) return [];
  const ids: number[] = [];
  for (const m of blob.matchAll(/(\d+)\s+0\s+R/gu)) {
    ids.push(Number(m[1]));
  }
  return ids;
}

function decodeStream(objectBody: string): string {
  const marker = objectBody.search(/stream\r?\n/u);
  if (marker < 0) return objectBody;
  const start = objectBody.indexOf('\n', marker) + 1;
  const end = objectBody.lastIndexOf('endstream');
  if (end <= start) return '';
  const raw = Buffer.from(objectBody.slice(start, end), 'latin1');
  const dict = objectBody.slice(0, marker);
  if (!/\/FlateDecode/u.test(dict)) return raw.toString('latin1');
  try {
    return inflateSync(raw).toString('latin1');
  } catch (err: unknown) {
    if (err instanceof Error || (typeof err === 'object' && err !== null)) {
      throw new Error('PDF 流解压失败');
    }
    throw err;
  }
}

function unescapePdfString(raw: string): string {
  return raw.replace(/\\(\d{1,3}|[nrtbf()\\])/gu, (_whole, token: string) => {
    if (token === 'n') return '\n';
    if (token === 'r') return '\r';
    if (token === 't') return '\t';
    if (token === 'b') return '\b';
    if (token === 'f') return '\f';
    if (token === '(' || token === ')' || token === '\\') return token;
    return String.fromCharCode(Number.parseInt(token, 8));
  });
}

function pdfStrings(content: string): string {
  const parts: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)/gu;
  for (const m of content.matchAll(re)) {
    const inner = m[0].slice(1, -1);
    parts.push(unescapePdfString(inner));
  }
  return parts.join(' ');
}
