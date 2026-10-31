import type { EventListResponse, ItemContentReference, ItemContentReadResponse, ItemListResponse, ThreadItem, ThreadReadResponse } from "@boss-cli/protocol";
import type { HarnessEvent } from "./harnessEvents";

interface Api { request<T>(method: string, params?: unknown): Promise<T> }
function validateContentReference(reference: ItemContentReference): void {
  if (!reference || reference.encoding !== "text" || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256) ||
      typeof reference.itemId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(reference.itemId) ||
      typeof reference.threadId !== "string" || !/^[a-f0-9]{12}$/.test(reference.threadId) ||
      (reference.part !== "text" && reference.part !== "thinking") ||
      (reference.snapshotId !== undefined && (typeof reference.snapshotId !== "string" || !/^[a-f0-9]{32}$/.test(reference.snapshotId))) ||
      !Number.isSafeInteger(reference.characterLength) || !Number.isSafeInteger(reference.byteLength) ||
      reference.characterLength < 1 || reference.byteLength < reference.characterLength ||
      reference.byteLength > reference.characterLength * 4 || reference.byteLength > 16 * 1024 * 1024) {
    throw new Error("会话内容引用无效或超出自动恢复上限");
  }
}
function cursor(event: HarnessEvent): bigint | null {
  const value = event.params?.eventCursor;
  return typeof value === "string" && /^\d{1,19}$/.test(value) ? BigInt(value) : null;
}

/** Snapshot + ordered replay; subscriptions stay live while history pages load. */
export class HarnessReplica {
  private readonly cursors = new Map<string, bigint>();
  private readonly loading = new Map<string, { buffered: HarnessEvent[]; flight: Promise<ThreadReadResponse | null> }>();
  private epoch = 0;
  private readonly generations = new Map<string, number>();
  private readonly itemVersions = new Map<string, number>();
  private nextItemVersion = 0;
  private readonly api: Api;
  private readonly onEvent: (event: HarnessEvent) => void;
  private readonly onSnapshot: (snapshot: ThreadReadResponse) => void;
  /** 内核声明 sessionBranchViews 时为真：已分支的会话改按当前分支（view=branch）读取。 */
  private readonly branchViews: () => boolean;
  constructor(api: Api, onEvent: (event: HarnessEvent) => void, onSnapshot: (snapshot: ThreadReadResponse) => void,
    branchViews: () => boolean = () => false) {
    this.api = api; this.onEvent = onEvent; this.onSnapshot = onSnapshot; this.branchViews = branchViews;
  }

  /** 分支指针移动后重新读取；若已有读取在途，等它结束后再读一次，避免沿用切换前的快照。 */
  reload(threadId: string): Promise<ThreadReadResponse | null> {
    const existing = this.loading.get(threadId);
    return existing ? existing.flight.then(() => this.resume(threadId)) : this.resume(threadId);
  }

  /**
   * 已分支会话的当前分支投影。内核暂不支持分支视图的冻结快照，因此优先用一次性的
   * thread/read（条目与事件游标同锁读取）；响应过大时退回按分支分页读取条目。
   */
  private async branchSnapshot(threadId: string, current: () => void): Promise<ThreadReadResponse | null> {
    if (!this.branchViews()) return null;
    const probe = await this.api.request<ThreadReadResponse>("thread/read", { threadId, excludeTurns: true, view: "branch" });
    current();
    if (probe.view !== "branch" || !probe.branch || probe.branch.threadId !== threadId) throw new Error("分支视图响应无效");
    if (!probe.branch.branched) return null;
    let snapshot: ThreadReadResponse;
    try {
      snapshot = await this.api.request<ThreadReadResponse>("thread/read", { threadId, view: "branch" });
    } catch (error) {
      if (!(error instanceof Error) || !/RESPONSE_TOO_LARGE|会话响应过大/.test(error.message)) throw error;
      current();
      snapshot = probe;
      const items: ThreadItem[] = [];
      let pageCursor: string | null = null;
      do {
        const page: ItemListResponse = await this.api.request("thread/items/list", { threadId, view: "branch", cursor: pageCursor, limit: 100 });
        current();
        items.push(...page.items); pageCursor = page.nextCursor;
      } while (pageCursor);
      snapshot.items = items;
    }
    current();
    if (snapshot.view !== "branch" || snapshot.thread?.id !== threadId) throw new Error("分支视图响应无效");
    const hydrated: ThreadItem[] = [];
    for (const item of snapshot.items) { current(); hydrated.push(await this.resolveItemContent(item, threadId, undefined, current)); }
    snapshot.items = hydrated;
    return snapshot;
  }

  invalidate(): void {
    this.epoch += 1;
    this.loading.clear();
    this.cursors.clear();
    this.generations.clear();
    this.itemVersions.clear();
  }

  ingest(event: HarnessEvent): void {
    const id = event.params?.threadId;
    if (id && this.loading.has(id)) { this.loading.get(id)!.buffered.push(event); return; }
    this.apply(event);
  }

  private apply(event: HarnessEvent): void {
    const id = event.params?.threadId, value = cursor(event);
    if (id && value !== null) {
      if (value <= (this.cursors.get(id) ?? -1n)) return;
      this.cursors.set(id, value);
    }
    const itemId = event.params?.itemId;
    const key = id && itemId ? `${id}\0${itemId}` : undefined;
    const version = ++this.nextItemVersion;
    if (key) this.itemVersions.set(key, version);
    const epoch = this.epoch;
    const generation = id ? this.generations.get(id) : undefined;
    this.onEvent(event);
    if (event.method === "item/completed" && (event.params?.textRef || event.params?.thinkingRef)) {
      const current = () => {
        if (epoch !== this.epoch || (id && this.generations.get(id) !== generation) ||
            (key && this.itemVersions.get(key) !== version)) throw new Error("内容加载已过期");
      };
      void this.resolveEventContent(event, current).then(content => {
        current();
        this.onEvent({ ...event, params: { ...event.params, ...content } });
      }).catch(error => {
        try { current(); this.reportFailure(id ?? "", error); } catch { /* newer state owns it */ }
      });
    }
  }

  resume(threadId: string): Promise<ThreadReadResponse | null> {
    const existing = this.loading.get(threadId);
    if (existing) return existing.flight;
    const epoch = this.epoch, buffered: HarnessEvent[] = [];
    const generation = (this.generations.get(threadId) ?? 0) + 1;
    this.generations.set(threadId, generation);
    for (const key of this.itemVersions.keys()) if (key.startsWith(`${threadId}\0`)) this.itemVersions.delete(key);
    const current = () => {
      if (epoch !== this.epoch || this.generations.get(threadId) !== generation) throw new Error("会话恢复已过期");
    };
    const flight = Promise.resolve().then(async () => {
      current();
      const branched = await this.branchSnapshot(threadId, current);
      const snapshot = branched ?? await this.api.request<ThreadReadResponse>("thread/resume", { threadId, excludeTurns: true, snapshot: true });
      current();
      if (branched) {
        // Items were read together with the branch projection above.
      } else if (snapshot.snapshotId) {
        const items: ThreadReadResponse["items"] = [];
        let pageCursor: string | null = null;
        do {
          const page: ItemListResponse = await this.api.request("thread/items/list", {
            threadId, snapshotId: snapshot.snapshotId, cursor: pageCursor, limit: 100,
          });
          current();
          items.push(...page.items); pageCursor = page.nextCursor;
        } while (pageCursor);
        const hydrated: ThreadItem[] = [];
        for (const item of items) { current(); hydrated.push(await this.resolveItemContent(item, threadId, snapshot.snapshotId, current)); }
        snapshot.items = hydrated;
      } else {
        // Compatibility with 0.1 servers that do not expose stable snapshot pages.
        const full = await this.api.request<ThreadReadResponse>("thread/read", { threadId });
        current();
        const hydrated: ThreadItem[] = [];
        for (const item of full.items) { current(); hydrated.push(await this.resolveItemContent(item, threadId, undefined, current)); }
        snapshot.items = hydrated;
      }
      current();
      this.onSnapshot(snapshot);
      let after = snapshot.eventCursor ?? "0";
      this.cursors.set(threadId, BigInt(after));
      if (snapshot.eventCursor !== undefined) {
        let more = true;
        while (more) {
          const page: EventListResponse = await this.api.request("event/list", { threadId, cursor: after, limit: 200 });
          current();
          for (const event of page.events) this.apply(event as HarnessEvent);
          after = page.nextCursor; more = page.hasMore;
        }
      }
      current();
      return snapshot;
    }).catch(error => {
      try { current(); this.reportFailure(threadId, error); } catch { /* superseded recovery */ }
      return null;
    }).finally(() => {
      if (epoch === this.epoch && this.generations.get(threadId) === generation) {
        buffered.sort((a, b) => { const x = cursor(a) ?? 0n, y = cursor(b) ?? 0n; return x < y ? -1 : x > y ? 1 : 0; });
        for (const event of buffered) this.apply(event);
      }
      if (this.loading.get(threadId)?.flight === flight) this.loading.delete(threadId);
    });
    this.loading.set(threadId, { buffered, flight });
    return flight;
  }

  private reportFailure(threadId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "响应无效";
    this.onEvent({ method: "session/error", params: { threadId,
      message: `读取会话内容失败：${detail}。已保留当前内容，请重新打开会话重试。` } });
  }

  private async readContent(reference: ItemContentReference, current: () => void): Promise<string> {
    current();
    validateContentReference(reference);
    let cursor: string | undefined;
    let offset = 0;
    let byteLength = 0;
    let text = "";
    while (true) {
      const response = await this.api.request<ItemContentReadResponse>("thread/item/content/read", {
        threadId: reference.threadId, itemId: reference.itemId, part: reference.part,
        sha256: reference.sha256, snapshotId: reference.snapshotId, cursor, limit: 16384,
      });
      current();
      const actual = response.contentRef;
      if (!actual || (["threadId", "itemId", "part", "encoding", "sha256", "byteLength", "characterLength", "snapshotId"] as const)
        .some(key => actual[key] !== reference[key])) throw new Error("会话内容版本已变化");
      if (response.offset !== offset || typeof response.text !== "string" || response.text.length > 32768) {
        throw new Error("会话内容分段无效");
      }
      const length = Array.from(response.text).length;
      if (length < 1 || length > 16384) throw new Error("会话内容分段长度无效");
      const chunkBytes = new TextEncoder().encode(response.text).byteLength;
      if (offset + length > reference.characterLength || byteLength + chunkBytes > reference.byteLength) {
        throw new Error("会话内容分段超过引用长度");
      }
      text += response.text;
      offset += length;
      byteLength += chunkBytes;
      if (response.nextCursor === null) break;
      if (typeof response.nextCursor !== "string" || !response.nextCursor.startsWith("ic1_") ||
          response.nextCursor.length > 2048 || response.nextCursor === cursor || offset >= reference.characterLength) {
        throw new Error("会话内容游标无效");
      }
      cursor = response.nextCursor;
    }
    const bytes = new TextEncoder().encode(text);
    current();
    if (offset !== reference.characterLength || bytes.byteLength !== reference.byteLength) {
      throw new Error("会话内容长度校验失败");
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    current();
    const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== reference.sha256) throw new Error("会话内容摘要校验失败");
    return text;
  }

  private async resolveItemContent(item: ThreadItem, threadId: string, snapshotId: string | undefined, current: () => void): Promise<ThreadItem> {
    const resolved = { ...item };
    for (const part of ["text", "thinking"] as const) {
      const reference = part === "text" ? item.textRef : item.thinkingRef;
      if (!reference) continue;
      validateContentReference(reference);
      if (reference.threadId !== threadId || reference.itemId !== item.id || reference.part !== part ||
          reference.snapshotId !== snapshotId) {
        throw new Error("会话内容引用归属无效");
      }
      resolved[part] = await this.readContent(reference, current);
    }
    return resolved;
  }

  private async resolveEventContent(event: HarnessEvent, current: () => void): Promise<{ text?: string; thinking?: string }> {
    const content: { text?: string; thinking?: string } = {};
    for (const part of ["text", "thinking"] as const) {
      const reference = part === "text" ? event.params?.textRef : event.params?.thinkingRef;
      if (!reference) continue;
      validateContentReference(reference);
      if (!event.params?.threadId || !event.params.itemId || reference.threadId !== event.params.threadId ||
          reference.itemId !== event.params.itemId || reference.part !== part || reference.snapshotId !== undefined) {
        throw new Error("会话事件内容引用归属无效");
      }
      const text = await this.readContent(reference, current);
      if (part === "text") content.text = text; else content.thinking = text;
    }
    return content;
  }
}
