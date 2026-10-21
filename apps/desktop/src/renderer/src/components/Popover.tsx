import { useCallback, useId, useLayoutEffect, useRef, useState, type PointerEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "../styles/popover.css";

type Side = "bottom" | "top" | "left" | "right";
type CloseReason = "outside" | "escape" | "tab" | "selection" | "switch";
interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  above?: boolean;
  label?: string;
  className?: string;
  side?: Side;
  anchorPoint?: { x: number; y: number };
  initialFocus?: "first" | "last" | false;
  contentRef?: (element: HTMLDivElement | null) => void;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
}
interface Position { left: number; top: number; maxHeight: number; side: Side; }

const MENU_ITEMS = "button, a[href], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']";
const FOCUSABLE = "button, a[href], input, textarea, select, [tabindex]";
let activePopover: { id: string; close: () => void } | null = null;

function available(element: HTMLElement): boolean {
  return !element.matches(":disabled, [aria-disabled='true']") && !element.closest("[inert]")
    && element.getClientRects().length > 0;
}

function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']");
}

function focusFirst(menu: HTMLElement, edge: "first" | "last" = "first"): void {
  if (edge === "last") {
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-menu-row]")];
    const lastRowItem = rows.reverse().map(row => [...row.querySelectorAll<HTMLElement>(MENU_ITEMS)].find(available)).find(Boolean);
    (lastRowItem ?? [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].reverse().find(available) ?? menu).focus({ preventScroll: true });
    return;
  }
  const preferred = [...menu.querySelectorAll<HTMLElement>("[data-menu-autofocus]")].find(available)
    ?? [...menu.querySelectorAll<HTMLElement>("input, textarea, select")].find(available)
    ?? [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].find(available)
    ?? menu;
  preferred.focus({ preventScroll: true });
}

export function Popover({ open, onClose, children, align = "left", above = false, label = "操作菜单", className = "", side, anchorPoint,
  initialFocus: focusOnOpen = "first", contentRef, onPointerEnter, onPointerLeave }: Props) {
  // This marker stays with the trigger while the menu escapes scroll containers.
  const markerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setMenuRef = useCallback((element: HTMLDivElement | null) => { menuRef.current = element; contentRef?.(element); }, [contentRef]);
  const close = useRef(onClose); close.current = onClose;
  const options = useRef({ align, above, side, anchorPoint, focusOnOpen }); options.current = { align, above, side, anchorPoint, focusOnOpen };
  const dismissRef = useRef<((reason: CloseReason) => void) | null>(null);
  const repositionRef = useRef<(() => void) | null>(null);
  const restoreFrame = useRef<number>();
  const initialFocus = useRef(false);
  const lastFocusMode = useRef(focusOnOpen);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) { setPortalHost(null); setPosition(null); return; }
    // A portal in the current modal remains inside its inert boundary and focus trap.
    setPortalHost(markerRef.current?.closest<HTMLElement>("[aria-modal='true']") ?? document.body);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portalHost) return;
    const menu = menuRef.current;
    const anchor = markerRef.current?.closest<HTMLElement>(".popover-anchor") ?? markerRef.current?.parentElement;
    if (!menu?.isConnected || !anchor) return;
    if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trigger = anchor.querySelector<HTMLElement>(":scope > button, :scope > [aria-haspopup='menu']")
      ?? anchor.querySelector<HTMLElement>("button, [tabindex]");
    const triggerFocus = previousFocus && anchor.contains(previousFocus) ? previousFocus : trigger;
    const returnTarget = (): HTMLElement | null => options.current.focusOnOpen === false ? previousFocus ?? triggerFocus : triggerFocus;
    let reason: CloseReason | null = null;
    let dismissed = false;
    let frame = 0;
    initialFocus.current = options.current.focusOnOpen !== false;
    const dismiss = (nextReason: CloseReason): void => {
      if (dismissed) return;
      dismissed = true;
      reason = nextReason;
      // A dialog opened by a menu action should capture the durable trigger as
      // its return target, instead of the menu item that is about to disappear.
      const target = returnTarget();
      if ((nextReason === "selection" || nextReason === "escape") && menu.contains(document.activeElement)
        && target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
      close.current();
    };
    dismissRef.current = dismiss;
    activePopover?.id !== id && activePopover?.close();
    activePopover = { id, close: () => dismiss("switch") };

    const addedAttributes: Array<{ name: string; value: string }> = [];
    if (trigger) {
      for (const [name, value] of [["aria-haspopup", "menu"], ["aria-controls", id], ["aria-expanded", "true"]]) {
        if (name && value && !trigger.hasAttribute(name)) {
          trigger.setAttribute(name, value);
          addedAttributes.push({ name, value });
        }
      }
    }
    const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].filter(available);
    const decorateItems = (): void => {
      menu.querySelectorAll<HTMLElement>(MENU_ITEMS).forEach(item => {
        if (!item.hasAttribute("role")) item.setAttribute("role", "menuitem");
        if (item instanceof HTMLButtonElement && !item.hasAttribute("type")) item.type = "button";
        if (!item.hasAttribute("tabindex")) item.tabIndex = -1;
      });
    };

    const updatePosition = (): void => {
      if (!anchor.isConnected || !menu.isConnected) return;
      const viewport = window.visualViewport;
      const bounds = {
        left: (viewport?.offsetLeft ?? 0) + 8,
        top: (viewport?.offsetTop ?? 0) + 8,
        right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - 8,
        bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 8,
      };
      const current = options.current;
      const rect = current.anchorPoint
        ? { left: current.anchorPoint.x, right: current.anchorPoint.x, top: current.anchorPoint.y, bottom: current.anchorPoint.y }
        : anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      // A modal can establish a fixed containing block (e.g. during its entrance animation).
      const scaleX = menu.offsetWidth ? menuRect.width / menu.offsetWidth : 1;
      const scaleY = menu.offsetHeight ? menuRect.height / menu.offsetHeight : 1;
      const originX = menuRect.left - (parseFloat(menu.style.left) || 0) * scaleX;
      const originY = menuRect.top - (parseFloat(menu.style.top) || 0) * scaleY;
      const width = menuRect.width;
      const naturalHeight = Math.min((menu.scrollHeight + menu.offsetHeight - menu.clientHeight) * scaleY, bounds.bottom - bounds.top);
      const gap = current.anchorPoint ? 2 : 6;
      const space = { bottom: bounds.bottom - rect.bottom - gap, top: rect.top - bounds.top - gap, right: bounds.right - rect.right - gap, left: rect.left - bounds.left - gap };
      let resolvedSide: Side = current.side ?? (current.above ? "top" : "bottom");
      const opposite: Record<Side, Side> = { bottom: "top", top: "bottom", right: "left", left: "right" };
      const required = resolvedSide === "top" || resolvedSide === "bottom" ? naturalHeight : width;
      if (space[resolvedSide] < required && space[opposite[resolvedSide]] > space[resolvedSide]) resolvedSide = opposite[resolvedSide];
      const vertical = resolvedSide === "top" || resolvedSide === "bottom";
      const maxHeight = Math.max(1, Math.min(bounds.bottom - bounds.top, vertical ? Math.max(80, space[resolvedSide]) : bounds.bottom - bounds.top));
      const height = Math.min(naturalHeight, maxHeight);
      let left = current.align === "right" ? rect.right - width : rect.left;
      let top = resolvedSide === "top" ? rect.top - height - gap : rect.bottom + gap;
      if (!vertical) {
        left = resolvedSide === "left" ? rect.left - width - gap : rect.right + gap;
        top = current.align === "right" ? rect.bottom - height : rect.top;
      }
      left = Math.max(bounds.left, Math.min(left, bounds.right - width));
      top = Math.max(bounds.top, Math.min(top, bounds.bottom - height));
      const next = { left: (left - originX) / scaleX, top: (top - originY) / scaleY, maxHeight: maxHeight / scaleY, side: resolvedSide };
      setPosition(previous => previous && previous.side === next.side && Math.abs(previous.left - next.left) < .5 && Math.abs(previous.top - next.top) < .5 && Math.abs(previous.maxHeight - next.maxHeight) < .5 ? previous : next);
    };
    const schedulePosition = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    repositionRef.current = schedulePosition;
    decorateItems();
    updatePosition();

    const handlePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) dismiss("outside");
    };
    const handleFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) dismiss("outside");
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (dismissed || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !(event.target instanceof Node)) return;
      const inside = menu.contains(event.target) || anchor.contains(event.target);
      if (event.key === "Escape" && (inside || options.current.focusOnOpen === false)) {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss("escape"); return;
      }
      if (!inside) return;
      if (event.key === "Tab") {
        // Continue from the trigger's document order, rather than the body portal's order.
        const focusables = [...portalHost.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => available(element) && element.tabIndex >= 0 && !menu.contains(element));
        const returnFocus = returnTarget();
        const index = returnFocus ? focusables.indexOf(returnFocus) : -1;
        const nextIndex = index + (event.shiftKey ? -1 : 1);
        const next = portalHost === document.body ? focusables[nextIndex] : focusables[(nextIndex + focusables.length) % focusables.length];
        event.stopImmediatePropagation();
        dismiss("tab");
        if (next) { event.preventDefault(); next.focus({ preventScroll: true }); }
        else returnFocus?.focus({ preventScroll: true });
        return;
      }
      if (editable(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (focused && anchor.contains(focused) && !menu.contains(focused) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault(); event.stopImmediatePropagation(); focusFirst(menu, event.key === "ArrowUp" ? "last" : "first"); return;
      }
      const currentRow = focused?.closest<HTMLElement>("[data-menu-row]");
      if (currentRow && menu.contains(currentRow) && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        const rows = [...menu.querySelectorAll<HTMLElement>("[data-menu-row]")];
        const cells = (row: HTMLElement): HTMLElement[] => [...row.querySelectorAll<HTMLElement>(MENU_ITEMS)];
        const rowIndex = rows.indexOf(currentRow);
        const currentCells = cells(currentRow);
        const column = Math.max(0, currentCells.indexOf(focused!));
        let next: HTMLElement | undefined;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const direction = event.key === "ArrowRight" ? 1 : -1;
          for (let index = column + direction; index >= 0 && index < currentCells.length; index += direction) {
            if (available(currentCells[index]!)) { next = currentCells[index]; break; }
          }
        } else {
          const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
          const start = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : rowIndex + direction;
          for (let offset = 0; offset < rows.length; offset++) {
            const row = rows[(start + offset * direction + rows.length) % rows.length];
            const candidate = row ? cells(row)[column] : undefined;
            if (candidate && available(candidate)) { next = candidate; break; }
          }
        }
        event.preventDefault(); event.stopImmediatePropagation();
        next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const elements = items();
      if (!elements.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const index = elements.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? elements.length - 1
        : index < 0 ? (event.key === "ArrowUp" ? elements.length - 1 : 0)
        : (index + (event.key === "ArrowDown" ? 1 : -1) + elements.length) % elements.length;
      elements[nextIndex]?.focus({ preventScroll: true });
      elements[nextIndex]?.scrollIntoView({ block: "nearest" });
    };
    const observer = new ResizeObserver(schedulePosition);
    observer.observe(anchor); observer.observe(menu);
    const mutations = new MutationObserver(() => {
      decorateItems(); schedulePosition();
      // A flat submenu may replace the focused item without closing the surface.
      if (options.current.focusOnOpen !== false && document.activeElement === document.body) focusFirst(menu);
    });
    mutations.observe(menu, { childList: true, subtree: true });
    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("focusin", handleFocus);
    // Window capture precedes a containing modal's document-level Escape/Tab trap.
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("animationend", schedulePosition, true);
    window.addEventListener("transitionend", schedulePosition, true);
    window.visualViewport?.addEventListener("resize", schedulePosition);
    window.visualViewport?.addEventListener("scroll", schedulePosition);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect(); mutations.disconnect();
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("focusin", handleFocus);
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("animationend", schedulePosition, true);
      window.removeEventListener("transitionend", schedulePosition, true);
      window.visualViewport?.removeEventListener("resize", schedulePosition);
      window.visualViewport?.removeEventListener("scroll", schedulePosition);
      addedAttributes.forEach(({ name, value }) => { if (trigger?.getAttribute(name) === value) trigger.removeAttribute(name); });
      if (activePopover?.id === id) activePopover = null;
      dismissRef.current = null; repositionRef.current = null; initialFocus.current = false;
      if (reason === "outside" || reason === "tab" || reason === "switch") return;
      restoreFrame.current = requestAnimationFrame(() => {
        // Selection can open a dialog or focus the composer. Never steal that focus.
        const focused = document.activeElement;
        const returnFocus = returnTarget();
        if (activePopover || !returnFocus?.isConnected || returnFocus.closest("[inert]")) return;
        if (focused === document.body || focused === document.documentElement || (focused instanceof Node && menu.contains(focused))) returnFocus.focus({ preventScroll: true });
      });
    };
  }, [open, portalHost, id]);

  useLayoutEffect(() => { repositionRef.current?.(); }, [align, above, side, anchorPoint?.x, anchorPoint?.y]);
  useLayoutEffect(() => {
    if (!open || !position) return;
    const changed = lastFocusMode.current !== focusOnOpen;
    lastFocusMode.current = focusOnOpen;
    if (focusOnOpen === false || (!initialFocus.current && !changed)) return;
    const menu = menuRef.current;
    if (!menu) return;
    initialFocus.current = false;
    focusFirst(menu, focusOnOpen);
  }, [open, position, focusOnOpen]);

  return <>
    <span ref={markerRef} hidden aria-hidden="true" />
    {open && portalHost && createPortal(<div ref={setMenuRef} id={id} role="menu" tabIndex={-1} aria-label={label}
      data-popover="" data-side={position?.side ?? side ?? (above ? "top" : "bottom")}
      className={`ui-popover ui-popover-portal ${align === "right" ? "align-right" : ""} ${above ? "above" : ""} ${className}`}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: position?.maxHeight ?? "calc(100dvh - 16px)", visibility: position ? "visible" : "hidden" }}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}
      onClick={event => {
        const item = event.target instanceof Element ? event.target.closest<HTMLElement>(MENU_ITEMS) : null;
        if (!event.defaultPrevented && item && available(item) && !item.hasAttribute("data-menu-keep-open") && item.getAttribute("aria-haspopup") !== "menu") dismissRef.current?.("selection");
      }}>{children}</div>, portalHost)}
  </>;
}
