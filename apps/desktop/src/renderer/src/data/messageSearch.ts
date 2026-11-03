import type { MessageItem } from "./mockData";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN");

/** 在当前聊天中查找时参与匹配的可见文本；工具结果与思考过程不展开。 */
function messageText(item: MessageItem): string {
  return [item.content ?? "", ...(item.paragraphs ?? []), ...(item.bullets ?? [])].join("\n");
}

/**
 * 返回匹配消息的 id，按消息顺序排列。
 * 查询为空（或只有空白）时不选中任何消息；匹配使用 NFKC 归一化且不区分大小写。
 */
export function findMessageMatches(messages: MessageItem[], query: string): string[] {
  const needle = normalize(query).trim();
  if (!needle) return [];
  return messages.filter(item => normalize(messageText(item)).includes(needle)).map(item => item.id);
}
