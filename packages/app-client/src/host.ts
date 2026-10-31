import type { InitializeResponse, JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "@boss-cli/protocol";
import { HarnessClient, type HarnessClientOptions } from "./index";

export type HarnessConnectionState = "cold" | "starting" | "initializing" | "ready" | "disconnected" | "stopped";

export interface HarnessConnectionStatus {
  hostId: string;
  state: HarnessConnectionState;
  generation: number;
  running: boolean;
  reconnectAttempt: number;
  retryAt?: number;
  error?: string;
  modelBridge?: InitializeResponse["modelBridge"];
  capabilities?: InitializeResponse["capabilities"];
}

export interface HarnessHostOptions {
  hostId: string;
  client: HarnessClientOptions;
  clientInfo: { name: string; version: string };
  protocolVersion?: string;
  /** Transport capability. Reconnection creates a fresh transport, never replays requests. */
  supportsReconnect?: boolean;
  autoReconnect?: { maxAttempts: number; initialDelayMs?: number; maxDelayMs?: number };
}

type ApprovalRoute = {
  requestId: JsonRpcId;
  generation: number;
  threadId: string;
  itemId: string;
  timer: ReturnType<typeof setTimeout>;
};

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * One host owns one process generation and one initialization flight. The design
 * follows the observed host/transport split; the recruitment kernel remains a
 * separate process. Pending mutation outcomes are never retried after disconnect.
 */
export class HarnessHostConnection {
  readonly hostId: string;
  private readonly options: HarnessHostOptions;
  #state: HarnessConnectionState = "cold";
  #generation = 0;
  #client: HarnessClient | null = null;
  #connecting: Promise<InitializeResponse> | null = null;
  #restarting: Promise<InitializeResponse> | null = null;
  #retiring: Promise<void> | null = null;
  #initialized: InitializeResponse | undefined;
  #error: string | undefined;
  #listeners = new Set<(notification: JsonRpcNotification) => void>();
  #approvals = new Map<string, ApprovalRoute>();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAt: number | undefined;
  #reconnectAttempt = 0;

  constructor(options: HarnessHostOptions) {
    this.options = options;
    this.hostId = options.hostId;
  }

  status(): HarnessConnectionStatus {
    return {
      hostId: this.hostId, state: this.#state, generation: this.#generation,
      running: this.#state === "ready", reconnectAttempt: this.#reconnectAttempt,
      ...(this.#retryAt !== undefined ? { retryAt: this.#retryAt } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#initialized ? { modelBridge: this.#initialized.modelBridge } : {}),
      ...(this.#initialized?.capabilities ? { capabilities: this.#initialized.capabilities } : {}),
    };
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** All callers share the same initialize -> initialized handshake. */
  ensureReady(): Promise<InitializeResponse> {
    if (this.#state === "stopped") return Promise.reject(new Error("harness host has stopped"));
    if (this.#state === "ready" && this.#initialized) return Promise.resolve(this.#initialized);
    if (this.#connecting) return this.#connecting;
    this.#clearRetry();
    let client: HarnessClient | null = null;
    let generation = 0;
    // Retire the previous writer before a new process opens the same session store.
    // Set the shared promise first; state observers may call ensureReady again.
    const work = Promise.resolve().then(async () => {
      if (this.#retiring) await this.#retiring;
      if (this.#connecting !== flight || this.#state === "stopped") throw new Error("harness connection superseded");
      generation = ++this.#generation;
      const connection = new HarnessClient(this.options.client);
      client = connection;
      this.#client = connection;
      this.#error = undefined;
      this.#initialized = undefined;
      connection.onNotification((notification) => {
        if (!this.#isCurrent(connection, generation)) return;
        if (notification.method === "harness/disconnected") {
          const params = object(notification.params) ? notification.params : {};
          this.#disconnected(connection, generation, typeof params.message === "string" ? params.message : "harness disconnected");
          return;
        }
        this.#expireFinishedApprovals(notification, connection);
        this.#emit(notification);
      });
      connection.onRequest((request) => {
        if (this.#isCurrent(connection, generation)) this.#serverRequest(request, connection, generation);
      });
      this.#setState("starting");
      connection.start();
      this.#setState("initializing");
      const response = await connection.request<InitializeResponse>("initialize", {
        protocolVersion: this.options.protocolVersion ?? "0.2.0",
        clientInfo: this.options.clientInfo,
        capabilities: { experimentalApi: false, bidirectionalRequests: true },
      });
      if (!this.#isCurrent(connection, generation)) throw new Error("harness connection superseded");
      if (!object(response) || typeof response.serverName !== "string" || typeof response.protocolVersion !== "string") {
        throw new Error("invalid harness initialize response");
      }
      connection.notify("initialized");
      this.#initialized = response;
      this.#error = undefined;
      // A process that briefly becomes ready and crashes again must not reset
      // the retry budget. Explicit reconnect starts a new recovery budget.
      this.#setState("ready");
      return response;
    });
    const flight = work.catch((error: unknown) => {
      if (client && this.#isCurrent(client, generation)) this.#disconnected(client, generation,
        error instanceof Error ? error.message : "harness initialization failed");
      throw error;
    }).finally(() => {
      if (this.#connecting === flight) {
        this.#connecting = null;
        if (this.#state === "disconnected") this.#scheduleReconnect();
      }
    });
    this.#connecting = flight;
    return flight;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureReady();
    const client = this.#client;
    if (!client || this.#state !== "ready") throw new Error("harness connection changed before request");
    if (method === "approval/respond" && object(params) && typeof params.approvalId === "string") {
      if (typeof params.approved !== "boolean") throw new Error("approval decision must be a boolean");
      const route = this.#approvals.get(params.approvalId);
      if (route) {
        if (route.generation !== this.#generation) throw new Error("approval belongs to a previous connection");
        if (this.#initialized?.capabilities?.durableApprovals !== true) {
          clearTimeout(route.timer);
          this.#approvals.delete(params.approvalId);
          client.respond(route.requestId, { approved: params.approved });
          return { accepted: true } as T;
        }
      }
      if (this.#initialized?.capabilities?.durableApprovals !== true &&
          this.#initialized?.protocolVersion !== "0.1.0") throw new Error("approval is no longer pending");
      // v0.1 kernels can still issue approval notifications and accept the legacy method.
    }
    return client.request<T>(method, params);
  }

  /** Explicit recovery starts a fresh generation and invalidates old approvals. */
  reconnect(): Promise<InitializeResponse> {
    if (this.#state === "stopped") return Promise.reject(new Error("harness host has stopped"));
    if (this.#restarting) return this.#restarting;
    this.#clearRetry();
    const old = this.#client;
    this.#client = null;
    this.#generation += 1;
    this.#connecting = null;
    this.#initialized = undefined;
    this.#clearApprovals();
    if (old) this.#retire(old);
    this.#reconnectAttempt = 0;
    const restart = this.ensureReady().finally(() => { if (this.#restarting === restart) this.#restarting = null; });
    this.#restarting = restart;
    this.#setState("disconnected");
    return restart;
  }

  dispose(): void {
    if (this.#state === "stopped") return;
    this.#clearRetry();
    this.#generation += 1;
    const client = this.#client;
    this.#client = null; this.#connecting = null; this.#initialized = undefined;
    this.#clearApprovals();
    if (client) this.#retire(client);
    this.#setState("stopped");
  }

  #isCurrent(client: HarnessClient, generation: number): boolean {
    return this.#client === client && this.#generation === generation && this.#state !== "stopped";
  }

  #disconnected(client: HarnessClient, generation: number, message: string): void {
    if (!this.#isCurrent(client, generation)) return;
    this.#client = null; this.#initialized = undefined; this.#error = message;
    this.#clearApprovals();
    this.#retire(client);
    this.#setState("disconnected");
    this.#emit({ jsonrpc: "2.0", method: "harness/disconnected", params: {
      hostId: this.hostId, generation, message, outcome: "unknown", automaticReplay: false,
    } });
    if (!this.#connecting) this.#scheduleReconnect();
  }

  #retire(client: HarnessClient): void {
    client.dispose();
    const closed = client.waitForClose();
    const retiring = this.#retiring ? Promise.all([this.#retiring, closed]).then(() => {}) : closed;
    this.#retiring = retiring;
    void retiring.finally(() => { if (this.#retiring === retiring) this.#retiring = null; });
  }

  /** The synchronous dispose API remains compatible; hosts can also await teardown. */
  waitForClose(): Promise<void> { return this.#retiring ?? Promise.resolve(); }

  #scheduleReconnect(): void {
    const retry = this.options.autoReconnect;
    if (!this.options.supportsReconnect || !retry || this.#state !== "disconnected" || this.#retryTimer ||
      this.#reconnectAttempt >= retry.maxAttempts) return;
    const delay = Math.min((retry.initialDelayMs ?? 500) * 2 ** this.#reconnectAttempt, retry.maxDelayMs ?? 10_000);
    this.#retryAt = Date.now() + delay;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null; this.#retryAt = undefined;
      this.#reconnectAttempt += 1;
      void this.ensureReady().catch(() => { /* State and bounded retry policy report this failure. */ });
    }, delay);
    this.#retryTimer.unref();
    this.#broadcastStatus();
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null; this.#retryAt = undefined;
  }

  #serverRequest(request: JsonRpcRequest, client: HarnessClient, generation: number): void {
    if (request.method !== "item/tool/requestApproval") {
      client.respondError(request.id, { code: -32601, message: "Method not found" }); return;
    }
    const params = request.params;
    if (!object(params) || typeof params.approvalId !== "string" || !params.approvalId ||
      typeof params.threadId !== "string" || typeof params.itemId !== "string" ||
      typeof params.toolName !== "string" || typeof params.summary !== "string" ||
      typeof params.consequential !== "boolean" || this.#approvals.has(params.approvalId)) {
      client.respondError(request.id, { code: -32602, message: "Invalid approval request" }); return;
    }
    const approvalId = params.approvalId;
    let deadline = Date.now() + (this.#initialized?.approval?.timeoutSeconds ?? 300) * 1_000;
    if (typeof params.deadline === "string") deadline = Date.parse(params.deadline);
    if (typeof params.deadline === "number") deadline = params.deadline > 1e12 ? params.deadline : params.deadline * 1_000;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      client.respondError(request.id, { code: -32001, message: "Approval expired" }); return;
    }
    const timer = setTimeout(() => {
      const route = this.#approvals.get(approvalId);
      if (route?.generation !== generation) return;
      this.#approvals.delete(approvalId);
      if (this.#isCurrent(client, generation)) {
        try { client.respondError(request.id, { code: -32001, message: "Approval expired" }); } catch {}
      }
    }, Math.min(deadline - Date.now(), 2_147_483_647));
    timer.unref();
    this.#approvals.set(approvalId, { requestId: request.id, generation, threadId: params.threadId, itemId: params.itemId, timer });
    this.#emit({ jsonrpc: "2.0", method: "approval/requested", params });
  }

  #expireFinishedApprovals(notification: JsonRpcNotification, client: HarnessClient): void {
    if (!object(notification.params)) return;
    const params = notification.params;
    for (const [approvalId, route] of this.#approvals) {
      const completedTurn = notification.method === "thread/updated" && params.threadId === route.threadId &&
        ["completed", "interrupted", "blocked", "error"].includes(String(params.status));
      const completedItem = notification.method === "item/completed" &&
        (params.itemId === route.itemId || (object(params.item) && params.item.id === route.itemId));
      if (!completedTurn && !completedItem) continue;
      clearTimeout(route.timer); this.#approvals.delete(approvalId);
      try { client.respondError(route.requestId, { code: -32001, message: "Approval no longer active" }); } catch {}
    }
  }

  #clearApprovals(): void {
    for (const route of this.#approvals.values()) clearTimeout(route.timer);
    this.#approvals.clear();
  }

  #setState(state: HarnessConnectionState): void { this.#state = state; this.#broadcastStatus(); }
  #broadcastStatus(): void { this.#emit({ jsonrpc: "2.0", method: "harness/connectionStatus", params: this.status() }); }
  #emit(notification: JsonRpcNotification): void {
    for (const listener of this.#listeners) {
      try { listener(notification); } catch { /* A detached window cannot break the host. */ }
    }
  }
}

/** Registry keeps host ownership out of individual windows. */
export class HarnessHostManager {
  #hosts = new Map<string, HarnessHostConnection>();

  add(options: HarnessHostOptions): HarnessHostConnection {
    if (this.#hosts.has(options.hostId)) throw new Error("harness host already registered");
    const host = new HarnessHostConnection(options);
    this.#hosts.set(options.hostId, host);
    return host;
  }

  get(hostId = "local"): HarnessHostConnection {
    const host = this.#hosts.get(hostId);
    if (!host) throw new Error("unknown harness host");
    return host;
  }

  list(): HarnessConnectionStatus[] { return [...this.#hosts.values()].map((host) => host.status()); }
  dispose(): void { for (const host of this.#hosts.values()) host.dispose(); this.#hosts.clear(); }
}
