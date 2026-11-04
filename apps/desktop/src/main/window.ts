import { join } from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import { isAllowedExternalUrl, isTrustedRendererUrl } from "./security";
import { rendererCrashPage, rendererFailurePage } from "./rendererFailure";
import { decideRendererRecovery, rendererGoneSummary } from "./rendererRecovery";
import type { WindowRestore } from "./windowState";

/**
 * 主窗口配置照搬 Codex 实测值：
 * titleBarStyle=hiddenInset、红绿灯位置 {x:10}、vibrancy=menu、背景透明，
 * 最小尺寸 240/160。
 */
export function createMainWindow(restored?: WindowRestore): BrowserWindow {
  const position = restored ? {
    width: restored.bounds.width, height: restored.bounds.height,
    ...(restored.bounds.x !== undefined ? { x: restored.bounds.x } : {}),
    ...(restored.bounds.y !== undefined ? { y: restored.bounds.y } : {}),
  } : { width: 1440, height: 900 };
  const window = new BrowserWindow({
    title: "BOSS Harness",
    icon: join(__dirname, "../../resources/icon.png"),
    ...position,
    minWidth: 240,
    minHeight: 160,
    show: false,
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 10, y: 14 },
    vibrancy: "menu",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // 最大化要在窗口显示时恢复：先按还原后的位置创建，再最大化，取消最大化后回到保存的位置。
  window.once("ready-to-show", () => {
    if (restored?.maximized && !window.isDestroyed()) window.maximize();
    window.show();
  });

  // 系统没有可用处理程序或地址无法打开时不能静默：把完整地址交给用户手动复制。
  const openExternal = (url: string): void => {
    if (!isAllowedExternalUrl(url)) return;
    void shell.openExternal(url).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      const options = { type: "warning" as const, message: "无法打开链接", detail: `${url}\n\n${detail}`, buttons: ["好"] };
      void (window.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options));
    });
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const entryFile = join(__dirname, "../renderer/index.html");
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, entryFile, devUrl)) event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, entryFile, devUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // 加载失败时 ready-to-show 不会触发，窗口会一直隐藏；这里显式显示窗口并留下原因。
  let failureReported = false;
  const reportFailure = (cause: string): void => {
    if (failureReported || window.isDestroyed() || window.webContents.isDestroyed()) return;
    failureReported = true;
    console.error("renderer load failed", cause);
    void window.loadURL(rendererFailurePage(cause)).catch(() => { /* 兜底页也失败时至少保留可见窗口。 */ });
    if (!window.isVisible()) window.show();
  };
  window.webContents.on("did-fail-load", (_event, errorCode, description, validatedUrl, mainFrame) => {
    // -3 是 ABORTED：多来自被替换的上一次导航（如开发模式首次重载），不算界面加载失败。
    if (!mainFrame || errorCode === -3) return;
    reportFailure(`${description || `error ${errorCode}`}${validatedUrl ? `（${validatedUrl}）` : ""}`);
  });
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
  // 记录当前导航：被后续加载取代的旧 Promise 会以 ABORTED 失败，不能当成界面加载失败。
  let activeLoad: Promise<void> | null = null;
  const loadRenderer = (): Promise<void> => {
    const load = devUrl ? window.loadURL(devUrl) : window.loadFile(entryFile);
    activeLoad = load;
    return load;
  };
  const showCrashPage = (cause: string): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    activeLoad = null;
    void window.loadURL(rendererCrashPage(cause)).catch(() => { /* 兜底页也失败时至少保留可见窗口。 */ });
    if (!window.isVisible()) window.show();
  };
  // 渲染进程崩溃后 webContents 仍可继续加载；有限次自动恢复，超出预算时留下无脚本的诊断页。
  let crashReloads: number[] = [];
  window.webContents.on("render-process-gone", (_event, details) => {
    const decision = decideRendererRecovery(details, crashReloads, Date.now());
    crashReloads = decision.reloads;
    if (decision.action === "ignore" || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (decision.action === "reload") {
      console.error("renderer process gone; reloading", details.reason, details.exitCode);
      const load = loadRenderer();
      void load.catch((error: unknown) => {
        if (activeLoad !== load) return;
        showCrashPage(`界面进程异常退出：${rendererGoneSummary(details)}；自动重载失败：${reason(error)}`);
      });
      return;
    }
    const cause = decision.message ?? `界面进程异常退出：${rendererGoneSummary(details)}。`;
    console.error("renderer process gone; recovery exhausted", cause);
    showCrashPage(cause);
  });
  const initialLoad = loadRenderer();
  void initialLoad.catch((error: unknown) => {
    if (activeLoad !== initialLoad) return;
    reportFailure(`${devUrl ?? entryFile}：${reason(error)}`);
  });

  return window;
}
