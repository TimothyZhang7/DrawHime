/** 本文件配置独立本地模型平台用户端的开发服务器。 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.LOCAL_MODEL_PLATFORM_WEB_PORT || 5187),
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.LOCAL_MODEL_PLATFORM_PORT || 3017}`,
        changeOrigin: true,
      },
    },
  },
});
