import type { MessageItem } from "./mockData";
import { messageCopyText } from "./messageCopy";

/**
 * 标题栏「导出为 Markdown」的正文拼装。
 * 正文、段落与导出列表保持原有顺序；工具记录复用复制文本，保留结果徽标、来源、
 * 错误码与恢复建议，避免导出的写操作看起来像已成功。
 */
export function exportMarkdown(title: string, messages: MessageItem[]): string {
  const sections = messages.map(message => {
    const tool = message.toolUse ? messageCopyText({ toolUse: message.toolUse }) : "";
    const body = [
      message.content,
      ...(message.paragraphs ?? []),
      ...(message.bullets ?? []).map(line => `- ${line}`),
      tool,
    ].filter(Boolean).join("\n\n");
    return `## ${message.role === "user" ? "你" : "BOSS Harness"}\n\n${body}`;
  });
  return `# ${title}\n\n${sections.join("\n\n")}`;
}
