import React, { useState, useRef, useEffect } from "react";
import { IconClose, IconSend, IconChat } from "./Icons";

export interface SideChatModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SideMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export const SideChatModal: React.FC<SideChatModalProps> = ({ isOpen, onClose }) => {
  const [messages, setMessages] = useState<SideMessage[]>([
    {
      id: "side-1",
      role: "assistant",
      text: "这里展示独立提问的界面交互。当前尚未连接模型，所有回复均为示例。",
    },
  ]);
  const [inputText, setInputText] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [isOpen]);
  if (!isOpen) return null;

  const handleSend = () => {
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setInputText("");
    const userMsg: SideMessage = { id: `u-${Date.now()}`, role: "user", text };
    setMessages((prev) => [...prev, userMsg]);

    setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: "示例提示：招聘判断应附上履历依据与待确认问题。此窗口未调用模型，内容仅用于预览。" }]);
  };

  return (
    <div className="sidechat-floating-window" role="dialog" aria-label="快速提问 · 示例" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="sidechat-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconChat size={14} style={{ color: "var(--accent-color)" }} />
          <span>快速提问 · 示例</span>
        </div>
        <button className="titlebar-btn" onClick={onClose} title="关闭 (⌘;)" aria-label="关闭快速提问">
          <IconClose size={12} />
        </button>
      </div>

      <div className="sidechat-messages">
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
      </div>

      <div className="sidechat-composer">
        <input
          ref={inputRef} aria-label="快速提问输入" placeholder="试试临时提问…"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          className="send-arrow-btn"
          style={{ width: 28, height: 28 }}
          onClick={handleSend}
          disabled={!inputText.trim()} aria-label="发送示例提问"
        >
          <IconSend size={12} />
        </button>
      </div>
    </div>
  );
};
