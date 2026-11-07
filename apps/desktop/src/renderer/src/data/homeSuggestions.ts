/**
 * 首页建议卡填充前的判断。
 *
 * 建议卡一次点击就会改写整个输入框；已有未发送正文时先确认，
 * 避免把用户正在写或刚从草稿恢复的内容直接覆盖。空白草稿与相同内容无需确认。
 */
export type SuggestionFillIntent = "apply" | "confirm";

export function suggestionFillIntent(current: string, suggestion: string): SuggestionFillIntent {
  const existing = current.trim();
  if (!existing || existing === suggestion.trim()) return "apply";
  return "confirm";
}
