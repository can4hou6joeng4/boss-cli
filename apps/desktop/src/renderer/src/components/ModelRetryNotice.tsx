import React, { useEffect, useState } from "react";
import { IconClock, IconCheck, IconClose } from "./Icons";
import { retryRemainingSeconds, type ModelRetryStatus } from "../data/modelRetry";

/** 会话区的模型自动重试状态条；只读观测，不提供重发入口。 */
export const ModelRetryNotice: React.FC<{ status: ModelRetryStatus; onDismiss?: () => void }> = ({ status, onDismiss }) => {
  const [now, setNow] = useState(() => Date.now());
  const remaining = retryRemainingSeconds(status, now);
  useEffect(() => {
    setNow(Date.now());
    if (status.phase !== "waiting") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [status]);
  const total = status.maxAttempts ? `${status.attempt}/${status.maxAttempts}` : `${status.attempt}`;
  let title: string;
  let detail: string | undefined;
  if (status.phase === "waiting") {
    title = `模型请求暂时失败，正在自动重试（第 ${total} 次）`;
    detail = status.errorMessage ? `上次失败：${status.errorMessage}` : undefined;
  } else if (status.phase === "recovered") {
    title = `模型请求已恢复（第 ${total} 次尝试成功）`;
  } else if (status.phase === "aborted") {
    title = "自动重试已停止";
    detail = status.endedBeforeAttempt ? `回合已中断，第 ${total} 次尝试未发起。` : status.finalError;
  } else {
    title = `自动重试未能恢复（已尝试 ${status.attempt} 次）`;
    detail = status.finalError ?? status.errorMessage;
  }
  return <div className={`model-retry-notice ${status.phase}`} data-retry-phase={status.phase}>
    <span className="model-retry-icon" aria-hidden="true">
      {status.phase === "recovered" ? <IconCheck size={13} /> : status.phase === "waiting" ? <IconClock size={13} /> : <IconClose size={13} />}
    </span>
    <div className="model-retry-body">
      <p className="model-retry-title" role="status" aria-live="polite">{title}</p>
      {status.phase === "waiting" && <p className="model-retry-countdown" aria-hidden="true">
        {remaining > 0 ? `${remaining} 秒后发起下一次尝试` : "正在发起下一次尝试…"}
      </p>}
      {detail && <p className="model-retry-detail">{detail}</p>}
      {status.phase === "waiting" && <p className="model-retry-hint">仅重发本次模型请求，不会重放已执行的工具；可随时停止。</p>}
    </div>
    {onDismiss && status.phase !== "waiting" && <button type="button" className="model-retry-dismiss" aria-label="关闭重试提示" onClick={onDismiss}><IconClose size={12} /></button>}
  </div>;
};
