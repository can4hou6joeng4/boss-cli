/**
 * 内核桥接：映射真实协议数据；示例模式由 App 显式选择。
 *
 * 这里只做「协议 → 界面数据模型」的映射，不放任何业务规则；
 * 组件仍然只依赖 mockData 里的类型，因此离线开发体验不受影响。
 */
import {
  ClientMethods,
  type ApprovalState,
  type ThreadItem,
  type ThreadListResponse,
  type ThreadReadResponse,
  type TurnInterruptResponse,
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
  error?: string;
}

export async function harnessStatus(): Promise<HarnessStatus | null> {
  try { return await bridge()?.status() ?? null; }
  catch { return { running: false, repoRoot: "", error: "无法连接本地内核" }; }
}

function bridge(): HarnessBridge | null {
  if (typeof window === "undefined") return null;
  return window.boss ?? null;
}

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
    const response = await api.request<ThreadListResponse>(ClientMethods.threadList);
    return response.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      timeAgo: formatRelativeTime(thread.updatedAt),
      status: thread.lastTurn?.status === "running" ? "running" as const : "idle" as const,
      turnId: thread.lastTurn?.turnId,
      projectId: HARNESS_PROJECT_ID,
    }));
  } catch {
    return [];
  }
}

export async function startThread(title: string): Promise<SessionItem | null> {
  const api = bridge();
  if (!api) return null;
  try {
    const response = await api.request<{ thread: { id: string; title: string; updatedAt: string } }>(
      ClientMethods.threadStart,
      { title },
    );
    return {
      id: response.thread.id,
      title: response.thread.title,
      timeAgo: formatRelativeTime(response.thread.updatedAt),
      status: "idle",
      projectId: HARNESS_PROJECT_ID,
    };
  } catch {
    return null;
  }
}

export async function sendTurn(threadId: string, input: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    await api.request(ClientMethods.turnStart, { threadId, input });
    return true;
  } catch {
    return false;
  }
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

/** 回答一次工具审批；返回是否被内核受理（id 过期时会失败）。 */
export async function respondApproval(approvalId: string, approved: boolean): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    await api.request(ClientMethods.approvalRespond, { approvalId, approved });
    return true;
  } catch {
    return false;
  }
}

export function toMessage(item: ThreadItem): MessageItem | null {
  switch (item.kind) {
    case "userMessage":
      return { id: item.id, role: "user", content: item.text ?? "" };
    case "agentMessage":
      return { id: item.id, role: "agent", paragraphs: item.text ? [item.text] : [],
        ...(item.thinking ? { thinkingTime: "思考过程", thinkingContent: item.thinking } : {}) };
    case "toolCall": {
      const approval = item.approval ? toApproval(item.approval) : undefined;
      return {
        id: item.id,
        role: "agent",
        paragraphs: [],
              toolUse: {
                name: item.toolName ?? "tool",
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
