/**
 * 界面统一的时间格式。
 *
 * 桌面界面的文案固定为简体中文，时间不能跟随系统区域：在英文或其他区域的机器上，
 * `Date#toLocaleString()` 会给出 `11/5/2026, 4:00:00 PM` 这类格式，与界面其余文案
 * 不一致，也让同一个来源时间在资料库与工具卡里显示成两种样子。这里统一按本机时区
 * 输出补零的 `YYYY-MM-DD HH:mm` 与 `HH:mm:ss`，不依赖 ICU 区域数据。
 */

const pad = (part: number) => String(part).padStart(2, "0");

/** 本机时区的完整日期时间：`YYYY-MM-DD HH:mm`。 */
export function formatLocalDateTime(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 本机时区的时刻：`HH:mm:ss`，用于同一次检查或最近一次刷新。 */
export function formatLocalClock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
