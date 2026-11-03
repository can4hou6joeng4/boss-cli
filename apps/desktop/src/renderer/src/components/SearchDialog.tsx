import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ModalSurface } from "./ModalSurface";
import { IconSearch, IconChat, IconChevronRight, IconClose } from "./Icons";
import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { ProjectFolder, SessionItem } from "../data/mockData";
import { sessionRows } from "../data/sessionRows";
import { searchThreadMessages } from "../data/harnessBridge";

export function SearchDialog({ folders, onSelect, onClose, searchMessages = false, onOpenMessage }: {
  folders: ProjectFolder[];
  onSelect: (session: SessionItem) => void;
  onClose: () => void;
  /** 内核声明 threadSearch 能力时为真；否则只按标题与项目搜索。 */
  searchMessages?: boolean;
  /** 打开会话并定位到命中的消息；缺省时退回只打开会话。 */
  onOpenMessage?: (session: SessionItem, itemId: string) => void;
}) {
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const [hits, setHits] = useState<ThreadSearchMatch[]>([]);
  const [messageState, setMessageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const rows = sessionRows(folders, query);
  const sessions = sessionRows(folders, "");
  const sessionById = new Map(sessions.map(row => [row.session.id, row.session]));
  const inputRef = useRef<HTMLInputElement>(null), resultsRef = useRef<HTMLDivElement>(null);
  const listId = useId(), statusId = useId();
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  useLayoutEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows[selected]?.session.id]);
  useEffect(() => {
    const needle = query.trim();
    if (!searchMessages || needle.length < 2) {
      setHits([]); setMessageState("idle");
      return;
    }
    let cancelled = false;
    setMessageState("loading");
    const timer = window.setTimeout(() => {
      void searchThreadMessages(needle, 20).then(result => {
        if (cancelled) return;
        const available = new Set(sessionRows(folders, "").map(row => row.session.id));
        setHits(result.matches.filter(match => available.has(match.threadId)));
        setMessageState("ready");
      }).catch(() => {
        if (cancelled) return;
        setHits([]); setMessageState("error");
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, searchMessages, folders]);
  const open = (session: SessionItem) => { onSelect(session); onClose(); };
  return <ModalSurface title="搜索聊天" onClose={onClose} className="search-dialog">
    <div className="search-field"><IconSearch size={19} /><input ref={inputRef} role="combobox" aria-label="搜索聊天和项目" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-describedby={statusId} aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined} autoComplete="off" placeholder="搜索聊天和项目…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(rows.length ? (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0); }
      if (event.key === "Enter" && rows[selected]) { event.preventDefault(); event.stopPropagation(); open(rows[selected]!.session); }
    }} />{query && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setQuery(""); setIndex(0); inputRef.current?.focus(); }}><IconClose size={15} /></button>}</div>
    <div className="search-results" ref={resultsRef}>
      <p id={statusId} role="status">{query.trim() ? `找到 ${rows.length} 个聊天${messageState === "ready" ? `、${hits.length} 条消息` : ""}` : "最近聊天"}</p>
      {query.trim().length >= 2 && searchMessages && <div className="search-message-hits" aria-label="消息搜索结果">
        <p>{messageState === "loading" ? "正在搜索消息…" : messageState === "error" ? "消息搜索失败，可继续按标题查找" : hits.length ? "消息命中" : "没有匹配的消息"}</p>
        {hits.map(hit => {
          const session = sessionById.get(hit.threadId);
          if (!session) return null;
          return <button type="button" className="search-result search-message-hit" key={`${hit.threadId}-${hit.itemId}`} title={hit.snippet} onClick={() => {
            if (onOpenMessage) { onOpenMessage(session, hit.itemId); onClose(); } else open(session);
          }}>
            <IconChat size={17} /><span><strong>{hit.threadTitle || session.title}</strong><small>{hit.role === "user" ? "你" : "助手"} · {hit.snippet}</small></span><IconChevronRight size={13} />
          </button>;
        })}
      </div>}
      <div id={listId} role="listbox" aria-label="聊天搜索结果">{rows.map((row, i) => <button type="button" role="option" tabIndex={-1} aria-selected={i === selected} id={`${listId}-${i}`} className={`search-result ${i === selected ? "highlighted" : ""}`} key={row.session.id} onPointerMove={event => { if (event.pointerType === "mouse" && (event.movementX || event.movementY)) setIndex(i); }} onClick={() => open(row.session)}><IconChat size={17} /><span><strong>{row.session.title}</strong><small>{row.project} · {row.session.timeAgo}</small></span><IconChevronRight size={13} /></button>)}</div>
      {!rows.length && !hits.length && messageState !== "loading" && <div className="search-empty"><IconSearch size={28} /><strong>{query.trim() ? "没有找到相关聊天或消息" : "还没有聊天"}</strong><span>{query.trim() ? "试试其他关键词、项目名称或消息内容" : "创建聊天后，可以在这里快速找到它"}</span></div>}
    </div><div className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>
  </ModalSurface>;
}
