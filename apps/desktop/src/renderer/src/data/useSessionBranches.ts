import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextBranchSummary, ContextCompactJob, InitializeResponse, QueueItem, ThreadBranchEndpoint, TurnSummary } from "@boss-cli/protocol";
import { abortContextCompaction, listBranchTurns, listThreadBranches, readContext, readContextCompaction, setThreadLeaf } from "./harnessBridge";

/**
 * 会话内分支（只在内核同时声明 sessionLeaf / sessionBranchTree / sessionBranchViews 时启用）。
 * 界面只读分支端点与当前分支回合，切换经 thread/leaf/set；摘要任务复用上下文摘要任务的读取与取消。
 */
export interface BranchSupport { summary: boolean }
export function branchSupport(capabilities?: InitializeResponse["capabilities"]): BranchSupport | null {
  if (capabilities?.sessionLeaf !== true || capabilities.sessionBranchTree !== true || capabilities.sessionBranchViews !== true) return null;
  return { summary: capabilities.sessionBranchSummary === true };
}

export interface SessionBranchState {
  loading: boolean;
  loaded: boolean;
  error: string;
  branched: boolean;
  leafTurnId: string | null;
  turnCount: number;
  endpoints: ThreadBranchEndpoint[];
  endpointsTruncated: boolean;
  /** 当前分支上的回合（自根到 leaf）。 */
  turns: TurnSummary[];
  summaries: ContextBranchSummary[];
  summaryJob?: ContextCompactJob;
  switching: boolean;
  switchError: string;
  cancelInFlight: boolean;
}

const initial = (): SessionBranchState => ({ loading: false, loaded: false, error: "", branched: false, leafTurnId: null, turnCount: 0,
  endpoints: [], endpointsTruncated: false, turns: [], summaries: [], switching: false, switchError: "", cancelInFlight: false });
const MAX_PAGES = 10;
const TERMINAL_TURN = new Set(["completed", "interrupted", "blocked", "error"]);
export const isSettledTurn = (status: string | null | undefined): boolean => Boolean(status && TERMINAL_TURN.has(status));

function rpcDetail(error: unknown): { rpc: boolean; text: string } {
  const value = error && typeof error === "object" ? error as { rpcError?: unknown; code?: unknown; message?: unknown; data?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : null;
  const message = typeof value?.message === "string" ? value.message.slice(0, 300) : "无法读取本地内核响应";
  if (value?.rpcError === true && typeof value.code === "number") {
    const reason = typeof data?.code === "string" ? ` / ${data.code}` : "";
    return { rpc: true, text: `${message}（内核 ${value.code}${reason}）` };
  }
  return { rpc: false, text: message };
}

function isBranchJob(value: unknown, threadId: string): value is ContextCompactJob {
  if (!value || typeof value !== "object") return false;
  const job = value as ContextCompactJob;
  return job.kind === "branchSummary" && job.threadId === threadId && typeof job.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(job.jobId)
    && ["running", "completed", "failed", "cancelled"].includes(job.status);
}

/** 切换前的界面侧阻断原因；与内核 thread/leaf/set 的 -32004 拒绝条件对应。 */
export function branchSwitchBlock(options: { connected: boolean; running: boolean; queueItems: QueueItem[]; compacting: boolean; switching: boolean }): string | null {
  if (!options.connected) return "本地内核未连接，暂不能切换分支。";
  if (options.switching) return "正在切换分支，请稍候。";
  if (options.running) return "回合运行中，暂不能切换分支：请先停止或等待回合结束（内核 -32004：请先中断该会话的运行回合）。";
  if (options.compacting) return "正在生成摘要，暂不能切换分支：请等待完成或先取消摘要（内核 -32004：该会话正在生成摘要）。";
  if (options.queueItems.some(item => item.status === "queued" || item.status === "delivering" || item.status === "paused")) {
    return "队列中仍有未处理的消息，暂不能切换分支：请等待投递完成或先撤回（排队或暂停的消息切换后会投递到新分支，界面先行阻断；投递中时内核返回 -32004）。";
  }
  return null;
}

export function useSessionBranches(threadId: string | null, connected: boolean, support: BranchSupport | null,
  onSwitched: (threadId: string) => Promise<unknown> | void) {
  const [states, setStates] = useState<Record<string, SessionBranchState>>({});
  const stateRef = useRef(states);
  const current = useRef({ threadId, connected, support, onSwitched });
  current.current = { threadId, connected, support, onSwitched };
  const versions = useRef(new Map<string, number>());
  const epoch = useRef(0);
  const alive = useRef(true);
  const update = useCallback((id: string, change: Partial<SessionBranchState> | ((state: SessionBranchState) => SessionBranchState)) => {
    if (!alive.current) return;
    const previous = stateRef.current[id] ?? initial();
    const next = typeof change === "function" ? change(previous) : { ...previous, ...change };
    stateRef.current = { ...stateRef.current, [id]: next };
    setStates(stateRef.current);
  }, []);
  const applyJob = useCallback((id: string, job: ContextCompactJob) => {
    update(id, state => {
      const known = state.summaryJob;
      if (known && known.jobId !== job.jobId && known.status === "running" && job.status !== "running") return state;
      // 终态优先于迟到的 running 读取。
      if (known && known.jobId === job.jobId && known.status !== "running") return state;
      return { ...state, summaryJob: { ...(known?.jobId === job.jobId ? known : {}), ...job },
        cancelInFlight: job.status === "running" ? state.cancelInFlight : false };
    });
  }, [update]);

  const refresh = useCallback(async (id: string): Promise<void> => {
    if (!current.current.connected || !current.current.support) return;
    const version = (versions.current.get(id) ?? 0) + 1;
    versions.current.set(id, version);
    const connectionEpoch = epoch.current;
    const valid = () => alive.current && epoch.current === connectionEpoch && versions.current.get(id) === version;
    update(id, { loading: true });
    try {
      const endpoints: ThreadBranchEndpoint[] = [];
      let cursor: string | null = null, pages = 0, truncated = false;
      let head: Awaited<ReturnType<typeof listThreadBranches>> | null = null;
      do {
        const page = await listThreadBranches(id, cursor);
        if (!valid()) return;
        if (page.threadId !== id || !Array.isArray(page.endpoints)) throw new Error("分支列表不属于当前会话");
        head ??= page;
        endpoints.push(...page.endpoints);
        cursor = page.nextCursor; pages += 1;
        if (cursor && pages >= MAX_PAGES) { truncated = true; break; }
      } while (cursor);
      const turns: TurnSummary[] = [];
      cursor = null; pages = 0;
      do {
        const page = await listBranchTurns(id, cursor);
        if (!valid()) return;
        if (page.view !== "branch") throw new Error("当前分支回合响应无效");
        turns.push(...page.turns.filter(turn => turn.threadId === id));
        cursor = page.nextCursor; pages += 1;
      } while (cursor && pages < MAX_PAGES);
      let summaries: ContextBranchSummary[] = [];
      let jobId: string | undefined;
      try {
        const context = await readContext(id);
        if (!valid()) return;
        if (context.threadId === id) {
          summaries = Array.isArray(context.branchSummaries) ? context.branchSummaries : [];
          if (context.compactionJob?.active) jobId = context.compactionJob.jobId;
        }
      } catch { /* 摘要条目只用于标注；读取失败不影响分支列表。 */ }
      update(id, state => ({ ...state, loading: false, loaded: true, error: "", branched: head?.branched ?? false,
        leafTurnId: head?.leafTurnId ?? null, turnCount: head?.turnCount ?? 0, endpoints, endpointsTruncated: truncated, turns, summaries }));
      const known = stateRef.current[id]?.summaryJob;
      const watch = jobId ?? (known?.status === "running" ? known.jobId : undefined);
      if (watch) {
        try {
          const job = await readContextCompaction(watch);
          if (valid() && isBranchJob(job, id)) applyJob(id, job);
        } catch { /* 任务可能已淘汰；保留上次状态。 */ }
      }
    } catch (error) {
      if (valid()) update(id, { loading: false, error: `读取分支失败：${rpcDetail(error).text}` });
    }
  }, [applyJob, update]);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.boss?.onNotification(event => {
      const params = event.params && typeof event.params === "object" ? event.params as Record<string, unknown> : {};
      if (event.method === "harness/disconnected" || (event.method === "harness/connectionStatus" && params.state !== "ready")) {
        epoch.current += 1;
        for (const id of Object.keys(stateRef.current)) update(id, state => ({ ...state, loading: false, cancelInFlight: false }));
        return;
      }
      const id = typeof params.threadId === "string" ? params.threadId : null;
      if (!id || !current.current.support) return;
      if (event.method.startsWith("context/compaction") && isBranchJob(params, id)) {
        applyJob(id, params);
        if (params.status !== "running") void refresh(id);
        return;
      }
      if (["thread/leafChanged", "turn/completed", "thread/updated", "context/compacted"].includes(event.method) && id === current.current.threadId) {
        void refresh(id);
      }
    });
    const timer = setInterval(() => {
      if (!current.current.connected) return;
      for (const [id, state] of Object.entries(stateRef.current)) {
        const job = state.summaryJob;
        if (job?.status === "running") void readContextCompaction(job.jobId).then(next => { if (isBranchJob(next, id)) { applyJob(id, next); if (next.status !== "running") void refresh(id); } }).catch(() => undefined);
      }
    }, 2000);
    return () => { alive.current = false; unsubscribe?.(); clearInterval(timer); };
  }, [applyJob, refresh, update]);
  useEffect(() => { if (threadId && connected && support) void refresh(threadId); }, [threadId, connected, support, refresh]);

  const switchTo = useCallback(async (target: string | null, summarize: boolean): Promise<boolean> => {
    const { threadId: id, connected: available, support: supported } = current.current;
    if (!id || !available || !supported) return false;
    const state = stateRef.current[id] ?? initial();
    if (state.switching) return false;
    const connectionEpoch = epoch.current;
    update(id, { switching: true, switchError: "" });
    try {
      const result = await setThreadLeaf(summarize && supported.summary ? { threadId: id, turnId: target, summarize: true } : { threadId: id, turnId: target });
      if (result.threadId !== id || result.leafTurnId !== target) throw new Error("切换回执与所选位置不一致");
      if (result.summaryJob && isBranchJob(result.summaryJob, id)) applyJob(id, result.summaryJob);
      await current.current.onSwitched(id);
      return true;
    } catch (error) {
      if (!alive.current || epoch.current !== connectionEpoch) return false;
      const detail = rpcDetail(error);
      update(id, { switchError: detail.rpc ? `内核拒绝切换，分支保持不变：${detail.text}` : `切换结果尚未确认：${detail.text}。已重新读取分支状态；不会自动重试。` });
      if (!detail.rpc) await current.current.onSwitched(id);
      return false;
    } finally {
      if (alive.current) update(id, { switching: false });
      void refresh(id);
    }
  }, [applyJob, refresh, update]);

  const cancelSummary = useCallback(async () => {
    const id = current.current.threadId;
    if (!id) return;
    const job = stateRef.current[id]?.summaryJob;
    if (!job || job.status !== "running" || stateRef.current[id]?.cancelInFlight) return;
    update(id, { cancelInFlight: true });
    try {
      const result = await abortContextCompaction(job.jobId);
      if (isBranchJob(result, id)) applyJob(id, result);
    } catch (error) {
      update(id, { switchError: `取消摘要的回执未知：${rpcDetail(error).text}。请稍后刷新核对。` });
    } finally { update(id, { cancelInFlight: false }); void refresh(id); }
  }, [applyJob, refresh, update]);

  const dismissSummaryJob = useCallback(() => {
    const id = current.current.threadId;
    if (id) update(id, state => state.summaryJob?.status === "running" ? state : { ...state, summaryJob: undefined });
  }, [update]);
  const clearSwitchError = useCallback(() => {
    const id = current.current.threadId;
    if (id) update(id, { switchError: "" });
  }, [update]);

  const state = threadId ? states[threadId] ?? initial() : initial();
  return { state, support, refresh: () => threadId ? refresh(threadId) : Promise.resolve(), switchTo, cancelSummary, dismissSummaryJob, clearSwitchError };
}
export type SessionBranchControl = ReturnType<typeof useSessionBranches>;
