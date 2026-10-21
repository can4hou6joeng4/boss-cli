import { useState, useEffect, useRef } from "react";
import { TitleBar } from "./TitleBar";
import { NavigationRail, type WorkspacePage } from "./NavigationRail";
import { ProjectSidebar, type SidebarPreferences } from "./ProjectSidebar";
import { HomeView } from "./HomeView";
import { ConversationArea } from "./ConversationArea";
import { RightPanel } from "./RightPanel";
import { LoginBrowserPanel } from "./LoginBrowserPanel";
import { LoginChoice } from "../components/LoginChoice";
import { usePlatformLogin } from "../data/usePlatformLogin";
import { WorkspacePages } from "./WorkspacePages";
import { SettingsDialog, type SettingsSection } from "../components/SettingsDialog";
import { SearchDialog } from "../components/SearchDialog";
import { ModalSurface } from "../components/ModalSurface";
import { IconNotification, IconCheck } from "../components/Icons";
import { type ProjectFolder, type SessionItem, type MessageItem, type ConversationMode } from "../data/mockData";
import { ClientMethods, type ToolDescriptor, type ToolListResponse } from "@boss-cli/protocol";
import { createComposerDraft, withDraftText, type ComposerDraft, type UpdateComposerDraft, type ComposerSend } from "../data/composerDraft";
import "../styles/login-sidebar.css";

export interface AppShellProps {
  isDark: boolean; onToggleTheme: () => void; isSidebarOpen: boolean; onToggleSidebar: () => void;
  folders: ProjectFolder[]; activeSession: SessionItem | null; isHomeView: boolean; messages: MessageItem[];
  currentMode: ConversationMode; onModeChange: (mode: ConversationMode) => void;
  onSelectSession: (session: SessionItem) => void; onNewTask: () => void; onSendMessage: ComposerSend;
  simulateLocal?: boolean; harnessUp?: boolean; running?: boolean; taskBlocked?: boolean;
  onInterrupt?: () => void;
  onApprovalDecision?: (approvalId: string, approved: boolean, toolName: string, remember: boolean) => void | boolean | Promise<boolean>;
  onStartSessionWithPrompt: (prompt: string, domainId: string, modelId: string) => Promise<SessionItem | null>;
  activeModelId?: string; onSelectModel?: (modelId: string) => void;
  configuredModelLabel?: string;
  onOpenCockpit: () => void; onOpenSideChat: () => void; onOpenRewind: () => void; onOpenShortcuts: () => void;
  onReviewDiff: () => void; onRevertDiff: () => void;
  onCreateConnectionSession: () => Promise<SessionItem | null>;
}
function preference<T>(key: string, initial: T): T {
  try { return JSON.parse(localStorage.getItem("boss-cli.ui." + key) ?? "null") as T ?? initial; } catch { return initial; }
}
interface Route { page: WorkspacePage; sessionId?: string; }
export function AppShell(props: AppShellProps) {
  const login = usePlatformLogin();
  const loginEntryFlight = useRef(false);
  const [page, setPage] = useState<WorkspacePage>("home");
  const [settings, setSettings] = useState(false), [search, setSearch] = useState(false), [notifications, setNotifications] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [summaryAvailable, setSummaryAvailable] = useState(() => window.matchMedia("(min-width: 1200px)").matches);
  const [summaryOpen, setSummaryOpen] = useState(() => preference("summaryOpen", true));
  const [pinned, setPinned] = useState<string[]>(() => preference("pinned", []));
  const [hidden, setHidden] = useState<string[]>(() => preference("hidden", []));
  const [aliases, setAliases] = useState<Record<string, string>>(() => preference("aliases", {}));
  const [groups, setGroups] = useState<ProjectFolder[]>(() => preference("groups", []));
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => preference("projectAliases", {}));
  const [threadGroups, setThreadGroups] = useState<Record<string, string>>(() => preference("threadGroups", {}));
  const [sidebarPreferences, setSidebarPreferences] = useState<SidebarPreferences>(() => {
    const saved = preference<Partial<SidebarPreferences>>("sidebar", {});
    return { grouping: saved.grouping === "list" ? "list" : "project", sort: saved.sort === "name" ? "name" : "updated", showRecent: saved.showRecent ?? false };
  });
  const [newProject, setNewProject] = useState(false), [projectName, setProjectName] = useState("");
  const [rename, setRename] = useState<SessionItem | null>(null), [name, setName] = useState("");
  const [renameProject, setRenameProject] = useState<ProjectFolder | null>(null), [folderName, setFolderName] = useState("");
  const [removeProject, setRemoveProject] = useState<ProjectFolder | null>(null);
  const [draft, updateHomeDraft] = useState(createComposerDraft);
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, ComposerDraft>>({});
  const setDraft = (text: string) => updateHomeDraft(previous => withDraftText(previous, text));
  const resetDraft = () => updateHomeDraft(createComposerDraft());
  const sessionDraftId = props.activeSession?.id ?? "conversation";
  const sessionDraft = sessionDrafts[sessionDraftId] ?? createComposerDraft("session:" + sessionDraftId);
  const updateSessionDraft: UpdateComposerDraft = change => setSessionDrafts(previous => {
    const current = previous[sessionDraftId] ?? createComposerDraft("session:" + sessionDraftId);
    const next = change(current);
    return next === current ? previous : { ...previous, [sessionDraftId]: next };
  });
  const [draftProjectId, setDraftProjectId] = useState("");
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [history, setHistory] = useState<Route[]>([{ page: "home" }]), [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor); cursorRef.current = cursor;
  const historyRef = useRef(history); historyRef.current = history;
  const hasConversation = page === "home" && !props.isHomeView && Boolean(props.activeSession);
  const loginThreadId = props.activeSession?.id ?? "";
  const browserOpen = hasConversation && login.panelThreadId === loginThreadId;
  const loginStatus = login.status.threadId === loginThreadId ? login.status : undefined;
  const baseFolders = [...props.folders, ...groups.filter(group => !props.folders.some(folder => folder.id === group.id))];
  const sessions = [...new Map(baseFolders.flatMap(folder => folder.sessions).map(session => [session.id, session])).values()];
  const allFolders = baseFolders.map(folder => ({ ...folder, name: projectAliases[folder.id] || folder.name,
    sessions: sessions.filter(session => (baseFolders.some(item => item.id === threadGroups[session.id]) ? threadGroups[session.id] : session.projectId) === folder.id)
      .map(session => ({ ...session, title: aliases[session.id] || session.title })),
  }));
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
  const newTask = () => { resetDraft(); setDraftProjectId(""); openRoute({ page: "home" }); };
  const newTaskInProject = (folder: ProjectFolder) => { resetDraft(); setDraftProjectId(folder.id); openRoute({ page: "home" }); };
  const openSettings = (section: SettingsSection = "general") => { setSettingsSection(section); setSettings(true); };
  const startInProject = async (prompt: string, domainId: string, modelId: string) => {
    const projectId = draftProjectId;
    const session = await props.onStartSessionWithPrompt(prompt, domainId, modelId);
    if (session && projectId) setThreadGroups(prev => ({ ...prev, [session.id]: projectId }));
    return Boolean(session);
  };
  const select = (session: SessionItem) => openRoute({ page: "home", sessionId: session.id });
  const loginEntry = async (direct = false) => {
    if (!window.boss || loginEntryFlight.current) return;
    loginEntryFlight.current = true;
    try {
      const owner = ["opening", "waiting", "saving"].includes(login.status.state)
        ? sessions.find(session => session.id === login.status.threadId) : undefined;
      const target = owner ?? (!props.isHomeView ? props.activeSession : null) ?? await props.onCreateConnectionSession();
      if (!target) return;
      setSettings(false); setPage("home");
      pushRoute({ page: "home", sessionId: target.id });
      props.onSelectSession(target);
      if (direct) void login.open(target.id); else login.show(target.id);
    } finally { loginEntryFlight.current = false; }
  };
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
    const entries: Record<string, unknown> = { summaryOpen, pinned, hidden, aliases, groups, projectAliases, threadGroups, sidebar: sidebarPreferences };
    for (const [key, value] of Object.entries(entries)) { try { localStorage.setItem("boss-cli.ui." + key, JSON.stringify(value)); } catch { /* UI preferences are optional. */ } }
  }, [summaryOpen, pinned, hidden, aliases, groups, projectAliases, threadGroups, sidebarPreferences]);
  useEffect(() => {
    let current = true;
    if (props.harnessUp && window.boss) void window.boss.request<ToolListResponse>(ClientMethods.toolList).then(result => { if (current) setTools(result.tools); }).catch(() => {});
    return () => { current = false; };
  }, [props.harnessUp]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "k" && !event.shiftKey) { event.preventDefault(); setSearch(true); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); newTask(); }
      if (event.key === ",") { event.preventDefault(); openSettings(); }
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
    <div className={`app-container ${window.boss ? "native-window" : "browser-window"} ${browserOpen ? `with-browser${login.expanded ? " browser-expanded" : ""}` : summaryOpen && hasConversation ? "with-summary" : ""}`}>
      <TitleBar summaryAvailable={summaryAvailable && !browserOpen} hasConversation={hasConversation} title={title} isSidebarOpen={props.isSidebarOpen} isSummaryOpen={summaryOpen && !browserOpen} canGoBack={cursor > 0} canGoForward={cursor < history.length - 1} onBack={() => go(-1)} onForward={() => go(1)} onToggleSidebar={props.onToggleSidebar} onToggleSummary={() => setSummaryOpen(!summaryOpen)} onNewTask={newTask} onOpenSettings={() => openSettings()} onOpenRewind={props.onOpenRewind} onRename={() => { if (props.activeSession) { setRename(props.activeSession); setName(title); } }} onPin={() => { const id = props.activeSession?.id; if (id) setPinned(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]); }} isPinned={pinned.includes(props.activeSession?.id ?? "")} onExport={exportChat} browserOpen={browserOpen} onOpenBrowser={window.boss ? () => { if (browserOpen) login.closePanel(); else void loginEntry(); } : undefined} />
      <div className="workspace-layout">
        <NavigationRail page={page} isDark={props.isDark} harnessUp={props.harnessUp ?? false} onToggleTheme={props.onToggleTheme} onOpenShortcuts={props.onOpenShortcuts} onNavigate={next => next === "home" ? newTask() : openRoute({ page: next })} onOpenSettings={openSettings} onOpenCockpit={props.onOpenCockpit} onOpenSideChat={props.onOpenSideChat} />
        <div className="workspace-surface">
          <ProjectSidebar isOpen={props.isSidebarOpen} folders={visibleFolders} activeSessionId={props.activeSession?.id ?? null} isHomeView={props.isHomeView || page !== "home"} pinned={pinned}
            preferences={sidebarPreferences} onPreferencesChange={setSidebarPreferences} localGroupIds={groups.map(group => group.id)} onSelectSession={select} onNewTask={newTask} onNewTaskInProject={newTaskInProject} onSearch={() => setSearch(true)} onOpenSettings={() => openSettings()} onRecents={() => openRoute({ page: "recents" })} onNewProject={() => setNewProject(true)} onNotifications={() => setNotifications(true)}
            onRename={session => { setRename(session); setName(session.title); }} onPin={id => setPinned(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])} onHide={id => setHidden(prev => [...prev.filter(item => item !== id), id])}
            onMoveSession={(id, folderId) => setThreadGroups(prev => ({ ...prev, [id]: folderId }))} onRenameProject={folder => { setRenameProject(folder); setFolderName(folder.name); }} onRemoveProject={setRemoveProject} />
          <main className="main-canvas">
            {page !== "home" ? <WorkspacePages page={page} folders={allFolders} messages={props.messages} onSelect={select} onNewTask={newTask} onDraft={text => { newTask(); setDraft(text); }} tools={tools} preview={props.simulateLocal ?? true} /> : props.isHomeView ? <HomeView key={draft.id} folders={allFolders} draft={draft} onDraftChange={updateHomeDraft} selectedProjectId={draftProjectId} onSelectProject={setDraftProjectId} onNewProject={() => setNewProject(true)} preview={!window.boss} harnessUp={props.harnessUp ?? false} blocked={props.taskBlocked} activeModelId={props.activeModelId ?? "deepseek-v4"} configuredModelLabel={props.configuredModelLabel} onSelectModel={props.onSelectModel} currentMode={props.currentMode} onModeChange={props.onModeChange} onStartSessionWithPrompt={startInProject} onOpenSettings={() => openSettings("connections")} /> : <>
              <div className="conversation-pane">
                {props.simulateLocal && <div className="conversation-preview-badge">示例会话 · 交互预览</div>}
                <ConversationArea readOnly={props.activeSession?.toolPolicy === "readOnly"} key={props.activeSession?.id ?? "conversation"} draft={sessionDraft} onDraftChange={updateSessionDraft} messages={props.messages} currentMode={props.currentMode} onModeChange={props.onModeChange} onSendMessage={props.onSendMessage} simulateLocal={props.simulateLocal} running={props.running} taskBlocked={props.taskBlocked} activeModelId={props.activeModelId} configuredModelLabel={props.configuredModelLabel} onSelectModel={props.onSelectModel} onOpenSettings={() => openSettings("connections")} onInterrupt={props.onInterrupt} onApprovalDecision={props.onApprovalDecision} onReviewDiff={props.onReviewDiff} onRevertDiff={props.onRevertDiff} onOpenRewind={props.onOpenRewind} onOpenCockpit={props.onOpenCockpit}
                  onLogin={window.boss ? () => { void loginEntry(); } : undefined}
                  loginGuide={login.visibleIn(loginThreadId) ? <LoginChoice status={loginStatus} pending={login.choiceThreadId === loginThreadId} busy={login.busy} panelOpen={browserOpen} error={login.error?.threadId === loginThreadId ? login.error.message : undefined} onOpen={() => { void login.open(loginThreadId); }} onHide={login.hideForLater} onCancel={() => { void login.cancel(loginThreadId); }} onDismiss={() => login.dismiss(loginThreadId)} onSettings={() => openSettings("connections")} /> : undefined} />
                <RightPanel isOpen={summaryOpen && !browserOpen} projectName={currentProject?.name ?? "本地招聘项目"} messages={props.messages} preview={props.simulateLocal ?? true} onReviewChanges={props.onReviewDiff} onOpenSettings={() => openSettings("connections")} />
              </div>
              {browserOpen && <LoginBrowserPanel key={loginThreadId} threadId={loginThreadId} status={loginStatus} expanded={login.expanded} onToggleExpanded={login.toggleExpanded} onClose={login.closePanel} onRetry={() => { void login.open(loginThreadId); }} />}
            </>}
          </main>
        </div>
      </div>
    </div>
    <SettingsDialog isOpen={settings} initialSection={settingsSection} onClose={() => setSettings(false)} isDark={props.isDark} onToggleTheme={props.onToggleTheme} onOpenShortcuts={() => { setSettings(false); props.onOpenShortcuts(); }} harnessUp={props.harnessUp ?? false} onLogin={() => { void loginEntry(true); }} />
    {search && <SearchDialog folders={allFolders} onSelect={select} onClose={() => setSearch(false)} />}
    {notifications && <ModalSurface title="通知" onClose={() => setNotifications(false)}><div className="notification-empty"><IconNotification size={32} /><h3>目前没有新通知</h3><p>需要你确认的操作会在聊天中显示。</p><span><IconCheck size={13} />当前工作区</span></div></ModalSurface>}
    {newProject && <ModalSurface title="新建项目" onClose={() => setNewProject(false)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!projectName.trim()) return; const id = "group-" + crypto.randomUUID(); setGroups(prev => [...prev, { id, name: projectName.trim(), sessions: [] }]); setDraftProjectId(id); resetDraft(); openRoute({ page: "home" }); setProjectName(""); setNewProject(false); }}><label>项目名称<input autoFocus maxLength={60} value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="例如：核心产研团队招聘" /></label><p>创建一个保存在此设备上的项目分组。</p><button className="solid-button" disabled={!projectName.trim()}>创建项目</button></form></ModalSurface>}
    {rename && <ModalSurface title="更改显示名称" onClose={() => setRename(null)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; setAliases(prev => ({ ...prev, [rename.id]: name.trim() })); setRename(null); }}><label>聊天名称<input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label><p>只更新此工作区的显示名称。</p><button className="solid-button" disabled={!name.trim()}>保存</button></form></ModalSurface>}
    {renameProject && <ModalSurface title="更改项目显示名称" onClose={() => setRenameProject(null)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!folderName.trim()) return; setProjectAliases(prev => ({ ...prev, [renameProject.id]: folderName.trim() })); setRenameProject(null); }}><label>项目名称<input autoFocus maxLength={60} value={folderName} onChange={event => setFolderName(event.target.value)} /></label><p>显示名称保存在此设备上。</p><button className="solid-button" disabled={!folderName.trim()}>保存</button></form></ModalSurface>}
    {removeProject && <ModalSurface title="移除本地分组" onClose={() => setRemoveProject(null)} className="compact-dialog"><div className="dialog-form"><p>移除“{removeProject.name}”后，其中的聊天会回到原项目。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setRemoveProject(null)}>取消</button><button className="solid-button" onClick={() => { const id = removeProject.id; setGroups(prev => prev.filter(folder => folder.id !== id)); setThreadGroups(prev => Object.fromEntries(Object.entries(prev).filter(([, folderId]) => folderId !== id))); if (draftProjectId === id) setDraftProjectId(""); setRemoveProject(null); }}>移除分组</button></div></div></ModalSurface>}
  </>;
}
