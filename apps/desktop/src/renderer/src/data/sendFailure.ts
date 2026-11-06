import { unconfirmedFailure } from "./confirmationFailure";
import { harnessErrorText, isHarnessRpcRejection } from "./harnessBridge";

/**
 * 发送失败的主提示。
 * 内核明确拒绝说明请求没有进入会话，不能再写成「结果尚未确认」；
 * 断连、IPC 失败或回执不可读仍按不确定处理。
 */
export function sendFailureNotice(error: unknown): string {
  return isHarnessRpcRejection(error)
    ? `发送失败：${harnessErrorText(error)}。正在读取会话状态，请核对后重试。`
    : `提交结果尚未确认：${harnessErrorText(error)}。正在读取会话状态，请核对记录后再决定下一步。`;
}

/** 发送失败后重新读取会话也失败时的提示：主因与核对原因都要保留。 */
export function sendFailureRecheckNotice(error: unknown, verification: unknown): string {
  return isHarnessRpcRejection(error)
    ? `发送失败：${harnessErrorText(error)}；重新读取会话状态也失败（${harnessErrorText(verification)}）。请稍后手动刷新核对。`
    : unconfirmedFailure("提交结果", error, verification, "请稍后手动刷新核对。");
}
