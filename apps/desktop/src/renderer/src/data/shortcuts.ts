export interface CommandChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 全局快捷键的精确匹配：必须按住 Command 或 Control，且 Shift / Alt 状态与声明一致。
 * 未声明的组合（如 ⌘⇧N、⌘⌥K）不触发，避免与系统或其他应用的快捷键冲突。
 */
export function isCommandChord(
  event: CommandChordEvent,
  key: string,
  modifiers: { shift?: boolean; alt?: boolean } = {},
): boolean {
  return event.key.toLowerCase() === key
    && (event.metaKey || event.ctrlKey)
    && event.shiftKey === (modifiers.shift === true)
    && event.altKey === (modifiers.alt === true);
}

/** 通知面板快捷键：⌘⇧A（Windows / Linux 为 Ctrl+Shift+A）；带 Alt 或缺少 Shift 时不匹配。 */
export function isNotificationsShortcut(event: CommandChordEvent): boolean {
  return isCommandChord(event, "a", { shift: true });
}
