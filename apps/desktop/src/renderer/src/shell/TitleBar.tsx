import { useState } from "react";
import { IconPanel, IconPanelRight, IconMore, IconFolder, IconPlus, IconChevronRight, IconCopy, IconHistory, IconSettings } from "../components/Icons";
import { Popover } from "../components/Popover";
interface Props {
  title: string; hasConversation: boolean; summaryAvailable: boolean; isSidebarOpen: boolean; isSummaryOpen: boolean; canGoBack: boolean; canGoForward: boolean;
  onBack: () => void; onForward: () => void; onToggleSidebar: () => void; onToggleSummary: () => void;
  onNewTask: () => void; onOpenSettings: () => void; onOpenRewind: () => void; onExport: () => void;
}
export function TitleBar(props: Props) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  return <header className="titlebar">
    <div className="titlebar-window-controls" aria-hidden="true"><i /><i /><i /></div>
    <div className="titlebar-navigation">
      <button className="titlebar-btn" title="后退 · ⌘[" aria-label="后退" disabled={!props.canGoBack} onClick={props.onBack}><IconChevronRight size={16} className="rotate-back" /></button>
      <button className="titlebar-btn" title="前进 · ⌘]" aria-label="前进" disabled={!props.canGoForward} onClick={props.onForward}><IconChevronRight size={16} /></button>
      <button className="titlebar-btn" title="切换侧边栏 · ⌘B" aria-label="切换侧边栏" aria-pressed={props.isSidebarOpen} onClick={props.onToggleSidebar}><IconPanel size={16} /></button>
    </div>
    <div className="titlebar-thread"><IconFolder size={15} /><span>{props.title}</span></div>
    <div className="titlebar-right">
      <div className="popover-anchor">
        <button className="titlebar-btn" title="聊天选项" aria-label="聊天选项" aria-expanded={menu} onClick={() => setMenu(!menu)}><IconMore size={17} /></button>
        <Popover open={menu} onClose={() => setMenu(false)} align="right">
          <button disabled={!props.hasConversation} onClick={() => { props.onExport(); setMenu(false); }}><IconCopy />导出为 Markdown</button>
          <button onClick={() => { void navigator.clipboard?.writeText(props.title).then(() => setCopied(true)).catch(() => setCopied(false)); }}><IconCopy />{copied ? "已复制标题" : "复制聊天标题"}</button>
          <button disabled={!props.hasConversation} onClick={() => { props.onOpenRewind(); setMenu(false); }}><IconHistory />查看会话回溯</button>
          <div className="menu-divider" />
          <button onClick={() => { props.onOpenSettings(); setMenu(false); }}><IconSettings />设置<span className="menu-shortcut">⌘,</span></button>
        </Popover>
      </div>
      <button className={`titlebar-btn ${props.hasConversation && props.summaryAvailable && props.isSummaryOpen ? "active" : ""}`} title="切换摘要面板 · ⌘⌥B" aria-label="切换摘要面板" aria-pressed={props.hasConversation && props.summaryAvailable && props.isSummaryOpen} disabled={!props.hasConversation || !props.summaryAvailable} onClick={props.onToggleSummary}><IconPanelRight size={17} /></button>
      <span className="titlebar-separator" />
      <button className="titlebar-btn" title="新聊天 · ⌘N" aria-label="新聊天" onClick={props.onNewTask}><IconPlus size={17} /></button>
    </div>
  </header>;
}
