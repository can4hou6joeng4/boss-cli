import React, { useState, useRef, useEffect } from "react";
import { harnessErrorText } from "../data/harnessBridge";
import { IconClose, IconSend, IconChat } from "./Icons";

export interface SideChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 已连接本地内核：提问会创建真实会话并发送，不在本地生成任何回复。 */
  connected: boolean;
  /** 浏览器预览（没有桌面桥）时保留演示交互，并始终标注为示例。 */
  preview: boolean;
  /** 正在创建会话；用于禁止重复提交。 */
  busy?: boolean;
  /** 提交问题；返回是否已创建会话并发送。 */
  onAsk?: (question: string) => Promise<boolean>;
}

interface SideMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** 单个问题的长度上限与内核输入契约一致；超出时在本地拒绝，不发起请求。 */
const MAX_QUESTION_CHARS = 100_000;
const PREVIEW_REPLY = "示例提示：招聘判断应附上履历依据与待确认问题。此窗口未调用模型，内容仅用于预览。";

export const SideChatModal: React.FC<SideChatModalProps> = ({ isOpen, onClose, connected, preview, busy = false, onAsk }) => {
  const live = !preview;
  const [messages, setMessages] = useState<SideMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [isOpen]);

  // 每次关闭都清掉提交结果；输入正文保留，便于用户重新打开后继续编辑。
  useEffect(() => {
    if (isOpen) return;
    setSubmitting(false);
    setNotice("");
  }, [isOpen]);

  if (!isOpen) return null;

  const question = inputText.trim();
  const tooLong = question.length > MAX_QUESTION_CHARS;
  const blocked = live && !connected;
  const canSubmit = question.length > 0 && !tooLong && !submitting && !busy && !blocked;

  const handleSend = async () => {
    if (!canSubmit) return;
    if (!live) {
      // 仅浏览器预览保留演示回复，并明确标注为示例。
      setInputText("");
      setMessages(previous => [...previous,
        { id: `u-${Date.now()}`, role: "user", text: question },
        { id: `a-${Date.now()}`, role: "assistant", text: PREVIEW_REPLY }]);
      return;
    }
    setSubmitting(true);
    setNotice("");
    try {
      const accepted = await onAsk?.(question);
      if (accepted) {
        setInputText("");
        onClose();
      } else {
        setNotice("未能创建会话；输入已保留，不会自动重试。请按主界面的提示处理后重试。");
      }
    } catch (cause) {
      setNotice(`提问失败：${harnessErrorText(cause)}。输入已保留，不会自动重试。`);
    } finally {
      setSubmitting(false);
    }
  };

  const hint = !live
    ? "浏览器预览：这里的回复是示例，不会调用模型。"
    : !connected
      ? "本地内核未连接，暂时无法提问。"
      : "提问会新建一个会话并立即发送，当前会话不受影响；回复在新会话中查看。";

  return (
    <div className="sidechat-floating-window" role="dialog" aria-label={live ? "快速提问" : "快速提问 · 示例"}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="sidechat-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconChat size={14} style={{ color: "var(--accent-color)" }} />
          <span>{live ? "快速提问" : "快速提问 · 示例"}</span>
        </div>
        <button className="titlebar-btn" onClick={onClose} title="关闭 (⌘;)" aria-label="关闭快速提问">
          <IconClose size={12} />
        </button>
      </div>

      <div className="sidechat-messages">
        <p className="sidechat-note" role="note">{hint}</p>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              background: m.role === "user" ? "var(--user-bubble-bg)" : "rgba(255, 255, 255, 0.05)",
              border: `1px solid ${m.role === "user" ? "var(--user-bubble-border)" : "var(--border-color)"}`,
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {m.text}
          </div>
        ))}
        {notice ? <p className="sidechat-notice" role="status">{notice}</p> : null}
        {tooLong ? <p className="sidechat-notice" role="alert">问题超过 {MAX_QUESTION_CHARS} 字符，无法发送。</p> : null}
        {blocked ? <p className="sidechat-notice" role="status">连接本地内核后才能提问。</p> : null}
      </div>

      <div className="sidechat-composer">
        <input
          ref={inputRef} aria-label="快速提问输入"
          placeholder={live ? "输入问题，发送后在新会话查看回复…" : "试试临时提问…"}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          className="send-arrow-btn"
          style={{ width: 28, height: 28 }}
          onClick={() => { void handleSend(); }}
          disabled={!canSubmit}
          aria-label={live ? (submitting ? "正在创建会话" : "发送提问") : "发送示例提问"}
        >
          <IconSend size={12} />
        </button>
      </div>
    </div>
  );
};
