import { useEffect, useState, type MouseEvent } from "react";
import { IconNewChat, IconSearch, IconFolder, IconChevronDown, IconChevronRight, IconMore, IconNotification, IconPlus, IconSettings, IconHistory, IconCopy, IconEdit, IconPin, IconCheck, IconSliders, IconClose } from "../components/Icons";
import { Popover } from "../components/Popover";
import type { ProjectFolder, SessionItem } from "../data/mockData";
import "../styles/sidebar-menus.css";

export interface SidebarPreferences { grouping: "project" | "list"; sort: "updated" | "name"; showRecent: boolean; }
interface Props {
  isOpen: boolean; folders: ProjectFolder[]; activeSessionId: string | null; isHomeView: boolean; pinned: string[];
  preferences: SidebarPreferences; onPreferencesChange: (value: SidebarPreferences) => void; localGroupIds: string[];
  onSelectSession: (session: SessionItem) => void; onNewTask: () => void; onSearch: () => void;
  onNewTaskInProject: (folder: ProjectFolder) => void;
  onOpenSettings: () => void; onRecents: () => void; onNewProject: () => void; onNotifications: () => void;
  onRename: (session: SessionItem) => void; onPin: (id: string) => void; onHide: (id: string) => void;
  onMoveSession: (id: string, projectId: string) => void;
  onRenameProject: (folder: ProjectFolder) => void; onRemoveProject: (folder: ProjectFolder) => void;
}
export function ProjectSidebar(props: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("boss-cli.ui.collapsedProjects") ?? "{}"); } catch { return {}; }
  });
  const [context, setContext] = useState<{ key: string; point?: { x: number; y: number } } | null>(null);
  const [view, setView] = useState<"main" | "move" | "copy">("main");
  const [notice, setNotice] = useState("");
  const { preferences } = props;
  const all = [...new Map(props.folders.flatMap(folder => folder.sessions).map(session => [session.id, session])).values()];
  const pinnedSessions = all.filter(session => props.pinned.includes(session.id));
  const sort = (sessions: SessionItem[]) => [...sessions].sort((a, b) => preferences.sort === "name"
    ? a.title.localeCompare(b.title, "zh-CN", { numeric: true })
    : a.updatedAt && b.updatedAt ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : 0);
  const toggle = (key: string) => { setView("main"); setContext(previous => previous?.key === key ? null : { key }); };
  const rightClick = (key: string, event: MouseEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    setView("main"); setContext({ key, point: { x: event.clientX, y: event.clientY } });
  };
  const close = () => setContext(null);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice("已复制"); }
    catch { setNotice("复制失败，请检查系统剪贴板权限"); }
    close();
  };
  useEffect(() => { try { localStorage.setItem("boss-cli.ui.collapsedProjects", JSON.stringify(collapsed)); } catch {} }, [collapsed]);
  useEffect(() => { if (!props.isOpen) close(); }, [props.isOpen]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);
  const sessionRow = (session: SessionItem, scope: string) => {
    const key = scope + session.id, selected = session.id === props.activeSessionId && !props.isHomeView;
    const projectId = props.folders.find(folder => folder.sessions.some(item => item.id === session.id))?.id;
    return <div className={"sidebar-session popover-anchor" + (selected ? " selected" : "")} key={session.id} onContextMenu={event => rightClick(key, event)}>
      <button className="session-select" onClick={() => props.onSelectSession(session)} title={session.title} aria-current={selected ? "page" : undefined}><span className={"session-state" + (session.status === "running" ? " running" : "")} /><span>{session.title}</span></button>
      <button className="session-overflow titlebar-btn" aria-label={"会话选项：" + session.title} aria-haspopup="menu" aria-expanded={context?.key === key} onClick={() => toggle(key)}><IconMore size={15} /></button>
      <Popover open={context?.key === key} onClose={close} align="right" anchorPoint={context?.key === key ? context.point : undefined} label="聊天选项" className="sidebar-context-menu">
        {view === "main" ? <>
          <button onClick={() => { props.onRename(session); close(); }}><IconEdit />重命名</button>
          <button onClick={() => { props.onPin(session.id); close(); }}><IconPin />{props.pinned.includes(session.id) ? "取消置顶" : "置顶聊天"}</button>
          <div className="menu-divider" />
          <button data-menu-keep-open aria-haspopup="menu" onClick={() => setView("move")}><IconFolder />移至项目<IconChevronRight className="menu-check" /></button>
          <button data-menu-keep-open aria-haspopup="menu" onClick={() => setView("copy")}><IconCopy />复制<IconChevronRight className="menu-check" /></button>
          <div className="menu-divider" />
          <button onClick={() => { props.onHide(session.id); close(); }}><IconClose />在侧栏隐藏</button>
        </> : view === "move" ? <>
          <button className="menu-back" data-menu-keep-open onClick={() => setView("main")}><IconChevronRight className="rotate-back" />移至项目</button>
          <div className="menu-divider" />
          {props.folders.map(folder => <button role="menuitemradio" aria-checked={projectId === folder.id} key={folder.id} onClick={() => { props.onMoveSession(session.id, folder.id); close(); }}><IconFolder /><span>{folder.name}</span>{projectId === folder.id && <IconCheck className="menu-check" />}</button>)}
          <div className="menu-note">分组保存在此设备上。</div>
        </> : <>
          <button className="menu-back" data-menu-keep-open onClick={() => setView("main")}><IconChevronRight className="rotate-back" />复制</button>
          <div className="menu-divider" />
          <button onClick={() => { void copy(session.title); }}><IconCopy />聊天标题</button>
          <button onClick={() => { void copy(session.id); }}><IconCopy />会话 ID</button>
        </>}
      </Popover>
    </div>;
  };
  const projectRow = (folder: ProjectFolder) => {
    const key = "project-" + folder.id, isCollapsed = collapsed[folder.id] ?? false;
    return <div className="sidebar-project" key={folder.id}>
      <div className="sidebar-project-row popover-anchor" onContextMenu={event => rightClick(key, event)}>
        <button className="sidebar-folder" onClick={() => setCollapsed(prev => ({ ...prev, [folder.id]: !isCollapsed }))} aria-expanded={!isCollapsed}>
          <span className="folder-chevron">{isCollapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}</span><IconFolder size={16} /><span>{folder.name}</span><span className="folder-count">{folder.sessions.length || ""}</span>
        </button>
        <button className="project-overflow titlebar-btn" aria-label={"项目选项：" + folder.name} aria-haspopup="menu" aria-expanded={context?.key === key} onClick={() => toggle(key)}><IconMore size={15} /></button>
        <Popover open={context?.key === key} onClose={close} align="right" anchorPoint={context?.key === key ? context.point : undefined} label="项目选项" className="sidebar-context-menu">
          <div className="menu-label">{folder.name}</div>
          <button onClick={() => { props.onNewTaskInProject(folder); close(); }}><IconNewChat />在项目中新聊天</button>
          <button onClick={() => { props.onRenameProject(folder); close(); }}><IconEdit />更改项目显示名称</button>
          <button onClick={() => { setCollapsed(prev => ({ ...prev, [folder.id]: !isCollapsed })); close(); }}><IconChevronDown />{isCollapsed ? "展开项目" : "折叠项目"}</button>
          <div className="menu-divider" />
          <button onClick={() => { void copy(folder.name); }}><IconCopy />复制项目名称</button>
          {props.localGroupIds.includes(folder.id) && <><div className="menu-divider" /><button onClick={() => { props.onRemoveProject(folder); close(); }}><IconClose />移除本地分组</button></>}
        </Popover>
      </div>
      {!isCollapsed && <div className="sidebar-session-list">{sort(folder.sessions).map(session => sessionRow(session, folder.id + "-"))}{!folder.sessions.length && <span className="empty-folder-note">暂无聊天</span>}</div>}
    </div>;
  };
  return <aside className={"project-sidebar" + (props.isOpen ? "" : " is-collapsed")} aria-label="项目与聊天" aria-hidden={!props.isOpen} onContextMenu={event => rightClick("preferences", event)}>
    <div className="project-sidebar-header">
      <div className="popover-anchor">
        <button className="workspace-brand" onClick={() => toggle("brand")} aria-haspopup="menu" aria-expanded={context?.key === "brand"}>BOSS-CLI<IconChevronDown size={12} /></button>
        <Popover open={context?.key === "brand"} onClose={close} label="工作区选项">
          <div className="menu-label">招聘工作台</div>
          <button onClick={() => { props.onNewTask(); close(); }}><IconNewChat />新聊天<span className="menu-shortcut">⌘N</span></button>
          <button onClick={() => { props.onNewProject(); close(); }}><IconFolder />新建项目</button>
          <div className="menu-divider" />
          <button onClick={() => { props.onOpenSettings(); close(); }}><IconSettings />设置<span className="menu-shortcut">⌘,</span></button>
        </Popover>
      </div>
      <div className="sidebar-header-actions">
        <button className="titlebar-btn" onClick={props.onNotifications} aria-label="通知" title="通知"><IconNotification size={16} /></button>
        <button className="titlebar-btn" onClick={props.onSearch} aria-label="搜索聊天" title="搜索聊天 · ⌘K"><IconSearch size={16} /></button>
      </div>
    </div>
    <button className="sidebar-new-chat" onClick={props.onNewTask}><IconNewChat size={17} /><span>新聊天</span><kbd>⌘N</kbd></button>
    <div className="sidebar-scroll">
      {pinnedSessions.length > 0 && <section className="sidebar-section"><h2>已置顶</h2>{sort(pinnedSessions).map(session => sessionRow(session, "pinned-"))}</section>}
      <section className="sidebar-section">
        <div className="sidebar-section-heading"><h2>{preferences.grouping === "project" ? "项目" : "聊天"}</h2><div className="sidebar-section-actions">
          <div className="popover-anchor">
            <button className="titlebar-btn sidebar-preferences-trigger" aria-label="侧栏显示选项" aria-haspopup="menu" aria-expanded={context?.key === "preferences"} onClick={() => toggle("preferences")}><IconSliders size={14} /></button>
            <Popover open={context?.key === "preferences"} onClose={close} align="right" anchorPoint={context?.key === "preferences" ? context.point : undefined} label="侧栏显示选项">
              <div className="menu-label">分组方式</div>
              {(["project", "list"] as const).map(grouping => <button role="menuitemradio" aria-checked={preferences.grouping === grouping} key={grouping} onClick={() => props.onPreferencesChange({ ...preferences, grouping })}><IconFolder />{grouping === "project" ? "按项目" : "所有聊天"}{preferences.grouping === grouping && <IconCheck className="menu-check" />}</button>)}
              <div className="menu-divider" /><div className="menu-label">排序方式</div>
              {(["updated", "name"] as const).map(sort => <button role="menuitemradio" aria-checked={preferences.sort === sort} key={sort} onClick={() => props.onPreferencesChange({ ...preferences, sort })}>{sort === "updated" ? <IconHistory /> : <IconEdit />}{sort === "updated" ? "最近更新" : "名称"}{preferences.sort === sort && <IconCheck className="menu-check" />}</button>)}
              <div className="menu-divider" />
              <button role="menuitemcheckbox" aria-checked={preferences.showRecent} onClick={() => props.onPreferencesChange({ ...preferences, showRecent: !preferences.showRecent })}><IconHistory />显示最近聊天{preferences.showRecent && <IconCheck className="menu-check" />}</button>
            </Popover>
          </div>
          <button className="titlebar-btn" onClick={props.onNewProject} aria-label="新建项目" title="新建项目分组"><IconPlus size={14} /></button>
        </div></div>
        {preferences.grouping === "project" ? [...props.folders].sort((a, b) => preferences.sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : 0).map(projectRow) : sort(all).map(session => sessionRow(session, "all-"))}
        {!all.length && !props.folders.length && <span className="empty-folder-note">创建一个项目，开始招聘任务</span>}
      </section>
      {preferences.showRecent && <section className="sidebar-section sidebar-recent-section"><button className="sidebar-recents" onClick={props.onRecents}><span>最近</span><IconChevronRight size={13} /></button>{sort(all.filter(session => !props.pinned.includes(session.id))).slice(0, 6).map(session => sessionRow(session, "recent-"))}</section>}
    </div>
    <button className="sidebar-footer-link" onClick={props.onRecents}><IconHistory size={14} /><span>查看所有聊天</span></button>
    {notice && <div className="sidebar-feedback" role="status">{notice}</div>}
  </aside>;
}
