/// <reference types="vite/client" />

import type { JsonRpcNotification, PlatformLoginStatus, PlatformLoginAction, PlatformLoginContext, SessionExportSaveRequest, SessionExportSaveResult } from "@boss-cli/protocol";
import type { HarnessConnectionStatus } from "@boss-cli/app-client";

declare global {
  interface Window {
    boss: {
      request<T>(method: string, params?: unknown): Promise<T>;
      status(): Promise<HarnessConnectionStatus & { repoRoot: string }>;
      reconnect(): Promise<HarnessConnectionStatus & { repoRoot: string }>;
      exportSession(request: SessionExportSaveRequest): Promise<SessionExportSaveResult>;
      platformLogin(action: PlatformLoginAction, context?: PlatformLoginContext): Promise<PlatformLoginStatus>;
      onPlatformLogin(listener: (status: PlatformLoginStatus) => void): () => void;
      onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
    };
  }
}

export {};
