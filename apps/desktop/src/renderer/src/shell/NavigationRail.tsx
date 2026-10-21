import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent } from "react";
import { IconHome, IconHistory, IconFolder, IconMore, IconBranch, IconSparkles, IconChat, IconSettings, IconHelp, IconSun, IconMoon, IconChevronRight, IconCheck, IconPin, IconSliders, IconGrip, type IconProps } from "../components/Icons";
import { Popover } from "../components/Popover";
import { ModalSurface } from "../components/ModalSurface";
import type { SettingsSection } from "../components/SettingsDialog";
import "../styles/navigation-menus.css";

export type WorkspacePage = "home" | "recents" | "library" | "skills";
type Destination = "sidechat" | "recents" | "library" | "cockpit" | "skills";
interface Props {
  page: WorkspacePage; isDark: boolean; harnessUp: boolean;
  onToggleTheme: () => void; onNavigate: (page: WorkspacePage) => void;
  onOpenSettings: (section?: SettingsSection) => void; onOpenShortcuts: () => void;
  onOpenCockpit: () => void; onOpenSideChat: () => void;
}
const ITEMS: Array<{ id: Destination; title: string; icon: ComponentType<IconProps>; page?: WorkspacePage; secondary?: boolean; shortcut?: string }> = [
  { id: "sidechat", title: "快速提问", icon: IconChat, shortcut: "⌘;" },
  { id: "recents", title: "最近聊天", icon: IconHistory, page: "recents" },
  { id: "library", title: "资料库", icon: IconFolder, page: "library" },
  { id: "cockpit", title: "招聘驾驶舱", icon: IconBranch, secondary: true, shortcut: "⌘⇧K" },
  { id: "skills", title: "技能与工具", icon: IconSparkles, page: "skills", secondary: true },
];
const DEFAULT_ORDER = ITEMS.map(item => item.id);
type Point = { x: number; y: number };
function inRect(point: Point, rect: DOMRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}
function inTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  const cross = (p: Point, start: Point, end: Point): number => (p.x - end.x) * (start.y - end.y) - (start.x - end.x) * (p.y - end.y);
  const values = [cross(point, a, b), cross(point, b, c), cross(point, c, a)];
  return !(values.some(value => value < 0) && values.some(value => value > 0));
}
function readLayout(): { order: Destination[]; pinned: Destination[] } {
  try {
    const saved = JSON.parse(localStorage.getItem("boss-cli.ui.navigation") ?? "null");
    const valid = (id: unknown): id is Destination => DEFAULT_ORDER.includes(id as Destination);
    if (saved && Array.isArray(saved.order) && Array.isArray(saved.pinned)) return {
      order: [...new Set<Destination>(saved.order.filter(valid)), ...DEFAULT_ORDER.filter(id => !saved.order.includes(id))],
      pinned: [...new Set<Destination>(saved.pinned.filter(valid))],
    };
  } catch { /* A missing preference uses the default navigation. */ }
  return { order: DEFAULT_ORDER, pinned: DEFAULT_ORDER };
}
export function NavigationRail(props: Props) {
  const [layout, setLayout] = useState(readLayout);
  const [menu, setMenu] = useState<"explore" | "profile" | "context" | null>(null);
  const [profileView, setProfileView] = useState<"main" | "appearance" | "help">("main");
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number }>();
  const [customize, setCustomize] = useState(false), [help, setHelp] = useState(false);
  const [dragged, setDragged] = useState<Destination | null>(null);
  const [grabbed, setGrabbed] = useState<Destination | null>(null), [reorderStatus, setReorderStatus] = useState("");
  const reorderSnapshot = useRef<{ id: Destination; order: Destination[] } | null>(null);
  const restoreReorderFocus = useRef<Destination | null>(null);
  const reorderHandles = useRef(new Map<Destination, HTMLButtonElement>());
  const reorderHintId = useId();
  const moreRef = useRef<HTMLButtonElement>(null), exploreRef = useRef<HTMLDivElement | null>(null);
  const setExploreRef = useCallback((element: HTMLDivElement | null) => { exploreRef.current = element; }, []);
  const [exploreFocus, setExploreFocus] = useState<"first" | "last" | false>("first");
  const exploreMode = useRef<"hover" | "click" | "keyboard">("click");
  const menuState = useRef(menu); menuState.current = menu;
  const openTimer = useRef<number>(), closeTimer = useRef<number>();
  const moreHovered = useRef(false), suppressHover = useRef(false);
  const corridor = useRef<{ origin: Point; target: "trigger" | "surface"; expires: number } | null>(null);
  const clearHoverTimers = useCallback(() => {
    window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current);
    openTimer.current = undefined; closeTimer.current = undefined; corridor.current = null;
  }, []);
  const closeExplore = useCallback(() => {
    clearHoverTimers(); suppressHover.current = true;
    setMenu(current => current === "explore" ? null : current);
  }, [clearHoverTimers]);
  const scheduleHoverClose = useCallback((delay: number) => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(closeExplore, delay);
  }, [closeExplore]);
  const leaveExplore = (event: PointerEvent<HTMLElement>, target: "trigger" | "surface") => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(openTimer.current); openTimer.current = undefined;
    if (menuState.current !== "explore" || exploreMode.current !== "hover") return;
    const destination = target === "surface" ? exploreRef.current : moreRef.current;
    if (event.relatedTarget instanceof Node && destination?.contains(event.relatedTarget)) { clearHoverTimers(); return; }
    const sourceRect = event.currentTarget.getBoundingClientRect(), destinationRect = destination?.getBoundingClientRect();
    const movingRight = destinationRect && destinationRect.left + destinationRect.right > sourceRect.left + sourceRect.right;
    const facingEdge = destinationRect && (movingRight ? event.clientX >= sourceRect.right - 3 : event.clientX <= sourceRect.left + 3);
    corridor.current = facingEdge ? { origin: { x: event.clientX, y: event.clientY }, target, expires: Date.now() + 1000 } : null;
    scheduleHoverClose(100);
  };
  const ordered = layout.order.map(id => ITEMS.find(item => item.id === id)!);
  const act = (id: Destination) => {
    setMenu(null);
    if (id === "sidechat") props.onOpenSideChat();
    else if (id === "cockpit") props.onOpenCockpit();
    else props.onNavigate(id);
  };
  const pin = (id: Destination) => setLayout(prev => ({ ...prev, pinned: prev.pinned.includes(id) ? prev.pinned.filter(item => item !== id) : [...prev.pinned, id] }));
  const move = (id: Destination, offset: number) => setLayout(prev => {
    const secondary = Boolean(ITEMS.find(item => item.id === id)?.secondary);
    const group = prev.order.filter(key => Boolean(ITEMS.find(item => item.id === key)?.secondary) === secondary);
    const adjacent = group[group.indexOf(id) + offset];
    if (!adjacent) return prev;
    const next = [...prev.order], from = next.indexOf(id), to = next.indexOf(adjacent);
    [next[from], next[to]] = [next[to]!, next[from]!];
    return { ...prev, order: next };
  });
  const finishReorder = () => {
    const picked = reorderSnapshot.current;
    reorderSnapshot.current = null; setGrabbed(null);
    if (picked) setReorderStatus(`已放下${ITEMS.find(item => item.id === picked.id)?.title}，顺序已保存。`);
  };
  const pickReorder = (id: Destination) => {
    if (reorderSnapshot.current?.id === id) { finishReorder(); return; }
    reorderSnapshot.current = { id, order: [...layout.order] }; setGrabbed(id);
    setReorderStatus(`已拿起${ITEMS.find(item => item.id === id)?.title}。上下键排序，空格或回车放下，Esc 取消。`);
  };
  const moveGrabbed = (id: Destination, offset: number) => {
    const rows = ordered.filter(item => Boolean(item.secondary) === Boolean(ITEMS.find(item => item.id === id)?.secondary));
    const index = rows.findIndex(item => item.id === id), next = index + offset;
    if (next < 0 || next >= rows.length) { setReorderStatus(`已到${offset < 0 ? "本组首位" : "本组末位"}，不能跨组移动。`); return; }
    move(id, offset);
    setReorderStatus(`${ITEMS.find(item => item.id === id)?.title}，本组第 ${next + 1} 项，共 ${rows.length} 项。`);
  };
  const openSettings = (section?: SettingsSection) => { setMenu(null); props.onOpenSettings(section); };
  const openCustomize = () => { clearHoverTimers(); setMenu(null); setReorderStatus(""); setCustomize(true); };
  const closeCustomize = () => { finishReorder(); setCustomize(false); };
  useEffect(() => {
    try { localStorage.setItem("boss-cli.ui.navigation", JSON.stringify(layout)); } catch { /* Preferences are optional. */ }
  }, [layout]);
  useLayoutEffect(() => {
    const target = grabbed ?? restoreReorderFocus.current;
    if (target) reorderHandles.current.get(target)?.focus({ preventScroll: true });
    restoreReorderFocus.current = null;
  }, [grabbed, layout.order]);
  useEffect(() => {
    const pointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== "mouse" || menuState.current !== "explore" || exploreMode.current !== "hover") return;
      const point = { x: event.clientX, y: event.clientY };
      if ([moreRef.current, exploreRef.current].some(element => element && inRect(point, element.getBoundingClientRect()))) { clearHoverTimers(); return; }
      const active = corridor.current;
      const destination = active?.target === "surface" ? exploreRef.current : moreRef.current;
      if (active && destination && Date.now() < active.expires) {
        const rect = destination.getBoundingClientRect(), sourceIsLeft = active.origin.x < (rect.left + rect.right) / 2;
        const edge = sourceIsLeft ? rect.left + 5 : rect.right - 5;
        if (inTriangle(point, active.origin, { x: edge, y: rect.top - 8 }, { x: edge, y: rect.bottom + 8 })) {
          scheduleHoverClose(active.expires - Date.now()); return;
        }
      }
      if (active) { corridor.current = null; scheduleHoverClose(100); return; }
      if (!closeTimer.current) scheduleHoverClose(100);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const snapshot = reorderSnapshot.current;
      if (snapshot && event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        restoreReorderFocus.current = snapshot.id;
        reorderSnapshot.current = null; setGrabbed(null);
        setLayout(previous => ({ ...previous, order: snapshot.order }));
        setReorderStatus("已取消排序，恢复拿起前的顺序。");
        return;
      }
      if (menuState.current === "explore" && event.target instanceof Node
        && (moreRef.current?.contains(event.target) || exploreRef.current?.contains(event.target))) {
        exploreMode.current = "keyboard"; clearHoverTimers();
      }
    };
    document.addEventListener("pointermove", pointerMove);
    window.addEventListener("keydown", keyboard, true);
    return () => { clearHoverTimers(); document.removeEventListener("pointermove", pointerMove); window.removeEventListener("keydown", keyboard, true); };
  }, [clearHoverTimers, scheduleHoverClose]);
  useEffect(() => { if (menu !== "explore") clearHoverTimers(); }, [menu, clearHoverTimers]);
  const railItem = (item: typeof ITEMS[number]) => <button key={item.id} className={`rail-button ${item.page === props.page ? "selected" : ""}`} onClick={() => act(item.id)} aria-label={item.title} aria-current={item.page === props.page ? "page" : undefined} title={item.title + (item.shortcut ? " · " + item.shortcut : "")}><item.icon size={20} /></button>;
  return <>
    <nav className="navigation-rail popover-anchor" aria-label="快捷导航" onContextMenu={event => {
      event.preventDefault(); (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.focus();
      setContextPoint({ x: event.clientX, y: event.clientY }); setMenu("context");
    }}>
      <div className="rail-items">
        <button className={`rail-button ${props.page === "home" ? "selected" : ""}`} onClick={() => { setMenu(null); props.onNavigate("home"); }} aria-label="主页" aria-current={props.page === "home" ? "page" : undefined} title="主页"><IconHome size={20} /></button>
        {ordered.filter(item => !item.secondary && layout.pinned.includes(item.id)).map(railItem)}
        <div className="popover-anchor">
          <button ref={moreRef} className={`rail-button ${menu === "explore" ? "selected" : ""}`} onClick={() => {
            clearHoverTimers(); suppressHover.current = true;
            if (menu === "explore" && exploreMode.current !== "hover") { closeExplore(); return; }
            exploreMode.current = "click"; setExploreFocus("first"); setMenu("explore");
          }} onPointerEnter={event => {
            if (event.pointerType !== "mouse") return;
            const alreadyInside = moreHovered.current; moreHovered.current = true;
            if (!alreadyInside) suppressHover.current = false;
            clearHoverTimers();
            if (suppressHover.current || menuState.current !== null) return;
            openTimer.current = window.setTimeout(() => {
              openTimer.current = undefined;
              if (!moreHovered.current || suppressHover.current || menuState.current !== null || document.querySelector("[data-popover], [aria-modal='true']")) return;
              exploreMode.current = "hover"; setExploreFocus(false); setMenu("explore");
            }, 150);
          }} onPointerLeave={event => {
            if (event.pointerType !== "mouse") return;
            moreHovered.current = false;
            if (menuState.current !== "explore") suppressHover.current = false;
            leaveExplore(event, "surface");
          }} onKeyDown={event => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); clearHoverTimers();
            exploreMode.current = "keyboard"; suppressHover.current = true;
            setExploreFocus(event.key === "ArrowUp" ? "last" : "first"); setMenu("explore");
          }} aria-label="更多导航" aria-haspopup="menu" aria-expanded={menu === "explore"} title="更多"><IconMore size={20} /></button>
          <Popover open={menu === "explore"} onClose={closeExplore} side="right" label="探索" className="rail-explore-menu" initialFocus={exploreFocus} contentRef={setExploreRef}
            onPointerEnter={event => { if (event.pointerType === "mouse") clearHoverTimers(); }} onPointerLeave={event => leaveExplore(event, "trigger")}>
            <div className="menu-label">探索</div>
            {ITEMS.map(item => <div className="explore-menu-row" data-menu-row key={item.id} onPointerMove={event => {
              if (event.pointerType !== "mouse" || (!event.movementX && !event.movementY) || event.currentTarget.contains(document.activeElement)) return;
              event.currentTarget.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
            }}>
              <button role="menuitem" onClick={() => act(item.id)} aria-current={item.page === props.page ? "page" : undefined}><item.icon size={17} /><span>{item.title}</span>{item.page === props.page && <IconCheck size={14} />}</button>
              <button role="menuitemcheckbox" data-menu-keep-open aria-checked={layout.pinned.includes(item.id)} className={`explore-pin ${layout.pinned.includes(item.id) ? "is-pinned" : ""}`} aria-label={`${layout.pinned.includes(item.id) ? "从导航移除" : "固定到导航"}：${item.title}`} title={layout.pinned.includes(item.id) ? "从导航移除" : "固定到导航"} onClick={() => pin(item.id)}><IconPin size={15} /></button>
            </div>)}
          </Popover>
        </div>
        {ordered.some(item => item.secondary && layout.pinned.includes(item.id)) && <div className="rail-divider" />}
        {ordered.filter(item => item.secondary && layout.pinned.includes(item.id)).map(railItem)}
      </div>
      <div className="popover-anchor">
        <button className="rail-avatar" onClick={() => { setProfileView("main"); setMenu(menu === "profile" ? null : "profile"); }} aria-label="打开个人菜单" aria-haspopup="menu" aria-expanded={menu === "profile"} title="本地工作区">BO</button>
        <Popover open={menu === "profile"} onClose={() => setMenu(null)} side="right" align="right" label="个人菜单" className="profile-menu">
          {profileView === "main" ? <>
            <div className="profile-menu-identity"><span className="profile-avatar">BO</span><span><strong>本地工作区</strong><small>{props.harnessUp ? "已连接招聘 Harness" : "BOSS-CLI"}</small></span></div>
            <div className="menu-divider" />
            <button onClick={() => openSettings()}><IconSettings />设置<span className="menu-shortcut">⌘,</span></button>
            <button onClick={() => { setMenu(null); props.onOpenShortcuts(); }}><span className="menu-text-icon">⌘</span>键盘快捷键<span className="menu-shortcut">⌘/</span></button>
            <button data-menu-keep-open aria-haspopup="menu" onClick={() => setProfileView("appearance")}><IconSun />外观<IconChevronRight className="menu-check" /></button>
            <button onClick={openCustomize}><IconSliders />自定导航栏</button>
            <div className="menu-divider" />
            <button data-menu-keep-open aria-haspopup="menu" onClick={() => setProfileView("help")}><IconHelp />帮助<IconChevronRight className="menu-check" /></button>
            <button onClick={() => openSettings("about")}><span className="menu-text-icon">ⓘ</span>关于 BOSS-CLI</button>
          </> : profileView === "appearance" ? <>
            <button className="menu-back" data-menu-keep-open onClick={() => setProfileView("main")}><IconChevronRight className="rotate-back" />外观</button><div className="menu-divider" />
            <button role="menuitemradio" aria-checked={!props.isDark} onClick={() => { if (props.isDark) props.onToggleTheme(); setMenu(null); }}><IconSun />浅色{!props.isDark && <IconCheck className="menu-check" />}</button>
            <button role="menuitemradio" aria-checked={props.isDark} onClick={() => { if (!props.isDark) props.onToggleTheme(); setMenu(null); }}><IconMoon />深色{props.isDark && <IconCheck className="menu-check" />}</button>
            <div className="menu-divider" /><button onClick={() => openSettings("appearance")}><IconSliders />外观设置</button>
          </> : <>
            <button className="menu-back" data-menu-keep-open onClick={() => setProfileView("main")}><IconChevronRight className="rotate-back" />帮助</button><div className="menu-divider" />
            <button onClick={() => { setMenu(null); setHelp(true); }}><IconHelp />使用说明</button>
            <button onClick={() => { setMenu(null); props.onOpenShortcuts(); }}><span className="menu-text-icon">⌘</span>键盘快捷键</button>
            <button onClick={() => openSettings("connections")}><IconSettings />检查模型与连接</button>
          </>}
        </Popover>
      </div>
      <Popover open={menu === "context"} onClose={() => setMenu(null)} anchorPoint={contextPoint} label="导航栏选项">
        <button onClick={openCustomize}><IconSliders />自定导航栏</button>
        <button onClick={() => { setLayout({ order: DEFAULT_ORDER, pinned: DEFAULT_ORDER }); setMenu(null); }}><IconHistory />重置导航栏</button>
      </Popover>
    </nav>
    {customize && <ModalSurface title="自定导航栏" onClose={closeCustomize} className="navigation-customize-dialog">
      <div className="navigation-customize-content"><p>固定常用入口，拖动调整顺序。<span id={reorderHintId} className="navigation-reorder-hint">排序柄支持空格或回车拿起，上下键移动，Esc 取消。</span></p>
        <div className="navigation-customize-fixed"><IconHome size={18} /><span>主页</span><small>始终显示</small></div>
        {([false, true] as const).map(secondary => <section key={String(secondary)}><h3>{secondary ? "招聘扩展" : "快捷入口"}</h3>{ordered.filter(item => Boolean(item.secondary) === secondary).map((item, index, rows) => <div className={`navigation-customize-row ${dragged === item.id ? "is-dragging" : ""} ${grabbed === item.id ? "is-keyboard-dragging" : ""}`} key={item.id} onDragOver={event => { if (dragged && Boolean(ITEMS.find(row => row.id === dragged)?.secondary) === secondary) event.preventDefault(); }} onDrop={event => {
          event.preventDefault(); if (!dragged || dragged === item.id || Boolean(ITEMS.find(row => row.id === dragged)?.secondary) !== secondary) return;
          setLayout(prev => { const next = prev.order.filter(id => id !== dragged); next.splice(next.indexOf(item.id), 0, dragged); return { ...prev, order: next }; }); setDragged(null);
        }}>
          <item.icon size={18} /><span>{item.title}</span>
          <button className="navigation-visibility-toggle" role="switch" aria-checked={layout.pinned.includes(item.id)} aria-label={`显示${item.title}`} onClick={() => pin(item.id)} />
          <button className="titlebar-btn" aria-label={`上移${item.title}`} disabled={index === 0} onClick={() => move(item.id, -1)}><IconChevronRight className="rotate-up" size={13} /></button>
          <button className="titlebar-btn" aria-label={`下移${item.title}`} disabled={index === rows.length - 1} onClick={() => move(item.id, 1)}><IconChevronRight className="rotate-down" size={13} /></button>
          <button type="button" className="navigation-drag-handle" ref={element => { if (element) reorderHandles.current.set(item.id, element); else reorderHandles.current.delete(item.id); }} draggable
            aria-label={`排序${item.title}`} aria-pressed={grabbed === item.id} aria-describedby={reorderHintId} onClick={() => pickReorder(item.id)}
            onKeyDown={event => {
              if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!event.repeat) pickReorder(item.id); }
              else if (reorderSnapshot.current?.id === item.id && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); event.stopPropagation(); moveGrabbed(item.id, event.key === "ArrowUp" ? -1 : 1); }
            }} onDragStart={event => { finishReorder(); event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; setDragged(item.id); }} onDragEnd={() => setDragged(null)} title="拖动排序，或用键盘调整"><IconGrip size={16} /></button>
        </div>)}</section>)}
      </div><div className="navigation-reorder-status" role="status" aria-live="polite" aria-atomic="true">{reorderStatus}</div><div className="navigation-customize-footer"><button className="subtle-button" onClick={() => { finishReorder(); setLayout({ order: DEFAULT_ORDER, pinned: DEFAULT_ORDER }); setReorderStatus("已恢复默认导航。"); }}>恢复默认</button><button className="solid-button" onClick={closeCustomize}>完成</button></div>
    </ModalSurface>}
    {help && <ModalSurface title="使用 BOSS-CLI" onClose={() => setHelp(false)} className="workspace-help-dialog"><div className="workspace-help-content">
      <h3>从一个招聘任务开始</h3><p>在新聊天中描述岗位需求、候选人筛选目标或沟通草稿。选择项目后，该项目名称会作为上下文随消息提供。</p>
      <h3>按你的习惯组织工作区</h3><p>右键点击导航栏可自定入口。项目和聊天右侧的更多菜单支持命名、置顶和本地分组。</p>
      <h3>随时查看与控制任务</h3><p>运行中可使用输入框旁的停止按钮。需要对外沟通或投递时，在聊天中的确认卡片核对内容并作出决定。</p>
      <button className="subtle-button" onClick={() => { setHelp(false); props.onOpenShortcuts(); }}>查看键盘快捷键</button>
    </div></ModalSurface>}
  </>;
}
