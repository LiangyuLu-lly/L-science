/**
 * 技能详情的参考材料必须能点开读，不能只列文件名。
 *
 * `skill.reference` 的 UI 包装是 `loadSkillReferenceFile`，详情里已经列出
 * `skill.references`，但点了没反应等于假可用。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const VIEW = readFileSync(join('packages', 'ui', 'src', 'components', 'SkillsView.tsx'), 'utf8');

describe('skills view reference files', () => {
  it('wires loadSkillReferenceFile and renders loaded text into a pre', () => {
    expect(VIEW).toContain('loadSkillReferenceFile');
    expect(VIEW).toContain('<pre className="skilleditor__code">');
    expect(VIEW).toContain('读取中…');
    expect(VIEW).toContain('正文超过 512000 字符上限，以下为截断后的前缀。');
  });

  it('has a per-file error branch that surfaces BackendError fields', () => {
    expect(VIEW).toMatch(/loadSkillReferenceFile[\s\S]+?errorText\(err\)/);
    expect(VIEW).toContain('role="alert"');
    expect(VIEW).toContain('err.message');
    expect(VIEW).toContain('err.detail');
    expect(VIEW).toContain('err.remediation');
  });

  it('still lists reference file names and does not hide unsatisfied skills', () => {
    expect(VIEW).toContain('参考材料');
    expect(VIEW).toContain('skill.references');
    expect(VIEW).not.toMatch(/requirementsSatisfied[\s\S]{0,120}skill\.references/);
  });
});
