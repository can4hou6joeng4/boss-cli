/** 审批回答被内核明确拒绝后的界面文案与收敛动作。 */

/**
 * 明确拒绝后的提示：区分「回合仍在运行」「回合已结束或已归档」「已按相反决策处理」等状态，
 * 不再把所有拒绝都说成「可能已过期」。
 */
export function approvalRejectionNotice(code: string | undefined, reason: string): string {
  const detail = reason ? `：${reason}` : "";
  switch (code) {
    case "APPROVAL_BUSY":
      return `审批仍由活动回合持有${detail}；请先停止回合或等待它结束后再处理，不要反复提交。`;
    case "APPROVAL_CLOSED":
      return `审批所属回合已结束或会话已归档，不再接受新的裁决${detail}；正在刷新会话状态。`;
    case "APPROVAL_CONFLICT":
      return `该审批已按相反决策处理${detail}；正在刷新会话状态。`;
    case "APPROVAL_NOT_FOUND":
      return `审批不存在或所属会话已删除${detail}；正在刷新会话状态。`;
    case "APPROVAL_INVALID":
      return `审批记录无效${detail}；正在刷新会话状态。`;
    case "APPROVAL_AMBIGUOUS":
      return `审批记录重复，内核拒绝裁决${detail}；正在刷新会话状态。`;
    default:
      return `审批未被受理${detail || "（可能已过期或状态已刷新）"}；请刷新会话后再试。`;
  }
}

/**
 * 只有回合已经结束或审批记录已变更时才重读会话。
 * APPROVAL_BUSY 表示回合仍在运行，全量快照会覆盖正在流式输出的增量。
 */
export function approvalRejectionRefreshes(code: string | undefined): boolean {
  return code === "APPROVAL_CLOSED" || code === "APPROVAL_CONFLICT"
    || code === "APPROVAL_NOT_FOUND" || code === "APPROVAL_INVALID" || code === "APPROVAL_AMBIGUOUS";
}
