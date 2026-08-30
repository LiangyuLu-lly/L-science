import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发服务器端口。
 *
 * `strictPort` 是刻意的：Vite 默认会在端口被占用时静默换一个，而外壳按固定地址加载
 * 渲染层，于是表现是「窗口一片空白」而不是「端口冲突」。宁可启动失败并把原因说出来。
 *
 * 因此并行开两个开发实例要显式给端口（需求 20.4.2）。`npm run dev:shell` 读同一个
 * 变量拼出 `L_SCIENCE_DEV_SERVER`，两边不会对不上。
 */
const DEV_PORT = Number(process.env['L_SCIENCE_UI_PORT'] ?? 5223);

export default defineConfig({
  plugins: [react()],
  // Electron 用 file:// 加载打包产物，必须用相对路径。
  base: './',
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
