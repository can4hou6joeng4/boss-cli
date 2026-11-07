import { formatLocalDateTime } from "./timeFormat";

/**
 * 工具来源的查询时间。
 *
 * 内核 `source.queriedAt` 是查询开始的 UTC ISO 时间，但历史记录、迁移数据或旧内核
 * 可能缺失、空白或给出无法解析的字符串。这里只接受带秒与时区的完整 ISO 日期时间，
 * 避免 `new Date` 把 `"1"`、只有日期的字符串或本地时间误当成有效时刻；解析失败返回
 * null，调用方既不渲染时间，也不复制到文本里。
 */

// 内核输出形如 `2026-11-05T08:00:00.123456+00:00`；演示与导出数据也用 `Z`。
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 来源查询时间；缺失、空白或不可解析时返回 null。 */
export function toolQueriedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_DATE_TIME.test(trimmed)) return null;
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 复制与轻量导出使用的查询时间：UTC ISO，整秒省略 `.000`。 */
export function toolQueriedAtText(value: unknown): string | null {
  const at = toolQueriedAt(value);
  if (!at) return null;
  const iso = at.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

/**
 * 工具卡展示用的本机时区时间；缺失或不可解析时返回 null。
 * 与资料库共用 `YYYY-MM-DD HH:mm`，同一来源时间在两处显示一致；
 * 会话内查找复用同一入口，保证匹配文本与卡片渲染完全一致。
 */
export function toolQueriedAtLabel(value: unknown): string | null {
  const at = toolQueriedAt(value);
  return at ? formatLocalDateTime(at) : null;
}
