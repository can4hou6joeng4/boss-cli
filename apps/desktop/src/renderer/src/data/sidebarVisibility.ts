import type { SessionItem } from "./mockData";

/**
 * 侧栏会话可见性：关闭「显示已隐藏的聊天」时过滤隐藏会话；开启时原样保留，
 * 由行内的「已隐藏」标记说明它们为什么仍然出现。
 */
export function visibleSessions(sessions: SessionItem[], hidden: ReadonlySet<string>, showHidden: boolean): SessionItem[] {
  return showHidden ? sessions : sessions.filter(session => !hidden.has(session.id));
}

/** 隐藏中的会话在右键菜单里改为「取消隐藏」，不再提供重复的隐藏操作。 */
export function hideActionLabel(hidden: boolean): string {
  return hidden ? "取消隐藏" : "在侧栏隐藏";
}

/** 常规侧栏只列未归档会话；已归档会话由「已归档」分组单独呈现，避免混进项目列表。 */
export function nonArchivedSessions(sessions: SessionItem[], hidden: ReadonlySet<string>, showHidden: boolean): SessionItem[] {
  return visibleSessions(sessions.filter(session => session.archived !== true), hidden, showHidden);
}

/** 「已归档」分组；同样遵守本地隐藏开关。 */
export function archivedSessions(sessions: SessionItem[], hidden: ReadonlySet<string>, showHidden: boolean): SessionItem[] {
  return visibleSessions(sessions.filter(session => session.archived === true), hidden, showHidden);
}
