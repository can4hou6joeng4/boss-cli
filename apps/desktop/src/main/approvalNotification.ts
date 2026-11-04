import type { JsonRpcNotification } from "@boss-harness/protocol";
import { safeSlice } from "@boss-harness/shared";

const ID_LIMIT = 200;
const TOOL_NAME_LIMIT = 120;
const TITLE_LIMIT = 80;
const BODY_LIMIT = 240;
const SEEN_LIMIT = 200;
const FALLBACK_BODY = "有操作等待你的批准，打开工作台查看。";

export interface ApprovalNotificationContent {
  approvalId: string;
  title: string;
  body: string;
  /** 仅当 threadId 与 itemId 都合法时携带，用于点击后定位审批卡。 */
  threadId?: string;
  itemId?: string;
}

function exactText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : null;
}

/** 折叠空白并按字符上限截断；通知正文不适合换行与超长文本。 */
function compact(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${safeSlice(collapsed, limit - 1).trimEnd()}…`;
}

/**
 * 从内核通知构造桌面通知内容；只接受审批请求，缺 approvalId / toolName 时返回 null。
 * 纯函数，不依赖 Electron，便于离线验证。
 */
export function approvalNotificationContent(notification: JsonRpcNotification): ApprovalNotificationContent | null {
  if (!notification || notification.method !== "approval/requested") return null;
  const params = notification.params;
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const approvalId = exactText(record.approvalId, ID_LIMIT);
  const toolName = exactText(record.toolName, TOOL_NAME_LIMIT);
  if (!approvalId || !toolName) return null;
  const summary = typeof record.summary === "string" ? compact(record.summary, BODY_LIMIT) : "";
  const threadId = exactText(record.threadId, ID_LIMIT);
  const itemId = exactText(record.itemId, ID_LIMIT);
  return {
    approvalId,
    title: compact(`待批准：${toolName}`, TITLE_LIMIT),
    body: summary || FALLBACK_BODY,
    ...(threadId && itemId ? { threadId, itemId } : {}),
  };
}

/**
 * 记录已提醒的审批 id，返回是否首次出现；超出上限时淘汰最早一条，
 * 避免长时间运行后集合无限增长。
 */
export function rememberApproval(seen: Set<string>, approvalId: string, limit = SEEN_LIMIT): boolean {
  if (seen.has(approvalId)) return false;
  seen.add(approvalId);
  while (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}
