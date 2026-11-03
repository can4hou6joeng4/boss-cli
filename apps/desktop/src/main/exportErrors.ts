/**
 * 会话导出写入失败的提示文案。
 *
 * 系统错误消息通常带完整路径，主进程不回显路径；只保留 errno（`ENOSPC`、`EACCES` 等），
 * 足以让用户区分空间不足、权限不足与目标不可写。
 */
export function sessionExportWriteError(error: unknown): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  if (typeof value?.code === "string" && value.code) return `无法写入所选文件（${value.code}），请换一个位置重试`;
  if (value?.message === "symlink") return "所选路径是符号链接，请换一个普通文件位置重试";
  return "无法写入所选文件，请换一个位置重试";
}
