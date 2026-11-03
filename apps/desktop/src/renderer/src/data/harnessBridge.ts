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
  type TurnAutoCompactionOverride,
  type TurnSteerParams,
  type QueueAddParams,
  type QueueItem,
  type QueueItemResponse,
  type QueueListResponse,
  type ModelListResponse,
  type SkillDescriptor,
  type SkillListResponse,
  type ToolDescriptor,
  type ToolListResponse,
  type ConnectionReport,
  type ConnectionTarget,
  type ConfigReadResponse,
  type ContextReadResponse,
  type ContextCompactPlan,
  type ContextCompactPlanParams,
  type ContextCompactStartParams,
  type ContextCompactJob,
  type ContextCompactAbortResponse,
  type ContextEditReadResponse,
  type ApprovalRespondResponse,
  type ThreadBranchesListResponse,
  type ThreadBranchSummaryReadResponse,
  type ThreadLeafState,
  type ThreadLeafSetParams,
  type TurnListResponse,
  type ThreadUsageReadResponse,
} from "@boss-cli/protocol";
import { formatRelativeTime } from "@boss-cli/shared";
import { queuePageOf, type QueuePage } from "./queueMapping";
import type { MessageItem, SessionItem } from "./mockData";

export const HARNESS_PROJECT_ID = "proj-harness";
export const HARNESS_PROJECT_NAME = "本机会话（内核）";

interface HarnessBridge {
  request<T>(method: string, params?: unknown): Promise<T>;
  status(): Promise<HarnessStatus>;
  reconnect(): Promise<HarnessStatus>;
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

/** 工具目录状态：把「还没读到」「读取失败」和「确实没有工具」分开，界面不能把它们混为一谈。 */
export type ToolCatalogState = "unavailable" | "loading" | "ready" | "empty" | "error";

export async function harnessStatus(): Promise<HarnessStatus | null> {
  try { return await bridge()?.status() ?? null; }
  catch { return { running: false, repoRoot: "", error: "无法连接本地内核" }; }
}

function bridge(): HarnessBridge | null {
  if (typeof window === "undefined") return null;
  return window.boss ?? null;
}

/** 渲染层展示用的内核错误文案：保留 RPC 错误码与可选原因码，其余回退为通用描述。 */
export function harnessErrorText(error: unknown): string {
  const value = error && typeof error === "object"
    ? error as { rpcError?: unknown; code?: unknown; message?: unknown; data?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : null;
  const raw = typeof value?.message === "string" && value.message.trim() ? value.message : "";
  // 未被主进程保留为 RPC 错误的方法只留下 Electron 拼接后的消息；去掉包装前缀再展示。
  const message = raw ? raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 300)
    : "无法读取本地内核响应";
  if (value?.rpcError === true && typeof value.code === "number") {
    return `${message}（内核 ${value.code}${typeof data?.code === "string" ? ` / ${data.code}` : ""}）`;
  }
  return message;
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

/** 会话内分支：仅在内核声明 sessionLeaf / sessionBranchTree / sessionBranchViews 后调用；错误保留内核错误码。 */
export const listThreadBranches = (threadId: string, cursor?: string | null): Promise<ThreadBranchesListResponse> =>
  contextRequest(ClientMethods.threadBranchesList, cursor ? { threadId, cursor, limit: 200 } : { threadId, limit: 200 });
export const setThreadLeaf = (params: ThreadLeafSetParams): Promise<ThreadLeafState> => contextRequest(ClientMethods.threadLeafSet, params);
/** 被放弃分支摘要正文；仅在内核声明 sessionBranchSummaryRead 后调用。 */
export const readBranchSummary = (threadId: string, entryId: string): Promise<ThreadBranchSummaryReadResponse> =>
  contextRequest(ClientMethods.threadBranchSummaryRead, { threadId, entryId });
/** 会话用量：仅在内核声明 threadUsage 后调用；只读，错误保留内核错误码。 */
export const readThreadUsage = (threadId: string, view: "log" | "branch", cursor?: string | null): Promise<ThreadUsageReadResponse> =>
  contextRequest(ClientMethods.threadUsageRead, cursor ? { threadId, view, cursor, limit: 200 } : { threadId, view, limit: 200 });
export const listBranchTurns = (threadId: string, cursor?: string | null): Promise<TurnListResponse> =>
  contextRequest(ClientMethods.threadTurnsList, cursor ? { threadId, view: "branch", cursor, limit: 200 } : { threadId, view: "branch", limit: 200 });

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

/** 内核里的会话列表，映射成侧栏用的条目。读取失败时抛出，避免把空列表误当成「没有会话」。 */
export async function listThreads(): Promise<SessionItem[]> {
  if (!bridge()) return [];
  const threads: ThreadListResponse["threads"] = [];
  let cursor: string | null = null;
  do {
    const response: ThreadListResponse = await contextRequest<ThreadListResponse>(ClientMethods.threadList, { cursor, limit: 200 });
    if (!response || !Array.isArray(response.threads)) throw new Error("会话列表响应格式无法识别");
    const next: string | null = response.nextCursor ?? null;
    if (next !== null && typeof next !== "string") throw new Error("会话列表分页游标无法识别");
    if (next === cursor) throw new Error("会话列表分页未前进");
    threads.push(...response.threads);
    cursor = next;
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

export async function sendTurn(threadId: string, input: string, clientUserMessageId: string, model?: string, skillIds: string[] = [], autoCompaction?: TurnAutoCompactionOverride): Promise<TurnStartResponse | null> {
  const api = bridge();
  if (!api) return null;
  try {
    // 不发送空对象：省略字段时内核沿用启动时的压缩策略。
    return await api.request(ClientMethods.turnStart, {
      threadId, input, clientUserMessageId, model, skillIds,
      ...(autoCompaction ? { autoCompaction } : {}),
    });
  } catch {
    return null;
  }
}

export function readConfig(): Promise<ConfigReadResponse> {
  return contextRequest(ClientMethods.configRead, {});
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

/** 中断当前回合。返回内核的如实回报：没有在跑的回合时为 false；请求失败由调用方重新读取状态。 */
export async function interruptTurn(threadId: string): Promise<boolean> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<TurnInterruptResponse>(ClientMethods.turnInterrupt, { threadId });
  return response.interrupted === true;
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

/** 会话队列的当前投影。失败不吞掉：调用方要保留面板旧内容并明确提示，而不是当成「队列为空」。 */
export async function listQueue(threadId: string): Promise<QueuePage> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const page = queuePageOf(await api.request<QueueListResponse>(ClientMethods.queueList, { threadId }));
  if (!page) throw new Error("队列列表响应无法识别");
  return page;
}

export async function readQueueItem(threadId: string, queueId: string): Promise<QueueItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<QueueItemResponse>(ClientMethods.queueGet, { threadId, queueId });
  return response.queueItem;
}

export async function removeQueuedItem(threadId: string, queueId: string): Promise<QueueItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<QueueItemResponse>(ClientMethods.queueRemove, { threadId, queueId });
  return response.queueItem;
}

/** 审批应答的送达结果：accepted 表示内核已受理；rejected 表示内核明确不受理；unconfirmed 表示请求没送到或回报不可读。 */
export type ApprovalDelivery = "accepted" | "rejected" | "unconfirmed";

/** 回答一次工具审批。区分「内核明确不受理」与「请求未送达」，调用方据此决定是否把审批卡放回界面。 */
export async function respondApproval(approvalId: string, approved: boolean): Promise<ApprovalDelivery> {
  const api = bridge();
  if (!api) return "unconfirmed";
  try {
    const response = await api.request<ApprovalRespondResponse>(ClientMethods.approvalRespond, { approvalId, approved });
    return response?.accepted === true ? "accepted" : "rejected";
  } catch {
    return "unconfirmed";
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

/** 本机可用模型线路。读取失败不吞掉：调用方要保留旧选项并提示，而不是把失败显示成「没有可选模型」。 */
export async function configuredModels(): Promise<ModelListResponse["models"]> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<ModelListResponse>(ClientMethods.modelList);
  if (!response || !Array.isArray(response.models)) throw new Error("模型列表响应无法识别");
  return response.models;
}

export async function listSkills(): Promise<SkillDescriptor[]> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  return (await api.request<SkillListResponse>(ClientMethods.skillsList)).skills;
}

/** 内核声明的工具清单。读取失败不吞掉：调用方要区分「没有工具」与「读取失败」。 */
export async function listTools(): Promise<ToolDescriptor[]> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<ToolListResponse>(ClientMethods.toolList);
  if (!response || !Array.isArray(response.tools)) throw new Error("工具清单响应无法识别");
  return response.tools;
}

export async function connectionReport(target?: ConnectionTarget): Promise<ConnectionReport> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  return api.request(target ? ClientMethods.connectionCheck : ClientMethods.connectionRead, target ? { target } : {});
}

/** 重连本地内核。返回真实状态与原因：调用方要据此提示，而不是把失败当作无事发生。 */
export async function reconnectHarness(): Promise<HarnessStatus> {
  const api = bridge();
  if (!api) return { running: false, repoRoot: "", error: "本地 Harness 未连接" };
  try { return await api.reconnect(); }
  catch (cause) { return { running: false, repoRoot: "", error: harnessErrorText(cause) }; }
}

/** 从指定回合分叉新会话。失败不吞掉：调用方要用真实原因提示，而不是猜「回合未结束」。 */
export async function forkThread(threadId: string, turnId: string): Promise<SessionItem> {
  const api = bridge();
  if (!api) throw new Error("本地 Harness 未连接");
  const response = await api.request<ThreadReadResponse>(ClientMethods.threadFork, { threadId, turnId });
  if (!response || !response.thread || typeof response.thread.id !== "string" || !response.thread.id) {
    throw new Error("分支响应无法识别");
  }
  return { id: response.thread.id, title: response.thread.title, timeAgo: "刚刚", status: "idle", projectId: HARNESS_PROJECT_ID,
    toolPolicy: response.thread.toolPolicy ?? "approval", provider: response.thread.provider,
    model: response.thread.model, reasoningEffort: response.thread.reasoningEffort };
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
