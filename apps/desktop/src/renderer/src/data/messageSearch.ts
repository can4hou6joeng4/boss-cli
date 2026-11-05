import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { MessageItem } from "./mockData";
import { searchText } from "./searchText";

/** 正文实际渲染的文本：用户消息渲染 `content`，智能体消息渲染 `paragraphs`。 */
function visibleBodyText(item: MessageItem): string {
  return item.role === "user" ? item.content ?? "" : (item.paragraphs ?? []).join("\n\n");
}

/** 折叠块中会渲染的详情文本；`resultRef` 存在时输出改为按需读取，此时为 `undefined`。 */
export interface VisibleDetailText {
  thinking?: string;
  input?: string;
  result?: string;
  output?: string;
}

/**
 * 折叠块里实际渲染的详情文本，默认收起、不进入正文 DOM。
 * 没有思考时长不渲染思考块；`resultRef` 存在时结构化输出不渲染，原始输出不能参与匹配。
 */
function visibleDetailText(item: MessageItem): VisibleDetailText {
  return {
    thinking: item.thinkingTime ? item.thinkingContent ?? "" : "",
    input: item.toolUse?.input ?? "",
    result: item.toolUse?.result ?? "",
    output: item.toolUse?.resultRef ? "" : item.toolUse?.output ?? "",
  };
}

/**
 * 返回匹配消息的 id，按消息顺序排列。
 * 查询为空（或只有空白）时不选中任何消息；匹配使用 NFKC 归一化且不区分大小写。
 * 只匹配实际渲染的文本：正文按角色取字段，`includeDetails` 为真时额外匹配折叠块中的思考、
 * 工具输入 / 结果 / 结构化输出。各字段独立匹配，不把记录里存在但界面不渲染的字段计入，
 * 避免计数命中却既无高亮也无折叠块可展开。
 */
export function findMessageMatches(messages: MessageItem[], query: string, options: { includeDetails?: boolean } = {}): string[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  const hit = (text: string | undefined) =>
    typeof text === "string" && text.length > 0 && searchText(text).includes(needle);
  return messages
    .filter(item => hit(visibleBodyText(item))
      || (options.includeDetails === true && Object.values(visibleDetailText(item)).some(hit)))
    .map(item => item.id);
}

/** 命中位于折叠块内的消息，用于「包含详情」查找时展开当前命中的块。 */
export interface FoldedMessageMatch {
  id: string;
  /** 思考块正文命中。 */
  thinking: boolean;
  /** 工具块正文（输入 / 结果 / 结构化输出）命中。 */
  tool: boolean;
  /** 工具块内直接渲染的结构化输出命中。 */
  output: boolean;
}

/**
 * 找出「包含详情」查找中命中位于折叠块内的消息，按消息顺序排列。
 * 与 `findMessageMatches` 共用 `visibleDetailText`：只统计实际会渲染的折叠块，
 * 没有思考时长不渲染思考块，`resultRef` 存在时输出按需读取、不展开内层。
 */
export function findFoldedMatches(messages: MessageItem[], query: string): FoldedMessageMatch[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  const hit = (text: string | undefined) =>
    typeof text === "string" && text.length > 0 && searchText(text).includes(needle);
  const matches: FoldedMessageMatch[] = [];
  for (const item of messages) {
    const detail = visibleDetailText(item);
    const thinking = hit(detail.thinking);
    const tool = Boolean(item.toolUse) && (hit(detail.input) || hit(detail.result) || hit(detail.output));
    const output = hit(detail.output);
    if (thinking || tool) matches.push({ id: item.id, thinking, tool, output });
  }
  return matches;
}

/** 一次消息搜索的结果批次；记录发起时的查询与归档范围，用于判断结果是否已过期。 */
export interface ThreadSearchBatch {
  query: string;
  includeArchived: boolean;
  matches: ThreadSearchMatch[];
  truncated: boolean;
}

export interface VisibleThreadSearchHits {
  matches: ThreadSearchMatch[];
  truncated: boolean;
}

/**
 * 只展示与当前查询和归档范围一致的消息命中批次。
 * 查询变化后旧批次仍留在组件状态里，若直接渲染会让旧命中继续可点开；
 * 这里在渲染期判定批次是否对应当前输入，并继续按当前可见会话过滤。
 */
export function visibleThreadSearchHits(
  batch: ThreadSearchBatch | null,
  query: string,
  includeArchived: boolean,
  availableThreadIds: ReadonlySet<string>,
): VisibleThreadSearchHits {
  const needle = query.trim();
  if (!batch || !needle || batch.query !== needle || batch.includeArchived !== includeArchived) {
    return { matches: [], truncated: false };
  }
  return {
    matches: batch.matches.filter(match => availableThreadIds.has(match.threadId)),
    truncated: batch.truncated,
  };
}
