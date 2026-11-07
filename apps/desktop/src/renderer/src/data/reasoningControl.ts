/** 推理设置操作的可用性：断连或没有会话时必须给出原因，不能静默丢弃点击。 */
export type ReasoningAction = "读取" | "保存";

export type ReasoningTarget =
  | { ok: true; threadId: string }
  | { ok: false; notice: string };

/**
 * 解析操作目标；不可执行时带回可见提示。
 *
 * `useSessionReasoning` 曾在断连时直接 return：既不设 pending 也不设 error，
 * Composer 的「重新加载推理设置」与档位按钮点了毫无反应，用户无法判断原因。
 */
export function reasoningTarget(action: ReasoningAction, threadId: string | null, connected: boolean): ReasoningTarget {
  if (!connected) return { ok: false, notice: `无法${action}会话推理设置：本地内核未连接。恢复连接后再试。` };
  if (!threadId) return { ok: false, notice: `无法${action}会话推理设置：当前没有可操作的会话。` };
  return { ok: true, threadId };
}
