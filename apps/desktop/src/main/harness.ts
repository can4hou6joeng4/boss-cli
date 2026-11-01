import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { app, dialog, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { HarnessHostManager, HarnessRpcError, type HarnessHostConnection } from "@boss-cli/app-client";
import type { JsonRpcNotification, SessionExportSaveResult } from "@boss-cli/protocol";
import { isTrustedRendererUrl, sessionExportFileName, validateHarnessRequest, validateLoginContext,
  validateSessionExportRequest, validateThreadExportResponse } from "./security";
import { PlatformLogin } from "./platformLogin";

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
const platformLogin = new PlatformLogin((method, params) => {
  if (!host) return Promise.reject(new Error("harness host is not attached"));
  return host.request(method, params);
}, status => {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send("platform-login:status", status);
  }
});

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
  ipcMain.handle("platform-login:action", async (event, action: unknown, payload: unknown) => {
    trustedSender(event);
    if (action === "status") return platformLogin.read();
    const context = validateLoginContext(payload);
    const parent = BrowserWindow.fromWebContents(event.sender)!;
    if (action === "open") {
      if (!host) throw new Error("harness host is not attached");
      await host.request("thread/read", { threadId: context.threadId });
      if (parent.isDestroyed()) throw new Error("login parent was closed");
      return platformLogin.open(parent, context.threadId);
    }
    if (["layout", "back", "forward", "reload", "cancel"].includes(action as string)) {
      return platformLogin.control(parent, action as "layout" | "back" | "forward" | "reload" | "cancel", context);
    }
    throw new Error("invalid platform login action");
  });
  ipcMain.handle("harness:request", async (event, payload: unknown) => {
    trustedSender(event);
    const request = validateHarnessRequest(payload);
    if (!host) throw new Error("harness host is not attached");
    try { return await host.request(request.method, request.params); }
    catch (error) {
      const preservesRpcError = request.method === "context/compact/start" ||
        request.method === "turn/continuation/read" || request.method === "turn/continue" ||
        request.method === "thread/model/set" || request.method === "thread/leaf/set" ||
        request.method === "thread/leaf/read" || request.method === "thread/branches/list" ||
        request.method === "thread/branchSummary/read" || request.method === "thread/usage/read";
      if (preservesRpcError && error instanceof HarnessRpcError && error.code !== -32603) {
        return { __harnessRpcError: { code: error.code, message: error.message, data: error.data } };
      }
      throw error;
    }
  });
  // Session export: the kernel renders redacted text, the main process asks where to save and writes it.
  // The renderer only receives the chosen file's base name and counts, never the exported content or path.
  let exportInFlight = false;
  ipcMain.handle("session-export:save", async (event, payload: unknown): Promise<SessionExportSaveResult | { __harnessRpcError: unknown }> => {
    trustedSender(event);
    const request = validateSessionExportRequest(payload);
    if (!host) throw new Error("harness host is not attached");
    if (exportInFlight) throw new Error("another session export is in progress");
    exportInFlight = true;
    try {
      let response: unknown;
      try {
        response = await host.request("thread/export", { threadId: request.threadId, view: request.view,
          format: request.format, includeToolResults: request.includeToolResults });
      } catch (error) {
        if (error instanceof HarnessRpcError && error.code !== -32603) {
          return { __harnessRpcError: { code: error.code, message: error.message, data: error.data } };
        }
        throw error;
      }
      const exported = validateThreadExportResponse(response, request);
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) throw new Error("export parent was closed");
      const markdown = request.format === "markdown";
      const choice = await dialog.showSaveDialog(parent, {
        title: "导出会话", defaultPath: join(app.getPath("downloads"), sessionExportFileName(request)),
        filters: [markdown ? { name: "Markdown", extensions: ["md"] } : { name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (choice.canceled || !choice.filePath) return { saved: false, canceled: true };
      await writeFile(choice.filePath, exported.content, { encoding: "utf8", mode: 0o600 });
      return { saved: true, fileName: basename(choice.filePath), bytes: Buffer.byteLength(exported.content, "utf8"),
        truncated: exported.truncated, turnCount: exported.turnCount, exportedTurnCount: exported.exportedTurnCount,
        toolResults: exported.toolResults, redactions: { ...exported.redactions } };
    } finally {
      exportInFlight = false;
    }
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
  app.once("before-quit", () => { platformLogin.cancel(); manager.dispose(); host = null; windows.clear(); });
}

/** Windows subscribe to the host registry; closing one window cannot stop the backend. */
export function attachHarness(window: BrowserWindow): void {
  if (windows.has(window)) return;
  windows.add(window);
  window.once("closed", () => { windows.delete(window); if (!windows.size) platformLogin.cancel(); });
  host ??= createHost();
  registerIPC();
  window.webContents.on("did-finish-load", () => {
    if (host) send(window, { jsonrpc: "2.0", method: "harness/connectionStatus", params: host.status() });
  });
  void host.ensureReady().catch(() => { /* Host status conveys initialization and reconnect failures. */ });
}
