import type { QueueIntent } from "./composerDraft";

/**
 * 运行中队列模式的技能提示。
 *
 * 只有「转向当前回合」会丢弃技能；「排到后续回合」自 `queue/add.skillIds` 起就支持技能，
 * 不能再笼统提示「队列消息不支持技能」。
 */
export function queueSkillNotice(queueing: boolean, intent: QueueIntent, skillCount: number): string | null {
  if (!queueing || intent !== "steering" || skillCount < 1) return null;
  return "转向消息不使用技能；切换为「排到后续回合」或清除已选技能后再发送。";
}
