/**
 * BOSS-CLI 桌面端与 Harness 内核之间的协议定义。
 *
 * 形状参照 Codex 的 app-server 协议：JSON-RPC 2.0 帧 + 方法名用斜杠分层
 * （thread/start、turn/start、item/started 等），请求/响应按 id 关联，
 * 事件单向推送。
 */

export const PROTOCOL_VERSION = "0.1.0";

/* ---------- JSON-RPC 2.0 帧 ---------- */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/* ---------- 握手 ---------- */

export interface ClientInfo {
  name: string;
  version: string;
}

export interface InitializeCapabilities {
  /** 声明接收实验性 API 与字段。 */
  experimentalApi?: boolean;
  /** 按名屏蔽的通知方法，例如 "turn/completed"。 */
  optOutNotificationMethods?: string[];
  /** 客户端声明的扩展。 */
  extensions?: Record<string, unknown>;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
}

/* ---------- 客户端请求方法 ---------- */

export const ClientMethods = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadList: "thread/list",
  threadRead: "thread/read",
  toolList: "tool/list",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  approvalRespond: "approval/respond",
} as const;

export type ClientMethod = (typeof ClientMethods)[keyof typeof ClientMethods];

/* ---------- 服务端通知 ---------- */

export const ServerNotifications = {
  turnStarted: "turn/started",
  agentMessageDelta: "agentMessage/delta",
  agentThinkingDelta: "agentThinking/delta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  toolCallStarted: "toolCall/started",
  toolCallCompleted: "toolCall/completed",
  approvalRequested: "approval/requested",
  threadUpdated: "thread/updated",
  sessionError: "session/error",
} as const;

export type ServerNotification =
  (typeof ServerNotifications)[keyof typeof ServerNotifications];

/* ---------- 领域模型：thread / turn / item ---------- */

export type ItemKind = "userMessage" | "agentMessage" | "toolCall" | "system";

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadItem {
  id: string;
  threadId: string;
  kind: ItemKind;
  text?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  status?: "running" | "completed" | "failed";
  /** 需要用户批准的工具调用会带这个字段；界面据此渲染审批卡。 */
  approval?: ApprovalState;
}

/** 一次工具审批的状态。`decision` 缺席表示还在等用户决定。 */
export interface ApprovalState {
  approvalId: string;
  toolName: string;
  /** 给用户看的一句话说明。 */
  description: string;
  params: Record<string, unknown>;
  /** 出站操作必须显式批准；只读操作可为 false。 */
  consequential: boolean;
  decision?: "approve" | "deny" | "expired";
}

export interface ThreadStartParams {
  title?: string;
}

export interface ThreadStartResponse {
  thread: ThreadSummary;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface ThreadReadParams {
  threadId: string;
}

export interface ThreadReadResponse {
  thread: ThreadSummary;
  items: ThreadItem[];
}

/** 内核当前暴露给模型的工具（首版仅只读）。 */
export interface ToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface ToolListResponse {
  tools: ToolDescriptor[];
}

/** 初始化时内核回报的工具桥状态。 */
export interface ToolBridgeStatus {
  available: boolean;
  binary: string;
  /** 二进制来源：explicit | env | sibling | path */
  binarySource: string;
  tools: string[];
}

export interface TurnStartParams {
  threadId: string;
  input: string;
}

export interface TurnStartResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
}

/** 中断请求的应答：`interrupted` 为 false 表示那一轮已经收尾，没有可中断的回合。 */
export interface TurnInterruptResponse {
  interrupted: boolean;
}

/** 服务端向客户端发起的审批请求。 */
export interface ApprovalRequestedParams {
  approvalId: string;
  threadId: string;
  toolName: string;
  summary: string;
  /** 待执行的操作参数；用户得先看到自己在批准什么。 */
  params?: Record<string, unknown>;
  /** 出站操作必须显式批准；只读操作可为 false。 */
  consequential: boolean;
}

export interface ApprovalRespondParams {
  approvalId: string;
  approved: boolean;
}
