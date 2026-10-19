import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import { HarnessClient } from "@boss-cli/app-client";
import type { InitializeResponse } from "@boss-cli/protocol";

/** 从当前目录向上找到仓库根，以 pnpm-workspace.yaml 为标记。 */
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

/**
 * 主进程与内核之间的桥。
 *
 * 外壳不 import 内核代码：只把 Python 内核当子进程启动，通过 stdio 上的
 * JSON-RPC 收发。渲染层再经 IPC 走这两条通道。
 */
let client: HarnessClient | null = null;
let attachedWindow: BrowserWindow | null = null;
let initialization: Promise<InitializeResponse> | null = null;
let connectionError: string | undefined;

export function attachHarness(window: BrowserWindow): void {
  attachedWindow = window;
  if (client) return;

  const repoRoot = findRepoRoot(app.getAppPath());
  const harnessSrc = resolve(repoRoot, "harness", "src");

  // 内核要求 Python 3.10+；优先用仓库内的虚拟环境，回退到 PATH 上的 python3。
  const venvPython = resolve(repoRoot, ".venv", "bin", "python");
  const python = process.env.BOSS_HARNESS_PYTHON ?? (existsSync(venvPython) ? venvPython : "python3");

  client = new HarnessClient({
    command: python,
    args: ["-m", "boss_harness", "--listen", "stdio://"],
    cwd: repoRoot,
    env: {
      PYTHONPATH: harnessSrc,
      PYTHONUNBUFFERED: "1",
      BOSS_HARNESS_PROVIDER: process.env.BOSS_HARNESS_PROVIDER ?? "openai",
    },
  }).start();

  initialization = client.request<InitializeResponse>("initialize", {
      clientInfo: { name: "boss-cli-desktop", version: app.getVersion() },
      capabilities: { experimentalApi: false },
    });
  void initialization.catch((error: unknown) => {
      connectionError = String(error);
      process.stderr.write(`[desktop] harness initialize failed: ${String(error)}\n`);
    });

  client.onNotification((notification) => {
    if (attachedWindow && !attachedWindow.isDestroyed()) {
      attachedWindow.webContents.send("harness:notification", notification);
    }
  });

  ipcMain.handle("harness:request", async (_event, payload: { method: string; params?: unknown }) => {
    if (!client) throw new Error("harness is not attached");
    await initialization;
    return client.request(payload.method, payload.params);
  });

  ipcMain.handle("harness:status", async () => {
    let info: InitializeResponse | undefined;
    try { info = await initialization ?? undefined; } catch {}
    return { running: Boolean(info && client && !client.exited), repoRoot,
      modelBridge: info?.modelBridge, error: connectionError };
  });

  app.on("before-quit", () => {
    client?.dispose();
    client = null;
  });
}
