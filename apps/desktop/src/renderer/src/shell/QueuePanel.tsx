import { useState } from "react";
import type { QueueItem, SkillDescriptor } from "@boss-harness/protocol";
import { IconClose } from "../components/Icons";
import { ModalSurface } from "../components/ModalSurface";
import { useClipboardCopy } from "../data/clipboardCopy";
import { harnessErrorText } from "../data/harnessBridge";
import { queueRefreshErrorText, type QueueRefreshResult } from "../data/queueRefresh";
import { queueSkillLabels } from "../data/queueSkillLabels";
import { compactionLabel, compactionTitle } from "./queueCompaction";

const LABELS: Record<QueueItem["status"], string> = {
  queued: "排队中",
  delivering: "正在投递",
  delivered: "已投递",
  paused: "已暂停",
  cancelled: "已撤回",
};
const MAX_VISIBLE_ITEMS = 20;

export function QueuePanel({ items, totalItems, activeItems, truncated, onRemove, onRetry, onReadFull, skills = [], connected = true, onRefresh }: {
  items: QueueItem[];
  /** 技能目录；用于把队列项里的技能 id 显示为名称，缺失时回退 id。 */
  skills?: SkillDescriptor[];
  /** 内核侧总数；旧内核不返回时为 undefined。 */
  totalItems?: number;
  /** 内核按全部持久项统计的待处理数；旧内核缺省时按已载入项计算。 */
  activeItems?: number;
  /** 内核只返回有界投影，仍有未载入的队列记录。 */
  truncated?: boolean;
  /** 内核连接状态；断开时队列内容可能已过期，刷新按钮禁用。 */
  connected?: boolean;
  /** 手动重读当前会话队列；成功返回 `{ ok: true }`，失败带回原因。 */
  onRefresh?: () => Promise<QueueRefreshResult>;
  /** 读取队列项在持久化记录中的完整输入，仅供核对，不会重新提交。 */
  onReadFull?: (item: QueueItem) => Promise<QueueItem>;
  onRemove: (id: string) => Promise<boolean>;
  onRetry?: (item: QueueItem) => Promise<boolean>;
}): JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ item: QueueItem; input: string } | null>(null);
  const clipboard = useClipboardCopy();
  if (!items.length) return null;
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true); setError("");
    try {
      const reason = queueRefreshErrorText(await onRefresh());
      if (reason) setError(`刷新队列失败：${reason}。队列面板保留上一次内容。`);
    } catch (cause) {
      setError(`刷新队列失败：${harnessErrorText(cause)}。队列面板保留上一次内容。`);
    } finally {
      setRefreshing(false);
    }
  };
  const canRetry = (item: QueueItem) => Boolean(onRetry) && item.kind === "followUp"
    && item.status === "paused" && item.failureCode === "TURN_START_FAILED" && item.inputPersisted === false;
  const showFullInput = async (item: QueueItem) => {
    if (!onReadFull || reading) return;
    clipboard.reset();
    setReading(item.id); setError("");
    try {
      const full = await onReadFull(item);
      setViewing({ item: full, input: full.input });
    } catch (cause) {
      setError(`读取完整输入失败：${harnessErrorText(cause)}。队列面板仍显示预览。`);
    } finally {
      setReading(null);
    }
  };
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
  // 完整输入视图与列表使用同一套技能映射，避免同一个队列项在两处显示不一致。
  const viewingSkillIds = viewing?.item.skillIds ?? [];
  const viewingSkillLabels = queueSkillLabels(viewingSkillIds, skills);
  const copyFeedback = viewing && clipboard.feedback?.key === viewing.item.id ? clipboard.feedback : null;
  return <>
    <section className="turn-queue" aria-label="任务队列" aria-live="polite">
    <div className="turn-queue-heading"><strong>任务队列</strong><span data-queue-pending={pendingCount} title={activeItems !== undefined ? "待处理数量由内核按全部持久队列项统计。"
      : kernelHidden ? "待处理数量按内核已载入的队列项统计。" : undefined}>{pendingCount} 项待处理</span>
      {hiddenNote && <span className="turn-queue-more" data-queue-total={total} data-queue-truncated={kernelHidden ? "true" : "false"} data-queue-visible={visibleItems.length}
        title={kernelHidden ? `内核只返回有界投影（待处理与已结束条目各自封顶），更早的队列记录未载入。${activeItems !== undefined
          ? "待处理数量仍按全部持久项统计。" : "待处理数量按已载入项统计。"}` : "任务队列较长，界面只显示最近的项目。"}>{hiddenNote}</span>}
      {onRefresh && <button type="button" className="turn-queue-refresh" disabled={refreshing || !connected}
        title={connected ? "重新读取当前会话的队列状态" : "本机内核未连接，恢复连接后再刷新"}
        onClick={() => { void refresh(); }}>{refreshing ? "刷新中…" : "刷新"}</button>}
    </div>
    {!connected && <p className="turn-queue-stale" role="status">本机内核已断开，队列状态可能已过期；恢复连接后会重新读取。</p>}
    <ul>
      {visibleItems.map(item => <li key={item.id}>
        <div className="turn-queue-item-copy">
          <span className={`turn-queue-kind is-${item.kind}`}>{item.kind === "steering" ? "当前回合" : "后续回合"}</span>
          <span className="turn-queue-status">{item.status === "paused" && item.failureCode === "TURN_START_FAILED" ? "启动失败，未执行"
            : item.status === "delivered" && item.deduplicated ? "已关联已有回合" : LABELS[item.status]}</span>
          {(() => {
            const ids = item.skillIds ?? [];
            if (!ids.length) return null;
            const labels = queueSkillLabels(ids, skills);
            return labels.length
              ? <span className="turn-queue-skills" title={labels.join("、")}>技能：{labels.join("、")}</span>
              : <span className="turn-queue-skills" title={ids.join("、")}>技能 {ids.length} 项</span>;
          })()}
          {item.autoCompaction && <span className="turn-queue-skills" title={compactionTitle(item.autoCompaction)}>{compactionLabel(item.autoCompaction)}</span>}
          {item.inputTruncated && <span className="turn-queue-skills" title="列表只显示前 600 字符；可点击「查看完整输入」核对全文，重新排队会读取并复用完整输入">正文已截断</span>}
          <p title={item.input}>{item.input}</p>
          {item.inputTruncated && onReadFull && <button type="button" className="turn-queue-expand" disabled={reading !== null}
            title="读取内核持久化的完整输入，仅供核对，不会重新提交"
            onClick={() => { void showFullInput(item); }}>{reading === item.id ? "读取中…" : "查看完整输入"}</button>}
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
    </section>
    {viewing && <ModalSurface title="队列消息完整输入" onClose={() => setViewing(null)}>
      <div className="dialog-form queue-input-dialog">
        <p className="dialog-note">{viewing.item.kind === "steering" ? "当前回合" : "后续回合"} · {LABELS[viewing.item.status]} · 只读展示持久化正文，关闭不会重新提交或修改队列。</p>
        {(viewingSkillIds.length > 0 || viewing.item.autoCompaction) && <div className="queue-input-facts">
          {viewingSkillLabels.length > 0 ? <span title={viewingSkillLabels.join("、")}>技能：{viewingSkillLabels.join("、")}</span>
            : viewingSkillIds.length > 0 ? <span title={viewingSkillIds.join("、")}>技能 {viewingSkillIds.length} 项（目录中未找到名称）</span> : null}
          {viewing.item.autoCompaction && <span title={compactionTitle(viewing.item.autoCompaction)}>{compactionLabel(viewing.item.autoCompaction)}</span>}
        </div>}
        <pre className="turn-queue-full-input">{viewing.input || "（空输入）"}</pre>
        <div className="dialog-actions queue-input-actions">
          {copyFeedback && <span className={copyFeedback.ok ? "queue-input-copy-status" : "queue-input-copy-error"} role="status">
            {copyFeedback.ok ? "已复制完整输入" : `复制失败：${copyFeedback.reason}；正文仍在窗口中`}
          </span>}
          <button className="secondary-button" disabled={!viewing.input} title="复制持久化正文，不会重新提交或修改队列"
            onClick={() => { void clipboard.copy(viewing.input, viewing.item.id); }}>复制完整输入</button>
        </div>
      </div>
    </ModalSurface>}
  </>;
}
