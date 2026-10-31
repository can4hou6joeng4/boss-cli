import { IconCheck, IconClock, IconClose } from "./Icons";
import type { ContextBranchSummary, ContextCompactJob } from "@boss-cli/protocol";

/** 当前分支上的被放弃分支摘要条目：正文只进入模型上下文，界面显示来源与规模。 */
export function BranchSummaryMarker({ summary }: { summary: ContextBranchSummary }) {
  return <div className="branch-summary-marker" data-branch-summary={summary.entryId} role="note">
    <span className="branch-summary-icon" aria-hidden="true"><IconCheck size={12} /></span>
    <div>
      <p className="branch-summary-title">被放弃分支摘要</p>
      <p className="branch-summary-detail">已写入此分支的后续模型上下文 · 概括 {summary.abandonedTurnIds.length} 个被放弃回合 · {summary.characters} 字。摘要属于模型判断，平台事实以原始工具结果为准，不扩大操作授权。</p>
    </div>
  </div>;
}

const FAILURES: Record<string, string> = {
  COMPACTION_CANCELLED: "摘要已取消",
  BRANCH_SUMMARY_LEAF_CHANGED: "分支在摘要完成前再次切换，摘要未写入",
  COMPACTION_INPUT_TOO_LARGE: "被放弃分支内容超过摘要输入上限",
};

/** 被放弃分支摘要的后台任务进度 / 失败；切换不随任务失败回滚。 */
export function BranchSummaryJobNotice({ job, cancelInFlight, onCancel, onDismiss }: {
  job: ContextCompactJob; cancelInFlight: boolean; onCancel: () => void; onDismiss: () => void;
}) {
  const running = job.status === "running";
  const failed = job.status === "failed" || job.status === "cancelled";
  const progress = job.totalCharacters ? `已处理 ${job.processedCharacters ?? 0}/${job.totalCharacters} 字` : "";
  const requests = job.modelRequestCount ? `模型请求 ${job.modelRequestCount} 次` : "";
  const title = running ? "正在为被放弃分支生成摘要…" : job.status === "completed" ? "被放弃分支摘要已生成"
    : job.status === "cancelled" ? "被放弃分支摘要已取消" : "被放弃分支摘要生成失败";
  const detail = failed ? `${(job.code && FAILURES[job.code]) || job.message || "摘要未写入"}${job.code ? `（${job.code}）` : ""}。分支已切换，不会回滚。` : "";
  return <div className={`model-retry-notice branch-summary-job ${running ? "" : failed ? "failed" : "recovered"}`} data-branch-summary-job={job.status}>
    <span className="model-retry-icon" aria-hidden="true">{running ? <IconClock size={13} /> : failed ? <IconClose size={13} /> : <IconCheck size={13} />}</span>
    <div className="model-retry-body">
      <p className="model-retry-title" role="status" aria-live="polite">{title}</p>
      {(progress || requests) && <p className="model-retry-detail">{[progress, requests].filter(Boolean).join(" · ")}</p>}
      {detail && <p className="model-retry-detail" role="alert">{detail}</p>}
      {running && <p className="model-retry-hint">摘要期间不能发送新消息或再次切换；可取消，取消不撤销切换。</p>}
    </div>
    {running ? <button type="button" className="secondary-button" disabled={cancelInFlight} onClick={onCancel}>{cancelInFlight ? "正在取消…" : "取消摘要"}</button>
      : <button type="button" className="model-retry-dismiss" aria-label="关闭摘要提示" onClick={onDismiss}><IconClose size={12} /></button>}
  </div>;
}
