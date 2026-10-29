import { ModalSurface } from "./ModalSurface";
import type { ContextPanelState } from "../data/useContextPanel";
import "../styles/context-panel.css";

export interface ContextPanelProps {
  isOpen: boolean;
  onClose: () => void;
  threadId: string | null;
  title: string;
  connected: boolean;
  busy: boolean;
  state: ContextPanelState;
  onKeepRecentChange: (value: string) => void;
  onRefresh: () => void;
  onPlan: () => void;
  onStart: () => void;
  onCancel: () => void;
}
const number = (value: number) => value.toLocaleString("zh-CN");
const usage = (value: Record<string, unknown> | null | undefined) => value ? Object.entries(value)
  .filter(([key, amount]) => typeof amount === "number" && /token|request|cost/i.test(key))
  .map(([key, amount]) => `${key}: ${typeof amount === "number" ? number(amount) : amount}`).join(" · ") || "服务返回了用量记录，未提供可展示的 token 数" : "暂无用量记录";
export function ContextPanel(props: ContextPanelProps) {
  if (!props.isOpen) return null;
  const { state, connected, busy } = props, budget = state.budget, job = state.job, plan = state.plan;
  const activeJob = job?.status === "running" && state.lifecycleActive !== false;
  const blocked = !connected || !props.threadId || busy || state.starting || Boolean(state.unknownStart) || state.lifecycleActive === true || activeJob || budget?.requestSource === "active";
  const noSummaryProvider = budget?.summaryAvailable === undefined
    ? budget?.provider === "none"
    : !budget.summaryAvailable;
  const keep = Number(state.keepRecentTokens), keepValid = Number.isSafeInteger(keep) && keep > 0;
  const status = job ? job.status === "running" && state.lifecycleActive === false ? "内核已不再保留此任务，状态已过期" : { running: state.cancelRequested ? "已请求取消，等待收尾" : "正在压缩", completed: "压缩已完成", failed: "压缩失败", cancelled: "压缩已取消" }[job.status] : "";
  const percentage = budget && budget.inputBudget > 0 ? Math.max(0, Math.min(100, budget.estimatedInputTokens / budget.inputBudget * 100)) : 0;
  return <ModalSurface title="会话上下文" onClose={props.onClose} className="context-panel">
    <div className="context-panel-body">
      <div className="context-panel-owner"><strong>{props.title || "当前会话"}</strong><code>{props.threadId ?? "请选择本机内核会话"}</code></div>
      <p className="context-panel-note">预算来自当前会话；不包含尚未发送的草稿。查看和生成计划不会调用模型或执行工具。</p>
      {!connected && <p className="context-panel-warning" role="status">本地内核未连接。已保留原任务信息，重连后只核对状态。</p>}
      <section className="context-panel-section" aria-labelledby="context-budget-heading">
        <div className="context-panel-section-heading"><h3 id="context-budget-heading">当前预算</h3><button type="button" className="secondary-button" onClick={props.onRefresh} disabled={!connected || state.reading}>{state.reading ? "正在读取…" : "刷新预算"}</button></div>
        {budget ? <>
          <p className="context-panel-source">{budget.requestSource === "active" ? "运行中已准备请求" : budget.requestSource === "preview" ? "请求预览" : "空闲会话的当前配置"} · {budget.provider} / {budget.model}</p>
          <div className="context-panel-budget"><strong>{budget.inputBudget > 0 ? <>{number(budget.estimatedInputTokens)}<small> / {number(budget.inputBudget)} 输入 token</small></> : "无可用输入预算"}</strong><span>{budget.withinBudget ? "预算内" : "预算不足"}</span></div>
          <div className="context-panel-meter" role="meter" aria-label="估算输入占预算比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={budget.inputBudget > 0 ? `${Math.round(percentage)}%` : "没有可用输入预算"}><i style={{ width: `${percentage}%` }} /></div>
          <dl className="context-panel-facts"><div><dt>上下文容量</dt><dd>{number(budget.contextWindow)}</dd></div><div><dt>输出预留</dt><dd>{number(budget.outputReserve)}</dd></div><div><dt>消息数</dt><dd>{number(budget.messageCount)}</dd></div><div><dt>容量来源</dt><dd>{budget.capabilitySource}{budget.capacityIsEstimate ? "（估算）" : ""}</dd></div></dl>
          <p className="context-panel-note">输入为估算值，不是账单。估算方式：{budget.estimateMethod}；{budget.usageApplied ? "使用历史用量基线校准" : "未应用历史用量校准"}。</p>
          <details><summary>模型用量与检查点</summary><dl className="context-panel-detail"><dt>最近业务用量</dt><dd>{usage(budget.usage)}</dd><dt>最近摘要用量</dt><dd>{usage(budget.summaryUsage)}</dd><dt>摘要检查点</dt><dd>{budget.checkpoint ? `已保留 · 截止回合 ${String(budget.checkpoint.throughTurnId ?? "未知")}` : "尚无摘要检查点"}</dd>{budget.checkpoint?.summaryProvider && <><dt>检查点模型</dt><dd>{String(budget.checkpoint.summaryProvider)} / {String(budget.checkpoint.summaryModel ?? "未知")}</dd><dt>检查点推理档位</dt><dd>{String(budget.checkpoint.summaryEffort ?? "服务默认")}</dd></>}</dl><p className="context-panel-note">历史用量不等于压缩后的精确输入用量。原始历史保留；摘要用于后续模型上下文。</p></details>
        </> : <p className="context-panel-note">{state.reading ? "正在读取当前会话预算…" : "尚未读取预算，可连接内核后刷新。"}</p>}
      </section>
      <section className="context-panel-section" aria-labelledby="context-plan-heading">
        <h3 id="context-plan-heading">手动压缩</h3>
        {busy && <p className="context-panel-warning" role="status">会话正在运行，只能查看当前预算。请等待回合结束后生成计划。</p>}
        <div className="context-panel-plan-input"><label htmlFor="context-keep-recent">近期保留目标（估算 token）<input id="context-keep-recent" inputMode="numeric" type="number" min="1" step="1" value={state.keepRecentTokens} disabled={blocked || state.planning} onChange={event => props.onKeepRecentChange(event.target.value)} /></label><button type="button" className="secondary-button" onClick={props.onPlan} disabled={blocked || state.planning || !keepValid || !budget}>{state.planning ? "正在规划…" : "生成整理计划"}</button></div>
        <p className="context-panel-note">只整理已完成回合，近期完整回合会保留。目标不是精确裁剪；摘要可能遗漏细节，不保证语义无损。</p>
        {noSummaryProvider && <p className="context-panel-warning" role="status">当前没有可用的摘要模型。仍可查看整理计划，但无法开始压缩。</p>}
        {plan && <div className="context-panel-plan" aria-label="整理计划"><dl className="context-panel-detail"><dt>整理范围</dt><dd>{number(plan.sourceItemCount)} 条历史条目 · 截止回合 <code>{plan.throughTurnId}</code></dd><dt>条目边界</dt><dd><code>{plan.firstItemId}</code> 至 <code>{plan.lastItemId}</code></dd><dt>保留范围</dt><dd>{number(plan.retainedItemCount)} 条 · {number(plan.retainedTurnIds.length)} 个完整回合 · 估算 {number(plan.estimatedRetainedTokens)} token</dd><dt>首个保留条目</dt><dd><code>{plan.firstKeptItemId ?? "无"}</code></dd><dt>来源校验</dt><dd><code>{plan.sourceDigest}</code></dd></dl><p className="context-panel-note">{plan.retentionUsageApplied
          ? `估算已使用 ${number(plan.retentionUsageAnchorCount ?? 0)} 个匹配的历史用量锚点校准；未覆盖消息仍按字符估算。`
          : "估算按字符长度与消息开销计算；没有可用的匹配用量区间。"}</p><p className="context-panel-warning">开始后会新增摘要模型用量，可能分多次请求；不会执行招聘工具。将使用本次计划的固定回合边界和来源校验，来源变化时不会自动重试。</p><button type="button" className="solid-button" onClick={props.onStart} disabled={blocked || noSummaryProvider}>开始压缩</button></div>}
        {state.starting && <p role="status" className="context-panel-note">正在请求开始压缩，等待任务回执…</p>}
        {state.unknownStart && !state.starting && <div className="context-panel-warning" role="status"><strong>开始结果待核对</strong><p>尚未找到与本次来源相符的新任务。不会重复开始；若内核已重启或记录已淘汰，本次结果无法恢复。可继续查看原会话或新建会话。</p><code>{state.unknownStart.sourceDigest}</code></div>}
      </section>
      {job && <section className="context-panel-section" aria-labelledby="context-job-heading"><div className="context-panel-section-heading"><h3 id="context-job-heading">{job.reason ? "自动摘要" : "手动摘要"}</h3><span role="status">{status}</span></div><dl className="context-panel-detail"><dt>任务</dt><dd><code>{job.jobId}</code></dd><dt>所属会话</dt><dd><code>{job.threadId}</code></dd>{job.summaryProvider && <><dt>摘要模型</dt><dd>{job.summaryProvider} / {job.summaryModel ?? "未知"}</dd><dt>推理档位</dt><dd>{job.summaryEffort ?? "服务默认"}</dd></>}{job.reason && <><dt>触发原因</dt><dd>{{ threshold: "接近上下文容量", budget: "请求超过预算", overflow: "模型上下文溢出" }[job.reason]}{job.turnId ? ` · 回合 ${job.turnId}` : ""}</dd></>}<dt>模型请求</dt><dd>{number(job.modelRequestCount ?? 0)} 次</dd>{job.totalCharacters !== undefined && <><dt>来源处理进度</dt><dd>{number(job.processedCharacters ?? 0)} / {number(job.totalCharacters)} 字符（不代表任务完成）</dd></>}</dl>{job.message && <p className={job.status === "failed" ? "context-panel-warning" : "context-panel-note"}>{job.message}{job.code ? `（${job.code}）` : ""}</p>}{state.lifecycleActive === true && job.status !== "running" && <p className="context-panel-note" role="status">已收到终态，仍在等待任务资源收尾。完成后才能再次生成摘要。</p>}{job.status === "running" && !job.reason && state.lifecycleActive !== false && <button type="button" className="secondary-button" disabled={!connected || state.cancelInFlight || Boolean(state.unavailableJob)} onClick={props.onCancel}>{state.cancelInFlight ? "正在请求取消…" : state.cancelRequested ? "再次请求取消" : "取消压缩"}</button>}{job.status === "running" && job.reason && <p className="context-panel-note">自动摘要仍在处理，当前面板只跟踪进度，不提供取消。</p>}</section>}
      {(job || state.unknownStart) && <button type="button" className="secondary-button" onClick={props.onRefresh} disabled={!connected || state.reading}>核对摘要状态</button>}
      {budget && budget.compactionJob === undefined && <p className="context-panel-note">当前内核未提供摘要任务发现信息。已知任务可以核对；未知开始结果无法自动关联。</p>}
      {state.startRejection && <p className="context-panel-warning" role="alert">{state.startRejection}</p>}
      {state.error && <p className="context-panel-warning" role="alert">{state.error}</p>}
      <p className="context-panel-note">关闭面板不会取消摘要。压缩完成后会刷新预算；若仍不足，请减少后续输入、调整保留目标或新建会话。</p>
    </div>
  </ModalSurface>;
}
