import { useState } from "react";
import type { QueueItem } from "@boss-cli/protocol";
import { IconClose } from "../components/Icons";

const LABELS: Record<QueueItem["status"], string> = {
  queued: "排队中",
  delivering: "正在投递",
  delivered: "已投递",
  paused: "已暂停",
  cancelled: "已撤回",
};
const MAX_VISIBLE_ITEMS = 20;

export function QueuePanel({ items, onRemove }: {
  items: QueueItem[];
  onRemove: (id: string) => Promise<boolean>;
}): JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!items.length) return null;
  const visibleItems = items.slice(-MAX_VISIBLE_ITEMS);
  return <section className="turn-queue" aria-label="任务队列" aria-live="polite">
    <div className="turn-queue-heading"><strong>任务队列</strong><span>{items.filter(item => item.status === "queued" || item.status === "delivering" || item.status === "paused").length} 项待处理</span></div>
    <ul>
      {visibleItems.map(item => <li key={item.id}>
        <div className="turn-queue-item-copy">
          <span className={`turn-queue-kind is-${item.kind}`}>{item.kind === "steering" ? "当前回合" : "后续回合"}</span>
          <span className="turn-queue-status">{item.status === "paused" && item.failureCode === "TURN_START_FAILED" ? "启动失败，未执行" : LABELS[item.status]}</span>
          <p title={item.input}>{item.input}</p>
          {item.status === "paused" && item.failureCode === "TURN_START_FAILED" && <p className="turn-queue-error">
            {item.inputPersisted === true ? "输入已保留在当前会话，核对后可发起新任务。" : item.inputPersisted === false
              ? "输入尚未写入当前会话，核对后可发起新任务。" : "请先核对当前会话，再决定是否发起新任务。"}
          </p>}
        </div>
        {(item.status === "queued" || item.status === "paused") && <button type="button" aria-label={`撤回排队消息：${item.input.slice(0, 80)}`} title={item.status === "paused" ? "取消暂停的队列消息" : "撤回排队消息"} disabled={pending !== null} onClick={async () => {
          setPending(item.id); setError("");
          try { if (!await onRemove(item.id)) setError("撤回结果尚未确认，请刷新队列状态。"); }
          catch { setError("撤回结果尚未确认，请刷新队列状态。"); }
          finally { setPending(null); }
        }}><IconClose size={14} /></button>}
      </li>)}
    </ul>
    {error && <p className="turn-queue-error" role="status">{error}</p>}
  </section>;
}
