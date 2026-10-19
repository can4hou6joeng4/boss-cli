import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./Icons";
export function ModalSurface({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const siblings = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== backdropRef.current).map(el => ({ el, inert: el.inert }));
    siblings.forEach(({ el }) => { el.inert = true; });
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>("input,button,textarea,select,a[href],[tabindex='0']") ?? [])].filter(el => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    const focusFirst = () => (focusable().find(el => el.tagName === "INPUT") ?? focusable()[0] ?? ref.current)?.focus();
    focusFirst();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key === "Tab") {
        const items = focusable(), first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); ref.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) focusFirst(); };
    document.addEventListener("keydown", handle, true); document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("keydown", handle, true); document.removeEventListener("focusin", focus); siblings.forEach(({ el, inert }) => { el.inert = inert; }); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(<div className="surface-backdrop" ref={backdropRef} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`surface-dialog ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="surface-heading"><h2>{title}</h2><button className="titlebar-btn" onClick={onClose} aria-label="关闭"><IconClose size={18} /></button></div>
      {children}
    </div>
  </div>, document.body);
}
