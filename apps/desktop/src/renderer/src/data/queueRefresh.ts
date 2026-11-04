/** 队列手动刷新的结果：成功时不带原因，失败时带回可展示的原因。 */
export interface QueueRefreshResult {
  ok: boolean;
  /** 失败原因；成功时缺省。 */
  message?: string;
}

const MESSAGE_LIMIT = 240;

/**
 * 解读一次手动刷新的返回值；成功返回 null，失败返回可展示的原因。
 * 返回值不可读或原因为空时给出保守文案，不能把未确认显示成刷新成功。
 */
export function queueRefreshErrorText(value: unknown): string | null {
  if (!value || typeof value !== "object") return "刷新结果未确认";
  const record = value as Record<string, unknown>;
  if (record.ok === true) return null;
  const message = typeof record.message === "string"
    ? record.message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_LIMIT)
    : "";
  return message || "原因未知";
}
