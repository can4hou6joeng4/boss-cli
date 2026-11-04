/** 主进程测试通知的返回值解读；未确认的情况不能显示成「已发送」。 */
export type NotificationTestOutcome = "sent" | "unsupported" | "unconfirmed";

export function readNotificationTestResult(value: unknown): NotificationTestOutcome {
  if (!value || typeof value !== "object") return "unconfirmed";
  const record = value as Record<string, unknown>;
  if (record.sent === true) return "sent";
  if (record.sent === false && record.supported === false) return "unsupported";
  return "unconfirmed";
}
