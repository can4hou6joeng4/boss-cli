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
  const deadline = approvalDeadlineMs(record.deadline);
  // 缺 id / 线程 / 工具名或到期时间不可读的条目无法定位与提示，直接丢弃。
  if (!approvalId || !threadId || !itemId || !toolName) return null;
  if (deadline === undefined) return null;
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

export interface PendingApprovalList {
  approvals: PendingApproval[];
  /** 内核还有更早的待审批未返回；旧内核缺省视为没有截断。 */
  truncated: boolean;
}

/** 校验 approval/list 的返回：外层不可读时抛错（不能伪装成「没有通知」），单条非法只丢弃该条。 */
export function mapPendingApprovals(value: unknown, limit = 100): PendingApprovalList {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).approvals)) {
    throw new Error("内核审批列表无法识别");
  }
  const truncated = (value as Record<string, unknown>).truncated;
  // 截断标记决定「是否还有更早的待审批」能否如实展示；存在但类型不对时整体拒绝，不猜。
  if (truncated !== undefined && typeof truncated !== "boolean") {
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
  return { approvals, truncated: truncated === true };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 5 分钟内到期的审批在卡片上标警示色。 */
export const APPROVAL_SOON_MS = 5 * MINUTE;

const MILLISECONDS_PER_SECOND = 1_000;
/** 低于该值的到期时间按 Unix 秒解释；真实毫秒时间戳远大于它。 */
const APPROVAL_DEADLINE_MS_THRESHOLD = 1e12;

/**
 * 内核用 Unix 秒（`time.time()`）写入审批到期时间，界面统一换算为毫秒，
 * 再与 `Date.now()` 比较。已经是毫秒的值原样保留；非有限数视为未知。
 */
export function approvalDeadlineMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 0 && value < APPROVAL_DEADLINE_MS_THRESHOLD ? value * MILLISECONDS_PER_SECOND : value;
}

/** 审批卡倒计时的紧急度；时间不可读时不显示倒计时，而不是显示成正常。 */
export function approvalUrgency(deadline: number, now = Date.now()): "expired" | "soon" | "normal" | "unknown" {
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || !Number.isFinite(now)) return "unknown";
  const remaining = deadline - now;
  if (!Number.isFinite(remaining)) return "unknown";
  if (remaining <= 0) return "expired";
  return remaining < APPROVAL_SOON_MS ? "soon" : "normal";
}

/** 把审批到期时间（毫秒）转成面板文案；非法时间与已过期要和「还有多久」区分开。 */
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

/** 铃铛的无障碍 / 悬停文案；截断时数量只是已返回条数，必须标成「至少」，不能断言总数。 */
export function approvalBadgeLabel(count: number, truncated = false): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  const visible = Math.floor(count);
  return truncated ? `至少 ${visible} 项待审批` : `${visible} 项待审批`;
}

/** 只有审批请求与裁决会改变待审批数量；其它通知不触发重新读取。 */
export function isApprovalCountEvent(method: unknown): boolean {
  return method === "approval/requested" || method === "approval/decided";
}

/** 在可点击条目之间循环移动；current 为 -1（焦点不在列表内）时按方向从首/尾进入。 */
export function nextApprovalIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** 校验主进程转来的通知点击目标；字段缺失、类型不对或超长时返回 null，调用方不得跳转。 */
export function readApprovalFocus(value: unknown): { threadId: string; itemId: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const threadId = text(record.threadId, FIELD_LIMIT);
  const itemId = text(record.itemId, FIELD_LIMIT);
  return threadId && itemId ? { threadId, itemId } : null;
}

/** 按会话汇总待审批数量，供侧栏会话行展示；解析阶段已按 approvalId 去重。 */
export function countPendingApprovalsByThread(approvals: readonly PendingApproval[]): Record<string, number> {
  // 用无原型对象承接内核返回的 threadId，避免特殊键名污染原型链。
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const approval of approvals) {
    counts[approval.threadId] = (counts[approval.threadId] ?? 0) + 1;
  }
  return counts;
}

export interface PendingApprovalGroup { threadId: string; approvals: PendingApproval[] }

/** 按线程分组并保留首次出现顺序；内核已按线程排序，这里只做稳定聚合。 */
export function groupPendingApprovals(approvals: PendingApproval[]): PendingApprovalGroup[] {
  const groups = new Map<string, PendingApprovalGroup>();
  const ordered: PendingApprovalGroup[] = [];
  for (const approval of approvals) {
    let group = groups.get(approval.threadId);
    if (!group) {
      group = { threadId: approval.threadId, approvals: [] };
      groups.set(approval.threadId, group);
      ordered.push(group);
    }
    group.approvals.push(approval);
  }
  return ordered;
}
