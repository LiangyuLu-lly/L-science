/**
 * 论文路径的样式存活检查。
 *
 * 为什么需要它：三条并行施工线都往 styles.css 尾部追加规则，而组件测试只断言
 * 「源码里有某个方法名」。于是出现一种最难发现的坏状态——**测试全绿，界面裸奔**：
 * `claims-view.test.ts` 说断言页有六个动作，而 `.ledger` 没有任何样式，因为它被
 * 后来的一次追加覆盖掉了。
 *
 * 这里从组件的 className 里抽出静态类名，逐个要求 styles.css 里存在对应选择器。
 * 它不判断样式好不好看（那是视觉过关的事），只保证「类名在用，就一定有规则」。
 * 用 Tailwind 的项目不需要这个测试；这个项目是手写 BEM。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPONENTS = [
  'packages/ui/src/components/RefsView.tsx',
  'packages/ui/src/components/ClaimsView.tsx',
  'packages/ui/src/components/ManuscriptsView.tsx',
  'packages/ui/src/components/SettingsView.tsx',
] as const;

const CSS = readFileSync(join('packages', 'ui', 'src', 'styles.css'), 'utf8');

/** 组件里写死的类名。模板字面量只取其中的静态片段（`ledger ${x}` → ledger）。 */
function staticClassNames(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = m[1] ?? m[2] ?? '';
    for (const token of raw.split(/[\s${}()?:'"`]+/)) {
      // 形如 `ledger__row` 才算类名；条件表达式的碎片（如 is-current）单独处理
      if (/^[a-z][a-z0-9]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?$/i.test(token)) found.add(token);
    }
  }
  for (const m of source.matchAll(/'([a-z][a-z0-9]*(?:__[a-z0-9-]+)?)(?:\s+is-current)?'/gi)) {
    found.add(m[1] ?? '');
  }
  return found;
}

describe('paper-path 组件用到的类名必须有样式', () => {
  for (const file of COMPONENTS) {
    const source = readFileSync(join(...file.split('/')), 'utf8');
    // 只盯着本项目自有的视觉类，通用原子类（btn/panel/…）另行兜底
    const owned = [...staticClassNames(source)].filter(
      (name) => /^(ledger|ref-card|manuscript-editor|dock-paper|grant|empty-action|is-current)/.test(name),
    );

    it(`${file.split('/').pop()} 的每个自有类名都能在 styles.css 里找到`, () => {
      const missing = owned.filter((name) => !CSS.includes(`.${name}`));
      expect(missing, `styles.css 缺少：${missing.join('、')}`).toEqual([]);
    });
  }

  it('断言页的账本样式真的存在（不是空壳）', () => {
    // 这三个是 ClaimsView 的结构骨架；少一个界面就退回纯文本列表
    for (const cls of ['.ledger', '.ledger__empty', '.empty-action']) {
      expect(CSS, `缺少 ${cls}`).toContain(cls);
    }
  });
});
