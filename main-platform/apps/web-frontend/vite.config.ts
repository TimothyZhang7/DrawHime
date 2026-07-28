/** 本文件配置用户前台 Vite 开发服务器端口。 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    // 严格使用配置端口，避免旧进程残留时 Vite 自动漂移端口导致地址清单错误。
    strictPort: true,
  },
});
