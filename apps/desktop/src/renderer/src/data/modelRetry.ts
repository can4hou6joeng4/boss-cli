import type { ModelRetryEndedNotification, ModelRetryStartedNotification } from "@boss-cli/protocol";

/**
 * 模型自动重试的会话区观测状态（仅展示；不参与重试判定、不触发任何请求）。
 * 内核未发送 model/retryStarted / retryEnded 时没有状态，界面保持原样。
 */
export type ModelRetryPhase = "waiting" | "recovered" | "failed" | "aborted";

export interface ModelRetryStatus {
  threadId: string;
  turnId?: string;
  phase: ModelRetryPhase;
  /** waiting：即将发起的尝试序号；其他阶段：最后一次发起的尝试序号。 */
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  /** 收到 retryStarted 的本地时刻，用于倒计时。 */
  receivedAt: number;
  errorMessage?: string;
  finalError?: string;
  /** 兜底：回合已结束却没收到 retryEnded（旧内核），按回合中断推断；attempt 为未发起的那次。 */
  endedBeforeAttempt?: boolean;
}

const MAX_ATTEMPT = 100;
const MAX_DELAY_MS = 3_600_000;
const MAX_MESSAGE = 300;

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > MAX_MESSAGE ? chars.slice(0, MAX_MESSAGE).join("") + "…" : text;
}

function turnOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

/** 校验并合并一条重试通知；字段无效时返回 previous（不臆造状态）。 */
export function reduceModelRetry(previous: ModelRetryStatus | undefined, method: string, raw: unknown, now: number): ModelRetryStatus | undefined {
  if (!raw || typeof raw !== "object") return previous;
  if (method === "model/retryStarted") {
    const params = raw as Partial<ModelRetryStartedNotification>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const attempt = boundedInteger(params.attempt, 2, MAX_ATTEMPT);
    const maxAttempts = boundedInteger(params.maxAttempts, 2, MAX_ATTEMPT);
    const delayMs = boundedInteger(params.delayMs, 0, MAX_DELAY_MS);
    if (!threadId || attempt === undefined || maxAttempts === undefined || delayMs === undefined || attempt > maxAttempts) return previous;
    return { threadId, turnId: turnOf(params.turnId), phase: "waiting", attempt, maxAttempts, delayMs, receivedAt: now,
      errorMessage: boundedText(params.errorMessage) };
  }
  if (method === "model/retryEnded") {
    const params = raw as Partial<ModelRetryEndedNotification>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const attempt = boundedInteger(params.attempt, 1, MAX_ATTEMPT);
    if (!threadId || attempt === undefined || typeof params.success !== "boolean") return previous;
    const phase: ModelRetryPhase = params.success ? "recovered" : params.reason === "aborted" ? "aborted" : "failed";
    return { threadId, turnId: turnOf(params.turnId) ?? previous?.turnId, phase, attempt,
      maxAttempts: previous?.maxAttempts, receivedAt: now, errorMessage: previous?.errorMessage,
      finalError: params.success ? undefined : boundedText(params.finalError) };
  }
  return previous;
}

/**
 * 回合收尾时收敛仍在等待的重试。内核会在回合终态前补发 retryEnded（含停止时的 aborted），
 * 已有终态（恢复 / 失败 / 已停止）以通知为准保持不变；仅当仍处于等待（旧内核未补发）时兜底：
 * 中断回合转为“已停止”，其他终态直接移除。
 */
export function settleModelRetryOnTurnEnd(previous: ModelRetryStatus | undefined, turnStatus: string | undefined, now: number): ModelRetryStatus | undefined {
  if (previous?.phase !== "waiting") return previous;
  if (turnStatus !== "interrupted") return undefined;
  return { ...previous, phase: "aborted", receivedAt: now, endedBeforeAttempt: true };
}

/** 距离下一次尝试的剩余整秒；已到点返回 0。 */
export function retryRemainingSeconds(status: ModelRetryStatus, now: number): number {
  if (status.phase !== "waiting" || status.delayMs === undefined) return 0;
  return Math.max(0, Math.ceil((status.receivedAt + status.delayMs - now) / 1000));
}
