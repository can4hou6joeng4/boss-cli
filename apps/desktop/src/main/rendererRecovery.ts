/**
 * 主窗口渲染进程意外退出后的恢复决策。
 *
 * 崩溃、内存不足或被系统终止时 `webContents` 仍然可用；在滚动窗口内有限次重载可以救回瞬时故障。
 * 预算耗尽后不再重载，改为展示静态诊断页，避免崩溃循环。这里只做纯决策，便于离线验证。
 */

/** `render-process-gone` 事件中本项目会用到的字段。 */
export interface RendererGoneDetails {
  reason?: unknown;
  exitCode?: unknown;
}

export interface RendererRecoveryOptions {
  /** 滚动窗口内允许的自动重载次数。 */
  maxReloads?: number;
  /** 重载预算的滚动窗口（毫秒）。 */
  windowMs?: number;
}

export type RendererRecoveryAction = "ignore" | "reload" | "report";

export interface RendererRecoveryDecision {
  action: RendererRecoveryAction;
  /** 仍在预算窗口内的重载时间戳；调用方保存并传给下一次决策。 */
  reloads: number[];
  /** 仅 `report` 时给出可展示的原因。 */
  message?: string;
}

export const RENDERER_CRASH_RELOAD_LIMIT = 2;
export const RENDERER_CRASH_WINDOW_MS = 120_000;

const REASON_LABELS: Record<string, string> = {
  "abnormal-exit": "异常退出",
  killed: "被终止",
  crashed: "崩溃",
  oom: "内存不足",
  "launch-failed": "启动失败",
  "integrity-failure": "完整性校验失败",
};

/** 把 Electron 的退出原因翻成可读标签；未知原因保留原始值，便于反馈时核对。 */
export function rendererGoneReasonLabel(reason: unknown): string {
  if (typeof reason !== "string" || !reason.trim()) return "未知原因";
  return REASON_LABELS[reason] ?? reason;
}

/** 崩溃摘要：用户能看懂的标签 + 原始原因与合法退出码。 */
export function rendererGoneSummary(details: RendererGoneDetails | null | undefined): string {
  const rawReason = typeof details?.reason === "string" ? details.reason.trim() : "";
  const reason = rawReason || "unknown";
  const label = rawReason ? rendererGoneReasonLabel(rawReason) : "未知原因";
  const code = typeof details?.exitCode === "number" && Number.isSafeInteger(details.exitCode)
    ? `，退出码 ${details.exitCode}` : "";
  return `${label}（${reason}${code}）`;
}

/**
 * 决定崩溃后的动作：
 * - `clean-exit` 视为正常结束，不重载；
 * - 窗口内的历史重载未达上限时重载，并记录本次时间戳；
 * - 达到上限时返回 `report`，由调用方展示静态诊断页。
 */
export function decideRendererRecovery(
  details: RendererGoneDetails | null | undefined,
  previousReloads: readonly number[],
  now: number,
  options: RendererRecoveryOptions = {},
): RendererRecoveryDecision {
  const maxReloads = typeof options.maxReloads === "number" && Number.isSafeInteger(options.maxReloads) && options.maxReloads >= 0
    ? options.maxReloads : RENDERER_CRASH_RELOAD_LIMIT;
  const windowMs = typeof options.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs : RENDERER_CRASH_WINDOW_MS;
  const clock = typeof now === "number" && Number.isFinite(now) ? now : 0;
  const reloads = Array.isArray(previousReloads)
    ? previousReloads.filter(item => typeof item === "number" && Number.isFinite(item)
      && item <= clock && item > clock - windowMs)
    : [];
  if (!details || details.reason === "clean-exit") return { action: "ignore", reloads };
  if (reloads.length < maxReloads) return { action: "reload", reloads: [...reloads, clock] };
  return {
    action: "report",
    reloads,
    message: `界面进程连续异常退出：${rendererGoneSummary(details)}；已自动重载 ${maxReloads} 次仍未恢复。`,
  };
}
