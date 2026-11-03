import type { ThreadItem } from "@boss-harness/protocol";

export type ToolOutcomeTone = "uncertain" | "failed" | "notExecuted" | "pending";

export interface ToolOutcomeBadge {
  tone: ToolOutcomeTone;
  label: string;
}

/**
 * 工具卡的结果徽标。
 *
 * 只标注需要用户决策的状态：成功与未回报不打扰。尤其不能把「未执行」「结果未确认」
 * 显示成成功——写操作（如打招呼）若被当成已生效，用户可能重复触达。
 */
export function toolOutcomeBadge(
  executionState: ThreadItem["executionState"],
  status: ThreadItem["status"],
  errorCode?: string,
): ToolOutcomeBadge | null {
  switch (executionState) {
    case "outcome_unknown":
      return { tone: "uncertain", label: "结果未确认" };
    case "not_executed":
      return { tone: "notExecuted", label: "未执行" };
    case "not_approved":
      return { tone: "notExecuted", label: "未获批准" };
    case "failed":
      return { tone: "failed", label: "执行失败" };
    case "pending_approval":
      return { tone: "pending", label: "等待审批" };
    case "queued":
      return { tone: "pending", label: "排队中" };
    case "approved":
    case "executing":
      return { tone: "pending", label: "执行中" };
    case "completed":
      return null;
  }
  // 旧条目可能没有 executionState：只在错误码或状态明确时补标。
  if (errorCode === "SESSION_INTERRUPTED") return { tone: "uncertain", label: "结果未确认" };
  if (status === "failed") return { tone: "failed", label: "执行失败" };
  if (status === "running") return { tone: "pending", label: "执行中" };
  return null;
}
