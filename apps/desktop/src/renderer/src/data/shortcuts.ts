export interface CommandChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 主修饰键所属平台：macOS 使用 Command，其余平台使用 Control。 */
export type CommandPlatform = "mac" | "other";

/**
 * 把平台标识归一为快捷键族。preload 给出 `process.platform`（darwin / win32 / linux），
 * 浏览器预览给出 `navigator.platform`（MacIntel / Win32 / Linux x86_64）。
 */
export function resolveCommandPlatform(platform: string | undefined | null): CommandPlatform {
  const value = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  return value === "darwin" || value.startsWith("mac") ? "mac" : "other";
}

/** 当前运行平台：优先读 preload 暴露的 process.platform，浏览器预览退回 navigator.platform。 */
export function currentCommandPlatform(): CommandPlatform {
  try {
    const platform = typeof window === "undefined" ? undefined : window.boss?.versions?.platform;
    if (typeof platform === "string" && platform) return resolveCommandPlatform(platform);
  } catch { /* 桥接不可用时继续使用浏览器信息。 */ }
  try {
    return resolveCommandPlatform(typeof navigator === "undefined" ? undefined : navigator.platform);
  } catch { /* 平台信息不可读时按非 macOS 处理。 */ }
  return "other";
}

/**
 * 全局快捷键的精确匹配：只接受当前平台的主修饰键（macOS 为 Command，其余为 Control），
 * 且 Shift / Alt 状态与声明一致。另一平台的修饰键必须未按下：macOS 的 Ctrl 组合是系统文本
 * 编辑（⌃B / ⌃K / ⌃F / ⌃N / ⌃⇧A），Windows / Linux 的 Meta 组合归系统所有，应用不再抢占。
 * 未声明的组合（如 ⌘⇧N、⌘⌥K）同样不触发，避免与其他应用冲突。
 */
export function isCommandChord(
  event: CommandChordEvent,
  key: string,
  modifiers: { shift?: boolean; alt?: boolean } = {},
  platform: CommandPlatform = currentCommandPlatform(),
): boolean {
  const command = platform === "mac" ? event.metaKey : event.ctrlKey;
  const foreign = platform === "mac" ? event.ctrlKey : event.metaKey;
  return !foreign && command
    && event.key.toLowerCase() === key
    && event.shiftKey === (modifiers.shift === true)
    && event.altKey === (modifiers.alt === true);
}

/** 通知面板快捷键：⌘⇧A（Windows / Linux 为 Ctrl+Shift+A）；带 Alt、缺少 Shift 或按下另一平台修饰键时不匹配。 */
export function isNotificationsShortcut(event: CommandChordEvent, platform: CommandPlatform = currentCommandPlatform()): boolean {
  return isCommandChord(event, "a", { shift: true }, platform);
}
