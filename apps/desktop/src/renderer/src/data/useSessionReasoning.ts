import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadReasoningReadResponse } from "@boss-harness/protocol";
import { harnessErrorText, readThreadReasoning, setThreadReasoning } from "./harnessBridge";
import { reasoningTarget } from "./reasoningControl";

export interface SessionReasoningControl {
  data: ThreadReasoningReadResponse | null;
  pending: boolean;
  error: string;
  refresh: () => Promise<void>;
  select: (effort: string | null) => Promise<void>;
}

/** Settings are durable server state; an uncertain write is read back, never replayed. */
export function useSessionReasoning(threadId: string | null, connected: boolean): SessionReasoningControl {
  const [data, setData] = useState<ThreadReasoningReadResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const current = useRef({ threadId, connected });
  current.current = { threadId, connected };
  const epoch = useRef(0), reads = useRef(0), saving = useRef(false);

  const read = useCallback(async (id: string, version: number) => {
    const request = ++reads.current;
    const result = await readThreadReasoning(id);
    if (result.threadId !== id || !Array.isArray(result.availableEfforts)
      || result.availableEfforts.some(effort => typeof effort !== "string")
      || (result.effort !== null && typeof result.effort !== "string")) throw new Error("推理设置响应无效");
    if (epoch.current === version && reads.current === request && current.current.threadId === id) setData(result);
    return result;
  }, []);
  const refresh = useCallback(async () => {
    const { threadId: id, connected: available } = current.current;
    // 断连时不能静默返回：用户点了「重新加载」，必须知道为什么没有变化。
    const target = reasoningTarget("读取", id, available);
    if (!target.ok) { setError(target.notice); return; }
    const version = epoch.current;
    try { await read(target.threadId, version); if (epoch.current === version) setError(""); }
    catch (cause) {
      // 读不到档位时保留真实原因：内核错误码或断连原因都影响用户下一步该做什么。
      if (epoch.current === version) setError(`无法读取会话推理设置：${harnessErrorText(cause)}。请重新连接或重新加载会话后再试。`);
    }
  }, [read]);

  useEffect(() => {
    ++epoch.current; ++reads.current; saving.current = false;
    setData(null); setError(""); setPending(false);
    if (threadId && connected) void refresh();
    const unsubscribe = window.boss?.onNotification(raw => {
      const event = raw as { method?: string; params?: { threadId?: string } };
      if (event.params?.threadId === threadId && ["thread/reasoning/updated", "thread/model/updated", "turn/started", "turn/completed", "context/compactionStarted", "context/compactionCompleted", "context/compactionFailed"].includes(event.method ?? "")) void refresh();
    });
    return () => { ++epoch.current; ++reads.current; unsubscribe?.(); };
  }, [threadId, connected, refresh]);

  useEffect(() => {
    if (!connected || data?.threadId !== threadId || !data?.summaryActive) return;
    // Completion notifications precede worker/abort retirement. Re-read until
    // the retained summary model no longer restricts the session's choices.
    const timer = setTimeout(() => { void refresh(); }, 1000);
    return () => clearTimeout(timer);
  }, [data, threadId, connected, refresh]);

  const select = useCallback(async (effort: string | null) => {
    const { threadId: id, connected: available } = current.current;
    // 档位按钮在 Composer 里没有按连接状态禁用，断连时点击必须给出可见原因。
    const target = reasoningTarget("保存", id, available);
    if (!target.ok) { setError(target.notice); return; }
    if (saving.current) return;
    const version = epoch.current;
    saving.current = true; setPending(true); setError(""); ++reads.current;
    try {
      await setThreadReasoning(target.threadId, effort);
      if (epoch.current === version) await read(target.threadId, version);
    } catch (cause) {
      if (epoch.current !== version) return;
      try {
        const actual = await read(target.threadId, version);
        if (epoch.current === version && actual.effort !== effort) setError(`设置未确认：${harnessErrorText(cause)}。请核对当前档位后再选择；没有自动重试。`);
      } catch (verifyError) {
        if (epoch.current === version) setError(`设置结果待核对：${harnessErrorText(cause)}；读取当前档位也失败（${harnessErrorText(verifyError)}）。重新连接后请核对；没有自动重试。`);
      }
    } finally {
      if (epoch.current === version) { saving.current = false; setPending(false); }
    }
  }, [read]);
  return { data: connected && data?.threadId === threadId ? data : null, pending, error, refresh, select };
}
