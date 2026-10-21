import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { attachHarness } from "./harness";

app.setName("BOSS-CLI");
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
    if (process.platform === "darwin") app.dock.setIcon(join(__dirname, "../../resources/icon.png"));
    showMainWindow();
    app.on("activate", showMainWindow);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
