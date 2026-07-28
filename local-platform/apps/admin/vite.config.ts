/** 本文件配置管理端构建与本地 API 代理。 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/local-model-admin/",
  plugins: [react()],
  server: {
    proxy: {
      "/local-model-api": {
        target: "http://127.0.0.1:7102",
        rewrite: (path) => path.replace(/^\/local-model-api/, ""),
      },
    },
  },
});
