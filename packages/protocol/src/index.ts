/**
 * BOSS Harness 桌面端与 Harness 内核之间的协议定义。
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
  capabilities?: { bidirectionalRequests: boolean; eventReplay: boolean; pagination: boolean;
    parallelThreads: boolean; durableApprovals?: boolean; explicitTurnContinuation?: boolean;
    sessionLeaf?: boolean; sessionBranchViews?: boolean; sessionBranchTree?: boolean;
    sessionBranchSummary?: boolean; threadUsage?: boolean; sessionModelSelection?: boolean;
    /** `view: "branch"` 可与 `snapshot: true` / `snapshotId` 同用（冻结分支快照）。 */
    sessionBranchSnapshots?: boolean;
    /** 可用 `thread/branchSummary/read` 读取被放弃分支摘要正文。 */
    sessionBranchSummaryRead?: boolean;
    /** 可用只读 `thread/export` 导出脱敏后的会话文本（Markdown / JSON / 自包含 HTML）。 */
    threadExport?: boolean;
    /** 可用只读 `thread/search` 在会话的消息正文中做有界搜索。 */
    threadSearch?: boolean;
    /** `thread/search` 接受 `includeArchived`，可把已归档会话纳入搜索。 */
    threadSearchArchived?: boolean;
    /** 可用 `context/instructions/read` / `context/instructions/write` 查看并保存工作区常驻说明。 */
    workspaceInstructionsEdit?: boolean;
    /** 可用只读 `skills/read` 查看单个工作区技能的 SKILL.md 正文（有界，不写入会话）。 */
    skillsRead?: boolean;
    /** 可用 `skills/create` 在当前生效技能目录新建 SKILL.md；只创建不覆盖。 */
    skillsCreate?: boolean;
    /** 可用 `skills/write` 按读取摘要修改已有技能；摘要变化时拒绝写入。 */
    skillsWrite?: boolean;
    /** 可用 `skills/delete` 按读取摘要删除技能；目录含其他文件时拒绝。 */
    skillsDelete?: boolean };
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
  threadLeafRead: "thread/leaf/read",
  threadLeafSet: "thread/leaf/set",
  threadBranchesList: "thread/branches/list",
  threadBranchSummaryRead: "thread/branchSummary/read",
  threadUsageRead: "thread/usage/read",
  threadSearch: "thread/search",
  threadExport: "thread/export",
  threadArchive: "thread/archive",
  threadDelete: "thread/delete",
  threadUnarchive: "thread/unarchive",
  threadNameSet: "thread/name/set",
  threadModelSet: "thread/model/set",
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
  turnContinuationRead: "turn/continuation/read",
  turnContinue: "turn/continue",
  taskRead: "task/read",
  approvalList: "approval/list",
  approvalRespond: "approval/respond",
  eventList: "event/list",
  queueAdd: "queue/add",
  queueList: "queue/list",
  queueGet: "queue/get",
  queueRemove: "queue/remove",
  modelList: "model/list",
  configRead: "config/read",
  runtimeResourcesRead: "runtime/resources/read",
  connectionRead: "connection/read",
  connectionCheck: "connection/check",
  skillsList: "skills/list",
  skillsRead: "skills/read",
  skillsCreate: "skills/create",
  skillsWrite: "skills/write",
  skillsDelete: "skills/delete",
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
  contextInstructionsRead: "context/instructions/read",
  contextInstructionsWrite: "context/instructions/write",
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
  threadLeafChanged: "thread/leafChanged",
  threadArchived: "thread/archived",
  threadDeleted: "thread/deleted",
  threadUnarchived: "thread/unarchived",
  threadRenamed: "thread/renamed",
  threadReasoningUpdated: "thread/reasoning/updated",
  threadModelUpdated: "thread/model/updated",
  queueUpdated: "queue/updated",
  contextCompactionStarted: "context/compactionStarted",
  contextCompactionProgress: "context/compactionProgress",
  contextCompactionCompleted: "context/compactionCompleted",
  contextCompactionFailed: "context/compactionFailed",
  contextEdited: "context/edited",
  kernelHookError: "kernel/hookError",
  modelRetryStarted: "model/retryStarted",
  modelRetryEnded: "model/retryEnded",
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

/**
 * 模型请求在首个输出前遇到瞬时失败、即将退避重试（仅观测；不代表授权重放回合）。
 * 可选通知：旧客户端忽略即可，也可经 optOutNotificationMethods 屏蔽。
 */
export interface ModelRetryStartedNotification {
  threadId: string;
  turnId?: string | null;
  /** 即将发起的第几次尝试（从 2 起）。 */
  attempt: number;
  /** 本次请求的总尝试上限。 */
  maxAttempts: number;
  delayMs: number;
  /** 已脱敏的上一次失败说明。 */
  errorMessage: string;
}

/** 一段自动重试结束：成功产出首个事件，或最终失败 / 被取消。 */
export interface ModelRetryEndedNotification {
  threadId: string;
  turnId?: string | null;
  /** 最后一次发起的尝试序号。 */
  attempt: number;
  success: boolean;
  reason?: "error" | "aborted";
  finalError?: string;
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

/** 尚未形成回合的队列项分类计数；与 `queueActiveItems` 来自同一次状态归并。 */
export interface QueueStatusCounts {
  queued: number;
  delivering: number;
  paused: number;
}

export interface ThreadSummary {
  toolPolicy?: "readOnly" | "approval";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastTurn?: Pick<TurnSummary, "turnId" | "status" | "taskPhase" | "taskPhaseStatus" | "taskAttempt" | "taskRestartLimit" | "taskRecoveryReason" | "taskResumePolicy" | "failureCode"> | null;
  sessionId?: string;
  projectId?: string | null;
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
  cwd?: string;
  archived?: boolean;
  /** 尚未形成回合的队列项数量（排队、投递中、暂停）；旧内核不返回。 */
  queueActiveItems?: number;
  /** 同一批待处理项的分类数量；没有待处理项或旧内核不返回时缺省。 */
  queueCounts?: QueueStatusCounts;
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
  provider?: string;
  /** Persisted session selection; must match a model/list entry for this provider. */
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
export interface ThreadModelSetParams {
  threadId: string;
  provider: string;
  model: string;
}
export interface ThreadModelSetResponse { thread: ThreadSummary }
/** 归档/恢复都返回内核当前线程摘要，`thread.archived` 即操作后的状态。 */
export interface ThreadArchiveResponse { thread: ThreadSummary }
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
  /**
   * 仅在 `capabilities.sessionBranchViews` 为真时可用。`branch` 与 `snapshot` 同用需
   * `capabilities.sessionBranchSnapshots`：快照绑定视图与当时的 leaf 记录，分页须带同一 `view`；
   * leaf 移动后旧分支快照的分页与内容读取返回 -32011 `SNAPSHOT_LEAF_CHANGED`，需重新 resume。
   */
  view?: ThreadReadView;
}

/** `log`（默认）展示完整日志；`branch` 按当前 leaf 分支投影。 */
export type ThreadReadView = "log" | "branch";

export interface ThreadReadResponse {
  thread: ThreadSummary;
  items: ThreadItem[];
  turns?: TurnSummary[] | null;
  activeTurnId?: string | null;
  eventCursor?: string;
  queue?: QueueItem[];
  /** Durable queue count; `queue` is a bounded projection when it is smaller. */
  queueTotalItems?: number;
  /** Durable count of queued / delivering / paused items; independent of the bounded projection. */
  queueActiveItems?: number;
  queueTruncated?: boolean;
  snapshotId?: string;
  itemCount?: number;
  view?: "branch";
  branch?: ThreadLeafState;
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
  /** 批次调度模式；任一 sequential 则整批串行。 */
  executionMode?: "sequential" | "parallel";
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
  /** Per-turn model override on the session's persisted provider; does not change session metadata. */
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

export type TurnContinuationBoundary = "user_input" | "completed_tool_batch";
export interface TurnContinuationReadParams {
  threadId: string;
  sourceTurnId: string;
}
export interface TurnContinuationReadResponse {
  threadId: string;
  sourceTurnId: string;
  eligible: boolean;
  boundary?: TurnContinuationBoundary;
  completedToolCalls?: number;
  reasonCode?: string;
  reason?: string;
  warning: string;
}
export interface TurnContinueParams extends TurnContinuationReadParams {
  continuationId: string;
}
export interface TurnContinueResponse {
  turnId: string;
  continuedFromTurnId: string;
  continuationId: string;
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

export interface ApprovalListParams { threadId?: string; limit?: number }
export interface PendingApproval {
  approvalId: string;
  threadId: string;
  turnId?: string;
  itemId: string;
  toolName: string;
  summary: string;
  deadline: number;
  paramsDigest: string;
}
export interface ApprovalListResponse { approvals: PendingApproval[] }
/** 桌面进程内 IPC：点击审批系统通知后要定位的会话与条目；不经内核。 */
export interface ApprovalFocusTarget { threadId: string; itemId: string }
export type ApprovalRespondResponse =
  | { accepted: true }
  | {
      approvalId: string;
      approved: boolean;
      accepted: true;
      durable: true;
      executionPending: true;
    }
  | {
      approvalId: string;
      approved: boolean;
      accepted: true;
      executed: boolean;
      recovered: true;
      executionState: string;
      status: string;
    }
  | {
      approvalId: string;
      approved: false;
      accepted: false;
      expired: true;
      executed: false;
      executionState: "not_executed";
    };

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
  /** 该回合实际使用的自动压缩策略；旧记录可能没有此字段。 */
  compactionPolicy?: AutoCompactionPolicy;
  /** 该回合实际注入的技能 id（最多 10 项）；旧记录或旧内核可能没有此字段。 */
  skillIds?: string[];
  /** 回合以 error / blocked 结束时记录的原因码；旧记录或中断回合可能没有。 */
  failureCode?: string;
}
export interface TurnListResponse { turns: TurnSummary[]; nextCursor: string | null;
  view?: "branch"; branch?: ThreadLeafState }
export interface ItemListResponse { items: ThreadItem[]; nextCursor: string | null }

export interface DurableEvent {
  method: string;
  params: Record<string, unknown> & { eventCursor: string; eventId: string; threadId?: string; turnId?: string };
}
export interface EventListResponse { events: DurableEvent[]; nextCursor: string; hasMore: boolean }

export interface ThreadSearchMatch {
  threadId: string;
  threadTitle: string;
  itemId: string;
  role: "user" | "agent" | "tool";
  /** 命中位置前后约 40 字符的片段，已折叠空白并截断。 */
  snippet: string;
}
export interface ThreadSearchParams {
  query: string;
  limit?: number;
  /** 为真时同时搜索已归档会话；旧内核不声明 `threadSearchArchived` 时应省略。 */
  includeArchived?: boolean;
}
export interface ThreadSearchResponse {
  query: string;
  matches: ThreadSearchMatch[];
  /** 达到会话数、文本预算、单会话命中数或总命中上限时为真。 */
  truncated: boolean;
}

export interface QueueItem {
  id: string;
  kind: "steering" | "followUp";
  input: string;
  status: "queued" | "delivering" | "delivered" | "paused" | "cancelled";
  expectedTurnId?: string | null;
  clientUserMessageId?: string | null;
  /** Skills loaded for this queued follow-up; applied when it becomes a turn. */
  skillIds?: string[];
  /**
   * Per-turn auto-compaction override applied when this follow-up becomes a turn.
   * Omitted fields inherit the kernel defaults in effect at delivery.
   */
  autoCompaction?: Partial<TurnAutoCompactionOverride>;
  failureCode?: "TURN_START_FAILED";
  executionStarted?: false;
  turnId?: string;
  inputPersisted?: boolean;
  /** Receipt linked to an existing request; delivery does not imply turn success. */
  deduplicated?: boolean;
  /** List/session reads clip long inputs; read the full item with queue/get before acting on it. */
  inputTruncated?: boolean;
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
  skillIds?: string[];
  /** Optional per-turn auto-compaction override for the delivered follow-up; omitted fields inherit the kernel defaults at delivery. */
  autoCompaction?: Partial<TurnAutoCompactionOverride>;
}
export interface QueueListResponse {
  items: QueueItem[];
  /** Durable item count; `items` is a bounded projection when it is smaller. */
  totalItems?: number;
  /** Durable count of queued / delivering / paused items; independent of `items`. */
  activeItems?: number;
  truncated?: boolean;
}
export interface QueueGetParams { threadId: string; queueId: string }
export interface QueueItemResponse { queueItem: QueueItem }

export type TaskKind = "turn" | "queue" | "compaction";
export type TaskOwnership = "root" | "resolved" | "unassigned" | "unresolved" | "conflict" | "independent";
export type TaskRecoveryPolicy = "process_owned" | "manual_review" | "queue_pending" | "closed";
export interface TaskLocator { kind: TaskKind; id: string }
export interface TaskRelation {
  relation: "input_queue" | "steering_input" | "queue_candidate" | "delivered_as" | "targets"
    | "turn_candidate" | "summary_child" | "summary_candidate" | "owner_turn";
  ownership: Extract<TaskOwnership, "resolved" | "unresolved" | "conflict">;
  task?: TaskLocator;
}
export interface TaskReadParams { threadId: string; kind: TaskKind; id: string }
export interface TaskReadTask {
  locator: TaskLocator;
  threadId: string;
  status: string;
  ownership: TaskOwnership;
  runtimeOwned: boolean;
  recoveryPolicy: TaskRecoveryPolicy;
  phase?: { name: TurnTaskPhase; status: TurnStatus; attempt: number; restartLimit: number; recoveryReason?: string };
  relations: TaskRelation[];
  relationsTruncated?: boolean;
  historyWindow?: { terminalCompactions: number; checkpointRelations: "durable" };
}
export interface TaskReadResponse { task: TaskReadTask }
export interface RuntimeResourceOwner {
  kind: "turn" | "manualCompaction" | "automaticCompaction";
  id: string;
  threadId: string;
  state: "active" | "cleanup";
  ageSeconds: number;
  cancelRequested: boolean;
  abortPending: boolean;
  phase: string | null;
  phaseStatus: string | null;
}

export interface RuntimeResourceWaiter {
  threadId: string;
  position: number;
  waitingSeconds: number;
}

export interface RuntimeResourcesReadResponse {
  turnCapacity: number;
  activeTurnCount: number;
  maxRetainedTurns: number;
  retainedTurnCount: number;
  ownerCount: number;
  owners: RuntimeResourceOwner[];
  ownersTruncated: boolean;
  waiterCount: number;
  waiters: RuntimeResourceWaiter[];
  waitersTruncated: boolean;
}

export type SteeringMode = "all" | "one-at-a-time";

/** `config/read` result; fields are optional so older kernels remain readable. */
export interface ConfigReadResponse {
  protocolVersion?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  parallelThreads?: number;
  maxRetainedTurns?: number;
  maxModelRequests?: number;
  /** Steering delivery per injection point; absent on kernels before 0.2.0 steering modes. */
  steeringMode?: SteeringMode;
  maxAttachmentStorageBytes?: number;
  maxAttachmentStorageObjects?: number;
  modelCapabilities?: ModelCapabilities;
  toolBundleId?: string;
  /** 内核启动时解析的自动压缩策略；旧内核可能不返回。 */
  autoCompaction?: AutoCompactionPolicy;
  approvalPolicy?: string;
  approvalTimeoutSeconds?: number;
}

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
  /** `branchSummary`：`thread/leaf/set` 的被放弃分支摘要任务；缺省为上下文压缩。 */
  kind?: "branchSummary";
  targetTurnId?: string | null;
  fromTurnId?: string;
  abandonedTurnIds?: string[];
}
export interface ContextCompactAbortResponse extends ContextCompactJob { aborted: boolean }
export interface ContextBudget {
  estimatedInputTokens: number;
  estimateMethod: string;
  contextWindow: number;
  outputReserve: number;
  inputBudget: number;
  messageCount: number;
  /** 输入构成估算；没有请求时的历史投影不返回该字段，应用用量校准时附 `usageBaseline`。 */
  breakdown?: { system: number; messages: number; tools: number; options: number; usageBaseline?: number };
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
  /** 当前分支上已注入模型上下文的被放弃分支摘要；无则缺省。 */
  branchSummaries?: ContextBranchSummary[];
  /** 工作区常驻说明的加载状态；旧内核不返回，文件不存在时为 null。 */
  workspaceInstructions?: WorkspaceInstructionsState | null;
  /** 系统提示规模与分段构成；只返回字节数，不返回正文。旧内核不返回。 */
  systemPromptInfo?: SystemPromptInfo;
}
/** `context/read.systemPromptInfo`：分段与实际的系统提示同源。 */
export interface SystemPromptInfo {
  bytes: number;
  /** 运行中的请求可能只有总数，不返回分段。 */
  sections?: SystemPromptSectionInfo[];
}
export interface SystemPromptSectionInfo {
  id: string;
  title: string;
  bytes: number;
}
/** `context/read.workspaceInstructions`：只描述读取结果，不返回文件正文。 */
export interface WorkspaceInstructionsState {
  path: string;
  status: "loaded" | "empty" | "too_large" | "unreadable";
  /** 实际字节数；超限或不可读时未知为 null。 */
  bytes: number | null;
  limitBytes: number;
}
/**
 * `context/instructions/read`：当前生效候选的有界正文。
 * 超限或无法解码时正文为空，状态与路径仍返回，便于就地覆盖修复。
 */
export interface WorkspaceInstructionsText {
  path: string;
  /** 保存时固定写入的首选路径；与 `path` 不同说明当前读取的是旧位置。 */
  pathPreferred: string;
  content: string;
  status: WorkspaceInstructionsState["status"];
  limitBytes: number;
  /** 文件实际字节数；空文件、超限或不可读时为 `null`。 */
  bytes: number | null;
}
export interface WorkspaceInstructionsWriteParams { content: string }
/** `context/instructions/write` 的结果：只描述保存后的文件，不返回正文。 */
export interface WorkspaceInstructionsWriteResponse {
  path: string;
  bytes: number;
  status: "loaded" | "empty";
  limitBytes: number;
}
export interface ContextBranchSummary {
  entryId: string;
  targetTurnId: string | null;
  fromTurnId: string | null;
  abandonedTurnIds: string[];
  summaryJobId: string | null;
  characters: number;
}
/** `thread/branchSummary/read`；仅在 `capabilities.sessionBranchSummaryRead` 为真时可用，只读当前分支上的摘要。 */
export interface ThreadBranchSummaryReadParams { threadId: string; entryId: string }
export interface ThreadBranchSummaryReadResponse extends ContextBranchSummary {
  threadId: string;
  /** 模型生成的摘要正文（最多 32000 字符）；不扩大操作授权。 */
  summary: string;
  origin: "model";
  label: string;
  commonTurnId: string | null;
  summaryProvider: string | null;
  summaryModel: string | null;
  sourceTextDigest: string | null;
  createdAt: string | null;
}
/** 分支快照失效 / 视图不符 / 摘要不存在时的 `error.data.code`（JSON-RPC code -32011）。 */
export type BranchReadErrorCode = "SNAPSHOT_LEAF_CHANGED" | "SNAPSHOT_VIEW_MISMATCH" | "BRANCH_SUMMARY_NOT_FOUND";
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
/** 未能加载的技能目录：只给 id 与可展示原因，不包含文件内容。 */
export interface SkillProblem { id: string; reason: string }
/**
 * 当前生效的技能目录相对工作区路径，如 `.boss-harness/skills`；旧内核不返回。
 * `problems` 列出目录里无法安全读取的 SKILL.md；旧内核不返回时不显示警示。
 */
export interface SkillListResponse { skills: SkillDescriptor[]; root?: string; problems?: SkillProblem[] }
/** `skills/read` 参数；仅在 `capabilities.skillsRead` 为真时可用，只读且不写入会话。 */
export interface SkillReadParams { id: string }
/** `skills/read` 结果：正文来自普通 UTF-8 文件，最多 `limitBytes` 字节。 */
export interface SkillReadResponse extends SkillDescriptor { content: string; limitBytes: number; root?: string }
/**
 * `skills/create` 参数；仅在 `capabilities.skillsCreate` 为真时可用。
 * id 限定小写字母、数字、下划线与连字符，正文最多 64 KiB，且不会覆盖已有技能。
 */
export interface SkillCreateParams { id: string; content: string }
/** `skills/create` 结果：新建成功的技能描述与写入的生效目录。 */
export interface SkillCreateResponse { skill: SkillDescriptor; root?: string }
/**
 * `skills/write` 参数；仅在 `capabilities.skillsWrite` 为真时可用。
 * `id` 是已存在的技能目录名（1–200 字符，允许旧名称，不含路径分隔符或控制字符）；
 * `expectedDigest` 必须来自最近一次读取，技能被外部修改后内核拒绝写入。
 */
export interface SkillWriteParams { id: string; content: string; expectedDigest: string }
/** `skills/write` 结果：写入后的技能描述与生效目录。 */
export interface SkillWriteResponse { skill: SkillDescriptor; root?: string }
/**
 * `skills/delete` 参数；仅在 `capabilities.skillsDelete` 为真时可用。
 * `id` 是已存在的技能目录名（1–200 字符，允许旧名称，不含路径分隔符或控制字符）；
 * `expectedDigest` 必须来自最近一次读取；目录还包含其他文件时内核拒绝删除。
 */
export interface SkillDeleteParams { id: string; expectedDigest: string }
/** `skills/delete` 结果：被删除的技能 id 与生效目录。 */
export interface SkillDeleteResponse { id: string; root?: string }
export interface AttachmentDescriptor { id: string; name: string; digest: string; bytes: number; mediaType: string }

/**
 * `thread/export` 参数；仅在 `capabilities.threadExport` 为真时可用。只读，不写会话。
 * `format` 为 `markdown`、`json` 或自包含 HTML（内联样式、禁止脚本与外部资源）。
 * 默认脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容不导出，工具结果只保留结构与执行状态，
 * 个人信息按工具数据中识别到的字段值打码（未出现在工具数据中的姓名可能无法识别）；
 * `includeToolResults: true` 才导出工具参数与结果明文（凭据与路径仍脱敏）。
 * `maxBytes`（65536–786432，默认 524288）按传输转义后的字节计，超限按条目截断并标注。
 */
export interface ThreadExportParams {
  threadId: string;
  view?: "log" | "branch";
  format?: "markdown" | "json" | "html";
  includeToolResults?: boolean;
  maxBytes?: number;
}
export interface ThreadExportResponse {
  threadId: string;
  view: "log" | "branch";
  format: "markdown" | "json" | "html";
  mediaType: "text/markdown" | "application/json" | "text/html";
  /** 不含会话标题，避免文件名携带个人信息。 */
  suggestedFileName: string;
  content: string;
  bytes: number;
  maxBytes: number;
  truncated: boolean;
  turnCount: number;
  exportedTurnCount: number;
  toolResults: "omitted" | "included";
  redactions: { secrets: number; environment: number; paths: number; personalInfo: number };
}
/** 桌面「导出会话」经主进程保存对话框写盘；渲染层只拿到文件名与统计，不接触导出正文。 */
export interface SessionExportSaveRequest {
  threadId: string;
  view: "log" | "branch";
  format: "markdown" | "json" | "html";
  includeToolResults: boolean;
  /** 必填 true 才能带明文导出；主进程同样校验，不只依赖渲染层的确认框。 */
  acknowledgePlaintext?: boolean;
}
export type SessionExportSaveResult =
  | { saved: false; canceled: true }
  | { saved: true; fileName: string; bytes: number; truncated: boolean; turnCount: number; exportedTurnCount: number;
      toolResults: "omitted" | "included"; redactions: ThreadExportResponse["redactions"] };

/** `thread/usage/read` 参数；仅在 `capabilities.threadUsage` 为真时可用。 */
export interface ThreadUsageReadParams { threadId: string; view?: "log" | "branch"; cursor?: string; limit?: number }
/** 仅累计可验证的 provider usage；provider 未上报的字段为 null，费用无价目来源时为 null。 */
export interface ThreadUsageBucket {
  requests: number;
  verifiedRequests: number;
  unverifiedRequests: number;
  /**
   * provider 未上报 usage 的请求数（`unverifiedRequests` 的子集，对应原因 `missing`），
   * 与上报为全零（原因 `zero`）区分；旧内核不返回该字段。
   */
  unreportedRequests?: number;
  /** 原因如 missing / invalidType / negative / outOfRange / inconsistent / zero / unknownProvider。 */
  unverifiedReasons: Record<string, number>;
  promptTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costSource: "unavailable";
}
/** 按 `jobId` 汇总的摘要任务用量；关联字段来自对应的 checkpoint 或分支摘要记录。 */
export interface ThreadUsageSummaryJob extends ThreadUsageBucket {
  jobId: string;
  kind: "compaction" | "branchSummary" | null;
  /** 自动/手动压缩关联的回合；分支摘要为切换前的目标回合。 */
  turnId: string | null;
  /** 压缩摘要实际覆盖到的回合；分支摘要或无记录时为 null，旧内核不返回。 */
  throughTurnId?: string | null;
  reason: "threshold" | "budget" | "overflow" | null;
  origin: "user" | "model" | null;
  /** 当前分支上验证通过并生效的压缩摘要任务；旧内核或非生效任务不返回。 */
  active?: boolean;
  providers: string[];
  models: string[];
}
export interface ThreadUsageTurn extends ThreadUsageBucket {
  turnId: string;
  providers: string[];
  models: string[];
  /** 回合开始与完成时间（ISO 字符串），来自同一快照的回合记录；不可解析或旧内核不返回。 */
  startedAt?: string;
  completedAt?: string;
  /** 回合当前/最终状态；旧内核不返回。 */
  status?: TurnStatus;
  /** 该回合记录的实际自动压缩策略；内核只返回通过校验的字段（历史记录可能只含部分字段），非法或旧内核不返回。 */
  compactionPolicy?: Partial<AutoCompactionPolicy>;
  /** 该回合实际注入的技能 id（最多 10 项）；旧记录或旧内核不返回。 */
  skillIds?: string[];
}
export interface ThreadUsageReadResponse {
  threadId: string;
  view: "log" | "branch";
  source: "provider-usage";
  costAvailable: boolean;
  turnCount: number;
  turns: ThreadUsageTurn[];
  nextCursor: string | null;
  summaryTasks: ThreadUsageBucket;
  /** 最近最多 50 个有 usage 记录的摘要任务；旧内核不返回该字段。 */
  summaryJobs?: ThreadUsageSummaryJob[];
  summaryJobCount?: number;
  summaryJobsTruncated?: boolean;
  totals: ThreadUsageBucket;
  branch?: ThreadLeafState;
}
/** `thread/branches/list` 参数与结果；仅在 `capabilities.sessionBranchTree` 为真时可用。 */
export interface ThreadBranchesListParams { threadId: string; cursor?: string; limit?: number }
export interface ThreadBranchEndpoint {
  turnId: string;
  status: TurnStatus | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  /** 自根到该端点的回合数。 */
  depth: number;
  /** 最近的分叉回合（有多个子回合）；无则为 null。 */
  forkTurnId: string | null;
  /** 分叉后该分支的第一个回合。 */
  branchTurnId: string;
  branchInputPreview: string | null;
  inputPreview: string | null;
  containsLeaf: boolean;
  isLeaf: boolean;
  selectable: boolean;
}
export interface ThreadBranchesListResponse {
  threadId: string;
  branched: boolean;
  leafTurnId: string | null;
  turnCount: number;
  endpoints: ThreadBranchEndpoint[];
  nextCursor: string | null;
}

/** `thread/leaf/read` / `thread/leaf/set` 结果；仅在 `capabilities.sessionLeaf` 为真时可用。 */
export interface ThreadLeafState {
  threadId: string;
  branched: boolean;
  leafTurnId: string | null;
  activeTurnCount: number;
  activeTurnIds: string[];
  activeTurnIdsTruncated: boolean;
  changed?: boolean;
  /** 仅在请求 `summarize: true` 且指针已移动时返回；任务失败或取消不回滚指针。 */
  summaryJob?: ContextCompactJob;
}
/** `thread/leaf/set` 参数；`summarize` 仅在 `capabilities.sessionBranchSummary` 为真时可用。 */
export interface ThreadLeafSetParams {
  threadId: string;
  turnId: string | null;
  summarize?: boolean;
}
