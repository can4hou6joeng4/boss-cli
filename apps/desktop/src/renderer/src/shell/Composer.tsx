import { useState, useRef, useEffect, forwardRef } from "react";
import { IconPlus, IconSend, IconStop, IconShield, IconChevronDown, IconCheck, IconClose, IconFolder, IconSparkles, IconSettings } from "../components/Icons";
import { Popover } from "../components/Popover";
import { SlashCommandList, SLASH_COMMANDS, type SlashCommandItem } from "../components/SlashCommandList";
import { AtMentionList, filterMentions, type MentionItem } from "../components/AtMentionList";
import { MODEL_OPTIONS, type ConversationMode } from "../data/mockData";

export interface ComposerProps {
  value: string; onChange: (text: string) => void; onSend: (text: string) => void;
  isRunning?: boolean; blocked?: boolean; onInterrupt?: () => void; preview?: boolean;
  currentMode?: ConversationMode; onModeChange?: (mode: ConversationMode) => void;
  activeModelId?: string; onSelectModel?: (id: string) => void; onOpenSettings?: () => void;
  home?: boolean;
}
interface TextAttachment { name: string; text: string; }
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({
  value, onChange, onSend, isRunning = false, blocked = false, onInterrupt, preview = true,
  currentMode = "agent", onModeChange, activeModelId, onSelectModel, onOpenSettings, home = false,
}, forwardedRef) {
  const [menu, setMenu] = useState<"add" | "permissions" | "model" | null>(null);
  const [permission, setPermission] = useState("请求批准");
  const [slashOpen, setSlashOpen] = useState(false), [mentionOpen, setMentionOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const slashQuery = value.match(/^\/([^\s]*)$/)?.[1] ?? "";
  const mentionQuery = value.match(/(?:^|\s)@([^\s]*)$/)?.[1] ?? "";
  const modelName = preview ? (MODEL_OPTIONS.find(m => m.id === activeModelId)?.name.replace("Adaptive Router: ", "") ?? "默认模型") : "配置的模型";
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(180, Math.max(home ? 66 : 52, inputRef.current.scrollHeight)) + "px";
    }
  }, [value, home]);
  const focusInput = () => inputRef.current?.focus();
  const change = (text: string) => {
    onChange(text); setNotice(""); setSelectedIndex(0);
    setSlashOpen(/^\/[^\s]*$/.test(text));
    setMentionOpen(/(?:^|\s)@[^\s]*$/.test(text));
  };
  const selectSlash = (item: SlashCommandItem) => {
    setSlashOpen(false); onChange(item.command + " "); focusInput();
  };
  const selectMention = (item: MentionItem) => {
    setMentionOpen(false); onChange(value.slice(0, value.lastIndexOf("@")) + "@" + item.name + " "); focusInput();
  };
  const submit = () => {
    if (isRunning || blocked || (!value.trim() && !attachments.length)) return;
    const text = [value.trim(), ...attachments.map(file => `附件：${file.name}\n\n${file.text}`)].filter(Boolean).join("\n\n");
    onSend(text); onChange(""); setAttachments([]); setSlashOpen(false); setMentionOpen(false);
  };
  return <div className={`composer-surface ${home ? "home-composer" : ""}`}>
    {attachments.length > 0 && <div className="attachment-list">{attachments.map((file, index) => <div className="attachment-chip" key={file.name + index}><IconFolder size={15} /><span>{file.name}</span><button type="button" aria-label={`移除附件 ${file.name}`} onClick={() => setAttachments(prev => prev.filter((_, i) => i !== index))}><IconClose size={12} /></button></div>)}</div>}
    <SlashCommandList isOpen={slashOpen} onClose={() => setSlashOpen(false)} onSelect={selectSlash} search={slashQuery} selectedIndex={selectedIndex} />
    <AtMentionList isOpen={mentionOpen} onClose={() => setMentionOpen(false)} onSelect={selectMention} search={mentionQuery} selectedIndex={selectedIndex} />
    <textarea aria-label="消息输入" ref={element => { inputRef.current = element; if (typeof forwardedRef === "function") forwardedRef(element); else if (forwardedRef) forwardedRef.current = element; }} rows={2}
      placeholder={isRunning ? "正在处理任务，你可以随时停止" : blocked ? "另一个任务正在运行，请等待完成" : "和 BOSS-CLI 一起工作"}
      value={value} onChange={event => change(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
        if (slashOpen || mentionOpen) {
          const options = slashOpen ? SLASH_COMMANDS.filter(item => [item.command, item.label, item.description].join(" ").toLowerCase().includes(slashQuery.toLowerCase())) : filterMentions(mentionQuery);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelectedIndex(prev => options.length ? (prev + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length : 0); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const option = options[selectedIndex]; if (option) { if (slashOpen) selectSlash(option as SlashCommandItem); else selectMention(option as MentionItem); } return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSlashOpen(false); setMentionOpen(false); return; }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
      }} />
    <div className="composer-controls">
      <div className="composer-control-left">
        <div className="popover-anchor">
          <button type="button" className="composer-icon" aria-label="添加附件或上下文" title="添加附件或上下文" aria-expanded={menu === "add"} onClick={() => setMenu(menu === "add" ? null : "add")}><IconPlus size={19} /></button>
          <Popover open={menu === "add"} onClose={() => setMenu(null)} above>
            <button onClick={() => { fileRef.current?.click(); setMenu(null); }}><IconFolder />添加文本文件<span className="menu-shortcut">本地</span></button>
            <button onClick={() => { onChange(value + (value ? " " : "") + "@"); setMentionOpen(true); setMenu(null); focusInput(); }}><IconPlus />关联招聘对象</button>
            <button onClick={() => { onChange("/"); setSlashOpen(true); setMenu(null); focusInput(); }}><IconSparkles />快捷指令</button>
            <div className="menu-note">文本附件会随下一条消息发送。支持 TXT、Markdown、JSON、CSV。</div>
          </Popover>
        </div>
        <div className="popover-anchor">
          <button type="button" className={`permission-button ${permission === "完全访问" ? "full-access" : ""}`} aria-label="权限与模式" aria-expanded={menu === "permissions"} onClick={() => setMenu(menu === "permissions" ? null : "permissions")}><IconShield size={15} /><span>{preview ? permission : "请求批准"}</span><IconChevronDown size={10} /></button>
          <Popover open={menu === "permissions"} onClose={() => setMenu(null)} above>
            <div className="menu-label">执行权限</div>
            {["请求批准", "完全访问"].map(item => <button key={item} disabled={!preview && item === "完全访问"} onClick={() => { setPermission(item); setMenu(null); }}><IconShield /><span>{item}</span>{(preview ? permission : "请求批准") === item && <IconCheck className="menu-check" />}</button>)}
            <div className="menu-note">{preview ? "界面预览选项。对外沟通与投递始终需要逐次授权。" : "当前连接由内核执行审批。前端不能扩大操作权限。"}</div>
            <div className="menu-divider" /><div className="menu-label">任务模式</div>
            {(["agent", "plan", "ask"] as ConversationMode[]).map(mode => <button key={mode} disabled={!preview && mode !== "agent"} onClick={() => { onModeChange?.(mode); setMenu(null); }}><span>{mode === "agent" ? "Agent · 执行任务" : mode === "plan" ? "Plan · 制定计划" : "Ask · 快速提问"}</span>{currentMode === mode && <IconCheck className="menu-check" />}</button>)}
          </Popover>
        </div>
      </div>
      <div className="composer-control-right">
        <div className="popover-anchor">
          <button className="composer-model" type="button" aria-label="选择模型" aria-expanded={menu === "model"} onClick={() => setMenu(menu === "model" ? null : "model")}><span>{modelName}</span><IconChevronDown size={11} /></button>
          <Popover open={menu === "model"} onClose={() => setMenu(null)} align="right" above>
            <div className="menu-label">{preview ? "模型 · 界面预览" : "当前模型"}</div>
            {preview ? MODEL_OPTIONS.map(model => <button key={model.id} onClick={() => { onSelectModel?.(model.id); setMenu(null); }}><span>{model.name.replace("Adaptive Router: ", "")}<small>{model.provider}</small></span>{model.id === activeModelId && <IconCheck className="menu-check" />}</button>) : <div className="menu-note">使用本地启动配置指定的模型与供应商。</div>}
            <div className="menu-divider" /><button onClick={() => { onOpenSettings?.(); setMenu(null); }}><IconSettings />模型与连接设置</button>
          </Popover>
        </div>
        <button type="button" className="composer-submit" aria-label={isRunning ? "停止任务" : "发送消息"} title={isRunning ? "停止任务" : "发送 · Enter"} disabled={!isRunning && (blocked || (!value.trim() && !attachments.length))} onClick={isRunning ? onInterrupt : submit}>{isRunning ? <IconStop size={15} /> : <IconSend size={18} />}</button>
      </div>
    </div>
    {notice && <div className="composer-notice" role="status">{notice}</div>}
    <input ref={fileRef} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.json,.csv" multiple onChange={async event => {
      const files = [...(event.target.files ?? [])]; event.target.value = "";
      if (files.length + attachments.length > 4 || files.some(file => file.size > 200000)) { setNotice("最多添加 4 个文本文件，每个文件不超过 200 KB。"); return; }
      try { const added = await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() }))); setAttachments(prev => [...prev, ...added]); } catch { setNotice("读取文件失败，请重新选择。"); }
    }} />
  </div>;
});
