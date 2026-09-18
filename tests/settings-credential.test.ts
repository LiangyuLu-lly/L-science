/**
 * 设置页凭据表单：选供应商即填入 provider:<id>。
 *
 * 引用名约定是 `providerRef('deepseek') === 'provider:deepseek'`。靠人记住并手打
 * 这个前缀，填错一次就会存成对不上的键。下拉框列出已登记的供应商 id，选中后
 * 写入 cred-ref，手打路径仍保留。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join('packages', 'ui', 'src', 'components', 'SettingsView.tsx'), 'utf8');

describe('SettingsView credential form', () => {
  it('provider select writes provider:<id> into cred-ref', () => {
    // Given: 凭据表单（不是供应商卡片上那个绑定已有引用名的下拉框）
    const formStart = SRC.indexOf('className="cred-form"');
    expect(formStart).toBeGreaterThan(-1);
    const form = SRC.slice(formStart);

    // When / Then: 表单里有供应商 id 下拉；选中后用 providerRef 写入 cred-ref
    expect(form).toMatch(/<select\b/);
    expect(form).toMatch(/id=["']cred-ref["']/);
    expect(form).toMatch(/setRef\(\s*providerRef\(/);
  });
});
