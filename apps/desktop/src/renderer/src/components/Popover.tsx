import { useEffect, useRef, type ReactNode } from "react";
interface Props { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right"; above?: boolean; label?: string; }
export function Popover({ open, onClose, children, align = "left", above = false, label = "操作菜单" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const parent = ref.current?.parentElement;
    const pointer = (event: PointerEvent) => { if (!parent?.contains(event.target as Node)) close.current(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); trigger?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer); parent?.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); parent?.removeEventListener("keydown", key); };
  }, [open]);
  if (!open) return null;
  return <div ref={ref} className={`ui-popover ${align === "right" ? "align-right" : ""} ${above ? "above" : ""}`} aria-label={label}>{children}</div>;
}
