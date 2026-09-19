/**
 * 原生 PDF 按页抽取（论文主路径）。read_file 的 extractPdfPage 必须真能读出
 * 页面文字，pdf-explore 才能从目录拒绝名单里拿掉。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collapseSpacedLetters, extractPdfPage } from '@l-science/core';

/** 生成一页未压缩 PDF，正文是可抽取的 Tj 字符串。 */
export function uncompressedPdf(text: string): Buffer {
  const escaped = text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>\n',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\n',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}endstream\n`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [i, content] of objs.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${String(i + 1)} 0 obj\n${content}endobj\n`;
  }
  const xrefPos = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i += 1) {
    xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefPos)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('extractPdfPage', () => {
  it('page 1 returns the Tj text and pageCount 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsci-pdf-'));
    const path = join(dir, 'n.pdf');
    writeFileSync(path, uncompressedPdf('Hello L-science PDF'));

    const result = await extractPdfPage(path, 1);
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('Hello L-science PDF');
  });

  it('out-of-range page still reports pageCount so read_file can emit PageOutOfRange', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsci-pdf-'));
    const path = join(dir, 'n.pdf');
    writeFileSync(path, uncompressedPdf('only-one-page'));

    const result = await extractPdfPage(path, 9);
    expect(result.pageCount).toBe(1);
  });

  it('collapses per-glyph spaced letters', () => {
    expect(collapseSpacedLetters('A l p h a F o l d')).toBe('AlphaFold');
  });
});
