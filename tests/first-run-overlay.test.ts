/**
 * 首次运行遮罩的源码契约。
 *
 * 第一次打开时人要先配密钥 / 检测 Ollama，而不是先看到 conda 缺环境。
 * 跳过只记本会话，文案必须说还能在设置里再打开。DeepSeek 密钥入口必须
 * 指向官方控制台，环境体检失败必须能带 refresh 再查一次。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join('packages', 'ui', 'src', 'components', 'FirstRunOverlay.tsx'),
  'utf8',
);

describe('FirstRunOverlay source', () => {
  it('places model registration heading before env doctor heading', () => {
    // Given: 遮罩函数体（不是文件里 EnvDoctorSection 的定义顺序）
    const overlay = SRC.slice(SRC.indexOf('export function FirstRunOverlay'));

    // When
    const model = overlay.indexOf('id="first-run-title"');
    const env = overlay.indexOf('<EnvDoctorSection');

    // Then: 登记模型先于 conda / 环境体检
    expect(model).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(-1);
    expect(model).toBeLessThan(env);
  });

  it('skip button copy is 本次跳过，可在设置里再打开', () => {
    expect(SRC).toContain('本次跳过，可在设置里再打开');
  });

  it('mentions https://platform.deepseek.com', () => {
    expect(SRC).toContain('https://platform.deepseek.com');
  });

  it('EnvDoctorSection retries with refresh true', () => {
    const section = SRC.slice(
      SRC.indexOf('export function EnvDoctorSection'),
      SRC.indexOf('export function FirstRunOverlay'),
    );
    expect(section).toContain('loadEnvDoctor(true)');
  });
});
