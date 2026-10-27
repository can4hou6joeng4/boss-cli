import { useState, useRef, useEffect, forwardRef } from "react";
import { IconPlus, IconSend, IconStop, IconShield, IconChevronDown, IconCheck, IconClose, IconFolder, IconSparkles, IconSettings, IconSearch, IconBranch, IconChat, IconLock } from "../components/Icons";
import { Popover } from "../components/Popover";
import { SlashCommandList, SLASH_COMMANDS, type SlashCommandItem } from "../components/SlashCommandList";
import { AtMentionList, filterMentions, type MentionItem } from "../components/AtMentionList";
import { MODEL_OPTIONS, type ConversationMode } from "../data/mockData";
import type { SkillDescriptor } from "@boss-cli/protocol";
import type { SkillCatalogState } from "../data/harnessBridge";
import type { SessionReasoningControl } from "../data/useSessionReasoning";
import { createComposerDraft, clearTransferredDraft, type ComposerDraft, type UpdateComposerDraft, type ComposerSend, type ComposerQueue, type QueueIntent, type CheckQueueSubmission } from "../data/composerDraft";
import "../styles/composer-menus.css";

export interface ComposerProps {
  readOnly?: boolean;
  value: string; onChange: (text: string) => void; onSend: ComposerSend;
  onQueue?: ComposerQueue;
  onCheckQueueSubmission?: CheckQueueSubmission;
  draft?: ComposerDraft; onDraftChange?: UpdateComposerDraft;
  isRunning?: boolean; blocked?: boolean; onInterrupt?: () => void; preview?: boolean;
  currentMode?: ConversationMode; onModeChange?: (mode: ConversationMode) => void;
  activeModelId?: string; configuredModelLabel?: string; onSelectModel?: (id: string) => void; onOpenSettings?: () => void;
  sessionReasoning?: SessionReasoningControl;
  skills?: SkillDescriptor[]; skillCatalogState?: SkillCatalogState; onRefreshSkills?: () => void;
  home?: boolean;
  onLogin?: () => void;
}
const MODES = [
  { id: "agent", name: "Agent", detail: "结合招聘工具持续推进任务", icon: IconSparkles },
  { id: "plan", name: "Plan", detail: "梳理目标并制定执行计划", icon: IconBranch },
  { id: "ask", name: "Ask", detail: "围绕当前上下文快速提问", icon: IconChat },
] as const;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 200000;

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({
  value, onChange, onSend, draft, onDraftChange, isRunning = false, blocked = false, onInterrupt, preview = true, readOnly = false,
  onQueue, onCheckQueueSubmission,
  currentMode = "agent", onModeChange, activeModelId, configuredModelLabel, onSelectModel, onOpenSettings, home = false, onLogin,
  skills = [], skillCatalogState = "unavailable", onRefreshSkills,
  sessionReasoning,
}, forwardedRef) {
  const [menu, setMenu] = useState<"add" | "permissions" | "mode" | "model" | "skills" | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [slashOpen, setSlashOpen] = useState(false), [mentionOpen, setMentionOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [localDraft, setLocalDraft] = useState(createComposerDraft);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [checkingQueue, setCheckingQueue] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const readingRef = useRef(false);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  const [queueIntent, setQueueIntent] = useState<QueueIntent>("steering");
  const lastValue = useRef(value), valueVersion = useRef(0);
  if (lastValue.current !== value) { lastValue.current = value; valueVersion.current += 1; }
  const composerDraft = draft && onDraftChange ? draft : { ...localDraft, text: value, textVersion: valueVersion.current };
  const draftRef = useRef(composerDraft); draftRef.current = composerDraft;
  const attachments = composerDraft.attachments;
  const selectedSkillIds = composerDraft.skillIds ?? [];
  const staleSkillIds = selectedSkillIds.filter(id => !skills.some(skill => skill.id === id));
  const readingAttachments = composerDraft.pendingReads > 0;
  const submitting = composerDraft.submitting;
  const uncertainQueue = composerDraft.queueSubmission?.uncertain ? composerDraft.queueSubmission : null;
  const queueModeActive = isRunning || Boolean(uncertainQueue?.intent === "followUp");
  const updateDraft: UpdateComposerDraft = change => {
    if (draft && onDraftChange) onDraftChange(change);
    else if (alive.current) setLocalDraft(previous => change({ ...previous, text: lastValue.current, textVersion: valueVersion.current }));
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dragDepth = useRef(0);
  const slashQuery = value.match(/^\/([^\s]*)$/)?.[1] ?? "";
  const mentionQuery = value.match(/(?:^|\s)@([^\s]*)$/)?.[1] ?? "";
  const modelName = preview ? (MODEL_OPTIONS.find(model => model.id === activeModelId)?.name.replace("Adaptive Router: ", "") ?? "默认模型") : (configuredModelLabel?.trim() || "配置的模型");
  const query = modelQuery.trim().toLowerCase();
  const filteredModels = MODEL_OPTIONS.filter(model => [model.name, model.provider].join(" ").toLowerCase().includes(query));
  const configuredModelMatches = [modelName, "启动配置 当前模型"].join(" ").toLowerCase().includes(query);
  const mode = MODES.find(item => item.id === currentMode) ?? MODES[0];

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(180, Math.max(home ? 66 : 52, inputRef.current.scrollHeight)) + "px";
    }
  }, [value, home]);
  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus());
  const toggleMenu = (next: typeof menu) => {
    setMenu(previous => previous === next ? null : next);
    setModelQuery(""); setSlashOpen(false); setMentionOpen(false);
  };
  const change = (text: string) => {
    onChange(text); setNotice(""); setSelectedIndex(0);
    setSlashOpen(/^\/[^\s]*$/.test(text));
    setMentionOpen(/(?:^|\s)@[^\s]*$/.test(text));
  };
  const selectSlash = (item: SlashCommandItem) => {
    setSlashOpen(false);
    onChange(/^\/[^\s]*$/.test(value) ? item.command + " " : `${item.command} ${value}`);
    focusInput();
  };
  const selectMention = (item: MentionItem) => {
    setMentionOpen(false); onChange(value.slice(0, value.lastIndexOf("@")) + "@" + item.name + " "); focusInput();
  };
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const started = draftRef.current;
    if (readingRef.current || started.pendingReads > 0) { setNotice("正在读取附件，请稍候。"); return; }
    if (sendingRef.current || started.submitting) { setNotice("正在转交消息，请稍候再添加附件。"); return; }
    if (files.length + started.attachments.length > MAX_ATTACHMENTS || files.some(file => file.size > MAX_ATTACHMENT_BYTES)) {
      setNotice("最多添加 4 个文本文件，每个文件不超过 200 KB。"); return;
    }
    if (files.some(file => !/\.(?:txt|md|markdown|json|csv)$/i.test(file.name))) {
      setNotice("请选择 TXT、Markdown、JSON 或 CSV 文本文件。"); return;
    }
    readingRef.current = true; setNotice("");
    updateDraft(previous => previous.id === started.id ? { ...previous, pendingReads: previous.pendingReads + 1 } : previous);
    try {
      const added = await Promise.all(files.map(async file => ({ id: crypto.randomUUID(), name: file.name, text: await file.text(), size: file.size })));
      updateDraft(previous => previous.id !== started.id || previous.attachments.length + added.length > MAX_ATTACHMENTS ? previous : { ...previous, attachments: [...previous.attachments, ...added] });
      const active = document.activeElement;
      if (alive.current && draftRef.current.id === started.id && (active === document.body || inputRef.current?.closest(".composer-surface")?.contains(active))) focusInput();
    } catch { if (alive.current && draftRef.current.id === started.id) setNotice("读取文件失败，请重新选择。"); }
    finally {
      readingRef.current = false;
      updateDraft(previous => previous.id === started.id ? { ...previous, pendingReads: Math.max(0, previous.pendingReads - 1) } : previous);
    }
  };
  const submit = async () => {
    const submitted = draftRef.current;
    const priorQueueSubmission = submitted.queueSubmission;
    const queueing = Boolean(onQueue && (isRunning || (priorQueueSubmission?.uncertain && priorQueueSubmission.intent === "followUp")));
    if ((!isRunning && blocked) || (isRunning && !queueing) || readingRef.current || submitted.pendingReads > 0 || sendingRef.current || submitted.submitting || (!submitted.text.trim() && !submitted.attachments.length)) return;
    if (queueing && (submitted.skillIds?.length ?? 0) > 0) {
      setNotice("队列消息暂不支持技能。请先清除已选技能，或等当前回合结束后直接发送。");
      return;
    }
    if (!queueing && (submitted.skillIds?.length ?? 0) > 0 && (skillCatalogState !== "ready" || submitted.skillIds?.some(id => !skills.some(skill => skill.id === id)))) {
      setNotice("所选技能尚未确认可用，请刷新技能目录或清除不可用技能后再发送。");
      return;
    }
    const text = [submitted.text.trim(), ...submitted.attachments.map(file => `附件：${file.name}\n\n${file.text}`)].filter(Boolean).join("\n\n");
    if (priorQueueSubmission?.uncertain) {
      const sameRequest = priorQueueSubmission.text === text && priorQueueSubmission.intent === queueIntent;
      if (!sameRequest) {
        setNotice("上一条队列消息结果尚未确认；恢复原消息和处理方式后才能用相同请求编号重试。");
        return;
      }
      if (!queueing) {
        setNotice("转向目标回合已结束。请先核对队列，再决定是否作为新消息提交。");
        return;
      }
    }
    sendingRef.current = true; setNotice("");
    updateDraft(previous => previous.id === submitted.id ? { ...previous, submitting: true } : previous);
    let queueRequest: ComposerDraft["queueSubmission"];
    try {
      let transferred: void | boolean;
      if (queueing && onQueue) {
        queueRequest = priorQueueSubmission?.text === text && priorQueueSubmission.intent === queueIntent
          ? priorQueueSubmission
          : { text, intent: queueIntent, id: crypto.randomUUID(), uncertain: false };
        updateDraft(previous => previous.id === submitted.id ? { ...previous, queueSubmission: queueRequest } : previous);
        transferred = await onQueue(text, queueIntent, queueRequest.id);
      } else {
        transferred = await onSend(text, submitted.skillIds ?? []);
      }
      if (transferred === false) {
        updateDraft(previous => previous.id === submitted.id ? { ...previous, submitting: false, ...(queueing ? { queueSubmission: undefined } : {}) } : previous);
        return;
      }
      if (!draft || !onDraftChange) {
        if (alive.current && draftRef.current.id === submitted.id && valueVersion.current === submitted.textVersion) onChange("");
      }
      updateDraft(previous => clearTransferredDraft(previous, submitted));
      if (alive.current && draftRef.current.id === submitted.id) { setSlashOpen(false); setMentionOpen(false); setMenu(null); }
    } catch {
      // 回调异常不能证明消息未转交；保留内容和提交锁，避免直接重复发送。
      if (alive.current && draftRef.current.id === submitted.id) setNotice(queueing
        ? "队列提交结果尚未确认；恢复原消息后再次提交会使用同一请求编号。"
        : "提交结果尚未确认，请先核对聊天记录；不会自动重复提交。");
      if (queueing && queueRequest) {
        updateDraft(previous => previous.id === submitted.id
          ? { ...previous, submitting: false, queueSubmission: { ...queueRequest!, uncertain: true } }
          : previous);
      }
    } finally { sendingRef.current = false; }
  };
  const restoreQueueSubmission = () => {
    const pending = draftRef.current.queueSubmission;
    if (!pending?.uncertain) return;
    onChange(pending.text);
    updateDraft(previous => previous.id === draftRef.current.id
      ? { ...previous, text: pending.text, textVersion: previous.textVersion + 1, attachments: [], queueSubmission: pending }
      : previous);
    setQueueIntent(pending.intent);
    setNotice("已恢复原队列消息；重试会沿用原请求编号。");
  };
  const checkUncertainQueueSubmission = async () => {
    const pending = draftRef.current.queueSubmission;
    if (!pending?.uncertain || !onCheckQueueSubmission || checkingQueue) return;
    setCheckingQueue(true);
    setNotice("正在核对内核队列…");
    try {
      const result = await onCheckQueueSubmission(pending.id);
      if (!alive.current) return;
      if (result.status === "unavailable") {
        setNotice("暂时无法读取内核队列；草稿和请求编号已保留，请连接恢复后再核对。");
        return;
      }
      if (result.status === "found") {
        updateDraft(previous => {
          if (previous.id !== draftRef.current.id) return previous;
          const currentText = [previous.text.trim(), ...previous.attachments.map(file => `附件：${file.name}\n\n${file.text}`)].filter(Boolean).join("\n\n");
          const matchesPending = currentText === pending.text;
          return { ...previous, text: matchesPending ? "" : previous.text,
            textVersion: previous.textVersion + (matchesPending && previous.text ? 1 : 0),
            attachments: matchesPending ? [] : previous.attachments, submitting: false, queueSubmission: undefined };
        });
        setNotice(`已核对：原消息在队列中，状态为${result.item.status === "queued" ? "排队中" : result.item.status === "delivering" ? "正在投递" : result.item.status === "delivered" ? "已投递" : "已暂停"}；不会重复提交。`);
        return;
      }
      updateDraft(previous => previous.id === draftRef.current.id ? { ...previous, submitting: false, queueSubmission: undefined } : previous);
      setNotice(result.status === "cancelled" ? "已核对：原消息已撤回；当前输入可作为新请求提交。" : "已核对：队列中没有原消息；当前输入可作为新请求提交。");
    } catch {
      if (alive.current) setNotice("核对内核队列失败；草稿和请求编号已保留，请稍后重试。");
    } finally {
      if (alive.current) setCheckingQueue(false);
    }
  };
  const selectModel = (id: string) => { onSelectModel?.(id); setMenu(null); focusInput(); };
  const selectReasoning = async (effort: string | null) => {
    if (!sessionReasoning || sessionReasoning.pending) return;
    await sessionReasoning.select(effort);
  };
  const toggleSkill = (id: string) => updateDraft(previous => {
    const current = previous.skillIds ?? [];
    if (current.includes(id)) return { ...previous, skillIds: current.filter(skillId => skillId !== id) };
    return current.length >= 10 ? previous : { ...previous, skillIds: [...current, id] };
  });

  return <div className={`composer-surface ${home ? "home-composer" : ""} ${dragging ? "composer-drop-active" : ""}`}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }}
    onDrop={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
    {dragging && <div className="composer-drop-hint" aria-hidden="true"><IconFolder size={25} /><strong>添加文件作为上下文</strong><span>TXT、Markdown、JSON、CSV · 每个最多 200 KB</span></div>}
    {attachments.length > 0 && <div className="attachment-list">{attachments.map(file => <div className="attachment-chip" key={file.id} title={`${file.name} · ${Math.max(1, Math.ceil(file.size / 1000))} KB`}><IconFolder size={15} /><span>{file.name}<small>{Math.max(1, Math.ceil(file.size / 1000))} KB · 文本</small></span><button type="button" aria-label={`移除附件 ${file.name}`} onClick={() => updateDraft(previous => ({ ...previous, attachments: previous.attachments.filter(item => item.id !== file.id) }))}><IconClose size={12} /></button></div>)}</div>}
    <SlashCommandList isOpen={slashOpen} onClose={() => setSlashOpen(false)} onSelect={selectSlash} search={slashQuery} selectedIndex={selectedIndex} />
    <AtMentionList isOpen={mentionOpen} onClose={() => setMentionOpen(false)} onSelect={selectMention} search={mentionQuery} selectedIndex={selectedIndex} />
    <textarea aria-label="消息输入" ref={element => { inputRef.current = element; if (typeof forwardedRef === "function") forwardedRef(element); else if (forwardedRef) forwardedRef.current = element; }} rows={2}
      placeholder={isRunning ? queueIntent === "steering" ? "补充当前任务要求…" : "安排当前任务结束后的下一步…" : blocked ? "另一个任务正在运行，请等待完成" : "和 BOSS-CLI 一起工作"}
      value={value} onChange={event => change(event.target.value)}
      onPaste={event => {
        const files = [...event.clipboardData.files];
        if (files.length) { event.preventDefault(); void addFiles(files); return; }
        const text = event.clipboardData.getData("text/plain");
        if (text.length >= 5000 && attachments.length < MAX_ATTACHMENTS && !readingRef.current && !readingAttachments && !submitting) {
          const file = new File([text], "粘贴的文本.txt", { type: "text/plain" });
          if (file.size <= MAX_ATTACHMENT_BYTES) { event.preventDefault(); void addFiles([file]); }
        }
      }}
      onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
        if (slashOpen || mentionOpen) {
          const options = slashOpen ? SLASH_COMMANDS.filter(item => [item.command, item.label, item.description].join(" ").toLowerCase().includes(slashQuery.toLowerCase())) : filterMentions(mentionQuery);
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) { event.preventDefault(); setSelectedIndex(previous => (previous + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return; }
          if (event.key === "Enter" || event.key === "Tab") {
            const option = options[selectedIndex];
            if (option && !event.shiftKey) { event.preventDefault(); if (slashOpen) selectSlash(option as SlashCommandItem); else selectMention(option as MentionItem); return; }
            setSlashOpen(false); setMentionOpen(false);
          }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSlashOpen(false); setMentionOpen(false); return; }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
      }} />
    {queueModeActive && onQueue && <div className="composer-queue-mode" role="group" aria-label="运行中消息处理方式">
      <button type="button" aria-pressed={queueIntent === "steering"} title="当前已发出的工具调用完成后，在下一次模型请求前加入此消息。" onClick={() => setQueueIntent("steering")}>转向当前回合</button>
      <button type="button" aria-pressed={queueIntent === "followUp"} title="等当前任务自然结束后，再以新回合处理此消息。" onClick={() => setQueueIntent("followUp")}>排到后续回合</button>
    </div>}
    <div className="composer-controls">
      <div className="composer-control-left">
        <div className="popover-anchor">
          <button type="button" className={`composer-mode composer-skills-trigger ${menu === "skills" ? "is-open" : ""}`} aria-label={`选择运行时技能${selectedSkillIds.length ? `，已选 ${selectedSkillIds.length} 项` : ""}`} data-count={selectedSkillIds.length || undefined} title={queueModeActive ? "队列消息不应用技能，当前不能更改技能" : submitting ? "正在转交消息，暂不能更改技能" : "选择应用于消息的运行时技能"} aria-haspopup="menu" aria-expanded={menu === "skills"} disabled={queueModeActive || submitting} onClick={() => toggleMenu("skills")}><IconSparkles size={14} /><span>技能{selectedSkillIds.length ? ` ${selectedSkillIds.length}` : ""}</span><IconChevronDown size={10} /></button>
          <Popover open={menu === "skills"} onClose={() => setMenu(null)} above label="选择运行时技能" className="composer-action-menu composer-skills-menu">
            <div className="composer-menu-heading">运行时技能</div>
            {skillCatalogState === "loading" && <div className="composer-menu-empty">正在加载可用技能…</div>}
            {skillCatalogState === "unavailable" && <div className="composer-menu-empty">{preview ? "运行时技能仅在连接桌面 Harness 后可用。" : "连接本地 Harness 后可加载技能。"}</div>}
            {skillCatalogState === "error" && <div className="composer-menu-empty">无法加载技能目录，请重试。</div>}
            {skillCatalogState === "empty" && <div className="composer-menu-empty">当前工作区没有可用技能。</div>}
            {skillCatalogState === "ready" && skills.map(skill => <button type="button" role="menuitemcheckbox" aria-checked={selectedSkillIds.includes(skill.id)} key={skill.id} disabled={queueModeActive || submitting || (selectedSkillIds.length >= 10 && !selectedSkillIds.includes(skill.id))} onClick={() => toggleSkill(skill.id)}><IconSparkles /><span>{skill.name}<small>{skill.description || "无描述"}</small></span>{selectedSkillIds.includes(skill.id) && <IconCheck className="menu-check" />}</button>)}
            {skillCatalogState === "ready" && selectedSkillIds.length >= 10 && <div className="composer-menu-footer">每回合最多选择 10 项技能。</div>}
            {staleSkillIds.length > 0 && skillCatalogState === "ready" && <div className="composer-menu-empty">{staleSkillIds.length} 项已选技能已不在当前目录中。</div>}
            {staleSkillIds.length > 0 && skillCatalogState === "ready" && <button type="button" disabled={queueModeActive || submitting} onClick={() => updateDraft(previous => ({ ...previous, skillIds: previous.skillIds.filter(id => !staleSkillIds.includes(id)) }))}>清除不可用技能</button>}
            {selectedSkillIds.length > 0 && skillCatalogState !== "ready" && <button type="button" disabled={queueModeActive || submitting} onClick={() => updateDraft(previous => ({ ...previous, skillIds: [] }))}>清除已选技能</button>}
            {skillCatalogState !== "unavailable" && onRefreshSkills && <button type="button" disabled={queueModeActive || submitting || skillCatalogState === "loading"} onClick={onRefreshSkills}>{skillCatalogState === "error" ? "重试加载技能" : "刷新技能目录"}</button>}
            <div className="composer-menu-footer">所选技能仅应用于本次直接发送，转交成功后清空。</div>
          </Popover>
        </div>
        <div className="popover-anchor">
          <button type="button" className={`composer-icon ${menu === "add" ? "is-open" : ""}`} aria-label="添加附件或上下文" title="添加附件或上下文" aria-haspopup="menu" aria-expanded={menu === "add"} onClick={() => toggleMenu("add")}><IconPlus size={19} /></button>
          <Popover open={menu === "add"} onClose={() => setMenu(null)} above label="添加上下文" className="composer-action-menu">
            <div className="composer-menu-heading">添加上下文</div>
            <button type="button" disabled={readingAttachments || submitting || attachments.length >= MAX_ATTACHMENTS} onClick={() => { fileRef.current?.click(); setMenu(null); }}><IconFolder /><span>添加文件<small>TXT、Markdown、JSON、CSV</small></span><span className="menu-shortcut">本地</span></button>
            <button type="button" onClick={() => { change(value + (value && !/\s$/.test(value) ? " " : "") + "@"); setMenu(null); focusInput(); }}><IconPlus /><span>关联招聘对象<small>将职位、候选人等加入上下文</small></span><span className="menu-shortcut">@</span></button>
            <div className="menu-divider" />
            {onLogin && <button type="button" onClick={() => { setMenu(null); onLogin(); }}><IconLock /><span>连接 BOSS 直聘<small>在当前会话右侧扫码登录</small></span></button>}
            <button type="button" onClick={() => { if (!value.trim()) onChange("/"); setSlashOpen(true); setMentionOpen(false); setSelectedIndex(0); setMenu(null); focusInput(); }}><IconSparkles /><span>快捷指令</span><span className="menu-shortcut">/</span></button>
            <div className="composer-menu-footer">也可拖入文本文件，或粘贴较长文本作为附件。</div>
          </Popover>
        </div>
        <div className="popover-anchor">
          <button type="button" className={`permission-button ${menu === "permissions" ? "is-open" : ""}`} aria-label="执行权限" title="查看执行权限" aria-haspopup="menu" aria-expanded={menu === "permissions"} onClick={() => toggleMenu("permissions")}><IconShield size={15} /><span>{readOnly ? "只读会话" : "请求批准"}</span><IconChevronDown size={10} /></button>
          <Popover open={menu === "permissions"} onClose={() => setMenu(null)} above label="执行权限" className="composer-action-menu composer-permission-menu">
            <div className="composer-menu-heading">{readOnly ? "本会话允许哪些操作？" : "如何批准 BOSS-CLI 的操作？"}</div>
            <button type="button" role="menuitemradio" aria-checked="true" onClick={() => { setMenu(null); focusInput(); }}><IconShield /><span>{readOnly ? "只读会话" : "请求批准"}<small>{readOnly ? "可读取职位与履历，服务端禁止对外写操作" : "对外沟通、投递等操作前由你确认"}</small></span><IconCheck className="menu-check" /></button>
            <button type="button" role="menuitemradio" aria-checked="false" disabled title="当前连接暂不支持自动审批"><IconSparkles /><span>代我批准<small>当前连接暂不支持自动审批</small></span></button>
            <button type="button" role="menuitemradio" aria-checked="false" disabled title="当前运行配置不提供完全访问"><IconLock /><span>完全访问<small>当前运行配置不提供完全访问</small></span></button>
            <div className="composer-menu-footer">{preview ? "当前为界面预览。权限选择以连接后的运行配置为准。" : readOnly ? "只读限制随会话保存，重启和创建分支后继续生效。" : "权限由运行配置管理；涉及对外操作仍需明确授权。"}</div>
          </Popover>
        </div>
        <div className="popover-anchor">
          <button type="button" className={`composer-mode ${menu === "mode" ? "is-open" : ""}`} aria-label="任务模式" title="选择任务模式" aria-haspopup="menu" aria-expanded={menu === "mode"} onClick={() => toggleMenu("mode")}><mode.icon size={14} /><span>{preview ? mode.name : "Agent"}</span><IconChevronDown size={10} /></button>
          <Popover open={menu === "mode"} onClose={() => setMenu(null)} above label="任务模式" className="composer-action-menu composer-mode-menu">
            <div className="composer-menu-heading">任务模式{preview && <span className="composer-menu-badge">预览</span>}</div>
            {MODES.map(item => <button type="button" role="menuitemradio" aria-checked={(preview ? currentMode : "agent") === item.id} key={item.id} disabled={(!preview && item.id !== "agent") || !onModeChange} onClick={() => { onModeChange?.(item.id); setMenu(null); focusInput(); }}><item.icon /><span>{item.name}<small>{!preview && item.id !== "agent" ? "当前连接暂不支持此模式" : item.detail}</small></span>{(preview ? currentMode : "agent") === item.id && <IconCheck className="menu-check" />}</button>)}
          </Popover>
        </div>
      </div>
      <div className="composer-control-right">
        <div className="popover-anchor">
          <button className={`composer-model ${menu === "model" ? "is-open" : ""}`} type="button" aria-label="选择模型" title={`当前模型：${modelName}`} aria-haspopup="menu" aria-expanded={menu === "model"} onClick={() => toggleMenu("model")}><span>{modelName}</span><IconChevronDown size={11} /></button>
          <Popover open={menu === "model"} onClose={() => setMenu(null)} align="right" above label="选择模型" className="composer-action-menu composer-model-menu">
            <div className="composer-menu-heading">模型{preview && <span className="composer-menu-badge">预览</span>}</div>
            <div className="composer-menu-search"><IconSearch size={15} /><input ref={modelInputRef} data-menu-autofocus aria-label="搜索模型" placeholder="搜索模型…" value={modelQuery} onChange={event => setModelQuery(event.target.value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const options = event.currentTarget.closest(".composer-action-menu")?.querySelectorAll<HTMLButtonElement>(".composer-model-options > button:not(:disabled)");
                const option = (event.key === "ArrowDown" ? options?.[0] : options?.[(options?.length ?? 0) - 1])
                  ?? event.currentTarget.closest(".composer-action-menu")?.querySelector<HTMLButtonElement>(":scope > button:not(:disabled)");
                if (option) { event.preventDefault(); event.stopPropagation(); option.focus(); }
              }
              if (event.key === "Enter" && preview && onSelectModel && filteredModels[0]) { event.preventDefault(); event.stopPropagation(); selectModel(filteredModels[0].id); }
            }} />{modelQuery && <button type="button" data-menu-keep-open aria-label="清除模型搜索" onClick={() => { setModelQuery(""); modelInputRef.current?.focus(); }}><IconClose size={12} /></button>}</div>
            <div className="composer-model-options">
              {preview ? filteredModels.map(model => <button type="button" role="menuitemradio" aria-checked={model.id === activeModelId} key={model.id} disabled={!onSelectModel} onClick={() => selectModel(model.id)}><span className="composer-model-monogram" aria-hidden="true">{model.provider.slice(0, 1)}</span><span>{model.name.replace("Adaptive Router: ", "")}<small>{model.provider}</small></span>{model.badge && <span className="composer-menu-badge">{model.badge}</span>}{model.id === activeModelId && <IconCheck className="menu-check" />}</button>) : configuredModelMatches && <div className="composer-configured-model"><span className="composer-model-monogram" aria-hidden="true"><IconSparkles size={15} /></span><span>{modelName}<small>{configuredModelLabel ? "当前运行模型" : "由启动配置管理"}</small></span><IconCheck className="menu-check" /></div>}
              {(preview ? !filteredModels.length : !configuredModelMatches) && <div className="composer-menu-empty">未找到匹配模型</div>}
            </div>
            {!preview && sessionReasoning && <>
              <div className="menu-divider" /><div className="composer-menu-heading">会话推理强度</div>
              {sessionReasoning.data && <>
                <button type="button" role="menuitemradio" data-menu-keep-open aria-checked={sessionReasoning.data.effort === null} disabled={sessionReasoning.pending} onClick={() => { void selectReasoning(null); }}><IconSparkles /><span>继承配置<small>{sessionReasoning.data.configuredEffort ?? "供应商默认"}</small></span>{sessionReasoning.data.effort === null && <IconCheck className="menu-check" />}</button>
                {sessionReasoning.data.availableEfforts.map(effort => <button type="button" role="menuitemradio" data-menu-keep-open aria-checked={sessionReasoning.data?.effort === effort} key={effort} disabled={sessionReasoning.pending} onClick={() => { void selectReasoning(effort); }}><span>{effort}</span>{sessionReasoning.data?.effort === effort && <IconCheck className="menu-check" />}</button>)}
                {!sessionReasoning.data.supported && <div className="composer-menu-footer" role="alert">保存的 {sessionReasoning.data.effort} 不在当前模型支持列表中；请重新选择。</div>}
                <div className="composer-menu-footer">{sessionReasoning.data.availableEfforts.length ? "保存到当前会话；下次请求准备时生效。" : "当前模型未声明可选推理档位。"}</div>
              </>}
              {sessionReasoning.error && <div className="composer-menu-footer" role="alert">{sessionReasoning.error}</div>}
              {(!sessionReasoning.data || sessionReasoning.error) && <button type="button" disabled={sessionReasoning.pending} onClick={() => { void sessionReasoning.refresh(); }}><span>重新加载推理设置</span></button>}
            </>}
            <div className="menu-divider" /><button type="button" disabled={!onOpenSettings} onClick={() => { setMenu(null); onOpenSettings?.(); }}><IconSettings /><span>模型与连接设置</span></button>
          </Popover>
        </div>
        <button type="button" className="composer-submit" aria-label={queueModeActive ? queueIntent === "steering" ? "转向当前回合" : "排入后续回合" : "发送消息"} title={queueModeActive ? queueIntent === "steering" ? "转向当前回合 · Enter" : "排入后续回合 · Enter" : submitting ? "正在转交消息" : "发送 · Enter"} disabled={(blocked && !isRunning) || readingAttachments || submitting || (!value.trim() && !attachments.length)} onClick={() => { void submit(); }}><IconSend size={18} /></button>
        {isRunning && onInterrupt && <button type="button" className="composer-stop" aria-label="停止任务" title="停止当前任务" onClick={onInterrupt}><IconStop size={15} /></button>}
      </div>
    </div>
    {queueModeActive && selectedSkillIds.length > 0 && <div className="composer-notice" role="status">队列消息暂不支持技能。清除选择后可排队，或等当前回合结束后直接发送。<button type="button" className="composer-menu-retry" disabled={submitting} onClick={() => updateDraft(previous => ({ ...previous, skillIds: [] }))}>清除已选技能</button></div>}
    {(notice || readingAttachments || submitting) && <div className="composer-notice" role="status">{notice || (readingAttachments ? "正在读取附件…" : "正在转交消息…")}</div>}
    {uncertainQueue && <div className="composer-notice-actions">
      <button type="button" onClick={restoreQueueSubmission}>恢复待确认消息</button>
      <button type="button" disabled={!onCheckQueueSubmission || checkingQueue} onClick={() => { void checkUncertainQueueSubmission(); }}>{checkingQueue ? "正在核对队列…" : "核对服务端队列"}</button>
    </div>}
    <input ref={fileRef} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.json,.csv" multiple onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void addFiles(files); }} />
  </div>;
});
