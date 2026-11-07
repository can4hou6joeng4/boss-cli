/**
 * 队列操作（撤回、重新排队）的结果。
 *
 * 只返回 boolean 无法区分「请求根本没有发出」与「请求可能生效但回执不可读」：
 * 前者要提示用户先处理原因（断连、状态已变化），后者必须让用户核对队列，
 * 不能当成失败直接重试。
 */
export type QueueActionOutcome =
  | { status: "done" }
  | { status: "skipped"; reason: string }
  | { status: "uncertain" };

/** 面板内提示；`done` 不需要提示，`uncertain` 的核对说明由调用方给出。 */
export function queueActionNotice(action: "撤回" | "重新排队", outcome: QueueActionOutcome): string | null {
  if (outcome.status === "skipped") return `${action}没有发出：${outcome.reason}。`;
  if (outcome.status === "uncertain") return `${action}结果尚未确认；请先核对队列状态，再决定是否重试。`;
  return null;
}
