import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadUsageBucket, ThreadUsageReadResponse, ThreadUsageSummaryJob, ThreadUsageTurn } from "@boss-cli/protocol";
import { readThreadUsage } from "./harnessBridge";
import { readPagedItems } from "./pagedRead";
import { bucketOf, isCount as count, summaryJobOf, turnOf } from "./usageMapping";

/**
 * 会话用量（只在内核声明 capabilities.threadUsage 时启用）。
 * 数据只来自 thread/usage/read：内核按回合汇总已持久的 provider 上报用量，不估算、不计价。
 * 界面只做形状校验与展示；未上报字段保持 null，由组件显示为“—”。
 */
export type UsageView = "log" | "branch";
export interface ThreadUsageState {
  loading: boolean;
  error: string;
  view: UsageView;
  data?: { threadId: string; view: UsageView; turnCount: number; turns: ThreadUsageTurn[]; truncated: boolean;
    summaryTasks: ThreadUsageBucket; totals: ThreadUsageBucket;
    /** 旧内核不返回摘要任务明细。 */
    summaryJobs?: ThreadUsageSummaryJob[]; summaryJobCount?: number; summaryJobsTruncated?: boolean };
}

const MAX_PAGES = 10;

/** 摘要任务明细在每页重复返回；任一页形状不符即报错，展示时只取第一份。 */
function summaryJobsOf(page: ThreadUsageReadResponse): Pick<NonNullable<ThreadUsageState["data"]>,
  "summaryJobs" | "summaryJobCount" | "summaryJobsTruncated"> {
  if (page.summaryJobs === undefined) return {};
  if (!Array.isArray(page.summaryJobs) || (page.summaryJobCount !== undefined && !count(page.summaryJobCount))
    || (page.summaryJobsTruncated !== undefined && typeof page.summaryJobsTruncated !== "boolean")) {
    throw new Error("内核返回的摘要任务用量格式无法识别");
  }
  const jobs = page.summaryJobs.slice(0, 50).map(summaryJobOf);
  if (jobs.some(job => !job)) throw new Error("内核返回的摘要任务用量格式无法识别");
  return { summaryJobs: jobs as ThreadUsageSummaryJob[], summaryJobCount: page.summaryJobCount,
    summaryJobsTruncated: page.summaryJobsTruncated };
}

/** 按页读取（每页 200 个回合，最多 10 页），任一页形状不符即整体报错，不展示部分可疑数据。 */
async function readAll(threadId: string, view: UsageView, valid: () => boolean): Promise<ThreadUsageState["data"]> {
  let head: ThreadUsageReadResponse | null = null;
  let summaryTasks: ThreadUsageBucket | null = null, totals: ThreadUsageBucket | null = null;
  let summaryMeta: ReturnType<typeof summaryJobsOf> | null = null;
  const reads = await readPagedItems<ThreadUsageTurn>("回合用量", async cursor => {
    const page: ThreadUsageReadResponse = await readThreadUsage(threadId, view, cursor);
    if (!valid()) throw new Error("回合用量读取已过期");
    if (!page || page.threadId !== threadId || page.view !== view || page.source !== "provider-usage"
      || !Array.isArray(page.turns) || !count(page.turnCount) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new Error("内核返回的用量不属于当前会话或格式无法识别");
    }
    head ??= page;
    summaryTasks ??= bucketOf(page.summaryTasks);
    totals ??= bucketOf(page.totals);
    if (!summaryTasks || !totals) throw new Error("内核返回的用量汇总格式无法识别");
    const pageMeta = page.summaryJobs === undefined ? null : summaryJobsOf(page);
    summaryMeta ??= pageMeta;
    const turns: ThreadUsageTurn[] = [];
    for (const item of page.turns) {
      const turn = turnOf(item);
      if (!turn) throw new Error("内核返回的回合用量格式无法识别");
      turns.push(turn);
    }
    return { items: turns, nextCursor: page.nextCursor ?? null };
  }, MAX_PAGES);
  return { threadId, view, turnCount: head!.turnCount, turns: reads.items, truncated: reads.truncated,
    summaryTasks: summaryTasks!, totals: totals!, ...(summaryMeta ?? {}) };
}

function errorText(error: unknown): string {
  const value = error && typeof error === "object" ? error as { rpcError?: unknown; code?: unknown; message?: unknown } : null;
  const message = typeof value?.message === "string" ? value.message.slice(0, 300) : "无法读取本地内核响应";
  return value?.rpcError === true && typeof value.code === "number" ? `${message}（内核 ${value.code}）` : message;
}

export function useThreadUsage(threadId: string | null, connected: boolean, supported: boolean, branchViews: boolean, running: boolean) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<ThreadUsageState>({ loading: false, error: "", view: "log" });
  const version = useRef(0);
  const current = useRef({ threadId, connected, supported, view: state.view });
  // 内核未声明 sessionBranchViews 时只读全部记录。
  current.current = { threadId, connected, supported, view: branchViews ? state.view : "log" };
  const refresh = useCallback(async () => {
    const { threadId: id, connected: up, supported: ok, view } = current.current;
    const mine = ++version.current;
    if (!id || !up || !ok) { setState(previous => ({ ...previous, loading: false, data: undefined })); return; }
    setState(previous => ({ ...previous, loading: true, error: "", data: previous.data?.threadId === id && previous.data.view === view ? previous.data : undefined }));
    try {
      const data = await readAll(id, view, () => version.current === mine);
      if (version.current === mine) setState(previous => ({ ...previous, loading: false, error: "", data }));
    } catch (error) {
      if (version.current === mine) setState(previous => ({ ...previous, loading: false, error: errorText(error), data: undefined }));
    }
  }, []);
  // 打开、切换会话或视图、回合开始 / 结束与重新连接时重新读取；关闭时作废未完成的读取。
  useEffect(() => {
    if (!isOpen) { version.current += 1; return; }
    void refresh();
  }, [isOpen, threadId, connected, supported, branchViews, state.view, running, refresh]);
  useEffect(() => { if (!supported || !threadId) setIsOpen(false); }, [supported, threadId]);
  return {
    isOpen, state: branchViews || state.view === "log" ? state : { ...state, view: "log" as const },
    open: useCallback(() => setIsOpen(true), []),
    close: useCallback(() => setIsOpen(false), []),
    refresh,
    setView: useCallback((view: UsageView) => setState(previous => previous.view === view ? previous : { ...previous, view, data: undefined }), []),
  };
}
