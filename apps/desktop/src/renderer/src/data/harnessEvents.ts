import type { ApprovalState, ProviderFailureInfo, QueueItem, ThreadItem } from "@boss-harness/protocol";
import type { MessageItem } from "./mockData";
import { toMessage, type ApprovalDelivery } from "./harnessBridge";
import { approvalDeadlineMs } from "./pendingApprovals";
import { toolDurationMs } from "./toolTiming";

export interface HarnessEvent {
  method: string;
  params?: {
    threadId?: string; turnId?: string; itemId?: string; kind?: ThreadItem["kind"];
    text?: string; delta?: string; message?: string; thinking?: string;
    status?: string; toolName?: string; arguments?: Record<string, unknown>;
    /** 工具事件的执行状态；内核旧版本缺省，渲染层按未知处理。 */
    executionState?: string;
    resultSummary?: string; error?: { code?: string; message?: string };
    code?: string; recoveryAttempted?: boolean; outputObserved?: boolean;
    errorInfo?: ProviderFailureInfo;
    result?: ThreadItem["result"];
    resultOmitted?: boolean;
    resultRef?: ThreadItem["resultRef"];
    textOmitted?: boolean; textRef?: ThreadItem["textRef"];
    thinkingOmitted?: boolean; thinkingRef?: ThreadItem["thinkingRef"];
    source?: ThreadItem["source"];
    approvalId?: string; summary?: string; params?: Record<string, unknown>;
    consequential?: boolean; approval?: ApprovalState;
    /** approval/requested 的等待截止时间；缺失或非法时审批卡不显示倒计时。 */
    deadline?: number;
    /** toolCall/completed 的内核测量耗时（毫秒）；旧内核不返回。 */
    durationMs?: number;
    eventCursor?: string; eventId?: string; clientUserMessageId?: string;
    state?: string; generation?: number; running?: boolean;
    queueId?: string; queue?: QueueItem[];
    /** model/retryStarted / model/retryEnded（仅观测，见 data/modelRetry.ts）。 */
    attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string;
    success?: boolean; reason?: string; finalError?: string;
  };
}

const TOOL_STATUSES = new Set<NonNullable<ThreadItem["status"]>>(["running", "completed", "failed"]);
const TOOL_EXECUTION_STATES = new Set<NonNullable<ThreadItem["executionState"]>>([
  "queued", "pending_approval", "approved", "not_approved", "executing",
  "completed", "failed", "not_executed", "outcome_unknown",
]);

/** 校验事件里的工具状态；未知值按缺失处理，不把内核新增状态当成已知。 */
function toolStatus(value: unknown): ThreadItem["status"] {
  return typeof value === "string" && TOOL_STATUSES.has(value as NonNullable<ThreadItem["status"]>)
    ? value as NonNullable<ThreadItem["status"]> : undefined;
}

function toolExecutionState(value: unknown): ThreadItem["executionState"] {
  return typeof value === "string" && TOOL_EXECUTION_STATES.has(value as NonNullable<ThreadItem["executionState"]>)
    ? value as NonNullable<ThreadItem["executionState"]> : undefined;
}

/** 启动卡正文与徽标保持一致：等待审批的工具不能显示成正在执行。 */
function runningToolText(state: ThreadItem["executionState"]): string {
  switch (state) {
    case "pending_approval": return "等待审批";
    case "queued": return "排队中";
    case "not_approved": return "未获批准";
    default: return "正在执行";
  }
}

/** 同一 itemId 的增量、工具状态与审批更新合并到同一条卡片。 */
export function reduceHarnessEvent(previous: MessageItem[], event: HarnessEvent, receivedAt = Date.now()): MessageItem[] {
  const params = event.params ?? {};
  const at = Number.isFinite(receivedAt) ? receivedAt : undefined;
  const id = params.itemId ?? (params.approvalId ? `approval-${params.approvalId}` : undefined);
  if (!id) return previous;
  const index = previous.findIndex(item => item.id === id || item.id === params.clientUserMessageId || (params.approvalId && item.approval?.approvalId === params.approvalId));
  const before = index >= 0 ? previous[index] : undefined;
  let item: MessageItem = before ?? { id, turnId: params.turnId, role: "agent", paragraphs: [] };
  switch (event.method) {
    case "agentMessage/delta":
      item = { ...item, paragraphs: [(item.paragraphs?.join("") ?? "") + (params.delta ?? "")] };
      break;
    case "agentThinking/delta":
      item = { ...item, thinkingTime: "思考过程", thinkingContent: (item.thinkingContent ?? "") + (params.delta ?? "") };
      break;
    case "item/completed": {
      if (params.kind !== "agentMessage" && params.kind !== "userMessage") return previous;
      const message = toMessage({ id, threadId: params.threadId ?? "", turnId: params.turnId,
        kind: params.kind, text: params.text ?? before?.paragraphs?.join(""),
        thinking: params.thinking ?? before?.thinkingContent });
      item = { ...item, ...message };
      break;
    }
    case "approval/decided": {
      if (!params.approval) return previous;
      const executionState = toolExecutionState(params.executionState);
      item = { ...item, approval: params.approval,
        ...(item.toolUse && executionState ? { toolUse: { ...item.toolUse, executionState,
          // 审批通过后重新开始执行计时；等待审批的时长不计入工具耗时。
          ...(executionState === "approved" && at !== undefined ? { startedAt: at, waitingSince: undefined } : {}) } } : {}) };
      break;
    }
    case "toolCall/started": {
      const executionState = toolExecutionState(params.executionState);
      // 只有等待审批才是真正的等待；queued 表示即将派发，按开始执行计时。
      const waiting = executionState === "pending_approval";
      item = { ...item, toolUse: { name: params.toolName ?? "tool", input: JSON.stringify(params.arguments ?? {}, null, 2),
        result: runningToolText(executionState), ...(executionState ? { executionState } : {}),
        // 等待审批只记录等待起点；真正开始执行的时间由审批裁决补充。
        ...(at === undefined ? {} : waiting ? { waitingSince: at } : { startedAt: at }) } };
      break;
    }
    case "toolCall/executing": {
      if (!item.toolUse) return previous;
      item = { ...item, toolUse: { ...item.toolUse, executionState: "executing", result: runningToolText("executing"),
        // 保留启动事件记录的最早开始时间；审批通过事件可能已先行记录。
        ...(at !== undefined && item.toolUse.startedAt === undefined ? { startedAt: at } : {}),
        waitingSince: undefined } };
      break;
    }
    case "toolCall/completed": {
      const status = toolStatus(params.status);
      const executionState = toolExecutionState(params.executionState);
      const errorCode = typeof params.error?.code === "string" && params.error.code ? params.error.code : undefined;
      const durationMs = toolDurationMs(params.durationMs);
      const toolUse: NonNullable<MessageItem["toolUse"]> = { ...item.toolUse,
        source: params.source ?? item.toolUse?.source,
        name: params.toolName ?? item.toolUse?.name ?? "tool",
        input: item.toolUse?.input ?? "{}",
        result: params.resultSummary ?? params.error?.message ?? params.status ?? "已结束" };
      // 完成事件是终态：内核没带的状态必须清掉，否则新内核的启动态（如等待审批）会残留到结束。
      if (status) toolUse.status = status; else delete toolUse.status;
      if (executionState) toolUse.executionState = executionState; else delete toolUse.executionState;
      if (errorCode) toolUse.errorCode = errorCode; else delete toolUse.errorCode;
      if (durationMs !== undefined) toolUse.durationMs = durationMs; else delete toolUse.durationMs;
      // 内核耗时缺失时用本机时钟回退；没有开始记录（如刷新后接入在途调用）则不显示耗时。
      if (at !== undefined && item.toolUse?.startedAt !== undefined) toolUse.endedAt = at; else delete toolUse.endedAt;
      item = { ...item, toolUse, ...(params.approval ? { approval: params.approval } : {}) };
      if (params.result) item = { ...item, toolUse: { ...item.toolUse!, resultRef: undefined, output: JSON.stringify(params.result, null, 2) } };
      else if (params.resultRef) item = { ...item, toolUse: { ...item.toolUse!, resultRef: params.resultRef, output: undefined } };
      else if (params.resultOmitted) item = { ...item, toolUse: { ...item.toolUse!, resultRef: undefined, output: "结果较大，实时详情已省略；完整结果已保存到会话历史。" } };
      break;
    }
    case "approval/requested": {
      if (!params.approvalId) return previous;
      const deadline = approvalDeadlineMs(params.deadline);
      item = { ...item, approval: { approvalId: params.approvalId, toolName: params.toolName ?? "tool", description: params.summary ?? "该操作需要你的批准", params: params.params ?? {}, consequential: params.consequential ?? true, ...(deadline !== undefined ? { deadline } : {}) } };
      break;
    }
    default: return previous;
  }
  return index >= 0 ? previous.map((message, slot) => slot === index ? item : message) : [...previous, item];
}

/**
 * 「本会话始终批准」的自动应答收尾：只有内核确认受理时才吞掉审批事件。
 * 未受理时把卡片放回消息列表，否则回合会一直等待一个界面上不存在的决定。
 */
export function autoApprovalFallback(previous: MessageItem[], event: HarnessEvent, delivery: ApprovalDelivery): MessageItem[] {
  return delivery === "accepted" ? previous : reduceHarnessEvent(previous, event);
}
