import { useState } from "react";
import { ModalSurface } from "./ModalSurface";
import { IconSearch, IconChat, IconChevronRight } from "./Icons";
import type { ProjectFolder, SessionItem } from "../data/mockData";
export function SearchDialog({ folders, onSelect, onClose }: { folders: ProjectFolder[]; onSelect: (session: SessionItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const rows = folders.flatMap(folder => folder.sessions.map(session => ({ session, project: folder.name }))).filter(row => (row.session.title + " " + row.project).toLowerCase().includes(query.toLowerCase()));
  return <ModalSurface title="搜索聊天" onClose={onClose} className="search-dialog">
    <div className="search-field"><IconSearch size={19} /><input aria-label="搜索聊天和项目" placeholder="搜索聊天和项目…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(prev => rows.length ? (prev + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0); }
      if (event.key === "Enter" && rows[index]) { event.preventDefault(); event.stopPropagation(); onSelect(rows[index]!.session); onClose(); }
    }} /></div>
    <div className="search-results"><p>{query ? `找到 ${rows.length} 个聊天` : "最近聊天"}</p>
      {rows.map((row, i) => <button className={`search-result ${i === index ? "highlighted" : ""}`} key={row.session.id} onMouseEnter={() => setIndex(i)} onClick={() => { onSelect(row.session); onClose(); }}><IconChat size={17} /><span><strong>{row.session.title}</strong><small>{row.project} · {row.session.timeAgo}</small></span><IconChevronRight size={13} /></button>)}
      {!rows.length && <div className="search-empty"><IconSearch size={28} /><strong>没有找到相关聊天</strong><span>试试其他关键词或项目名称</span></div>}
    </div><div className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>
  </ModalSurface>;
}
