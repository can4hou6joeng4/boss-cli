/**
 * 渲染层可识别内核 RPC 错误码的方法。
 *
 * 主进程默认把内核错误当作普通 IPC 失败抛出，渲染层只看到拼接后的消息；这里列出的方法
 * 会以 `__harnessRpcError` 返回，且调用方都经 renderer 的 contextRequest 解析该形状。
 * 只加入确实按错误码分支或需要精确文案的方法，避免改变其他调用方的返回约定。
 */
const PRESERVED: ReadonlySet<string> = new Set([
  "context/compact/read",
  "context/compact/start",
  "thread/branchSummary/read",
  "thread/branches/list",
  "thread/leaf/read",
  "thread/leaf/set",
  "thread/list",
  "thread/model/set",
  "thread/usage/read",
  "turn/continuation/read",
  "turn/continue",
]);

export function preservesRpcError(method: string): boolean {
  return PRESERVED.has(method);
}
