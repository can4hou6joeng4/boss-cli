/** A process transport. Host lifecycle and reconnection live in host.ts. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest,
  JsonRpcResponse, ServerNotification,
} from "@boss-cli/protocol";

export interface HarnessClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Byte limits cover incoming and outgoing LF-delimited frames. */
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  onDiagnostic?: (message: string) => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Outgoing = { frame: string; bytes: number; id?: JsonRpcId };

function validId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

export class HarnessClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<JsonRpcId, Pending>();
  #incoming = new Set<JsonRpcId>();
  #listeners = new Set<(n: JsonRpcNotification) => void>();
  #requestListeners = new Set<(request: JsonRpcRequest) => void>();
  #nextId = 1;
  #failure: Error | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #outgoing: Outgoing[] = [];
  #queuedBytes = 0;
  #waitingForDrain = false;
  #killTimer: ReturnType<typeof setTimeout> | null = null;
  #resolveClosed: (() => void) | null = null;
  #closed = new Promise<void>((resolveClosed) => { this.#resolveClosed = resolveClosed; });

  private readonly options: HarnessClientOptions;

  constructor(options: HarnessClientOptions) { this.options = options; }

  start(): this {
    if (this.#child || this.#failure) throw new Error("harness client cannot be started twice");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    // Split bytes only on LF: U+2028 and U+2029 remain valid string content.
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stderr.on("data", () => this.#diagnostic("backend diagnostic received"));
    child.on("error", () => this.#fail(new Error("harness failed to start; check Python and dependencies")));
    child.stdin.on("error", () => this.#fail(new Error("harness input pipe closed")));
    child.stdin.on("drain", () => { this.#waitingForDrain = false; this.#flush(); });
    child.on("exit", (code, signal) => this.#fail(new Error(`harness exited (code=${code}, signal=${signal})`)));
    child.on("close", (code, signal) => {
      if (this.#killTimer) clearTimeout(this.#killTimer);
      this.#killTimer = null;
      this.#fail(new Error(`harness exited (code=${code}, signal=${signal})`));
      this.#resolveClosed?.(); this.#resolveClosed = null;
    });
    return this;
  }

  get exited(): boolean { return this.#failure !== null; }
  get pendingRequestCount(): number { return this.#pending.size; }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#failure || !this.#child?.stdin.writable) {
      return Promise.reject(this.#failure ?? new Error("harness is not running"));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // If a command was never written, remove it; sent commands are never replayed.
        this.#removeQueued(id);
        reject(new Error(`harness request timed out: ${method}; outcome unknown, do not retry automatically`));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.#enqueue({ jsonrpc: "2.0", id, method, params }, id); }
      catch (error) {
        clearTimeout(timer); this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("could not serialize harness request"));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.#enqueue({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server request once. IDs belong only to this process generation. */
  respond(id: JsonRpcId, result: unknown): void {
    this.#respond({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, error: JsonRpcError): void {
    this.#respond({ jsonrpc: "2.0", id, error });
  }

  onRequest(listener: (request: JsonRpcRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  onNotification(listener: (n: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  on(method: ServerNotification, listener: (params: unknown) => void): () => void {
    return this.onNotification((n) => { if (n.method === method) listener(n.params); });
  }

  dispose(): void {
    this.#fail(new Error("harness client disposed"));
    const child = this.#child;
    if (!child) { this.#resolveClosed?.(); this.#resolveClosed = null; return; }
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (!this.#killTimer) {
      this.#killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        this.#killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1_000);
        this.#killTimer.unref();
      }, 250);
      this.#killTimer.unref();
    }
  }

  /** Resolves only once the owned process and its stdio handles have closed. */
  waitForClose(): Promise<void> { return this.#closed; }

  #respond(response: JsonRpcResponse): void {
    if (!this.#incoming.has(response.id)) throw new Error("server request is no longer pending");
    // Enqueue before consuming the ID so a local serialization failure is recoverable.
    this.#enqueue(response);
    this.#incoming.delete(response.id);
  }

  #enqueue(payload: JsonRpcMessage, id?: JsonRpcId): void {
    if (this.#failure || !this.#child?.stdin.writable) throw this.#failure ?? new Error("harness is not running");
    const frame = `${JSON.stringify(payload)}\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new Error("harness frame exceeds byte limit");
    if (this.#queuedBytes + bytes > (this.options.maxQueuedBytes ?? 16 * 1024 * 1024)) {
      throw new Error("harness input queue exceeds byte limit");
    }
    this.#outgoing.push({ frame, bytes, id });
    this.#queuedBytes += bytes;
    this.#flush();
  }

  #flush(): void {
    const child = this.#child;
    if (this.#failure || this.#waitingForDrain || !child) return;
    while (this.#outgoing.length) {
      const record = this.#outgoing.shift()!;
      this.#queuedBytes -= record.bytes;
      try {
        if (!child.stdin.write(record.frame)) { this.#waitingForDrain = true; return; }
      } catch { this.#fail(new Error("harness input pipe closed")); return; }
    }
  }

  #removeQueued(id: JsonRpcId): void {
    this.#outgoing = this.#outgoing.filter((record) => {
      if (record.id !== id) return true;
      this.#queuedBytes -= record.bytes;
      return false;
    });
  }

  #read(chunk: Buffer): void {
    if (this.#failure) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    let end: number;
    while ((end = this.#buffer.indexOf(10)) >= 0) {
      if (end > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) { this.#oversized(); return; }
      const line = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(line); }
      catch { this.#diagnostic("invalid UTF-8 protocol frame"); continue; }
      this.#onLine(decoded);
      if (this.#failure) return;
    }
    if (this.#buffer.length > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) this.#oversized();
  }

  #oversized(): void {
    this.#fail(new Error("harness output frame exceeds byte limit"));
    this.dispose();
  }

  #fail(reason: Error): void {
    if (this.#failure) return;
    this.#failure = reason;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.#pending.clear(); this.#incoming.clear(); this.#outgoing = []; this.#queuedBytes = 0;
    this.#buffer = Buffer.alloc(0);
    this.#emit({ jsonrpc: "2.0", method: "harness/disconnected", params: { message: reason.message } });
  }

  #diagnostic(message: string): void {
    // Protocol frames, stderr and exception objects may contain credentials or private records.
    if (this.options.onDiagnostic) { try { this.options.onDiagnostic(message); } catch {} }
    else process.stderr.write(`[harness] ${message}\n`);
  }

  #emit(notification: JsonRpcNotification): void {
    for (const listener of this.#listeners) {
      try { listener(notification); } catch { this.#diagnostic("notification listener failed"); }
    }
  }

  #onLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.#diagnostic("invalid protocol frame"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== "2.0") return;
    if ("id" in message && validId(message.id) && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending || ("result" in message) === ("error" in message)) return;
      if ("error" in message && (!message.error || typeof message.error !== "object" ||
        typeof (message.error as JsonRpcError).message !== "string" ||
        typeof (message.error as JsonRpcError).code !== "number")) return;
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error((message.error as JsonRpcError).message));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string" || !message.method || "result" in message || "error" in message) return;
    if (!("id" in message)) { this.#emit(value as JsonRpcNotification); return; }
    if (!validId(message.id) || this.#incoming.has(message.id)) return;
    if (this.#incoming.size >= 256) { this.#fail(new Error("too many pending server requests")); this.dispose(); return; }
    this.#incoming.add(message.id);
    const request = value as JsonRpcRequest;
    if (!this.#requestListeners.size) {
      this.respondError(request.id, { code: -32601, message: "Method not found" }); return;
    }
    for (const listener of this.#requestListeners) {
      try { listener(request); }
      catch {
        if (this.#incoming.has(request.id)) this.respondError(request.id, { code: -32603, message: "Client request handler failed" });
      }
    }
  }
}

export { HarnessHostConnection, HarnessHostManager } from "./host";
export type { HarnessConnectionState, HarnessConnectionStatus, HarnessHostOptions } from "./host";
