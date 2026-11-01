import { useEffect, useRef, useState } from "react";
import type { SessionExportSaveRequest, SessionExportSaveResult } from "@boss-cli/protocol";
import { ModalSurface } from "./ModalSurface";
import "../styles/context-panel.css";

type ExportView = SessionExportSaveRequest["view"];
type ExportFormat = SessionExportSaveRequest["format"];
type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "canceled" }
  | { kind: "saved"; result: Extract<SessionExportSaveResult, { saved: true }> }
  | { kind: "error"; message: string };

const number = (value: number) => value.toLocaleString("zh-CN");

function rpcError(value: unknown): Error | null {
  if (!value || typeof value !== "object" || !("__harnessRpcError" in value)) return null;
  const rpc = (value as { __harnessRpcError?: { code?: unknown; message?: unknown } }).__harnessRpcError;
  const message = typeof rpc?.message === "string" ? rpc.message.slice(0, 300) : "内核拒绝了导出请求";
  return new Error(typeof rpc?.code === "number" ? `${message}（内核 ${rpc.code}）` : message);
}

function savedResult(value: unknown): SessionExportSaveResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.saved === false && raw.canceled === true) return { saved: false, canceled: true };
  const counts = raw.redactions as Record<string, unknown> | undefined;
  const count = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (raw.saved !== true || typeof raw.fileName !== "string" || !raw.fileName || raw.fileName.length > 255 ||
    !count(raw.bytes) || typeof raw.truncated !== "boolean" || !count(raw.turnCount) || !count(raw.exportedTurnCount) ||
    (raw.toolResults !== "omitted" && raw.toolResults !== "included") || !counts ||
    !["secrets", "environment", "paths", "personalInfo"].every(key => count(counts[key]))) return null;
  return value as SessionExportSaveResult;
}

/**
 * 导出会话（只读）：选择视图、格式与是否包含工具结果明文，经主进程保存对话框写盘。
 * 正文由内核脱敏生成、由主进程直接写入用户选择的文件；本组件只看到文件名与统计。
 */
export function ExportDialog({ isOpen, onClose, threadId, branchViews, connected }: {
  isOpen: boolean; onClose: () => void; threadId: string | null; branchViews: boolean; connected: boolean;
}) {
  const [view, setView] = useState<ExportView>("branch");
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [includeToolResults, setIncludeToolResults] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const version = useRef(0);
  useEffect(() => {
    version.current += 1;
    setStatus({ kind: "idle" }); setIncludeToolResults(false); setAcknowledged(false);
  }, [isOpen, threadId]);
  if (!isOpen || !threadId) return null;
  const effectiveView: ExportView = branchViews ? view : "log";
  const blocked = !connected || !window.boss?.exportSession || status.kind === "saving" || (includeToolResults && !acknowledged);
  const save = async () => {
    const mine = ++version.current;
    setStatus({ kind: "saving" });
    try {
      const response: unknown = await window.boss.exportSession({ threadId, view: effectiveView, format, includeToolResults });
      if (version.current !== mine) return;
      const failure = rpcError(response);
      if (failure) throw failure;
      const result = savedResult(response);
      if (!result) throw new Error("导出结果格式无法识别");
      setStatus(result.saved ? { kind: "saved", result } : { kind: "canceled" });
    } catch (error) {
      if (version.current !== mine) return;
      const message = error instanceof Error && error.message ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 300) : "导出失败";
      setStatus({ kind: "error", message });
    }
  };
  return <ModalSurface title="导出会话" onClose={onClose} className="context-panel export-dialog">
    <div className="dialog-form">
      <p className="context-panel-source" data-export-note>导出用于复盘与提交问题报告。内核默认脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容不导出；工具结果只保留调用名、执行状态与结果结构，候选人个人信息（姓名、手机号、邮箱、微信、简历正文等）打码。文件由主进程写入你选择的位置。</p>
      {branchViews && <fieldset className="export-options" aria-label="导出范围">
        <legend>范围</legend>
        <label className="branch-summary-option"><input type="radio" name="export-view" checked={view === "branch"} onChange={() => setView("branch")} /><span>当前分支</span></label>
        <label className="branch-summary-option"><input type="radio" name="export-view" checked={view === "log"} onChange={() => setView("log")} /><span>完整日志（含已切离的分支）</span></label>
      </fieldset>}
      <fieldset className="export-options" aria-label="导出格式">
        <legend>格式</legend>
        <label className="branch-summary-option"><input type="radio" name="export-format" checked={format === "markdown"} onChange={() => setFormat("markdown")} /><span>Markdown（便于阅读与粘贴）</span></label>
        <label className="branch-summary-option"><input type="radio" name="export-format" checked={format === "json"} onChange={() => setFormat("json")} /><span>JSON（结构化，便于工具处理）</span></label>
      </fieldset>
      <label className="branch-summary-option"><input type="checkbox" data-export-include checked={includeToolResults} onChange={event => { setIncludeToolResults(event.target.checked); setAcknowledged(false); }} /><span>包含工具结果明文</span></label>
      {includeToolResults && <div className="context-panel-warning export-risk" role="alert" data-export-risk>
        <p><strong>风险提示：</strong>工具参数与结果明文可能包含候选人姓名、联系方式、简历正文与平台标识等个人信息。导出文件请仅用于本人复盘，不要上传到公开问题报告或发给无关人员；凭据与本机路径仍会脱敏。</p>
        <label className="branch-summary-option"><input type="checkbox" data-export-ack checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>我了解风险，仍要包含明文</span></label>
      </div>}
      {!connected && <p className="context-panel-warning" role="status">本地内核未连接，暂不能导出。</p>}
      {status.kind === "saved" && <p className="context-panel-note" role="status" data-export-status="saved">
        已保存为「{status.result.fileName}」（{number(status.result.bytes)} 字节，{number(status.result.exportedTurnCount)} / {number(status.result.turnCount)} 个回合）。
        {status.result.truncated ? "内容超出导出上限，已截断并在文末标注。" : ""}
        脱敏：凭据 {number(status.result.redactions.secrets)} 处、环境变量 {number(status.result.redactions.environment)} 处、本机路径 {number(status.result.redactions.paths)} 处、候选人信息 {number(status.result.redactions.personalInfo)} 处。
      </p>}
      {status.kind === "canceled" && <p className="context-panel-note" role="status" data-export-status="canceled">已取消保存，未写入文件。</p>}
      {status.kind === "error" && <p className="context-panel-warning" role="alert" data-export-status="error">导出失败：{status.message}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
        <button type="button" className="solid-button" data-export-save disabled={blocked} onClick={() => { void save(); }}>{status.kind === "saving" ? "正在导出…" : "选择保存位置…"}</button>
      </div>
    </div>
  </ModalSurface>;
}
