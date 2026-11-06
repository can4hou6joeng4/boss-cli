import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { MessageItem } from "./mockData";
import { approvalDecisionText } from "./approvalCopy";
import { approvalRemainingText } from "./pendingApprovals";
import { searchText } from "./searchText";
import { toolOutcomeBadge } from "./toolOutcome";
import { toolQueriedAtLabel } from "./toolSource";
import { toolCompletedTimingLabel } from "./toolTiming";

/** 正文实际渲染的文本：用户消息渲染 `content`，智能体消息渲染 `paragraphs`。 */
function visibleBodyText(item: MessageItem): string {
  return item.role === "user" ? item.content ?? "" : (item.paragraphs ?? []).join("\n\n");
}

/**
 * 摘要行、审批卡与折叠块中会渲染的详情文本；`resultRef` 存在时输出改为按需读取，此时为 `undefined`。
 * 工具名、状态徽标、执行耗时与审批卡默认可见，命中时不需要展开折叠块；其余工具字段默认收起。
 */
export interface VisibleDetailText {
  thinking?: string;
  toolName?: string;
  toolStatus?: string;
  toolTiming?: string;
  input?: string;
  source?: string;
  sourceQueriedAt?: string;
  errorCode?: string;
  recoveryAction?: string;
  result?: string;
  output?: string;
  approvalStatus?: string;
  approvalDescription?: string;
  approvalDeadline?: string;
}

/**
 * 工具卡与审批卡里实际渲染的详情文本。
 * 没有思考时长不渲染思考块；`resultRef` 存在时结构化输出不渲染，原始输出不能参与匹配。
 * 耗时与卡片共用 `toolCompletedTimingLabel`：只匹配完成的定格文案，不匹配每秒变化的
 * 「已运行 / 已等待 / 排队」，未批准 / 未执行与非法、倒序时间不产生可匹配文本。
 * 审批期限使用卡片上的倒计时文案，而不是内核原始时间戳；卡片只在尚无结论时显示倒计时，
 * 已裁决的条目即使仍带 `deadline` 也不参与期限匹配。
 */
function visibleDetailText(item: MessageItem, now = Date.now()): VisibleDetailText {
  const badge = item.toolUse
    ? toolOutcomeBadge(item.toolUse.executionState, item.toolUse.status, item.toolUse.errorCode)
    : null;
  const approval = item.approval;
  const approvalStatus = approvalDecisionText(approval?.decision) ?? "";
  return {
    thinking: item.thinkingTime ? item.thinkingContent ?? "" : "",
    toolName: item.toolUse?.name ?? "",
    toolStatus: badge?.label ?? "",
    // 与工具卡摘要行同源：完成值优先内核 durationMs，旧内核回退开始 / 完成时间。
    toolTiming: item.toolUse ? toolCompletedTimingLabel(item.toolUse) ?? "" : "",
    input: item.toolUse?.input ?? "",
    source: item.toolUse?.source?.ref ?? "",
    // 与工具卡同源：只匹配实际渲染的本地时间；不可解析时卡片不显示时间，也不参与匹配。
    sourceQueriedAt: toolQueriedAtLabel(item.toolUse?.source?.queriedAt) ?? "",
    errorCode: item.toolUse?.errorCode ?? "",
    recoveryAction: item.toolUse?.recoveryAction ?? "",
    result: item.toolUse?.result ?? "",
    output: item.toolUse?.resultRef ? "" : item.toolUse?.output ?? "",
    approvalStatus,
    approvalDescription: approval?.description ?? "",
    // 与审批卡一致：只有尚无结论时才渲染倒计时；未知结论同样按已裁决处理。
    approvalDeadline: approval && !approval.decision && approval.deadline !== undefined
      ? approvalRemainingText(approval.deadline, now)
      : "",
  };
}

/**
 * 返回匹配消息的 id，按消息顺序排列。
 * 查询为空（或只有空白）时不选中任何消息；匹配使用 NFKC 归一化且不区分大小写。
 * 只匹配实际渲染的文本：正文按角色取字段，`includeDetails` 为真时额外匹配思考内容与
 * 工具卡上可见的名称、状态徽标、执行耗时、输入、来源编号、来源查询时间、错误码、
 * 恢复建议、结果与结构化输出，以及审批卡的说明、结论与期限。各字段独立匹配，不把记录
 * 里存在但界面不渲染的字段计入，避免计数命中却既无高亮也无折叠块可展开。
 */
export function findMessageMatches(
  messages: MessageItem[],
  query: string,
  options: { includeDetails?: boolean; now?: number } = {},
): string[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  const hit = (text: string | undefined) =>
    typeof text === "string" && text.length > 0 && searchText(text).includes(needle);
  const now = options.now ?? Date.now();
  return messages
    .filter(item => hit(visibleBodyText(item))
      || (options.includeDetails === true && Object.values(visibleDetailText(item, now)).some(hit)))
    .map(item => item.id);
}

/** 命中位于折叠块内的消息，用于「包含详情」查找时展开当前命中的块。 */
export interface FoldedMessageMatch {
  id: string;
  /** 思考块正文命中。 */
  thinking: boolean;
  /** 工具块折叠内容（输入 / 来源编号及查询时间 / 错误码 / 恢复建议 / 结果 / 结构化输出）命中；摘要行的工具名与状态徽标不算。 */
  tool: boolean;
  /** 工具块内直接渲染的结构化输出命中。 */
  output: boolean;
}

/**
 * 找出「包含详情」查找中命中位于折叠块内的消息，按消息顺序排列。
 * 与 `findMessageMatches` 共用 `visibleDetailText`：只统计实际会渲染的折叠块，
 * 没有思考时长不渲染思考块，`resultRef` 存在时输出按需读取、不展开内层。
 * 工具名、状态徽标、执行耗时与审批卡默认可见，命中时不需要展开，因此不计入 `tool`。
 */
export function findFoldedMatches(messages: MessageItem[], query: string): FoldedMessageMatch[] {
  const needle = searchText(query).trim();
  if (!needle) return [];
  const hit = (text: string | undefined) =>
    typeof text === "string" && text.length > 0 && searchText(text).includes(needle);
  const matches: FoldedMessageMatch[] = [];
  for (const item of messages) {
    const detail = visibleDetailText(item);
    const thinking = hit(detail.thinking);
    const tool = Boolean(item.toolUse) && (
      hit(detail.input) || hit(detail.source) || hit(detail.sourceQueriedAt)
      || hit(detail.errorCode) || hit(detail.recoveryAction) || hit(detail.result) || hit(detail.output)
    );
    const output = hit(detail.output);
    if (thinking || tool) matches.push({ id: item.id, thinking, tool, output });
  }
  return matches;
}

/** 一次消息搜索的结果批次；记录发起时的查询与归档范围，用于判断结果是否已过期。 */
export interface ThreadSearchBatch {
  query: string;
  includeArchived: boolean;
  matches: ThreadSearchMatch[];
  truncated: boolean;
}

export interface VisibleThreadSearchHits {
  matches: ThreadSearchMatch[];
  truncated: boolean;
}

const SEARCH_ROLES: ReadonlySet<string> = new Set(["user", "agent", "tool"]);

/** 命中项逐项校验：弹窗渲染 threadId / role / snippet 并经内核高亮切分，非对象元素必须在进入状态前拒绝。 */
function isThreadSearchMatch(value: unknown): value is ThreadSearchMatch {
  if (!value || typeof value !== "object") return false;
  const match = value as Record<string, unknown>;
  return typeof match.threadId === "string" && match.threadId.length > 0
    && typeof match.threadTitle === "string"
    && typeof match.itemId === "string" && match.itemId.length > 0
    && typeof match.role === "string" && SEARCH_ROLES.has(match.role)
    && typeof match.snippet === "string";
}

/**
 * 只展示与当前查询和归档范围一致的消息命中批次。
 * 查询变化后旧批次仍留在组件状态里，若直接渲染会让旧命中继续可点开；
 * 这里在渲染期判定批次是否对应当前输入，并继续按当前可见会话过滤。
 * 批次来自内核响应，形状不可信：matches 非数组时按空结果处理，非对象或字段类型不符的命中被丢弃。
 */
export function visibleThreadSearchHits(
  batch: ThreadSearchBatch | null,
  query: string,
  includeArchived: boolean,
  availableThreadIds: ReadonlySet<string>,
): VisibleThreadSearchHits {
  const needle = query.trim();
  if (!batch || !needle || batch.query !== needle || batch.includeArchived !== includeArchived) {
    return { matches: [], truncated: false };
  }
  if (!Array.isArray(batch.matches)) return { matches: [], truncated: false };
  return {
    matches: batch.matches.filter(isThreadSearchMatch).filter(match => availableThreadIds.has(match.threadId)),
    truncated: batch.truncated === true,
  };
}
