import type { MessageItem } from "./mockData";
import { toolOutcomeBadge } from "./toolOutcome";
import { toolCompletedTimingLabel } from "./toolTiming";

type CopySource = Pick<MessageItem, "content" | "paragraphs" | "plan" | "toolUse">;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 消息工具栏可复制的文本。
 *
 * 优先气泡中展示的段落，其次正文；没有正文时复制计划正文，
 * 最后按工具卡可见字段拼装：工具名、结果徽标、耗时、来源编号、输入、
 * 错误码、恢复建议与输出/结果。思考过程不算消息正文。
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
  const badge = toolOutcomeBadge(tool.executionState, tool.status, tool.errorCode);
  const timing = toolCompletedTimingLabel(tool);
  const sourceRef = text(tool.source?.ref);
  const errorCode = text(tool.errorCode);
  const recoveryAction = text(tool.recoveryAction);
  return [
    `工具：${tool.name || "tool"}`,
    badge ? `状态：${badge.label}` : null,
    timing,
    text(tool.input),
    sourceRef ? `来源编号：${sourceRef}` : null,
    errorCode ? `错误码：${errorCode}` : null,
    recoveryAction ? `恢复建议：${recoveryAction}` : null,
    text(tool.output) ?? text(tool.result),
  ].filter((part): part is string => part !== null).join("\n\n");
}
