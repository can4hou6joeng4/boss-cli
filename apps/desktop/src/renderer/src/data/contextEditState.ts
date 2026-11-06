/**
 * 「后续模型上下文」对话框的提交闸门。
 *
 * 读取或提交后回读失败时，界面会保留上一次成功读取的快照；该快照可能已经过期，
 * 在重新读取成功前不能再基于它提交编辑。
 */
export interface ContextEditGate {
  loading: boolean;
  saving: boolean;
  stale: boolean;
}

export function contextEditSubmitBlocked(gate: ContextEditGate): boolean {
  return gate.loading || gate.saving || gate.stale;
}

/** 旧快照提示；与提交闸门一起使用，明确说明界面展示的不是当前事实。 */
export const CONTEXT_EDIT_STALE_NOTICE = "下方是上次成功读取的上下文快照，可能已过期；重新读取成功前不会提交新的编辑。";
