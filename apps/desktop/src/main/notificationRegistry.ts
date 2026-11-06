/**
 * 系统通知的引用保留。
 *
 * Electron 的 `Notification` 由 JS 对象弱持有：对象被垃圾回收后，`click` 监听不再触发，
 * 通知也可能从通知中心消失。保留最近若干条引用，直到通知关闭或显示失败。
 */
export interface RetainableNotification {
  show(): void;
  once(event: "close" | "failed", listener: () => void): unknown;
}

export const NOTIFICATION_RETENTION_LIMIT = 32;

export class NotificationRegistry {
  private readonly retained = new Set<RetainableNotification>();
  private readonly limit: number;

  constructor(limit: number = NOTIFICATION_RETENTION_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("通知保留上限必须是正整数");
    this.limit = limit;
  }

  /** 保留并显示通知；重复显示同一对象时重新排到最新，避免被当成最旧的一条淘汰。 */
  show(notification: RetainableNotification): void {
    this.retained.delete(notification);
    this.retained.add(notification);
    while (this.retained.size > this.limit) {
      const oldest = this.retained.values().next().value;
      if (oldest === undefined) break;
      this.retained.delete(oldest);
    }
    const release = (): void => { this.retained.delete(notification); };
    notification.once("close", release);
    notification.once("failed", release);
    notification.show();
  }

  /** 当前保留的通知数量；供诊断与离线探针使用。 */
  get size(): number {
    return this.retained.size;
  }
}
