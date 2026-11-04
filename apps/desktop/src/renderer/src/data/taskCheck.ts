import type {
  RuntimeResourceOwner,
  TaskKind,
  TaskLocator,
  TaskOwnership,
  TaskReadParams,
  TaskReadTask,
  TaskRecoveryPolicy,
  TaskRelation,
} from "@boss-harness/protocol";
import { harnessErrorText } from "./harnessBridge";

/**
 * `task/read` 的桌面端消费层：只核对既有持久记录，不恢复、不重放、不取消任务。
 *
 * 内核响应按白名单字段严格校验；任何字段不符合预期时整体拒绝，避免界面展示半份归属事实。
 */
const TASK_KINDS: ReadonlySet<string> = new Set(["turn", "queue", "compaction"]);
const OWNERSHIPS: ReadonlySet<string> = new Set(["root", "resolved", "unassigned", "unresolved", "conflict", "independent"]);
const RELATION_OWNERSHIPS: ReadonlySet<string> = new Set(["resolved", "unresolved", "conflict"]);
const RECOVERY_POLICIES: ReadonlySet<string> = new Set(["process_owned", "manual_review", "queue_pending", "closed"]);
const RELATIONS: ReadonlySet<string> = new Set([
  "input_queue", "steering_input", "queue_candidate", "delivered_as", "targets",
  "turn_candidate", "summary_child", "summary_candidate", "owner_turn",
]);
const PHASES: ReadonlySet<string> = new Set(["admission", "prepare", "model_request", "tool_execution", "finish"]);
const PHASE_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "interrupted", "blocked", "error"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const THREAD_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_RELATIONS = 256;
const MAX_STATUS = 100;
const MAX_REASON = 200;

const OWNERSHIP_LABELS: Record<TaskOwnership, string> = {
  root: "根任务",
  resolved: "已解析",
  unassigned: "未分配",
  unresolved: "未解析",
  conflict: "冲突",
  independent: "独立",
};
const RECOVERY_LABELS: Record<TaskRecoveryPolicy, string> = {
  process_owned: "当前进程持有；退出后不自动重放",
  manual_review: "人工复核；不自动恢复",
  queue_pending: "队列待投递",
  closed: "已关闭；无需恢复",
};
const RELATION_LABELS: Record<TaskRelation["relation"], string> = {
  input_queue: "来源队列",
  steering_input: "转向输入",
  queue_candidate: "候选队列",
  delivered_as: "已投递为",
  targets: "指向",
  turn_candidate: "候选回合",
  summary_child: "摘要子任务",
  summary_candidate: "候选摘要",
  owner_turn: "归属回合",
};

export interface TaskCheckState {
  loading: boolean;
  task?: TaskReadTask;
  error?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maximum ? text : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 运行中 owner 到只读查询参数的映射；id 不符合协议形状时不提供核对入口。 */
export function taskLocatorForOwner(owner: RuntimeResourceOwner): TaskReadParams | null {
  const kind: TaskKind | null = owner.kind === "turn" ? "turn"
    : owner.kind === "manualCompaction" || owner.kind === "automaticCompaction" ? "compaction" : null;
  if (!kind || !THREAD_PATTERN.test(owner.threadId) || !ID_PATTERN.test(owner.id)) return null;
  return { threadId: owner.threadId, kind, id: owner.id };
}

function taskLocator(value: unknown): TaskLocator | null {
  if (!record(value) || typeof value.kind !== "string" || !TASK_KINDS.has(value.kind)
    || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return null;
  return { kind: value.kind as TaskKind, id: value.id };
}

function taskRelation(value: unknown): TaskRelation | null {
  if (!record(value) || typeof value.relation !== "string" || !RELATIONS.has(value.relation)
    || typeof value.ownership !== "string" || !RELATION_OWNERSHIPS.has(value.ownership)) return null;
  const relation: TaskRelation = {
    relation: value.relation as TaskRelation["relation"],
    ownership: value.ownership as TaskRelation["ownership"],
  };
  if (value.task !== undefined) {
    const locator = taskLocator(value.task);
    if (!locator) return null;
    relation.task = locator;
  }
  return relation;
}

/** 校验并归一化 `task/read` 响应；归属、状态枚举或关联形状不符时抛错。 */
export function parseTaskRead(value: unknown, params: TaskReadParams): TaskReadTask {
  const invalid = (): Error => new Error("任务核对响应无法识别");
  if (!record(value) || !record(value.task)) throw invalid();
  const raw = value.task;
  const locator = taskLocator(raw.locator);
  if (!locator || locator.kind !== params.kind || locator.id !== params.id) throw invalid();
  if (raw.threadId !== params.threadId) throw invalid();
  const status = boundedText(raw.status, MAX_STATUS);
  if (status === null || typeof raw.ownership !== "string" || !OWNERSHIPS.has(raw.ownership)
    || typeof raw.runtimeOwned !== "boolean"
    || typeof raw.recoveryPolicy !== "string" || !RECOVERY_POLICIES.has(raw.recoveryPolicy)) throw invalid();

  let phase: TaskReadTask["phase"];
  if (raw.phase !== undefined) {
    if (!record(raw.phase) || typeof raw.phase.name !== "string" || !PHASES.has(raw.phase.name)
      || typeof raw.phase.status !== "string" || !PHASE_STATUSES.has(raw.phase.status)) throw invalid();
    const attempt = nonNegativeInteger(raw.phase.attempt);
    const restartLimit = nonNegativeInteger(raw.phase.restartLimit);
    if (attempt === null || restartLimit === null) throw invalid();
    const reason = raw.phase.recoveryReason === undefined ? undefined : boundedText(raw.phase.recoveryReason, MAX_REASON);
    if (reason === null) throw invalid();
    phase = {
      name: raw.phase.name as NonNullable<TaskReadTask["phase"]>["name"],
      status: raw.phase.status as NonNullable<TaskReadTask["phase"]>["status"],
      attempt,
      restartLimit,
      ...(reason === undefined ? {} : { recoveryReason: reason }),
    };
  }

  if (!Array.isArray(raw.relations) || raw.relations.length > MAX_RELATIONS) throw invalid();
  const relations: TaskRelation[] = [];
  for (const entry of raw.relations) {
    const relation = taskRelation(entry);
    if (!relation) throw invalid();
    relations.push(relation);
  }

  let relationsTruncated: boolean | undefined;
  if (raw.relationsTruncated !== undefined) {
    if (typeof raw.relationsTruncated !== "boolean") throw invalid();
    relationsTruncated = raw.relationsTruncated;
  }

  let historyWindow: TaskReadTask["historyWindow"];
  if (raw.historyWindow !== undefined) {
    if (!record(raw.historyWindow) || raw.historyWindow.checkpointRelations !== "durable") throw invalid();
    const terminalCompactions = nonNegativeInteger(raw.historyWindow.terminalCompactions);
    if (terminalCompactions === null) throw invalid();
    historyWindow = { terminalCompactions, checkpointRelations: "durable" };
  }

  return {
    locator,
    threadId: params.threadId,
    status,
    ownership: raw.ownership as TaskOwnership,
    runtimeOwned: raw.runtimeOwned,
    recoveryPolicy: raw.recoveryPolicy as TaskRecoveryPolicy,
    relations,
    ...(phase ? { phase } : {}),
    ...(relationsTruncated === undefined ? {} : { relationsTruncated }),
    ...(historyWindow ? { historyWindow } : {}),
  };
}

/** 核对结果的可展示行；只陈述内核返回的事实，不推断恢复动作。 */
export function taskCheckLines(task: TaskReadTask): string[] {
  const lines = [
    `持久状态：${task.status} · 归属：${OWNERSHIP_LABELS[task.ownership]}`,
    `执行 owner：${task.runtimeOwned ? "当前进程持有" : "当前进程未持有"} · 恢复策略：${RECOVERY_LABELS[task.recoveryPolicy]}`,
  ];
  if (task.phase) {
    const reason = task.phase.recoveryReason ? ` · 恢复原因 ${task.phase.recoveryReason}` : "";
    lines.push(`任务阶段：${task.phase.name} · ${task.phase.status} · 尝试 ${task.phase.attempt}/${task.phase.restartLimit}${reason}`);
  }
  if (task.relations.length === 0) lines.push("已验证关联：无");
  else {
    const shown = task.relations.slice(0, 8);
    for (const relation of shown) {
      const target = relation.task ? ` · ${relation.task.kind}/${relation.task.id}` : "";
      lines.push(`关联：${RELATION_LABELS[relation.relation]} · ${OWNERSHIP_LABELS[relation.ownership]}${target}`);
    }
    if (task.relations.length > shown.length) lines.push(`其余 ${task.relations.length - shown.length} 项关联未展开；核对不改变任务状态。`);
  }
  if (task.relationsTruncated) lines.push("关联已由内核按上限截断，清单不完整。");
  if (task.historyWindow) lines.push(`历史窗口：最近 ${task.historyWindow.terminalCompactions} 个摘要终态；检查点关联持久化。`);
  return lines;
}

/** 核对失败文案：任务不在持久记录中时给出明确结论，其余保留内核错误码。 */
export function taskCheckErrorText(error: unknown): string {
  const value = error && typeof error === "object"
    ? error as { rpcError?: unknown; data?: unknown } : null;
  const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : null;
  const code = value?.rpcError === true && typeof data?.code === "string" ? data.code : "";
  if (code === "TASK_NOT_FOUND") {
    return "该任务不在持久记录中（可能已清理，或不属于此会话；TASK_NOT_FOUND）；核对不会恢复或重放任务。";
  }
  return harnessErrorText(error);
}
