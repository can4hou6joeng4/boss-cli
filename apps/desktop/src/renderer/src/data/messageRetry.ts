import type { MessageItem } from "./mockData";

function retryableText(item: MessageItem): string | null {
  const text = item.content?.trim();
  return text ? text : null;
}

/**
 * 「重试此轮对话」应重新发送的文本。
 * 用户消息取自身；代理消息取它之前最近的一条用户消息，而不是整个会话的最后一条，
 * 否则点击旧回合会把后续回合的输入重复提交。找不到对应消息或文本为空时返回 null。
 */
export function retryTextForMessage(messages: readonly MessageItem[], messageId: string): string | null {
  const index = messages.findIndex(item => item.id === messageId);
  if (index < 0) return null;
  const target = messages[index];
  if (!target) return null;
  if (target.role === "user") return retryableText(target);
  // 连续的工具调用 / 思考消息同属一个回合，回溯到该回合的用户输入为止。
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (candidate?.role === "user") return retryableText(candidate);
  }
  return null;
}
