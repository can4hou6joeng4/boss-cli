import { useEffect, useState } from "react";
import { IconClock } from "./Icons";
import { approvalRemainingText, approvalUrgency } from "../data/pendingApprovals";

/** 审批卡到期倒计时：每 15 秒刷新一次，与通知面板的读取节拍一致。 */
export function ApprovalDeadline({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  const urgency = approvalUrgency(deadline, now);
  // 到期时间不可读时不显示倒计时，避免把未知显示成正常。
  if (urgency === "unknown") return null;
  return <span className={`approval-deadline is-${urgency}`} title="审批等待时间有限；到期后按未批准处理。"><IconClock size={12} />{approvalRemainingText(deadline, now)}</span>;
}
