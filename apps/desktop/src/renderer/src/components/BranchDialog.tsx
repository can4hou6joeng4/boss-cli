import { useEffect, useState } from "react";
import { ModalSurface } from "./ModalSurface";
import type { MessageItem } from "../data/mockData";
import { isSettledTurn, type BranchSupport, type SessionBranchState } from "../data/useSessionBranches";
import type { ThreadBranchEndpoint } from "@boss-cli/protocol";

type Target = BranchTarget;

function timeOf(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
function clip(text: string | null | undefined, fallback: string): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return fallback;
  return value.length > 80 ? value.slice(0, 80) + "…" : value;
}

/**
 * 会话内分支选择器（交互参考 Pi coding-agent 的 /tree：列出分支端点、选位置、可选摘要被放弃的分支）。
 * 切换只移动 leaf 指针；原回合保留可切回；招聘平台上已发生的操作不会撤销。
 */
export interface BranchTarget { turnId: string | null; label: string; abandons: boolean }
export function BranchDialog({ isOpen, onClose, state, support, messages, block, summaryUnavailable, onSwitch, onRefresh, initialTarget }: {
  isOpen: boolean; onClose: () => void; state: SessionBranchState; support: BranchSupport; messages: MessageItem[];
  initialTarget?: BranchTarget | null;
  block: string | null; summaryUnavailable: string | null;
  onSwitch: (turnId: string | null, summarize: boolean) => Promise<boolean>; onRefresh: () => void;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [summarize, setSummarize] = useState(false);
  useEffect(() => { setTarget(isOpen ? initialTarget ?? null : null); setSummarize(false); }, [isOpen, initialTarget]);
  useEffect(() => { setSummarize(false); }, [target?.turnId]);
  if (!isOpen) return null;
  const inputOf = (turnId: string) => messages.find(message => message.role === "user" && message.turnId === turnId)?.content;
  const turns = state.turns.filter(turn => isSettledTurn(turn.status));
  const endpointTarget = (endpoint: ThreadBranchEndpoint): Target => ({ turnId: endpoint.turnId,
    label: `分支端点「${clip(endpoint.inputPreview, "无文本输入")}」`, abandons: !endpoint.containsLeaf });
  const summaryBlocked = !support.summary ? "当前内核不支持生成被放弃分支摘要。"
    : summaryUnavailable ?? (target && !target.abandons ? "切换到此处不会放弃任何回合，无需摘要。" : null);
  const confirm = async () => {
    if (!target || block) return;
    const ok = await onSwitch(target.turnId, summarize && !summaryBlocked);
    if (ok) onClose();
  };
  return <ModalSurface title="会话分支" onClose={onClose} className="rewind-dialog branch-dialog">
    <div className="dialog-form">
      <p>切换只移动当前位置：原有回合全部保留，可随时切回；之后的输入从所选位置继续，模型只会看到所选分支的历史。已发生的招聘平台操作不会撤销。</p>
      {block && <p className="branch-block" role="status" data-branch-block>{block}</p>}
      {state.switchError && <p className="branch-error" role="alert">{state.switchError}</p>}
      {state.error && <p className="branch-error" role="alert">{state.error}</p>}
      <section className="branch-section" aria-label="分支端点">
        <div className="branch-section-heading"><strong>分支端点</strong><span>{state.loading ? "正在读取…" : `${state.endpoints.length} 个${state.endpointsTruncated ? "（仅显示前若干页）" : ""}`}</span>
          <button type="button" className="secondary-button" onClick={onRefresh} disabled={state.loading}>刷新</button></div>
        <div className="rewind-points">
          {state.endpoints.map(endpoint => <div className={`branch-row ${endpoint.isLeaf || endpoint.containsLeaf ? "current" : ""} ${target?.turnId === endpoint.turnId ? "selected" : ""}`} key={endpoint.turnId} data-branch-endpoint={endpoint.turnId}>
            <span className="branch-row-copy">
              <small>
                {endpoint.isLeaf ? <b className="branch-badge">当前</b> : endpoint.containsLeaf ? <b className="branch-badge">含当前位置</b> : null}
                {!endpoint.selectable && <b className="branch-badge muted">未结束</b>}
                第 {endpoint.depth} 回合{timeOf(endpoint.completedAt ?? endpoint.updatedAt) ? ` · ${timeOf(endpoint.completedAt ?? endpoint.updatedAt)}` : ""}
              </small>
              <strong title={endpoint.inputPreview ?? undefined}>{clip(endpoint.inputPreview, "（无文本输入）")}</strong>
              {endpoint.branchTurnId !== endpoint.turnId && <small title={endpoint.branchInputPreview ?? undefined}>分支首条输入：{clip(endpoint.branchInputPreview, "（无文本输入）")}</small>}
            </span>
            <button type="button" className="secondary-button" disabled={endpoint.isLeaf || !endpoint.selectable || Boolean(block)}
              title={endpoint.isLeaf ? "已在此位置" : !endpoint.selectable ? "该回合尚未结束，不能切换" : block ?? undefined}
              onClick={() => setTarget(endpointTarget(endpoint))}>{endpoint.isLeaf ? "当前位置" : !endpoint.selectable ? "不可切换" : "切换到此分支"}</button>
          </div>)}
          {!state.loading && !state.endpoints.length && <p>当前会话还没有已结束的回合。</p>}
        </div>
      </section>
      <section className="branch-section" aria-label="当前分支回合">
        <div className="branch-section-heading"><strong>从这里重新开始</strong><span>当前分支 {turns.length} 个已结束回合</span></div>
        <div className="rewind-points">
          <div className={`branch-row ${target && target.turnId === null ? "selected" : ""}`} data-branch-turn="root">
            <span className="branch-row-copy"><small>会话开头</small><strong>回到第一条输入之前</strong></span>
            <button type="button" className="secondary-button" disabled={state.leafTurnId === null || Boolean(block)} title={block ?? undefined}
              onClick={() => setTarget({ turnId: null, label: "会话开头", abandons: true })}>{state.leafTurnId === null ? "当前位置" : "从这里重新开始"}</button>
          </div>
          {turns.map((turn, index) => <div className={`branch-row ${turn.turnId === state.leafTurnId ? "current" : ""} ${target?.turnId === turn.turnId ? "selected" : ""}`} key={turn.turnId} data-branch-turn={turn.turnId}>
            <span className="branch-row-copy"><small>第 {index + 1} 回合之后{timeOf(turn.updatedAt) ? ` · ${timeOf(turn.updatedAt)}` : ""}</small>
              <strong title={inputOf(turn.turnId)}>{clip(inputOf(turn.turnId), "（无文本输入）")}</strong></span>
            <button type="button" className="secondary-button" disabled={turn.turnId === state.leafTurnId || Boolean(block)} title={block ?? undefined}
              onClick={() => setTarget({ turnId: turn.turnId, label: `第 ${index + 1} 回合之后`, abandons: true })}>{turn.turnId === state.leafTurnId ? "当前位置" : "从这里重新开始"}</button>
          </div>)}
        </div>
      </section>
      {target && <section className="branch-confirm" aria-label="确认切换">
        <p className="branch-confirm-target">将切换到：<b>{target.label}</b></p>
        <label className="branch-summary-option">
          <input type="checkbox" checked={summarize && !summaryBlocked} disabled={Boolean(summaryBlocked)} onChange={event => setSummarize(event.target.checked)} />
          <span>为被放弃的分支生成摘要</span>
        </label>
        <p className="branch-summary-cost">{summaryBlocked ?? "会调用模型并可能产生费用。摘要在后台生成，写入新分支并标注为“被放弃分支摘要”；生成失败或取消不会撤销切换。"}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => setTarget(null)}>取消</button>
          <button type="button" className="solid-button" disabled={Boolean(block) || state.switching} onClick={() => { void confirm(); }}>{state.switching ? "正在切换…" : "确认切换"}</button>
        </div>
      </section>}
    </div>
  </ModalSurface>;
}
