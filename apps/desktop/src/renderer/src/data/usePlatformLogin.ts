import { useEffect, useRef, useState } from "react";
import type { PlatformLoginStatus } from "@boss-cli/protocol";

const active = (status: PlatformLoginStatus) => ["opening", "waiting", "saving"].includes(status.state);
const focusComposer = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".thread-composer-inner textarea")?.focus());

/** Login is a desktop interaction attached to a thread, not a model turn. */
export function usePlatformLogin() {
  const [status, setStatus] = useState<PlatformLoginStatus>({ state: "idle", summary: "尚未开始登录" });
  const [panelThreadId, setPanelThreadId] = useState<string | null>(null);
  const [choiceThreadId, setChoiceThreadId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<{ threadId: string; message: string } | null>(null);
  const flight = useRef(false), revision = useRef(0);
  useEffect(() => {
    if (!window.boss) return;
    let alive = true;
    const initial = revision.current;
    const unsubscribe = window.boss.onPlatformLogin(next => { revision.current += 1; if (alive) setStatus(next); });
    void window.boss.platformLogin("status").then(next => { if (alive && initial === revision.current) setStatus(next); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, []);
  const show = (threadId: string) => {
    setDismissed(previous => previous.filter(id => id !== threadId)); setError(null);
    if (status.threadId === threadId && status.state !== "idle" && status.state !== "cancelled") setPanelThreadId(threadId);
    else setChoiceThreadId(threadId);
  };
  const open = async (threadId: string) => {
    if (!window.boss || flight.current) return;
    setDismissed(previous => previous.filter(id => id !== threadId)); setChoiceThreadId(null); setPanelThreadId(threadId); setError(null);
    if (status.threadId === threadId && active(status)) return;
    setExpanded(false);
    flight.current = true; setBusy(true);
    const before = revision.current;
    try {
      const next = await window.boss.platformLogin("open", { threadId });
      if (before === revision.current) setStatus(next);
    } catch {
      setError({ threadId, message: "无法启动登录。请检查本机连接后重试；已有账号登录态仍保留。" });
      if (before === revision.current) setStatus({ threadId, state: "failed", summary: "官方登录页尚未打开" });
    } finally { flight.current = false; setBusy(false); }
  };
  const cancel = async (threadId: string) => {
    if (!window.boss || !status.browserId || status.threadId !== threadId || flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    const before = revision.current;
    try {
      const next = await window.boss.platformLogin("cancel", { threadId, browserId: status.browserId });
      if (before === revision.current) setStatus(next);
      setPanelThreadId(null);
      focusComposer();
    } catch { setError({ threadId, message: "取消结果未确认，请检查连接后重试。" }); }
    finally { flight.current = false; setBusy(false); }
  };
  const dismiss = (threadId: string) => {
    setChoiceThreadId(null); setPanelThreadId(null); setDismissed(previous => [...previous, threadId]); setError(null);
    focusComposer();
  };
  return { status, panelThreadId, choiceThreadId, busy, error, open, cancel, show, dismiss, expanded,
    toggleExpanded: () => setExpanded(previous => !previous),
    hideForLater: () => { setPanelThreadId(null); focusComposer(); },
    closePanel: () => { setPanelThreadId(null); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="打开会话浏览器"]')?.focus()); },
    visibleIn: (threadId: string) => choiceThreadId === threadId || (!dismissed.includes(threadId) && status.threadId === threadId && status.state !== "idle"),
  };
}
