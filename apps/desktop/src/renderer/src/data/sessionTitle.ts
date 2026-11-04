import { safeSlice } from "@boss-harness/shared";

/** 侧栏会话标题上限；与内核默认标题保持一致的回退文案。 */
export const SESSION_TITLE_LIMIT = 32;
export const SESSION_TITLE_FALLBACK = "新会话";

/** 首页会把所选项目拼成「招聘项目：<名称>\n\n<正文>」；标题只取正文。 */
const PROJECT_PREFIX = /^\s*招聘项目：[^\n]*\n\n/;

/** 去掉首页固定格式的项目前缀；不匹配时原样返回。 */
export function stripProjectPrefix(prompt: string): string {
  return prompt.replace(PROJECT_PREFIX, "");
}

/**
 * 新建会话标题：剥离项目前缀、折叠空白后安全截断。
 * 只影响展示，发送给模型的输入保持不变。
 */
export function sessionTitleFromPrompt(prompt: string, limit = SESSION_TITLE_LIMIT): string {
  const collapsed = stripProjectPrefix(prompt).replace(/\s+/g, " ").trim();
  return safeSlice(collapsed, limit) || SESSION_TITLE_FALLBACK;
}

/** 会话顶栏与分支标签：折叠空白，超长时安全截断并保留省略号。 */
export function compactTitle(text: string | null | undefined, limit: number, fallback = ""): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed || limit <= 0) return fallback;
  return collapsed.length > limit ? `${safeSlice(collapsed, limit).trimEnd()}…` : collapsed;
}
