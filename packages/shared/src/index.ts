/**
 * 跨包共享的小工具。对应 Codex 的 shared-node。
 */

export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 去掉 Electron `ipcRenderer.invoke` 拼接的错误包装，只留下真实原因。
 *
 * 主进程抛出的错误跨 IPC 后只剩 `Error invoking remote method '<channel>': <String(error)>`；
 * `String(error)` 带错误名：普通错误为 `Error: `，本项目的内核 RPC 错误为 `HarnessRpcError: `。
 */
export function stripIpcErrorWrapper(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (?:Error|HarnessRpcError): /, "");
}
