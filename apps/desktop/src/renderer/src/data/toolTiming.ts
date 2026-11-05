import type { ThreadItem } from "@boss-harness/protocol";
import { formatDuration } from "./turnTiming";

/**
 * 工具耗时展示：完成值优先使用内核测量的 `durationMs`（持久化、刷新后仍在），
 * 运行中才用本机时钟显示已运行 / 已等待；没有开始时间时不虚构耗时。
 */
export interface ToolTimingInput {
  executionState?: ThreadItem["executionState"];
  durationMs?: number;
  /** 渲染层收到实际开始执行事件的本机时钟；仅本次运行有效。 */
  startedAt?: number;
  /** 等待审批或排队开始的本机时钟；与执行计时分开。 */
  waitingSince?: number;
  /** 渲染层收到完成事件的本机时钟；内核耗时缺失时作为回退。 */
  endedAt?: number;
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 内核耗时只接受非负有限数；其它值按未提供处理，避免把坏字段显示成「不足 1 秒」。 */
export function toolDurationMs(value: unknown): number | undefined {
  return validTime(value) ? value : undefined;
}

/** 工具耗时文案：完成显示「耗时」，运行中显示「已运行」，等待审批 / 排队不混入执行耗时。 */
export function toolTimingLabel(toolUse: ToolTimingInput, now = Date.now()): string | null {
  // 未获批准或未执行的调用没有执行耗时；即使条目误带内核耗时也不显示成一次执行。
  if (toolUse.executionState === "not_approved" || toolUse.executionState === "not_executed") return null;
  const duration = toolDurationMs(toolUse.durationMs);
  if (duration !== undefined) return `耗时 ${formatDuration(duration)}`;
  if (toolUse.endedAt !== undefined) {
    if (!validTime(toolUse.startedAt) || !validTime(toolUse.endedAt) || toolUse.endedAt < toolUse.startedAt) return null;
    return `耗时 ${formatDuration(toolUse.endedAt - toolUse.startedAt)}`;
  }
  if (!validTime(now)) return null;
  if (validTime(toolUse.startedAt)) return `已运行 ${formatDuration(Math.max(0, now - toolUse.startedAt))}`;
  if (validTime(toolUse.waitingSince)) {
    if (toolUse.executionState === "pending_approval") return `已等待 ${formatDuration(Math.max(0, now - toolUse.waitingSince))}`;
    if (toolUse.executionState === "queued") return `排队 ${formatDuration(Math.max(0, now - toolUse.waitingSince))}`;
  }
  return null;
}
