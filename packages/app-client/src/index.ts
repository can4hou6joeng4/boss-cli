/**
 * Harness 客户端：把 Python 内核当作子进程启动，用换行分隔的 JSON-RPC 与其通信。
 *
 * 对应 Codex 的 app-server-manager：外壳只依赖这一个模块，不 import 任何内核代码，
 * 内核崩了也不会拖垮界面。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
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
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class HarnessClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #pending = new Map<JsonRpcId, Pending>();
  #listeners = new Set<(n: JsonRpcNotification) => void>();
  #nextId = 1;
  #exited = false;

  constructor(private readonly options: HarnessClientOptions) {}

  start(): this {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on("line", (line) => this.#onLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness] ${chunk.toString()}`);
    });
    child.on("exit", (code, signal) => {
      this.#exited = true;
      const reason = new Error(`harness exited (code=${code}, signal=${signal})`);
      for (const pending of this.#pending.values()) pending.reject(reason);
      this.#pending.clear();
    });

    return this;
  }

  get exited(): boolean {
    return this.#exited;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const child = this.#child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("harness is not running"));
    }
    const id = this.#nextId++;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
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
    this.#reader?.close();
    this.#child?.kill();
    this.#child = null;
  }

  #onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      process.stderr.write(`[harness] unparsable line: ${text.slice(0, 200)}\n`);
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
      return;
    }
    if (!("id" in message)) {
      for (const listener of this.#listeners) listener(message as JsonRpcNotification);
    }
  }
}
