import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { isAllowedExternalUrl, isTrustedRendererUrl } from "./security";

/**
 * 主窗口配置照搬 Codex 实测值：
 * titleBarStyle=hiddenInset、红绿灯位置 {x:10}、vibrancy=menu、背景透明，
 * 最小尺寸 240/160。
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "BOSS-CLI",
    icon: join(__dirname, "../../resources/icon.png"),
    width: 1440,
    height: 900,
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

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => {});
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
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(entryFile);
  }

  return window;
}
