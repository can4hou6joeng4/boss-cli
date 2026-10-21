import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PlatformLoginStatus } from "@boss-cli/protocol";
import { IconCheck, IconClose, IconLock, IconPanelRight } from "./Icons";

type Choice = "open" | "later" | "cancel";
interface LoginOption { id: Choice; label: string; detail: string; recommended?: boolean; }
const connectionOptions: LoginOption[] = [
  { id: "open", label: "打开官方登录页", detail: "在右侧浏览器完成登录，求职者也可以使用。", recommended: true },
  { id: "later", label: "稍后登录", detail: "回到会话继续工作，当前输入内容会保留。" },
];
const waitingOptions: LoginOption[] = [
  { id: "open", label: "继续登录", detail: "展开当前官方页面，继续本次登录。" },
  { id: "later", label: "稍后继续", detail: "收起浏览器；本次登录从开始起最多保留五分钟。" },
  { id: "cancel", label: "取消本次登录", detail: "结束本次等待，保留此前已保存的账号登录态。" },
];

function LoginRequest({ pending, busy, error, onAnswer, onClose }: {
  pending: boolean; busy: boolean; error?: string; onAnswer: (choice: Choice) => void; onClose: () => void;
}): JSX.Element {
  const id = useId();
  const options = pending ? connectionOptions : waitingOptions;
  const [choice, setChoice] = useState<Choice>(options[0]!.id);
  const [hovered, setHovered] = useState<Choice>();
  const [advancing, setAdvancing] = useState<Choice>();
  const surface = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => { surface.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const close = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    onClose();
  };
  const answer = (next: Choice) => {
    if (busy || timer.current !== null) return;
    setChoice(next); setHovered(next); setAdvancing(next);
    timer.current = setTimeout(() => { timer.current = null; onAnswer(next); }, 180);
  };
  const handleKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (busy || event.target instanceof Element && event.target.closest("[data-login-dismiss]")) return;
    const digit = /^[1-9]$/.test(event.key) ? options[Number(event.key) - 1] : undefined;
    if (digit) { event.preventDefault(); if (!event.repeat) answer(digit.id); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (timer.current !== null) return;
      const index = options.findIndex(option => option.id === choice);
      const next = options[Math.min(options.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]!;
      setChoice(next.id); setHovered(next.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) answer(choice);
    }
  };
  return <section ref={surface} tabIndex={0} className="login-choice is-choosing" aria-labelledby={`${id}-title`} onKeyDown={handleKeys} aria-busy={busy || !!advancing}>
    <header className="login-choice-heading">
      <h3 id={`${id}-title`}>{pending ? "如何连接 BOSS 直聘？" : "接下来如何处理登录？"}</h3>
      <button data-login-dismiss type="button" className="login-choice-close" aria-label={pending ? "收起登录选择" : "收起登录选项"} title="收起 · Esc" onClick={close}><IconClose size={14} /></button>
    </header>
    <div className="login-request-body">
      <div className="login-choice-options" role="radiogroup" aria-labelledby={`${id}-title`}>
        {options.map((option, index) => <button key={option.id} type="button" role="radio" aria-checked={choice === option.id}
          className={`login-choice-option${(advancing ?? hovered ?? choice) === option.id ? " is-highlighted" : ""}${advancing === option.id ? " is-advancing" : ""}`}
          aria-labelledby={`${id}-${option.id}-label${option.recommended ? ` ${id}-${option.id}-recommended` : ""}`} aria-describedby={`${id}-${option.id}-detail`}
          aria-keyshortcuts={String(index + 1)} disabled={busy || !!advancing}
          onPointerEnter={() => { if (timer.current === null) setHovered(option.id); }} onClick={() => answer(option.id)}>
          <span className="login-option-number" aria-hidden="true">{index + 1}</span>
          <span className="login-option-content">
            <span className="login-option-heading"><span id={`${id}-${option.id}-label`}>{option.label}</span>{option.recommended && <small id={`${id}-${option.id}-recommended`} className="login-choice-recommendation">推荐</small>}</span>
            <span id={`${id}-${option.id}-detail`} className="login-option-description">{option.detail}</span>
          </span>
          <span className="login-option-enter" aria-hidden="true">↵</span>
        </button>)}
      </div>
      {error && <p className="login-choice-error" role="alert">{error}</p>}
      <footer className="login-request-footer"><button data-login-dismiss type="button" className="login-choice-secondary" disabled={busy || !!advancing} onClick={close}>跳过</button></footer>
    </div>
  </section>;
}

export function LoginChoice({ status, pending, busy, panelOpen, error, onOpen, onHide, onCancel, onDismiss, onSettings }: {
  status?: PlatformLoginStatus; pending: boolean; busy: boolean; panelOpen: boolean; error?: string;
  onOpen: () => void; onHide: () => void; onCancel: () => void; onDismiss: () => void; onSettings: () => void;
}): JSX.Element {
  const id = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  const waiting = status?.state === "waiting";
  const opening = status?.state === "opening" || (!status && busy);
  const saving = status?.state === "saving";
  const active = waiting || opening || saving;
  const connected = status?.state === "succeeded";
  const failed = status?.state === "failed" || status?.state === "blocked";
  const choosing = pending || (optionsOpen && waiting);
  useEffect(() => { setOptionsOpen(false); }, [pending, status?.browserId]);
  useEffect(() => { if (!waiting) setOptionsOpen(false); }, [waiting]);

  const closeOptions = () => {
    if (pending) onDismiss();
    else {
      setOptionsOpen(false);
      requestAnimationFrame(() => optionsTrigger.current?.focus({ preventScroll: true }));
    }
  };
  if (choosing) return <LoginRequest key={`${pending ? "connect" : "waiting"}:${status?.browserId ?? ""}`} pending={pending} busy={busy} error={error} onClose={closeOptions} onAnswer={answer => {
      setOptionsOpen(false);
      if (answer === "open") onOpen();
      else if (answer === "cancel") onCancel();
      else if (pending) onDismiss();
      else onHide();
    }} />;

  const title = connected ? "BOSS 直聘已连接" : failed ? "登录尚未完成" : status?.state === "cancelled" ? "本次登录已取消"
    : opening ? "正在打开官方页面" : saving ? "正在验证并保存账号" : "等待完成 BOSS 直聘登录";
  const description = waiting && status?.phase === "scan"
    ? panelOpen ? "在右侧选择「APP 扫码登录」，用 BOSS 直聘 App 扫码。" : "官方页面已收起，可以在浏览器中继续登录。"
    : status?.summary || "正在准备官方登录页，请稍候。";
  return <section className={`login-choice is-status${connected ? " is-connected" : ""}${failed ? " is-error" : ""}`} aria-labelledby={`${id}-title`} aria-busy={opening || saving}>
    <div className="login-choice-heading">
      <span className={`login-status-symbol${opening || saving ? " is-loading" : ""}`} aria-hidden="true">{connected ? <IconCheck size={15} /> : <IconLock size={14} />}</span>
      <h3 id={`${id}-title`}>{title}</h3>
      {waiting ? <button ref={optionsTrigger} type="button" className="login-options-trigger" aria-expanded={false} onClick={() => setOptionsOpen(true)}>登录选项</button>
        : !active && <button type="button" className="login-choice-close" aria-label="收起登录引导" onClick={onDismiss}><IconClose size={14} /></button>}
    </div>
    <p className="login-choice-description" role="status" aria-live="polite">{description}</p>
    {connected && <p className="login-choice-capability">{status?.identity === "jobSeeker" ? "当前页面身份为求职者。" : ""}求职者可检索职位，候选人功能需要招聘者身份。</p>}
    {error && <p className="login-choice-error" role="alert">{error}</p>}
    {(!waiting || !panelOpen) && <div className="login-choice-actions">
      {active ? <>{!waiting && <button type="button" className="login-choice-secondary" disabled={busy} onClick={onCancel}>取消本次登录</button>}{waiting && !panelOpen && <button type="button" className="login-choice-submit" onClick={onOpen} disabled={busy}>打开浏览器<IconPanelRight size={13} /></button>}</>
        : connected ? <><button type="button" className="login-choice-secondary" onClick={onSettings}>查看连接状态</button><button type="button" className="login-choice-submit" onClick={onDismiss}>返回会话</button></>
        : <><button type="button" className="login-choice-secondary" onClick={onDismiss}>稍后处理</button><button type="button" className="login-choice-submit" disabled={busy} onClick={onOpen}>重新打开</button></>}
    </div>}
    {status?.code && <details className="login-choice-details"><summary>查看错误代码</summary><code>{status.code}</code></details>}
  </section>;
}
