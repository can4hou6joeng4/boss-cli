import { useState } from "react";
import { IconMore, IconDiffFiles, IconChevronRight, IconTerminal, IconPlus, IconFolder, IconCheck } from "../components/Icons";
import { Popover } from "../components/Popover";
import type { MessageItem } from "../data/mockData";
interface Props { projectName: string; isOpen: boolean; messages: MessageItem[]; preview: boolean; onReviewChanges: () => void; onOpenSettings: () => void; }
export function RightPanel({ projectName, isOpen, messages, preview, onReviewChanges, onOpenSettings }: Props) {
  const [expanded, setExpanded] = useState(false), [menu, setMenu] = useState(false);
  if (!isOpen) return null;
  const summary = [...messages].reverse().find(item => item.diffSummary)?.diffSummary;
  const tools = [...new Set(messages.flatMap(item => item.toolUse ? [item.toolUse.name] : []))];
  return <aside className="summary-panel" aria-label="项目摘要">
    <div className="summary-panel-header"><span title={projectName}>{projectName}</span><div className="popover-anchor"><button className="titlebar-btn" aria-label="摘要选项" aria-expanded={menu} onClick={() => setMenu(!menu)}><IconMore size={17} /></button><Popover open={menu} onClose={() => setMenu(false)} align="right"><button onClick={() => { setExpanded(true); setMenu(false); }}>展开所有来源</button><button onClick={() => { onOpenSettings(); setMenu(false); }}>连接设置</button></Popover></div></div>
    <button className="summary-diff-row" onClick={onReviewChanges} disabled={!summary}><span><IconDiffFiles size={16} />变更</span>{summary ? <span><b className="diff-added">+{summary.additions}</b><b className="diff-deleted">−{summary.deletions}</b></span> : <span className="summary-muted">暂无变更</span>}</button>
    <div className="summary-sources-heading"><span>来源</span><button className="titlebar-btn" title="管理来源" aria-label="管理来源" onClick={onOpenSettings}><IconPlus size={16} /></button></div>
    <button className="summary-source" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><span className="source-icon"><IconTerminal size={13} /></span><span>{preview ? "招聘工具 · 示例" : "本地招聘 Harness"}</span></button>
    {expanded && <div className="summary-details">{tools.length ? tools.map(tool => <div key={tool}><IconCheck size={12} /><span>{tool}</span></div>) : <div><IconFolder size={13} /><span>{preview ? "示例数据，仅用于界面预览" : "工具结果会在运行后列于此处"}</span></div>}</div>}
    <button className="summary-show-all" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "查看全部"}<IconChevronRight size={12} className={expanded ? "rotate-down" : ""} /></button>
    {preview && <span className="summary-preview-label">示例会话</span>}
  </aside>;
}
