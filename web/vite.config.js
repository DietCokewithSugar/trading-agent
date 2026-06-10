import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 把体积大的依赖拆成独立 chunk,便于浏览器缓存
        manualChunks: {
          antd: ['antd'],
          recharts: ['recharts'],
        },
      },
    },
  },
});
