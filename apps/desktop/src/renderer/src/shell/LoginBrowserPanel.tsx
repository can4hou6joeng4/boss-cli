import { useLayoutEffect, useRef, useState } from "react";
import type { PlatformLoginAction, PlatformLoginStatus } from "@boss-cli/protocol";
import { IconCheck, IconChevronRight, IconClose, IconLock } from "../components/Icons";

export function LoginBrowserPanel({ status, threadId, expanded, onToggleExpanded, onClose, onRetry }: {
  status?: PlatformLoginStatus; threadId: string; expanded: boolean; onToggleExpanded: () => void; onClose: () => void; onRetry: () => void;
}): JSX.Element {
  const slot = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  const [controlError, setControlError] = useState("");
  const browserId = status?.browserId;
  const available = Boolean(status?.browser?.available && ["waiting", "saving"].includes(status.state));
  // The native page sits above HTML. Never leave it over a modal, menu, or another thread.
  useLayoutEffect(() => {
    if (!window.boss || !browserId || !available) return;
    let frame = 0, previous = "";
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = slot.current?.getBoundingClientRect();
        const overlay = Boolean(document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"]'));
        setCovered(overlay);
        const visible = !overlay && !document.hidden && Boolean(rect && rect.width >= 100 && rect.height >= 80);
        const bounds = rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const signature = JSON.stringify({ visible, bounds });
        if (signature === previous) return;
        previous = signature;
        void window.boss.platformLogin("layout", { threadId, browserId, visible, bounds }).catch(() => {});
      });
    };
    const resize = () => { previous = ""; update(); };
    const size = new ResizeObserver(update);
    if (slot.current) size.observe(slot.current);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "aria-modal", "role", "class"] });
    window.addEventListener("resize", resize);
    window.addEventListener("focus", resize);
    document.addEventListener("visibilitychange", resize);
    update();
    return () => {
      cancelAnimationFrame(frame); size.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", resize);
      window.removeEventListener("focus", resize);
      void window.boss.platformLogin("layout", { threadId, browserId, visible: false }).catch(() => {});
    };
  }, [threadId, browserId, available]);
  const control = (action: PlatformLoginAction) => {
    if (!browserId) return;
    setControlError("");
    void window.boss.platformLogin(action, { threadId, browserId }).catch(() => setControlError("浏览器操作未完成，请检查连接后重试。"));
  };
  const connected = status?.state === "succeeded";
  const failed = status?.state === "failed" || status?.state === "blocked";
  const cancelled = status?.state === "cancelled";
  const footer = status?.state === "saving" ? "正在验证账号…" : status?.browser?.loading ? "页面加载中…"
    : connected ? "账号连接已完成" : failed ? "登录未完成" : cancelled ? "登录已取消" : "内置浏览器";
  return <aside className="login-browser-panel" aria-label="当前会话的内置浏览器">
    <header className="login-browser-tabs"><span className="login-browser-tab"><span className="login-browser-favicon" aria-hidden="true">B</span>BOSS 直聘<span className="login-browser-tab-dot" /></span><div className="login-browser-window-actions"><button type="button" className="titlebar-btn" aria-label={expanded ? "恢复浏览器分栏" : "展开浏览器"} title={expanded ? "恢复分栏" : "展开浏览器"} onClick={onToggleExpanded}><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d={expanded ? "M3 8h5V3M17 12h-5v5M8 8 3 3m9 9 5 5" : "M3 8V3h5M17 12v5h-5M3 3l5 5m9 9-5-5"} /></svg></button><button type="button" className="titlebar-btn" onClick={onClose} aria-label="收起浏览器，返回会话" title="收起浏览器，返回会话"><IconClose size={15} /></button></div></header>
    <div className="login-browser-toolbar">
      <button type="button" className="titlebar-btn" aria-label="浏览器后退" disabled={!status?.browser?.canGoBack || status.state !== "waiting"} onClick={() => control("back")}><IconChevronRight size={15} className="rotate-back" /></button>
      <button type="button" className="titlebar-btn" aria-label="浏览器前进" disabled={!status?.browser?.canGoForward || status.state !== "waiting"} onClick={() => control("forward")}><IconChevronRight size={15} /></button>
      <button type="button" className="titlebar-btn login-browser-reload" aria-label="重新加载官方页面" disabled={!available || status?.state !== "waiting"} onClick={() => control("reload")}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .2 5M16 3v4h-4" /></svg></button>
      <div className="login-browser-address"><IconLock size={12} /><span>www.zhipin.com</span><small>官方页面</small></div>
    </div>
    {controlError && <p className="login-browser-control-error" role="alert">{controlError}</p>}
    <div className="login-browser-viewport" ref={slot}>
      {(!available || failed || covered) && <div className="login-browser-placeholder"><span className="login-browser-placeholder-icon">{connected ? <IconCheck size={28} /> : <IconLock size={26} />}</span><h3>{covered ? "浏览器已暂时隐藏" : connected ? "账号已连接" : failed ? "登录还未完成" : cancelled ? "本次登录已取消" : "正在打开官方页面"}</h3><p>{covered ? "关闭当前菜单或弹窗后，官方页面会在这里恢复。" : connected ? "登录态已保存。返回会话后，可按账号身份继续使用工具。" : failed || cancelled ? status?.summary : "登录页面在隔离的浏览器中打开。"}</p>{(failed || cancelled) && <button type="button" className="solid-button" onClick={onRetry}>重新打开</button>}{connected && <button type="button" className="solid-button" onClick={onClose}>返回当前会话</button>}</div>}
    </div>
    <footer className="login-browser-footer"><span className={status?.browser?.loading ? "is-loading" : ""} /><span>{footer}</span><span className="login-browser-footer-hint">{available && "用 BOSS 直聘 App 扫码，选择已有身份"}</span><button type="button" onClick={onClose}>返回会话</button></footer>
  </aside>;
}
