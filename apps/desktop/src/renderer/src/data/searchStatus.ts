/** 搜索弹窗的消息搜索状态；与组件内的状态机保持一致。 */
export type MessageSearchState = "idle" | "loading" | "ready" | "error";

/**
 * 状态行的文字。
 *
 * 消息搜索失败时，只报标题命中数量会掩盖消息部分未完成；读屏用户依赖这个
 * `role="status"` 区域获知失败，因此失败信息必须进入状态行。
 */
export function searchStatusText(
  query: string,
  chatCount: number,
  messageCount: number,
  messageState: MessageSearchState,
): string {
  if (!query.trim()) return "最近聊天";
  if (messageState === "ready") return `找到 ${chatCount} 个聊天、${messageCount} 条消息`;
  if (messageState === "error") return `找到 ${chatCount} 个聊天；消息搜索失败`;
  return `找到 ${chatCount} 个聊天`;
}

export interface SearchEmptyCopy {
  title: string;
  hint: string;
}

/**
 * 结果区为空时的文案。
 *
 * 空态只能描述真正完成的搜索范围：消息搜索失败、旧内核不支持消息搜索或查询
 * 短于 2 个字符时，标题为空并不能说明消息内容没有命中，不能用「没有找到相关
 * 聊天或消息」给出完整结论。
 */
export function searchEmptyCopy(
  query: string,
  messageState: MessageSearchState,
  searchMessages: boolean,
): SearchEmptyCopy {
  if (!query.trim()) return { title: "还没有聊天", hint: "创建聊天后，可以在这里快速找到它" };
  if (!searchMessages) {
    return {
      title: "没有找到相关聊天",
      hint: "当前内核只按标题与项目搜索；升级内核后可搜索消息内容",
    };
  }
  if (messageState === "error") {
    return {
      title: "标题中没有匹配的聊天",
      hint: "消息搜索失败，暂时无法确认消息内容是否有命中；可稍后重试或换个关键词",
    };
  }
  if (query.trim().length < 2) {
    return {
      title: "没有找到匹配的聊天",
      hint: "标题中没有匹配；输入至少 2 个字符可同时搜索消息内容",
    };
  }
  // 消息搜索尚未完成（组件在 loading 时不渲染空态；idle 是发起检索前的一帧）。
  if (messageState !== "ready") {
    return {
      title: "正在搜索消息…",
      hint: "标题结果已更新；消息内容仍在检索中",
    };
  }
  return { title: "没有找到相关聊天或消息", hint: "试试其他关键词、项目名称或消息内容" };
}
