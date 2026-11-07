/**
 * 技能对话框的关闭意图。
 *
 * 保存 / 删除进行中不能关闭：请求已经发出，关闭只会让界面与磁盘状态分叉。
 * 有未保存内容时第一次关闭只提示，第二次才真正丢弃，避免误按 Esc 或点遮罩丢掉长正文。
 */
export type SkillDialogCloseIntent = "ignore" | "confirm" | "close";

export function skillDialogCloseIntent(busy: boolean, dirty: boolean, confirmed: boolean): SkillDialogCloseIntent {
  if (busy) return "ignore";
  if (dirty && !confirmed) return "confirm";
  return "close";
}
