import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadReasoningReadResponse } from "@boss-cli/protocol";
import { readThreadReasoning, setThreadReasoning } from "./harnessBridge";

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
    if (!id || !available) return;
    const version = epoch.current;
    try { await read(id, version); if (epoch.current === version) setError(""); }
    catch { if (epoch.current === version) setError("无法读取会话推理设置，请重新加载。"); }
  }, [read]);

  useEffect(() => {
    ++epoch.current; ++reads.current; saving.current = false;
    setData(null); setError(""); setPending(false);
    if (threadId && connected) void refresh();
    const unsubscribe = window.boss?.onNotification(raw => {
      const event = raw as { method?: string; params?: { threadId?: string } };
      if (event.params?.threadId === threadId && ["thread/reasoning/updated", "turn/started", "turn/completed", "context/compactionStarted", "context/compactionCompleted", "context/compactionFailed"].includes(event.method ?? "")) void refresh();
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
    if (!id || !available || saving.current) return;
    const version = epoch.current;
    saving.current = true; setPending(true); setError(""); ++reads.current;
    try {
      await setThreadReasoning(id, effort);
      if (epoch.current === version) await read(id, version);
    } catch {
      if (epoch.current !== version) return;
      try {
        const actual = await read(id, version);
        if (epoch.current === version && actual.effort !== effort) setError("设置未确认，请核对当前档位后再选择；没有自动重试。");
      } catch { if (epoch.current === version) setError("设置结果待核对，重新连接后请读取当前档位；没有自动重试。"); }
    } finally {
      if (epoch.current === version) { saving.current = false; setPending(false); }
    }
  }, [read]);
  return { data: connected && data?.threadId === threadId ? data : null, pending, error, refresh, select };
}
