import type { ApprovalState, ThreadItem } from "@boss-cli/protocol";
import type { MessageItem } from "./mockData";
import { toMessage } from "./harnessBridge";

export interface HarnessEvent {
  method: string;
  params?: {
    threadId?: string; turnId?: string; itemId?: string; kind?: ThreadItem["kind"];
    text?: string; delta?: string; message?: string; thinking?: string;
    status?: string; toolName?: string; arguments?: Record<string, unknown>;
    resultSummary?: string; error?: { code?: string; message?: string };
    approvalId?: string; summary?: string; params?: Record<string, unknown>;
    consequential?: boolean; approval?: ApprovalState;
  };
}

/** 同一 itemId 的增量、工具状态与审批更新合并到同一条卡片。 */
export function reduceHarnessEvent(previous: MessageItem[], event: HarnessEvent): MessageItem[] {
  const params = event.params ?? {};
  const id = params.itemId ?? (params.approvalId ? `approval-${params.approvalId}` : undefined);
  if (!id) return previous;
  const index = previous.findIndex(item => item.id === id || (params.approvalId && item.approval?.approvalId === params.approvalId));
  const before = index >= 0 ? previous[index] : undefined;
  let item: MessageItem = before ?? { id, role: "agent", paragraphs: [] };
  switch (event.method) {
    case "agentMessage/delta":
      item = { ...item, paragraphs: [(item.paragraphs?.join("") ?? "") + (params.delta ?? "")] };
      break;
    case "agentThinking/delta":
      item = { ...item, thinkingTime: "思考过程", thinkingContent: (item.thinkingContent ?? "") + (params.delta ?? "") };
      break;
    case "item/completed": {
      if (params.kind !== "agentMessage") return previous;
      const message = toMessage({ id, threadId: params.threadId ?? "", kind: "agentMessage", text: params.text, thinking: params.thinking });
      item = { ...item, ...message };
      break;
    }
    case "toolCall/started":
      item = { ...item, toolUse: { name: params.toolName ?? "tool", input: JSON.stringify(params.arguments ?? {}, null, 2), result: "正在执行" } };
      break;
    case "toolCall/completed":
      item = { ...item, toolUse: { name: params.toolName ?? item.toolUse?.name ?? "tool", input: item.toolUse?.input ?? "{}", result: params.resultSummary ?? params.error?.message ?? params.status ?? "已结束" },
        ...(params.approval ? { approval: params.approval } : {}) };
      break;
    case "approval/requested":
      if (!params.approvalId) return previous;
      item = { ...item, approval: { approvalId: params.approvalId, toolName: params.toolName ?? "tool", description: params.summary ?? "该操作需要你的批准", params: params.params ?? {}, consequential: params.consequential ?? true } };
      break;
    default: return previous;
  }
  return index >= 0 ? previous.map((message, slot) => slot === index ? item : message) : [...previous, item];
}
