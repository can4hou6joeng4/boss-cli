/** 通知面板快捷键：⌘⇧A（Windows / Linux 为 Ctrl+Shift+A）；带 Alt 或缺少 Shift 时不匹配。 */
export function isNotificationsShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.key.toLowerCase() === "a"
    && (event.metaKey || event.ctrlKey)
    && event.shiftKey
    && !event.altKey;
}
