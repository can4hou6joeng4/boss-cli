/**
 * 聊天内查找的状态文案。
 *
 * 计数单位是「匹配消息数」：`findMessageMatches` 返回匹配消息的 id，同一条消息里
 * 命中多次也只算一条。直接拼「1 / 3」会让用户以为这是命中处数，按 Enter 逐条跳转
 * 时看到计数停在原地，容易误判成跳转失效，因此文案必须写明单位。
 */

export interface FindStatusInput {
  /** 查找框原文，可能只有空白。 */
  query: string;
  /** 匹配消息数。 */
  total: number;
  /** 当前位次，从 0 开始；越界时收敛到合法范围。 */
  position: number;
  /**
   * 仅正文没有命中时，勾选「含工具、审批与思考」后能命中的消息数。
   * `undefined` 表示未计算或已勾选详情，此时不给提示。
   */
  detailHits?: number;
}

/**
 * 状态行文字。
 *
 * 正文有命中时不提示详情：此时用户在逐条跳转，插一句「含详情还能命中更多」只会
 * 干扰当前路径；只有正文一无所获时，这句提示才是下一步该做的事。
 */
export function findStatusText(input: FindStatusInput): string {
  if (!input.query.trim()) return "输入关键词";
  const total = Math.max(0, Math.floor(input.total));
  if (total > 0) {
    const position = Math.min(Math.max(0, Math.floor(input.position)), total - 1);
    return `第 ${position + 1} / ${total} 条消息`;
  }
  const detailHits = Math.max(0, Math.floor(input.detailHits ?? 0));
  if (detailHits > 0) return `正文无匹配 · 含详情可命中 ${detailHits} 条消息`;
  return "无匹配消息";
}
