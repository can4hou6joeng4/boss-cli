import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { attachHarness } from "./harness";

app.whenReady().then(() => {
  const window = createMainWindow();
  attachHarness(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) attachHarness(createMainWindow());
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
