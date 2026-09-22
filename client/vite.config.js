import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物直接输出到 server 的静态目录，实现单容器托管
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
