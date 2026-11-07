import type { ComposerSendOutcome } from "./composerDraft";
import type { SessionItem } from "./mockData";

/**
 * 新建会话并发送首条消息的结果。
 *
 * 必须分开「会话是否存在」与「首条消息是否送达」：只返回 `SessionItem | null`
 * 会把「会话已建立、只是消息没送出去」说成「未能创建会话」，用户据此重发就会
 * 再建一个空会话，原会话变成没有消息的孤儿记录。
 */
export type SessionStartOutcome =
  | { status: "started"; session: SessionItem }
  | { status: "unsent"; session: SessionItem }
  | { status: "unconfirmed"; session: SessionItem }
  | { status: "failed" };

/** 已经建立的会话；`failed` 之外的状态都必须能打开这个会话。 */
export function createdSession(outcome: SessionStartOutcome): SessionItem | null {
  return outcome.status === "failed" ? null : outcome.session;
}

/**
 * 归一成输入区的发送结果。只有内核明确拒绝才按 `false` 处理；
 * 结果不确定必须保留草稿，避免把可能已送达的消息当成失败重发。
 */
export function sessionStartSendOutcome(outcome: SessionStartOutcome): ComposerSendOutcome {
  if (outcome.status === "started") return true;
  if (outcome.status === "unconfirmed") return "uncertain";
  return false;
}

/**
 * 全局提示。`started` 无需提示；`failed` 的原因由创建阶段给出，
 * 这里只补「会话已建立」的核对指引，不与创建失败提示重复。
 */
export function sessionStartNotice(outcome: SessionStartOutcome): string | null {
  if (outcome.status === "unsent") {
    return `会话「${outcome.session.title}」已创建，但首条消息被内核拒绝；草稿已保留，请打开该会话核对后重试。`;
  }
  if (outcome.status === "unconfirmed") {
    return `会话「${outcome.session.title}」已创建，但首条消息提交结果尚未确认；草稿已保留，请从会话列表打开该会话核对，不会自动重试。`;
  }
  return null;
}

/** 快速提问弹窗的提示：`sent` 不提示，只有 `failed` 才说「未能创建会话」。 */
export function quickAskNotice(outcome: SessionStartOutcome): string | null {
  if (outcome.status === "unsent") {
    return `会话「${outcome.session.title}」已创建，但这个问题没有被接受；输入已保留，请从会话列表打开该会话核对后重试。`;
  }
  if (outcome.status === "unconfirmed") {
    return `会话「${outcome.session.title}」已创建，但提交结果尚未确认；输入已保留，请从会话列表打开该会话核对，不会自动重试。`;
  }
  if (outcome.status === "failed") {
    return "未能创建会话；输入已保留，不会自动重试。请按主界面的提示处理后重试。";
  }
  return null;
}
