/** 仅保存在当前应用内存；附件原文不写入 UI 偏好或浏览器持久存储。 */
import type { QueueItem } from "@boss-cli/protocol";

export interface DraftAttachment { id: string; name: string; text: string; size: number; }
export interface QueueSubmission { text: string; intent: QueueIntent; id: string; uncertain: boolean; }
export type QueueSubmissionCheck =
  | { status: "found"; item: QueueItem }
  | { status: "cancelled"; item: QueueItem }
  | { status: "missing" }
  | { status: "unavailable" };
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
/** false 仅表示转交前的明确拒绝；其它返回值表示输入已交给会话，不代表执行完成。 */
export type ComposerSend = (text: string, skillIds?: string[]) => void | boolean | Promise<void | boolean>;
export type QueueIntent = "steering" | "followUp";
export type ComposerQueue = (text: string, intent: QueueIntent, clientUserMessageId: string) => void | boolean | Promise<void | boolean>;
export type CheckQueueSubmission = (clientUserMessageId: string) => Promise<QueueSubmissionCheck>;
export function createComposerDraft(id: string = crypto.randomUUID()): ComposerDraft {
  return { id, text: "", textVersion: 0, attachments: [], skillIds: [], pendingReads: 0, submitting: false };
}
export function withDraftText(draft: ComposerDraft, text: string): ComposerDraft {
  return draft.text === text ? draft : { ...draft, text, textVersion: draft.textVersion + 1 };
}
export function clearTransferredDraft(current: ComposerDraft, submitted: ComposerDraft): ComposerDraft {
  if (current.id !== submitted.id) return current;
  const sent = new Set(submitted.attachments.map(file => file.id));
  const clearText = current.textVersion === submitted.textVersion;
  return { ...current, text: clearText ? "" : current.text,
    textVersion: current.textVersion + (clearText ? 1 : 0),
    attachments: current.attachments.filter(file => !sent.has(file.id)), skillIds: [], submitting: false, queueSubmission: undefined };
}
