import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { MessageItem } from "./mockData";
import { searchText } from "./searchText";

/** 在当前聊天中查找时参与匹配的可见文本；工具结果与思考过程默认不展开。 */
function messageText(item: MessageItem): string {
  return [item.content ?? "", ...(item.paragraphs ?? []), ...(item.bullets ?? [])].join("\n");
}

function messageDetailText(item: MessageItem): string {
  return [
    item.thinkingContent ?? "",
    item.toolUse?.input ?? "",
    item.toolUse?.result ?? "",
    item.toolUse?.output ?? "",
  ].join("\n");
}

/**
 * 返回匹配消息的 id，按消息顺序排列。
 * 查询为空（或只有空白）时不选中任何消息；匹配使用 NFKC 归一化且不区分大小写。
 * `includeDetails` 为真时额外匹配思考内容与工具调用的输入、结果、输出。
 */
export function findMessageMatches(messages: MessageItem[], query: string, options: { includeDetails?: boolean } = {}): string[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  return messages
    .filter(item => searchText(messageText(item) + (options.includeDetails ? "\n" + messageDetailText(item) : "")).includes(needle))
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
 * 只统计实际会渲染的折叠块：没有思考时长不渲染思考块，`resultRef` 存在时输出改为按需读取、不进入正文 DOM；
 * 归一化与 `findMessageMatches` 一致，保证展开的块与计数来自同一套匹配语义。
 */
export function findFoldedMatches(messages: MessageItem[], query: string): FoldedMessageMatch[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  const hit = (text: string | undefined) =>
    typeof text === "string" && text.length > 0 && searchText(text).includes(needle);
  const matches: FoldedMessageMatch[] = [];
  for (const item of messages) {
    // `resultRef` 存在时结构化输出改为按需读取，原始 output 不进入正文 DOM。
    const outputText = item.toolUse?.resultRef ? undefined : item.toolUse?.output;
    const thinking = Boolean(item.thinkingTime) && hit(item.thinkingContent);
    const tool = Boolean(item.toolUse) && (hit(item.toolUse?.input) || hit(item.toolUse?.result) || hit(outputText));
    const output = hit(outputText);
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
