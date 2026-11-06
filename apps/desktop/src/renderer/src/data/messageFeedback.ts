import { UI_STORAGE_PREFIX } from "./uiStorage";

/**
 * 代理消息的「有帮助 / 需要改进」标记。
 *
 * 只保存在本机界面偏好，不发送给模型或招聘平台。键由会话 id 与消息 id
 * 组成的 JSON 数组保存，避免分隔符歧义；值只有 `up` / `down`。
 */
export type MessageFeedbackChoice = "up" | "down";

export const MESSAGE_FEEDBACK_STORAGE_KEY = UI_STORAGE_PREFIX + "messageFeedback";
/** 单条持久化键的长度上限；会话或消息 id 异常超长时拒绝写入，避免偏好被撑坏。 */
export const MAX_FEEDBACK_KEY_LENGTH = 600;
/** 最多保留的条目数；超出后按插入顺序淘汰最早条目，长期使用也不会无限增长。 */
export const MAX_MESSAGE_FEEDBACK_ENTRIES = 2_000;

export type MessageFeedbackStore = Record<string, MessageFeedbackChoice>;

/**
 * 生成持久化键；缺少会话或消息 id、或键超长时返回 null，调用方跳过写入。
 * 预览会话由调用方传入稳定的占位 id。
 */
export function feedbackEntryKey(threadId: string, messageId: string): string | null {
  const thread = typeof threadId === "string" ? threadId.trim() : "";
  const message = typeof messageId === "string" ? messageId.trim() : "";
  if (!thread || !message) return null;
  const key = JSON.stringify([thread, message]);
  return key.length <= MAX_FEEDBACK_KEY_LENGTH ? key : null;
}

/** 解析持久化键；只接受由两个非空字符串组成的 JSON 数组，其余返回 null。 */
export function parseFeedbackEntryKey(key: string): [string, string] | null {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_FEEDBACK_KEY_LENGTH) return null;
  let value: unknown;
  try { value = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [thread, message] = value;
  if (typeof thread !== "string" || typeof message !== "string") return null;
  if (!thread || !message || thread.trim() !== thread || message.trim() !== message) return null;
  return [thread, message];
}

/**
 * 校验存储内容：只保留合法键与 `up` / `down` 值，其余条目丢弃。
 * 对象属性顺序即写入顺序，超限时保留最近的条目。
 */
export function parseMessageFeedback(value: unknown): MessageFeedbackStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, MessageFeedbackChoice][] = [];
  for (const [key, choice] of Object.entries(value as Record<string, unknown>)) {
    if (choice !== "up" && choice !== "down") continue;
    if (!parseFeedbackEntryKey(key)) continue;
    entries.push([key, choice]);
  }
  return Object.fromEntries(entries.slice(-MAX_MESSAGE_FEEDBACK_ENTRIES));
}

/**
 * 写入或删除一条反馈并返回新对象；已有键先删除再插入，保持「最近操作在末尾」的顺序。
 * 超过上限时从最早条目开始淘汰。
 */
export function withMessageFeedback(
  store: MessageFeedbackStore,
  key: string,
  choice: MessageFeedbackChoice | undefined,
): MessageFeedbackStore {
  const next: MessageFeedbackStore = { ...store };
  delete next[key];
  if (choice !== undefined) next[key] = choice;
  const keys = Object.keys(next);
  const excess = keys.length - MAX_MESSAGE_FEEDBACK_ENTRIES;
  if (excess > 0) for (const stale of keys.slice(0, excess)) delete next[stale];
  return next;
}

/** 取某个会话的消息级反馈；无法解析的键忽略，供界面按消息 id 直接查询。 */
export function feedbackForThread(store: MessageFeedbackStore, threadId: string): MessageFeedbackStore {
  const result: MessageFeedbackStore = {};
  for (const [key, choice] of Object.entries(store)) {
    const parsed = parseFeedbackEntryKey(key);
    if (parsed?.[0] === threadId) result[parsed[1]] = choice;
  }
  return result;
}

/** 读取本机偏好；存储缺失、损坏或不可用时返回空映射，界面按未标记渲染。 */
export function readStoredMessageFeedback(): MessageFeedbackStore {
  try {
    return parseMessageFeedback(JSON.parse(localStorage.getItem(MESSAGE_FEEDBACK_STORAGE_KEY) ?? "null"));
  } catch { return {}; }
}

/** 写入本机偏好；失败（隐私模式、配额用尽）返回 false，由调用方如实提示。 */
export function saveStoredMessageFeedback(store: MessageFeedbackStore): boolean {
  try {
    localStorage.setItem(MESSAGE_FEEDBACK_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch { return false; }
}
