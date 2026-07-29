/** 本文件挂载 DrawHime Desktop React 应用和全局样式。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./account.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
