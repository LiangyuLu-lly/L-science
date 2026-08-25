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
    // 默认 node 环境。需要 DOM 的测试用文件头的
    // `@vitest-environment jsdom` 注释单独声明——全局开 jsdom 会让后端测试
    // 也背上它的启动开销（每个文件几十毫秒，累计起来很明显），而后端代码
    // 根本不该碰 DOM
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    reporters: ['default'],
  },
});
