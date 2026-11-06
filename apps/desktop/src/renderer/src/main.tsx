import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { migrateLegacyUiStorage, UI_STORAGE_PREFIX } from "./data/uiStorage";
import { parseThemePreference, resolveDarkTheme } from "./data/themePreference";
import "./styles/app.css";
import "./styles/replica.css";

// 先补齐改名前的界面偏好，再渲染；各组件只从新命名空间读写。
migrateLegacyUiStorage();

// 在 React 挂载前应用主题：保存浅色而系统深色时，不先显示深色再切回来。
let storedTheme: string | null = null;
try { storedTheme = localStorage.getItem(UI_STORAGE_PREFIX + "theme"); } catch {}
const systemPrefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
document.documentElement.classList.toggle(
  "dark",
  resolveDarkTheme(parseThemePreference(storedTheme), systemPrefersDark),
);

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary scope="应用" hint="会话与内核仍在运行；重试会重新加载界面，不会删除本地会话。">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
