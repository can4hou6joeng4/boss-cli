import type { JsonRpcNotification } from "@boss-harness/protocol";

const ID_LIMIT = 200;
const START_LIMIT = 200;
/** 短回合通常是即时问答，切窗口期间完成不值得再打扰。 */
export const TURN_NOTIFY_MIN_MS = 20_000;

export interface TurnEvent {
  kind: "started" | "completed";
  threadId: string;
  turnId: string;
  status?: string;
}

export interface TurnNotificationContent {
  turnId: string;
  title: string;
  body: string;
}

function exactText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : null;
}

/** 解析回合开始 / 结束事件；字段不可读或方法不匹配时返回 null。 */
export function readTurnEvent(notification: JsonRpcNotification): TurnEvent | null {
  const method = notification?.method;
  if (method !== "turn/started" && method !== "turn/completed") return null;
  const params = notification.params;
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const threadId = exactText(record.threadId, ID_LIMIT);
  const turnId = exactText(record.turnId, ID_LIMIT);
  if (!threadId || !turnId) return null;
  const status = typeof record.status === "string" ? record.status.trim().slice(0, 32) : "";
  return { kind: method === "turn/started" ? "started" : "completed", threadId, turnId, ...(status ? { status } : {}) };
}

/** 记录回合开始时间；超出上限淘汰最早记录，避免长期运行后映射无限增长。 */
export function recordTurnStart(starts: Map<string, number>, turnId: string, startedAt: number, limit = START_LIMIT): void {
  starts.set(turnId, startedAt);
  while (starts.size > limit) {
    const oldest = starts.keys().next().value;
    if (oldest === undefined) break;
    starts.delete(oldest);
  }
}

/** 回合时长；开始或结束时间不可读、或结束早于开始时返回 null。 */
export function turnDurationMs(startedAt: unknown, finishedAt: unknown): number | null {
  if (typeof startedAt !== "number" || typeof finishedAt !== "number") return null;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  const duration = finishedAt - startedAt;
  return duration >= 0 ? duration : null;
}

export function formatTurnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** 按回合终态给出提醒标题；未知状态回退到通用文案。 */
export function turnStatusLabel(status: unknown): string {
  switch (status) {
    case "completed": return "回合已完成";
    case "interrupted": return "回合已中断";
    case "blocked": return "回合已暂停";
    case "error": return "回合出错";
    default: return "回合已结束";
  }
}

/**
 * 构造回合结束的桌面通知内容；只接受 `turn/completed`，开始时间不可读、
 * 时长不足 20 秒或字段缺失时返回 null。
 */
export function turnNotificationContent(
  notification: JsonRpcNotification, startedAt: unknown, now = Date.now(),
): TurnNotificationContent | null {
  const event = readTurnEvent(notification);
  if (!event || event.kind !== "completed") return null;
  const duration = turnDurationMs(startedAt, now);
  if (duration === null || duration < TURN_NOTIFY_MIN_MS) return null;
  return {
    turnId: event.turnId,
    title: turnStatusLabel(event.status),
    body: `运行 ${formatTurnDuration(duration)}，点击回到工作台查看详情。`,
  };
}
