import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { app, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { HarnessHostManager, type HarnessHostConnection } from "@boss-cli/app-client";
import type { JsonRpcNotification } from "@boss-cli/protocol";
import { isTrustedRendererUrl, validateHarnessRequest } from "./security";

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(start, "..", "..");
}

const manager = new HarnessHostManager();
const windows = new Set<BrowserWindow>();
let host: HarnessHostConnection | null = null;
let repoRoot = "";
let ipcRegistered = false;
/** A window, its current main frame and its entry URL must all match. */
function trustedSender(event: IpcMainInvokeEvent): void {
  const window = [...windows].find((candidate) => !candidate.isDestroyed() && candidate.webContents === event.sender);
  if (!window || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("untrusted harness IPC sender");
  }
  if (!isTrustedRendererUrl(event.senderFrame.url, resolve(__dirname, "../renderer/index.html"), process.env.ELECTRON_RENDERER_URL)) {
    throw new Error("untrusted harness IPC origin");
  }
}

function send(window: BrowserWindow, notification: JsonRpcNotification): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  try { window.webContents.send("harness:notification", notification); } catch {}
}

function createHost(): HarnessHostConnection {
  repoRoot = findRepoRoot(app.getAppPath());
  const venvPython = resolve(repoRoot, ".venv", "bin", "python");
  const python = process.env.BOSS_HARNESS_PYTHON ?? (existsSync(venvPython) ? venvPython : "python3");
  const connection = manager.add({
    hostId: "local",
    clientInfo: { name: "boss-cli-desktop", version: app.getVersion() },
    supportsReconnect: true,
    // Explicit user recovery is also exposed; this small retry budget covers process crashes.
    autoReconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 },
    client: {
      command: python, args: ["-m", "boss_harness", "--listen", "stdio://"], cwd: repoRoot,
      env: {
        PYTHONPATH: resolve(repoRoot, "harness", "src"), PYTHONUNBUFFERED: "1",
        BOSS_HARNESS_PROVIDER: process.env.BOSS_HARNESS_PROVIDER ?? "openai",
      },
    },
  });
  connection.onNotification((notification) => { for (const window of windows) send(window, notification); });
  return connection;
}

function registerIPC(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("harness:request", async (event, payload: unknown) => {
    trustedSender(event);
    const request = validateHarnessRequest(payload);
    if (!host) throw new Error("harness host is not attached");
    return host.request(request.method, request.params);
  });
  ipcMain.handle("harness:status", (event) => {
    trustedSender(event);
    return { ...manager.get().status(), repoRoot };
  });
  ipcMain.handle("harness:reconnect", async (event) => {
    trustedSender(event);
    await manager.get().reconnect();
    return { ...manager.get().status(), repoRoot };
  });
  app.once("before-quit", () => { manager.dispose(); host = null; windows.clear(); });
}

/** Windows subscribe to the host registry; closing one window cannot stop the backend. */
export function attachHarness(window: BrowserWindow): void {
  if (windows.has(window)) return;
  windows.add(window);
  window.once("closed", () => { windows.delete(window); });
  host ??= createHost();
  registerIPC();
  window.webContents.on("did-finish-load", () => {
    if (host) send(window, { jsonrpc: "2.0", method: "harness/connectionStatus", params: host.status() });
  });
  void host.ensureReady().catch(() => { /* Host status conveys initialization and reconnect failures. */ });
}
