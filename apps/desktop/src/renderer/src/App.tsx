import { useState, useEffect, useCallback, useRef } from "react";
import { AppShell } from "./shell/AppShell";
import { CockpitModal } from "./components/CockpitModal";
import { SideChatModal } from "./components/SideChatModal";
import { RewindOverlay } from "./components/RewindOverlay";
import { UnifiedDiffModal } from "./components/UnifiedDiffModal";
import { RevertConfirmModal } from "./components/RevertConfirmModal";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { IconClose } from "./components/Icons";
import { MOCK_PROJECT_FOLDERS, MOCK_CONVERSATION_THREAD, type ProjectFolder, type SessionItem, type MessageItem, type ConversationMode } from "./data/mockData";
import { HARNESS_PROJECT_ID, HARNESS_PROJECT_NAME, harnessStatus, interruptTurn, listThreads, readThreadMessages, respondApproval, sendTurn, startThread } from "./data/harnessBridge";
import { reduceHarnessEvent, type HarnessEvent } from "./data/harnessEvents";
export function App(): JSX.Element {
  const [isDark, setIsDark] = useState(() => {
    try { const saved = localStorage.getItem("boss-cli.ui.theme"); if (saved) return saved === "dark"; } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  });
  const [harnessUp, setHarnessUp] = useState(false);
  const [isHomeView, setIsHomeView] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 700);
  const [folders, setFolders] = useState<ProjectFolder[]>(() => MOCK_PROJECT_FOLDERS.map(folder => ({ ...folder, sessions: folder.sessions.map(session => ({ ...session, status: "completed" })) })));
  const [activeSession, setActiveSession] = useState<SessionItem | null>(null);
  const [currentMode, setCurrentMode] = useState<ConversationMode>("agent");
  const [activeModelId, setActiveModelId] = useState("deepseek-v4");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeRef = useRef<SessionItem | null>(null);
  const runningRef = useRef<string | null>(null);
  const turnIds = useRef(new Map<string, string>());
  const lifecycleVersion = useRef(0);
  const startingRef = useRef(false);
  const [startingSession, setStartingSession] = useState(false);
  const cache = useRef(new Map<string, MessageItem[]>());
  const versions = useRef(new Map<string, number>());
  const rememberedApprovals = useRef(new Map<string, Set<string>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionVersion = useRef(0);
  const lastEsc = useRef(0);
  const [isCockpitOpen, setIsCockpitOpen] = useState(false), [isSideChatOpen, setIsSideChatOpen] = useState(false);
  const [isRewindOpen, setIsRewindOpen] = useState(false), [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [isRevertModalOpen, setIsRevertModalOpen] = useState(false), [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const updateThread = useCallback((id: string, change: (previous: MessageItem[]) => MessageItem[]) => {
    const next = change(cache.current.get(id) ?? []);
    cache.current.set(id, next); versions.current.set(id, (versions.current.get(id) ?? 0) + 1);
    if (activeRef.current?.id === id) setMessages(next);
  }, []);
  const markRunning = useCallback((id: string, running: boolean) => {
    if (running) { runningRef.current = id; setRunningThreadId(id); }
    else if (runningRef.current === id) { runningRef.current = null; setRunningThreadId(null); }
    setFolders(previous => previous.map(folder => ({ ...folder, sessions: folder.sessions.map(session => session.id === id ? { ...session, status: running ? "running" : "completed" } : session) })));
  }, []);
  const insertSession = useCallback((session: SessionItem) => {
    setFolders(previous => {
      const exists = previous.some(folder => folder.id === session.projectId);
      if (!exists) return [{ id: session.projectId, name: session.projectId === HARNESS_PROJECT_ID ? HARNESS_PROJECT_NAME : "招聘项目", sessions: [session] }, ...previous];
      return previous.map(folder => folder.id === session.projectId ? { ...folder, sessions: [session, ...folder.sessions.filter(item => item.id !== session.id)] } : folder);
    });
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    try { localStorage.setItem("boss-cli.ui.theme", isDark ? "dark" : "light"); } catch {}
  }, [isDark]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await harnessStatus(); if (cancelled) return; setHarnessUp(status?.running ?? false);
      if (!status?.running) { if (window.boss) setError(status?.error ?? "本地内核未连接，请检查配置并重启应用。"); return; }
      if (status.modelBridge) setActiveModelId(status.modelBridge.model);
      const version = lifecycleVersion.current;
      const sessions = await listThreads(); if (cancelled) return;
      if (version === lifecycleVersion.current) {
        const active = sessions.find(session => session.status === "running");
        if (active) { if (active.turnId) turnIds.current.set(active.id, active.turnId); markRunning(active.id, true); }
      }
      for (const session of sessions) session.status = runningRef.current === session.id ? "running" : "idle";
      setFolders(previous => [{ id: HARNESS_PROJECT_ID, name: HARNESS_PROJECT_NAME, sessions }, ...previous.filter(folder => folder.id !== HARNESS_PROJECT_ID)]);
    })();
    return () => { cancelled = true; };
  }, [markRunning]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!window.boss) return;
    return window.boss.onNotification(raw => {
      const event = raw as HarnessEvent, params = event.params ?? {}, id = params.threadId;
      if (event.method === "harness/disconnected") {
        setHarnessUp(false); setError("本地内核已断开，请检查配置并重启应用；未确认的对外操作请先核对平台状态。");
        if (runningRef.current) markRunning(runningRef.current, false);
        return;
      }
      if (!id) return;
      if (event.method === "turn/started") { lifecycleVersion.current += 1; if (params.turnId) turnIds.current.set(id, params.turnId); markRunning(id, true); return; }
      if (params.turnId && turnIds.current.has(id) && turnIds.current.get(id) !== params.turnId) return;
      if (event.method === "approval/requested" && params.approvalId) {
        if (!params.consequential && params.toolName && rememberedApprovals.current.get(id)?.has(params.toolName)) { void respondApproval(params.approvalId, true); return; }
      }
      if (event.method === "session/error") {
        setError(params.message ?? "任务遇到错误，请检查后重试。"); return;
      }
      if (event.method === "thread/updated") {
        lifecycleVersion.current += 1;
        markRunning(id, false);
        const version = versions.current.get(id);
        void readThreadMessages(id).then(real => {
          if (real === null || versions.current.get(id) !== version) return;
          updateThread(id, () => real);
        });
        return;
      }
      updateThread(id, previous => reduceHarnessEvent(previous, event));
    });
  }, [updateThread, markRunning]);
  const handleSelectSession = useCallback((session: SessionItem) => {
    const requestVersion = ++selectionVersion.current;
    activeRef.current = session; setActiveSession(session); setIsHomeView(false); setError("");
    if (window.innerWidth < 700) setIsSidebarOpen(false);
    if (session.projectId !== HARNESS_PROJECT_ID) {
      const sample = cache.current.get(session.id) ?? (session.id === "s-algo" ? MOCK_CONVERSATION_THREAD : [
        { id: "sample-user-" + session.id, role: "user" as const, content: session.title },
        { id: "sample-agent-" + session.id, role: "agent" as const, paragraphs: ["这是一段招聘任务示例。你可以在这里预览消息、输入与菜单交互，所有对外操作均未执行。"] },
      ]);
      cache.current.set(session.id, sample); setMessages(sample); return;
    }
    setMessages(cache.current.get(session.id) ?? []);
    const version = versions.current.get(session.id);
    void readThreadMessages(session.id).then(real => {
      if (selectionVersion.current !== requestVersion || activeRef.current?.id !== session.id || versions.current.get(session.id) !== version) return;
      if (real === null) { setError("读取会话失败，已保留当前内容。请检查本地内核连接。"); return; }
      updateThread(session.id, () => real);
    });
  }, [updateThread]);
  const handleNewTask = useCallback(() => {
    ++selectionVersion.current; activeRef.current = null; setActiveSession(null); setMessages([]); setIsHomeView(true); setError("");
  }, []);
  const simulate = useCallback((id: string) => {
    markRunning(id, true);
    timer.current = setTimeout(() => {
      updateThread(id, previous => [...previous, { id: "preview-agent-" + Date.now(), role: "agent", thinkingTime: "界面演示", paragraphs: ["已记录这条示例任务。正式执行时，BOSS-CLI 会依据岗位需求、履历事实和你的偏好逐步推进，并在需要对外操作时请你确认。", "当前为界面预览，未调用模型或招聘平台。"] }]);
      markRunning(id, false); timer.current = null;
    }, 1300);
  }, [markRunning, updateThread]);
  const send = useCallback(async (id: string, text: string, real: boolean) => {
    if (real && !harnessUp) { setError("本地内核未连接，请重启应用后再发起任务。"); return; }
    if (runningRef.current) { setError("已有任务正在运行，请等待结束或停止后再发送。"); return; }
    updateThread(id, previous => [...previous, { id: "user-" + Date.now(), role: "user", content: text }]);
    if (!real) { simulate(id); return; }
    markRunning(id, true);
    if (!await sendTurn(id, text)) {
      markRunning(id, false);
      updateThread(id, previous => [...previous, { id: "error-" + Date.now(), role: "agent", paragraphs: ["发送失败，请检查本地内核连接并重试。"] }]);
    }
  }, [harnessUp, updateThread, markRunning, simulate]);
  const handleStartSessionWithPrompt = useCallback((prompt: string, _domain: string, modelId: string) => {
    void (async () => {
      if (window.boss && !harnessUp) { setError("本地内核未连接，请检查启动配置并重启应用。"); return; }
      if (runningRef.current || startingRef.current) { setError("已有任务正在创建或运行，请等待结束或停止后再创建。"); return; }
      startingRef.current = true; setStartingSession(true);
      try {
        setActiveModelId(modelId);
        const started = harnessUp ? await startThread(prompt.slice(0, 32)) : { id: "preview-" + Date.now(), title: prompt.slice(0, 32), timeAgo: "刚刚", status: "idle" as const, projectId: MOCK_PROJECT_FOLDERS[0]?.id ?? "preview" };
        if (!started) { setError("创建会话失败，请检查本地内核连接后重试。"); return; }
        ++selectionVersion.current; activeRef.current = started; setActiveSession(started); setIsHomeView(false); setMessages([]); insertSession(started);
        await send(started.id, prompt, started.projectId === HARNESS_PROJECT_ID);
      } finally { startingRef.current = false; setStartingSession(false); }
    })();
  }, [harnessUp, insertSession, send]);
  const handleSendMessage = useCallback((text: string) => {
    const session = activeRef.current; if (!session || !text.trim()) return;
    void send(session.id, text, session.projectId === HARNESS_PROJECT_ID);
  }, [send]);
  const handleInterrupt = useCallback(() => {
    const id = runningRef.current; if (!id) return;
    if (timer.current) {
      clearTimeout(timer.current); timer.current = null; markRunning(id, false);
      updateThread(id, previous => [...previous, { id: "stopped-" + Date.now(), role: "agent", paragraphs: ["已停止界面演示。"] }]); return;
    }
    void interruptTurn(id).then(interrupted => { if (!interrupted && runningRef.current === id) setError("未找到可停止的任务，正在等待内核状态同步。"); });
  }, [markRunning, updateThread]);
  const handleApproval = useCallback(async (approvalId: string, approved: boolean, toolName: string, remember: boolean) => {
    const session = activeRef.current; if (!session) return false;
    const accepted = await respondApproval(approvalId, approved);
    if (!accepted) return false;
    const approval = cache.current.get(session.id)?.find(message => message.approval?.approvalId === approvalId)?.approval;
    if (remember && approved && approval && !approval.consequential) {
      const tools = rememberedApprovals.current.get(session.id) ?? new Set<string>(); tools.add(toolName); rememberedApprovals.current.set(session.id, tools);
    }
    updateThread(session.id, previous => previous.map(message => message.approval?.approvalId === approvalId ? { ...message, approval: { ...message.approval, decision: approved ? "approve" : "deny" } } : message));
    return true;
  }, [updateThread]);
  const openRewind = useCallback(() => {
    if (!activeRef.current) { setError("请先打开一段聊天。"); return; }
    if (activeRef.current.projectId === HARNESS_PROJECT_ID) { setError("当前会话尚未连接回溯服务。"); return; }
    setIsRewindOpen(true);
  }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") { const now = Date.now(); if (now - lastEsc.current < 450) { openRewind(); lastEsc.current = 0; } else lastEsc.current = now; return; }
      if (!command) return;
      const key = event.key.toLowerCase();
      if (key === "k" && event.shiftKey) { event.preventDefault(); setIsCockpitOpen(true); }
      if (key === ";") { event.preventDefault(); setIsSideChatOpen(previous => !previous); }
      if (key === "b" && !event.shiftKey && !event.altKey) { event.preventDefault(); setIsSidebarOpen(previous => !previous); }
      if (key === "/") { event.preventDefault(); setIsShortcutsOpen(previous => !previous); }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [handleNewTask, openRewind]);
  const preview = activeSession?.projectId !== HARNESS_PROJECT_ID;
  return <>
    <AppShell isDark={isDark} onToggleTheme={() => setIsDark(previous => !previous)} isSidebarOpen={isSidebarOpen} onToggleSidebar={() => setIsSidebarOpen(previous => !previous)}
      folders={folders} activeSession={activeSession} isHomeView={isHomeView} messages={messages} currentMode={currentMode} onModeChange={setCurrentMode}
      onSelectSession={handleSelectSession} onNewTask={handleNewTask} onSendMessage={handleSendMessage} simulateLocal={preview} harnessUp={harnessUp}
      running={Boolean(activeSession && activeSession.id === runningThreadId)} taskBlocked={startingSession || Boolean(runningThreadId && (!activeSession || activeSession.id !== runningThreadId))}
      onInterrupt={handleInterrupt} onApprovalDecision={handleApproval} onStartSessionWithPrompt={handleStartSessionWithPrompt} activeModelId={activeModelId} onSelectModel={setActiveModelId}
      onOpenCockpit={() => setIsCockpitOpen(true)} onOpenSideChat={() => setIsSideChatOpen(previous => !previous)} onOpenRewind={openRewind}
      onOpenShortcuts={() => setIsShortcutsOpen(true)} onReviewDiff={() => setIsDiffModalOpen(true)} onRevertDiff={() => setIsRevertModalOpen(true)} />
    {error && <div className="app-toast" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭提示"><IconClose size={14} /></button></div>}
    <CockpitModal isOpen={isCockpitOpen} onClose={() => setIsCockpitOpen(false)} />
    <SideChatModal isOpen={isSideChatOpen} onClose={() => setIsSideChatOpen(false)} />
    <RewindOverlay messages={messages} isOpen={isRewindOpen} onClose={() => setIsRewindOpen(false)} onConfirmRewind={messageCount => {
      const id = activeRef.current?.id; if (id && preview) updateThread(id, previous => previous.slice(0, messageCount));
    }} />
    <UnifiedDiffModal messages={messages} preview={preview} isOpen={isDiffModalOpen} onClose={() => setIsDiffModalOpen(false)} onRevertChanges={() => { setIsDiffModalOpen(false); setIsRevertModalOpen(true); }} />
    <RevertConfirmModal isOpen={isRevertModalOpen} onClose={() => setIsRevertModalOpen(false)} fileCount={[...messages].reverse().find(message => message.diffSummary)?.diffSummary?.fileCount ?? 0} onConfirm={() => {
      const id = activeRef.current?.id;
      if (id && preview) updateThread(id, previous => previous.map(message => ({ ...message, showDiffCard: false, diffSummary: undefined })));
      setIsRevertModalOpen(false);
    }} />
    <KeyboardShortcutsModal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
  </>;
}
