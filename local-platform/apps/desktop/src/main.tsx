/** 本文件挂载 DrawHime Desktop React 应用和全局样式。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GenerationPreviewWindow } from "./GenerationPreviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
import "./account.css";
import "./repository.css";
import "./styles/logs.css";

// 两类独立预览窗口只挂载轻量任务视图，不启动主工作区的环境轮询和仓库请求。
const Root = ["generation-preview", "gallery-preview"].includes(getCurrentWindow().label) ? GenerationPreviewWindow : App;
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
