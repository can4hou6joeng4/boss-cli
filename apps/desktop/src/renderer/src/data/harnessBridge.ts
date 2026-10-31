/**
 * 内核桥接：映射真实协议数据；示例模式由 App 显式选择。
 *
 * 这里只做「协议 → 界面数据模型」的映射，不放任何业务规则；
 * 组件仍然只依赖 mockData 里的类型，因此离线开发体验不受影响。
 */
import {
  ClientMethods,
  type InitializeResponse,
  type ApprovalState,
  type ThreadItem,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadSummary,
  type ThreadStartResponse,
  type ThreadModelSetResponse,
  type ThreadReasoningReadResponse,
  type ThreadReasoningSetResponse,
  type TurnInterruptResponse,
  type TurnContinuationReadParams,
  type TurnContinuationReadResponse,
  type TurnContinueParams,
  type TurnContinueResponse,
  type TurnStartResponse,
  type TurnSteerParams,
  type QueueAddParams,
  type QueueItem,
  type QueueItemResponse,
  type QueueListResponse,
  type ModelListResponse,
  type SkillDescriptor,
  type SkillListResponse,
  type ConnectionReport,
  type ConnectionTarget,
  type ContextReadResponse,
  type ContextCompactPlan,
  type ContextCompactPlanParams,
  type ContextCompactStartParams,
  type ContextCompactJob,
  type ContextCompactAbortResponse,
  type ContextEditReadResponse,
  type ApprovalRespondResponse,
} from "@boss-cli/protocol";
import { formatRelativeTime } from "@boss-cli/shared";
import type { MessageItem, SessionItem } from "./mockData";

export const HARNESS_PROJECT_ID = "proj-harness";
export const HARNESS_PROJECT_NAME = "本机会话（内核）";

interface HarnessBridge {
  request<T>(method: string, params?: unknown): Promise<T>;
  status(): Promise<HarnessStatus>;
  onNotification(listener: (notification: unknown) => void): () => void;
}

export interface HarnessStatus {
  running: boolean;
  repoRoot: string;
  modelBridge?: { provider: string; model: string; driven: boolean };
  capabilities?: InitializeResponse["capabilities"];
  error?: string;
  state?: string;
  generation?: number;
}

export type SkillCatalogState = "unavailable" | "loading" | "ready" | "empty" | "error";

export async function harnessStatus(): Promise<HarnessStatus | null> {
  try { return await bridge()?.status() ?? null; }
  catch { return { running: false, repoRoot: "", error: "无法连接本地内核" }; }
}

function bridge(): HarnessBridge | null {
  if (typeof window === "undefined") return null;
  return window.boss ?? null;
}

function contextRequest<T>(method: string, params: unknown): Promise<T> {
  const api = bridge();
  if (!api) return Promise.reject(new Error("本地 Harness 未连接"));
  return api.request<unknown>(method, params).then(response => {
    if (response && typeof response === "object" && "__harnessRpcError" in response) {
      const rpc = (response as { __harnessRpcError?: { code?: unknown; message?: unknown; data?: unknown } }).__harnessRpcError;
      if (rpc && typeof rpc.code === "number" && typeof rpc.message === "string") {
        const error = new Error(rpc.message) as Error & { code: number; data: unknown; rpcError: true };
        error.name = "HarnessRpcError";
        error.code = rpc.code;
        error.data = rpc.data;
        error.rpcError = true;
        throw error;
      }
    }
    return response as T;
  });
}

export const readContext = (threadId: string): Promise<ContextReadResponse> => contextRequest(ClientMethods.contextRead, { threadId });
export const planContextCompaction = (params: ContextCompactPlanParams): Promise<ContextCompactPlan> => contextRequest(ClientMethods.contextCompactPlan, params);
export const startContextCompaction = (params: ContextCompactStartParams): Promise<ContextCompactJob> => contextRequest(ClientMethods.contextCompactStart, params);
export const readContextCompaction = (jobId: string): Promise<ContextCompactJob> => contextRequest(ClientMethods.contextCompactRead, { jobId });
export const abortContextCompaction = (jobId: string): Promise<ContextCompactAbortResponse> => contextRequest(ClientMethods.contextCompactAbort, { jobId });
export const readContextEdit = (threadId: string, itemId: string): Promise<ContextEditReadResponse> =>
  contextRequest(ClientMethods.contextEditRead, { threadId, itemId });
export const writeContextEdit = (params: { threadId: string; itemId: string; sourceDigest: string; replacementText: string | null }): Promise<ContextEditReadResponse> =>
  contextRequest(ClientMethods.contextEdit, params);

/** 内核是否已连接（preload 未注入或进程未起时返回 false）。 */
export async function isHarnessUp(): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    return (await api.status()).running;
  } catch {
    return false;
  }
}

/** 内核里的会话列表，映射成侧栏用的条目。 */
export async function listThreads(): Promise<SessionItem[]> {
  const api = bridge();
  if (!api) return [];
  try {
    const threads: ThreadListResponse["threads"] = [];
    let cursor: string | null = null;
    do {
      const response: ThreadListResponse = await api.request(ClientMethods.threadList, { cursor, limit: 200 });
      threads.push(...response.threads);
      cursor = response.nextCursor ?? null;
    } while (cursor);
    return threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      timeAgo: formatRelativeTime(thread.updatedAt),
      updatedAt: thread.updatedAt,
      status: thread.lastTurn?.status === "running" ? "running" as const
        : thread.lastTurn?.status === "interrupted" ? "interrupted" as const : "idle" as const,
      turnId: thread.lastTurn?.turnId,
      lastTurnStatus: thread.lastTurn?.status,
      taskResumePolicy: thread.lastTurn?.taskResumePolicy,
      toolPolicy: thread.toolPolicy ?? "approval",
      provider: thread.provider,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      projectId: HARNESS_PROJECT_ID,
    }));
  } catch {
    return [];
  }
}

export async function startThread(title: string, model?: string, provider?: string): Promise<SessionItem | null> {
  const api = bridge();
  if (!api) return null;
  try {
    const response = await api.request<ThreadStartResponse>(
      ClientMethods.threadStart,
      { title, provider, model, toolPolicy: "readOnly" },
    );
    return {
      id: response.thread.id,
      title: response.thread.title,
      timeAgo: formatRelativeTime(response.thread.updatedAt),
      updatedAt: response.thread.updatedAt,
      toolPolicy: response.thread.toolPolicy,
      provider: response.thread.provider,
      model: response.thread.model,
      reasoningEffort: response.thread.reasoningEffort,
      status: "idle",
      projectId: HARNESS_PROJECT_ID,
    };
  } catch {
    return null;
  }
}

export async function setThreadModel(threadId: string, provider: string, model: string): Promise<ThreadSummary> {
  const response = await contextRequest<ThreadModelSetResponse>(ClientMethods.threadModelSet, { threadId, provider, model });
  return response.thread;
}

export async function sendTurn(threadId: string, input: string, clientUserMessageId: string, model?: string, skillIds: string[] = []): Promise<TurnStartResponse | null> {
  const api = bridge();
  if (!api) return null;
  try {
    return await api.request(ClientMethods.turnStart, { threadId, input, clientUserMessageId, model, skillIds });
  } catch {
    return null;
  }
}

export function readTurnContinuation(params: TurnContinuationReadParams): Promise<TurnContinuationReadResponse> {
  return contextRequest(ClientMethods.turnContinuationRead, params);
}

export function continueTurn(params: TurnContinueParams): Promise<TurnContinueResponse> {
  return contextRequest(ClientMethods.turnContinue, params);
}

export async function readThreadReasoning(threadId: string): Promise<ThreadReasoningReadResponse> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  return api.request(ClientMethods.threadReasoningRead, { threadId });
}

export async function setThreadReasoning(threadId: string, effort: string | null): Promise<SessionItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<ThreadReasoningSetResponse>(ClientMethods.threadReasoningSet, { threadId, effort });
  const thread = response.thread;
  return { id: thread.id, title: thread.title, timeAgo: formatRelativeTime(thread.updatedAt),
    updatedAt: thread.updatedAt, status: thread.lastTurn?.status === "running" ? "running"
      : thread.lastTurn?.status === "interrupted" ? "interrupted" : "idle",
    turnId: thread.lastTurn?.turnId, lastTurnStatus: thread.lastTurn?.status,
    taskResumePolicy: thread.lastTurn?.taskResumePolicy,
    toolPolicy: thread.toolPolicy ?? "approval", model: thread.model,
    reasoningEffort: thread.reasoningEffort, projectId: HARNESS_PROJECT_ID };
}

/** 中断当前回合。返回内核的如实回报：没有在跑的回合时为 false。 */
export async function interruptTurn(threadId: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    const response = await api.request<TurnInterruptResponse>(ClientMethods.turnInterrupt, { threadId });
    return response.interrupted;
  } catch {
    return false;
  }
}

export async function steerTurn(params: TurnSteerParams): Promise<QueueItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<QueueItemResponse>(ClientMethods.turnSteer, params);
  return response.queueItem;
}

export async function queueFollowUp(params: QueueAddParams): Promise<QueueItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<QueueItemResponse>(ClientMethods.queueAdd, params);
  return response.queueItem;
}

export async function listQueue(threadId: string): Promise<QueueItem[] | null> {
  const api = bridge();
  if (!api) return null;
  try {
    return (await api.request<QueueListResponse>(ClientMethods.queueList, { threadId })).items;
  } catch {
    return null;
  }
}

export async function removeQueuedItem(threadId: string, queueId: string): Promise<QueueItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<QueueItemResponse>(ClientMethods.queueRemove, { threadId, queueId });
  return response.queueItem;
}

/** 回答一次工具审批；返回是否被内核受理（id 过期时会失败）。 */
export async function respondApproval(approvalId: string, approved: boolean): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    const response = await api.request<ApprovalRespondResponse>(ClientMethods.approvalRespond, { approvalId, approved });
    return response.accepted === true;
  } catch {
    return false;
  }
}

export function toMessage(item: ThreadItem): MessageItem | null {
  switch (item.kind) {
    case "userMessage":
      return { id: item.id, turnId: item.turnId, contextEdit: item.contextEdit, role: "user", content: item.text ?? "" };
    case "agentMessage":
      return { id: item.id, turnId: item.turnId, contextEdit: item.contextEdit, role: "agent", paragraphs: item.text ? [item.text] : [],
        ...(item.thinking ? { thinkingTime: "思考过程", thinkingContent: item.thinking } : {}) };
    case "toolCall": {
      const approval = item.approval ? toApproval(item.approval) : undefined;
      return {
        id: item.id,
        turnId: item.turnId,
        role: "agent",
        paragraphs: [],
              toolUse: {
                name: item.toolName ?? "tool",
                source: item.source,
                resultRef: item.resultRef,
                output: item.result ? JSON.stringify(item.result, null, 2) : undefined,
                input: JSON.stringify(item.toolArguments ?? {}, null, 2),
                result: item.resultSummary ?? (item.status === "running" ? "正在执行" : item.status ?? ""),
              },
        ...(approval ? { approval } : {}),
      };
    }
    default:
      return null;
  }
}

export async function configuredModels(): Promise<ModelListResponse["models"]> {
  try { return (await bridge()?.request<ModelListResponse>(ClientMethods.modelList))?.models ?? []; }
  catch { return []; }
}

export async function listSkills(): Promise<SkillDescriptor[]> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  return (await api.request<SkillListResponse>(ClientMethods.skillsList)).skills;
}

export async function connectionReport(target?: ConnectionTarget): Promise<ConnectionReport> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  return api.request(target ? ClientMethods.connectionCheck : ClientMethods.connectionRead, target ? { target } : {});
}

export async function reconnectHarness(): Promise<boolean> {
  try { return (await window.boss.reconnect()).running; }
  catch { return false; }
}

export async function forkThread(threadId: string, turnId: string): Promise<SessionItem | null> {
  try {
    const response = await bridge()?.request<ThreadReadResponse>(ClientMethods.threadFork, { threadId, turnId });
    if (!response) return null;
    return { id: response.thread.id, title: response.thread.title, timeAgo: "刚刚", status: "idle", projectId: HARNESS_PROJECT_ID,
      toolPolicy: response.thread.toolPolicy ?? "approval", provider: response.thread.provider,
      model: response.thread.model, reasoningEffort: response.thread.reasoningEffort };
  } catch { return null; }
}

function toApproval(state: ApprovalState): NonNullable<MessageItem["approval"]> {
  return {
    approvalId: state.approvalId,
    toolName: state.toolName,
    description: state.description,
    params: state.params,
    consequential: state.consequential,
    decision: state.decision,
  } as NonNullable<MessageItem["approval"]>;
}

/** 读回一个线程的全部条目，映射成会话区的消息模型。 */
export async function readThreadMessages(threadId: string): Promise<MessageItem[] | null> {
  const api = bridge();
  if (!api) return null;
  try {
    const response = await api.request<ThreadReadResponse>(ClientMethods.threadRead, { threadId });
    return response.items
      .map(toMessage)
      .filter((message): message is MessageItem => message !== null);
  } catch {
    return null;
  }
}
