import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { attachHarness } from "./harness";
import { adoptLegacyUserData } from "./profile";

app.setName("BOSS Harness");
// 旧产品名的 userData 里还有界面偏好与草稿；在读取任何本地状态之前接管，避免升级后丢数据。
adoptLegacyUserData(app.getPath("userData"), join(app.getPath("appData"), "BOSS-CLI"));
let mainWindow: BrowserWindow | null = null;

function showMainWindow(): void {
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  mainWindow = createMainWindow();
  mainWindow.once("closed", () => { mainWindow = null; });
  attachHarness(mainWindow);
}

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
