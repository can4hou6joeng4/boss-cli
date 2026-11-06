import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { createMainWindow } from "./window";
import { attachHarness, setHarnessWindowFactory } from "./harness";
import { adoptLegacyUserData } from "./profile";
import { readWindowState, restoreWindowState, trackWindowState } from "./windowState";

app.setName("BOSS Harness");
// 旧产品名的 userData 里还有界面偏好与草稿；在读取任何本地状态之前接管，避免升级后丢数据。
adoptLegacyUserData(app.getPath("userData"), join(app.getPath("appData"), "BOSS-CLI"));
let mainWindow: BrowserWindow | null = null;

function showMainWindow(): BrowserWindow | null {
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  // 位置、尺寸与最大化状态保存在 userData；恢复前按当前显示器校验，避免窗口落在屏幕外。
  const statePath = join(app.getPath("userData"), "window-state.json");
  const restored = restoreWindowState(readWindowState(statePath), screen.getAllDisplays().map(display => display.workArea));
  mainWindow = createMainWindow(restored);
  trackWindowState(mainWindow, statePath);
  mainWindow.once("closed", () => { mainWindow = null; });
  attachHarness(mainWindow);
  return mainWindow;
}

// 关闭全部窗口后（macOS 不退出），点击系统通知仍可重新打开主窗口。
setHarnessWindowFactory(showMainWindow);

// One desktop process owns the local host; later launches activate its window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { void app.whenReady().then(showMainWindow); });
  void app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.setIcon(join(__dirname, "../../resources/icon.png"));
    showMainWindow();
    app.on("activate", showMainWindow);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
