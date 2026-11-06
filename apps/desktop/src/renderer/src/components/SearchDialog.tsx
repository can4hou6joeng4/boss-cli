import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ModalSurface } from "./ModalSurface";
import { IconSearch, IconChat, IconChevronRight, IconClose } from "./Icons";
import type { ProjectFolder, SessionItem } from "../data/mockData";
import { sessionRows } from "../data/sessionRows";
import { buildSearchOptions, searchHitFocus, searchRoleLabel, type SearchOption } from "../data/searchOptions";
import { splitKernelHighlight } from "../data/findHighlight";
import { visibleThreadSearchHits, type ThreadSearchBatch } from "../data/messageSearch";
import { searchThreadMessages } from "../data/harnessBridge";
import { clearRecentSearches, readRecentSearches, rememberRecentSearch, RECENT_SEARCH_MIN_LENGTH } from "../data/recentSearches";

/** 用 `mark` 标出关键词；无命中时原样输出。内核命中片段按内核的 casefold 归一化标注。 */
function Highlighted({ text, query }: { text: string; query: string }) {
  return <>{splitKernelHighlight(text, query).map((segment, index) => segment.match
    ? <mark className="search-match" key={index}>{segment.text}</mark>
    : segment.text)}</>;
}

export function SearchDialog({ folders, onSelect, onClose, searchMessages = false, searchArchived = false, onOpenMessage }: {
  folders: ProjectFolder[];
  onSelect: (session: SessionItem) => void;
  onClose: () => void;
  /** 内核声明 threadSearch 能力时为真；否则只按标题与项目搜索。 */
  searchMessages?: boolean;
  /** 内核声明 threadSearchArchived 能力时为真；为假时不发送 includeArchived。 */
  searchArchived?: boolean;
  /** 打开会话并定位到命中的消息；缺省时退回只打开会话。工具命中传入展开工具块的意图，查询词用于目标消息内的关键词高亮。 */
  onOpenMessage?: (session: SessionItem, itemId: string, revealToolBlock: boolean, query: string) => void;
}) {
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const [hitBatch, setHitBatch] = useState<ThreadSearchBatch | null>(null);
  const [messageState, setMessageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [recent, setRecent] = useState<string[]>(readRecentSearches);
  const [includeArchived, setIncludeArchived] = useState(false);
  const rows = sessionRows(folders, query, { includeArchived });
  const allRows = sessionRows(folders, "", { includeArchived });
  const rowsById = new Map(allRows.map(row => [row.session.id, row]));
  const availableThreadIds = new Set(allRows.map(row => row.session.id));
  const { matches: hits, truncated: hitsTruncated } = searchMessages
    ? visibleThreadSearchHits(hitBatch, query, includeArchived, availableThreadIds)
    : { matches: [], truncated: false };
  const options = buildSearchOptions(rows, hits, rowsById);
  const messageOptions = options.filter((option): option is Extract<SearchOption, { kind: "message" }> => option.kind === "message");
  const sessionOptions = options.filter((option): option is Extract<SearchOption, { kind: "session" }> => option.kind === "session");
  const inputRef = useRef<HTMLInputElement>(null), resultsRef = useRef<HTMLDivElement>(null);
  const listId = useId(), statusId = useId();
  const selected = Math.min(index, Math.max(0, options.length - 1));
  useLayoutEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, options[selected]?.key]);
  useEffect(() => {
    const needle = query.trim();
    if (!searchMessages || needle.length < 2) {
      setHitBatch(null); setMessageState("idle");
      return;
    }
    let cancelled = false;
    setMessageState("loading");
    const timer = window.setTimeout(() => {
      void searchThreadMessages(needle, 20, includeArchived).then(result => {
        if (cancelled) return;
        // 响应形状不可信：matches 不是数组时按失败处理，不能把畸形值带进渲染期。
        if (!result || !Array.isArray(result.matches)) { setHitBatch(null); setMessageState("error"); return; }
        setHitBatch({ query: needle, includeArchived, matches: result.matches, truncated: result.truncated === true });
        setMessageState("ready");
      }).catch(() => {
        if (cancelled) return;
        setHitBatch(null); setMessageState("error");
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, searchMessages, includeArchived]);
  const openOption = (option: SearchOption | undefined) => {
    if (!option) return;
    if (query.trim().length >= RECENT_SEARCH_MIN_LENGTH) setRecent(rememberRecentSearch(query));
    if (option.kind === "session") { onSelect(option.row.session); onClose(); return; }
    if (onOpenMessage) {
      const focus = searchHitFocus(option.hit, query);
      onOpenMessage(option.row.session, focus.itemId, focus.revealToolBlock, focus.query);
      onClose();
    } else { onSelect(option.row.session); onClose(); }
  };
  const move = (delta: number) => setIndex(options.length ? (selected + delta + options.length) % options.length : 0);
  const optionProps = (option: SearchOption) => {
    const current = options.findIndex(entry => entry.key === option.key);
    return {
      role: "option" as const, tabIndex: -1, id: `${listId}-${current}`, "aria-selected": current === selected,
      className: `search-result${current === selected ? " highlighted" : ""}${option.kind === "message" ? " search-message-hit" : ""}`,
      onPointerMove: (event: React.PointerEvent) => { if (event.pointerType === "mouse" && (event.movementX || event.movementY)) setIndex(current); },
      onClick: () => openOption(option),
    };
  };
  return <ModalSurface title="搜索聊天" onClose={onClose} className="search-dialog">
    <div className="search-field"><IconSearch size={19} /><input ref={inputRef} role="combobox" aria-label="搜索聊天和项目" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-describedby={statusId} aria-activedescendant={options.length ? `${listId}-${selected}` : undefined} autoComplete="off" placeholder="搜索聊天和项目…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      if (event.key === "Enter" && options[selected]) { event.preventDefault(); event.stopPropagation(); openOption(options[selected]); }
    }} />{query && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setQuery(""); setIndex(0); inputRef.current?.focus(); }}><IconClose size={15} /></button>}</div>
    <div className="search-results" ref={resultsRef}>
      <p id={statusId} role="status">{query.trim() ? `找到 ${rows.length} 个聊天${messageState === "ready" ? `、${messageOptions.length} 条消息` : ""}` : "最近聊天"}</p>
      {!query.trim() && recent.length > 0 && <div className="search-recent" role="group" aria-label="最近搜索">
        <span className="search-recent-label">最近搜索</span>
        {recent.map(term => <button type="button" key={term} className="search-recent-chip" onClick={() => { setQuery(term); setIndex(0); inputRef.current?.focus(); }}>{term}</button>)}
        <button type="button" className="search-recent-clear" onClick={() => { clearRecentSearches(); setRecent([]); }}>清除</button>
      </div>}
      <div id={listId} role="listbox" aria-label="聊天与消息搜索结果">
        {query.trim().length >= 2 && searchMessages && <>
          <p className="search-message-heading" role="presentation">{messageState === "loading" ? "正在搜索消息…"
            : messageState === "error" ? "消息搜索失败，可继续按标题查找"
            : messageOptions.length ? <>{`消息命中`}{hitsTruncated && <span className="search-truncated" title="搜索有界：最多 100 个会话、50 条消息，较早或过多的命中不会全部返回">仅显示部分结果</span>}</>
            : "没有匹配的消息"}</p>
          {messageOptions.map(option => {
            const { hit, row } = option;
            return <button type="button" key={option.key} title={hit.snippet} {...optionProps(option)}>
              <IconChat size={17} /><span><strong><Highlighted text={row.session.title} query={query} /></strong><small>{row.session.archived === true ? "已归档 · " : ""}{row.project} · {searchRoleLabel(hit.role)} · <Highlighted text={hit.snippet} query={query} /></small></span><IconChevronRight size={13} />
            </button>;
          })}
        </>}
        {sessionOptions.map(option => {
          const { row } = option;
          return <button type="button" key={option.key} {...optionProps(option)}><IconChat size={17} /><span><strong><Highlighted text={row.session.title} query={query} /></strong><small>{row.session.archived === true ? "已归档 · " : ""}{row.project} · {row.session.timeAgo}</small></span><IconChevronRight size={13} /></button>;
        })}
      </div>
      {!sessionOptions.length && !messageOptions.length && messageState !== "loading" && <div className="search-empty"><IconSearch size={28} /><strong>{query.trim() ? "没有找到相关聊天或消息" : "还没有聊天"}</strong><span>{query.trim() ? "试试其他关键词、项目名称或消息内容" : "创建聊天后，可以在这里快速找到它"}</span></div>}
    </div><div className="search-footer">{searchArchived && <label className="search-archived-toggle" title="同时搜索已归档会话；归档不会删除消息"><input type="checkbox" checked={includeArchived} onChange={event => { setIncludeArchived(event.target.checked); setIndex(0); }} />含已归档</label>}<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>
  </ModalSurface>;
}
