/**
 * 平台登录流程失败时的诊断信息。
 *
 * 主进程此前把打开、保存失败都写成同一条固定摘要；保留内核原因码与可读消息，
 * 才能区分「内核拒绝/忙」与「本机断连」。消息去掉 Electron 的 IPC 包装前缀并限制长度。
 */
export function loginFailureDetail(error: unknown): { code?: string; message?: string } {
  const value = error && typeof error === "object"
    ? error as { data?: unknown; message?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as { code?: unknown } : null;
  const code = typeof data?.code === "string" && data.code ? data.code : undefined;
  const raw = typeof value?.message === "string" ? value.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").trim() : "";
  return { ...(code ? { code } : {}), ...(raw ? { message: raw.slice(0, 200) } : {}) };
}
