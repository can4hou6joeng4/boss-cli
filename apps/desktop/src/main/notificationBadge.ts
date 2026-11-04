/** 应用图标徽标只接受 0–999 的整数；其它输入返回 null，调用方保持现有徽标不变。 */
export const BADGE_COUNT_LIMIT = 999;

export function normalizeBadgeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value <= BADGE_COUNT_LIMIT ? value : null;
}
