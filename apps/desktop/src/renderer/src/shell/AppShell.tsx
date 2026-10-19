import { useState, useEffect, useRef } from "react";
import { TitleBar } from "./TitleBar";
import { NavigationRail, type WorkspacePage } from "./NavigationRail";
import { ProjectSidebar } from "./ProjectSidebar";
import { HomeView } from "./HomeView";
import { ConversationArea } from "./ConversationArea";
import { RightPanel } from "./RightPanel";
import { WorkspacePages } from "./WorkspacePages";
import { SettingsDialog } from "../components/SettingsDialog";
import { SearchDialog } from "../components/SearchDialog";
import { ModalSurface } from "../components/ModalSurface";
import { IconNotification, IconCheck } from "../components/Icons";
import { type ProjectFolder, type SessionItem, type MessageItem, type ConversationMode } from "../data/mockData";
import { ClientMethods, type ToolDescriptor, type ToolListResponse } from "@boss-cli/protocol";

export interface AppShellProps {
  isDark: boolean; onToggleTheme: () => void; isSidebarOpen: boolean; onToggleSidebar: () => void;
  folders: ProjectFolder[]; activeSession: SessionItem | null; isHomeView: boolean; messages: MessageItem[];
  currentMode: ConversationMode; onModeChange: (mode: ConversationMode) => void;
  onSelectSession: (session: SessionItem) => void; onNewTask: () => void; onSendMessage: (text: string) => void;
  simulateLocal?: boolean; harnessUp?: boolean; running?: boolean; taskBlocked?: boolean;
  onInterrupt?: () => void;
  onApprovalDecision?: (approvalId: string, approved: boolean, toolName: string, remember: boolean) => void | boolean | Promise<boolean>;
  onStartSessionWithPrompt: (prompt: string, domainId: string, modelId: string) => void;
  activeModelId?: string; onSelectModel?: (modelId: string) => void;
  onOpenCockpit: () => void; onOpenSideChat: () => void; onOpenRewind: () => void; onOpenShortcuts: () => void;
  onReviewDiff: () => void; onRevertDiff: () => void;
}
function preference<T>(key: string, initial: T): T {
  try { return JSON.parse(localStorage.getItem("boss-cli.ui." + key) ?? "null") as T ?? initial; } catch { return initial; }
}
interface Route { page: WorkspacePage; sessionId?: string; }
export function AppShell(props: AppShellProps) {
  const [page, setPage] = useState<WorkspacePage>("home");
  const [settings, setSettings] = useState(false), [search, setSearch] = useState(false), [notifications, setNotifications] = useState(false);
  const [summaryAvailable, setSummaryAvailable] = useState(() => window.matchMedia("(min-width: 1200px)").matches);
  const [summaryOpen, setSummaryOpen] = useState(() => preference("summaryOpen", true));
  const [pinned, setPinned] = useState<string[]>(() => preference("pinned", []));
  const [hidden, setHidden] = useState<string[]>(() => preference("hidden", []));
  const [aliases, setAliases] = useState<Record<string, string>>(() => preference("aliases", {}));
  const [groups, setGroups] = useState<ProjectFolder[]>(() => preference("groups", []));
  const [newProject, setNewProject] = useState(false), [projectName, setProjectName] = useState("");
  const [rename, setRename] = useState<SessionItem | null>(null), [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [history, setHistory] = useState<Route[]>([{ page: "home" }]), [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor); cursorRef.current = cursor;
  const historyRef = useRef(history); historyRef.current = history;
  const hasConversation = page === "home" && !props.isHomeView && Boolean(props.activeSession);
  const allFolders = [...props.folders, ...groups].map(folder => ({ ...folder, sessions: folder.sessions.map(session => ({ ...session, title: aliases[session.id] || session.title })) }));
  const visibleFolders = allFolders.map(folder => ({ ...folder, sessions: folder.sessions.filter(session => !hidden.includes(session.id)) }));
  const currentProject = allFolders.find(folder => folder.sessions.some(session => session.id === props.activeSession?.id));
  const title = page === "home" ? props.isHomeView ? "BOSS-CLI" : aliases[props.activeSession?.id ?? ""] || props.activeSession?.title || "新聊天" : { recents: "最近聊天", library: "资料库", skills: "技能与工具" }[page];
  const pushRoute = (route: Route) => {
    const previous = historyRef.current, current = previous[cursorRef.current];
    if (current?.page === route.page && current.sessionId === route.sessionId) return;
    const next = [...previous.slice(0, cursorRef.current + 1), route];
    historyRef.current = next; cursorRef.current = next.length - 1; setHistory(next); setCursor(next.length - 1);
  };
  const openRoute = (route: Route, record = true) => {
    if (record) pushRoute(route);
    setPage(route.page);
    if (route.page === "home") {
      const session = allFolders.flatMap(folder => folder.sessions).find(item => item.id === route.sessionId);
      if (session) { setHidden(prev => prev.filter(id => id !== session.id)); props.onSelectSession(session); }
      else props.onNewTask();
    }
  };
  const newTask = () => { setDraft(""); openRoute({ page: "home" }); };
  const select = (session: SessionItem) => openRoute({ page: "home", sessionId: session.id });
  const go = (delta: number) => { const next = cursorRef.current + delta; if (historyRef.current[next]) { cursorRef.current = next; setCursor(next); openRoute(historyRef.current[next]!, false); } };
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");
    const update = () => setSummaryAvailable(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!props.isHomeView && props.activeSession && page === "home") pushRoute({ page: "home", sessionId: props.activeSession.id });
  }, [props.activeSession?.id, props.isHomeView]);
  useEffect(() => {
    const entries: Record<string, unknown> = { summaryOpen, pinned, hidden, aliases, groups };
    for (const [key, value] of Object.entries(entries)) { try { localStorage.setItem("boss-cli.ui." + key, JSON.stringify(value)); } catch { /* UI preferences are optional. */ } }
  }, [summaryOpen, pinned, hidden, aliases, groups]);
  useEffect(() => {
    let current = true;
    if (props.harnessUp && window.boss) void window.boss.request<ToolListResponse>(ClientMethods.toolList).then(result => { if (current) setTools(result.tools); }).catch(() => {});
    return () => { current = false; };
  }, [props.harnessUp]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "k" && !event.shiftKey) { event.preventDefault(); setSearch(true); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); newTask(); }
      if (event.key === ",") { event.preventDefault(); setSettings(true); }
      if (event.key.toLowerCase() === "b" && event.altKey && summaryAvailable) { event.preventDefault(); setSummaryOpen(prev => !prev); }
      if (event.key === "[") { event.preventDefault(); go(-1); }
      if (event.key === "]") { event.preventDefault(); go(1); }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  });
  const exportChat = () => {
    if (!hasConversation) return;
    const markdown = "# " + title + "\n\n" + props.messages.map(message => "## " + (message.role === "user" ? "你" : "BOSS-CLI") + "\n\n" + [message.content, ...(message.paragraphs ?? []), ...(message.bullets ?? []).map(line => "- " + line), message.toolUse ? `工具：${message.toolUse.name}\n\n${message.toolUse.result ?? ""}` : ""].filter(Boolean).join("\n\n")).join("\n\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = title.replace(/[\\/:*?"<>|]/g, "_") + ".md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <div className={`app-container ${window.boss ? "native-window" : "browser-window"} ${summaryOpen && !props.isHomeView && page === "home" ? "with-summary" : ""}`}>
      <TitleBar summaryAvailable={summaryAvailable} hasConversation={hasConversation} title={title} isSidebarOpen={props.isSidebarOpen} isSummaryOpen={summaryOpen} canGoBack={cursor > 0} canGoForward={cursor < history.length - 1} onBack={() => go(-1)} onForward={() => go(1)} onToggleSidebar={props.onToggleSidebar} onToggleSummary={() => setSummaryOpen(!summaryOpen)} onNewTask={newTask} onOpenSettings={() => setSettings(true)} onOpenRewind={props.onOpenRewind} onExport={exportChat} />
      <div className="workspace-layout">
        <NavigationRail page={page} onNavigate={next => next === "home" ? newTask() : openRoute({ page: next })} onOpenSettings={() => setSettings(true)} onOpenCockpit={props.onOpenCockpit} onOpenSideChat={props.onOpenSideChat} />
        <div className="workspace-surface">
          <ProjectSidebar isOpen={props.isSidebarOpen} folders={visibleFolders} activeSessionId={props.activeSession?.id ?? null} isHomeView={props.isHomeView || page !== "home"} pinned={pinned} onSelectSession={select} onNewTask={newTask} onSearch={() => setSearch(true)} onOpenSettings={() => setSettings(true)} onRecents={() => openRoute({ page: "recents" })} onNewProject={() => setNewProject(true)} onNotifications={() => setNotifications(true)} onRename={session => { setRename(session); setName(session.title); }} onPin={id => setPinned(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])} onHide={id => setHidden(prev => [...prev.filter(item => item !== id), id])} />
          <main className="main-canvas">
            {page !== "home" ? <WorkspacePages page={page} folders={allFolders} messages={props.messages} onSelect={select} onNewTask={newTask} onDraft={text => { newTask(); setDraft(text); }} tools={tools} preview={props.simulateLocal ?? true} /> : props.isHomeView ? <HomeView folders={allFolders} initialPrompt={draft} preview={!props.harnessUp} blocked={props.taskBlocked} activeModelId={props.activeModelId ?? "deepseek-v4"} onSelectModel={props.onSelectModel} currentMode={props.currentMode} onModeChange={props.onModeChange} onStartSessionWithPrompt={props.onStartSessionWithPrompt} onOpenSettings={() => setSettings(true)} /> : <>
              {props.simulateLocal && <div className="conversation-preview-badge">示例会话 · 交互预览</div>}
              <ConversationArea key={props.activeSession?.id ?? "conversation"} messages={props.messages} currentMode={props.currentMode} onModeChange={props.onModeChange} onSendMessage={props.onSendMessage} simulateLocal={props.simulateLocal} running={props.running} taskBlocked={props.taskBlocked} activeModelId={props.activeModelId} onSelectModel={props.onSelectModel} onOpenSettings={() => setSettings(true)} onInterrupt={props.onInterrupt} onApprovalDecision={props.onApprovalDecision} onReviewDiff={props.onReviewDiff} onRevertDiff={props.onRevertDiff} onOpenRewind={props.onOpenRewind} onOpenCockpit={props.onOpenCockpit} />
              <RightPanel isOpen={summaryOpen} projectName={currentProject?.name ?? "本地招聘项目"} messages={props.messages} preview={props.simulateLocal ?? true} onReviewChanges={props.onReviewDiff} onOpenSettings={() => setSettings(true)} />
            </>}
          </main>
        </div>
      </div>
    </div>
    <SettingsDialog isOpen={settings} onClose={() => setSettings(false)} isDark={props.isDark} onToggleTheme={props.onToggleTheme} onOpenShortcuts={() => { setSettings(false); props.onOpenShortcuts(); }} harnessUp={props.harnessUp ?? false} />
    {search && <SearchDialog folders={allFolders} onSelect={select} onClose={() => setSearch(false)} />}
    {notifications && <ModalSurface title="通知" onClose={() => setNotifications(false)}><div className="notification-empty"><IconNotification size={32} /><h3>目前没有新通知</h3><p>需要你确认的操作会在聊天中显示。</p><span><IconCheck size={13} />当前工作区</span></div></ModalSurface>}
    {newProject && <ModalSurface title="新建项目" onClose={() => setNewProject(false)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!projectName.trim()) return; setGroups(prev => [...prev, { id: "group-" + Date.now(), name: projectName.trim(), sessions: [] }]); setProjectName(""); setNewProject(false); }}><label>项目名称<input autoFocus maxLength={60} value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="例如：核心产研团队招聘" /></label><p>创建一个本地项目分组。新聊天可选择项目作为任务上下文。</p><button className="solid-button" disabled={!projectName.trim()}>创建项目</button></form></ModalSurface>}
    {rename && <ModalSurface title="更改显示名称" onClose={() => setRename(null)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; setAliases(prev => ({ ...prev, [rename.id]: name.trim() })); setRename(null); }}><label>聊天名称<input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label><p>只更新此工作区的显示名称。</p><button className="solid-button" disabled={!name.trim()}>保存</button></form></ModalSurface>}
  </>;
}
