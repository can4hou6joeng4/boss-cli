import { useState, useEffect, useCallback, useRef } from "react";
import { AppShell } from "./shell/AppShell";
import { CockpitModal } from "./components/CockpitModal";
import { ContextPanel } from "./components/ContextPanel";
import { useContextPanel } from "./data/useContextPanel";
import { useSessionReasoning } from "./data/useSessionReasoning";
import { SideChatModal } from "./components/SideChatModal";
import { RewindOverlay } from "./components/RewindOverlay";
import { UnifiedDiffModal } from "./components/UnifiedDiffModal";
import { RevertConfirmModal } from "./components/RevertConfirmModal";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { IconClose } from "./components/Icons";
import { MOCK_PROJECT_FOLDERS, MOCK_CONVERSATION_THREAD, type ProjectFolder, type SessionItem, type MessageItem, type ConversationMode } from "./data/mockData";
import { HARNESS_PROJECT_ID, HARNESS_PROJECT_NAME, configuredModels, harnessStatus, forkThread, interruptTurn, listThreads, listQueue, queueFollowUp, reconnectHarness, removeQueuedItem, respondApproval, sendTurn, setThreadModel, startThread, steerTurn, readTurnContinuation, continueTurn } from "./data/harnessBridge";
import { reduceHarnessEvent, type HarnessEvent } from "./data/harnessEvents";
import { HarnessReplica } from "./data/harnessReplica";
import { reduceModelRetry, settleModelRetryOnTurnEnd, type ModelRetryStatus } from "./data/modelRetry";
import { toMessage } from "./data/harnessBridge";
import type { ModelDescriptor, QueueItem, TurnContinuationReadResponse } from "@boss-cli/protocol";
import type { QueueIntent, QueueSubmissionCheck } from "./data/composerDraft";

const LEGACY_ROUTE_HINT = "该旧会话记录的模型不属于默认线路，请先在模型菜单中选择线路后再发送。";
function legacyRouteMismatch(session: { provider?: string; model?: string }, defaultModel: { provider: string; model: string } | null): boolean {
  return !session.provider && !!session.model && !!defaultModel && session.model !== defaultModel.model;
}

export function App(): JSX.Element {
  const [isDark, setIsDark] = useState(() => {
    try { const saved = localStorage.getItem("boss-cli.ui.theme"); if (saved) return saved === "dark"; } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  });
  const [harnessUp, setHarnessUp] = useState(false);
  const [continuationSupported, setContinuationSupported] = useState(false);
  const [isHomeView, setIsHomeView] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 700);
  const [folders, setFolders] = useState<ProjectFolder[]>(() => window.boss ? [] : MOCK_PROJECT_FOLDERS.map(folder => ({ ...folder, sessions: folder.sessions.map(session => ({ ...session, status: "completed" })) })));
  const [activeSession, setActiveSession] = useState<SessionItem | null>(null);
  const [currentMode, setCurrentMode] = useState<ConversationMode>("agent");
  const [activeModelId, setActiveModelId] = useState("deepseek-v4");
  const [activeModelProvider, setActiveModelProvider] = useState("DeepSeek");
  const [modelOptions, setModelOptions] = useState<ModelDescriptor[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; model: string } | null>(null);
  const [configuredModelLabel, setConfiguredModelLabel] = useState<string>();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [runningThreadIds, setRunningThreadIds] = useState(new Set<string>());
  const [continuationCheck, setContinuationCheck] = useState<{
    threadId: string; sourceTurnId: string; loading: boolean; submitting?: boolean;
    uncertain?: boolean; response?: TurnContinuationReadResponse; error?: string;
  } | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [modelRetries, setModelRetries] = useState<Record<string, ModelRetryStatus>>({});
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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
  const continuationReadGeneration = useRef(0);
  const continuationSubmitting = useRef<string | null>(null);
  const lastEsc = useRef(0);
  const [isCockpitOpen, setIsCockpitOpen] = useState(false), [isSideChatOpen, setIsSideChatOpen] = useState(false);
  const [isRewindOpen, setIsRewindOpen] = useState(false), [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [isRevertModalOpen, setIsRevertModalOpen] = useState(false), [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const contextThreadId = activeSession?.projectId === HARNESS_PROJECT_ID && !isHomeView ? activeSession.id : null;
  const contextPanel = useContextPanel(contextThreadId, harnessUp, runningThreadIds);
  const sessionReasoning = useSessionReasoning(contextThreadId, harnessUp);
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
  /** 重试状态只用于观测：按会话保存，回合开始、断连或会话收尾时清理；已恢复的提示短暂停留后自动消失。 */
  const updateModelRetry = useCallback((id: string, change: (previous: ModelRetryStatus | undefined) => ModelRetryStatus | undefined) => {
    setModelRetries(previous => {
      const next = change(previous[id]);
      if (next === previous[id]) return previous;
      const copy = { ...previous };
      if (next) copy[id] = next; else delete copy[id];
      return copy;
    });
  }, []);
  const clearModelRetry = useCallback((id: string, keep?: (status: ModelRetryStatus) => boolean) => {
    const timer = retryTimers.current.get(id);
    if (timer && !keep) { clearTimeout(timer); retryTimers.current.delete(id); }
    updateModelRetry(id, previous => previous && keep?.(previous) ? previous : undefined);
  }, [updateModelRetry]);
  const insertSession = useCallback((session: SessionItem) => {
    setFolders(previous => {
      const exists = previous.some(folder => folder.id === session.projectId);
      if (!exists) return [{ id: session.projectId, name: session.projectId === HARNESS_PROJECT_ID ? HARNESS_PROJECT_NAME : "招聘项目", sessions: [session] }, ...previous];
      return previous.map(folder => folder.id === session.projectId ? { ...folder, sessions: [session, ...folder.sessions.filter(item => item.id !== session.id)] } : folder);
    });
  }, []);
  const readContinuationCheck = useCallback(async (session: SessionItem, explicitRejection?: string) => {
    const sourceTurnId = session.lastTurnStatus === "interrupted" ? session.turnId : undefined;
    const generation = ++continuationReadGeneration.current;
    if (!window.boss || !continuationSupported || !sourceTurnId || session.projectId !== HARNESS_PROJECT_ID) {
      setContinuationCheck(null);
      return;
    }
    setContinuationCheck({ threadId: session.id, sourceTurnId, loading: true });
    try {
      const response = await readTurnContinuation({ threadId: session.id, sourceTurnId });
      if (generation !== continuationReadGeneration.current || activeRef.current?.id !== session.id) return;
      if (response.threadId !== session.id || response.sourceTurnId !== sourceTurnId) {
        throw new Error("预检结果与来源回合不一致");
      }
      setContinuationCheck({ threadId: session.id, sourceTurnId, loading: false, response,
        error: response.eligible ? explicitRejection : undefined });
    } catch (error) {
      if (generation !== continuationReadGeneration.current || activeRef.current?.id !== session.id) return;
      const rpc = error && typeof error === "object" ? error as { rpcError?: unknown; message?: unknown; data?: unknown } : null;
      const rpcData = rpc?.data && typeof rpc.data === "object" ? rpc.data as Record<string, unknown> : null;
      if (rpc?.rpcError === true && typeof rpc.message === "string") {
        const reasonCode = typeof rpcData?.code === "string" ? rpcData.code : undefined;
        setContinuationCheck({ threadId: session.id, sourceTurnId, loading: false,
          error: `预检被内核拒绝：${rpc.message}${reasonCode ? `（${reasonCode}）` : ""}` });
        return;
      }
      setContinuationCheck({ threadId: session.id, sourceTurnId, loading: false,
        error: "无法确认该中断回合是否可续接。刷新状态前不会发送续接请求。" });
    }
  }, [continuationSupported]);
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
      if (["queue/updated", "turn/steeringApplied", "turn/started", "turn/completed"].includes(event.method)) {
        void listQueue(id).then(items => {
          if (items && activeRef.current?.id === id) setQueueItems(items);
        });
      }
      if (["thread/created", "thread/archived", "thread/unarchived", "thread/renamed", "thread/model/updated"].includes(event.method)) { void refresh(); return; }
      if (event.method === "turn/started") {
        lifecycleVersion.current += 1;
        clearModelRetry(id);
        if (params.turnId) turnIds.current.set(id, params.turnId);
        if (activeRef.current?.id === id) setContinuationCheck(null);
        markRunning(id, true); return;
      }
      if (params.kind !== "userMessage" && params.turnId && turnIds.current.has(id) && turnIds.current.get(id) !== params.turnId) return;
      if (event.method === "approval/requested" && params.approvalId && !params.consequential && params.toolName && rememberedApprovals.current.get(id)?.has(params.toolName)) {
        void respondApproval(params.approvalId, true); return;
      }
      if (event.method === "model/retryStarted" || event.method === "model/retryEnded") {
        const receivedAt = Date.now();
        updateModelRetry(id, previous => reduceModelRetry(previous, event.method, event.params, receivedAt));
        const timer = retryTimers.current.get(id);
        if (timer) { clearTimeout(timer); retryTimers.current.delete(id); }
        if (event.method === "model/retryEnded" && event.params?.success === true) {
          retryTimers.current.set(id, setTimeout(() => {
            retryTimers.current.delete(id);
            updateModelRetry(id, previous => previous?.phase === "recovered" && previous.receivedAt === receivedAt ? undefined : previous);
          }, 5000));
        }
        return;
      }
      if (event.method === "session/error") { setError(params.message ?? "任务遇到错误，请检查后重试。"); return; }
      if (event.method === "thread/updated") {
        lifecycleVersion.current += 1; markRunning(id, false);
        // 回合已收尾：等待中的重试不再成立（中断转为“已停止”）；终态说明保留到下一回合、自动消失或手动关闭。
        updateModelRetry(id, previous => settleModelRetryOnTurnEnd(previous, params.status, Date.now()));
        void replica.resume(id); void refresh(); return;
      }
      updateThread(id, previous => reduceHarnessEvent(previous, event));
    }, snapshot => {
      if (cancelled) return;
      const id = snapshot.thread.id;
      if (activeRef.current?.id === id) setQueueItems(snapshot.queue ?? []);
      const real = snapshot.items.map(toMessage).filter((item): item is MessageItem => item !== null);
      updateThread(id, () => real);
      if (snapshot.activeTurnId) turnIds.current.set(id, snapshot.activeTurnId);
      else clearModelRetry(id, status => status.phase !== "waiting");
      markRunning(id, Boolean(snapshot.activeTurnId));
    });
    replicaRef.current = replica;
    function refresh(): Promise<void> {
      if (refreshing) { refreshAgain = true; return refreshing; }
      refreshing = (async () => {
        const status = await harnessStatus(); if (cancelled) return;
        setHarnessUp(status?.running ?? false);
        setContinuationSupported(status?.capabilities?.explicitTurnContinuation === true);
        if (!status?.running) {
          if (status?.state === "disconnected" || status?.state === "stopped") setError(status?.error ?? "本地内核未连接，可重新连接后恢复会话。");
          return;
        }
        const processDefault = status.modelBridge
          ? { provider: status.modelBridge.provider, model: status.modelBridge.model }
          : null;
        if (processDefault) {
          const initial = processDefault;
          setDefaultModel(initial);
          if (!activeRef.current || activeRef.current.projectId !== HARNESS_PROJECT_ID) {
            setActiveModelProvider(initial.provider); setActiveModelId(initial.model);
          }
          setConfiguredModelLabel(`${initial.provider} · ${initial.model}`);
        }
        const modelCatalog = await configuredModels();
        if (cancelled) return;
        setModelOptions(modelCatalog.filter(model => model.configured && model.available));
        const version = lifecycleVersion.current;
        const sessions = await listThreads(); if (cancelled) return;
        if (version === lifecycleVersion.current) {
          const next = new Set(sessions.filter(session => session.status === "running").map(session => session.id));
          runningRef.current = next; setRunningThreadIds(next);
          for (const session of sessions) if (session.turnId) turnIds.current.set(session.id, session.turnId);
        }
        for (const session of sessions) session.status = runningRef.current.has(session.id) ? "running"
          : session.lastTurnStatus === "interrupted" ? "interrupted" : "idle";
        setFolders([{ id: HARNESS_PROJECT_ID, name: HARNESS_PROJECT_NAME, sessions }]);
        const active = activeRef.current;
        if (active?.projectId === HARNESS_PROJECT_ID) {
          const summary = sessions.find(session => session.id === active.id);
          if (summary) {
            activeRef.current = summary; setActiveSession(summary);
            void readContinuationCheck(summary);
            const provider = summary.provider ?? processDefault?.provider ?? active.provider;
            const model = summary.model ?? modelCatalog.find(candidate => candidate.provider === provider)?.id ?? processDefault?.model ?? active.model;
            if (provider && model) {
              setActiveModelProvider(provider); setActiveModelId(model); setConfiguredModelLabel(`${provider} · ${model}`);
            }
          }
          await replica.resume(active.id);
        }
      })().finally(() => { refreshing = null; if (refreshAgain && !cancelled) { refreshAgain = false; void refresh(); } });
      return refreshing;
    }
    const unsubscribe = window.boss.onNotification(raw => {
      const event = raw as HarnessEvent;
      if (event.method === "harness/connectionStatus") {
        if (event.params?.state === "ready") { setError(""); void refresh(); }
        else { setHarnessUp(false); setContinuationSupported(false); }
        return;
      }
      if (event.method === "harness/disconnected") {
        replica.invalidate(); setHarnessUp(false); setContinuationSupported(false); setConfiguredModelLabel(undefined); setModelOptions([]);
        for (const timer of retryTimers.current.values()) clearTimeout(timer);
        retryTimers.current.clear(); setModelRetries({});
        setError("本地内核已断开，正在恢复连接；结果未确认的对外操作请先核对平台状态。");
        for (const id of runningRef.current) markRunning(id, false);
        return;
      }
      replica.ingest(event);
    });
    void refresh();
    return () => { cancelled = true; replica.invalidate(); unsubscribe(); if (replicaRef.current === replica) replicaRef.current = null; };
  }, [clearModelRetry, markRunning, readContinuationCheck, updateModelRetry, updateThread]);
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    for (const timer of retryTimers.current.values()) clearTimeout(timer);
  }, []);
  const handleSelectSession = useCallback((session: SessionItem) => {
    const requestVersion = ++selectionVersion.current;
    activeRef.current = session; setActiveSession(session); setIsHomeView(false); setError("");
    if (legacyRouteMismatch(session, defaultModel)) setError(LEGACY_ROUTE_HINT);
    const provider = session.provider ?? defaultModel?.provider ?? activeModelProvider;
    const model = session.model ?? (provider === defaultModel?.provider ? defaultModel.model : undefined)
      ?? modelOptions.find(candidate => candidate.provider === provider)?.id ?? activeModelId;
    setActiveModelProvider(provider); setActiveModelId(model);
    setConfiguredModelLabel(legacyRouteMismatch(session, defaultModel) ? `需选择线路 · ${model}` : `${provider} · ${model}`);
    setQueueItems([]);
    void readContinuationCheck(session);
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
      else {
        const provider = snapshot.thread.provider ?? defaultModel?.provider ?? activeModelProvider;
        const model = snapshot.thread.model ?? (provider === defaultModel?.provider ? defaultModel.model : undefined)
          ?? modelOptions.find(candidate => candidate.provider === provider)?.id ?? activeModelId;
        const updated = { ...session, provider: snapshot.thread.provider, model: snapshot.thread.model };
        activeRef.current = updated; setActiveSession(updated);
        const needsRoute = legacyRouteMismatch(updated, defaultModel);
        if (needsRoute) setError(LEGACY_ROUTE_HINT);
        setActiveModelProvider(provider); setActiveModelId(model); setConfiguredModelLabel(needsRoute ? `需选择线路 · ${model}` : `${provider} · ${model}`);
      }
    });
  }, [activeModelId, activeModelProvider, defaultModel, modelOptions, readContinuationCheck]);
  const handleNewTask = useCallback(() => {
    ++selectionVersion.current; ++continuationReadGeneration.current;
    activeRef.current = null; setActiveSession(null); setMessages([]); setIsHomeView(true); setError(""); setContinuationCheck(null);
    if (defaultModel) { setActiveModelProvider(defaultModel.provider); setActiveModelId(defaultModel.model); setConfiguredModelLabel(`${defaultModel.provider} · ${defaultModel.model}`); }
  }, [defaultModel]);
  const createConnectionSession = async (): Promise<SessionItem | null> => {
    if (!window.boss || !harnessUp || startingRef.current) return null;
    startingRef.current = true; setStartingSession(true);
    try {
      const session = await startThread("BOSS 直聘账号连接", activeModelId, activeModelProvider);
      if (session) { insertSession(session); handleSelectSession(session); }
      return session;
    } catch { setError("连接会话尚未创建，请检查本机连接后重试。"); return null; }
    finally { startingRef.current = false; setStartingSession(false); }
  };
  const simulate = useCallback((id: string) => {
    markRunning(id, true);
    timers.current.set(id, setTimeout(() => {
      updateThread(id, previous => [...previous, { id: "preview-agent-" + Date.now(), role: "agent", thinkingTime: "界面演示", paragraphs: ["已记录这条示例任务。正式执行时，BOSS-CLI 会依据岗位需求、履历事实和你的偏好逐步推进，并在需要对外操作时请你确认。", "当前为界面预览，未调用模型或招聘平台。"] }]);
      markRunning(id, false); timers.current.delete(id);
    }, 1300));
  }, [markRunning, updateThread]);
  const handleSelectModel = useCallback(async (provider: string, model: string): Promise<boolean> => {
    const session = activeRef.current;
    if (session?.projectId === HARNESS_PROJECT_ID && !isHomeView) {
      if (!harnessUp || runningRef.current.has(session.id)) return false;
      const selectionVersionAtStart = selectionVersion.current;
      try {
        await setThreadModel(session.id, provider, model);
      } catch (error) {
        if (selectionVersion.current === selectionVersionAtStart && activeRef.current?.id === session.id) {
          const data = (error as { data?: { code?: unknown } } | null)?.data;
          setError(data?.code === "MODEL_SWITCH_QUEUE_PENDING"
            ? "会话仍有排队消息，请先处理或移除队列后再切换模型线路；当前会话选择保持不变。"
            : "模型设置失败；当前会话选择保持不变。");
        }
        return false;
      }
      const updated = { ...session, provider, model, reasoningEffort: null };
      setFolders(previous => previous.map(folder => ({
        ...folder,
        sessions: folder.sessions.map(item => item.id === updated.id ? { ...item, provider, model, reasoningEffort: null } : item),
      })));
      if (selectionVersion.current !== selectionVersionAtStart || activeRef.current?.id !== session.id) return true;
      activeRef.current = updated; setActiveSession(updated); setError("");
      void sessionReasoning.refresh(); void readContinuationCheck(updated);
    }
    setActiveModelProvider(provider); setActiveModelId(model); setConfiguredModelLabel(`${provider} · ${model}`);
    return true;
  }, [harnessUp, isHomeView, readContinuationCheck, sessionReasoning]);
  const send = useCallback(async (id: string, text: string, real: boolean, model: string | undefined, skillIds: string[] = []): Promise<boolean> => {
    if (real && !harnessUp) { setError("本地内核未连接，请重启应用后再发起任务。"); return false; }
    if (runningRef.current.has(id)) { setError("该会话仍在运行，请等待结束或停止后再发送。"); return false; }
    const clientId = crypto.randomUUID();
    updateThread(id, previous => [...previous, { id: clientId, role: "user", content: text }]);
    if (!real) { simulate(id); return true; }
    markRunning(id, true);
    try {
      const accepted = await sendTurn(id, text, clientId, model, skillIds);
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
  }, [harnessUp, updateThread, markRunning, simulate]);
  const handleStartSessionWithPrompt = useCallback((prompt: string, _domain: string, provider: string, modelId: string, skillIds: string[] = []) => {
    return (async () => {
      if (window.boss && !harnessUp) { setError("本地内核未连接，请检查启动配置并重启应用。"); return null; }
      if (startingRef.current) { setError("已有任务正在创建或运行，请等待结束或停止后再创建。"); return null; }
      const requestVersion = selectionVersion.current;
      startingRef.current = true; setStartingSession(true);
      try {
        setActiveModelId(modelId);
        setActiveModelProvider(provider);
        const started = harnessUp ? await startThread(prompt.slice(0, 32), modelId, provider) : { id: "preview-" + Date.now(), title: prompt.slice(0, 32), timeAgo: "刚刚", status: "idle" as const, projectId: MOCK_PROJECT_FOLDERS[0]?.id ?? "preview", provider, model: modelId };
        if (!started) { setError("创建会话失败，请检查本地内核连接后重试。"); return null; }
        insertSession(started);
        const transferred = await send(started.id, prompt, started.projectId === HARNESS_PROJECT_ID, started.model ?? modelId, skillIds);
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
  const handleSendMessage = useCallback((text: string, skillIds: string[] = []) => {
    const session = activeRef.current; if (!session || !text.trim()) return false;
    if (session.projectId !== HARNESS_PROJECT_ID) return send(session.id, text, false, activeModelId, skillIds);
    if (legacyRouteMismatch(session, defaultModel)) { setError(LEGACY_ROUTE_HINT); return false; }
    // 会话线路由内核持久化的 provider/model 决定；只发送会话自身记录的模型，避免切换后携带旧选择。
    return send(session.id, text, true, session.model, skillIds);
  }, [send, activeModelId, defaultModel]);
  const handleContinueInterruptedTurn = useCallback(async () => {
    const check = continuationCheck;
    if (!harnessUp || !continuationSupported) {
      setContinuationCheck(previous => previous ? { ...previous, error: !harnessUp
        ? "本地内核未连接。重新连接并刷新预检状态后再操作。"
        : "当前本地内核版本不支持显式续接。" } : previous);
      return;
    }
    if (!check?.response?.eligible || check.loading || check.submitting || check.uncertain ||
        activeRef.current?.id !== check.threadId) return;
    const key = `${check.threadId}:${check.sourceTurnId}`;
    if (continuationSubmitting.current === key) return;
    continuationSubmitting.current = key;
    setContinuationCheck(previous => previous && previous.threadId === check.threadId && previous.sourceTurnId === check.sourceTurnId
      ? { ...previous, submitting: true, error: undefined } : previous);
    const continuationId = crypto.randomUUID();
    try {
      const response = await continueTurn({ threadId: check.threadId, sourceTurnId: check.sourceTurnId, continuationId });
      if (response.continuedFromTurnId !== check.sourceTurnId || response.continuationId !== continuationId || !response.turnId) {
        throw new Error("续接回执与请求不一致");
      }
      turnIds.current.set(check.threadId, response.turnId);
      setContinuationCheck(null);
      markRunning(check.threadId, true);
      void replicaRef.current?.resume(check.threadId);
    } catch (error) {
      const rpc = error && typeof error === "object" ? error as { rpcError?: unknown; message?: unknown; data?: unknown } : null;
      const rpcData = rpc?.data && typeof rpc.data === "object" ? rpc.data as Record<string, unknown> : null;
      if (rpc?.rpcError === true && typeof rpc.message === "string") {
        const reasonCode = typeof rpcData?.code === "string" ? rpcData.code : undefined;
        const rejection = `续接被内核拒绝：${rpc.message}${reasonCode ? `（${reasonCode}）` : ""}`;
        const session = activeRef.current;
        if (session?.id === check.threadId) void readContinuationCheck(session, rejection);
        else setContinuationCheck(previous => previous && previous.threadId === check.threadId
          ? { ...previous, submitting: false, error: rejection } : previous);
        return;
      }
      setContinuationCheck(previous => previous && previous.threadId === check.threadId && previous.sourceTurnId === check.sourceTurnId
        ? { ...previous, submitting: false, uncertain: true,
            error: "续接请求的回执尚未确认。请先刷新状态；本次不会自动重发。" } : previous);
      void replicaRef.current?.resume(check.threadId);
    } finally {
      if (continuationSubmitting.current === key) continuationSubmitting.current = null;
    }
  }, [continuationCheck, continuationSupported, harnessUp, markRunning, readContinuationCheck]);
  const handleQueueMessage = useCallback(async (text: string, intent: QueueIntent, clientUserMessageId: string): Promise<boolean> => {
    const session = activeRef.current;
    if (!session || session.projectId !== HARNESS_PROJECT_ID || !harnessUp || !text.trim()) return false;
    if (intent === "steering") {
      const expectedTurnId = turnIds.current.get(session.id);
      if (!runningRef.current.has(session.id) || !expectedTurnId) {
        setError("当前回合已结束或状态尚未同步；消息仍保留在输入框，请刷新后再提交。");
        await replicaRef.current?.resume(session.id);
        return false;
      }
      const item = await steerTurn({ threadId: session.id, expectedTurnId, input: text, clientUserMessageId });
      if (activeRef.current?.id === session.id) setQueueItems(previous => [...previous.filter(existing => existing.id !== item.id), item]);
      return true;
    }
    const item = await queueFollowUp({ threadId: session.id, input: text, clientUserMessageId });
    if (activeRef.current?.id === session.id) setQueueItems(previous => [...previous.filter(existing => existing.id !== item.id), item]);
    return true;
  }, [harnessUp]);
  const handleCheckQueueSubmission = useCallback(async (clientUserMessageId: string): Promise<QueueSubmissionCheck> => {
    const session = activeRef.current;
    if (!session || session.projectId !== HARNESS_PROJECT_ID || !harnessUp) return { status: "unavailable" };
    const items = await listQueue(session.id);
    if (!items) return { status: "unavailable" };
    if (activeRef.current?.id === session.id) setQueueItems(items);
    const item = items.find(candidate => candidate.clientUserMessageId === clientUserMessageId);
    if (!item) return { status: "missing" };
    return item.status === "cancelled" ? { status: "cancelled", item } : { status: "found", item };
  }, [harnessUp]);
  const handleRemoveQueueItem = useCallback(async (queueId: string): Promise<boolean> => {
    const session = activeRef.current;
    if (!session || session.projectId !== HARNESS_PROJECT_ID || !harnessUp) return false;
    try {
      const item = await removeQueuedItem(session.id, queueId);
      if (activeRef.current?.id === session.id) setQueueItems(previous => previous.map(existing => existing.id === item.id ? item : existing));
      return true;
    } catch {
      if (activeRef.current?.id !== session.id) return false;
      setError("撤回结果尚未确认，正在刷新队列状态；不会自动重复撤回。");
      const items = await listQueue(session.id);
      if (items && activeRef.current?.id === session.id) setQueueItems(items);
      return false;
    }
  }, [harnessUp]);
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
      onSelectSession={handleSelectSession} onNewTask={handleNewTask} onSendMessage={handleSendMessage} onQueueMessage={handleQueueMessage} onCheckQueueSubmission={handleCheckQueueSubmission} queueItems={queueItems} onRemoveQueueItem={handleRemoveQueueItem} simulateLocal={preview} harnessUp={harnessUp}
      onCreateConnectionSession={createConnectionSession}
      sessionReasoning={contextThreadId ? sessionReasoning : undefined}
      running={Boolean(activeSession && runningThreadIds.has(activeSession.id))} taskBlocked={startingSession}
      continuationCheck={continuationCheck} onContinueInterruptedTurn={handleContinueInterruptedTurn}
      modelRetry={activeSession && !isHomeView ? modelRetries[activeSession.id] : undefined}
      onDismissModelRetry={() => { const id = activeRef.current?.id; if (id) clearModelRetry(id); }}
      onInterrupt={handleInterrupt} onApprovalDecision={handleApproval} onStartSessionWithPrompt={handleStartSessionWithPrompt} models={modelOptions} activeModelProvider={activeModelProvider} activeModelId={activeModelId} configuredModelLabel={configuredModelLabel} onSelectModel={handleSelectModel}
      onOpenCockpit={() => setIsCockpitOpen(true)} onOpenSideChat={() => setIsSideChatOpen(previous => !previous)} onOpenRewind={openRewind} onOpenContext={contextThreadId ? contextPanel.open : undefined}
      onOpenShortcuts={() => setIsShortcutsOpen(true)} onReviewDiff={() => setIsDiffModalOpen(true)} onRevertDiff={() => setIsRevertModalOpen(true)} />
    {error && <div className="app-toast" role="alert"><span>{error}</span>{!harnessUp && window.boss && <button onClick={() => { void reconnectHarness(); }}>重新连接</button>}<button onClick={() => setError("")} aria-label="关闭提示"><IconClose size={14} /></button></div>}
    <CockpitModal isOpen={isCockpitOpen} onClose={() => setIsCockpitOpen(false)} />
    <ContextPanel isOpen={contextPanel.isOpen} onClose={contextPanel.close} threadId={contextThreadId} title={activeSession?.title ?? ""} connected={harnessUp} busy={contextPanel.busy} state={contextPanel.state} onKeepRecentChange={contextPanel.changeKeepRecent} onRefresh={() => { void contextPanel.refresh(); }} onPlan={() => { void contextPanel.plan(); }} onStart={() => { void contextPanel.start(); }} onCancel={() => { void contextPanel.cancel(); }} />
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
