import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { InitializeResponse, JsonRpcNotification, PlatformLoginStatus, PlatformLoginAction, PlatformLoginContext } from "@boss-cli/protocol";

interface HarnessStatus {
  running: boolean;
  repoRoot: string;
  hostId: string;
  state: "cold" | "starting" | "initializing" | "ready" | "disconnected" | "stopped";
  generation: number;
  reconnectAttempt: number;
  retryAt?: number;
  modelBridge?: { provider: string; model: string; driven: boolean };
  capabilities?: InitializeResponse["capabilities"];
  error?: string;
}

/**
 * 渲染层只可请求允许清单里的内核方法，订阅通知、查询连接和显式重连。
 * 不暴露 ipcRenderer 本体，也不暴露 Node 能力。
 */
const api = {
  request<T>(method: string, params?: unknown): Promise<T> {
    return ipcRenderer.invoke("harness:request", { method, params }) as Promise<T>;
  },
  status(): Promise<HarnessStatus> {
    return ipcRenderer.invoke("harness:status") as Promise<HarnessStatus>;
  },
  reconnect(): Promise<HarnessStatus> {
    return ipcRenderer.invoke("harness:reconnect") as Promise<HarnessStatus>;
  },
  platformLogin(action: PlatformLoginAction, context?: PlatformLoginContext): Promise<PlatformLoginStatus> {
    return ipcRenderer.invoke("platform-login:action", action, context) as Promise<PlatformLoginStatus>;
  },
  onPlatformLogin(listener: (status: PlatformLoginStatus) => void): () => void {
    const handler = (_event: IpcRendererEvent, status: PlatformLoginStatus): void => listener(status);
    ipcRenderer.on("platform-login:status", handler);
    return () => ipcRenderer.removeListener("platform-login:status", handler);
  },
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    const handler = (_event: IpcRendererEvent, notification: JsonRpcNotification): void =>
      listener(notification);
    ipcRenderer.on("harness:notification", handler);
    return () => ipcRenderer.removeListener("harness:notification", handler);
  },
};

export type BossBridge = typeof api;

contextBridge.exposeInMainWorld("boss", api);
