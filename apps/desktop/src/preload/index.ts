import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ApprovalFocusTarget, BadgeCountResult, InitializeResponse, JsonRpcNotification, NotificationTestResult,
  PlatformLoginStatus, PlatformLoginAction, PlatformLoginContext, SessionExportSaveRequest,
  SessionExportSaveResult } from "@boss-harness/protocol";

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
  /** 导出会话：主进程向内核取脱敏文本并经保存对话框写盘；返回文件名与统计，不返回正文或路径。 */
  exportSession(request: SessionExportSaveRequest): Promise<SessionExportSaveResult> {
    return ipcRenderer.invoke("session-export:save", request) as Promise<SessionExportSaveResult>;
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
  /** 把待审批数量同步到应用图标徽标；平台不支持时主进程返回 applied=false。 */
  setBadgeCount(count: number): Promise<BadgeCountResult> {
    return ipcRenderer.invoke("notification:badge", count) as Promise<BadgeCountResult>;
  },
  /** 请主进程发送一条测试系统通知，用于确认当前系统的通知权限。 */
  testNotification(): Promise<NotificationTestResult> {
    return ipcRenderer.invoke("notification:test") as Promise<NotificationTestResult>;
  },
  /** 点击审批系统通知后要定位的会话与条目；载荷由渲染层再次校验后才使用。 */
  onApprovalFocus(listener: (target: ApprovalFocusTarget) => void): () => void {
    const handler = (_event: IpcRendererEvent, target: ApprovalFocusTarget): void => listener(target);
    ipcRenderer.on("harness:focus-approval", handler);
    return () => ipcRenderer.removeListener("harness:focus-approval", handler);
  },
  /** 关于页展示的运行版本；来自 preload 进程，渲染层只读。 */
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
    platform: process.platform,
  },
};

export type BossBridge = typeof api;

contextBridge.exposeInMainWorld("boss", api);
