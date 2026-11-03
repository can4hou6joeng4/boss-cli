import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { migrateLegacyUiStorage } from "./data/uiStorage";
import "./styles/app.css";
import "./styles/replica.css";

// 先补齐改名前的界面偏好，再渲染；各组件只从新命名空间读写。
migrateLegacyUiStorage();

// 首版跟随系统外观；后续换成设置项并持久化。
if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
