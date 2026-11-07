import type { MessageItem } from "./mockData";

/** 内核单回合最多注入 10 个技能；重试沿用同一上限。 */
const MAX_RETRY_SKILLS = 10;

/** 「重试此轮对话」当前不可用的原因；`null` 表示可以重试。 */
export type RetryBlockReason = "running" | "taskBlocked";

/**
 * 重试按钮何时不可用。渲染（disabled 与说明文案）与处理函数共用这一判定，
 * 避免按钮可点但处理函数静默返回。
 */
export function retryBlockReason(running: boolean, taskBlocked: boolean): RetryBlockReason | null {
  if (running) return "running";
  if (taskBlocked) return "taskBlocked";
  return null;
}

function retryableText(item: MessageItem): string | null {
  const text = item.content?.trim();
  return text ? text : null;
}

/** 重试对应的用户输入：用户消息取自身，代理消息回溯到最近一条用户消息。 */
function retrySource(messages: readonly MessageItem[], messageId: string): { item: MessageItem; text: string } | null {
  const index = messages.findIndex(item => item.id === messageId);
  if (index < 0) return null;
  const target = messages[index];
  if (!target) return null;
  if (target.role === "user") {
    const text = retryableText(target);
    return text ? { item: target, text } : null;
  }
  // 连续的工具调用 / 思考消息同属一个回合，回溯到该回合的用户输入为止。
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (candidate?.role === "user") {
      const text = retryableText(candidate);
      return text ? { item: candidate, text } : null;
    }
  }
  return null;
}

/**
 * 「重试此轮对话」应重新发送的文本。
 * 用户消息取自身；代理消息取它之前最近的一条用户消息，而不是整个会话的最后一条，
 * 否则点击旧回合会把后续回合的输入重复提交。找不到对应消息或文本为空时返回 null。
 */
export function retryTextForMessage(messages: readonly MessageItem[], messageId: string): string | null {
  return retrySource(messages, messageId)?.text ?? null;
}

export interface RetryRequest {
  text: string;
  /** 该回合记录、且当前技能目录仍确认可用的技能 id。 */
  skillIds: string[];
}

/**
 * 重试请求：文本规则与 `retryTextForMessage` 一致，并重新带上该回合注入的技能。
 * 只保留 `availableSkillIds` 中仍然存在的 id：内核加载未知技能会直接拒绝，
 * 已删除或目录尚未确认的技能留在请求里，会让原本可执行的重试变成一次失败发送。
 */
export function retryRequestForMessage(
  messages: readonly MessageItem[],
  messageId: string,
  turnSkillIds: Readonly<Record<string, readonly string[]>>,
  availableSkillIds: readonly string[],
): RetryRequest | null {
  const source = retrySource(messages, messageId);
  if (!source) return null;
  const turnId = source.item.turnId;
  const recorded = typeof turnId === "string" ? turnSkillIds[turnId] : undefined;
  const available = new Set(availableSkillIds);
  const skillIds: string[] = [];
  if (Array.isArray(recorded)) {
    for (const id of recorded) {
      if (skillIds.length >= MAX_RETRY_SKILLS) break;
      if (typeof id === "string" && available.has(id) && !skillIds.includes(id)) skillIds.push(id);
    }
  }
  return { text: source.text, skillIds };
}
