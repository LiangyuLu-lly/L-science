/**
 * 打包用官方 Node 24 win-x64 下载器。
 *
 * 测的是 URL 与 SHASUMS 文件名解析：这两处写错会静默下到非官方镜像或
 * linux/mac 包。真正的 HTTP 下载只在 L_SCIENCE_NET=1 时跑，默认离线。
 */

import { describe, expect, it } from 'vitest';

import {
  NODE_VERSION,
  innerNodeExe,
  nodeDistUrls,
  parseSha256,
  winX64ZipName,
} from '../scripts/download-node.mjs';

describe('NODE_VERSION', () => {
  it('is a pinned 24.x string, not latest', () => {
    expect(NODE_VERSION).toMatch(/^24\.\d+\.\d+$/u);
    expect(NODE_VERSION).not.toBe('latest');
    expect(NODE_VERSION.startsWith('v')).toBe(false);
  });
});

describe('URL builder', () => {
  it('builds official dist URLs for a given 24.x version', () => {
    const version = '24.11.1';
    const urls = nodeDistUrls(version);

    expect(urls.zipName).toBe('node-v24.11.1-win-x64.zip');
    expect(urls.zip).toBe('https://nodejs.org/dist/v24.11.1/node-v24.11.1-win-x64.zip');
    expect(urls.shasums).toBe('https://nodejs.org/dist/v24.11.1/SHASUMS256.txt');
  });

  it('defaults to the pinned NODE_VERSION', () => {
    const urls = nodeDistUrls();
    expect(urls.zip).toBe(
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
    );
    expect(urls.shasums).toBe(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
    expect(urls.zipName).toBe(winX64ZipName(NODE_VERSION));
  });

  it('does not point at unofficial mirrors or non-win-x64 artifacts', () => {
    const urls = nodeDistUrls('24.11.1');
    const joined = `${urls.zip}\n${urls.shasums}\n${urls.zipName}`;

    expect(urls.zip.startsWith('https://nodejs.org/dist/')).toBe(true);
    expect(joined).not.toContain('npmmirror');
    expect(joined).not.toContain('unofficial-builds');
    expect(joined).not.toContain('linux');
    expect(joined).not.toContain('darwin');
    expect(joined).not.toContain('osx');
    expect(joined).not.toContain('arm64');
  });
});

describe('filename parse', () => {
  it('names the win-x64 zip and the inner node.exe path', () => {
    expect(winX64ZipName('24.11.1')).toBe('node-v24.11.1-win-x64.zip');
    expect(innerNodeExe('24.11.1')).toBe('node-v24.11.1-win-x64/node.exe');
    expect(winX64ZipName('24.11.1')).not.toContain('linux');
    expect(innerNodeExe('24.11.1')).not.toContain('linux');
  });

  it('reads the win-x64 zip hash and ignores other platform lines', () => {
    const winHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const linuxHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const darwinHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const armHash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const text = [
      `${linuxHash}  node-v24.11.1-linux-x64.tar.xz`,
      `${darwinHash}  node-v24.11.1-darwin-x64.tar.gz`,
      `${armHash}  node-v24.11.1-win-arm64.zip`,
      `${winHash}  node-v24.11.1-win-x64.zip`,
      '',
    ].join('\n');

    expect(parseSha256(text, winX64ZipName('24.11.1'))).toBe(winHash);
  });

  it('accepts CRLF and GNU binary asterisk form', () => {
    const hash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const text = `${hash} *node-v24.11.1-win-x64.zip\r\n`;
    expect(parseSha256(text, 'node-v24.11.1-win-x64.zip')).toBe(hash);
  });

  it('throws when the win-x64 zip is missing', () => {
    const text = 'ffff'.repeat(16) + '  node-v24.11.1-linux-x64.tar.xz\n';
    expect(() => parseSha256(text, winX64ZipName('24.11.1'))).toThrow(
      /node-v24\.11\.1-win-x64\.zip/u,
    );
  });
});

const live = process.env.L_SCIENCE_NET === '1';

describe.skipIf(!live)('official dist (L_SCIENCE_NET=1)', () => {
  it('SHASUMS256.txt lists the pinned win-x64 zip', async () => {
    const urls = nodeDistUrls();
    const res = await fetch(urls.shasums, { signal: AbortSignal.timeout(30_000) });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(parseSha256(text, urls.zipName)).toMatch(/^[0-9a-f]{64}$/iu);
  });
});
