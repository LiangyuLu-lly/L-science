import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // 指向源码而不是 dist，测试因此不依赖构建产物，改代码即可直接跑。
    alias: {
      '@l-science/shared': pkg('shared'),
      '@l-science/kernel': pkg('kernel'),
      '@l-science/adapters': pkg('adapters'),
      '@l-science/core': pkg('core'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    reporters: ['default'],
  },
});
