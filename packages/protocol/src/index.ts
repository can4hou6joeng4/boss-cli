/**
 * BOSS-CLI 桌面端与 Harness 内核之间的协议定义。
 *
 * 形状参照 Codex 的 app-server 协议：JSON-RPC 2.0 帧 + 方法名用斜杠分层
 * （thread/start、turn/start、item/started 等），请求/响应按 id 关联，
 * 通知与客户端/服务端请求分开关联。此协议独立实现，不宣称兼容 Codex 私有字段。
 */

export const PROTOCOL_VERSION = "0.2.0";

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
  bidirectionalRequests?: boolean;
  /** 声明接收实验性 API 与字段。 */
  experimentalApi?: boolean;
  /** 按名屏蔽的通知方法，例如 "turn/completed"。 */
  optOutNotificationMethods?: string[];
  /** 客户端声明的扩展。 */
  extensions?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion?: string;
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolBridge: ToolBridgeStatus;
  modelBridge: { provider: string; model: string; driven: boolean };
  approval: { requiredTools: string[]; timeoutSeconds: number };
  capabilities?: { bidirectionalRequests: boolean; eventReplay: boolean; pagination: boolean; parallelThreads: boolean };
  eventCursor?: string;
}

/* ---------- 客户端请求方法 ---------- */

export const ClientMethods = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadList: "thread/list",
  threadRead: "thread/read",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadArchive: "thread/archive",
  threadDelete: "thread/delete",
  threadUnarchive: "thread/unarchive",
  threadNameSet: "thread/name/set",
  threadReasoningRead: "thread/reasoning/read",
  threadReasoningSet: "thread/reasoning/set",
  threadTurnsList: "thread/turns/list",
  threadItemsList: "thread/items/list",
  threadItemResultRead: "thread/item/result/read",
  threadItemContentRead: "thread/item/content/read",
  toolList: "tool/list",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  turnSteer: "turn/steer",
  turnRead: "turn/read",
  approvalRespond: "approval/respond",
  eventList: "event/list",
  queueAdd: "queue/add",
  queueList: "queue/list",
  queueRemove: "queue/remove",
  modelList: "model/list",
  configRead: "config/read",
  connectionRead: "connection/read",
  connectionCheck: "connection/check",
  skillsList: "skills/list",
  attachmentAdd: "attachment/add",
  attachmentRead: "attachment/read",
  contextRead: "context/read",
  contextCompactPlan: "context/compact/plan",
  contextCompactStart: "context/compact/start",
  contextCompactAbort: "context/compact/abort",
  contextCompactRead: "context/compact/read",
  contextCompact: "context/compact",
  contextEditRead: "context/edit/read",
  contextEdit: "context/edit",
} as const;

export type ClientMethod = (typeof ClientMethods)[keyof typeof ClientMethods];

/* ---------- 服务端通知 ---------- */

export const ServerNotifications = {
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  agentMessageDelta: "agentMessage/delta",
  agentThinkingDelta: "agentThinking/delta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  toolCallStarted: "toolCall/started",
  toolCallCompleted: "toolCall/completed",
  approvalRequested: "approval/requested",
  threadUpdated: "thread/updated",
  sessionError: "session/error",
  harnessDisconnected: "harness/disconnected",
  connectionStatus: "harness/connectionStatus",
  threadCreated: "thread/created",
  threadArchived: "thread/archived",
  threadDeleted: "thread/deleted",
  threadUnarchived: "thread/unarchived",
  threadRenamed: "thread/renamed",
  threadReasoningUpdated: "thread/reasoning/updated",
  queueUpdated: "queue/updated",
  contextCompactionStarted: "context/compactionStarted",
  contextCompactionProgress: "context/compactionProgress",
  contextCompactionCompleted: "context/compactionCompleted",
  contextCompactionFailed: "context/compactionFailed",
  contextEdited: "context/edited",
  kernelHookError: "kernel/hookError",
} as const;

export type ServerNotification =
  (typeof ServerNotifications)[keyof typeof ServerNotifications];

/** Sanitized provider facts attached to terminal model failures. */
export interface ProviderFailureInfo {
  provider: "openai" | "anthropic";
  source: "http_error" | "stream_error" | "transport_error";
  /** Harness classification; only CONTEXT_OVERFLOW permits context recovery. */
  code?: "CONTEXT_OVERFLOW";
  providerCode?: string;
  statusCode?: number;
  /** Adapter transient-failure classification, not permission to replay a turn. */
  retryable?: boolean;
  /** Sanitized cause category; raw exception details are never included. */
  transportCause?: "connect_timeout" | "read_timeout" | "write_timeout" | "pool_timeout"
    | "timeout" | "dns_error" | "tls_error" | "connect_error" | "read_error"
    | "write_error" | "protocol_error" | "connection_error" | "os_error" | "unknown";
  /** Portable allowlisted errno label, when available. */
  transportCode?: "ECONNABORTED" | "ECONNREFUSED" | "ECONNRESET" | "EHOSTUNREACH"
    | "ENETUNREACH" | "ETIMEDOUT" | "EPIPE" | "EAI_AGAIN" | "EAI_NONAME";
}

export interface SessionErrorNotification {
  threadId?: string;
  turnId?: string;
  message: string;
  code?: string;
  recoveryAttempted?: boolean;
  outputObserved?: boolean;
  /** The host refused this request before provider dispatch. */
  requestRejected?: boolean;
  purpose?: "turn" | "compaction" | "connection_check";
  provider?: string;
  model?: string;
  requestIndex?: number;
  jobId?: string;
  /** Business request cap and exhausted count for TURN_ROUND_LIMIT. */
  maxModelRequests?: number;
  modelRequestCount?: number;
  errorInfo?: ProviderFailureInfo;
}

/* ---------- 领域模型：thread / turn / item ---------- */

export type ItemKind = "userMessage" | "agentMessage" | "toolCall" | "system";

export interface ThreadSummary {
  toolPolicy?: "readOnly" | "approval";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastTurn?: Pick<TurnSummary, "turnId" | "status" | "taskPhase" | "taskPhaseStatus" | "taskAttempt" | "taskRestartLimit" | "taskRecoveryReason" | "taskResumePolicy"> | null;
  sessionId?: string;
  projectId?: string | null;
  model?: string;
  reasoningEffort?: string | null;
  cwd?: string;
  archived?: boolean;
  forkedFromId?: string;
  forkedFromTurnId?: string;
}

export interface ThreadItem {
  id: string;
  threadId: string;
  turnId?: string;
  clientUserMessageId?: string;
  queueId?: string;
  kind: ItemKind;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolBatchId?: string;
  toolArguments?: Record<string, unknown>;
  status?: "running" | "completed" | "failed";
  thinking?: string;
  resultSummary?: string;
  source?: { ref: string; tool: string; queriedAt: string };
  errorCode?: string;
  recoveryAction?: string;
  executionState?: "queued" | "pending_approval" | "approved" | "not_approved" | "executing" | "completed" | "failed" | "not_executed" | "outcome_unknown";
  result?: { ok: boolean; command: string; data: unknown; pagination?: Record<string, unknown> | null; error: unknown; hints: unknown };
  resultOmitted?: boolean;
  resultRef?: ToolResultReference;
  textOmitted?: boolean;
  textRef?: ItemContentReference;
  thinkingOmitted?: boolean;
  thinkingRef?: ItemContentReference;
  /** 需要用户批准的工具调用会带这个字段；界面据此渲染审批卡。 */
  approval?: ApprovalState;
  contextEdit?: { entryId: string; excluded: boolean };
}

export interface ContextEditReadResponse {
  threadId: string;
  itemId: string;
  sourceDigest: string;
  originalText: string;
  currentText: string | null;
  excluded: boolean;
  canEdit: boolean;
  reason?: string | null;
}

/** Reference to canonical JSON in a durable tool item, independent of model text. */
export interface ToolResultReference {
  threadId: string;
  itemId: string;
  encoding: "json";
  sha256: string;
  byteLength: number;
  /** Unicode code points, not UTF-16 code units. */
  characterLength: number;
}

export interface ToolResultReadParams {
  threadId: string;
  itemId: string;
  sha256: string;
  cursor?: string;
  /** Default 16384, maximum 32768 Unicode code points. */
  limit?: number;
}

export interface ToolResultReadResponse {
  text: string;
  offset: number;
  nextCursor: string | null;
  resultRef: ToolResultReference;
}

export interface ItemContentReference {
  threadId: string;
  itemId: string;
  part: "text" | "thinking";
  encoding: "text";
  sha256: string;
  byteLength: number;
  /** Unicode code points, not UTF-16 code units. */
  characterLength: number;
  /** Reads must use the same frozen snapshot as this reference. */
  snapshotId?: string;
}

export interface ItemContentReadParams {
  threadId: string;
  itemId: string;
  part: ItemContentReference["part"];
  sha256: string;
  cursor?: string;
  /** Default 16384, maximum 32768 Unicode code points. */
  limit?: number;
  snapshotId?: string;
}

export interface ItemContentReadResponse {
  text: string;
  offset: number;
  nextCursor: string | null;
  contentRef: ItemContentReference;
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
  deadline?: number;
}

export interface ThreadStartParams {
  toolPolicy?: "readOnly" | "approval";
  title?: string;
  projectId?: string;
  model?: string;
}

export interface ThreadStartResponse {
  thread: ThreadSummary;
}

export interface ThreadReasoningSetParams {
  threadId: string;
  /** Null restores the configured provider default. */
  effort: string | null;
}
export interface ThreadReasoningSetResponse { thread: ThreadSummary }
export interface ThreadReasoningReadResponse {
  threadId: string;
  model: string;
  effort: string | null;
  configuredEffort: string | null;
  supported: boolean;
  /** Retained summary ownership may temporarily restrict the available levels. */
  summaryActive: boolean;
  availableEfforts: string[];
  capabilitySource: string;
  capabilityIsEstimate: boolean;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
  nextCursor?: string | null;
}

export interface ThreadReadParams {
  threadId: string;
  excludeTurns?: boolean;
  snapshot?: boolean;
}

export interface ThreadReadResponse {
  thread: ThreadSummary;
  items: ThreadItem[];
  turns?: TurnSummary[] | null;
  activeTurnId?: string | null;
  eventCursor?: string;
  queue?: QueueItem[];
  snapshotId?: string;
  itemCount?: number;
}

export interface ThreadDeleteParams {
  threadId: string;
}

export interface ThreadDeleteResponse {
  threadId: string;
  deleted: true;
}

export interface ThreadDeletedNotification {
  deletedThreadId: string;
  eventId: string;
  eventCursor: string;
}

/** 内核允许清单中的工具；写操作需要逐次批准。 */
export interface ToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  maxModelResultBytes?: number;
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

export interface AutoCompactionPolicy {
  enabled: boolean;
  triggerPercent: number;
  keepRecentTokens: number;
  provider: string | null;
  model: string | null;
  effort: string | null;
}

export interface TurnAutoCompactionOverride {
  enabled: boolean;
  triggerPercent: number;
  keepRecentTokens: number;
}

export interface TurnStartParams {
  threadId: string;
  input: string;
  /** Per-thread identity shared by direct and follow-up submissions; retries retain the first input. */
  clientUserMessageId?: string;
  model?: string;
  attachmentIds?: string[];
  skillIds?: string[];
  autoCompaction?: Partial<TurnAutoCompactionOverride>;
  /** Tightens the host cap for this turn only; integer from 1 to the configured maximum. */
  maxModelRequests?: number;
}

export interface TurnStartResponse {
  turnId: string;
  clientUserMessageId?: string;
  deduplicated?: boolean;
}

export type TurnStatus = "running" | "completed" | "interrupted" | "blocked" | "error";
export type TurnTaskPhase = "admission" | "prepare" | "model_request" | "tool_execution" | "finish";
export type TurnTaskResumePolicy = "manual" | "closed";

export interface ThreadUpdatedParams {
  threadId: string;
  turnId: string;
  status: Exclude<TurnStatus, "running">;
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
  turnId?: string;
  itemId: string;
  toolName: string;
  summary: string;
  /** 待执行的操作参数；用户得先看到自己在批准什么。 */
  params?: Record<string, unknown>;
  /** 出站操作必须显式批准；只读操作可为 false。 */
  consequential: boolean;
  deadline?: number;
}

export interface ApprovalRespondParams {
  approvalId: string;
  approved: boolean;
}

export const ServerRequests = { toolRequestApproval: "item/tool/requestApproval" } as const;

export interface ToolApprovalResponse { approved: boolean }

export interface PageParams { cursor?: string | null; limit?: number }
export interface ThreadListParams extends PageParams { archived?: boolean; projectId?: string }
export interface TurnSummary {
  turnId: string;
  threadId: string;
  status: TurnStatus;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  maxModelRequests?: number;
  taskPhase?: TurnTaskPhase;
  taskPhaseStatus?: TurnStatus;
  taskAttempt?: number;
  taskRestartLimit?: number;
  taskRecoveryReason?: "processExit" | "terminalStateRecovered";
  taskResumePolicy?: TurnTaskResumePolicy;
}
export interface TurnListResponse { turns: TurnSummary[]; nextCursor: string | null }
export interface ItemListResponse { items: ThreadItem[]; nextCursor: string | null }

export interface DurableEvent {
  method: string;
  params: Record<string, unknown> & { eventCursor: string; eventId: string; threadId?: string; turnId?: string };
}
export interface EventListResponse { events: DurableEvent[]; nextCursor: string; hasMore: boolean }

export interface QueueItem {
  id: string;
  kind: "steering" | "followUp";
  input: string;
  status: "queued" | "delivering" | "delivered" | "paused" | "cancelled";
  expectedTurnId?: string | null;
  clientUserMessageId?: string | null;
  failureCode?: "TURN_START_FAILED";
  executionStarted?: false;
  turnId?: string;
  inputPersisted?: boolean;
  /** Receipt linked to an existing request; delivery does not imply turn success. */
  deduplicated?: boolean;
}
export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: string;
  clientUserMessageId?: string;
}
export interface QueueAddParams {
  threadId: string;
  input: string;
  clientUserMessageId?: string;
}
export interface QueueListResponse { items: QueueItem[] }
export interface QueueItemResponse { queueItem: QueueItem }

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  capabilitySource: string;
  capacityIsEstimate: boolean;
  reasoningEfforts?: string[];
}
export interface ModelDescriptor {
  id: string;
  provider: string;
  configured: boolean;
  available: boolean;
  capabilities?: ModelCapabilities;
}
export interface ModelListResponse { models: ModelDescriptor[]; source: "local-config" }
/** Read the active prepared request, or preview the next turn while idle. */
export interface ContextReadParams {
  threadId: string;
  model?: string;
  input?: string;
  skillIds?: string[];
  attachmentIds?: string[];
}
export interface ContextCompactPlanParams {
  threadId: string;
  /** Explicit boundary; mutually exclusive with keepRecentTokens. */
  throughTurnId?: string;
  /** Positive estimate target; defaults to 20000 when no boundary is supplied. */
  keepRecentTokens?: number;
}
export interface ContextCompactPlan {
  threadId: string;
  throughTurnId: string;
  sourceItemIds: string[];
  sourceDigest: string;
  sourceItemCount: number;
  firstItemId: string;
  lastItemId: string;
  digestVersion: 2;
  checkpointDigest: string | null;
  selection: "explicit" | "keepRecentTokens";
  keepRecentTokens: number | null;
  retainedItemCount: number;
  retainedTurnIds: string[];
  firstKeptItemId: string | null;
  estimatedRetainedTokens: number;
  retentionEstimateMethod?: string;
  retentionUsageApplied?: boolean;
  retentionUsageAnchorCount?: number;
}
export type ContextCompactionJobStatus = "running" | "completed" | "failed" | "cancelled";
export interface ContextCompactStartParams {
  threadId: string;
  throughTurnId?: string;
  keepRecentTokens?: number;
  sourceDigest?: string;
  model?: string;
}
export interface ContextCompactJob {
  jobId: string;
  threadId: string;
  throughTurnId: string;
  sourceDigest: string;
  status: ContextCompactionJobStatus;
  reason?: "threshold" | "budget" | "overflow";
  turnId?: string;
  code?: string;
  message?: string;
  result?: ContextReadResponse;
  modelRequestCount?: number;
  /** Unicode code points in the complete serialized summary source. */
  processedCharacters?: number;
  totalCharacters?: number;
  retainedItemCount?: number;
  firstKeptItemId?: string | null;
  estimatedRetainedTokens?: number;
  summaryProvider?: string;
  summaryModel?: string;
  summaryEffort?: string | null;
  requestRejected?: boolean;
}
export interface ContextCompactAbortResponse extends ContextCompactJob { aborted: boolean }
export interface ContextBudget {
  estimatedInputTokens: number;
  estimateMethod: string;
  contextWindow: number;
  outputReserve: number;
  inputBudget: number;
  messageCount: number;
  breakdown: { system: number; messages: number; tools: number; options: number; usageBaseline?: number };
  requestedOutputTokens: number;
  modelMaxOutputTokens: number;
  /** Effective provider effort at this request's preparation boundary. */
  reasoningEffort?: string | null;
  capabilitySource: string;
  capacityIsEstimate: boolean;
  withinBudget: boolean;
  model: string;
  provider: string;
  usageApplied: boolean;
  requestFingerprint?: string | null;
  usageAnchorTurnId?: string | null;
}
export interface ContextReadResponse extends ContextBudget {
  threadId: string;
  turnId?: string;
  requestSource: "active" | "preview" | "default";
  summaryAvailable?: boolean;
  checkpoint: (Record<string, unknown> & {
    summaryProvider?: string;
    summaryModel?: string;
    summaryEffort?: string | null;
  }) | null;
  usage: Record<string, unknown> | null;
  summaryUsage?: Record<string, unknown> | null;
  lastBudget?: ContextBudget & { turnId: string } | null;
  /** Active ownership is process-local; retained terminal jobs are reconstructed from durable events. Missing means an older service; null means no retained job. */
  compactionJob?: { jobId: string; status: ContextCompactionJobStatus; active: boolean } | null;
}
export type ConnectionTarget = "local" | "model" | "platform";
export interface ConnectionCheck {
  state: "unchecked" | "checking" | "ready" | "failed" | "blocked" | "disabled";
  summary: string;
  checkedAt?: string | null;
  code?: string | null;
  provider?: string;
  model?: string;
  authState?: string;
  binarySource?: string;
  browserSourcePolicy?: "inherit" | "auto" | "existing-browser" | "stored-cookie";
  requestRejected?: boolean;
}
export interface ConnectionReport { cli: ConnectionCheck; model: ConnectionCheck; platform: ConnectionCheck }
/** Login control contains no credentials; cookie transport is private to the host. */
export interface PlatformLoginStatus {
  state: "idle" | "opening" | "waiting" | "saving" | "succeeded" | "failed" | "blocked" | "cancelled" | "disabled";
  summary: string;
  code?: string | null;
  phase?: "scan" | "confirm" | "credentials" | "verify";
  identity?: "jobSeeker" | "recruiter" | "unknown";
  /** Desktop-only context; never contains platform credentials or page text. */
  threadId?: string;
  browserId?: string;
  browser?: { available: boolean; loading: boolean; canGoBack: boolean; canGoForward: boolean };
}
export type PlatformLoginAction = "open" | "status" | "cancel" | "layout" | "back" | "forward" | "reload";
export interface PlatformLoginContext {
  threadId: string;
  browserId?: string;
  visible?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface SkillDescriptor { id: string; name: string; description: string; digest: string; bytes: number }
export interface SkillListResponse { skills: SkillDescriptor[] }
export interface AttachmentDescriptor { id: string; name: string; digest: string; bytes: number; mediaType: string }
