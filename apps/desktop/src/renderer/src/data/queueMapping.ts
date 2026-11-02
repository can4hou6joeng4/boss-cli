import type { QueueItem, QueueListResponse } from "@boss-cli/protocol";

/**
 * 内核只返回有界投影：待处理与已结束条目各自封顶，并用 totalItems / truncated 说明总量。
 * 渲染层必须保留这两个字段，否则界面上会无痕丢掉老队列记录，待处理数量也会偏小。
 */
export interface QueuePage {
  items: QueueItem[];
  totalItems?: number;
  truncated?: boolean;
}

/** 校验并保留队列列表的总数 / 截断元数据；items 形状不符时返回 null，交由调用方按不可用处理。 */
export function queuePageOf(response: QueueListResponse | null | undefined): QueuePage | null {
  if (!response || !Array.isArray(response.items)) return null;
  const page: QueuePage = { items: response.items };
  const total = response.totalItems;
  // 总数只接受不小于已载入项的安全整数；异常时退回按已载入项计算。
  if (typeof total === "number" && Number.isSafeInteger(total) && total >= response.items.length) page.totalItems = total;
  if (typeof response.truncated === "boolean") page.truncated = response.truncated;
  return page;
}
