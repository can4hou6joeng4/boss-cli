/// <reference types="vite/client" />

import type { ApprovalFocusTarget, BadgeCountResult, JsonRpcNotification, NotificationTestResult, PlatformLoginStatus, PlatformLoginAction, PlatformLoginContext, SessionExportSaveRequest, SessionExportSaveResult } from "@boss-harness/protocol";
import type { HarnessConnectionStatus } from "@boss-harness/app-client";

declare global {
  /** 构建时由 electron-vite 注入的发布版本号。 */
  const __APP_VERSION__: string;

  interface Window {
    boss: {
      request<T>(method: string, params?: unknown): Promise<T>;
      status(): Promise<HarnessConnectionStatus & { repoRoot: string }>;
      reconnect(): Promise<HarnessConnectionStatus & { repoRoot: string }>;
      exportSession(request: SessionExportSaveRequest): Promise<SessionExportSaveResult>;
      platformLogin(action: PlatformLoginAction, context?: PlatformLoginContext): Promise<PlatformLoginStatus>;
      onPlatformLogin(listener: (status: PlatformLoginStatus) => void): () => void;
      onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
      onApprovalFocus(listener: (target: ApprovalFocusTarget) => void): () => void;
      testNotification(): Promise<NotificationTestResult>;
      setBadgeCount(count: number): Promise<BadgeCountResult>;
      /** 运行环境版本；浏览器预览没有该字段。 */
      versions?: { electron?: string; chrome?: string; node?: string; platform?: string };
    };
  }
}

export {};
