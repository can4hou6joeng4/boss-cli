import { harnessErrorText } from "./harnessBridge";

/**
 * 删除会话失败的展示结果。
 *
 * `incomplete` 表示会话已从列表消失（内核已隐藏、稍后继续清理），调用方仍需移除本地状态；
 * `failed` 表示内核明确拒绝删除，会话原样保留；
 * `unknown` 表示结果未确认（传输错误、未知原因码或响应形状不符），调用方保留列表并提示核对。
 */
export type DeleteThreadFailure = { status: "incomplete" | "failed" | "unknown"; message: string };

/** 按内核原因码给出可操作的中文提示；未知错误不臆断删除结果，避免把未确认说成未删除。 */
export function deleteThreadFailure(error: unknown): DeleteThreadFailure {
  const value = error && typeof error === "object"
    ? error as { rpcError?: unknown; data?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : null;
  const code = value?.rpcError === true && typeof data?.code === "string" ? data.code : "";
  switch (code) {
    case "THREAD_BUSY":
      return { status: "failed", message: "该聊天仍有运行中的回合或排队消息，无法删除。请先停止当前回合并清空队列，再重试。" };
    case "THREAD_DELETE_INCOMPLETE":
      return { status: "incomplete", message: "聊天已从列表移除，但本机数据尚未清理完；内核重启后会继续清理。" };
    case "THREAD_NOT_FOUND":
      return { status: "incomplete", message: "该聊天已不存在，已从列表移除。" };
    default:
      return { status: "unknown", message: `删除结果尚未确认：${harnessErrorText(error)}。请刷新会话列表核对；若该聊天已消失，无需重试。` };
  }
}
