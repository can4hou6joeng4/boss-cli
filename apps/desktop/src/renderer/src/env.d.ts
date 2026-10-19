import type { JsonRpcNotification } from "@boss-cli/protocol";

declare global {
  interface Window {
    boss: {
      request<T>(method: string, params?: unknown): Promise<T>;
      status(): Promise<{ running: boolean; repoRoot: string; modelBridge?: { provider: string; model: string; driven: boolean }; error?: string }>;
      onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
    };
  }
}

export {};
