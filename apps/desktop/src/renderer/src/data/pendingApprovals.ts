import type { PendingApproval } from "@boss-harness/protocol";

const FIELD_LIMIT = 200;
const SUMMARY_LIMIT = 400;
const DIGEST_LIMIT = 128;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : null;
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, limit) ?? undefined;
}

function readApproval(value: unknown): PendingApproval | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const approvalId = text(record.approvalId, FIELD_LIMIT);
  const threadId = text(record.threadId, FIELD_LIMIT);
  const itemId = text(record.itemId, FIELD_LIMIT);
  const toolName = text(record.toolName, FIELD_LIMIT);
  const deadline = record.deadline;
  // 缺 id / 线程 / 工具名或到期时间不可读的条目无法定位与提示，直接丢弃。
  if (!approvalId || !threadId || !itemId || !toolName) return null;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
  const summary = optionalText(record.summary, SUMMARY_LIMIT);
  const turnId = optionalText(record.turnId, FIELD_LIMIT);
  const paramsDigest = optionalText(record.paramsDigest, DIGEST_LIMIT);
  return {
    approvalId, threadId, itemId, toolName, deadline,
    summary: summary ?? "",
    paramsDigest: paramsDigest ?? "",
    ...(turnId ? { turnId } : {}),
  };
}

/** 校验 approval/list 的返回：外层不可读时抛错（不能伪装成「没有通知」），单条非法只丢弃该条。 */
export function mapPendingApprovals(value: unknown, limit = 100): PendingApproval[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).approvals)) {
    throw new Error("内核审批列表无法识别");
  }
  const seen = new Set<string>();
  const approvals: PendingApproval[] = [];
  for (const entry of (value as { approvals: unknown[] }).approvals) {
    const approval = readApproval(entry);
    if (!approval || seen.has(approval.approvalId)) continue;
    seen.add(approval.approvalId);
    approvals.push(approval);
    if (approvals.length >= limit) break;
  }
  return approvals;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 把审批到期时间转成面板文案；非法时间与已过期要和「还有多久」区分开。 */
export function approvalRemainingText(deadline: number, now = Date.now()): string {
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return "到期时间未知";
  const remaining = deadline - now;
  if (!Number.isFinite(remaining)) return "到期时间未知";
  if (remaining <= 0) return "已过期";
  if (remaining < MINUTE) return "即将过期";
  if (remaining < HOUR) return `${Math.ceil(remaining / MINUTE)} 分钟后过期`;
  return `${Math.ceil(remaining / HOUR)} 小时后过期`;
}

/** 铃铛徽标文案：没有待审批（或计数不可读）时不显示，超过 9 条显示 9+。 */
export function approvalBadgeText(count: number): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}
