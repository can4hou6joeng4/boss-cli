import { useCallback, useEffect, useState } from "react";
import type { ContextEditReadResponse } from "@boss-cli/protocol";
import { readContextEdit, writeContextEdit } from "../data/harnessBridge";
import { ModalSurface } from "./ModalSurface";
import "../styles/context-edit.css";

interface Props {
  threadId: string;
  itemId: string;
  title: string;
  onClose: () => void;
  onChanged: (state: ContextEditReadResponse) => void;
}

function validate(value: ContextEditReadResponse, threadId: string, itemId: string): ContextEditReadResponse {
  if (value.threadId !== threadId || value.itemId !== itemId || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
      || typeof value.originalText !== "string" || !(typeof value.currentText === "string" || value.currentText === null)
      || typeof value.canEdit !== "boolean" || typeof value.excluded !== "boolean") {
    throw new Error("上下文编辑响应与当前消息不匹配，已停止操作。");
  }
  return value;
}

export function ContextEditDialog({ threadId, itemId, title, onClose, onChanged }: Props) {
  const [record, setRecord] = useState<ContextEditReadResponse>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = validate(await readContextEdit(threadId, itemId), threadId, itemId);
      setRecord(next);
      setDraft(next.currentText ?? next.originalText);
      setUncertain(false);
      onChanged(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取会话上下文失败。");
    } finally {
      setLoading(false);
    }
  }, [itemId, onChanged, threadId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const apply = async (replacementText: string | null) => {
    if (!record || saving || !record.canEdit) return;
    setSaving(true);
    setError("");
    setUncertain(false);
    let writeError: unknown;
    try {
      await writeContextEdit({ threadId, itemId, sourceDigest: record.sourceDigest, replacementText });
    } catch (cause) {
      writeError = cause;
    }

    // A lost RPC response can follow a durable append. Read the authoritative
    // state before reporting failure; never repeat the append automatically.
    try {
      const actual = validate(await readContextEdit(threadId, itemId), threadId, itemId);
      setRecord(actual);
      setDraft(actual.currentText ?? actual.originalText);
      onChanged(actual);
      const expected = replacementText === null ? actual.excluded : !actual.excluded && actual.currentText === replacementText;
      if (expected) {
        setError("");
        setUncertain(false);
      } else if (writeError) {
        setError("提交结果未确认。已重新读取当前上下文；请核对下方内容后再决定下一步。没有自动重试。");
        setUncertain(true);
      } else {
        setError("会话来源已变化，编辑没有按预期生效。请核对当前内容后重新操作。");
      }
    } catch (cause) {
      setError(writeError
        ? "提交结果和当前状态都无法确认。请先刷新并核对，不要重复提交。"
        : cause instanceof Error ? cause.message : "提交后无法读取最新上下文，请稍后核对。");
      setUncertain(true);
    } finally {
      setSaving(false);
    }
  };

  const excluded = record?.excluded ?? false;
  const changed = Boolean(record && !excluded && record.currentText !== record.originalText);

  return <ModalSurface title={title} onClose={saving ? () => undefined : onClose} className="context-edit-dialog">
    <div className="context-edit-body">
      <p className="context-edit-note">这里只调整未来模型请求中的上下文。原始会话记录和已发生的操作保持不变。</p>
      {loading && <p className="context-edit-status" role="status">正在读取消息与当前上下文…</p>}
      {record && <>
        <section className="context-edit-state" aria-label="当前模型上下文状态">
          <strong>{excluded ? "此消息已从后续模型上下文排除" : changed ? "后续模型请求使用替换文本" : "后续模型请求使用原始文本"}</strong>
          <span>{record.canEdit ? "可追加新的上下文编辑" : record.reason || "此消息当前不可编辑"}</span>
        </section>
        <section className="context-edit-source">
          <h3>原始会话文本</h3>
          <pre>{record.originalText || "（空文本）"}</pre>
        </section>
        <section className="context-edit-source">
          <h3>当前送入模型的文本</h3>
          <pre>{excluded ? "（此消息不进入后续模型上下文）" : record.currentText || "（空文本）"}</pre>
        </section>
        {record.canEdit && <label className="context-edit-label" htmlFor="context-edit-draft">替换文本
          <textarea id="context-edit-draft" rows={7} value={draft} onChange={event => setDraft(event.target.value)} disabled={saving || loading} />
        </label>}
        {record.reason && !record.canEdit && <p className="context-edit-warning" role="status">{record.reason}</p>}
      </>}
      {error && <p className="context-edit-warning" role="alert">{error}</p>}
      {uncertain && !loading && <p className="context-edit-status" role="status">当前状态尚未确认；刷新只读取，不会再次提交编辑。</p>}
      {error && !loading && <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={saving}>重新读取状态</button>}
      <div className="context-edit-actions">
        <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>关闭</button>
        {record?.canEdit && <>
          <button className="secondary-button" type="button" onClick={() => void apply(record.originalText)} disabled={saving || loading || (!excluded && !changed && draft === record.originalText)}>恢复原文</button>
          <button className="secondary-button" type="button" onClick={() => void apply(null)} disabled={saving || loading || excluded}>排除消息</button>
          <button className="solid-button" type="button" onClick={() => void apply(draft)} disabled={saving || loading || !draft.trim() || [...draft].length > 32000 || draft === record.currentText}>{saving ? "正在核对…" : "使用替换文本"}</button>
        </>}
      </div>
    </div>
  </ModalSurface>;
}
