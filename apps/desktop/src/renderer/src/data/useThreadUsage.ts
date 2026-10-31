import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadUsageBucket, ThreadUsageReadResponse, ThreadUsageTurn } from "@boss-cli/protocol";
import { readThreadUsage } from "./harnessBridge";

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
    summaryTasks: ThreadUsageBucket; totals: ThreadUsageBucket };
}

const MAX_PAGES = 10;
const COUNT_KEYS = ["requests", "verifiedRequests", "unverifiedRequests", "promptTokens", "uncachedInputTokens", "outputTokens"] as const;
const NULLABLE_KEYS = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function bucketOf(value: unknown): ThreadUsageBucket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!COUNT_KEYS.every(key => count(raw[key])) || !NULLABLE_KEYS.every(key => raw[key] === null || count(raw[key]))) return null;
  const reasons = raw.unverifiedReasons;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return null;
  const unverifiedReasons: Record<string, number> = {};
  for (const [reason, amount] of Object.entries(reasons as Record<string, unknown>).slice(0, 20)) {
    if (!count(amount)) return null;
    unverifiedReasons[reason.slice(0, 40)] = amount;
  }
  const bucket = {} as ThreadUsageBucket;
  for (const key of COUNT_KEYS) bucket[key] = raw[key] as number;
  for (const key of NULLABLE_KEYS) bucket[key] = raw[key] as number | null;
  // 费用不展示：内核当前无可信价目来源，界面固定标注“未计价”。
  return { ...bucket, unverifiedReasons, costUsd: null, costSource: "unavailable" };
}
const strings = (value: unknown, limit: number): string[] | null => Array.isArray(value) && value.every(item => typeof item === "string")
  ? (value as string[]).slice(0, limit).map(item => item.slice(0, 120)) : null;
function turnOf(value: unknown): ThreadUsageTurn | null {
  const bucket = bucketOf(value);
  if (!bucket) return null;
  const raw = value as Record<string, unknown>;
  const providers = strings(raw.providers, 8), models = strings(raw.models, 8);
  if (typeof raw.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.turnId) || !providers || !models) return null;
  return { ...bucket, turnId: raw.turnId, providers, models };
}

/** 按页读取（每页 200 个回合，最多 10 页），任一页形状不符即整体报错，不展示部分可疑数据。 */
async function readAll(threadId: string, view: UsageView, valid: () => boolean): Promise<ThreadUsageState["data"] | null> {
  const turns: ThreadUsageTurn[] = [];
  let cursor: string | null = null, pages = 0, head: ThreadUsageReadResponse | null = null;
  let summaryTasks: ThreadUsageBucket | null = null, totals: ThreadUsageBucket | null = null;
  do {
    const page: ThreadUsageReadResponse = await readThreadUsage(threadId, view, cursor);
    if (!valid()) return null;
    if (!page || page.threadId !== threadId || page.view !== view || page.source !== "provider-usage"
      || !Array.isArray(page.turns) || !count(page.turnCount) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new Error("内核返回的用量不属于当前会话或格式无法识别");
    }
    head ??= page;
    summaryTasks ??= bucketOf(page.summaryTasks);
    totals ??= bucketOf(page.totals);
    if (!summaryTasks || !totals) throw new Error("内核返回的用量汇总格式无法识别");
    for (const item of page.turns) {
      const turn = turnOf(item);
      if (!turn) throw new Error("内核返回的回合用量格式无法识别");
      turns.push(turn);
    }
    cursor = page.nextCursor; pages += 1;
  } while (cursor && pages < MAX_PAGES);
  return { threadId, view, turnCount: head!.turnCount, turns, truncated: Boolean(cursor), summaryTasks: summaryTasks!, totals: totals! };
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
      if (data && version.current === mine) setState(previous => ({ ...previous, loading: false, error: "", data }));
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
