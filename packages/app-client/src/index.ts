/**
 * Harness 客户端：把 Python 内核当作子进程启动，用换行分隔的 JSON-RPC 与其通信。
 *
 * 对应 Codex 的 app-server-manager：外壳只依赖这一个模块，不 import 任何内核代码，
 * 内核崩了也不会拖垮界面。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcResponse,
  ServerNotification,
} from "@boss-cli/protocol";

export interface HarnessClientOptions {
  /** 启动内核的可执行文件，例如 "python3"。 */
  command: string;
  /** 参数，例如 ["-m", "boss_harness", "--listen", "stdio://"]。 */
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HarnessClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<JsonRpcId, Pending>();
  #listeners = new Set<(n: JsonRpcNotification) => void>();
  #nextId = 1;
  #exited = false;
  #failure: Error | null = null;
  #buffer = "";

  private readonly options: HarnessClientOptions;

  constructor(options: HarnessClientOptions) { this.options = options; }

  start(): this {
    if (this.#child || this.#exited) throw new Error("harness client cannot be started twice");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let end: number;
      while ((end = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        this.#onLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness] ${chunk.toString()}`);
    });
    child.on("error", () => this.#fail(new Error("harness failed to start; check Python and dependencies")));
    child.stdin.on("error", () => this.#fail(new Error("harness input pipe closed")));
    child.on("close", (code, signal) => this.#fail(new Error(`harness exited (code=${code}, signal=${signal})`)));

    return this;
  }

  get exited(): boolean {
    return this.#exited;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const child = this.#child;
    if (this.#failure || !child || !child.stdin.writable) {
      return Promise.reject(this.#failure ?? new Error("harness is not running"));
    }
    const id = this.#nextId++;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`harness request timed out: ${method}; outcome unknown, do not retry automatically`));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer); this.#pending.delete(id); reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.#child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  onNotification(listener: (n: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 便捷方法：只订阅指定的服务端通知（如 ServerNotifications.agentMessageDelta）。 */
  on(method: ServerNotification, listener: (params: unknown) => void): () => void {
    return this.onNotification((n) => {
      if (n.method === method) listener(n.params);
    });
  }

  dispose(): void {
    this.#fail(new Error("harness client disposed"));
    this.#child?.stdin.end();
    this.#child?.kill();
    this.#child = null;
  }

  #fail(reason: Error): void {
    if (this.#failure) return;
    this.#failure = reason;
    this.#exited = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#emit({ jsonrpc: "2.0", method: "harness/disconnected", params: { message: reason.message } });
  }

  #emit(notification: JsonRpcNotification): void {
    for (const listener of this.#listeners) {
      try { listener(notification); }
      catch { process.stderr.write("[harness] notification listener failed\n"); }
    }
  }

  #onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      process.stderr.write("[harness] invalid protocol frame\n");
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if ("id" in message && ("result" in message || "error" in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
      return;
    }
    if (!("id" in message)) {
      this.#emit(message as JsonRpcNotification);
    }
  }
}
