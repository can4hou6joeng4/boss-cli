import { useEffect, useRef, useState } from "react";
import type { PlatformLoginStatus } from "@boss-harness/protocol";
import { harnessErrorText } from "./harnessBridge";

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
  const [statusError, setStatusError] = useState("");
  const flight = useRef(false), revision = useRef(0);
  useEffect(() => {
    if (!window.boss) return;
    let alive = true;
    const initial = revision.current;
    const unsubscribe = window.boss.onPlatformLogin(next => {
      revision.current += 1;
      if (alive) { setStatusError(""); setStatus(next); }
    });
    void window.boss.platformLogin("status").then(next => { if (alive && initial === revision.current) setStatus(next); })
      .catch(cause => {
        // 读不到上一次登录状态时，面板会当成「尚未开始」；记下原因，等用户准备登录时提示，避免撞上仍在进行的登录。
        if (alive && initial === revision.current) setStatusError(`无法读取上一次登录状态：${harnessErrorText(cause)}`);
      });
    return () => { alive = false; unsubscribe(); };
  }, []);
  const show = (threadId: string) => {
    setDismissed(previous => previous.filter(id => id !== threadId));
    // 原因在决定是否登录的这一刻最有价值：此时正要发起新登录，可能与此前未读到的登录冲突。
    setError(statusError ? { threadId, message: `${statusError}。若此前已发起过登录，请先在下方取消，再重新打开官方页面。` } : null);
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
    } catch (cause) {
      setError({ threadId, message: `无法启动登录：${harnessErrorText(cause)}。请检查本机连接后重试；已有账号登录态仍保留。` });
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
    } catch (cause) { setError({ threadId, message: `取消结果未确认：${harnessErrorText(cause)}。请检查连接后重试。` }); }
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
