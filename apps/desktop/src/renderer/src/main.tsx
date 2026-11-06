import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
    <ErrorBoundary scope="应用" hint="会话与内核仍在运行；重试会重新加载界面，不会删除本地会话。">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
