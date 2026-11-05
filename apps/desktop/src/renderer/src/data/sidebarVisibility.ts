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

/**
 * 「显示已隐藏的聊天」的计数：只统计当前列表中真实存在的隐藏会话。
 * 持久化 id 可能指向已删除或尚未加载的会话，直接按集合大小计数会虚高。
 */
export function hiddenSessionCount(sessions: SessionItem[], hidden: ReadonlySet<string>): number {
  return new Set(sessions.filter(session => hidden.has(session.id)).map(session => session.id)).size;
}

/** 上一回合以 error / blocked 结束；运行中或等待预检的会话不计入，避免重复提示。 */
export function sessionFailed(session: SessionItem): boolean {
  return session.status !== "running" && session.status !== "interrupted"
    && (session.lastTurnStatus === "error" || session.lastTurnStatus === "blocked");
}

/** 需要用户处理的会话：上一回合异常、等待预检，或有已暂停的队列项。 */
export function sessionNeedsAttention(session: SessionItem): boolean {
  return session.archived !== true
    && (sessionFailed(session) || session.status === "interrupted" || (session.queueCounts?.paused ?? 0) > 0);
}

/** 「待你处理」分组的候选会话，遵守归档与本地隐藏规则。 */
export function attentionSessions(sessions: SessionItem[], hidden: ReadonlySet<string>, showHidden: boolean): SessionItem[] {
  return nonArchivedSessions(sessions, hidden, showHidden).filter(sessionNeedsAttention);
}
