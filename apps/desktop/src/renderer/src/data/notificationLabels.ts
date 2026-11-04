import type { SessionItem } from "./mockData";

/** 组标题上限：项目名与会话标题相加后仍可读；截断时保留归档后缀。 */
export const NOTIFICATION_LABEL_LIMIT = 120;
const ARCHIVED_SUFFIX = " · 已归档";
const FALLBACK_ID_LIMIT = 8;

export interface NotificationGroupSource {
  threadId: string;
  /** 当前工作区能解析到的会话；缺失时用线程 id 前 8 位回退。 */
  session?: Pick<SessionItem, "title" | "archived"> | null;
  /** 会话所属项目名；空白或与会话标题相同时不重复展示。 */
  project?: unknown;
}

function compact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** 通知分组的展示标题：优先「项目 · 会话」，让不同项目下的同名会话可以区分。 */
export function notificationGroupLabel(source: NotificationGroupSource): string {
  const threadId = compact(source.threadId);
  const fallback = `会话 ${threadId.slice(0, FALLBACK_ID_LIMIT) || "未知"}`;
  const title = compact(source.session?.title) || fallback;
  const project = compact(source.project);
  const base = project && project !== title ? `${project} · ${title}` : title;
  const suffix = source.session?.archived === true ? ARCHIVED_SUFFIX : "";
  if (base.length + suffix.length <= NOTIFICATION_LABEL_LIMIT) return `${base}${suffix}`;
  const room = Math.max(1, NOTIFICATION_LABEL_LIMIT - suffix.length - 1);
  return `${base.slice(0, room)}…${suffix}`;
}
