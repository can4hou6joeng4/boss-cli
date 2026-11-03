import { useState, useEffect, useRef } from "react";
import { TitleBar } from "./TitleBar";
import { NavigationRail, type WorkspacePage } from "./NavigationRail";
import { ProjectSidebar, type SidebarPreferences } from "./ProjectSidebar";
import { HomeView } from "./HomeView";
import { ConversationArea } from "./ConversationArea";
import type { TurnContinuationReadResponse } from "@boss-harness/protocol";
import { UI_STORAGE_PREFIX } from "../data/uiStorage";
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
import { booleanPreference, projectFolders, stringList, stringRecord } from "../data/preferenceShapes";
import { type ModelDescriptor, type SkillDescriptor, type ToolDescriptor } from "@boss-harness/protocol";
import { createComposerDraft, withDraftText, type ComposerDraft, type UpdateComposerDraft, type ComposerSend } from "../data/composerDraft";
import type { CheckQueueSubmission, ComposerQueue } from "../data/composerDraft";
import type { QueueItem } from "@boss-harness/protocol";
import { harnessErrorText, listSkills, listTools, type SkillCatalogState, type ToolCatalogState, type ApprovalDelivery, type ApprovalOutcome } from "../data/harnessBridge";
import type { SkillProblem } from "@boss-harness/protocol";
import type { SessionReasoningControl } from "../data/useSessionReasoning";
import type { ModelRetryStatus } from "../data/modelRetry";
import type { SessionBranchesView } from "./ConversationArea";
import "../styles/login-sidebar.css";

export interface AppShellProps {
  isDark: boolean; onToggleTheme: () => void; isSidebarOpen: boolean; onToggleSidebar: () => void;
  folders: ProjectFolder[]; activeSession: SessionItem | null; isHomeView: boolean; messages: MessageItem[];
  /** turnId → 该回合实际注入的技能 id；旧内核不返回时为空。 */
  turnSkillIds?: Record<string, string[]>;
  currentMode: ConversationMode; onModeChange: (mode: ConversationMode) => void;
  onSelectSession: (session: SessionItem) => void; onNewTask: () => void;
  /** 删除会话；返回 false 表示会话仍保留（失败原因由外层提示）。 */
  onDeleteSession?: (session: SessionItem) => Promise<boolean>; onSendMessage: ComposerSend;
  /** 归档或恢复会话；失败原因由外层提示，界面以内核事件刷新为准。 */
  onArchiveSession?: (session: SessionItem, archived: boolean) => Promise<boolean>;
  onQueueMessage?: ComposerQueue; onCheckQueueSubmission?: CheckQueueSubmission; queueItems?: QueueItem[]; queueTotalItems?: number; queueActiveItems?: number; queueTruncated?: boolean; onRemoveQueueItem?: (id: string) => Promise<boolean>; onRetryQueueItem?: (item: QueueItem) => Promise<boolean>;
  simulateLocal?: boolean; harnessUp?: boolean; running?: boolean; taskBlocked?: boolean;
  /** 内核声明 skills/read 后，「技能与工具」页才能展示技能正文。 */
  skillsReadable?: boolean;
  /** 内核声明 threadSearch 后，⌘K 弹窗才会按消息正文搜索。 */
  threadSearchable?: boolean;
  /** 内核声明 threadSearchArchived 后，搜索弹窗才提供「含已归档」开关。 */
  threadSearchArchived?: boolean;
  skillsCreatable?: boolean;
  skillsWritable?: boolean;
  skillsDeletable?: boolean;
  /** 内核声明 workspaceInstructionsEdit 后，「技能与工具」页才提供说明编辑。 */
  workspaceInstructionsEditable?: boolean;
  continuationCheck?: { threadId: string; sourceTurnId: string; loading: boolean; submitting?: boolean;
    uncertain?: boolean; response?: TurnContinuationReadResponse; error?: string } | null;
  onContinueInterruptedTurn?: () => void;
  modelRetry?: ModelRetryStatus; onDismissModelRetry?: () => void;
  sessionBranches?: SessionBranchesView;
  onInterrupt?: () => void;
  onApprovalDecision?: (approvalId: string, approved: boolean, toolName: string, remember: boolean) => void | ApprovalDelivery | ApprovalOutcome | Promise<void | ApprovalDelivery | ApprovalOutcome>;
  onStartSessionWithPrompt: (prompt: string, domainId: string, provider: string, modelId: string, skillIds?: string[]) => Promise<SessionItem | null>;
  models?: ModelDescriptor[]; activeModelProvider?: string; activeModelId?: string;
  onSelectModel?: (provider: string, modelId: string) => void | boolean | Promise<void | boolean>;
  configuredModelLabel?: string;
  sessionReasoning?: SessionReasoningControl;
  onOpenCockpit: () => void; onOpenSideChat: () => void; onOpenRewind: () => void; onOpenShortcuts: () => void;
  onOpenContext?: () => void;
  onOpenUsage?: () => void;
  onOpenExport?: () => void;
  onReviewDiff: () => void; onRevertDiff: () => void;
  onCreateConnectionSession: () => Promise<SessionItem | null>;
}
function preference(key: string, initial: unknown): unknown {
  try { return JSON.parse(localStorage.getItem(UI_STORAGE_PREFIX + key) ?? "null") ?? initial; } catch { return initial; }
}
interface Route { page: WorkspacePage; sessionId?: string; }
export function AppShell(props: AppShellProps) {
  const login = usePlatformLogin();
  const loginEntryFlight = useRef(false);
  const [page, setPage] = useState<WorkspacePage>("home");
  /** 从对话里的回合技能标签跳到「技能与工具」时的一次性聚焦意图。 */
  const [skillFocus, setSkillFocus] = useState<string | null>(null);
  const [messageFocus, setMessageFocus] = useState<{ threadId: string; itemId: string } | null>(null);
  const [settings, setSettings] = useState(false), [search, setSearch] = useState(false), [notifications, setNotifications] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [summaryAvailable, setSummaryAvailable] = useState(() => window.matchMedia("(min-width: 1200px)").matches);
  const [summaryOpen, setSummaryOpen] = useState(() => booleanPreference(preference("summaryOpen", true), true));
  const [pinned, setPinned] = useState<string[]>(() => stringList(preference("pinned", [])));
  const [hidden, setHidden] = useState<string[]>(() => stringList(preference("hidden", [])));
  const [aliases, setAliases] = useState<Record<string, string>>(() => stringRecord(preference("aliases", {})));
  const [groups, setGroups] = useState<ProjectFolder[]>(() => projectFolders(preference("groups", [])));
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => stringRecord(preference("projectAliases", {})));
  const [threadGroups, setThreadGroups] = useState<Record<string, string>>(() => stringRecord(preference("threadGroups", {})));
  const [sidebarPreferences, setSidebarPreferences] = useState<SidebarPreferences>(() => {
    const saved = preference("sidebar", {});
    const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Partial<SidebarPreferences> : {};
    return { grouping: value.grouping === "list" ? "list" : "project", sort: value.sort === "name" ? "name" : "updated", showRecent: value.showRecent === true, showHidden: value.showHidden === true, showArchived: value.showArchived === true };
  });
  const [newProject, setNewProject] = useState(false), [projectName, setProjectName] = useState("");
  const [rename, setRename] = useState<SessionItem | null>(null), [name, setName] = useState("");
  const [deleteSession, setDeleteSession] = useState<SessionItem | null>(null), [deleteBusy, setDeleteBusy] = useState(false);
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
  const [toolCatalogState, setToolCatalogState] = useState<ToolCatalogState>("unavailable");
  const [toolCatalogError, setToolCatalogError] = useState("");
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [skillCatalogState, setSkillCatalogState] = useState<SkillCatalogState>("unavailable");
  const [skillCatalogError, setSkillCatalogError] = useState("");
  const [skillRoot, setSkillRoot] = useState<string | null>(null);
  const [skillProblems, setSkillProblems] = useState<SkillProblem[]>([]);
  const [skillRefresh, setSkillRefresh] = useState(0);
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
  const currentProject = allFolders.find(folder => folder.sessions.some(session => session.id === props.activeSession?.id));
  const title = page === "home" ? props.isHomeView ? "BOSS Harness" : aliases[props.activeSession?.id ?? ""] || props.activeSession?.title || "新聊天" : { recents: "最近聊天", library: "资料库", skills: "技能与工具" }[page];
  const pushRoute = (route: Route) => {
    const previous = historyRef.current, current = previous[cursorRef.current];
    if (current?.page === route.page && current.sessionId === route.sessionId) return;
    const next = [...previous.slice(0, cursorRef.current + 1), route];
    historyRef.current = next; cursorRef.current = next.length - 1; setHistory(next); setCursor(next.length - 1);
  };
  const openRoute = (route: Route, record = true) => {
    if (record) pushRoute(route);
    setSkillFocus(null);
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
  const startInProject = async (prompt: string, domainId: string, provider: string, modelId: string, skillIds: string[] = []) => {
    const projectId = draftProjectId;
    const session = await props.onStartSessionWithPrompt(prompt, domainId, provider, modelId, skillIds);
    if (session && projectId) setThreadGroups(prev => ({ ...prev, [session.id]: projectId }));
    return Boolean(session);
  };
  const select = (session: SessionItem) => openRoute({ page: "home", sessionId: session.id });
  const openMessage = (session: SessionItem, itemId: string) => {
    setMessageFocus({ threadId: session.id, itemId });
    select(session);
  };
  const confirmDeleteSession = async () => {
    const target = deleteSession;
    if (!target || deleteBusy || !props.onDeleteSession) return;
    setDeleteBusy(true);
    let removed = false;
    try { removed = await props.onDeleteSession(target); }
    catch { removed = false; }
    finally { setDeleteBusy(false); }
    if (!removed) return;
    const id = target.id;
    // 会话已不存在：同时清掉只存在于本设备的隐藏、置顶、别名与分组记录。
    setPinned(previous => previous.filter(item => item !== id));
    setHidden(previous => previous.filter(item => item !== id));
    setAliases(previous => { if (!(id in previous)) return previous; const next = { ...previous }; delete next[id]; return next; });
    setThreadGroups(previous => { if (!(id in previous)) return previous; const next = { ...previous }; delete next[id]; return next; });
    setDeleteSession(null);
  };
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
    for (const [key, value] of Object.entries(entries)) { try { localStorage.setItem(UI_STORAGE_PREFIX + key, JSON.stringify(value)); } catch { /* UI preferences are optional. */ } }
  }, [summaryOpen, pinned, hidden, aliases, groups, projectAliases, threadGroups, sidebarPreferences]);
  useEffect(() => {
    let current = true;
    setTools([]);
    setToolCatalogError("");
    if (!props.harnessUp || !window.boss) { setToolCatalogState("unavailable"); return () => { current = false; }; }
    setToolCatalogState("loading");
    void listTools().then(result => {
      if (!current) return;
      setTools(result);
      setToolCatalogState(result.length ? "ready" : "empty");
    }).catch(cause => {
      // 读取失败不能显示成「没有工具」：旧清单作废，但状态要如实标为失败。
      if (!current) return;
      setTools([]);
      setToolCatalogError(harnessErrorText(cause));
      setToolCatalogState("error");
    });
    return () => { current = false; };
  }, [props.harnessUp]);
  useEffect(() => {
    let current = true;
    setSkills([]);
    setSkillRoot(null);
    setSkillProblems([]);
    setSkillCatalogError("");
    if (!props.harnessUp || !window.boss) { setSkillCatalogState("unavailable"); return () => { current = false; }; }
    setSkillCatalogState("loading");
    void listSkills().then(result => {
      if (!current) return;
      setSkills(result.skills);
      setSkillRoot(result.root);
      setSkillProblems(result.problems);
      // 全部文件都未能加载时仍按 empty 处理，但问题清单会说明原因。
      setSkillCatalogState(result.skills.length ? "ready" : "empty");
    }).catch(cause => {
      // 读取失败不能显示成「没有技能」：旧清单作废，但状态要如实标为失败并保留原因。
      if (!current) return;
      setSkills([]);
      setSkillRoot(null);
      setSkillCatalogError(harnessErrorText(cause));
      setSkillCatalogState("error");
    });
    return () => { current = false; };
  }, [props.harnessUp, skillRefresh]);
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
    const markdown = "# " + title + "\n\n" + props.messages.map(message => "## " + (message.role === "user" ? "你" : "BOSS Harness") + "\n\n" + [message.content, ...(message.paragraphs ?? []), ...(message.bullets ?? []).map(line => "- " + line), message.toolUse ? `工具：${message.toolUse.name}\n\n${message.toolUse.result ?? ""}` : ""].filter(Boolean).join("\n\n")).join("\n\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = title.replace(/[\\/:*?"<>|]/g, "_") + ".md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <div className={`app-container ${window.boss ? "native-window" : "browser-window"} ${browserOpen ? `with-browser${login.expanded ? " browser-expanded" : ""}` : summaryOpen && hasConversation ? "with-summary" : ""}`}>
      <TitleBar summaryAvailable={summaryAvailable && !browserOpen} hasConversation={hasConversation} title={title} isSidebarOpen={props.isSidebarOpen} isSummaryOpen={summaryOpen && !browserOpen} canGoBack={cursor > 0} canGoForward={cursor < history.length - 1} onBack={() => go(-1)} onForward={() => go(1)} onToggleSidebar={props.onToggleSidebar} onToggleSummary={() => setSummaryOpen(!summaryOpen)} onNewTask={newTask} onOpenSettings={() => openSettings()} onOpenRewind={props.onOpenRewind} onOpenContext={props.onOpenContext} onOpenUsage={props.onOpenUsage} onOpenExport={props.onOpenExport} onOpenBranches={props.sessionBranches ? () => props.sessionBranches?.onOpen() : undefined} onRename={() => { if (props.activeSession) { setRename(props.activeSession); setName(title); } }} onPin={() => { const id = props.activeSession?.id; if (id) setPinned(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]); }} isPinned={pinned.includes(props.activeSession?.id ?? "")} onDelete={() => { if (props.activeSession) setDeleteSession(props.activeSession); }} onExport={exportChat} browserOpen={browserOpen} onOpenBrowser={window.boss ? () => { if (browserOpen) login.closePanel(); else void loginEntry(); } : undefined} />
      <div className="workspace-layout">
        <NavigationRail page={page} isDark={props.isDark} harnessUp={props.harnessUp ?? false} onToggleTheme={props.onToggleTheme} onOpenShortcuts={props.onOpenShortcuts} onNavigate={next => next === "home" ? newTask() : openRoute({ page: next })} onOpenSettings={openSettings} onOpenCockpit={props.onOpenCockpit} onOpenSideChat={props.onOpenSideChat} />
        <div className="workspace-surface">
          <ProjectSidebar isOpen={props.isSidebarOpen} folders={allFolders} activeSessionId={props.activeSession?.id ?? null} isHomeView={props.isHomeView || page !== "home"} pinned={pinned}
            hiddenSessionIds={hidden} onUnhideSession={id => setHidden(prev => prev.filter(item => item !== id))}
            preferences={sidebarPreferences} onPreferencesChange={setSidebarPreferences} localGroupIds={groups.map(group => group.id)} onSelectSession={select} onNewTask={newTask} onNewTaskInProject={newTaskInProject} onSearch={() => setSearch(true)} onOpenSettings={() => openSettings()} onRecents={() => openRoute({ page: "recents" })} onNewProject={() => setNewProject(true)} onNotifications={() => setNotifications(true)}
            onRename={session => { setRename(session); setName(session.title); }} onPin={id => setPinned(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])} onHide={id => setHidden(prev => [...prev.filter(item => item !== id), id])} onDelete={setDeleteSession}
            onArchive={session => { void props.onArchiveSession?.(session, true); }} onUnarchive={session => { void props.onArchiveSession?.(session, false); }}
            onMoveSession={(id, folderId) => setThreadGroups(prev => ({ ...prev, [id]: folderId }))} onRenameProject={folder => { setRenameProject(folder); setFolderName(folder.name); }} onRemoveProject={setRemoveProject} />
          <main className="main-canvas">
            {page !== "home" ? <WorkspacePages page={page} folders={allFolders} messages={props.messages} onSelect={select} onNewTask={newTask} onDraft={text => { newTask(); setDraft(text); }} tools={tools} toolCatalogState={toolCatalogState} toolCatalogError={toolCatalogError} skills={skills} skillCatalogState={skillCatalogState} skillCatalogError={skillCatalogError} onRefreshSkills={() => setSkillRefresh(previous => previous + 1)} skillsReadable={props.skillsReadable === true} skillsCreatable={props.skillsCreatable === true} skillsWritable={props.skillsWritable === true} skillsDeletable={props.skillsDeletable === true} skillRoot={skillRoot} skillProblems={skillProblems} onUseSkill={skillId => { newTask(); updateHomeDraft(previous => ({ ...previous, skillIds: [skillId] })); }} workspaceInstructionsEditable={props.workspaceInstructionsEditable === true} harnessUp={props.harnessUp === true} preview={props.simulateLocal ?? true} focusSkillId={skillFocus} onFocusSkill={() => setSkillFocus(null)} /> : props.isHomeView ? <HomeView key={draft.id} folders={allFolders} draft={draft} onDraftChange={updateHomeDraft} selectedProjectId={draftProjectId} onSelectProject={setDraftProjectId} onNewProject={() => setNewProject(true)} preview={!window.boss} harnessUp={props.harnessUp ?? false} blocked={props.taskBlocked} models={props.models} activeModelProvider={props.activeModelProvider} activeModelId={props.activeModelId ?? "deepseek-v4"} configuredModelLabel={props.configuredModelLabel} onSelectModel={props.onSelectModel} currentMode={props.currentMode} onModeChange={props.onModeChange} skills={skills} skillCatalogState={skillCatalogState} skillCatalogError={skillCatalogError} onRefreshSkills={() => setSkillRefresh(previous => previous + 1)} skillProblems={skillProblems} onStartSessionWithPrompt={startInProject} onOpenSettings={() => openSettings("connections")} /> : <>
              <div className="conversation-pane">
                {props.simulateLocal && <div className="conversation-preview-badge">示例会话 · 交互预览</div>}
                <ConversationArea readOnly={props.activeSession?.toolPolicy === "readOnly"} archived={props.activeSession?.archived === true} threadId={props.activeSession?.id} key={props.activeSession?.id ?? "conversation"} draft={sessionDraft} onDraftChange={updateSessionDraft} messages={props.messages} turnSkillIds={props.turnSkillIds ?? {}} onInspectSkill={skillId => { openRoute({ page: "skills" }); setSkillFocus(skillId); }} focusMessageId={messageFocus && messageFocus.threadId === props.activeSession?.id ? messageFocus.itemId : null} onFocusMessage={() => setMessageFocus(null)} currentMode={props.currentMode} onModeChange={props.onModeChange} onSendMessage={props.onSendMessage} onQueueMessage={props.onQueueMessage} onCheckQueueSubmission={props.onCheckQueueSubmission} queueItems={props.queueItems} queueTotalItems={props.queueTotalItems} queueActiveItems={props.queueActiveItems} queueTruncated={props.queueTruncated} onRemoveQueueItem={props.onRemoveQueueItem} onRetryQueueItem={props.onRetryQueueItem} simulateLocal={props.simulateLocal} harnessUp={props.harnessUp} running={props.running} taskBlocked={props.taskBlocked} models={props.models} activeModelProvider={props.activeModelProvider} activeModelId={props.activeModelId} configuredModelLabel={props.configuredModelLabel} onSelectModel={props.onSelectModel} sessionReasoning={props.sessionReasoning} skills={skills} skillCatalogState={skillCatalogState} skillCatalogError={skillCatalogError} onRefreshSkills={() => setSkillRefresh(previous => previous + 1)} skillProblems={skillProblems} onOpenSettings={() => openSettings("connections")} onInterrupt={props.onInterrupt} onApprovalDecision={props.onApprovalDecision} onReviewDiff={props.onReviewDiff} onRevertDiff={props.onRevertDiff} onOpenRewind={props.onOpenRewind} onOpenCockpit={props.onOpenCockpit} continuationCheck={props.continuationCheck} onContinueInterruptedTurn={props.onContinueInterruptedTurn} modelRetry={props.modelRetry} onDismissModelRetry={props.onDismissModelRetry} sessionBranches={props.sessionBranches}
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
    {search && <SearchDialog folders={allFolders} onSelect={select} onOpenMessage={openMessage} onClose={() => setSearch(false)} searchMessages={props.threadSearchable === true} searchArchived={props.threadSearchArchived === true} />}
    {notifications && <ModalSurface title="通知" onClose={() => setNotifications(false)}><div className="notification-empty"><IconNotification size={32} /><h3>目前没有新通知</h3><p>需要你确认的操作会在聊天中显示。</p><span><IconCheck size={13} />当前工作区</span></div></ModalSurface>}
    {newProject && <ModalSurface title="新建项目" onClose={() => setNewProject(false)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!projectName.trim()) return; const id = "group-" + crypto.randomUUID(); setGroups(prev => [...prev, { id, name: projectName.trim(), sessions: [] }]); setDraftProjectId(id); resetDraft(); openRoute({ page: "home" }); setProjectName(""); setNewProject(false); }}><label>项目名称<input autoFocus maxLength={60} value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="例如：核心产研团队招聘" /></label><p>创建一个保存在此设备上的项目分组。</p><button className="solid-button" disabled={!projectName.trim()}>创建项目</button></form></ModalSurface>}
    {rename && <ModalSurface title="更改显示名称" onClose={() => setRename(null)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; setAliases(prev => ({ ...prev, [rename.id]: name.trim() })); setRename(null); }}><label>聊天名称<input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label><p>只更新此工作区的显示名称。</p><button className="solid-button" disabled={!name.trim()}>保存</button></form></ModalSurface>}
    {renameProject && <ModalSurface title="更改项目显示名称" onClose={() => setRenameProject(null)} className="compact-dialog"><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!folderName.trim()) return; setProjectAliases(prev => ({ ...prev, [renameProject.id]: folderName.trim() })); setRenameProject(null); }}><label>项目名称<input autoFocus maxLength={60} value={folderName} onChange={event => setFolderName(event.target.value)} /></label><p>显示名称保存在此设备上。</p><button className="solid-button" disabled={!folderName.trim()}>保存</button></form></ModalSurface>}
    {removeProject && <ModalSurface title="移除本地分组" onClose={() => setRemoveProject(null)} className="compact-dialog"><div className="dialog-form"><p>移除“{removeProject.name}”后，其中的聊天会回到原项目。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setRemoveProject(null)}>取消</button><button className="solid-button" onClick={() => { const id = removeProject.id; setGroups(prev => prev.filter(folder => folder.id !== id)); setThreadGroups(prev => Object.fromEntries(Object.entries(prev).filter(([, folderId]) => folderId !== id))); if (draftProjectId === id) setDraftProjectId(""); setRemoveProject(null); }}>移除分组</button></div></div></ModalSurface>}
    {deleteSession && <ModalSurface title="删除聊天" onClose={() => { if (!deleteBusy) setDeleteSession(null); }} className="compact-dialog"><div className="dialog-form">
      <p>“{aliases[deleteSession.id] || deleteSession.title}”及其全部消息会从本机移除，无法恢复。</p>
      <p>仍有运行中的回合或排队消息时，内核会拒绝删除；请先停止当前回合。</p>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={deleteBusy} onClick={() => setDeleteSession(null)}>取消</button>
        <button className="solid-button danger-button" disabled={deleteBusy} onClick={() => { void confirmDeleteSession(); }}>{deleteBusy ? "正在删除…" : "删除聊天"}</button>
      </div>
    </div></ModalSurface>}
  </>;
}
