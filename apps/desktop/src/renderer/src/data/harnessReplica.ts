import type { EventListResponse, ItemListResponse, ThreadReadResponse } from "@boss-cli/protocol";
import type { HarnessEvent } from "./harnessEvents";

interface Api { request<T>(method: string, params?: unknown): Promise<T> }
function cursor(event: HarnessEvent): bigint | null {
  const value = event.params?.eventCursor;
  return typeof value === "string" && /^\d{1,19}$/.test(value) ? BigInt(value) : null;
}

/** Snapshot + ordered replay; subscriptions stay live while history pages load. */
export class HarnessReplica {
  private readonly cursors = new Map<string, bigint>();
  private readonly loading = new Map<string, { buffered: HarnessEvent[]; flight: Promise<ThreadReadResponse | null> }>();
  private epoch = 0;
  private readonly api: Api;
  private readonly onEvent: (event: HarnessEvent) => void;
  private readonly onSnapshot: (snapshot: ThreadReadResponse) => void;
  constructor(api: Api, onEvent: (event: HarnessEvent) => void, onSnapshot: (snapshot: ThreadReadResponse) => void) {
    this.api = api; this.onEvent = onEvent; this.onSnapshot = onSnapshot;
  }

  invalidate(): void {
    this.epoch += 1;
    this.loading.clear();
    this.cursors.clear();
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
    this.onEvent(event);
  }

  resume(threadId: string): Promise<ThreadReadResponse | null> {
    const existing = this.loading.get(threadId);
    if (existing) return existing.flight;
    const epoch = this.epoch, buffered: HarnessEvent[] = [];
    const flight = Promise.resolve().then(async () => {
      const snapshot = await this.api.request<ThreadReadResponse>("thread/resume", { threadId, excludeTurns: true, snapshot: true });
      if (epoch !== this.epoch) return null;
      if (snapshot.snapshotId) {
        const items: ThreadReadResponse["items"] = [];
        let pageCursor: string | null = null;
        do {
          const page: ItemListResponse = await this.api.request("thread/items/list", {
            threadId, snapshotId: snapshot.snapshotId, cursor: pageCursor, limit: 100,
          });
          if (epoch !== this.epoch) return null;
          items.push(...page.items); pageCursor = page.nextCursor;
        } while (pageCursor);
        snapshot.items = items;
      } else {
        // Compatibility with 0.1 servers that do not expose stable snapshot pages.
        const full = await this.api.request<ThreadReadResponse>("thread/read", { threadId });
        snapshot.items = full.items;
      }
      if (epoch !== this.epoch) return null;
      this.onSnapshot(snapshot);
      let after = snapshot.eventCursor ?? "0";
      this.cursors.set(threadId, BigInt(after));
      if (snapshot.eventCursor !== undefined) {
        let more = true;
        while (more) {
          const page: EventListResponse = await this.api.request("event/list", { threadId, cursor: after, limit: 200 });
          if (epoch !== this.epoch) return null;
          for (const event of page.events) this.apply(event as HarnessEvent);
          after = page.nextCursor; more = page.hasMore;
        }
      }
      if (epoch !== this.epoch) return null;
      return snapshot;
    }).catch(() => null).finally(() => {
      if (epoch === this.epoch) {
        buffered.sort((a, b) => { const x = cursor(a) ?? 0n, y = cursor(b) ?? 0n; return x < y ? -1 : x > y ? 1 : 0; });
        for (const event of buffered) this.apply(event);
      }
      if (this.loading.get(threadId)?.flight === flight) this.loading.delete(threadId);
    });
    this.loading.set(threadId, { buffered, flight });
    return flight;
  }
}
