/** 本文件配置 DrawHime Desktop 的本地 WebView 前端构建。 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 7200, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13", minify: !process.env.TAURI_ENV_DEBUG, sourcemap: Boolean(process.env.TAURI_ENV_DEBUG) },
});
