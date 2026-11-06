import { useEffect, useRef, useState } from "react";
import { IconHistory, IconFolder, IconSearch, IconPlus, IconSparkles, IconChevronRight, IconTerminal } from "../components/Icons";
import { ModalSurface } from "../components/ModalSurface";
import { STRATEGY_DOMAINS, type ProjectFolder, type SessionItem, type MessageItem } from "../data/mockData";
import { sessionRows } from "../data/sessionRows";
import type { SkillDescriptor, SkillProblem, ToolDescriptor } from "@boss-harness/protocol";
import type { SkillCatalogState, ToolCatalogState } from "../data/harnessBridge";
import { WorkspaceSkills } from "../components/WorkspaceSkills";
import { WorkspaceInstructionsSection } from "../components/WorkspaceInstructionsSection";
import { collectLibraryFiles, collectLibrarySources, filterLibraryFiles, filterLibrarySources, formatSourceQueriedAt, shortLibraryId } from "../data/libraryFiles";
import type { WorkspacePage } from "./NavigationRail";
interface Props { page: WorkspacePage; folders: ProjectFolder[]; messages: MessageItem[]; onSelect: (session: SessionItem) => void; onNewTask: () => void; onDraft: (text: string) => void; tools: ToolDescriptor[]; toolCatalogState: ToolCatalogState; toolCatalogError: string; skills: SkillDescriptor[]; skillCatalogState: SkillCatalogState; skillCatalogError?: string; onRefreshSkills: () => void; skillsReadable: boolean; skillsCreatable: boolean; skillsWritable: boolean; skillsDeletable: boolean; skillRoot?: string | null; skillProblems: SkillProblem[]; onUseSkill: (skillId: string) => void; workspaceInstructionsEditable: boolean; harnessUp: boolean; preview: boolean; focusSkillId?: string | null; onFocusSkill?: () => void; }
export function WorkspacePages({ page, folders, messages, onSelect, onNewTask, onDraft, tools, toolCatalogState, toolCatalogError, skills, skillCatalogState, skillCatalogError = "", onRefreshSkills, skillsReadable, skillsCreatable, skillsWritable, skillsDeletable, skillRoot = null, skillProblems = [], onUseSkill, workspaceInstructionsEditable, harnessUp, preview, focusSkillId = null, onFocusSkill }: Props) {
  const [query, setQuery] = useState(""), [file, setFile] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [copyNote, setCopyNote] = useState<{ key: string; text: string } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (copyTimer.current !== undefined) clearTimeout(copyTimer.current); }, []);
  /** 复制资料路径或来源编号；失败时如实提示，不假装已复制。 */
  const copyLibraryText = async (key: string, text: string) => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
    } catch { copied = false; }
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
    setCopyNote({ key, text: copied ? "已复制。" : "复制失败：当前环境不允许写入剪贴板。" });
    copyTimer.current = setTimeout(() => { copyTimer.current = undefined; setCopyNote(null); }, 2600);
  };
  const recentRows = sessionRows(folders, query);
  if (page === "recents") return <div className="workspace-page" data-screen-label="最近聊天"><div className="page-heading"><div><h1>最近聊天</h1><p>从上次停下的地方继续。</p></div><button className="subtle-button" onClick={onNewTask}><IconPlus size={15} />新聊天</button></div><div className="page-search"><IconSearch size={16} /><input aria-label="筛选最近聊天" placeholder="搜索聊天…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="recent-table">{recentRows.map(({ session, project }) => <button className="recent-row" key={session.id} onClick={() => onSelect(session)}><span className="recent-row-icon"><IconHistory size={18} /></span><span><strong>{session.title}</strong><small>{project}</small></span><time dateTime={session.updatedAt}>{session.timeAgo}</time><IconChevronRight size={14} /></button>)}
    {!recentRows.length && <p className="page-empty-note">{query.trim() ? "没有找到匹配的聊天" : "还没有聊天，创建一个任务开始吧"}</p>}</div></div>;
  if (page === "library") {
    const files = collectLibraryFiles(messages);
    const sources = collectLibrarySources(messages);
    const visibleFiles = filterLibraryFiles(files, libraryQuery);
    const visibleSources = filterLibrarySources(sources, libraryQuery);
    const empty = files.length === 0 && sources.length === 0;
    const noMatch = !empty && visibleFiles.length === 0 && visibleSources.length === 0;
    const selected = file === null ? null : files.find(item => item.path === file) ?? null;
    return <div className="workspace-page" data-screen-label="资料库">
      <div className="page-heading"><div><h1>资料库</h1><p>当前会话中的文件变更与工具来源{preview ? " · 示例" : ""}</p></div></div>
      {!empty && <div className="page-search"><IconSearch size={16} /><input aria-label="筛选资料" placeholder="筛选文件或来源…" value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} /></div>}
      {empty ? <div className="page-empty"><IconFolder size={36} /><h2>资料会汇集在这里</h2><p>会话中出现的文件变更与工具来源会显示在这里。文件变更摘要目前只有示例会话提供；真实会话里调用工具后，来源会出现在下方列表。</p><button className="subtle-button" onClick={onNewTask}>开始一个任务</button></div>
        : noMatch ? <p className="page-empty-note">没有匹配的文件或来源。清空筛选后再试。</p>
        : <>
          {files.length > 0 && <><h2 className="page-section-title">文件 <span>{visibleFiles.length} / {files.length}</span></h2>
            {visibleFiles.length ? <div className="library-grid">{visibleFiles.map(item => <button key={item.path} onClick={() => setFile(item.path)}>
              <div className="library-file-preview"><IconFolder size={32} /><span>{item.kind}</span></div>
              <strong>{item.name}</strong>
              <small>{item.directory || "会话根目录"} · +{item.additions} −{item.deletions}{item.occurrences > 1 ? ` · ${item.occurrences} 次` : ""}</small>
            </button>)}</div> : <p className="page-empty-note">没有匹配的文件。</p>}
          </>}
          {sources.length > 0 && <><h2 className="page-section-title">工具来源 <span>{visibleSources.length} / {sources.length}</span></h2>
            {visibleSources.length ? <ul className="library-source-list">{visibleSources.map(source => <li key={source.ref}>
              <IconTerminal size={16} />
              <span><code>{source.ref}</code><small>{source.tool} · {formatSourceQueriedAt(source.queriedAt)}{source.turnId ? ` · 回合 ${shortLibraryId(source.turnId)}` : ""}</small></span>
              <button type="button" className="subtle-button" onClick={() => { void copyLibraryText(`source:${source.ref}`, source.ref); }} aria-label={`复制来源 ${source.ref}`}>复制</button>
              {copyNote?.key === `source:${source.ref}` && <em className="library-copy-note" role="status">{copyNote.text}</em>}
            </li>)}</ul> : <p className="page-empty-note">没有匹配的来源。</p>}
          </>}
        </>}
      {selected && <ModalSurface title={selected.name || selected.path} onClose={() => setFile(null)}><div className="file-reference-detail">
        <IconFolder size={32} /><code>{selected.path}</code>
        <p>所在目录：{selected.directory || "会话根目录"}</p>
        <p>本会话累计新增 {selected.additions} 行、删除 {selected.deletions} 行，出现 {selected.occurrences} 次。</p>
        {selected.turnId && <p>来自回合 {shortLibraryId(selected.turnId)}。</p>}
        <p>这是会话中的文件变更引用。内核尚未提供文件读取接口，无法在这里预览内容，但可以复制路径后在本地打开。</p>
        <div className="library-detail-actions">
          <button className="subtle-button" onClick={() => { void copyLibraryText("file", selected.path); }}>复制路径</button>
          <button className="subtle-button" onClick={() => setFile(null)}>返回资料库</button>
        </div>
        {copyNote?.key === "file" && <span className="library-copy-note" role="status">{copyNote.text}</span>}
      </div></ModalSurface>}
    </div>;
  }
  return <div className="workspace-page" data-screen-label="技能与工具"><div className="page-heading"><div><h1>技能与工具</h1><p>组合基础能力，推进你的招聘任务。</p></div></div><WorkspaceSkills skills={skills} state={skillCatalogState} error={skillCatalogError} readable={skillsReadable} root={skillRoot} creatable={skillsCreatable} writable={skillsWritable} deletable={skillsDeletable} problems={skillProblems} onUseSkill={onUseSkill} preview={preview} onRefresh={onRefreshSkills} focusSkillId={focusSkillId} onFocusSkill={onFocusSkill} /><WorkspaceInstructionsSection editable={workspaceInstructionsEditable} connected={harnessUp} preview={preview} /><h2 className="page-section-title">招聘任务模板</h2><div className="skill-grid">{STRATEGY_DOMAINS.map(domain => <button key={domain.id} onClick={() => onDraft(domain.defaultPrompt)}><span className="skill-icon"><IconSparkles size={23} /></span><strong>{domain.name}</strong><p>{domain.desc}</p><span className="skill-action">在新聊天中使用<IconChevronRight size={12} /></span></button>)}</div><h2 className="page-section-title">已连接工具 <span>{toolCatalogState === "ready" || toolCatalogState === "empty" ? tools.length : "—"}</span></h2>{tools.length ? <div className="tool-list">{tools.map(tool => <div key={tool.name}><IconTerminal size={17} /><span><strong>{tool.name}</strong><p>{tool.description}</p></span><small>{tool.readOnly ? "只读" : "需要授权"}</small></div>)}</div> : toolCatalogState === "loading" ? <div className="page-tool-empty">正在读取工具清单…</div> : toolCatalogState === "error" ? <div className="page-tool-empty">工具清单读取失败{toolCatalogError ? `：${toolCatalogError}` : ""}。这只表示读取没有完成，不代表内核没有可用工具；请稍后重试。</div> : toolCatalogState === "empty" ? <div className="page-tool-empty">内核当前没有声明可用工具。</div> : <div className="page-tool-empty">{preview ? "浏览器预览未连接工具。启动桌面端后显示实际工具清单。" : "连接尚未就绪，暂时无法读取工具清单。"}</div>}</div>;
}
