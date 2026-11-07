/**
 * 打开聊天内查找时沿用当前选中文本的判定。
 *
 * 浏览器与编辑器打开查找时会把当前选择填进查找框，这里做同样的接续。只放行适合当
 * 关键词的选择：单行、去掉首尾空白后非空、长度有上限。多行选择按原样沿用没有意义
 * （查找框是单行的），整段选择多半是复制意图，超长文本填进去只会得到一片无意义高亮。
 */

/** 超过这个长度的选择不作为关键词。 */
export const FIND_SEED_MAX_LENGTH = 120;

export interface FindSeedContext {
  /** 焦点在输入框、文本域或可编辑区域时为真：此时文档选择可能是残留，不作为关键词。 */
  editable?: boolean;
}

/** 焦点是否落在可编辑控件上；选择发生在输入框里时，`window.getSelection()` 不可靠。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

/** 返回可以填进查找框的关键词；不适合沿用时返回 `null`，调用方保持原有关键词。 */
export function findSeedFromSelection(
  selection: string | null | undefined,
  context: FindSeedContext = {},
): string | null {
  if (context.editable) return null;
  if (typeof selection !== "string") return null;
  const text = selection.trim();
  if (!text) return null;
  if (/[\r\n]/.test(text)) return null;
  if (text.length > FIND_SEED_MAX_LENGTH) return null;
  return text;
}
