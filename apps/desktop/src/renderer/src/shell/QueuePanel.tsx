import { useState } from "react";
import type { QueueItem } from "@boss-harness/protocol";
import { IconClose } from "../components/Icons";
import { harnessErrorText } from "../data/harnessBridge";
import { compactionLabel, compactionTitle } from "./queueCompaction";

const LABELS: Record<QueueItem["status"], string> = {
  queued: "排队中",
  delivering: "正在投递",
  delivered: "已投递",
  paused: "已暂停",
  cancelled: "已撤回",
};
const MAX_VISIBLE_ITEMS = 20;

export function QueuePanel({ items, totalItems, activeItems, truncated, onRemove, onRetry }: {
  items: QueueItem[];
  /** 内核侧总数；旧内核不返回时为 undefined。 */
  totalItems?: number;
  /** 内核按全部持久项统计的待处理数；旧内核缺省时按已载入项计算。 */
  activeItems?: number;
  /** 内核只返回有界投影，仍有未载入的队列记录。 */
  truncated?: boolean;
  onRemove: (id: string) => Promise<boolean>;
  onRetry?: (item: QueueItem) => Promise<boolean>;
}): JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!items.length) return null;
  const canRetry = (item: QueueItem) => Boolean(onRetry) && item.kind === "followUp"
    && item.status === "paused" && item.failureCode === "TURN_START_FAILED" && item.inputPersisted === false;
  const retry = async (item: QueueItem) => {
    setPending(item.id); setError("");
    try {
      if (!await onRetry!(item)) setError("重新排队未完成，请稍后重试。");
    } catch (cause) {
      // 重新排队会先读取完整输入；读取失败、断连与内核拒绝要给出各自原因，否则只能盲目刷新。
      setError(`重新排队结果尚未确认：${harnessErrorText(cause)}。请刷新队列状态。`);
    } finally {
      setPending(null);
    }
  };
  const visibleItems = (() => {
    const active = items.filter(item => item.status === "queued" || item.status === "delivering" || item.status === "paused");
    const visibleActive = active.slice(-MAX_VISIBLE_ITEMS);
    const room = Math.max(0, MAX_VISIBLE_ITEMS - visibleActive.length);
    const visibleTerminal = room ? items.filter(item => !active.includes(item)).slice(-room) : [];
    const keep = new Set([...visibleActive, ...visibleTerminal].map(item => item.id));
    return items.filter(item => keep.has(item.id));
  })();
  const pendingCount = activeItems ?? items.filter(item => item.status === "queued" || item.status === "delivering" || item.status === "paused").length;
  // 内核投影与界面自身的 20 条上限都可能隐藏记录；总数只用于说明，不参与任何业务判断。
  const total = Math.max(totalItems ?? items.length, items.length);
  const kernelHidden = truncated === true;
  const hiddenNote = [
    kernelHidden
      ? total > items.length ? `共 ${total} 项，已载入 ${items.length} 项` : `列表已截断，已载入 ${items.length} 项`
      : "",
    visibleItems.length < items.length ? `仅显示 ${visibleItems.length} 项` : "",
  ].filter(Boolean).join("，");
  return <section className="turn-queue" aria-label="任务队列" aria-live="polite">
    <div className="turn-queue-heading"><strong>任务队列</strong><span data-queue-pending={pendingCount} title={activeItems !== undefined ? "待处理数量由内核按全部持久队列项统计。"
      : kernelHidden ? "待处理数量按内核已载入的队列项统计。" : undefined}>{pendingCount} 项待处理</span>
      {hiddenNote && <span className="turn-queue-more" data-queue-total={total} data-queue-truncated={kernelHidden ? "true" : "false"} data-queue-visible={visibleItems.length}
        title={kernelHidden ? `内核只返回有界投影（待处理与已结束条目各自封顶），更早的队列记录未载入。${activeItems !== undefined
          ? "待处理数量仍按全部持久项统计。" : "待处理数量按已载入项统计。"}` : "任务队列较长，界面只显示最近的项目。"}>{hiddenNote}</span>}
    </div>
    <ul>
      {visibleItems.map(item => <li key={item.id}>
        <div className="turn-queue-item-copy">
          <span className={`turn-queue-kind is-${item.kind}`}>{item.kind === "steering" ? "当前回合" : "后续回合"}</span>
          <span className="turn-queue-status">{item.status === "paused" && item.failureCode === "TURN_START_FAILED" ? "启动失败，未执行"
            : item.status === "delivered" && item.deduplicated ? "已关联已有回合" : LABELS[item.status]}</span>
          {item.skillIds && item.skillIds.length > 0 && <span className="turn-queue-skills" title={item.skillIds.join("、")}>技能 {item.skillIds.length} 项</span>}
          {item.autoCompaction && <span className="turn-queue-skills" title={compactionTitle(item.autoCompaction)}>{compactionLabel(item.autoCompaction)}</span>}
          {item.inputTruncated && <span className="turn-queue-skills" title="列表只显示前 600 字符；重新排队会读取并复用完整输入">正文已截断</span>}
          <p title={item.input}>{item.input}</p>
          {item.status === "paused" && item.failureCode === "TURN_START_FAILED" && <p className="turn-queue-error">
            {item.inputPersisted === true ? "输入已保留在当前会话，核对后可发起新任务。" : item.inputPersisted === false
              ? onRetry ? "输入尚未写入当前会话，可直接重新排队。" : "输入尚未写入当前会话，核对后可发起新任务。" : "请先核对当前会话，再决定是否发起新任务。"}
          </p>}
          {item.status === "paused" && item.deduplicated && item.failureCode !== "TURN_START_FAILED" && <p className="turn-queue-error">
            已关联旧请求，请核对当前会话后决定是否发起新任务。
          </p>}
        </div>
        {canRetry(item) && <button type="button" className="turn-queue-retry" title="用同一输入与技能重新创建队列消息，并撤回旧项" disabled={pending !== null} onClick={() => { void retry(item); }}>重新排队</button>}
        {(item.status === "queued" || item.status === "paused") && <button type="button" aria-label={`撤回排队消息：${item.input.slice(0, 80)}`} title={item.status === "paused" ? "取消暂停的队列消息" : "撤回排队消息"} disabled={pending !== null} onClick={async () => {
          setPending(item.id); setError("");
          try { if (!await onRemove(item.id)) setError("撤回结果尚未确认，请刷新队列状态。"); }
          catch (cause) { setError(`撤回结果尚未确认：${harnessErrorText(cause)}。请刷新队列状态。`); }
          finally { setPending(null); }
        }}><IconClose size={14} /></button>}
      </li>)}
    </ul>
    {error && <p className="turn-queue-error" role="status">{error}</p>}
  </section>;
}
