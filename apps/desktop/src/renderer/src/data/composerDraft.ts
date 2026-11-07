/** 附件原文与提交流程状态只保存在当前应用内存；正文与技能选择由界面层持久化到本地。 */
import { safeSlice } from "@boss-harness/shared";
import type { QueueSubmissionLookup } from "./queueMapping";

export interface DraftAttachment { id: string; name: string; text: string; size: number; }
export interface QueueSubmission { text: string; intent: QueueIntent; id: string; skillIds: string[]; uncertain: boolean; }
export type QueueSubmissionCheck =
  | QueueSubmissionLookup
  /** reason 说明读取失败的原因；缺省表示本地内核未连接。 */
  | { status: "unavailable"; reason?: string };
export interface ComposerDraft {
  id: string;
  text: string;
  textVersion: number;
  attachments: DraftAttachment[];
  skillIds: string[];
  pendingReads: number;
  submitting: boolean;
  queueSubmission?: QueueSubmission;
}
export type UpdateComposerDraft = (change: (previous: ComposerDraft) => ComposerDraft) => void;
/**
 * false 表示内核明确拒绝；"uncertain" 表示结果无法确认，输入可能没有进入会话；
 * 其它返回值表示输入已交给会话，不代表执行完成。
 */
export type ComposerSendOutcome = void | boolean | "uncertain";
export type ComposerSend = (text: string, skillIds?: string[]) => ComposerSendOutcome | Promise<ComposerSendOutcome>;
export type ComposerSendResult = "sent" | "rejected" | "uncertain";
/**
 * 把发送回调的返回值归一成三种结果。
 * 只有成功与明确拒绝可以清空草稿：结果不确定时服务端可能没收到，清空会让输入无处可寻。
 */
export function composerSendResult(transferred: ComposerSendOutcome): ComposerSendResult {
  if (transferred === false) return "rejected";
  if (transferred === "uncertain") return "uncertain";
  return "sent";
}
export type QueueIntent = "steering" | "followUp";
export type ComposerQueue = (text: string, intent: QueueIntent, clientUserMessageId: string, skillIds?: string[]) => void | boolean | Promise<void | boolean>;
export type CheckQueueSubmission = (clientUserMessageId: string) => Promise<QueueSubmissionCheck>;
export function createComposerDraft(id: string = crypto.randomUUID()): ComposerDraft {
  return { id, text: "", textVersion: 0, attachments: [], skillIds: [], pendingReads: 0, submitting: false };
}
export function withDraftText(draft: ComposerDraft, text: string): ComposerDraft {
  return draft.text === text ? draft : { ...draft, text, textVersion: draft.textVersion + 1 };
}

/** 引用片段上限：只取消息开头一段，避免把整段长回复塞进输入框。 */
export const QUOTE_LIMIT = 100;

/**
 * 把一条消息的引用追加到当前草稿，保留尚未发送的正文、附件与技能选择。
 * 空引用不改变草稿；超长片段安全截断并标注省略号。
 */
export function appendQuote(draft: ComposerDraft, source: string, limit = QUOTE_LIMIT): ComposerDraft {
  const text = source.trim();
  if (!text || limit <= 0) return draft;
  const body = safeSlice(text, limit);
  const quoted = `> ${body}${body.length < text.length ? "…" : ""}`;
  if (!draft.text) return withDraftText(draft, `${quoted}\n\n`);
  const separator = draft.text.endsWith("\n\n") ? "" : draft.text.endsWith("\n") ? "\n" : "\n\n";
  return withDraftText(draft, `${draft.text}${separator}${quoted}\n\n`);
}
export function clearTransferredDraft(current: ComposerDraft, submitted: ComposerDraft): ComposerDraft {
  if (current.id !== submitted.id) return current;
  const sent = new Set(submitted.attachments.map(file => file.id));
  const clearText = current.textVersion === submitted.textVersion;
  return { ...current, text: clearText ? "" : current.text,
    textVersion: current.textVersion + (clearText ? 1 : 0),
    attachments: current.attachments.filter(file => !sent.has(file.id)), skillIds: [], submitting: false, queueSubmission: undefined };
}
