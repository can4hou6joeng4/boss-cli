import type { QueueItem, QueueListResponse } from "@boss-harness/protocol";

/**
 * 内核只返回有界投影：待处理与已结束条目各自封顶，并用 totalItems / truncated 说明总量。
 * 渲染层必须保留这两个字段，否则界面上会无痕丢掉老队列记录，待处理数量也会偏小。
 */
export interface QueuePage {
  items: QueueItem[];
  totalItems?: number;
  /** 内核按全部持久项统计的待处理数（排队 / 投递中 / 暂停）；旧内核缺省。 */
  activeItems?: number;
  truncated?: boolean;
}

const QUEUE_KINDS: ReadonlySet<string> = new Set(["steering", "followUp"]);
const QUEUE_STATUSES: ReadonlySet<string> = new Set(["queued", "delivering", "delivered", "paused", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 自动压缩覆盖是部分字段：缺省继承内核默认值，出现时必须与界面读取的类型一致。 */
function isAutoCompaction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.triggerPercent !== undefined && !Number.isSafeInteger(value.triggerPercent)) return false;
  if (value.keepRecentTokens !== undefined && !Number.isSafeInteger(value.keepRecentTokens)) return false;
  return true;
}

/**
 * 队列项逐项校验。界面直接渲染 `id` / `kind` / `input` / `status` 并把 `input` 当 React 子节点，
 * 畸形元素会在渲染期抛错并落到会话区错误边界，因此状态里只允许通过校验的条目。
 */
export function isQueueItem(value: unknown): value is QueueItem {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.kind !== "string" || !QUEUE_KINDS.has(value.kind)) return false;
  if (typeof value.input !== "string") return false;
  if (typeof value.status !== "string" || !QUEUE_STATUSES.has(value.status)) return false;
  if (value.expectedTurnId != null && typeof value.expectedTurnId !== "string") return false;
  if (value.clientUserMessageId != null && typeof value.clientUserMessageId !== "string") return false;
  if (value.skillIds !== undefined
    && !(Array.isArray(value.skillIds) && value.skillIds.every(id => typeof id === "string"))) return false;
  if (value.autoCompaction !== undefined && !isAutoCompaction(value.autoCompaction)) return false;
  if (value.failureCode !== undefined && value.failureCode !== "TURN_START_FAILED") return false;
  if (value.executionStarted !== undefined && value.executionStarted !== false) return false;
  if (value.turnId !== undefined && typeof value.turnId !== "string") return false;
  if (value.inputPersisted !== undefined && typeof value.inputPersisted !== "boolean") return false;
  if (value.deduplicated !== undefined && typeof value.deduplicated !== "boolean") return false;
  if (value.inputTruncated !== undefined && typeof value.inputTruncated !== "boolean") return false;
  return true;
}

/** 列表整体校验：任一项非法即整体不可用，避免只渲染一部分时界面数量与内核总数对不上。 */
export function queueItemsOf(value: unknown): QueueItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: QueueItem[] = [];
  for (const item of value) {
    if (!isQueueItem(item)) return null;
    items.push(item);
  }
  return items;
}

/** 校验并保留队列列表的总数 / 待处理数 / 截断元数据；items 形状不符时返回 null，交由调用方按不可用处理。 */
export function queuePageOf(response: QueueListResponse | null | undefined): QueuePage | null {
  if (!response) return null;
  const items = queueItemsOf(response.items);
  if (!items) return null;
  const page: QueuePage = { items };
  const total = response.totalItems;
  // 总数只接受不小于已载入项的安全整数；异常时退回按已载入项计算。
  if (typeof total === "number" && Number.isSafeInteger(total) && total >= items.length) page.totalItems = total;
  const active = response.activeItems;
  // 待处理数可以大于已载入项，但不能超过持久总数。
  if (typeof active === "number" && Number.isSafeInteger(active) && active >= 0
    && (page.totalItems === undefined || active <= page.totalItems)) page.activeItems = active;
  if (typeof response.truncated === "boolean") page.truncated = response.truncated;
  return page;
}

/**
 * 在队列投影里查找「提交结果未确认」的消息。
 *
 * 投影只保留有限条目：`truncated` 为真表示还有未载入的记录，此时未命中不能证明消息不在队列。
 * 只有投影完整时才允许返回 `missing`，避免界面把「没读到」当成「不存在」并引导重复提交。
 */
export type QueueSubmissionLookup =
  | { status: "found"; item: QueueItem }
  | { status: "cancelled"; item: QueueItem }
  | { status: "missing" }
  | { status: "unknown" };

export function queueSubmissionLookup(page: QueuePage, clientUserMessageId: string): QueueSubmissionLookup {
  const item = page.items.find(candidate => candidate.clientUserMessageId === clientUserMessageId);
  if (item) return item.status === "cancelled" ? { status: "cancelled", item } : { status: "found", item };
  return page.truncated === true ? { status: "unknown" } : { status: "missing" };
}
