/** 本文件挂载本地平台管理端，并保留全局样式入口。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><AdminApp /></StrictMode>,
);
