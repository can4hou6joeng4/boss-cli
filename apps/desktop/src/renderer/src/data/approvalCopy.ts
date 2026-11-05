import type { MessageItem } from "./mockData";

type ApprovalCopyInput = Pick<NonNullable<MessageItem["approval"]>, "decision" | "deadline">;

const DECISION_TEXT: Record<string, string> = {
  approve: "已批准",
  deny: "已拒绝",
  expired: "等待超时，按未批准处理",
};

// Date 可表示的最大时刻；超出后 toISOString 会抛错。
const MAX_DATE_MS = 8.64e15;

/** 内核审批结论只认已知值；未知字符串按尚无结论处理，不把原始值抄进复制文本。 */
export function approvalDecisionText(value: unknown): string | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DECISION_TEXT, value)
    ? DECISION_TEXT[value] ?? null
    : null;
}

/** 待审批期限：合法 epoch 毫秒转 UTC ISO；整秒时省略毫秒，非法值不猜单位。 */
export function approvalDeadlineText(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_DATE_MS) return null;
  const iso = new Date(value).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

/** 复制与轻量导出使用的审批行：已决定显示结论，尚无结论才显示期限，两者不重复。 */
export function approvalCopyLine(approval: ApprovalCopyInput | undefined): string | null {
  if (!approval) return null;
  const decision = approvalDecisionText(approval.decision);
  if (decision) return `审批：${decision}`;
  const deadline = approvalDeadlineText(approval.deadline);
  return deadline ? `审批期限：${deadline}` : null;
}
