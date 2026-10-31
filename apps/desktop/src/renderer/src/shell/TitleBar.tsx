import { useEffect, useRef, useState } from "react";
import { IconPanel, IconPanelRight, IconMore, IconFolder, IconPlus, IconChevronRight, IconCopy, IconHistory, IconSettings, IconEdit, IconPin, IconBranch } from "../components/Icons";
import { Popover } from "../components/Popover";
interface Props {
  title: string; hasConversation: boolean; summaryAvailable: boolean; isSidebarOpen: boolean; isSummaryOpen: boolean; canGoBack: boolean; canGoForward: boolean;
  onBack: () => void; onForward: () => void; onToggleSidebar: () => void; onToggleSummary: () => void;
  onNewTask: () => void; onOpenSettings: () => void; onOpenRewind: () => void; onExport: () => void;
  onRename: () => void; onPin: () => void; isPinned: boolean;
  onOpenBrowser?: () => void; browserOpen?: boolean;
  onOpenContext?: () => void;
  /** 仅在内核声明会话内分支能力时提供。 */
  onOpenBranches?: () => void;
}
export function TitleBar(props: Props) {
  const [menu, setMenu] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const copyVersion = useRef(0);
  useEffect(() => { copyVersion.current += 1; setCopyState("idle"); setMenu(false); }, [props.title]);
  const copyTitle = async () => {
    const version = ++copyVersion.current;
    setCopyState("pending");
    try {
      await navigator.clipboard.writeText(props.title);
      if (copyVersion.current === version) setCopyState("copied");
    } catch {
      if (copyVersion.current === version) setCopyState("failed");
    }
  };
  return <header className="titlebar">
    <div className="titlebar-window-controls" aria-hidden="true"><i /><i /><i /></div>
    <div className="titlebar-navigation">
      <button className="titlebar-btn" title="后退 · ⌘[" aria-label="后退" disabled={!props.canGoBack} onClick={props.onBack}><IconChevronRight size={16} className="rotate-back" /></button>
      <button className="titlebar-btn" title="前进 · ⌘]" aria-label="前进" disabled={!props.canGoForward} onClick={props.onForward}><IconChevronRight size={16} /></button>
      <button className="titlebar-btn" title="切换侧边栏 · ⌘B" aria-label="切换侧边栏" aria-pressed={props.isSidebarOpen} onClick={props.onToggleSidebar}><IconPanel size={16} /></button>
    </div>
    <div className="titlebar-thread"><IconFolder size={15} /><span>{props.title}</span></div>
    <div className="titlebar-right">
      {props.onOpenBranches && <button type="button" className="titlebar-btn" title="会话分支 · 切换分支或从已结束回合重新开始" aria-label="会话分支" disabled={!props.hasConversation} onClick={props.onOpenBranches}><IconBranch size={16} /></button>}
      {props.onOpenBrowser && <button type="button" className={`titlebar-btn${props.browserOpen ? " active" : ""}`} title="会话浏览器 · BOSS 直聘登录" aria-label="打开会话浏览器" aria-pressed={props.browserOpen} disabled={!props.hasConversation} onClick={props.onOpenBrowser}><svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2" /><path d="M2 7h16M5 5h.1M7 5h.1M12 7v10" /></svg></button>}
      <div className="popover-anchor">
        <button className="titlebar-btn" title="聊天选项" aria-label="聊天选项" aria-haspopup="menu" aria-expanded={menu} onClick={() => { copyVersion.current += 1; setCopyState("idle"); setMenu(!menu); }}><IconMore size={17} /></button>
        <Popover open={menu} onClose={() => setMenu(false)} align="right" label="当前聊天选项">
          <button disabled={!props.hasConversation} onClick={() => { props.onRename(); setMenu(false); }}><IconEdit />重命名</button>
          <button disabled={!props.hasConversation} onClick={() => { props.onPin(); setMenu(false); }}><IconPin />{props.isPinned ? "取消置顶" : "置顶聊天"}</button>
          <div className="menu-divider" />
          <button disabled={!props.hasConversation} onClick={() => { props.onExport(); setMenu(false); }}><IconCopy />导出为 Markdown</button>
          <button data-menu-keep-open disabled={!props.hasConversation || copyState === "pending"} onClick={() => { void copyTitle(); }}><IconCopy />{copyState === "pending" ? "正在复制…" : copyState === "copied" ? "已复制标题" : copyState === "failed" ? "复制失败，点击重试" : "复制聊天标题"}</button>
          {copyState === "copied" && <div className="menu-note" role="status">聊天标题已复制</div>}
          {copyState === "failed" && <div className="menu-note" role="status">无法访问剪贴板，请检查权限后重试。</div>}
          <button disabled={!props.hasConversation} onClick={() => { props.onOpenRewind(); setMenu(false); }}><IconHistory />查看会话回溯</button>
          {props.onOpenContext && <button disabled={!props.hasConversation} onClick={() => { props.onOpenContext?.(); setMenu(false); }}><IconPanelRight />会话上下文</button>}
          {props.onOpenBranches && <button disabled={!props.hasConversation} onClick={() => { props.onOpenBranches?.(); setMenu(false); }}><IconBranch />会话分支</button>}
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
