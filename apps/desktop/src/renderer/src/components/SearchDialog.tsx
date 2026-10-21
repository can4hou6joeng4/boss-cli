import { useId, useLayoutEffect, useRef, useState } from "react";
import { ModalSurface } from "./ModalSurface";
import { IconSearch, IconChat, IconChevronRight, IconClose } from "./Icons";
import type { ProjectFolder, SessionItem } from "../data/mockData";
import { sessionRows } from "../data/sessionRows";
export function SearchDialog({ folders, onSelect, onClose }: { folders: ProjectFolder[]; onSelect: (session: SessionItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const rows = sessionRows(folders, query);
  const inputRef = useRef<HTMLInputElement>(null), resultsRef = useRef<HTMLDivElement>(null);
  const listId = useId(), statusId = useId();
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  useLayoutEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows[selected]?.session.id]);
  return <ModalSurface title="搜索聊天" onClose={onClose} className="search-dialog">
    <div className="search-field"><IconSearch size={19} /><input ref={inputRef} role="combobox" aria-label="搜索聊天和项目" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-describedby={statusId} aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined} autoComplete="off" placeholder="搜索聊天和项目…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(rows.length ? (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0); }
      if (event.key === "Enter" && rows[selected]) { event.preventDefault(); event.stopPropagation(); onSelect(rows[selected]!.session); onClose(); }
    }} />{query && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setQuery(""); setIndex(0); inputRef.current?.focus(); }}><IconClose size={15} /></button>}</div>
    <div className="search-results" ref={resultsRef}><p id={statusId} role="status">{query.trim() ? `找到 ${rows.length} 个聊天` : "最近聊天"}</p>
      <div id={listId} role="listbox" aria-label="聊天搜索结果">{rows.map((row, i) => <button type="button" role="option" tabIndex={-1} aria-selected={i === selected} id={`${listId}-${i}`} className={`search-result ${i === selected ? "highlighted" : ""}`} key={row.session.id} onPointerMove={event => { if (event.pointerType === "mouse" && (event.movementX || event.movementY)) setIndex(i); }} onClick={() => { onSelect(row.session); onClose(); }}><IconChat size={17} /><span><strong>{row.session.title}</strong><small>{row.project} · {row.session.timeAgo}</small></span><IconChevronRight size={13} /></button>)}</div>
      {!rows.length && <div className="search-empty"><IconSearch size={28} /><strong>{query.trim() ? "没有找到相关聊天" : "还没有聊天"}</strong><span>{query.trim() ? "试试其他关键词或项目名称" : "创建聊天后，可以在这里快速找到它"}</span></div>}
    </div><div className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>
  </ModalSurface>;
}
