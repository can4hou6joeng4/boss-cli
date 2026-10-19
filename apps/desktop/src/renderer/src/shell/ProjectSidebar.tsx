import { useState } from "react";
import { IconNewChat, IconSearch, IconFolder, IconChevronDown, IconChevronRight, IconMore, IconNotification, IconPlus, IconSettings, IconHistory, IconCopy, IconEdit } from "../components/Icons";
import { Popover } from "../components/Popover";
import type { ProjectFolder, SessionItem } from "../data/mockData";
interface Props {
  isOpen: boolean; folders: ProjectFolder[]; activeSessionId: string | null; isHomeView: boolean; pinned: string[];
  onSelectSession: (session: SessionItem) => void; onNewTask: () => void; onSearch: () => void;
  onOpenSettings: () => void; onRecents: () => void; onNewProject: () => void; onNotifications: () => void;
  onRename: (session: SessionItem) => void; onPin: (id: string) => void; onHide: (id: string) => void;
}
export function ProjectSidebar(props: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [context, setContext] = useState<string | null>(null);
  const [brandMenu, setBrandMenu] = useState(false);
  const all = props.folders.flatMap(folder => folder.sessions);
  const sessionRow = (session: SessionItem, scope: string) => <div className={`sidebar-session ${session.id === props.activeSessionId && !props.isHomeView ? "selected" : ""}`} key={session.id}>
    <button className="session-select" onClick={() => props.onSelectSession(session)} title={session.title}><span className={`session-state ${session.status === "running" ? "running" : ""}`} /><span>{session.title}</span></button>
    <div className="popover-anchor">
      <button className="session-overflow titlebar-btn" aria-label={`会话选项：${session.title}`} aria-expanded={context === scope + session.id} onClick={() => setContext(context === scope + session.id ? null : scope + session.id)}><IconMore size={15} /></button>
      <Popover open={context === scope + session.id} onClose={() => setContext(null)} align="right">
        <button onClick={() => { props.onPin(session.id); setContext(null); }}><IconPlus />{props.pinned.includes(session.id) ? "取消置顶" : "置顶聊天"}</button>
        <button onClick={() => { props.onRename(session); setContext(null); }}><IconEdit />更改显示名称</button>
        <button onClick={() => { void navigator.clipboard?.writeText(session.id); setContext(null); }}><IconCopy />复制会话 ID</button>
        <div className="menu-divider" /><button onClick={() => { props.onHide(session.id); setContext(null); }}>在侧栏隐藏<span className="menu-shortcut">可从最近恢复</span></button>
      </Popover>
    </div>
  </div>;
  return <aside className={`project-sidebar ${props.isOpen ? "" : "is-collapsed"}`} aria-label="项目与聊天" aria-hidden={!props.isOpen}>
    <div className="project-sidebar-header">
      <div className="popover-anchor">
        <button className="workspace-brand" onClick={() => setBrandMenu(!brandMenu)} aria-expanded={brandMenu}>BOSS-CLI<IconChevronDown size={12} /></button>
        <Popover open={brandMenu} onClose={() => setBrandMenu(false)}>
          <div className="menu-label">本地工作区</div><button onClick={() => { props.onNewTask(); setBrandMenu(false); }}><IconNewChat />新聊天</button>
          <button onClick={() => { props.onOpenSettings(); setBrandMenu(false); }}><IconSettings />设置<span className="menu-shortcut">⌘,</span></button>
        </Popover>
      </div>
      <div className="sidebar-header-actions">
        <button className="titlebar-btn" onClick={props.onNotifications} aria-label="通知" title="通知"><IconNotification size={16} /></button>
        <button className="titlebar-btn" onClick={props.onSearch} aria-label="搜索聊天" title="搜索聊天 · ⌘K"><IconSearch size={16} /></button>
      </div>
    </div>
    <button className="sidebar-new-chat" onClick={props.onNewTask}><IconNewChat size={17} /><span>新聊天</span><kbd>⌘N</kbd></button>
    <div className="sidebar-scroll">
      {props.pinned.length > 0 && <section className="sidebar-section"><h2>已置顶</h2>{all.filter(session => props.pinned.includes(session.id)).map(session => sessionRow(session, "pinned-"))}</section>}
      <section className="sidebar-section"><div className="sidebar-section-heading"><h2>项目</h2><button className="titlebar-btn" onClick={props.onNewProject} aria-label="新建项目" title="新建项目分组"><IconPlus size={14} /></button></div>
        {props.folders.map(folder => <div className="sidebar-project" key={folder.id}>
          <button className="sidebar-folder" onClick={() => setCollapsed(prev => ({ ...prev, [folder.id]: !(prev[folder.id] ?? false) }))} aria-expanded={!(collapsed[folder.id] ?? false)}>
            <span className="folder-chevron">{collapsed[folder.id] ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}</span><IconFolder size={16} /><span>{folder.name}</span><span className="folder-count">{folder.sessions.length || ""}</span>
          </button>
          {!collapsed[folder.id] && <div className="sidebar-session-list">{folder.sessions.map(session => sessionRow(session, folder.id + "-"))}{!folder.sessions.length && <span className="empty-folder-note">暂无聊天</span>}</div>}
        </div>)}
      </section>
      <button className="sidebar-recents" onClick={props.onRecents}><span>最近</span><IconChevronRight size={13} /></button>
    </div>
    <button className="sidebar-footer-link" onClick={props.onRecents}><IconHistory size={14} /><span>查看所有聊天</span><kbd>⌘K</kbd></button>
  </aside>;
}
