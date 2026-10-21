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
import { HARNESS_PROJECT_ID, HARNESS_PROJECT_NAME, harnessStatus, forkThread, interruptTurn, listThreads, reconnectHarness, respondApproval, sendTurn, startThread } from "./data/harnessBridge";
import { reduceHarnessEvent, type HarnessEvent } from "./data/harnessEvents";
import { HarnessReplica } from "./data/harnessReplica";
import { toMessage } from "./data/harnessBridge";
export function App(): JSX.Element {
  const [isDark, setIsDark] = useState(() => {
    try { const saved = localStorage.getItem("boss-cli.ui.theme"); if (saved) return saved === "dark"; } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  });
  const [harnessUp, setHarnessUp] = useState(false);
  const [isHomeView, setIsHomeView] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 700);
  const [folders, setFolders] = useState<ProjectFolder[]>(() => window.boss ? [] : MOCK_PROJECT_FOLDERS.map(folder => ({ ...folder, sessions: folder.sessions.map(session => ({ ...session, status: "completed" })) })));
  const [activeSession, setActiveSession] = useState<SessionItem | null>(null);
  const [currentMode, setCurrentMode] = useState<ConversationMode>("agent");
  const [activeModelId, setActiveModelId] = useState("deepseek-v4");
  const [configuredModelLabel, setConfiguredModelLabel] = useState<string>();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [runningThreadIds, setRunningThreadIds] = useState(new Set<string>());
  const [error, setError] = useState("");
  const activeRef = useRef<SessionItem | null>(null);
  const runningRef = useRef(new Set<string>());
  const replicaRef = useRef<HarnessReplica | null>(null);
  const turnIds = useRef(new Map<string, string>());
  const lifecycleVersion = useRef(0);
  const startingRef = useRef(false);
  const [startingSession, setStartingSession] = useState(false);
  const cache = useRef(new Map<string, MessageItem[]>());
  const versions = useRef(new Map<string, number>());
  const rememberedApprovals = useRef(new Map<string, Set<string>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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
    const next = new Set(runningRef.current);
    if (running) next.add(id); else next.delete(id);
    runningRef.current = next; setRunningThreadIds(next);
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
    if (!window.boss) return;
    let cancelled = false;
    let refreshing: Promise<void> | null = null;
    let refreshAgain = false;
    const replica = new HarnessReplica(window.boss, event => {
      const params = event.params ?? {}, id = params.threadId;
      if (!id) return;
      if (["thread/created", "thread/archived", "thread/unarchived", "thread/renamed"].includes(event.method)) { void refresh(); return; }
      if (event.method === "turn/started") {
        lifecycleVersion.current += 1;
        if (params.turnId) turnIds.current.set(id, params.turnId);
        markRunning(id, true); return;
      }
      if (params.kind !== "userMessage" && params.turnId && turnIds.current.has(id) && turnIds.current.get(id) !== params.turnId) return;
      if (event.method === "approval/requested" && params.approvalId && !params.consequential && params.toolName && rememberedApprovals.current.get(id)?.has(params.toolName)) {
        void respondApproval(params.approvalId, true); return;
      }
      if (event.method === "session/error") { setError(params.message ?? "任务遇到错误，请检查后重试。"); return; }
      if (event.method === "thread/updated") {
        lifecycleVersion.current += 1; markRunning(id, false);
        void replica.resume(id); return;
      }
      updateThread(id, previous => reduceHarnessEvent(previous, event));
    }, snapshot => {
      if (cancelled) return;
      const id = snapshot.thread.id;
      const real = snapshot.items.map(toMessage).filter((item): item is MessageItem => item !== null);
      updateThread(id, () => real);
      if (snapshot.activeTurnId) turnIds.current.set(id, snapshot.activeTurnId);
      markRunning(id, Boolean(snapshot.activeTurnId));
    });
    replicaRef.current = replica;
    function refresh(): Promise<void> {
      if (refreshing) { refreshAgain = true; return refreshing; }
      refreshing = (async () => {
        const status = await harnessStatus(); if (cancelled) return;
        setHarnessUp(status?.running ?? false);
        if (!status?.running) {
          if (status?.state === "disconnected" || status?.state === "stopped") setError(status?.error ?? "本地内核未连接，可重新连接后恢复会话。");
          return;
        }
        if (status.modelBridge) { setActiveModelId(status.modelBridge.model); setConfiguredModelLabel(status.modelBridge.model); }
        const version = lifecycleVersion.current;
        const sessions = await listThreads(); if (cancelled) return;
        if (version === lifecycleVersion.current) {
          const next = new Set(sessions.filter(session => session.status === "running").map(session => session.id));
          runningRef.current = next; setRunningThreadIds(next);
          for (const session of sessions) if (session.turnId) turnIds.current.set(session.id, session.turnId);
        }
        for (const session of sessions) session.status = runningRef.current.has(session.id) ? "running" : "idle";
        setFolders([{ id: HARNESS_PROJECT_ID, name: HARNESS_PROJECT_NAME, sessions }]);
        const active = activeRef.current;
        if (active?.projectId === HARNESS_PROJECT_ID) await replica.resume(active.id);
      })().finally(() => { refreshing = null; if (refreshAgain && !cancelled) { refreshAgain = false; void refresh(); } });
      return refreshing;
    }
    const unsubscribe = window.boss.onNotification(raw => {
      const event = raw as HarnessEvent;
      if (event.method === "harness/connectionStatus") {
        if (event.params?.state === "ready") { setError(""); void refresh(); }
        else setHarnessUp(false);
        return;
      }
      if (event.method === "harness/disconnected") {
        replica.invalidate(); setHarnessUp(false); setConfiguredModelLabel(undefined);
        setError("本地内核已断开，正在恢复连接；结果未确认的对外操作请先核对平台状态。");
        for (const id of runningRef.current) markRunning(id, false);
        return;
      }
      replica.ingest(event);
    });
    void refresh();
    return () => { cancelled = true; replica.invalidate(); unsubscribe(); if (replicaRef.current === replica) replicaRef.current = null; };
  }, [markRunning, updateThread]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
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
    void replicaRef.current?.resume(session.id).then(snapshot => {
      if (selectionVersion.current !== requestVersion || activeRef.current?.id !== session.id) return;
      if (!snapshot) setError("读取会话失败，已保留当前内容。请检查本地内核连接。");
      else if (snapshot.thread.model) { setActiveModelId(snapshot.thread.model); setConfiguredModelLabel(snapshot.thread.model); }
    });
  }, []);
  const handleNewTask = useCallback(() => {
    ++selectionVersion.current; activeRef.current = null; setActiveSession(null); setMessages([]); setIsHomeView(true); setError("");
  }, []);
  const simulate = useCallback((id: string) => {
    markRunning(id, true);
    timers.current.set(id, setTimeout(() => {
      updateThread(id, previous => [...previous, { id: "preview-agent-" + Date.now(), role: "agent", thinkingTime: "界面演示", paragraphs: ["已记录这条示例任务。正式执行时，BOSS-CLI 会依据岗位需求、履历事实和你的偏好逐步推进，并在需要对外操作时请你确认。", "当前为界面预览，未调用模型或招聘平台。"] }]);
      markRunning(id, false); timers.current.delete(id);
    }, 1300));
  }, [markRunning, updateThread]);
  const send = useCallback(async (id: string, text: string, real: boolean, model = activeModelId): Promise<boolean> => {
    if (real && !harnessUp) { setError("本地内核未连接，请重启应用后再发起任务。"); return false; }
    if (runningRef.current.has(id)) { setError("该会话仍在运行，请等待结束或停止后再发送。"); return false; }
    const clientId = crypto.randomUUID();
    updateThread(id, previous => [...previous, { id: clientId, role: "user", content: text }]);
    if (!real) { simulate(id); return true; }
    markRunning(id, true);
    try {
      const accepted = await sendTurn(id, text, clientId, model);
      if (accepted) turnIds.current.set(id, accepted.turnId);
      else {
        markRunning(id, false);
        setError("提交结果尚未确认，正在读取会话状态。请核对记录后再决定下一步。");
        await replicaRef.current?.resume(id);
      }
    } catch {
      markRunning(id, false);
      setError("提交结果尚未确认，正在读取会话状态。请核对记录后再决定下一步。");
      await replicaRef.current?.resume(id).catch(() => undefined);
    }
    // 已交给会话并发起请求；回执未知仍不能作为可自动重发的草稿。
    return true;
  }, [harnessUp, activeModelId, updateThread, markRunning, simulate]);
  const handleStartSessionWithPrompt = useCallback((prompt: string, _domain: string, modelId: string) => {
    return (async () => {
      if (window.boss && !harnessUp) { setError("本地内核未连接，请检查启动配置并重启应用。"); return null; }
      if (startingRef.current) { setError("已有任务正在创建或运行，请等待结束或停止后再创建。"); return null; }
      const requestVersion = selectionVersion.current;
      startingRef.current = true; setStartingSession(true);
      try {
        setActiveModelId(modelId);
        const started = harnessUp ? await startThread(prompt.slice(0, 32), modelId) : { id: "preview-" + Date.now(), title: prompt.slice(0, 32), timeAgo: "刚刚", status: "idle" as const, projectId: MOCK_PROJECT_FOLDERS[0]?.id ?? "preview" };
        if (!started) { setError("创建会话失败，请检查本地内核连接后重试。"); return null; }
        insertSession(started);
        const transferred = await send(started.id, prompt, started.projectId === HARNESS_PROJECT_ID, modelId);
        if (!transferred) return null;
        if (selectionVersion.current === requestVersion) {
          ++selectionVersion.current; activeRef.current = started; setActiveSession(started); setIsHomeView(false);
          setMessages(cache.current.get(started.id) ?? []);
        }
        return started;
      } catch {
        setError("创建会话失败，请检查本地内核连接后重试。"); return null;
      } finally { startingRef.current = false; setStartingSession(false); }
    })();
  }, [harnessUp, insertSession, send]);
  const handleSendMessage = useCallback((text: string) => {
    const session = activeRef.current; if (!session || !text.trim()) return false;
    return send(session.id, text, session.projectId === HARNESS_PROJECT_ID);
  }, [send]);
  const handleInterrupt = useCallback(() => {
    const id = activeRef.current?.id; if (!id || !runningRef.current.has(id)) return;
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer); timers.current.delete(id); markRunning(id, false);
      updateThread(id, previous => [...previous, { id: "stopped-" + Date.now(), role: "agent", paragraphs: ["已停止界面演示。"] }]); return;
    }
    void interruptTurn(id).then(interrupted => { if (!interrupted && runningRef.current.has(id)) setError("未找到可停止的任务，正在等待内核状态同步。"); });
  }, [markRunning, updateThread]);
  const handleApproval = useCallback(async (approvalId: string, approved: boolean, toolName: string, remember: boolean) => {
    const session = activeRef.current; if (!session) return false;
    const accepted = await respondApproval(approvalId, approved);
    if (!accepted) return false;
    const approval = cache.current.get(session.id)?.find(message => message.approval?.approvalId === approvalId)?.approval;
    if (remember && approved && approval && !approval.consequential) {
      const tools = rememberedApprovals.current.get(session.id) ?? new Set<string>(); tools.add(toolName); rememberedApprovals.current.set(session.id, tools);
    }
    return true;
  }, [updateThread]);
  const openRewind = useCallback(() => {
    if (!activeRef.current) { setError("请先打开一段聊天。"); return; }
    if (runningRef.current.has(activeRef.current.id)) { setError("请先停止当前回合，再选择分支位置。"); return; }
    setIsRewindOpen(true);
  }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
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
  const preview = !window.boss && activeSession?.projectId !== HARNESS_PROJECT_ID;
  return <>
    <AppShell isDark={isDark} onToggleTheme={() => setIsDark(previous => !previous)} isSidebarOpen={isSidebarOpen} onToggleSidebar={() => setIsSidebarOpen(previous => !previous)}
      folders={folders} activeSession={activeSession} isHomeView={isHomeView} messages={messages} currentMode={currentMode} onModeChange={setCurrentMode}
      onSelectSession={handleSelectSession} onNewTask={handleNewTask} onSendMessage={handleSendMessage} simulateLocal={preview} harnessUp={harnessUp}
      running={Boolean(activeSession && runningThreadIds.has(activeSession.id))} taskBlocked={startingSession}
      onInterrupt={handleInterrupt} onApprovalDecision={handleApproval} onStartSessionWithPrompt={handleStartSessionWithPrompt} activeModelId={activeModelId} configuredModelLabel={configuredModelLabel} onSelectModel={setActiveModelId}
      onOpenCockpit={() => setIsCockpitOpen(true)} onOpenSideChat={() => setIsSideChatOpen(previous => !previous)} onOpenRewind={openRewind}
      onOpenShortcuts={() => setIsShortcutsOpen(true)} onReviewDiff={() => setIsDiffModalOpen(true)} onRevertDiff={() => setIsRevertModalOpen(true)} />
    {error && <div className="app-toast" role="alert"><span>{error}</span>{!harnessUp && window.boss && <button onClick={() => { void reconnectHarness(); }}>重新连接</button>}<button onClick={() => setError("")} aria-label="关闭提示"><IconClose size={14} /></button></div>}
    <CockpitModal isOpen={isCockpitOpen} onClose={() => setIsCockpitOpen(false)} />
    <SideChatModal isOpen={isSideChatOpen} onClose={() => setIsSideChatOpen(false)} />
    <RewindOverlay messages={messages} fork={!preview} isOpen={isRewindOpen} onClose={() => setIsRewindOpen(false)} onConfirmRewind={messageCount => {
      const id = activeRef.current?.id;
      if (!id) return;
      if (preview) { updateThread(id, previous => previous.slice(0, messageCount)); return; }
      const turnId = [...messages.slice(0, messageCount)].reverse().find(message => message.turnId)?.turnId;
      if (!turnId) { setError("所选消息没有完整回合信息，请刷新会话后再试。"); return; }
      void forkThread(id, turnId).then(session => {
        if (!session) { setError("创建分支失败；请选择已结束且工具已收尾的回合。"); return; }
        insertSession(session); handleSelectSession(session);
      });
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
