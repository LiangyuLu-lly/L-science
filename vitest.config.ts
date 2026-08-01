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
      // shell 包的入口是 Electron 主进程代码，测试里不能整体导入（会去 require
      // 'electron'）。这里单独指向可独立测试的协议客户端。
      '@l-science/shell/backend-client': fileURLToPath(
        new URL('./packages/shell/src/backend-client.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    reporters: ['default'],
  },
});
