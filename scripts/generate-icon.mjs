#!/usr/bin/env node
/**
 * 生成 packages/shell/build/icon.png 与 icon.ico。
 *
 * 256×256，底 #111318，记号 #6aa9ff。无第三方依赖：PNG 用 zlib，ICO 内嵌 PNG。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const BG = [0x11, 0x13, 0x18, 0xff];
const FG = [0x6a, 0xa9, 0xff, 0xff];

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 左侧竖笔 + 底横笔，构成 L。 */
function inMark(x, y) {
  const thick = 36;
  const left = 72;
  const top = 48;
  const bottom = 208;
  const right = 196;
  const stem = x >= left && x < left + thick && y >= top && y < bottom;
  const foot = x >= left && x < right && y >= bottom - thick && y < bottom;
  return stem || foot;
}

function pngRgba() {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const pixel = inMark(x, y) ? FG : BG;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function icoFromPng(pngBuf) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuf.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuf]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'shell', 'build');
mkdirSync(outDir, { recursive: true });
const pngBuf = pngRgba();
writeFileSync(join(outDir, 'icon.png'), pngBuf);
writeFileSync(join(outDir, 'icon.ico'), icoFromPng(pngBuf));
