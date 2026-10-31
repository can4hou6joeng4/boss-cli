import { useEffect, useRef, useState } from "react";
import { IconCheck, IconClock, IconClose } from "./Icons";
import type { ContextBranchSummary, ContextCompactJob } from "@boss-cli/protocol";
import { readBranchSummary } from "../data/harnessBridge";

function readError(error: unknown): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; data?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : null;
  const message = typeof value?.message === "string" ? value.message.slice(0, 300) : "无法读取本地内核响应";
  const code = typeof value?.code === "number" ? `内核 ${value.code}${typeof data?.code === "string" ? ` / ${data.code}` : ""}` : "";
  return code ? `${message}（${code}）` : message;
}

/**
 * 当前分支上的被放弃分支摘要条目：默认显示来源与规模；内核声明 sessionBranchSummaryRead 时可展开，
 * 经 thread/branchSummary/read 按需读取正文（纯文本显示，不渲染 Markdown）。
 */
export function BranchSummaryMarker({ summary, threadId, canRead = false }: { summary: ContextBranchSummary; threadId?: string; canRead?: boolean }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const readable = canRead && Boolean(threadId);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || !threadId || body.loading || body.text !== undefined) return;
    setBody({ loading: true });
    readBranchSummary(threadId, summary.entryId).then(response => {
      if (!alive.current) return;
      if (response.entryId !== summary.entryId || typeof response.summary !== "string") throw new Error("摘要响应与条目不符");
      setBody({ loading: false, text: response.summary });
    }).catch(error => { if (alive.current) setBody({ loading: false, error: readError(error) }); });
  };
  const bodyId = `branch-summary-body-${summary.entryId}`;
  return <div className="branch-summary-marker" data-branch-summary={summary.entryId} role="note">
    <span className="branch-summary-icon" aria-hidden="true"><IconCheck size={12} /></span>
    <div className="branch-summary-main">
      <p className="branch-summary-title">被放弃分支摘要</p>
      <p className="branch-summary-detail">已写入此分支的后续模型上下文 · 概括 {summary.abandonedTurnIds.length} 个被放弃回合 · {summary.characters} 字。摘要属于模型判断，平台事实以原始工具结果为准，不扩大操作授权。</p>
      {readable && <button type="button" className="branch-summary-toggle" data-branch-summary-toggle aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        {open ? "收起摘要正文" : "展开摘要正文"}
      </button>}
      {readable && open && <div className="branch-summary-body" id={bodyId} data-branch-summary-body>
        <p className="branch-summary-label">模型生成的被放弃分支摘要</p>
        {body.loading ? <p className="branch-summary-detail" role="status">正在读取正文…</p>
          : body.error ? <p className="branch-summary-error" role="alert">读取失败：{body.error}</p>
            : <div className="branch-summary-text">{body.text}</div>}
      </div>}
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
