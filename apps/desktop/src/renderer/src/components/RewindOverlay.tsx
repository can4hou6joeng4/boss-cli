import { useState } from "react";
import { ModalSurface } from "./ModalSurface";
import type { MessageItem } from "../data/mockData";
export function RewindOverlay({ isOpen, onClose, onConfirmRewind, messages, fork = false }: { isOpen: boolean; onClose: () => void; onConfirmRewind: (messageCount: number) => void; messages: MessageItem[]; fork?: boolean }) {
  const [selected, setSelected] = useState(0);
  if (!isOpen) return null;
  const points = messages.flatMap((message, index) => message.role === "user" ? [{ message, count: index + 1 }] : []);
  return <ModalSurface title={fork ? "创建会话分支" : "会话回溯 · 示例"} onClose={onClose} className="rewind-dialog">
    <div className="dialog-form"><p>{fork ? "以所选消息所属的完整回合创建新会话。原会话保留，已发生的招聘平台操作不会撤销。" : "选择一条消息，移除它之后的示例对话。此操作仅影响当前预览，不会回退文件或招聘平台操作。"}</p>
      <div className="rewind-points">{points.map((point, index) => <label className={`rewind-point ${selected === index ? "selected" : ""}`} key={point.message.id}><input type="radio" name="rewind-point" checked={selected === index} onChange={() => setSelected(index)} /><span><small>消息 {index + 1}</small><strong>{point.message.content}</strong></span></label>)}{!points.length && <p>当前没有可回溯的消息。</p>}</div>
      <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="solid-button" disabled={!points[selected]} onClick={() => { const point = points[selected]; if (point) onConfirmRewind(point.count); onClose(); }}>{fork ? "创建分支" : "回到这条消息"}</button></div>
    </div>
  </ModalSurface>;
}
