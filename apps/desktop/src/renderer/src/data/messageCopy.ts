import type { MessageItem } from "./mockData";

type CopySource = Pick<MessageItem, "content" | "paragraphs" | "plan" | "toolUse">;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 消息工具栏可复制的文本。
 *
 * 优先气泡中展示的段落，其次正文；没有正文时复制计划正文，
 * 最后按工具名称、输入、错误码与结果拼装。思考过程不算消息正文。
 * 没有任何可复制内容时返回空串，调用方不应显示复制或引用入口。
 */
export function messageCopyText(item: CopySource): string {
  const paragraphs = (item.paragraphs ?? []).filter((part): part is string => text(part) !== null);
  if (paragraphs.length) return paragraphs.join("\n\n");
  const content = text(item.content);
  if (content) return content;
  const plan = text(item.plan?.content);
  if (plan) return plan;
  const tool = item.toolUse;
  if (!tool) return "";
  return [
    `工具：${tool.name || "tool"}`,
    text(tool.input),
    text(tool.errorCode ? `错误码：${tool.errorCode}` : null),
    text(tool.output) ?? text(tool.result),
  ].filter((part): part is string => part !== null).join("\n\n");
}
